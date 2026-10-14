// cspell:ignore ctions
// Entry-file suite for issue #4244, covering
// src/scripts/user-global-entry-files.mts and its wiring into
// src/scripts/user-global-install.mts.
//
// Every test runs against a sandbox HOME passed through `env` and `homedir`,
// so no test writes to the real home directory. The installer refuses on
// Windows before any write, so each test skips there.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import {
  installPayload,
  planInstall,
  planUninstall,
  type UserGlobalOptions,
  uninstallPayload,
} from '../src/scripts/user-global-install.mts';
import type { FsOps } from '../src/scripts/user-global-paths.mts';

const REPO = join(import.meta.dirname, '..');
const ALL_HARNESSES = ['claude', 'codex', 'opencode'] as const;
const ENTRY_TEXT = nodeFs.readFileSync(
  join(REPO, 'idd-template', 'user-global', 'entry.md'),
  'utf8',
);
const BEGIN = '<!-- idd-skill:user-global:begin -->';
const END = '<!-- idd-skill:user-global:end -->';
const NO_INSTALL =
  process.platform === 'win32'
    ? 'the installer refuses on Windows before any write: no-follow opens are unavailable'
    : false;

const test = ((name: string, ...rest: unknown[]) => {
  const fn = rest[rest.length - 1] as () => void;
  const options =
    rest.length === 2 ? (rest[0] as { skip?: string | boolean }) : {};
  return nodeTest(name, { ...options, skip: NO_INSTALL || options.skip }, fn);
}) as unknown as typeof nodeTest;

const sandboxes: string[] = [];

after(() => {
  for (const dir of sandboxes) {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A sandbox HOME with the directories a real user already has. */
function freshHome(
  options: { codex?: boolean; config?: boolean } = {},
): string {
  const dir = nodeFs.mkdtempSync(
    join(nodeFs.realpathSync(tmpdir()), 'user-global-entry-'),
  );
  sandboxes.push(dir);
  for (const sub of ['.local/share', '.claude', '.agents']) {
    nodeFs.mkdirSync(join(dir, sub), { recursive: true });
  }
  if (options.config !== false) nodeFs.mkdirSync(join(dir, '.config'));
  if (options.codex) nodeFs.mkdirSync(join(dir, '.codex'));
  return dir;
}

function optionsFor(
  home: string,
  extra: Partial<UserGlobalOptions> = {},
): UserGlobalOptions {
  return {
    env: { HOME: home },
    homedir: home,
    harnesses: ALL_HARNESSES,
    ...extra,
  };
}

const dataRootOf = (home: string): string =>
  join(home, '.local', 'share', 'idd-skill');
const entryPathOf = (home: string): string =>
  join(dataRootOf(home), 'current', 'user-global', 'entry.md');
const filesOf = (home: string) => ({
  claude: join(home, '.claude', 'CLAUDE.md'),
  codex: join(home, '.codex', 'AGENTS.md'),
  opencode: join(home, '.config', 'opencode', 'opencode.json'),
});
const claudeSpan = (home: string): string =>
  `${BEGIN}\n@${entryPathOf(home)}\n${END}\n`;
const codexSpan = (): string => `${BEGIN}\n${ENTRY_TEXT}${END}\n`;
const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Read a file's bytes, or null when it is absent. */
function bytesOf(path: string): Buffer | null {
  try {
    return nodeFs.readFileSync(path);
  } catch {
    return null;
  }
}

function textOf(path: string): string {
  const bytes = bytesOf(path);
  assert.notEqual(bytes, null, `${path} should exist`);
  return (bytes as Buffer).toString('utf8');
}

interface ReceiptJson {
  version: number;
  entries: { kind: string; path: string; [key: string]: unknown }[];
}

function receiptOf(home: string): ReceiptJson | null {
  const bytes = bytesOf(join(dataRootOf(home), 'receipt.json'));
  return bytes === null
    ? null
    : (JSON.parse(bytes.toString('utf8')) as ReceiptJson);
}

function listedEntry(home: string, path: string) {
  return receiptOf(home)?.entries.find((entry) => entry.path === path);
}

function writeReceipt(home: string, receipt: ReceiptJson): void {
  nodeFs.writeFileSync(
    join(dataRootOf(home), 'receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

/**
 * An fs object that reports each call to `hook` before running it. The hook
 * may throw to inject a failure. Only the calls that change files are hooked.
 */
function hookedFs(hook: (op: string, args: unknown[]) => void): FsOps {
  const real = nodeFs as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const wrapped: Record<string, unknown> = { ...nodeFs };
  for (const op of ['renameSync', 'unlinkSync', 'rmdirSync', 'mkdirSync']) {
    wrapped[op] = (...args: unknown[]) => {
      hook(op, args);
      return real[op](...args);
    };
  }
  return wrapped as unknown as FsOps;
}

/**
 * An fs object whose renames fail on the nth call whose target ends with a
 * suffix. Each rule counts its own calls, so the forward write and a later
 * rollback can be told apart.
 */
function faultyRenames(faults: { suffix: string; nth: number }[]): FsOps {
  const seen = new Map<string, number>();
  return hookedFs((op, args) => {
    if (op !== 'renameSync') return;
    const dest = String(args[1]);
    for (const fault of faults) {
      if (!dest.endsWith(fault.suffix)) continue;
      const count = (seen.get(fault.suffix) ?? 0) + 1;
      seen.set(fault.suffix, count);
      if (count === fault.nth) throw new Error('injected rename failure');
    }
  });
}

/** Every path under `root`, with the SHA-256 of each regular file. */
function treeOf(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of nodeFs.readdirSync(dir)) {
      const path = join(dir, name);
      const stat = nodeFs.lstatSync(path);
      if (stat.isDirectory()) {
        result.set(path, 'directory');
        walk(path);
      } else if (stat.isFile()) {
        result.set(path, sha256(nodeFs.readFileSync(path)));
      } else {
        result.set(path, 'other');
      }
    }
  };
  if (nodeFs.existsSync(root)) walk(root);
  return result;
}

test('a fresh install writes the three entry files and records each as a file', () => {
  const home = freshHome();
  const files = filesOf(home);
  const entry = entryPathOf(home);
  const result = installPayload(optionsFor(home));

  assert.equal(textOf(files.claude), claudeSpan(home));
  assert.equal(textOf(files.codex), codexSpan());
  assert.equal(
    textOf(files.opencode),
    `{\n  "instructions": ${JSON.stringify([entry])}\n}\n`,
  );
  for (const path of Object.values(files)) {
    assert.equal(listedEntry(home, path)?.kind, 'file', path);
  }
  assert.equal(listedEntry(home, join(home, '.codex'))?.kind, 'directory');
  assert.ok(result.lines.includes(`create ${files.claude}`));
});

test('the Codex managed block is fewer than 2048 bytes', () => {
  const home = freshHome();
  installPayload(optionsFor(home));
  assert.ok(Buffer.byteLength(textOf(filesOf(home).codex)) < 2048);
});

test('a second install changes no byte in any entry file', () => {
  const home = freshHome();
  installPayload(optionsFor(home));
  const before = Object.values(filesOf(home)).map((path) => bytesOf(path));
  installPayload(optionsFor(home));
  const after2 = Object.values(filesOf(home)).map((path) => bytesOf(path));
  assert.deepEqual(after2, before);
});

test('uninstall after a fresh install removes the entry files and the directory install created', () => {
  const home = freshHome();
  installPayload(optionsFor(home));
  uninstallPayload(optionsFor(home));
  for (const path of Object.values(filesOf(home))) {
    assert.equal(bytesOf(path), null, `${path} should be gone`);
  }
  assert.equal(nodeFs.existsSync(join(home, '.codex')), false);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('user text without a trailing LF survives install and uninstall byte for byte', () => {
  const home = freshHome();
  const claude = filesOf(home).claude;
  nodeFs.writeFileSync(claude, 'user line');
  installPayload(optionsFor(home));
  assert.equal(textOf(claude), `user line\n${claudeSpan(home)}`);
  assert.equal(listedEntry(home, claude)?.kind, 'managed-block');
  uninstallPayload(optionsFor(home));
  assert.equal(textOf(claude), 'user line');
});

test('a zero-byte entry file gets the block with no separator, and uninstall leaves it empty', () => {
  const home = freshHome();
  const claude = filesOf(home).claude;
  nodeFs.writeFileSync(claude, '');
  installPayload(optionsFor(home));
  assert.equal(textOf(claude), claudeSpan(home));
  assert.equal(listedEntry(home, claude)?.separator, false);
  uninstallPayload(optionsFor(home));
  assert.equal(textOf(claude), '');
});

test('a block that is current and not recorded is left alone, and uninstall leaves it', () => {
  const home = freshHome();
  const claude = filesOf(home).claude;
  nodeFs.writeFileSync(claude, `user\n${claudeSpan(home)}`);
  installPayload(optionsFor(home));
  assert.equal(textOf(claude), `user\n${claudeSpan(home)}`);
  assert.equal(listedEntry(home, claude), undefined);
  uninstallPayload(optionsFor(home));
  assert.equal(textOf(claude), `user\n${claudeSpan(home)}`);
});

test('an unrecorded block whose bytes differ makes install refuse and write nothing', () => {
  const home = freshHome();
  const claude = filesOf(home).claude;
  nodeFs.writeFileSync(claude, `${BEGIN}\n@/elsewhere.md\n${END}\n`);
  assert.throws(
    () => installPayload(optionsFor(home)),
    /differs from the entry text/,
  );
  assert.equal(textOf(claude), `${BEGIN}\n@/elsewhere.md\n${END}\n`);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('a recorded block the user edited makes install and uninstall refuse, and nothing is removed', () => {
  const home = freshHome();
  const claude = filesOf(home).claude;
  installPayload(optionsFor(home));
  nodeFs.writeFileSync(claude, claudeSpan(home).replace('@', '@/edited-'));
  const edited = textOf(claude);
  assert.throws(() => installPayload(optionsFor(home)), /edited after install/);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /edited after install/,
  );
  assert.equal(textOf(claude), edited);
  assert.ok(nodeFs.existsSync(join(home, '.claude', 'skills')));
});

test('a recorded block that is now absent makes install refuse; uninstall drops the record', () => {
  const home = freshHome();
  const claude = filesOf(home).claude;
  nodeFs.writeFileSync(claude, 'user\n');
  installPayload(optionsFor(home));
  nodeFs.writeFileSync(claude, 'user only');
  assert.throws(
    () => installPayload(optionsFor(home)),
    /no longer holds the managed block/,
  );
  uninstallPayload(optionsFor(home));
  assert.equal(textOf(claude), 'user only');
  assert.equal(listedEntry(home, claude), undefined);
});

test('a recorded block whose text changed in a newer version is replaced and re-recorded', () => {
  const home = freshHome();
  const claude = filesOf(home).claude;
  nodeFs.writeFileSync(claude, 'user\n');
  installPayload(optionsFor(home));
  const oldSpan = `${BEGIN}\n@/old/entry.md\n${END}\n`;
  nodeFs.writeFileSync(claude, `user\n${oldSpan}`);
  const receipt = receiptOf(home) as ReceiptJson;
  const recorded = receipt.entries.find((entry) => entry.path === claude);
  assert.ok(recorded);
  recorded.sha256 = sha256(oldSpan);
  writeReceipt(home, receipt);

  installPayload(optionsFor(home));
  assert.equal(textOf(claude), `user\n${claudeSpan(home)}`);
  assert.equal(listedEntry(home, claude)?.sha256, sha256(claudeSpan(home)));
});

for (const [label, body] of [
  ['a begin without an end', `${BEGIN}\n@/x.md\n`],
  ['two begin lines', `${BEGIN}\n${BEGIN}\n${END}\n`],
  ['an end before the begin', `${END}\n${BEGIN}\n`],
  ['a CR byte', `user\r\n`],
  ['an unterminated end marker at EOF', `${BEGIN}\n@/x.md\n${END}`],
] as const) {
  test(`a Markdown entry file with ${label} makes install refuse`, () => {
    const home = freshHome();
    const claude = filesOf(home).claude;
    nodeFs.writeFileSync(claude, body);
    assert.throws(() => installPayload(optionsFor(home)));
    assert.equal(textOf(claude), body);
    assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  });
}

test('a symbolic-link entry file is refused, and its target is unchanged', {
  skip: NO_INSTALL,
}, () => {
  const home = freshHome();
  const outside = join(home, 'outside.md');
  nodeFs.writeFileSync(outside, 'outside\n');
  nodeFs.symlinkSync(outside, filesOf(home).claude);
  assert.throws(() => installPayload(optionsFor(home)), /symbolic link/);
  assert.equal(textOf(outside), 'outside\n');
});

test('a symbolic-link entry file inside the harness directory is refused too', {
  skip: NO_INSTALL,
}, () => {
  const home = freshHome();
  const inside = join(home, '.claude', 'real.md');
  nodeFs.writeFileSync(inside, 'inside\n');
  nodeFs.symlinkSync(inside, filesOf(home).claude);
  assert.throws(() => installPayload(optionsFor(home)), /symbolic link/);
  assert.equal(textOf(inside), 'inside\n');
});

test('a symbolic-link harness directory is refused and its target is unchanged', {
  skip: NO_INSTALL,
}, () => {
  const home = freshHome({ codex: false });
  const realDir = join(home, 'real-codex');
  nodeFs.mkdirSync(realDir);
  nodeFs.symlinkSync(realDir, join(home, '.codex'));
  assert.throws(() => installPayload(optionsFor(home)), /symbolic link/);
  assert.deepEqual(nodeFs.readdirSync(realDir), []);
});

test('an entry file with more than one hard link is refused', {
  skip: NO_INSTALL,
}, () => {
  const home = freshHome();
  const claude = filesOf(home).claude;
  nodeFs.writeFileSync(claude, 'user\n');
  nodeFs.linkSync(claude, join(home, 'second-name.md'));
  assert.throws(() => installPayload(optionsFor(home)), /hard link/);
  assert.equal(textOf(claude), 'user\n');
});

for (const [label, text] of [
  ['a comment', '// note\n{}\n'],
  ['a trailing comma', '{"model":"x",}\n'],
  ['a duplicate key', '{"model":"x","model":"y"}\n'],
  [
    'an escaped spelling of a duplicate key',
    '{"instructions":[],"instr\\u0075ctions":[]}\n',
  ],
  ['a nested duplicate key', '{"x":{"k":1,"k":2}}\n'],
  ['a non-object root', '[]\n'],
  ['instructions that is not an array', '{"instructions":"x"}\n'],
  ['the entry listed twice', 'ENTRY_TWICE'],
] as const) {
  test(`an opencode.json with ${label} makes install refuse and write nothing`, () => {
    const home = freshHome();
    const opencode = filesOf(home).opencode;
    nodeFs.mkdirSync(join(home, '.config', 'opencode'));
    const body =
      text === 'ENTRY_TWICE'
        ? `{"instructions":[${JSON.stringify(entryPathOf(home))},${JSON.stringify(entryPathOf(home))}]}\n`
        : text;
    nodeFs.writeFileSync(opencode, body);
    assert.throws(() => installPayload(optionsFor(home)));
    assert.equal(textOf(opencode), body);
    assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
    assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  });
}

for (const [label, fixture] of [
  ['an empty object', '{}'],
  ['an object with one member', '{"model":"x"}'],
  ['an object with an empty instructions array', '{"instructions":[]}'],
  ['a multi-line object', '{\n  "model": "x",\n  "theme": "dark"\n}\n'],
] as const) {
  test(`install and uninstall of ${label} in opencode.json restore its bytes`, () => {
    const home = freshHome();
    const opencode = filesOf(home).opencode;
    nodeFs.mkdirSync(join(home, '.config', 'opencode'));
    nodeFs.writeFileSync(opencode, fixture);
    installPayload(optionsFor(home));
    const installed = JSON.parse(textOf(opencode)) as {
      instructions: string[];
    };
    assert.deepEqual(installed.instructions, [entryPathOf(home)]);
    uninstallPayload(optionsFor(home));
    assert.equal(textOf(opencode), fixture);
  });
}

test('an opencode.json that already holds the entry once is left alone and not recorded', () => {
  const home = freshHome();
  const opencode = filesOf(home).opencode;
  nodeFs.mkdirSync(join(home, '.config', 'opencode'));
  const body = `{"instructions":[${JSON.stringify(entryPathOf(home))}]}\n`;
  nodeFs.writeFileSync(opencode, body);
  installPayload(optionsFor(home));
  assert.equal(textOf(opencode), body);
  assert.equal(listedEntry(home, opencode), undefined);
  uninstallPayload(optionsFor(home));
  assert.equal(textOf(opencode), body);
});

test('an opencode.json whose recorded instruction the user removed makes uninstall refuse', () => {
  const home = freshHome();
  const opencode = filesOf(home).opencode;
  nodeFs.mkdirSync(join(home, '.config', 'opencode'));
  nodeFs.writeFileSync(opencode, '{}');
  installPayload(optionsFor(home));
  nodeFs.writeFileSync(opencode, '{"instructions":[]}');
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /exactly once; refusing/,
  );
  assert.equal(textOf(opencode), '{"instructions":[]}');
});

test('relative CODEX_HOME and XDG_CONFIG_HOME fall back to the default roots', () => {
  const home = freshHome();
  installPayload(
    optionsFor(home, {
      env: {
        HOME: home,
        CODEX_HOME: 'relative/codex',
        XDG_CONFIG_HOME: 'relative-config',
      },
    }),
  );
  assert.equal(textOf(filesOf(home).codex), codexSpan());
  assert.equal(
    textOf(filesOf(home).opencode),
    `{\n  "instructions": ${JSON.stringify([entryPathOf(home)])}\n}\n`,
  );
});

test('an absolute CODEX_HOME names the Codex harness directory', () => {
  const home = freshHome({ codex: false });
  const codexHome = join(home, 'custom-codex');
  installPayload(
    optionsFor(home, { env: { HOME: home, CODEX_HOME: codexHome } }),
  );
  assert.equal(textOf(join(codexHome, 'AGENTS.md')), codexSpan());
  assert.equal(listedEntry(home, codexHome)?.kind, 'directory');
});

test('a missing harness directory is created as a leaf and removed when uninstall finds it empty', () => {
  const home = freshHome({ codex: false });
  installPayload(optionsFor(home));
  assert.equal(listedEntry(home, join(home, '.codex'))?.kind, 'directory');
  uninstallPayload(optionsFor(home));
  assert.equal(nodeFs.existsSync(join(home, '.codex')), false);
});

test('install writes only the entry files and the harness directory it records', () => {
  const home = freshHome({ codex: false });
  const before = treeOf(home);
  installPayload(optionsFor(home));
  const added = [...treeOf(home).keys()].filter(
    (path) =>
      !before.has(path) &&
      !path.startsWith(dataRootOf(home)) &&
      !path.includes('/skills'),
  );
  assert.deepEqual(
    added.sort(),
    [
      join(home, '.codex'),
      join(home, '.codex', 'AGENTS.md'),
      join(home, '.claude', 'CLAUDE.md'),
      join(home, '.config', 'opencode'),
      join(home, '.config', 'opencode', 'opencode.json'),
    ].sort(),
  );
});

test('a pre-existing empty harness directory is not recorded, and uninstall leaves it', () => {
  const home = freshHome({ codex: true });
  installPayload(optionsFor(home));
  assert.equal(listedEntry(home, join(home, '.codex')), undefined);
  uninstallPayload(optionsFor(home));
  assert.ok(nodeFs.statSync(join(home, '.codex')).isDirectory());
  assert.deepEqual(nodeFs.readdirSync(join(home, '.codex')), []);
});

test('a harness directory that is no longer empty is kept, with its user file', () => {
  const home = freshHome({ codex: false });
  installPayload(optionsFor(home));
  const notes = join(home, '.codex', 'notes.txt');
  nodeFs.writeFileSync(notes, 'mine\n');
  const lines = uninstallPayload(optionsFor(home)).lines;
  assert.equal(textOf(notes), 'mine\n');
  assert.ok(
    lines.some((line) => line.startsWith(`kept ${join(home, '.codex')}`)),
  );
  assert.equal(bytesOf(filesOf(home).codex), null);
});

test('a missing .config refuses the opencode harness, and install writes nothing', () => {
  const home = freshHome({ config: false });
  assert.throws(
    () => installPayload(optionsFor(home)),
    /creates a harness directory only as a leaf/,
  );
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
});

test('an entry file the user edited after install makes uninstall refuse before any removal', () => {
  const home = freshHome();
  installPayload(optionsFor(home));
  const codex = filesOf(home).codex;
  nodeFs.writeFileSync(codex, 'my own notes\n');
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /edited after install/,
  );
  assert.equal(textOf(codex), 'my own notes\n');
  assert.ok(nodeFs.existsSync(join(home, '.claude', 'skills')));
});

test('uninstall refuses a hand-written receipt entry outside its harness root', () => {
  const home = freshHome();
  installPayload(optionsFor(home));
  const outside = join(home, 'elsewhere', 'CLAUDE.md');
  nodeFs.mkdirSync(join(home, 'elsewhere'));
  nodeFs.writeFileSync(outside, `${claudeSpan(home)}`);
  const receipt = receiptOf(home) as ReceiptJson;
  receipt.entries.push({
    kind: 'managed-block',
    path: outside,
    sha256: sha256(claudeSpan(home)),
    separator: false,
  });
  writeReceipt(home, receipt);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /not a path the installer creates/,
  );
  assert.equal(textOf(outside), claudeSpan(home));
});

test('planInstall and planUninstall name each file and write nothing', () => {
  const home = freshHome();
  const plan = planInstall(optionsFor(home));
  assert.ok(plan.lines.includes(`create ${filesOf(home).claude}`));
  assert.ok(plan.lines.includes(`create ${filesOf(home).opencode}`));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  installPayload(optionsFor(home));
  const removal = planUninstall(optionsFor(home));
  assert.ok(removal.lines.includes(`remove ${filesOf(home).claude}`));
});

test('a failure in the third entry-file write restores the first two and drops this run records', () => {
  const home = freshHome({ codex: true });
  const files = filesOf(home);
  nodeFs.mkdirSync(join(home, '.config', 'opencode'));
  installPayload(optionsFor(home, { harnesses: [] }));
  const earlier = (receiptOf(home) as ReceiptJson).entries
    .map((e) => e.path)
    .sort();
  nodeFs.writeFileSync(files.claude, 'claude user\n');
  nodeFs.writeFileSync(files.codex, 'codex user\n');
  nodeFs.writeFileSync(files.opencode, '{}\n');

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, {
          fs: faultyRenames([{ suffix: 'opencode.json', nth: 1 }]),
        }),
      ),
    /rolled back/,
  );
  assert.equal(textOf(files.claude), 'claude user\n');
  assert.equal(textOf(files.codex), 'codex user\n');
  assert.equal(textOf(files.opencode), '{}\n');
  const after2 = (receiptOf(home) as ReceiptJson).entries
    .map((e) => e.path)
    .sort();
  assert.deepEqual(after2, earlier);
});

test('a failed restore names the path, fails the run, and keeps the record', () => {
  const home = freshHome({ codex: true });
  const files = filesOf(home);
  nodeFs.mkdirSync(join(home, '.config', 'opencode'));
  installPayload(optionsFor(home, { harnesses: [] }));
  nodeFs.writeFileSync(files.claude, 'claude user\n');
  nodeFs.writeFileSync(files.codex, 'codex user\n');
  nodeFs.writeFileSync(files.opencode, '{}\n');

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, {
          fs: faultyRenames([
            { suffix: 'opencode.json', nth: 1 },
            { suffix: 'AGENTS.md', nth: 2 },
          ]),
        }),
      ),
    /AGENTS\.md/,
  );
  assert.equal(listedEntry(home, files.codex)?.kind, 'managed-block');
});

test('uninstall refuses a stale entry temporary before it removes anything', () => {
  const home = freshHome();
  const claude = filesOf(home).claude;
  nodeFs.writeFileSync(claude, 'user\n');
  installPayload(optionsFor(home));
  nodeFs.writeFileSync(`${claude}.tmp-999`, 'stale');
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /crashed run left it behind/,
  );
  assert.equal(textOf(claude), `user\n${claudeSpan(home)}`);
  assert.ok(nodeFs.existsSync(join(home, '.claude', 'skills')));
});

test('uninstall refuses when a link replaces the config directory above the entry file', {
  skip: NO_INSTALL,
}, () => {
  const home = freshHome();
  installPayload(optionsFor(home));
  const original = textOf(filesOf(home).opencode);
  const moved = join(home, 'moved-config');
  nodeFs.renameSync(join(home, '.config'), moved);
  nodeFs.symlinkSync(moved, join(home, '.config'));
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /symbolic link on the path/,
  );
  assert.equal(
    nodeFs.readFileSync(join(moved, 'opencode', 'opencode.json'), 'utf8'),
    original,
  );
});

test('a receipt that names an instruction other than the entry text is corrupt', () => {
  const home = freshHome();
  nodeFs.mkdirSync(join(home, '.config', 'opencode'));
  const opencode = filesOf(home).opencode;
  nodeFs.writeFileSync(opencode, '{"instructions":["/home/me/notes.md"]}\n');
  installPayload(optionsFor(home));
  const receipt = receiptOf(home) as ReceiptJson;
  const recorded = receipt.entries.find((entry) => entry.path === opencode);
  assert.ok(recorded);
  recorded.value = '/home/me/notes.md';
  writeReceipt(home, receipt);
  const before = textOf(opencode);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /does not name the installer's entry text/,
  );
  assert.equal(textOf(opencode), before);
});

test('a receipt that names the entry text of another data root is corrupt', () => {
  const home = freshHome();
  nodeFs.mkdirSync(join(home, '.config', 'opencode'));
  const opencode = filesOf(home).opencode;
  nodeFs.writeFileSync(opencode, '{}\n');
  installPayload(optionsFor(home));
  const receipt = receiptOf(home) as ReceiptJson;
  const recorded = receipt.entries.find((entry) => entry.path === opencode);
  assert.ok(recorded);
  recorded.value = '/other/root/current/user-global/entry.md';
  writeReceipt(home, receipt);
  const before = textOf(opencode);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /does not name the installer's entry text/,
  );
  assert.equal(textOf(opencode), before);
});

test('a failed receipt write after an entry rewrite restores the entry file', () => {
  const home = freshHome();
  nodeFs.mkdirSync(join(home, '.config', 'opencode'));
  const opencode = filesOf(home).opencode;
  nodeFs.writeFileSync(opencode, '{}\n');
  installPayload(optionsFor(home));
  const installed = textOf(opencode);
  assert.throws(
    () =>
      uninstallPayload(
        optionsFor(home, {
          fs: faultyRenames([{ suffix: 'receipt.json', nth: 1 }]),
        }),
      ),
    /receipt\.json/,
  );
  assert.equal(textOf(opencode), installed);
  assert.equal(listedEntry(home, opencode)?.kind, 'json-instruction');
});

test('uninstall refuses a link above an absent recorded entry file', {
  skip: NO_INSTALL,
}, () => {
  const home = freshHome();
  nodeFs.mkdirSync(join(home, '.config', 'opencode'));
  const opencode = filesOf(home).opencode;
  nodeFs.writeFileSync(opencode, '{}\n');
  installPayload(optionsFor(home));
  const moved = join(home, 'moved-config');
  nodeFs.renameSync(join(home, '.config'), moved);
  const elsewhere = join(home, 'elsewhere');
  nodeFs.mkdirSync(elsewhere);
  nodeFs.symlinkSync(elsewhere, join(home, '.config'));
  const kept = nodeFs.readFileSync(
    join(moved, 'opencode', 'opencode.json'),
    'utf8',
  );
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /symbolic link on the path/,
  );
  assert.equal(listedEntry(home, opencode)?.kind, 'json-instruction');
  assert.equal(
    nodeFs.readFileSync(join(moved, 'opencode', 'opencode.json'), 'utf8'),
    kept,
  );
});
