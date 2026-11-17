// Guards two of #2322's acceptance criteria, one of #3665's, one of
// #3728's, and one of #5182's against future workflow edits:
// (1) none of the four required status-check workflows ever gains a path
// filter on its pull_request trigger or renames its job id (a path-filtered
// required check never reports for a change outside its filter, which
// blocks every such pull request rather than saving anything); (2) every
// pull_request-triggering workflow keeps some form of concurrency
// cancellation, so a superseded push does not also pay for a stale run;
// (3) both of this repository's own pnpm-boundary lanes keep running on
// ubuntu-latest, while the reusable workflow's declared runner input
// default stays ubuntu-slim for downstream callers (GitHub caps a job on
// the single-CPU ubuntu-slim runner at 15 minutes, which cancelled the
// required check although timeout-minutes was 20).
// (4) the required `lint` job stays on `ubuntu-latest`: issue #3728 recorded
// cancellation annotations for runs 36730573670, 36752800229, and
// 36955823310; the workflow comment preserves their timer ambiguity.
// (5) the `lint` job keeps `timeout-minutes: 10` and none of its steps runs
// `node --test`: issue #5182 moved the full test suite out of that job (the
// installed pnpm-boundary test shards still run it) and cut the timeout from
// 30 to 10 minutes, and issue #5266 added this guard so a later edit cannot
// restore the step or the old budget while every other guard still passes.
// Issue #5269 narrowed the `node --test` match to text that can run: observed
// 2026-11-16 in the review of pull request #5268, the guard rejected a step
// that only quotes or comments the text, such as `echo "node --test"`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  parseWorkflowYamlSubset,
  type WorkflowYamlMapping,
  type WorkflowYamlValue,
} from '../src/scripts/workflow-yaml-subset.mts';
import {
  readSharedSetupNodePin,
  SETUP_NODE_USE_LINE,
  setupNodeUseLine,
  sharedSetupNodePinFromSources,
} from './setup-node-pin.mts';

const WORKFLOWS_DIR = 'workflows';

function readWorkflow(name: string): string {
  return readFileSync(
    new URL(`../.github/${WORKFLOWS_DIR}/${name}`, import.meta.url),
    'utf8',
  );
}

test('the shared setup-node pin reader accepts one uniform pin and rejects malformed uses', () => {
  const currentPin = readSharedSetupNodePin();
  const replacementPin =
    currentPin.toLowerCase() === 'a'.repeat(40)
      ? 'b'.repeat(40)
      : 'a'.repeat(40);
  const source = (path: string, lines: readonly string[]) => ({
    path,
    contents: lines.join('\n'),
  });

  assert.equal(
    sharedSetupNodePinFromSources([
      source('first.yml', [setupNodeUseLine(currentPin)]),
      source('second.yml', [setupNodeUseLine(currentPin)]),
    ]),
    currentPin,
  );
  assert.equal(
    sharedSetupNodePinFromSources([
      source('first.yml', [
        `      - uses: actions/setup-node@${replacementPin} # v1.2.3`,
      ]),
      source('second.yml', [setupNodeUseLine(replacementPin)]),
    ]),
    replacementPin,
  );

  assert.throws(
    () =>
      sharedSetupNodePinFromSources([
        source('first.yml', [setupNodeUseLine(currentPin)]),
        source('second.yml', [setupNodeUseLine(replacementPin)]),
      ]),
    /all setup-node uses must share one SHA/,
  );

  for (const ref of ['v7.1.0', 'main']) {
    assert.throws(
      () =>
        sharedSetupNodePinFromSources([
          source('invalid.yml', [
            `        uses: actions/setup-node@${ref} # v1.2.3`,
          ]),
        ]),
      /same-line semver comment/,
    );
  }

  assert.throws(
    () =>
      sharedSetupNodePinFromSources([
        source('invalid.yml', [
          '      -uses: actions/setup-node@' + currentPin + ' # v1.2.3',
        ]),
      ]),
    /same-line semver comment/,
  );

  for (const line of [
    `        uses: actions/setup-node@${currentPin}`,
    `        uses: actions/setup-node@${currentPin} # version one`,
  ]) {
    assert.throws(
      () => sharedSetupNodePinFromSources([source('invalid.yml', [line])]),
      /same-line semver comment/,
    );
  }

  assert.throws(
    () =>
      sharedSetupNodePinFromSources([
        source('mixed.yml', [
          setupNodeUseLine(currentPin),
          '        uses: actions/setup-node@invalid # v1.2.3',
        ]),
      ]),
    /same-line semver comment/,
  );

  const commentOnlyPin = `# uses: actions/setup-node@${replacementPin} # v1.2.3`;
  assert.equal(
    sharedSetupNodePinFromSources([
      source('real.yml', [setupNodeUseLine(currentPin)]),
      source('comment.yml', [commentOnlyPin]),
    ]),
    currentPin,
  );
  assert.throws(
    () =>
      sharedSetupNodePinFromSources([source('comment.yml', [commentOnlyPin])]),
    /at least one real setup-node use must exist/,
  );
});

// In the Linux `lint` job, checkout is the only action before the Node floor assertion. Keep its
// immutable ref explicit: an earlier JavaScript/composite action can change
// GITHUB_PATH for every later step, so an unreviewed action can replace node.
// A matching ref can still check out other files. repository, ref, token,
// ssh-key, path, and github-server-url do that before the floor check, so
// the with mapping may contain only the two inputs lint.yml already uses.
const REVIEWED_CHECKOUT_USES =
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const REVIEWED_PRE_FLOOR_ACTIONS = new Set([REVIEWED_CHECKOUT_USES]);
const REVIEWED_CHECKOUT_INPUTS: Readonly<Record<string, string>> = {
  'fetch-depth': '0',
  'persist-credentials': 'false',
};
// Command text is not an immutable input: these scripts are repository
// code, and audit-docs.mjs runs other helpers before the floor. Each
// digest is sha256 over the sorted closure (the entry script, its static
// relative imports, dynamic import('./…') literals, and, when the entry
// probes helpers, every documented scripts/*.mjs plus that graph).
// pull_request CI checks out the merge with main. Helper scripts already
// on main moved the audit-docs closure after the earlier pins; this
// branch does not change that closure. Issue #3775 edits
// scripts/lint-source-boundaries.mjs, the only boundaries-closure file
// whose bytes differ from main, so that command has its own added
// digests. A further digest, including a one-byte edit, is not reviewed.
const REVIEWED_PRE_FLOOR_RUNS: readonly {
  command: string;
  digests: readonly string[];
}[] = [
  {
    command: 'node scripts/audit-docs.mjs --check',
    digests: [
      '8da091bc5c9aa25ed977013f3d78d85ae1a50ab9e5919debd8f19d50b84fab1b',
      'ad4b8b704d8bb2185c0838877351f2fedfb9f7b4a5092ee826c9ae6ce5973716',
      '42d6d094e4555bfc7a3e1cb5c66ee6c03448dbe91f207d3e88324e50e27dbb31',
    ],
  },
  {
    // Bare-node audits that already precede the floor assertion on main.
    // pull_request CI tests the merge with main, which runs these steps
    // (issues #3748 and #3751).
    command: 'node scripts/lint-source-contracts.mjs',
    digests: [
      '60f567d2ff88a072780130e813dacb67a8f1efb34d242b0979feeeeef569eb37',
    ],
  },
  {
    command: 'node scripts/lint-source-boundaries.mjs',
    digests: [
      'de1b710b0e268c1148897cbbe89bef0d9bda398e3c26b007db7d90cdbcbe0162',
      '70dd318737656256481c8264e3371ece519a9a77c76b860d5a4e9eed4665fd69',
      'a4e7f37c6b32715f6c30d9b0fb9cac8626035343c67298016713a90f40e42c98',
      '0e2436a7ae19ad016c49f8473c3b7dc303b3aacc54a41f2f5d007784b74a8911',
      '2b6412ac4e50299fb0d38e9de21259bc80e44d8a037efabd82657ae4f303793a',
      'fc6810afe62a98082ac29e669bf8972ccca3194bc5b1b59096641f93bb0d68cb',
      '9935e270ab2c491b35dcf605fdca15efc2027c11225b7077b4007a4c851a70e4',
      'eb4931c4d6d2aa5aa70177eb40ed58ac60205540c2db0e562e9622b5cff3f13a',
    ],
  },
  {
    command: 'node scripts/validate-schemas.mjs',
    digests: [
      'cee3a8a41e7266ff41afb094d54db3b0840629b0e29ff5787d15e40f829b1fb4',
      '22ad5211438a38482bb2818b1b870022687902f52927041fa5666871638505bf',
    ],
  },
];
const REVIEWED_PRE_FLOOR_RUN_COMMANDS = new Set(
  REVIEWED_PRE_FLOOR_RUNS.map((entry) => entry.command),
);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The engines.node range and its leading semver floor, read from
 * package.json at test time so that no test literal hard-codes the current
 * low bound.
 */
function enginesNodeFloor(): { range: string; lowBound: string } {
  const range = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ).engines.node as string;
  const match = /^\s*\^?(\d+\.\d+\.\d+)/.exec(range);
  if (match === null) {
    throw new Error('engines.node has no leading semver floor');
  }
  return { range, lowBound: match[1] };
}
const NODE_SCRIPT_COMMAND = /^node (scripts\/[\w./-]+\.mjs)(?: |$)/;
const PROBES_HELPERS =
  /execFileSync\(\s*['"]node['"]\s*,\s*\[\s*helperPath\s*,\s*['"]--help['"]\s*\]/;
const DOC_ROOTS = ['docs', 'idd-template', '.github/instructions'];

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function entryScript(command: string): string | undefined {
  const match = NODE_SCRIPT_COMMAND.exec(command);
  if (!match || match[1].includes('..')) {
    return undefined;
  }
  return match[1];
}

function resolveSpecifier(fromRelative: string, specifier: string): string[] {
  const base = toPosix(join(dirname(fromRelative), specifier));
  if (/\.(?:mjs|cjs|js|json)$/.test(base)) {
    return [base];
  }
  return [`${base}.mjs`, `${base}.js`];
}

function staysInsideRepo(root: string, relativePath: string): boolean {
  const fromRoot = relative(root, join(root, relativePath));
  return (
    fromRoot !== '' &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !fromRoot.startsWith('/')
  );
}

function markdownFiles(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) {
    return [];
  }
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => toPosix(join(dir, entry)));
}

function documentedHelpers(
  root: string,
  readFile: (absolutePath: string) => Buffer,
): string[] {
  const helpers = new Set<string>();
  const pattern = /\bnode\s+(scripts\/[\w./-]+\.mjs)\b/g;
  for (const dir of DOC_ROOTS) {
    for (const relativePath of markdownFiles(root, dir)) {
      const text = readFile(join(root, relativePath)).toString('utf8');
      for (const match of text.matchAll(pattern)) {
        if (!match[1].includes('..')) {
          helpers.add(match[1]);
        }
      }
    }
  }
  return [...helpers].sort();
}

type ClosureDigest = { digest: string; count: number } | { error: string };

function preFloorClosureDigest(
  root: string,
  command: string,
  readFile: (absolutePath: string) => Buffer = readFileSync,
): ClosureDigest | undefined {
  const entry = entryScript(command);
  if (entry === undefined || !existsSync(join(root, entry))) {
    return undefined;
  }
  const files = new Set<string>([entry]);
  const pending = [entry];
  const relativeModule =
    /^\s*(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+)['"](\.[^'"]+)['"]/gm;
  const dynamicImport = /\bawait\s+import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (relativePath === undefined) {
      break;
    }
    const text = readFile(join(root, relativePath)).toString('utf8');
    const specifiers = [
      ...text.matchAll(relativeModule),
      ...text.matchAll(dynamicImport),
    ].map((match) => match[1]);
    if (relativePath === entry && PROBES_HELPERS.test(text)) {
      specifiers.push(...documentedHelpers(root, readFile));
    }
    for (const specifier of specifiers) {
      if (specifier.includes('..') && !specifier.startsWith('.')) {
        return {
          error: `unverifiable specifier ${specifier} from ${relativePath}`,
        };
      }
      const options = specifier.startsWith('.')
        ? resolveSpecifier(relativePath, specifier)
        : [specifier];
      const resolved = options.find(
        (candidate) =>
          staysInsideRepo(root, candidate) && existsSync(join(root, candidate)),
      );
      if (resolved === undefined) {
        if (!specifier.startsWith('.') && !existsSync(join(root, specifier))) {
          continue;
        }
        return {
          error: `unresolved ${specifier} from ${relativePath}`,
        };
      }
      if (!files.has(resolved)) {
        files.add(resolved);
        pending.push(resolved);
      }
    }
  }
  const ordered = [...files].sort();
  const hash = createHash('sha256');
  for (const relativePath of ordered) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFile(join(root, relativePath)));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), count: ordered.length };
}

function inlinePreFloorRunCommands(jobBody: string): string[] {
  const stepsBlock = findStepsThroughFloorCheck(jobBody);
  if (stepsBlock === undefined) {
    return [];
  }
  const lines = stepsBlock.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const floorStep = lines.findIndex(
    (line, index) =>
      !scalarContent[index] && line === '      - name: Assert Node.js floor',
  );
  if (floorStep === -1) {
    return [];
  }
  const runKey = /^(?:run|'run'|"run")\s*:\s*(.*?)\s*$/;
  const commands: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (index >= floorStep || scalarContent[index]) {
      continue;
    }
    const uncommented = stripYamlComment(line);
    const indent = line.match(/^ */)?.[0].length ?? 0;
    let entry: string | undefined;
    if (indent === 6 && /^ {6}-\s*/.test(uncommented)) {
      entry = uncommented.replace(/^ {6}-\s*/, '');
    } else if (indent >= 7) {
      entry = uncommented.slice(indent);
    }
    if (entry === undefined) {
      continue;
    }
    const runMatch = entry.match(runKey);
    if (runMatch && (indent === 6 || indent === 8)) {
      commands.push(runMatch[1].trim());
    }
  }
  return commands;
}

function unpinnedPreFloorCommand(
  jobBody: string,
  root: string,
  readFile: (absolutePath: string) => Buffer = readFileSync,
): string | undefined {
  for (const command of inlinePreFloorRunCommands(jobBody)) {
    const reviewed = REVIEWED_PRE_FLOOR_RUNS.find(
      (item) => item.command === command,
    );
    if (reviewed === undefined) {
      continue;
    }
    const result = preFloorClosureDigest(root, command, readFile);
    if (
      result === undefined ||
      !('digest' in result) ||
      !reviewed.digests.includes(result.digest)
    ) {
      return command;
    }
  }
  return undefined;
}

/** Extracts one job's indented body -- the lines from `^  {jobId}:$` up to
 * (but not including) the next 2-space-indented sibling key, or end of
 * file. */
function extractJobBody(text: string, jobId: string): string {
  const lines = text.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const jobsStartIndex = lines.findIndex(
    (line, index) =>
      !scalarContent[index] &&
      /^(?:jobs|'jobs'|"jobs")\s*:\s*$/.test(stripYamlComment(line)),
  );
  assert.notEqual(jobsStartIndex, -1, 'root jobs mapping not found');
  const jobsEndIndex = lines.findIndex(
    (line, index) =>
      index > jobsStartIndex &&
      !scalarContent[index] &&
      line.trim() !== '' &&
      !line.trimStart().startsWith('#') &&
      !/^\s/.test(line),
  );
  const startIndex = lines.findIndex(
    (line, index) =>
      index > jobsStartIndex &&
      (jobsEndIndex === -1 || index < jobsEndIndex) &&
      !scalarContent[index] &&
      line === `  ${jobId}:`,
  );
  assert.notEqual(startIndex, -1, `job ${jobId} not found`);
  const nextSiblingIndex = lines.findIndex(
    (line, index) =>
      index > startIndex &&
      (jobsEndIndex === -1 || index < jobsEndIndex) &&
      !scalarContent[index] &&
      /^ {2}(?!#)\S/.test(line),
  );
  const endIndex =
    nextSiblingIndex === -1
      ? jobsEndIndex
      : jobsEndIndex === -1
        ? nextSiblingIndex
        : Math.min(nextSiblingIndex, jobsEndIndex);
  return lines
    .slice(startIndex + 1, endIndex === -1 ? undefined : endIndex)
    .join('\n');
}

/** Marks lines that belong to YAML literal or folded block scalars. The
 * implicit indentation is the first non-empty content line, per YAML's
 * block-scalar rules. */
function yamlMappingColonIndex(line: string): number {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      break;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (
      character === ':' &&
      (index + 1 === line.length || /\s/.test(line[index + 1]))
    ) {
      return index;
    }
  }
  return -1;
}

function yamlBlockScalarHeader(
  line: string,
): { contentHeaderIndent: number; explicitIndent?: number } | undefined {
  const leadingIndent = line.match(/^ */)?.[0].length ?? 0;
  let content = line.slice(leadingIndent);
  let contentHeaderIndent = leadingIndent;
  if (/^-\s/.test(content)) {
    content = content.slice(1).trimStart();
    const sequenceMappingColon = yamlMappingColonIndex(content);
    if (sequenceMappingColon !== -1) {
      contentHeaderIndent += 2;
      content = content.slice(sequenceMappingColon + 1);
    }
  } else {
    const mappingColon = yamlMappingColonIndex(content);
    if (mappingColon === -1) {
      return undefined;
    }
    content = content.slice(mappingColon + 1);
  }

  const value = stripYamlComment(content).trim();
  const header = value.match(
    /^(?:(?:&[^\s]+|![^\s]+)\s+)*(?:[|>])(?:([+-]?[1-9]|[1-9][+-]|[+-]))?$/,
  );
  if (!header) {
    return undefined;
  }
  const explicitIndent = header[1]?.match(/[1-9]/)?.[0];
  return {
    contentHeaderIndent,
    ...(explicitIndent ? { explicitIndent: Number(explicitIndent) } : {}),
  };
}

function yamlBlockScalarContentFlags(lines: string[]): boolean[] {
  const contentFlags = lines.map(() => false);
  let activeContentIndent: number | undefined;
  let pendingHeaderIndent: number | undefined;
  let pendingExplicitContentIndent: number | undefined;

  for (const [index, line] of lines.entries()) {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (activeContentIndent !== undefined) {
      if (line.trim() === '') {
        contentFlags[index] = true;
        continue;
      }
      if (indent >= activeContentIndent) {
        contentFlags[index] = true;
        continue;
      }
      activeContentIndent = undefined;
    }

    if (pendingHeaderIndent !== undefined) {
      if (line.trim() === '') {
        continue;
      }
      const contentIndent =
        pendingExplicitContentIndent ??
        (indent > pendingHeaderIndent ? indent : undefined);
      pendingHeaderIndent = undefined;
      pendingExplicitContentIndent = undefined;
      if (contentIndent !== undefined && indent >= contentIndent) {
        contentFlags[index] = true;
        activeContentIndent = contentIndent;
        continue;
      }
    }

    const header = yamlBlockScalarHeader(line);
    if (header) {
      pendingHeaderIndent = header.contentHeaderIndent;
      pendingExplicitContentIndent = header.explicitIndent
        ? pendingHeaderIndent + header.explicitIndent
        : undefined;
    }
  }

  return contentFlags;
}

/** Removes a YAML comment from one line without treating a quoted `#` as
 * a comment marker. */
function stripYamlComment(line: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (
      character === '#' &&
      (index === 0 || /\s/.test(line[index - 1]))
    ) {
      return line.slice(0, index);
    }
  }
  return line;
}

/** Counts YAML flow-map braces outside quoted values and comments. */
function yamlFlowMapBraceDelta(line: string): number {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let delta = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      break;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (character === '{') {
      delta += 1;
    } else if (character === '}') {
      delta -= 1;
    }
  }
  return delta;
}

/** Extracts only the root workflow `env` mapping, leaving independent jobs
 * and comments outside the lint job's execution scope. */
function extractWorkflowEnvironmentBlock(text: string): string {
  const lines = text.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const start = lines.findIndex(
    (line, index) =>
      !scalarContent[index] &&
      /^(?:env|'env'|"env")\s*:/.test(stripYamlComment(line)),
  );
  if (start === -1) {
    return '';
  }

  const header = stripYamlComment(lines[start]);
  const inlineValue = header.match(/^(?:env|'env'|"env")\s*:(.*)$/)?.[1];
  if (inlineValue?.trim()) {
    const value = inlineValue.trim();
    if (value.startsWith('{')) {
      const block = [header];
      let braceDepth = yamlFlowMapBraceDelta(header);
      for (const line of lines.slice(start + 1)) {
        block.push(line);
        braceDepth += yamlFlowMapBraceDelta(line);
        if (braceDepth <= 0) {
          break;
        }
      }
      return block.join('\n');
    }
    if (!/^(?:&[^\s]+|![^\s]+)(?:\s|$)/.test(value)) {
      return header;
    }
  }

  const block = [header];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      block.push(line);
      continue;
    }
    if (/^\s/.test(line)) {
      block.push(line);
      continue;
    }
    break;
  }
  return block.join('\n');
}

/** Extracts only the lint job's root `env` mapping. */
function extractJobEnvironmentBlock(jobBody: string): string {
  const lines = jobBody.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const start = lines.findIndex(
    (line, index) =>
      !scalarContent[index] &&
      /^ {4}(?:env|'env'|"env")\s*:/.test(stripYamlComment(line)),
  );
  if (start === -1) {
    return '';
  }

  const header = stripYamlComment(lines[start]);
  const inlineValue = header.match(/^ {4}(?:env|'env'|"env")\s*:(.*)$/)?.[1];
  if (inlineValue?.trim()) {
    const value = inlineValue.trim();
    if (value.startsWith('{')) {
      const block = [header];
      let braceDepth = yamlFlowMapBraceDelta(header);
      for (const line of lines.slice(start + 1)) {
        block.push(line);
        braceDepth += yamlFlowMapBraceDelta(line);
        if (braceDepth <= 0) {
          break;
        }
      }
      return block.join('\n');
    }
    if (!/^(?:&[^\s]+|![^\s]+)(?:\s|$)/.test(value)) {
      return header;
    }
  }

  const block = [header];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      block.push(line);
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= 4) {
      break;
    }
    block.push(line);
  }
  return block.join('\n');
}

/** Rejects merge keys inside env mappings because their inherited values
 * cannot be verified by the line-based override scan. */
function hasEnvironmentMergeKey(
  lines: string[],
  scalarContent: boolean[],
): boolean {
  let environmentIndent: number | undefined;
  let flowMapDepth = 0;
  const mergeKey =
    /(?:^|[{,])\s*(?:(?:&[^\s,{}[\]]+|![^\s,{}[\]]+)\s+)*(?:<<|'<<'|"<<")\s*:/;

  for (const [index, line] of lines.entries()) {
    if (scalarContent[index]) {
      continue;
    }
    const uncommented = stripYamlComment(line);
    if (uncommented.trim() === '') {
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (
      environmentIndent !== undefined &&
      flowMapDepth === 0 &&
      indent <= environmentIndent
    ) {
      environmentIndent = undefined;
    }

    const environmentHeader = uncommented.match(
      /^([ ]*)(?:env|'env'|"env")\s*:(.*)$/,
    );
    if (environmentHeader) {
      const value = environmentHeader[2];
      if (mergeKey.test(value)) {
        return true;
      }
      const trimmedValue = value.trim();
      flowMapDepth = yamlFlowMapBraceDelta(value);
      const startsBlockMapping =
        trimmedValue === '' ||
        /^(?:(?:&[^\s]+|![^\s]+)\s+)*(?:&[^\s]+|![^\s]+)$/.test(trimmedValue);
      environmentIndent =
        flowMapDepth > 0 || startsBlockMapping
          ? environmentHeader[1].length
          : undefined;
      continue;
    }

    if (
      environmentIndent !== undefined &&
      (flowMapDepth > 0 || indent > environmentIndent)
    ) {
      if (mergeKey.test(uncommented)) {
        return true;
      }
      if (flowMapDepth > 0) {
        flowMapDepth += yamlFlowMapBraceDelta(uncommented);
      }
    }
  }

  return false;
}

/** Rejects escaped or tagged env keys that the literal-name scan cannot decode. */
function hasUnverifiableEnvironmentKey(
  lines: string[],
  scalarContent: boolean[],
): boolean {
  let environmentIndent: number | undefined;
  let flowMapDepth = 0;
  const unverifiableKey =
    /(?:^|[{,])\s*(?:"(?:[^"\\]|\\.)*\\(?:[^"\\]|\\.)*"|!{1,2}[^\s]+\s+(?:'[^']*'|"[^"]*"|[^\s,{]+))\s*:/;
  const anchoredKey = /(?:^|[{,])\s*(?:(?:&[^\s,{}[\]]+|![^\s,{}[\]]+)\s+)+\S/;
  const aliasedKey = /(?:^|[{,])\s*\*[^\s,{}[\]]+\s*:/;
  const explicitKeyIndicator = /(?:^|[{,])\s*\?(?:\s|$)/;
  const rejectsEnvironmentKey = (value: string): boolean =>
    unverifiableKey.test(value) ||
    anchoredKey.test(value) ||
    aliasedKey.test(value) ||
    explicitKeyIndicator.test(value);

  for (const [index, line] of lines.entries()) {
    if (scalarContent[index]) {
      continue;
    }
    const uncommented = stripYamlComment(line);
    if (uncommented.trim() === '') {
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (
      environmentIndent !== undefined &&
      flowMapDepth === 0 &&
      indent <= environmentIndent
    ) {
      environmentIndent = undefined;
    }

    const environmentHeader = uncommented.match(
      /^([ ]*)(?:env|'env'|"env")\s*:(.*)$/,
    );
    if (environmentHeader) {
      const value = environmentHeader[2];
      if (rejectsEnvironmentKey(value)) {
        return true;
      }
      const trimmedValue = value.trim();
      flowMapDepth = yamlFlowMapBraceDelta(value);
      const startsBlockMapping =
        trimmedValue === '' ||
        /^(?:(?:&[^\s]+|![^\s]+)\s+)*(?:&[^\s]+|![^\s]+)$/.test(trimmedValue);
      environmentIndent =
        flowMapDepth > 0 || startsBlockMapping
          ? environmentHeader[1].length
          : undefined;
      continue;
    }

    if (
      environmentIndent !== undefined &&
      (flowMapDepth > 0 || indent > environmentIndent)
    ) {
      if (rejectsEnvironmentKey(uncommented)) {
        return true;
      }
      if (flowMapDepth > 0) {
        flowMapDepth += yamlFlowMapBraceDelta(uncommented);
      }
    }
  }

  return false;
}

/** Rejects YAML merge keys at the direct property indentation of a mapping. */
function hasYamlMergeKeyAtIndent(text: string, indent: number): boolean {
  const lines = text.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const mergeKey =
    /^(?:(?:&[^\s,{}[\]]+|![^\s,{}[\]]+)\s+)*(?:<<|'<<'|"<<")\s*:/;
  return lines.some(
    (line, index) =>
      !scalarContent[index] &&
      line.startsWith(' '.repeat(indent)) &&
      mergeKey.test(stripYamlComment(line).slice(indent)),
  );
}

/** Rejects escaped, tagged, anchored, or aliased mapping keys at structural
 * control-property indentation because the line-based checks below cannot
 * resolve them. An alias may be the whole key (`*skip:`) or a leading
 * token whose following name is still unresolved (`*skip if:`). */
function hasUnverifiableYamlKeyAtIndent(text: string, indent: number): boolean {
  const lines = text.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const unverifiableKey =
    /^(?:"(?:[^"\\]|\\.)*\\(?:[^"\\]|\\.)*"|!{1,2}[^\s]+\s+(?:'[^']*'|"[^"\\]*(?:\\.[^"\\]*)*"|[^\s,{]+))\s*:/;
  const decoratedKey = /^(?:(?:&[^\s]+|!{1,2}[^\s]+)\s+)+\S/;
  const aliasedKey = /^\*[^\s]+/;
  return lines.some((line, index) => {
    if (scalarContent[index] || !line.startsWith(' '.repeat(indent))) {
      return false;
    }
    const key = line.slice(indent);
    return (
      unverifiableKey.test(key) ||
      decoratedKey.test(key) ||
      aliasedKey.test(key) ||
      /^\?(?:\s|$)/.test(key)
    );
  });
}

/** Returns the lint job's `steps:` mapping body when it is present. */
function findJobStepsBlock(jobBody: string): string | undefined {
  const jobLines = jobBody.split('\n');
  const jobScalarContent = yamlBlockScalarContentFlags(jobLines);
  const stepsStart = jobLines.findIndex(
    (line, index) =>
      !jobScalarContent[index] &&
      /^ {4}(?:steps|'steps'|"steps")\s*:/.test(stripYamlComment(line)),
  );
  if (stepsStart === -1) {
    return undefined;
  }
  const nextJobProperty = jobLines.findIndex(
    (line, index) =>
      index > stepsStart &&
      !jobScalarContent[index] &&
      /^ {4}(?!#)\S/.test(line),
  );
  return jobLines
    .slice(stepsStart + 1, nextJobProperty === -1 ? undefined : nextJobProperty)
    .join('\n');
}

/** Returns the lint job steps through the floor-check step. */
function findStepsThroughFloorCheck(jobBody: string): string | undefined {
  const stepsBlock = findJobStepsBlock(jobBody);
  if (stepsBlock === undefined) {
    return undefined;
  }
  const lines = stepsBlock.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const floorStep = lines.findIndex(
    (line, index) =>
      !scalarContent[index] && line === '      - name: Assert Node.js floor',
  );
  if (floorStep === -1) {
    return stepsBlock;
  }
  const nextStep = lines.findIndex(
    (line, index) =>
      index > floorStep && !scalarContent[index] && /^ {6}- /.test(line),
  );
  return lines.slice(0, nextStep === -1 ? undefined : nextStep).join('\n');
}

/** Rejects merge keys on steps that can affect the floor-check execution. */
function hasStepLevelYamlMergeKey(jobBody: string): boolean {
  const stepsBlock = findStepsThroughFloorCheck(jobBody);
  if (stepsBlock === undefined) {
    return false;
  }
  const lines = stepsBlock.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const mergeKey =
    /(?:^|[{,])\s*(?:(?:&[^\s,{}[\]]+|![^\s,{}[\]]+)\s+)*(?:<<|'<<'|"<<")\s*:/;
  return lines.some((line, index) => {
    if (scalarContent[index]) {
      return false;
    }
    const uncommented = stripYamlComment(line);
    if (/^ {8}/.test(uncommented) && mergeKey.test(uncommented.slice(8))) {
      return true;
    }
    if (!/^ {6}-\s/.test(uncommented)) {
      return false;
    }
    const sequenceItem = uncommented.slice(8);
    return (
      /^\*[A-Za-z0-9_.-]+(?:\s|$)/.test(sequenceItem) ||
      mergeKey.test(sequenceItem)
    );
  });
}

/** A more-indented plain scalar line can fold into a preceding `run:` value. */
function hasPlainScalarContinuation(
  lines: string[],
  scalarContent: boolean[],
  lineIndex: number,
  keyIndent: number,
): boolean {
  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    if (scalarContent[index]) {
      continue;
    }
    if (stripYamlComment(lines[index]).trim() === '') {
      continue;
    }
    const indent = lines[index].match(/^ */)?.[0].length ?? 0;
    return indent > keyIndent;
  }
  return false;
}

function reviewedCheckoutInputsUnreviewed(
  lines: string[],
  scalarContent: boolean[],
  floorStep: number,
): boolean {
  const stepStarts: number[] = [];
  for (let index = 0; index < floorStep; index += 1) {
    if (!scalarContent[index] && /^ {6}- /.test(lines[index])) {
      stepStarts.push(index);
    }
  }
  for (let stepIndex = 0; stepIndex < stepStarts.length; stepIndex += 1) {
    const start = stepStarts[stepIndex];
    const end =
      stepIndex + 1 < stepStarts.length ? stepStarts[stepIndex + 1] : floorStep;
    if (checkoutStepInputsUnreviewed(lines, scalarContent, start, end)) {
      return true;
    }
  }
  return false;
}

function checkoutStepInputsUnreviewed(
  lines: string[],
  scalarContent: boolean[],
  start: number,
  end: number,
): boolean {
  let usesReviewedCheckout = false;
  const withLines: number[] = [];
  for (let index = start; index < end; index += 1) {
    if (scalarContent[index]) {
      continue;
    }
    const trimmed = stripYamlComment(lines[index]).trim();
    const uses = /^(?:-\s*)?(?:uses|'uses'|"uses")\s*:\s*(.*)$/.exec(trimmed);
    if (uses?.[1].trim() === REVIEWED_CHECKOUT_USES) {
      usesReviewedCheckout = true;
    }
    if (/^(?:-\s*)?(?:with|'with'|"with")\s*:/.test(trimmed)) {
      withLines.push(index);
    }
  }
  if (!usesReviewedCheckout) {
    return false;
  }
  return withLines.some((withAt) =>
    checkoutWithBlockUnreviewed(lines, scalarContent, withAt, end),
  );
}

function checkoutWithBlockUnreviewed(
  lines: string[],
  scalarContent: boolean[],
  withAt: number,
  end: number,
): boolean {
  const body = stripYamlComment(lines[withAt])
    .trim()
    .replace(/^(?:-\s*)?/, '');
  if (!body.startsWith('with')) {
    return true;
  }
  const inline = body.replace(/^with\s*:\s*/, '');
  if (inline !== '') {
    return true;
  }
  for (let index = withAt + 1; index < end; index += 1) {
    if (scalarContent[index]) {
      return true;
    }
    const uncommented = stripYamlComment(lines[index]);
    if (uncommented.trim() === '') {
      continue;
    }
    const indent = lines[index].match(/^ */)?.[0].length ?? 0;
    if (indent <= 8) {
      return false;
    }
    if (indent !== 10) {
      return true;
    }
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(uncommented.trim());
    if (!match || REVIEWED_CHECKOUT_INPUTS[match[1]] !== match[2].trim()) {
      return true;
    }
  }
  return false;
}

/** Rejects unreviewed actions and run commands before the floor assertion.
 * Earlier steps can write GITHUB_PATH for later steps. */
function hasUnreviewedPreFloorExecution(jobBody: string): boolean {
  const stepsBlock = findStepsThroughFloorCheck(jobBody);
  if (stepsBlock === undefined) {
    return false;
  }
  const lines = stepsBlock.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const floorStep = lines.findIndex(
    (line, index) =>
      !scalarContent[index] && line === '      - name: Assert Node.js floor',
  );
  if (floorStep === -1) {
    return false;
  }
  const actionKey = /^(?:uses|'uses'|"uses")\s*:\s*(.*?)\s*$/;
  const runKey = /^(?:run|'run'|"run")\s*:\s*(.*?)\s*$/;
  const shellKey = /^(?:shell|'shell'|"shell")\s*:/;

  for (const [index, line] of lines.entries()) {
    if (index >= floorStep) {
      break;
    }
    if (scalarContent[index]) {
      continue;
    }
    const uncommented = stripYamlComment(line);
    const indent = line.match(/^ */)?.[0].length ?? 0;
    let entry: string | undefined;
    if (indent === 6 && /^ {6}-\s*/.test(uncommented)) {
      entry = uncommented.replace(/^ {6}-\s*/, '');
    } else if (indent >= 7) {
      entry = uncommented.slice(indent);
    }
    if (entry === undefined) {
      continue;
    }

    if (shellKey.test(entry)) {
      return true;
    }

    // Flow mappings, aliases, decorated/escaped keys, and noncanonical
    // property indentation are outside this line-based guard's syntax.
    if (indent === 6 && /^\s*\{/.test(entry)) {
      return true;
    }
    const match = entry.match(actionKey);
    if (
      match &&
      (!(indent === 6 || indent === 8) ||
        !REVIEWED_PRE_FLOOR_ACTIONS.has(match[1].trim()))
    ) {
      return true;
    }
    const runMatch = entry.match(runKey);
    if (
      runMatch &&
      (!(indent === 6 || indent === 8) ||
        !REVIEWED_PRE_FLOOR_RUN_COMMANDS.has(runMatch[1].trim()))
    ) {
      return true;
    }
    if (
      runMatch &&
      hasPlainScalarContinuation(
        lines,
        scalarContent,
        index,
        indent === 6 ? 8 : indent,
      )
    ) {
      return true;
    }
    if (
      (indent === 6 && /^\s*(?:\?|\*|&|!)/.test(entry)) ||
      (indent >= 7 && /^\s*(?:\?|\*|&|!)/.test(entry)) ||
      (indent === 6 &&
        /^\s*(?:"[^"]*\\[^"]*"|'[^']*\\[^']*')\s*:/.test(entry)) ||
      (indent >= 7 && /^\s*(?:"[^"]*\\[^"]*"|'[^']*\\[^']*')\s*:/.test(entry))
    ) {
      return true;
    }
  }

  return reviewedCheckoutInputsUnreviewed(lines, scalarContent, floorStep);
}

/** Extracts one named step's body from the job's `steps` mapping, stopping
 * before the next step. Similar headers elsewhere in the job cannot satisfy
 * a step-specific guard. */
function extractNamedStepBody(
  text: string,
  jobId: string,
  stepName: string,
): string {
  const jobBody = extractJobBody(text, jobId);
  const stepsBlock = findJobStepsBlock(jobBody);
  assert.ok(
    stepsBlock !== undefined,
    `steps mapping not found in job ${jobId}`,
  );
  const lines = stepsBlock.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const matchingSteps = lines
    .map((line, index) =>
      !scalarContent[index] && line === `      - name: ${stepName}`
        ? index
        : -1,
    )
    .filter((index) => index !== -1);
  assert.equal(
    matchingSteps.length,
    1,
    `expected exactly one step ${JSON.stringify(stepName)} in job ${jobId}, found ${matchingSteps.length}`,
  );
  const start = matchingSteps[0];
  const nextStep = lines.findIndex(
    (line, index) =>
      index > start && !scalarContent[index] && /^ {6}- /.test(line),
  );
  return lines.slice(start, nextStep === -1 ? undefined : nextStep).join('\n');
}

function workflowStepBlocks(workflow: string, jobId: string): string[] {
  const stepsBlock = findJobStepsBlock(extractJobBody(workflow, jobId));
  assert.ok(
    stepsBlock !== undefined,
    `steps mapping not found in job ${jobId}`,
  );
  const lines = stepsBlock.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const starts = lines
    .map((line, index) =>
      !scalarContent[index] && /^ {6}- /.test(line) ? index : -1,
    )
    .filter((index) => index !== -1);
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length).join('\n'),
  );
}

function assertFloorImmediatelyFollowsCheckout(
  workflow: string,
  jobId: string,
): void {
  const steps = workflowStepBlocks(workflow, jobId);
  const checkoutIndex = steps.findIndex((step) =>
    /^ {6}- uses: actions\/checkout@/m.test(step),
  );
  const floorIndex = steps.findIndex((step) =>
    /^ {6}- name: Assert Node\.js floor$/m.test(step),
  );
  assert.notEqual(checkoutIndex, -1, `${jobId}: checkout step must be present`);
  assert.notEqual(floorIndex, -1, `${jobId}: Node floor step must be present`);
  assert.equal(
    floorIndex,
    checkoutIndex + 1,
    `${jobId}: Node floor step must immediately follow checkout`,
  );
}

function assertWindowsNodeSetupBeforeCheckout(workflow: string): void {
  const steps = workflowStepBlocks(workflow, 'lint-windows');
  const sharedPin = readSharedSetupNodePin();
  const setupIndex = steps.findIndex((step) =>
    /^ {6}- name: Setup Node\.js$/m.test(step),
  );
  const checkoutIndex = steps.findIndex((step) =>
    /^ {6}- uses: actions\/checkout@/m.test(step),
  );
  assert.notEqual(
    setupIndex,
    -1,
    'lint-windows: Node setup step must be present',
  );
  assert.ok(
    setupIndex < checkoutIndex,
    'lint-windows: Node setup must precede checkout',
  );
  const setupStep = steps[setupIndex];
  assert.ok(setupStep, 'lint-windows: Node setup step must be present');
  const setupUseLines = setupStep
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.trimStart().startsWith('#') &&
        line.includes('actions/setup-node@'),
    );
  assert.equal(
    setupUseLines.length,
    1,
    'lint-windows: Node setup must have exactly one setup-node use',
  );
  const setupUseLine = setupUseLines.at(0);
  assert.ok(setupUseLine, 'lint-windows: Node setup uses line must be present');
  const setupUseMatch = SETUP_NODE_USE_LINE.exec(setupUseLine);
  assert.ok(
    setupUseMatch,
    'lint-windows: Node setup must use a 40-hex pin with a semver comment',
  );
  assert.equal(
    setupUseMatch[1],
    sharedPin,
    'lint-windows: Node setup must use the shared workflow pin',
  );
  const setupStepWithoutComments = setupStep
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.equal(
    setupStepWithoutComments.replace(
      setupUseLine,
      '        <shared setup-node pin>',
    ),
    [
      '      - name: Setup Node.js',
      '        <shared setup-node pin>',
      '        with:',
      '          check-latest: true',
      '          node-version: 24.x',
    ].join('\n'),
    'lint-windows: Node setup must retain its reviewed action pin and inputs',
  );
}

/** Returns the raw lines from a step's literal run block. Keeping comments
 * and shell syntax intact lets the guard compare the whole script against
 * its one supported command shape instead of approximating a shell lexer. */
function literalRunLinesFromStep(stepBody: string): string[] {
  const lines = stepBody.split('\n');
  const runStart = lines.findIndex((line) => /^ {8}run: \|[+-]?$/.test(line));
  assert.notEqual(runStart, -1, 'step must have a literal run: | block');

  const scriptLines: string[] = [];
  let contentIndent: number | undefined;
  for (const line of lines.slice(runStart + 1)) {
    if (line.trim() === '') {
      scriptLines.push('');
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= 8) {
      break;
    }
    if (contentIndent === undefined) {
      contentIndent = indent;
    } else if (indent < contentIndent) {
      break;
    }
    scriptLines.push(line.slice(contentIndent));
  }

  return scriptLines;
}

/** Exact package-based floor assertion expected in every workflow copy. */
const NODE_FLOOR_ASSERTION_LINES = [
  'const fs = require("fs");',
  'let enginesNode = "<unavailable>";',
  'let accepted = false;',
  'try {',
  '  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));',
  '  const declaredEnginesNode = manifest && manifest.engines && manifest.engines.node;',
  '  if (typeof declaredEnginesNode !== "string") throw new Error("missing engines.node");',
  '  enginesNode = declaredEnginesNode;',
  '  const clauses = enginesNode.trim().split(/\\s*\\|\\|\\s*/);',
  '  if (clauses.length < 2) throw new Error("invalid engines.node shape");',
  '  const versions = clauses.map((clause, index) => {',
  '    const pattern = index === clauses.length - 1',
  '      ? /^>=(\\d+)\\.(\\d+)\\.(\\d+)$/',
  '      : /^\\^(\\d+)\\.(\\d+)\\.(\\d+)$/;',
  '    const match = pattern.exec(clause);',
  '    if (!match) throw new Error("invalid engines.node clause");',
  '    const version = match.slice(1).map(Number);',
  '    if (!version.every(Number.isSafeInteger)) throw new Error("invalid version number");',
  '    return version;',
  '  });',
  '  const runtimeMatch = /^(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(process.versions.node);',
  '  if (!runtimeMatch) throw new Error("invalid runtime version");',
  '  const runtime = runtimeMatch.slice(1).map(Number);',
  '  const compare = (left, right) => {',
  '    for (let index = 0; index < 3; index += 1) {',
  '      if (left[index] !== right[index]) return left[index] - right[index];',
  '    }',
  '    return 0;',
  '  };',
  '  accepted = versions.slice(0, -1).some((version) =>',
  '    runtime[0] === version[0] && compare(runtime, version) >= 0',
  '  ) || compare(runtime, versions[versions.length - 1]) >= 0;',
  '} catch (error) {',
  '  accepted = false;',
  '}',
  'if (process.versions.node.includes("-")) accepted = false;',
  'if (!accepted) {',
  '  console.error("Node " + process.version + " does not satisfy package.json engines.node range: " + String(enginesNode));',
  '  process.exit(1);',
  '}',
];
const REQUIRED_NODE_FLOOR_ASSERTION = NODE_FLOOR_ASSERTION_LINES.join(' ')
  .replace(/\s+/g, ' ')
  .trim();

function assertNoNodeExecutionOverrides(text: string, scope: string): void {
  const lines = text.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const usesEnvironmentMergeKey = hasEnvironmentMergeKey(lines, scalarContent);
  assert.equal(
    usesEnvironmentMergeKey,
    false,
    `lint.yml: ${scope} must not use YAML merge keys in env mappings because merged Node overrides cannot be verified`,
  );
  assert.equal(
    hasUnverifiableEnvironmentKey(lines, scalarContent),
    false,
    `lint.yml: ${scope} must not use escaped, tagged, anchored, or aliased YAML env keys because their resolved names cannot be verified`,
  );
  const usesUnresolvedEnvironmentAlias = lines.some((line, index) => {
    if (scalarContent[index]) {
      return false;
    }
    return /(?:^|[{,])\s*(?:env|'env'|"env")\s*:\s*\*[A-Za-z0-9_.-]+/.test(
      stripYamlComment(line),
    );
  });
  assert.equal(
    usesUnresolvedEnvironmentAlias,
    false,
    'lint.yml: ' +
      scope +
      ' must not use an unresolved env alias because its preload values cannot be verified',
  );

  const executionOverrideToken =
    /\b(?:NODE_OPTIONS|BASH_ENV|SHELLOPTS|PATH|GITHUB_PATH|GITHUB_ENV)\b|\bBASH_FUNC_node%%/;
  const configuresOrReferencesOverride = lines.some((line, index) => {
    if (scalarContent[index]) {
      const shellLine = line.trimStart();
      return (
        !shellLine.startsWith('#') && executionOverrideToken.test(shellLine)
      );
    }
    const uncommented = stripYamlComment(line);
    const configuresOverride =
      /(?:^|[{,])\s*(?:NODE_OPTIONS|'NODE_OPTIONS'|"NODE_OPTIONS"|BASH_ENV|'BASH_ENV'|"BASH_ENV"|SHELLOPTS|'SHELLOPTS'|"SHELLOPTS"|BASH_FUNC_node%%|'BASH_FUNC_node%%'|"BASH_FUNC_node%%"|PATH|'PATH'|"PATH"|GITHUB_PATH|'GITHUB_PATH'|"GITHUB_PATH"|GITHUB_ENV|'GITHUB_ENV'|"GITHUB_ENV")\s*:/.test(
        uncommented,
      );
    const inlineRunValue = uncommented.match(
      /^\s*(?:-\s*)?(?:run|'run'|"run")\s*:(.*)$/,
    )?.[1];
    return (
      configuresOverride ||
      (inlineRunValue !== undefined &&
        executionOverrideToken.test(inlineRunValue))
    );
  });
  assert.equal(
    configuresOrReferencesOverride,
    false,
    `lint.yml: ${scope} must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV, which can bypass the floor assertion`,
  );
}

function assertLintJobEnforcesNodeFloor(jobBody: string): void {
  assertNoNodeExecutionOverrides(
    extractJobEnvironmentBlock(jobBody),
    'lint job environment',
  );
  const relevantSteps = findStepsThroughFloorCheck(jobBody);
  assertNoNodeExecutionOverrides(
    relevantSteps ?? findJobStepsBlock(jobBody) ?? '',
    'lint job steps through the Node floor check',
  );
  assert.equal(
    hasUnverifiableYamlKeyAtIndent(jobBody, 4),
    false,
    'lint.yml: lint job control keys must not be escaped, tagged, anchored, aliased, or explicit YAML keys',
  );
  assert.equal(
    hasUnverifiableYamlKeyAtIndent(relevantSteps ?? '', 8),
    false,
    'lint.yml: lint step control keys must not be escaped, tagged, anchored, aliased, or explicit YAML keys',
  );
  assert.doesNotMatch(
    jobBody,
    /^ {4}(?:container|'container'|"container")\s*:/m,
    'lint.yml: lint job must not use a container that can override the Node floor environment',
  );
  assert.equal(
    hasYamlMergeKeyAtIndent(jobBody, 4),
    false,
    'lint.yml: lint job must not use YAML merge keys that can inherit job controls',
  );
  assert.equal(
    hasStepLevelYamlMergeKey(jobBody),
    false,
    'lint.yml: lint job steps must not use YAML merge keys that can inherit step controls',
  );
  assert.equal(
    hasUnreviewedPreFloorExecution(jobBody),
    false,
    'lint.yml: actions and run steps before the Node floor check must use reviewed entries',
  );
  assert.doesNotMatch(
    jobBody,
    /^ {4}(?:if|'if'|"if")\s*:/m,
    'lint.yml: lint job must not be conditionally skipped',
  );
  assert.doesNotMatch(
    jobBody,
    /^ {4}(?:continue-on-error|'continue-on-error'|"continue-on-error")\s*:/m,
    'lint.yml: lint job must not set continue-on-error',
  );
  assert.doesNotMatch(
    jobBody,
    /^ {4}(?:needs|'needs'|"needs")\s*:/m,
    'lint.yml: lint job must not depend on a prerequisite that can skip it',
  );
}

const SHELL_ESCAPED_SINGLE_QUOTE = "'\"'\"'";

function assertLintJobUsesDefaultShell(
  jobBody: string,
  workflow: string,
): void {
  assert.equal(
    hasUnverifiableYamlKeyAtIndent(workflow, 0),
    false,
    'lint.yml: workflow root keys must not be escaped, tagged, anchored, aliased, or explicit YAML keys',
  );
  assertNoNodeExecutionOverrides(
    extractWorkflowEnvironmentBlock(workflow),
    'workflow environment',
  );
  assert.doesNotMatch(
    workflow,
    /^(?:defaults|'defaults'|"defaults")\s*:/m,
    'lint.yml: workflow must not declare defaults that can override the default shell',
  );
  assert.doesNotMatch(
    jobBody,
    /^ {4}(?:defaults|'defaults'|"defaults")\s*:/m,
    'lint.yml: lint job must not declare defaults that can override the default shell',
  );
}

/** Asserts the named step logs Node before running the exact engine-floor
 * assertion. Synthetic steps exercise rejected shell shapes. */
function assertNodeVersionLogBeforeFloor(stepBody: string): string {
  assertNoNodeExecutionOverrides(stepBody, 'Assert Node.js floor step');
  assert.equal(
    hasUnverifiableYamlKeyAtIndent(stepBody, 8),
    false,
    'lint.yml: Assert Node.js floor step control keys must not be escaped, tagged, anchored, aliased, or explicit YAML keys',
  );
  assert.equal(
    hasYamlMergeKeyAtIndent(stepBody, 8),
    false,
    'lint.yml: Assert Node.js floor step must not use YAML merge keys that can inherit step controls',
  );
  assert.doesNotMatch(
    stepBody,
    /^ {8}(?:if|'if'|"if")\s*:/m,
    'lint.yml: Assert Node.js floor step must not be conditionally skipped',
  );
  assert.doesNotMatch(
    stepBody,
    /^ {8}(?:continue-on-error|'continue-on-error'|"continue-on-error")\s*:/m,
    'lint.yml: Assert Node.js floor step must not set continue-on-error',
  );
  assert.doesNotMatch(
    stepBody,
    /^ {8}(?:shell|'shell'|"shell")\s*:/m,
    'lint.yml: Assert Node.js floor step must use the default shell',
  );
  const lines = literalRunLinesFromStep(stepBody)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  assert.equal(
    lines[0],
    'node --version',
    'lint.yml: Assert Node.js floor must execute node --version as the first shell command, with stdout visible',
  );
  assert.equal(
    lines[1],
    "node -e '",
    'lint.yml: the Node floor assertion must execute immediately after the version log',
  );
  const closingQuoteIndex = lines.indexOf("'", 2);
  assert.equal(
    closingQuoteIndex,
    lines.length - 1,
    'lint.yml: shell script must not leave a quote open or add commands after the floor assertion',
  );
  const assertionScript = lines
    .slice(2, closingQuoteIndex)
    .join(' ')
    .replaceAll(SHELL_ESCAPED_SINGLE_QUOTE, "'");
  const normalizedAssertionScript = assertionScript.replace(/\s+/g, ' ').trim();
  assert.equal(
    normalizedAssertionScript,
    REQUIRED_NODE_FLOOR_ASSERTION,
    'workflow: node -e must retain the Node engines.node floor assertion and its failing path while reading package.json',
  );
  assert.equal(
    normalizedAssertionScript.includes("'"),
    false,
    'workflow: inline JavaScript must not contain apostrophes that break the default Windows PowerShell shell',
  );
  return normalizedAssertionScript;
}

test('lint.yml logs Node.js version before asserting the Node floor', () => {
  const workflow = readWorkflow('lint.yml');
  const lintJob = extractJobBody(workflow, 'lint');
  assertLintJobEnforcesNodeFloor(lintJob);
  assertLintJobUsesDefaultShell(lintJob, workflow);
  assertFloorImmediatelyFollowsCheckout(workflow, 'lint');
  assertNodeVersionLogBeforeFloor(
    extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
  );
  assert.equal(
    unpinnedPreFloorCommand(lintJob, REPO_ROOT),
    undefined,
    'lint.yml: a reviewed pre-floor run must execute the pinned closure',
  );
});

test('all mirrored Node floor checks follow checkout and share one program', () => {
  const workflowCases = [
    ['lint.yml', 'lint'],
    ['lint.yml', 'lint-windows'],
    ['idd-advisory-convergence.yml', 'idd-advisory-convergence'],
    ['idd-advisory-convergence.yml', 'idd-advisory-convergence-self-waiver'],
    ['idd-advisory-convergence-comment.yml', 'refresh-if-idd-originated'],
  ] as const;
  const programs: string[] = [];

  for (const [workflowName, jobId] of workflowCases) {
    const workflow = readWorkflow(workflowName);
    const jobBody = extractJobBody(workflow, jobId);
    assertFloorImmediatelyFollowsCheckout(workflow, jobId);
    assertLintJobUsesDefaultShell(jobBody, workflow);
    programs.push(
      assertNodeVersionLogBeforeFloor(
        extractNamedStepBody(workflow, jobId, 'Assert Node.js floor'),
      ),
    );
  }

  assertWindowsNodeSetupBeforeCheckout(readWorkflow('lint.yml'));
  assert.equal(new Set(programs).size, 1);
});

test('live workflow Node floor checks match the package-based lint assertion', () => {
  const canonicalProgram = assertNodeVersionLogBeforeFloor(
    extractNamedStepBody(
      readWorkflow('lint.yml'),
      'lint',
      'Assert Node.js floor',
    ),
  );
  // Keep adopter templates out of this equality check because they do not
  // ship the source repository's package.json.
  const workflowCases = [
    ['idd-doctor.yml', 'idd-doctor'],
    ['review-policy-audit.yml', 'audit'],
  ] as const;
  assert.deepEqual(
    workflowCases.map(([workflowName]) => workflowName),
    ['idd-doctor.yml', 'review-policy-audit.yml'],
    'only the two source-repository workflows belong in this equality check',
  );

  const floor = enginesNodeFloor();
  for (const [workflowName, jobId] of workflowCases) {
    const workflow = readWorkflow(workflowName);
    assert.equal(
      workflow.includes(floor.lowBound),
      false,
      `${workflowName}: must not hard-code the Node floor`,
    );
    assert.equal(
      workflow.includes(floor.range),
      false,
      `${workflowName}: must not hard-code the engines.node range`,
    );
    const program = assertNodeVersionLogBeforeFloor(
      extractNamedStepBody(workflow, jobId, 'Assert Node.js floor'),
    );
    assert.equal(
      program,
      canonicalProgram,
      `${workflowName}: assertion must match lint.yml after whitespace normalization`,
    );
  }
});

test('lint-windows setup ignores comments that mention setup-node', () => {
  const workflow = readWorkflow('lint.yml');
  const annotatedWorkflow = workflow.replace(
    /^ {6}- name: Setup Node\.js$/m,
    (stepLine) =>
      `${stepLine}\n        # This comment mentions actions/setup-node@ without adding a use.`,
  );
  assert.notEqual(annotatedWorkflow, workflow);
  assertWindowsNodeSetupBeforeCheckout(annotatedWorkflow);
});

/** The timeout, in minutes, that the `lint` job keeps now that issue #5182
 * removed the full test suite from it. */
const LINT_JOB_TIMEOUT_MINUTES = '10';

/** Matches a shell command line that starts the Node test runner: `node` (or
 * `node.exe`, under any path, or an `npx node@22` style version) followed by
 * `--test`, possibly after other options. The lookbehind keeps a property
 * access such as `process.versions.node` from starting a match. A script
 * argument that happens to be spelled `--test...` also matches, which only
 * fails loudly. The pattern knows nothing about quotes or comments, so it is
 * applied to `executableShellText(line)`, never to a raw line (issue #5269). */
const NODE_TEST_COMMAND =
  /(?<![\w.-])node(?:@[\w.]+)?(?:\.exe)?\s(?:[^\n;&|]*\s)?--test(?!\w)/;

/** The command whose quoted arguments are only text that it prints. A quoted
 * argument of any other command can be code (`bash -c`, `eval`, a
 * stored `CMD='...'`, `node -e`, `ssh host '...'`), so the guard keeps it and
 * fails closed (issue #5269). */
const TEXT_PRINTING_COMMAND = /^echo$/;

/** Returns the index of the quote that closes the span opened at `start`, or
 * -1 when the line ends first. A backslash escapes only in double quotes. */
function shellQuoteEnd(line: string, start: number): number {
  const quote = line.charAt(start);
  let index = start + 1;
  while (index < line.length) {
    if (line.charAt(index) === quote) {
      return index;
    }
    index += quote === '"' && line.charAt(index) === '\\' ? 2 : 1;
  }
  return -1;
}

/** Returns whether the output of an `echo` on the line may become code: the
 * line pipes, redirects output, or opens a group or a command substitution
 * outside quotes (`echo 'node --test' | bash`, `echo 'node --test' > run.sh`,
 * `x=$(true; echo 'node --test'); eval "$x"`), or holds a `$'...'` or
 * `$"..."` quote, whose end this loop cannot find. A comment is not skipped,
 * so a pipe in a comment only keeps more text, which fails loudly. */
function echoOutputMayRun(line: string): boolean {
  let index = 0;
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === '\\') {
      index += 2;
    } else if (char === '"' || char === "'") {
      const end = shellQuoteEnd(line, index);
      if (end === -1) {
        return false;
      }
      if (line.charAt(index - 1) === '$') {
        return true;
      }
      index = end + 1;
    } else if (
      char === '>' ||
      char === '(' ||
      (char === '|' &&
        line.charAt(index - 1) !== '|' &&
        line.charAt(index + 1) !== '|')
    ) {
      return true;
    } else {
      index += 1;
    }
  }
  return false;
}

/** Returns the part of one shell line that can start a command, so that
 * `NODE_TEST_COMMAND` does not match text that only mentions `node --test`
 * (issue #5269; observed 2026-11-16 in the review of pull request #5268: the
 * false match on `echo "node --test"` and `echo ok # node --test`).
 *
 * One pass over the line. The default is to keep text, so a shape that the
 * scan does not know fails loudly instead of passing. Only two things are
 * removed:
 * - An unquoted `#` at the start of a word drops the rest of the line. A
 *   backslash makes the next character literal, so it never opens or closes
 *   a quote and never makes a following `#` start a comment, and the word
 *   start is read from the original line, never from the output.
 * - A quoted argument that holds whitespace or `;&|` becomes one space when
 *   the current simple command, the text since the last `;`, `&`, `|`, or
 *   `(`, starts with `echo`. Any other quoted span is kept with its quotes,
 *   because it can be code: `bash -c '...'`, `eval "$CMD"`, `CMD='...'`,
 *   `for c in '...'`, `node -e '...'`.
 *
 * A quoted span with no whitespace or `;&|`, an empty one included, is
 * unquoted in place, so `"node" --test`, `node '--test'`, and `node --te""st`
 * all still match. A line that holds a `${{` removes nothing, because GitHub
 * Actions substitutes the expression, quotes and all, before the shell reads
 * the line; nor does a line that pipes, redirects output, or opens a group or
 * substitution, because the output of an `echo` there can become code. Such
 * a line only unquotes spans in place.
 * The rest of the line is kept verbatim from a backtick, from a `$'...'` or
 * `$"..."` quote, from a double-quoted span with a `$(` or backtick in it,
 * and from a quote that never closes.
 *
 * Known limits. These fail loudly, as a false rejection: text that stays
 * unquoted (`echo node --test`, a heredoc body); a quoted argument of any
 * command but `echo` (`grep -q "node --test" f`), which includes an `echo`
 * after `then` or `{` or after a `>&` redirection, because the first word
 * since the last `;`, `&`, `|`, or `(` names the command; a `#` inside a kept
 * quoted span or after a backtick (`bash -c 'echo ok # node --test'`); and
 * any line with a `${{`, a pipe, a redirection, or a `(`. These pass, as a
 * false acceptance, although they can run the test runner: a group, pipe, or
 * substitution that spans lines (`x=$(` then `echo '...'` then `)`); a word
 * that an expansion or an escape builds, such as `node$IFS--test` or
 * `node\ --test` (the raw-line check missed them too); a `#` inside
 * `${...}`; a quoted variable glued to `node`; a comment that ends in a
 * backslash (the backslash-newline join runs first, as it always did); and a
 * command between two quotes on a line that starts inside a quote opened on
 * an earlier line, when that line starts with `echo`. The scan reads one line
 * alone, so it reads such a line as if it started outside a quote. */
function executableShellText(line: string): string {
  // GitHub Actions substitutes a `${{ ... }}` expression, quotes and all,
  // before the shell reads the line, so a line with one removes nothing. Nor
  // does a line where the output of an `echo` can become code.
  const keepAll = line.includes('${{') || echoOutputMayRun(line);
  let text = '';
  let index = 0;
  let afterEscape = false;
  let commandStart = 0;
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === '\\') {
      text += line.slice(index, index + 2);
      index += 2;
      afterEscape = true;
      continue;
    }
    const startsWord =
      index === 0 || (!afterEscape && /[\s;&|(]/.test(line.charAt(index - 1)));
    afterEscape = false;
    if (char === '#' && startsWord && !keepAll) {
      break;
    }
    if (char === '`') {
      return text + line.slice(index);
    }
    if (char !== '"' && char !== "'") {
      text += char;
      index += 1;
      if (/[;&|(]/.test(char)) {
        commandStart = text.length;
      }
      continue;
    }
    const end = shellQuoteEnd(line, index);
    if (end === -1 || text.endsWith('$')) {
      return text + line.slice(index);
    }
    const body = line.slice(index + 1, end);
    if (char === '"' && /\$\(|`/.test(body)) {
      return text + line.slice(index);
    }
    const command = /^\s*(\S+)/.exec(text.slice(commandStart))?.[1] ?? '';
    if (/^[^\s;&|]*$/.test(body)) {
      text += body;
    } else if (!keepAll && TEXT_PRINTING_COMMAND.test(command)) {
      text += ' ';
    } else {
      text += line.slice(index, end + 1);
    }
    index = end + 1;
  }
  return text;
}

function isWorkflowMapping(
  value: WorkflowYamlValue | undefined,
): value is WorkflowYamlMapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a workflow with the shared YAML subset reader and returns one job's
 * mapping. A construct the reader refuses, a missing root `jobs` mapping, or
 * a missing job fails the guard instead of passing it. */
function parsedWorkflowJob(
  workflow: string,
  jobId: string,
): WorkflowYamlMapping {
  const parsed = parseWorkflowYamlSubset(workflow);
  if (!parsed.ok) {
    assert.fail(
      `lint.yml: the workflow must parse with the YAML subset reader, but it refused ${parsed.violation.construct} at line ${parsed.violation.line}`,
    );
  }
  const jobs = isWorkflowMapping(parsed.value) ? parsed.value.jobs : undefined;
  assert.ok(isWorkflowMapping(jobs), 'lint.yml: root jobs mapping not found');
  const job = jobs[jobId];
  assert.ok(isWorkflowMapping(job), `lint.yml: job ${jobId} not found`);
  return job;
}

/** Requires the job's own `timeout-minutes` key to be exactly `minutes`. The
 * reader resolves no scalar types, so `10`, `'10'`, and `"10"` all read as
 * `10`, while a missing key, another value, a step-level key, and an
 * expression all fail. */
function assertJobTimeoutMinutes(
  workflow: string,
  jobId: string,
  minutes: string,
): void {
  assert.equal(
    parsedWorkflowJob(workflow, jobId)['timeout-minutes'],
    minutes,
    `lint.yml: ${jobId} job must keep timeout-minutes: ${minutes} (#5182)`,
  );
}

/** Requires that no `run` line of the job's steps starts the Node test
 * runner. Backslash-newline continuations are joined first. Each line is
 * reduced by `executableShellText`, so a comment or a quoted argument that
 * only mentions `node --test` does not count. */
function assertJobRunsNoNodeTest(workflow: string, jobId: string): void {
  const { steps } = parsedWorkflowJob(workflow, jobId);
  assert.ok(
    Array.isArray(steps) && steps.length > 0,
    `lint.yml: ${jobId} job must list steps`,
  );
  for (const step of steps) {
    if (!isWorkflowMapping(step) || typeof step.run !== 'string') {
      continue;
    }
    for (const line of step.run.replace(/\\\n/g, ' ').split('\n')) {
      assert.doesNotMatch(
        executableShellText(line),
        NODE_TEST_COMMAND,
        `lint.yml: ${jobId} job must not run the test suite with node --test (#5182): ${line.trim()}`,
      );
    }
  }
}

/** Replaces one exact occurrence, so a mutation that no longer matches the
 * live workflow fails the test instead of passing without testing anything. */
function replaceOnce(text: string, from: string, to: string): string {
  assert.equal(
    text.split(from).length,
    2,
    `expected exactly one occurrence of ${JSON.stringify(from)}`,
  );
  return text.replace(from, () => to);
}

/** The lint job step that the step-restoring mutations are inserted ahead of. */
const LINT_NEXT_STEP = '      - name: Run workshop integrity check\n';

/** Returns the workflow with `step` (whole YAML text, newline-terminated)
 * inserted ahead of `LINT_NEXT_STEP`. The edit touches only the lint job's own
 * text, so a second job that repeats the anchor cannot make it ambiguous. */
function withLintStep(workflow: string, step: string): string {
  const lintJob = extractJobBody(workflow, 'lint');
  return replaceOnce(
    workflow,
    lintJob,
    replaceOnce(lintJob, LINT_NEXT_STEP, `${step}${LINT_NEXT_STEP}`),
  );
}

/** Builds a minimal workflow whose lint job has one step that runs `line`.
 * The line sits in a block scalar so the shell sees it byte for byte: the YAML
 * reader would strip a trailing ` # ...` from a plain scalar before then. */
function lintWorkflowWithRunLine(line: string): string {
  return [
    'jobs:',
    '  lint:',
    '    timeout-minutes: 10',
    '    steps:',
    '      - name: Run one line',
    '        run: |',
    `          ${line}`,
  ].join('\n');
}

/** Steps that restore the removed test suite in each shape the guard must keep
 * rejecting (issues #5182 and #5266). */
const RESTORED_NODE_TEST_STEPS = [
  [
    'the removed suite step under its old name',
    '      - name: Run bare-Node test suite\n        run: node --test --import ./tests/isolate-state.mts tests/*.test.mts\n',
  ],
  [
    'a node --test line inside a run block',
    '      - name: Run unit tests\n        run: |\n          echo start\n          node --test tests/*.test.mts\n',
  ],
  [
    'node --test after other options',
    '      - name: Run unit tests\n        run: node --import ./tests/isolate-state.mts --test tests/*.test.mts\n',
  ],
  [
    'node --test on a continued line',
    '      - name: Run unit tests\n        run: |\n          node \\\n            --test tests/*.test.mts\n',
  ],
  [
    'a flow-mapping step',
    '      - { name: Run unit tests, run: node --test tests/ }\n',
  ],
  [
    'node --test through an absolute path',
    '      - name: Run unit tests\n        run: /usr/bin/node --test tests/*.test.mts\n',
  ],
  [
    'node.exe with other options before --test',
    '      - name: Run unit tests\n        run: node.exe --import ./tests/isolate-state.mts --test tests/\n',
  ],
  [
    'node --test through a versioned npx command',
    '      - name: Run unit tests\n        run: npx node@22 --test tests/*.test.mts\n',
  ],
] as const;

test('lint.yml keeps the lint job timeout at 10 minutes and runs no node --test step', () => {
  const workflow = readWorkflow('lint.yml');
  assertJobTimeoutMinutes(workflow, 'lint', LINT_JOB_TIMEOUT_MINUTES);
  assertJobRunsNoNodeTest(workflow, 'lint');
});

test('changing the lint job timeout is rejected', () => {
  const workflow = readWorkflow('lint.yml');
  const lintJob = extractJobBody(workflow, 'lint');
  // Each mutation edits only the lint job's own text, so a second job that
  // repeats a step or a timeout line cannot make an anchor ambiguous.
  const mutateLintJob = (mutate: (jobBody: string) => string): string =>
    replaceOnce(workflow, lintJob, mutate(lintJob));
  const timeoutLine = '    timeout-minutes: 10\n    steps:\n';
  const timeoutMutations = [
    [
      'a longer timeout',
      mutateLintJob((job) =>
        replaceOnce(job, timeoutLine, '    timeout-minutes: 30\n    steps:\n'),
      ),
    ],
    [
      'the old shorter timeout',
      mutateLintJob((job) =>
        replaceOnce(job, timeoutLine, '    timeout-minutes: 15\n    steps:\n'),
      ),
    ],
    [
      'a removed timeout',
      mutateLintJob((job) => replaceOnce(job, timeoutLine, '    steps:\n')),
    ],
    [
      'a step-level timeout only',
      mutateLintJob((job) =>
        replaceOnce(
          replaceOnce(job, timeoutLine, '    steps:\n'),
          '        run: node scripts/audit-docs.mjs --check\n',
          '        run: node scripts/audit-docs.mjs --check\n        timeout-minutes: 10\n',
        ),
      ),
    ],
  ] as const;
  for (const [description, mutated] of timeoutMutations) {
    assert.notEqual(mutated, workflow, description);
    assert.throws(
      () => assertJobTimeoutMinutes(mutated, 'lint', LINT_JOB_TIMEOUT_MINUTES),
      /lint job must keep timeout-minutes: 10/,
      `accepted ${description}`,
    );
  }
});

test('the lint job node --test guard ignores quoted and commented text but still rejects the restored and running shapes', () => {
  const workflow = readWorkflow('lint.yml');
  const noNodeTest = /lint job must not run the test suite with node --test/;
  const withRunLine = (line: string): string =>
    withLintStep(
      workflow,
      `      - name: Mention node --test\n        run: |\n          ${line}\n`,
    );

  // Text that only mentions node --test passes, in the live lint job and in a
  // minimal one (issue #5269).
  const mentionedLines = [
    'echo "node --test"',
    'echo ok # node --test',
    'echo "" "node --test"',
    'echo "a" "node --test" "b"',
    'echo "a b" "node --test"',
    'echo "node --test" || true',
    'echo "a > b" "node --test"',
    'echo "a | b" "node --test"',
    "echo 'node --test' \\| true",
    "echo ok # don't run node --test",
    'echo "node --test" && echo ok',
    'echo "" # node --test',
    "echo 'node --test'",
    'echo "node --test" # node --test',
    'echo "a;node" --test',
    "echo '$(node --test)'",
    'echo ok;# node --test',
    'echo a\\ b # node --test',
    'node --version # node --test',
    '# node --test tests/',
  ] as const;
  for (const line of mentionedLines) {
    assertJobRunsNoNodeTest(withRunLine(line), 'lint');
    assertJobRunsNoNodeTest(lintWorkflowWithRunLine(line), 'lint');
  }

  // Every restored-step row keeps failing, and so does a node --test that sits
  // in a quoted shell command string.
  for (const [description, step] of RESTORED_NODE_TEST_STEPS) {
    const mutated = withLintStep(workflow, step);
    assert.throws(
      () => assertJobRunsNoNodeTest(mutated, 'lint'),
      noNodeTest,
      `accepted ${description}`,
    );
  }
  const bashCommandString = withRunLine("bash -c 'node --test tests/'");
  assert.throws(
    () => assertJobRunsNoNodeTest(bashCommandString, 'lint'),
    noNodeTest,
    "accepted bash -c 'node --test tests/' in the live lint job",
  );

  // Shapes that run node --test, hide it behind quoting or escaping tricks, or
  // keep it in a quoted argument of a command other than echo keep
  // failing in a minimal lint job. The last kind is a deliberate loud
  // rejection: that argument can be code. The scanner reads each line alone.
  const runningLines = [
    'node --test tests/*.test.mts',
    'node --import ./tests/isolate-state.mts --test tests/*.test.mts',
    '/usr/bin/node --test tests/*.test.mts',
    'npx node@22 --test tests/*.test.mts',
    "bash -c 'node --test tests/'",
    'echo "x" && node --test tests/',
    'echo `node --test`',
    'echo `echo a #b` ; node --test',
    'CMD=\'node --test tests/\'; eval "$CMD"',
    'CMD+=\'node --test\'; eval "$CMD"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansion under test, not a forgotten template placeholder.
    'CMD[0]=\'node --test\'; eval "${CMD[0]}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansion under test, not a forgotten template placeholder.
    'CMD=("node --test"); eval "${CMD[*]}"',
    'printf -v CMD \'node --test\'; eval "$CMD"',
    'for CMD in \'node --test\'; do eval "$CMD"; done',
    'export CMD="node --test"',
    'grep -q "node --test" tests/x',
    "echo 'node --test' | bash",
    "echo 'node --test' > run.sh",
    'x=$(echo \'node --test\'); eval "$x"',
    'x=$(true; echo \'node --test\'); eval "$x"',
    "bash <(true; echo 'node --test')",
    "echo 'node --test #' $'\\'' | bash",
    "echo ok; bash -c 'node --test'",
    "echo ok && bash -c 'node --test'",
    "echo ok | bash -c 'node --test'",
    "echo $(bash -c 'node --test')",
    'echo=\'node --test\'; eval "$echo"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    "${{ 'node --test tests/' }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    "\\${{ 'node --test tests/' }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    'echo "${{ \'node --test\' }}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    "echo ${{ '; node --test' }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    "node '--test' tests/ ${{ github.sha }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    '"node" --test ${{ github.sha }}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    "node ${{ '--test' }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    'echo ok # node --test ${{ x }}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    "echo \\${{ '; node --test' }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    "echo 'x ${{ '''' }} ; node --test ; echo 'y'",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    "echo ok && ${{ 'node --test tests/' }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
    "${{ runner.os == 'Windows' && 'node.exe --test tests/' || 'node --test tests/' }}",
    'node --te""st',
    'n""ode --test',
    "bash -\\c 'node --test tests/'",
    "ev\\al 'node --test'",
    'echo "$(node --test)"',
    'echo "$(echo "x"; node --test)"',
    'echo "`node --test`"',
    '"node" --test',
    "node '--test' tests/",
    'node --import "./a b.mts" --test tests/',
    'sh -c "node --test"',
    "bash -ce 'node --test'",
    "bash -c -x 'node --test tests/'",
    "bash --command 'node --test tests/'",
    "bash -c 2>&1 'node --test tests/'",
    "bash<<<'node --test tests/'",
    'cmd /c "node --test tests/"',
    'echo $"node --test"',
    "bash -c $'node --test tests/'",
    "pwsh -Command 'node --test tests/'",
    "echo $'\\'' ; node --test ; echo $'\\''",
    "bash <<< 'node --test tests/'",
    "eval 'node --test'",
    'echo "a \\" b" ; node --test ; echo "c"',
    'echo a\\ #b ; node --test',
    "echo 'a\\' ; node --test ; echo 'b'",
    'echo $(true)#x ; node --test',
    'echo "a b"#x ; node --test',
    'echo "unterminated node --test',
    'node --test tests/ # run',
  ] as const;
  for (const line of runningLines) {
    assert.throws(
      () => assertJobRunsNoNodeTest(lintWorkflowWithRunLine(line), 'lint'),
      noNodeTest,
      `accepted ${line}`,
    );
  }
});

test('comments, other node commands, and other jobs do not trip the lint job guards', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    timeout-minutes: 10',
    '    steps:',
    '      # node --test tests/*.test.mts',
    '      - name: Static audits',
    '        run: |',
    '          # node --test tests/*.test.mts',
    '          node --version',
    "          node -e 'console.log(process.versions.node)'",
    '          node scripts/audit-docs.mjs --check',
    '          echo engines.node --test-free',
    '  other:',
    '    timeout-minutes: 15',
    '    steps:',
    '      - run: node --test tests/*.test.mts',
  ].join('\n');
  assertJobTimeoutMinutes(workflow, 'lint', '10');
  assertJobRunsNoNodeTest(workflow, 'lint');
  assert.throws(
    () => assertJobRunsNoNodeTest(workflow, 'other'),
    /other job must not run the test suite with node --test/,
  );
});

test('a workflow the YAML subset reader refuses or a missing lint job cannot pass the lint job guards', () => {
  const anchored = [
    'jobs:',
    '  lint:',
    '    timeout-minutes: &minutes 10',
    '    steps:',
    '      - run: node --version',
  ].join('\n');
  assert.throws(
    () => assertJobTimeoutMinutes(anchored, 'lint', '10'),
    /must parse with the YAML subset reader, but it refused anchor/,
  );
  assert.throws(
    () => assertJobRunsNoNodeTest(anchored, 'lint'),
    /must parse with the YAML subset reader/,
  );

  const noSteps = ['jobs:', '  lint:', '    timeout-minutes: 10'].join('\n');
  assert.throws(
    () => assertJobRunsNoNodeTest(noSteps, 'lint'),
    /lint job must list steps/,
  );
  assert.throws(
    () =>
      assertJobTimeoutMinutes('jobs:\n  other:\n    steps: []', 'lint', '10'),
    /job lint not found/,
  );
});

function evaluateNodeFloorProgram(
  program: string,
  runtimeVersion: string,
  manifestText: string,
  readError?: Error,
): { exitCode: number | undefined; diagnostics: string[] } {
  let exitCode: number | undefined;
  const diagnostics: string[] = [];
  runInNewContext(program, {
    require: (moduleName: string) => {
      assert.equal(moduleName, 'fs');
      return {
        readFileSync: (path: string, encoding: string) => {
          assert.equal(path, 'package.json');
          assert.equal(encoding, 'utf8');
          if (readError !== undefined) throw readError;
          return manifestText;
        },
      };
    },
    process: {
      version: `v${runtimeVersion}`,
      versions: { node: runtimeVersion },
      exit: (code: number) => {
        exitCode = code;
      },
    },
    console: {
      error: (message: string) => diagnostics.push(String(message)),
    },
  });
  return { exitCode, diagnostics };
}

test('the package-based Node floor matches every documented runtime boundary', () => {
  const workflow = readWorkflow('lint.yml');
  const program = assertNodeVersionLogBeforeFloor(
    extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
  );
  const manifestText = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
  const enginesRange = JSON.parse(manifestText).engines.node as string;
  const { lowBound } = enginesNodeFloor();
  const cases: readonly [string, boolean][] = [
    ['22.23.1', false],
    [lowBound, true],
    ['23.0.0', false],
    ['24.1.9', false],
    ['24.2.0', true],
    ['25.0.0', false],
    ['26.0.0', true],
    [`${lowBound}-rc.1`, false],
  ];

  for (const [runtimeVersion, expectedToPass] of cases) {
    const result = evaluateNodeFloorProgram(
      program,
      runtimeVersion,
      manifestText,
    );
    assert.equal(
      result.exitCode === undefined,
      expectedToPass,
      `unexpected Node floor result for ${runtimeVersion}`,
    );
    if (!expectedToPass) {
      assert.equal(
        result.diagnostics[0],
        `Node v${runtimeVersion} does not satisfy package.json engines.node range: ${enginesRange}`,
      );
    }
  }
});

test('the package-based Node floor fails closed for malformed or unreadable manifests', () => {
  const workflow = readWorkflow('lint.yml');
  const program = assertNodeVersionLogBeforeFloor(
    extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
  );
  const { lowBound } = enginesNodeFloor();
  const floorRange = `^${lowBound}`;
  const malformedManifests: readonly [string, string][] = [
    ['{}', '<unavailable>'],
    ['{"engines":{}}', '<unavailable>'],
    ['{"engines":{"node":24}}', '<unavailable>'],
    [JSON.stringify({ engines: { node: floorRange } }), floorRange],
    ['{"engines":{"node":">=22.0.0 || ^24.0.0"}}', '>=22.0.0 || ^24.0.0'],
    ['{', '<unavailable>'],
  ];
  for (const [manifestText, expectedRange] of malformedManifests) {
    const result = evaluateNodeFloorProgram(program, lowBound, manifestText);
    assert.equal(result.exitCode, 1);
    assert.equal(
      result.diagnostics[0],
      `Node v${lowBound} does not satisfy package.json engines.node range: ${expectedRange}`,
    );
  }

  const unreadable = evaluateNodeFloorProgram(
    program,
    lowBound,
    '',
    new Error('EACCES'),
  );
  assert.equal(unreadable.exitCode, 1);
  assert.equal(
    unreadable.diagnostics[0],
    `Node v${lowBound} does not satisfy package.json engines.node range: <unavailable>`,
  );
});

test('a conditionally skipped lint job cannot satisfy the Node log guard', () => {
  for (const condition of ['false', '${' + '{ false }}']) {
    assert.throws(
      () => assertLintJobEnforcesNodeFloor(`    if: ${condition}`),
      /lint job must not be conditionally skipped/,
      `accepted job condition: ${condition}`,
    );
  }
});

test('a YAML comment cannot hide a later lint job condition', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    steps:',
    '      - name: Assert Node.js floor',
    '        run: |',
    '          node --version',
    '  # This comment does not end the lint job.',
    '    if: false',
    '  other:',
    '    runs-on: ubuntu-latest',
  ].join('\n');

  assert.throws(
    () => assertLintJobEnforcesNodeFloor(extractJobBody(workflow, 'lint')),
    /lint job must not be conditionally skipped/,
  );
});

test('a prerequisite-dependent lint job cannot skip the Node floor guard', () => {
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    needs: gate'),
    /lint job must not depend on a prerequisite that can skip it/,
  );
});

test('quoted YAML job keys cannot bypass skip or failure guards', () => {
  for (const quote of ["'", '"']) {
    assert.throws(
      () => assertLintJobEnforcesNodeFloor(`    ${quote}if${quote}: false`),
      /lint job must not be conditionally skipped/,
    );
    assert.throws(
      () =>
        assertLintJobEnforcesNodeFloor(
          `    ${quote}continue-on-error${quote}: true`,
        ),
      /lint job must not set continue-on-error/,
    );
  }
});

test('duplicate Node floor step names are rejected as ambiguous', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    steps:',
    '      - name: Assert Node.js floor',
    '        run: node --version',
    '      - name: Assert Node.js floor',
    '        run: node -e "process.exit(1)"',
  ].join('\n');

  assert.throws(
    () => extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
    /expected exactly one step .* found 2/,
  );
});

test('a YAML block scalar cannot impersonate the named Node floor step', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    fake: |',
    '      - name: Assert Node.js floor',
    '        run: |',
    '          node --version',
    "          node -e '",
    '            process.exit(0);',
    "          '\n",
    '    steps:',
    '      - name: Other step',
    '        run: echo ok',
  ].join('\n');

  assert.throws(
    () => extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
    /expected exactly one step .* found 0/,
  );
});

test('a same-named list item outside job.steps cannot impersonate the floor step', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    metadata:',
    '      - name: Assert Node.js floor',
    '        run: |',
    '          node --version',
    '          node -e "process.exit(0)"',
    '    steps:',
    '      - name: Other step',
    '        run: echo ok',
  ].join('\n');

  assert.throws(
    () => extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
    /expected exactly one step .* found 0/,
  );
});

test('job extraction ignores job-like headers inside YAML block scalars', () => {
  const missingLintJob = [
    'metadata: |',
    '  lint:',
    '    continue-on-error: true',
    'jobs:',
    '  other:',
    '    runs-on: ubuntu-latest',
  ].join('\n');
  assert.throws(
    () => extractJobBody(missingLintJob, 'lint'),
    /job lint not found/,
  );

  const actualLintJob = [
    'metadata: |',
    '  lint:',
    '    continue-on-error: true',
    'jobs:',
    '  lint:',
    '    runs-on: ubuntu-latest',
    '  other:',
    '    runs-on: ubuntu-latest',
  ].join('\n');
  const lintJob = extractJobBody(actualLintJob, 'lint');
  assert.match(lintJob, /^ {4}runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(lintJob, /continue-on-error/);
});

test('job extraction only searches the root jobs mapping', () => {
  const workflow = [
    'metadata:',
    '  lint:',
    '    runs-on: ubuntu-latest',
    'jobs:',
    '  lint:',
    '    if: false',
    '    steps:',
    '      - name: Other step',
    '        run: echo ok',
  ].join('\n');

  assert.throws(
    () => assertLintJobEnforcesNodeFloor(extractJobBody(workflow, 'lint')),
    /lint job must not be conditionally skipped/,
  );
});

test('anchored or quoted-key block scalars cannot impersonate the lint job', () => {
  for (const scalarHeader of [
    'metadata: &note |',
    '"metadata: note": &note |',
    'metadata: |-',
    'metadata: |+',
  ]) {
    const workflow = [
      scalarHeader,
      '  lint:',
      '    runs-on: ubuntu-latest',
      'jobs:',
      '  lint:',
      '    if: false',
      '    steps:',
      '      - name: Other step',
      '        run: echo ok',
    ].join('\n');
    const lintJob = extractJobBody(workflow, 'lint');
    assert.throws(
      () => assertLintJobEnforcesNodeFloor(lintJob),
      /lint job must not be conditionally skipped/,
    );
  }
});

test('a command inside a quoted here-document cannot satisfy the Node log guard', () => {
  const stepBody = [
    '      - name: Assert Node.js floor',
    '        run: |',
    "          : <<'COMMENT'",
    '            node --version',
    '          COMMENT',
    "          node -e '",
    '            process.versions.node.split(".");',
    "          '",
  ].join('\n');

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor must execute node --version/,
  );
});

test('a nine-space shell comment cannot satisfy the Node version log guard', () => {
  const stepBody = [
    '      - name: Assert Node.js floor',
    '        run: |',
    '         # node --version',
    "         node -e '",
    '           const versionParts = process.versions.node.split(".");',
    '           const ok = false;',
    '           if (!ok) { process.exit(1); }',
    "         '",
  ].join('\n');

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor must execute node --version/,
  );
});

test('a command inside a multiline shell string cannot satisfy the Node log guard', () => {
  const stepBody = [
    '      - name: Assert Node.js floor',
    '        run: |',
    "          printf '%s\\n' 'example text",
    '          node --version',
    "          still quoted'",
    "          node -e '",
    '            const versionParts = process.versions.node.split(".");',
    '            const ok = false;',
    '            if (!ok) { process.exit(1); }',
    "          '",
  ].join('\n');

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor must execute node --version/,
  );
});

const SYNTHETIC_FLOOR_ASSERTION = NODE_FLOOR_ASSERTION_LINES;

function syntheticFloorStep(
  shellLines: string[],
  assertionLines = SYNTHETIC_FLOOR_ASSERTION,
): string {
  return [
    '      - name: Assert Node.js floor',
    '        run: |',
    ...shellLines.map((line) => `          ${line}`),
    "          node -e '",
    ...assertionLines.map(
      (line) => `            ${line.replaceAll("'", "'\"'\"'")}`,
    ),
    "          '",
  ].join('\n');
}

test('a conditionally skipped workflow step cannot satisfy the Node log guard', () => {
  for (const condition of ['false', '${' + '{ false }}']) {
    const stepBody = syntheticFloorStep(['node --version']).replace(
      '        run: |',
      `        if: ${condition}\n        run: |`,
    );

    assert.throws(
      () => assertNodeVersionLogBeforeFloor(stepBody),
      /step must not be conditionally skipped/,
      `accepted step condition: ${condition}`,
    );
  }
});

test('job or step continue-on-error cannot hide a Node floor failure', () => {
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    continue-on-error: true'),
    /lint job must not set continue-on-error/,
  );

  const stepBody = syntheticFloorStep(['node --version']).replace(
    '        run: |',
    '        continue-on-error: true\n        run: |',
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /floor step must not set continue-on-error/,
  );
});

test('quoted YAML step keys cannot bypass skip or failure guards', () => {
  for (const quote of ["'", '"']) {
    const conditionalStep = syntheticFloorStep(['node --version']).replace(
      '        run: |',
      `        ${quote}if${quote}: false\n        run: |`,
    );
    assert.throws(
      () => assertNodeVersionLogBeforeFloor(conditionalStep),
      /step must not be conditionally skipped/,
    );

    const continueOnErrorStep = syntheticFloorStep(['node --version']).replace(
      '        run: |',
      `        ${quote}continue-on-error${quote}: true\n        run: |`,
    );
    assert.throws(
      () => assertNodeVersionLogBeforeFloor(continueOnErrorStep),
      /floor step must not set continue-on-error/,
    );
  }
});

test('custom shell templates cannot skip Node floor execution', () => {
  for (const quote of ["'", '"']) {
    assert.throws(
      () =>
        assertNodeVersionLogBeforeFloor(
          syntheticFloorStep(['node --version']).replace(
            '        run: |',
            `        ${quote}shell${quote}: bash -n {0}\n        run: |`,
          ),
        ),
      /floor step must use the default shell/,
    );
  }
  assert.throws(
    () =>
      assertLintJobUsesDefaultShell(
        '    defaults:\n      run:\n        shell: bash -n {0}',
        '',
      ),
    /lint job must not declare defaults/,
  );
  assert.throws(
    () =>
      assertLintJobUsesDefaultShell(
        "    defaults: { run: { shell: 'bash -n {0}' } }",
        '',
      ),
    /lint job must not declare defaults/,
  );
  assert.throws(
    () =>
      assertLintJobUsesDefaultShell(
        '',
        'defaults:\n  run:\n    shell: bash -n {0}',
      ),
    /workflow must not declare defaults/,
  );
  for (const workflow of [
    'defaults: # trailing YAML comment\n  run:\n    shell: bash -n {0}',
    '"defaults" : &lint-defaults\n  run:\n    shell: bash -n {0}',
  ]) {
    assert.throws(
      () => assertLintJobUsesDefaultShell('', workflow),
      /workflow must not declare defaults/,
    );
  }
});

test('Node and Bash startup overrides are rejected at every lint scope', () => {
  for (const variable of ['NODE_OPTIONS', 'BASH_ENV', 'SHELLOPTS']) {
    const options =
      variable === 'SHELLOPTS' ? 'noexec' : '--require=./exit.cjs';
    const assignments = [
      `${variable}: ${options}`,
      `"${variable}": ${options}`,
      `{ ${variable}: ${options} }`,
      `{ CI: true, ${variable}: ${options} }`,
    ];
    for (const assignment of assignments) {
      const jobEnvironment = assignment.startsWith('{')
        ? `    env: ${assignment}`
        : `    env:\n      ${assignment}`;
      const workflowEnvironment = assignment.startsWith('{')
        ? `env: ${assignment}`
        : `env:\n  ${assignment}`;
      const stepEnvironment = assignment.startsWith('{')
        ? `        env: ${assignment}`
        : `        env:\n          ${assignment}`;
      assert.throws(
        () => assertLintJobEnforcesNodeFloor(jobEnvironment),
        /must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV/,
      );
      assert.throws(
        () => assertLintJobUsesDefaultShell('', workflowEnvironment),
        /workflow environment must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV/,
      );

      const stepBody = syntheticFloorStep(['node --version']).replace(
        '        run: |',
        `${stepEnvironment}\n        run: |`,
      );
      assert.throws(
        () => assertNodeVersionLogBeforeFloor(stepBody),
        /Assert Node\.js floor step must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV/,
      );
    }

    const scriptWrite = `echo ${variable}=${options} >> "$GITHUB_ENV"`;
    assert.throws(
      () =>
        assertLintJobEnforcesNodeFloor(
          `    steps:\n      - run: |\n          ${scriptWrite}`,
        ),
      /must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV/,
    );
    assert.throws(
      () => assertNodeVersionLogBeforeFloor(syntheticFloorStep([scriptWrite])),
      /Assert Node\.js floor step must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV/,
    );
  }
});

test('exported Node shell functions are rejected at every lint scope', () => {
  const functionBody = '() { echo v26.0.0; return 0; }';
  const assignments = [
    `BASH_FUNC_node%%: "${functionBody}"`,
    `"BASH_FUNC_node%%": "${functionBody}"`,
    `{ BASH_FUNC_node%%: "${functionBody}" }`,
    `{ CI: true, "BASH_FUNC_node%%": "${functionBody}" }`,
  ];
  const rejection =
    /must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV/;

  for (const assignment of assignments) {
    const jobEnvironment = assignment.startsWith('{')
      ? `    env: ${assignment}`
      : `    env:\n      ${assignment}`;
    const workflowEnvironment = assignment.startsWith('{')
      ? `env: ${assignment}`
      : `env:\n  ${assignment}`;
    const stepEnvironment = assignment.startsWith('{')
      ? `        env: ${assignment}`
      : `        env:\n          ${assignment}`;
    assert.throws(
      () => assertLintJobEnforcesNodeFloor(jobEnvironment),
      rejection,
    );
    assert.throws(
      () => assertLintJobUsesDefaultShell('', workflowEnvironment),
      rejection,
    );
    assert.throws(
      () =>
        assertNodeVersionLogBeforeFloor(
          syntheticFloorStep(['node --version']).replace(
            '        run: |',
            `${stepEnvironment}\n        run: |`,
          ),
        ),
      rejection,
    );
  }

  const scriptWrite = `echo 'BASH_FUNC_node%%=${functionBody}' >> "$GITHUB_ENV"`;
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        `    steps:\n      - run: |\n          ${scriptWrite}`,
      ),
    rejection,
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(syntheticFloorStep([scriptWrite])),
    rejection,
  );
});

test('PATH overrides and Actions environment file writes are rejected', () => {
  const assignments = [
    'PATH: /tmp/fake-bin',
    '"PATH": /tmp/fake-bin',
    '{ PATH: /tmp/fake-bin }',
    '{ CI: true, "PATH": /tmp/fake-bin }',
  ];
  const rejection =
    /must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV/;

  for (const assignment of assignments) {
    const jobEnvironment = assignment.startsWith('{')
      ? `    env: ${assignment}`
      : `    env:\n      ${assignment}`;
    const workflowEnvironment = assignment.startsWith('{')
      ? `env: ${assignment}`
      : `env:\n  ${assignment}`;
    const stepEnvironment = assignment.startsWith('{')
      ? `        env: ${assignment}`
      : `        env:\n          ${assignment}`;
    assert.throws(
      () => assertLintJobEnforcesNodeFloor(jobEnvironment),
      rejection,
    );
    assert.throws(
      () => assertLintJobUsesDefaultShell('', workflowEnvironment),
      rejection,
    );
    assert.throws(
      () =>
        assertNodeVersionLogBeforeFloor(
          syntheticFloorStep(['node --version']).replace(
            '        run: |',
            `${stepEnvironment}\n        run: |`,
          ),
        ),
      rejection,
    );
  }

  const pathWrite = `echo '/tmp/fake-bin' >> "$GITHUB_PATH"`;
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        `    steps:\n      - run: |\n          ${pathWrite}`,
      ),
    rejection,
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(syntheticFloorStep([pathWrite])),
    rejection,
  );
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        '    steps:\n      - run: echo /tmp/fake-bin >> "$GITHUB_PATH"',
      ),
    rejection,
  );
  assert.throws(
    () =>
      assertNodeVersionLogBeforeFloor(
        [
          '      - name: Assert Node.js floor',
          '        run: echo NODE_OPTIONS=--require=./exit.cjs >> "$GITHUB_ENV"',
        ].join('\n'),
      ),
    rejection,
  );
  const indirectWrite = `printf '%s%s=%s\\n' NODE_ OPTIONS --require=./exit.cjs >> "$GITHUB_ENV"`;
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        `    steps:\n      - run: |\n          ${indirectWrite}`,
      ),
    rejection,
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(syntheticFloorStep([indirectWrite])),
    rejection,
  );
});

test('YAML merge keys in env mappings are rejected at every lint scope', () => {
  const rejection = /must not use YAML merge keys in env mappings/;
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    env:\n      <<: *shared-env'),
    rejection,
  );
  assert.throws(
    () => assertLintJobUsesDefaultShell('', 'env:\n  <<: *shared-env'),
    rejection,
  );
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    env: { <<: *shared-env }'),
    rejection,
  );
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor('    env:\n      &shared <<: *shared-env'),
    rejection,
  );
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor('    env: { &shared <<: *shared-env }'),
    rejection,
  );

  const stepBody = syntheticFloorStep(['node --version']).replace(
    '        run: |',
    '        env:\n          <<: *shared-env\n        run: |',
  );
  assert.throws(() => assertNodeVersionLogBeforeFloor(stepBody), rejection);

  assert.doesNotThrow(() =>
    assertLintJobEnforcesNodeFloor(
      '    strategy:\n      matrix:\n        <<: *shared-matrix',
    ),
  );
});

test('YAML merge keys cannot inherit lint job or step controls', () => {
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    <<: *disabled'),
    /lint job must not use YAML merge keys that can inherit job controls/,
  );

  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        '    steps:\n      - name: Prepare Node\n        <<: *disabled',
      ),
    /lint job steps must not use YAML merge keys that can inherit step controls/,
  );

  const sequenceItemMerge = [
    '    steps:',
    '      - &base-step',
    '        name: Prepare Node',
    '        run: echo setup',
    '      - <<: *base-step',
    '        name: Assert Node.js floor',
  ].join('\n');
  assert.throws(
    () => assertLintJobEnforcesNodeFloor(sequenceItemMerge),
    /lint job steps must not use YAML merge keys that can inherit step controls/,
  );

  const decoratedSequenceItemMerge = [
    '    steps:',
    '      - &shared <<: *step-controls',
    '        name: Assert Node.js floor',
    '        run: node --version',
  ].join('\n');
  assert.throws(
    () => assertLintJobEnforcesNodeFloor(decoratedSequenceItemMerge),
    /lint job steps must not use YAML merge keys that can inherit step controls/,
  );

  const wholeStepAlias = [
    '    steps:',
    '      - &base-step',
    '        name: Skipped step',
    '        if: false',
    '        run: echo skipped',
    '      - *base-step',
    '      - name: Assert Node.js floor',
  ].join('\n');
  assert.throws(
    () => assertLintJobEnforcesNodeFloor(wholeStepAlias),
    /lint job steps must not use YAML merge keys that can inherit step controls/,
  );

  const commentAndScalar = [
    '    steps:',
    '      - name: Document merge syntax',
    '        run: |',
    '          echo "<<: *disabled"',
    '          echo "*whole-step"',
    '      # - *commented-step',
    ...syntheticFloorStep(['node --version']).split('\n'),
  ].join('\n');
  assert.equal(
    hasStepLevelYamlMergeKey(commentAndScalar),
    false,
    'comments and block scalars cannot trigger the step merge-key guard',
  );

  const reviewedFloorStep = syntheticFloorStep(['node --version']);
  const reviewedCheckout = [
    '    steps:',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    '      - name: Run documentation audit',
    '        run: node scripts/audit-docs.mjs --check',
    '      - name: Run bare-Node source contract audit',
    '        run: node scripts/lint-source-contracts.mjs',
    '      - name: Run source boundary lint',
    '        run: node scripts/lint-source-boundaries.mjs',
    '      - name: Run schema validation',
    '        run: node scripts/validate-schemas.mjs',
    ...reviewedFloorStep.split('\n'),
  ].join('\n');
  assert.doesNotThrow(() => assertLintJobEnforcesNodeFloor(reviewedCheckout));
  const reviewedCheckoutWithInputs = reviewedCheckout.replace(
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n',
    [
      '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      '        with:',
      '          fetch-depth: 0',
      '          persist-credentials: false',
      '',
    ].join('\n'),
  );
  assert.doesNotThrow(() =>
    assertLintJobEnforcesNodeFloor(reviewedCheckoutWithInputs),
  );
  const reviewedCheckoutWithBeforeUses = reviewedCheckout.replace(
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n',
    [
      '      - with:',
      '          fetch-depth: 0',
      '          persist-credentials: false',
      '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      '',
    ].join('\n'),
  );
  assert.doesNotThrow(() =>
    assertLintJobEnforcesNodeFloor(reviewedCheckoutWithBeforeUses),
  );
  const flipped = (absolutePath: string): Buffer => {
    const bytes = readFileSync(absolutePath);
    if (absolutePath.endsWith(`${sep}scripts${sep}audit-docs.mjs`)) {
      const copy = Buffer.from(bytes);
      copy[copy.length - 1] ^= 0x01;
      return copy;
    }
    return bytes;
  };
  assert.equal(
    unpinnedPreFloorCommand(reviewedCheckout, REPO_ROOT, flipped),
    'node scripts/audit-docs.mjs --check',
    'a one-byte change to a pre-floor script must leave the reviewed closure',
  );

  const floorStep = syntheticFloorStep(['node --version']).replace(
    '        run: |',
    '        <<: *disabled\n        run: |',
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(floorStep),
    /Assert Node\.js floor step must not use YAML merge keys that can inherit step controls/,
  );
});

test('unreviewed actions and run steps before the Node floor assertion are rejected', () => {
  const actionSteps = [
    { lines: ['      - uses: actions/example@deadbeef'], type: 'action' },
    {
      lines: [
        '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        '        with:',
        '          repository: attacker/repo',
        '          ref: deadbeef',
      ],
      type: 'action',
    },
    {
      lines: [
        '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        '        with: { repository: attacker/repo }',
      ],
      type: 'action',
    },
    {
      lines: [
        '      - with:',
        '          ref: deadbeef',
        '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      ],
      type: 'action',
    },
    {
      lines: [
        '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        "        'with':",
        '          fetch-depth: 0',
      ],
      type: 'action',
    },
    { lines: ['      -   uses: actions/example@deadbeef'], type: 'action' },
    { lines: ['      - "uses": actions/example@deadbeef'], type: 'action' },
    { lines: ['      - { uses: actions/example@deadbeef }'], type: 'action' },
    {
      lines: ['      - &action uses: actions/example@deadbeef'],
      type: 'action',
    },
    {
      lines: [
        '      - name: &action+key uses',
        '        run: node scripts/audit-docs.mjs --check',
        '      - name: Install through an alias key',
        '        *action+key: actions/example@deadbeef',
      ],
      type: 'action',
      rejection: /lint step control keys must not be escaped/,
    },
    { lines: ['      - run: node ./unreviewed-script.mjs'], type: 'run' },
    {
      lines: ['      - run: |', '          echo unreviewed command'],
      type: 'run',
    },
    {
      lines: [
        '      - run: node scripts/audit-docs.mjs --check',
        '          ; echo /tmp/fake-bin >> "$GITHUB_PATH"',
      ],
      type: 'run',
    },
    {
      lines: [
        '      - name: Run documentation audit',
        '        run: node scripts/audit-docs.mjs --check',
        '        shell: bash -c "{0}; echo /tmp/fake-bin >> $GITHUB_PATH"',
      ],
      type: 'run',
    },
    {
      lines: ['      -', '         uses: actions/example@deadbeef'],
      type: 'action',
    },
  ];

  for (const actionStep of actionSteps) {
    const jobBody = [
      '    steps:',
      ...actionStep.lines,
      ...syntheticFloorStep(['node --version']).split('\n'),
    ].join('\n');
    const rejection =
      'rejection' in actionStep && actionStep.rejection instanceof RegExp
        ? actionStep.rejection
        : /actions and run steps before the Node floor check must use reviewed entries/;
    assert.throws(
      () => assertLintJobEnforcesNodeFloor(jobBody),
      rejection,
      `accepted unreviewed ${actionStep.type} steps: ${actionStep.lines.join(' | ')}`,
    );
  }
});

test('later lint steps may set their own environment and shell', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    steps:',
    ...syntheticFloorStep(['node --version']).split('\n'),
    '      - name: Later protocol test',
    '        shell: pwsh',
    '        env:',
    '          PATH: /tmp/fake-bin',
    '        run: echo /tmp/fake-bin >> "$GITHUB_PATH"',
    '      - name: Later environment setup',
    '        run: echo NODE_OPTIONS=--require=./later.cjs >> "$GITHUB_ENV"',
  ].join('\n');
  const jobBody = extractJobBody(workflow, 'lint');

  assert.doesNotThrow(() => assertLintJobEnforcesNodeFloor(jobBody));
  assert.doesNotThrow(() => assertLintJobUsesDefaultShell(jobBody, workflow));
  assert.doesNotThrow(() =>
    assertNodeVersionLogBeforeFloor(
      extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
    ),
  );
});

test('escaped or tagged YAML env keys cannot hide Node execution overrides', () => {
  const rejection =
    /must not use escaped, tagged, anchored, or aliased YAML env keys/;
  for (const environment of [
    '    env:\n      "\\u004eODE_OPTIONS": --require=./exit.cjs',
    '    env: { "\\u004eODE_OPTIONS": --require=./exit.cjs }',
    '    env:\n      !!str NODE_OPTIONS: --require=./exit.cjs',
    '    env:\n      ? "\\u004eODE_OPTIONS"\n      : --require=./exit.cjs',
    '    env:\n      &node NODE_OPTIONS: --require=./exit.cjs',
    '    env: { &node NODE_OPTIONS: --require=./exit.cjs }',
    '    env:\n      *node: --require=./exit.cjs',
    '    env: { *node: --require=./exit.cjs }',
  ]) {
    assert.throws(() => assertLintJobEnforcesNodeFloor(environment), rejection);
  }

  assert.throws(
    () =>
      assertLintJobUsesDefaultShell(
        '',
        'env: { "\\u004eODE_OPTIONS": --require=./exit.cjs }',
      ),
    rejection,
  );

  const stepEnvironment = syntheticFloorStep(['node --version']).replace(
    '        run: |',
    '        env:\n          "\\u004eODE_OPTIONS": --require=./exit.cjs\n        run: |',
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepEnvironment),
    rejection,
  );
});

test('escaped YAML control keys cannot skip or hide the floor guard', () => {
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    "i\\u0066": false'),
    /lint job control keys must not be escaped/,
  );
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    &skip if: false'),
    /lint job control keys must not be escaped/,
  );
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    *skip if: false'),
    /lint job control keys must not be escaped/,
  );
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    !!str if: false'),
    /lint job control keys must not be escaped/,
  );
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        '    steps:\n      - name: Assert Node.js floor\n        "i\\u0066": false',
      ),
    /lint step control keys must not be escaped/,
  );
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        '    steps:\n      - name: Assert Node.js floor\n        &skip if: false',
      ),
    /lint step control keys must not be escaped/,
  );
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        '    steps:\n      - name: Assert Node.js floor\n        *skip if: false',
      ),
    /lint step control keys must not be escaped/,
  );

  const escapedShell = syntheticFloorStep(['node --version']).replace(
    '        run: |',
    '        "sh\\u0065ll": bash\n        run: |',
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(escapedShell),
    /step control keys must not be escaped/,
  );

  assert.throws(
    () =>
      assertLintJobUsesDefaultShell(
        '',
        '"e\\u006ev":\n  NODE_OPTIONS: --require=./exit.cjs',
      ),
    /workflow root keys must not be escaped/,
  );
});

test('lint job cannot move the Node floor check into a container', () => {
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        '    container:\n      image: node:26\n      env:\n        NODE_OPTIONS: --require=./exit.cjs',
      ),
    /lint job must not use a container/,
  );
});

test('a workflow env anchor keeps its mapping body in the preload scan', () => {
  for (const variable of ['NODE_OPTIONS', 'BASH_ENV']) {
    assert.throws(
      () =>
        assertLintJobUsesDefaultShell(
          '',
          `env: &lint-env\n  ${variable}: --require=./exit.cjs`,
        ),
      /workflow environment must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV/,
    );
  }
});

test('multiline root environment flow mappings remain in the override scan', () => {
  for (const [variable, value] of [
    ['NODE_OPTIONS', "'--require=./exit.cjs'"],
    ['PATH', '/tmp/fake-bin'],
  ]) {
    const workflow = [
      'env: {',
      `  ${variable}: ${value}`,
      '}',
      'jobs:',
      '  lint-windows:',
      '    env:',
      '      NODE_OPTIONS: --require=./windows-only.cjs',
    ].join('\n');
    assert.throws(
      () => assertLintJobUsesDefaultShell('', workflow),
      /workflow environment must not configure or reference NODE_OPTIONS, BASH_ENV, SHELLOPTS, BASH_FUNC_node%%, PATH, GITHUB_PATH, or GITHUB_ENV/,
    );
  }
});

test('unresolved environment aliases are rejected at workflow, job, and step scopes', () => {
  const workflow = [
    'jobs:',
    '  windows:',
    '    env: &windows-env',
    '      BASH_ENV: ./exit.sh',
    '  lint:',
    '    env: *windows-env',
  ].join('\n');
  assert.throws(
    () => assertLintJobEnforcesNodeFloor(extractJobBody(workflow, 'lint')),
    /must not use an unresolved env alias/,
  );
  assert.throws(
    () => assertLintJobUsesDefaultShell('', 'env: *shared-env'),
    /workflow environment must not use an unresolved env alias/,
  );

  const stepBody = syntheticFloorStep(['node --version']).replace(
    '        run: |',
    '        env: *shared-env\n        run: |',
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor step must not use an unresolved env alias/,
  );
});

test('comments and an independent workflow job cannot trigger the lint preload guard', () => {
  const workflow = [
    '# NODE_OPTIONS: this comment does not configure the lint job.',
    'jobs:',
    '  lint:',
    '    # NODE_OPTIONS: this comment does not configure the lint job.',
    '    steps:',
    '      - name: Other step',
    '        run: echo ok',
    '  lint-windows:',
    '    env:',
    '      NODE_OPTIONS: --require=./windows-only.cjs',
    '      BASH_ENV: ./windows-only.sh',
    '      PATH: /windows-only/bin',
    '    steps:',
    '      - run: echo /windows-only/bin >> "$GITHUB_PATH"',
  ].join('\n');
  const lintJob = extractJobBody(workflow, 'lint');

  assert.doesNotThrow(() => assertLintJobEnforcesNodeFloor(lintJob));
  assert.doesNotThrow(() => assertLintJobUsesDefaultShell(lintJob, workflow));
});

test('a comment after an escaped newline cannot satisfy the Node log guard', () => {
  const stepBody = syntheticFloorStep(['node --version\\', '# ignored?']);

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /must execute node --version as the first shell command/,
  );
});

test('an unterminated shell quote cannot satisfy the Node floor guard', () => {
  const stepBody = syntheticFloorStep(['node --version']).replace(
    /\n {10}'$/,
    '',
  );

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /shell script must not leave a quote open/,
  );
});

test('redirected or conditional Node commands cannot satisfy the Node log guard', () => {
  for (const shellLines of [
    ['node --version >node-version.txt'],
    ['false && node --version'],
    ['if false', 'then', 'node --version', 'fi'],
    ['output=$(node --version)'],
  ]) {
    assert.throws(
      () => assertNodeVersionLogBeforeFloor(syntheticFloorStep(shellLines)),
      /must execute node --version as the first shell command/,
      `accepted shell lines: ${shellLines.join('\\n')}`,
    );
  }
});

test('a shell comment after a command operator cannot satisfy the Node log guard', () => {
  const stepBody = syntheticFloorStep([':;# node --version']);

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor must execute node --version/,
  );
});

test('an earlier shell exit cannot bypass either required Node command', () => {
  const stepBody = syntheticFloorStep(['exit 0', 'node --version']);

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /must execute node --version as the first shell command/,
  );
});

test('a constant result cannot replace the Node engines floor comparison', () => {
  const stepBody = syntheticFloorStep(
    ['node --version'],
    [
      'const versionParts = process.versions.node.split(".");',
      'const [major, minor, patch] = versionParts.map(Number);',
      'const ok = true;',
      'if (!ok) { process.exit(1); }',
    ],
  );

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /must retain the Node engines\.node floor assertion and its failing path/,
  );
});

test('commented or unreachable JavaScript cannot satisfy the Node floor guard', () => {
  for (const assertionLines of [
    ['/*', ...SYNTHETIC_FLOOR_ASSERTION, '*/'],
    ['process.exit(0);', ...SYNTHETIC_FLOOR_ASSERTION],
  ]) {
    assert.throws(
      () =>
        assertNodeVersionLogBeforeFloor(
          syntheticFloorStep(['node --version'], assertionLines),
        ),
      /must retain the Node engines\.node floor assertion and its failing path/,
    );
  }
});
