// Install and uninstall suite for issue #4243, covering
// src/scripts/user-global-install.mts and its receipt in
// src/scripts/user-global-receipt.mts.
//
// Every test runs against a sandbox HOME passed through `env` and `homedir`,
// so no test writes to the real home directory. Tests that use real symbolic
// links skip on Windows, where the no-follow opens are unavailable and the
// installer refuses before any write.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { PAYLOAD_PLACEHOLDER_FIELDS } from '../src/scripts/payload-placeholders.mts';
import {
  installPayload,
  planInstall,
  planUninstall,
  type UserGlobalOptions,
  uninstallPayload,
} from '../src/scripts/user-global-install.mts';
import type { FsOps } from '../src/scripts/user-global-paths.mts';

const REPO = join(import.meta.dirname, '..');
const PACKAGE_VERSION: string = JSON.parse(
  nodeFs.readFileSync(join(REPO, 'package.json'), 'utf8'),
).version;
/** A version the package never ships, so an upgrade always targets a new directory. */
const UPGRADE_VERSION = '99.0.0';
const NO_LINKS =
  process.platform === 'win32'
    ? 'symbolic links need the no-follow opens, which Windows lacks'
    : false;
const ENTRY_RELATIVE = '.github/instructions/idd-overview-core.instructions.md';
const SKILL_RELATIVE = 'issue-authoring/SKILL.md';

/**
 * Every test here installs or uninstalls. The installer refuses on Windows
 * before any write, because the no-follow opens it needs are unavailable, so
 * each test skips there with this reason. A test that passes its own `skip`
 * option keeps it.
 */
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

function makeSandbox(prefix: string): string {
  const dir = nodeFs.mkdtempSync(join(nodeFs.realpathSync(tmpdir()), prefix));
  sandboxes.push(dir);
  return dir;
}

/** A sandbox HOME with the directories a real user already has. */
function makeHome(): string {
  const home = makeSandbox('user-global-install-');
  for (const dir of ['.local/share', '.claude', '.agents']) {
    nodeFs.mkdirSync(join(home, dir), { recursive: true });
  }
  return home;
}

function optionsFor(
  home: string,
  extra: Partial<UserGlobalOptions> = {},
): UserGlobalOptions {
  return { env: { HOME: home }, homedir: home, ...extra };
}

const dataRootOf = (home: string): string =>
  join(home, '.local', 'share', 'idd-skill');
const currentOf = (home: string): string => join(dataRootOf(home), 'current');
const versionDirOf = (home: string, version = PACKAGE_VERSION): string =>
  join(dataRootOf(home), version);
const skillFileOf = (home: string, root: '.claude' | '.agents'): string =>
  join(home, root, 'skills', SKILL_RELATIVE);
const receiptOf = (home: string): string =>
  join(dataRootOf(home), 'receipt.json');

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every path under `root` with its type and content hash, for no-write checks. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of nodeFs.readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = nodeFs.lstatSync(path);
      const rel = path.slice(root.length);
      if (stat.isSymbolicLink()) {
        out.push(`${rel} -> ${nodeFs.readlinkSync(path)}`);
      } else if (stat.isDirectory()) {
        out.push(`${rel}/`);
        visit(path);
      } else {
        out.push(`${rel} ${sha256(nodeFs.readFileSync(path))}`);
      }
    }
  };
  if (nodeFs.existsSync(root)) visit(root);
  return out;
}

function readReceiptEntries(home: string): { path: string; kind: string }[] {
  const parsed = JSON.parse(nodeFs.readFileSync(receiptOf(home), 'utf8'));
  return parsed.entries;
}

/** A source tree copy, so a test can change a skill file or the version. */
function copySourceTree(): string {
  const dir = makeSandbox('user-global-source-');
  for (const part of ['audit', 'idd-template', 'skills']) {
    nodeFs.cpSync(join(REPO, part), join(dir, part), { recursive: true });
  }
  return dir;
}

const WRITE_FLAGS =
  nodeFs.constants.O_WRONLY |
  nodeFs.constants.O_RDWR |
  nodeFs.constants.O_CREAT |
  nodeFs.constants.O_TRUNC;
const WRITE_OPS = new Set([
  'mkdirSync',
  'renameSync',
  'unlinkSync',
  'rmdirSync',
  'symlinkSync',
  'writeSync',
  'fchmodSync',
]);

type Hook = (op: string, args: unknown[]) => void;

/** An fs object that reports each call to `hook` before running it. */
function hookedFs(hook: Hook): FsOps {
  const real = nodeFs as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const wrapped: Record<string, unknown> = { ...nodeFs };
  for (const op of ['openSync', ...WRITE_OPS]) {
    wrapped[op] = (...args: unknown[]) => {
      hook(op, args);
      return real[op](...args);
    };
  }
  return wrapped as unknown as FsOps;
}

function isWriteCall(op: string, args: unknown[]): boolean {
  if (op === 'openSync') {
    return typeof args[1] === 'number' && (args[1] & WRITE_FLAGS) !== 0;
  }
  return WRITE_OPS.has(op);
}

test('a fresh install lays down the payload, skills, and receipt, and uninstall removes them', () => {
  const home = makeHome();
  const options = optionsFor(home);
  const result = installPayload(options);
  const vdir = versionDirOf(home);

  assert.equal(result.priorCurrentTarget, null);
  assert.equal(nodeFs.readlinkSync(currentOf(home)), vdir);
  assert.equal(
    nodeFs.readFileSync(join(vdir, ENTRY_RELATIVE), 'utf8'),
    nodeFs.readFileSync(join(REPO, 'idd-template', ENTRY_RELATIVE), 'utf8'),
  );
  assert.equal(
    nodeFs.readFileSync(join(vdir, 'user-global/entry.md'), 'utf8'),
    nodeFs.readFileSync(
      join(REPO, 'idd-template/user-global/entry.md'),
      'utf8',
    ),
  );
  for (const root of ['.claude', '.agents'] as const) {
    assert.equal(
      nodeFs.readFileSync(skillFileOf(home, root), 'utf8'),
      nodeFs.readFileSync(join(REPO, 'skills', SKILL_RELATIVE), 'utf8'),
    );
  }
  const entries = readReceiptEntries(home);
  assert.ok(
    entries.some(
      (entry) => entry.kind === 'link' && entry.path === currentOf(home),
    ),
    'the receipt lists the current link',
  );

  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.equal(nodeFs.existsSync(join(home, '.agents', 'skills')), false);
  assert.deepEqual(nodeFs.readdirSync(join(home, '.claude')), []);
});

test('a second install of the same version writes no file', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const before = snapshot(home);

  let writes = 0;
  const result = installPayload(
    optionsFor(home, {
      fs: hookedFs((op, args) => {
        if (isWriteCall(op, args)) writes += 1;
      }),
    }),
  );

  assert.equal(writes, 0);
  assert.deepEqual(snapshot(home), before);
  assert.ok(result.lines.every((line) => line.startsWith('keep ')));
});

test('plan functions write nothing and create no directory', () => {
  const home = makeHome();
  const options = optionsFor(home);
  const beforeInstall = snapshot(home);

  const installPlan = planInstall(options);
  assert.ok(installPlan.lines.length > 0);
  assert.deepEqual(snapshot(home), beforeInstall);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);

  installPayload(options);
  const beforeUninstall = snapshot(home);
  const uninstallPlan = planUninstall(options);
  assert.ok(uninstallPlan.lines.length > 0);
  assert.deepEqual(snapshot(home), beforeUninstall);
});

test('an edited payload file makes uninstall refuse before any removal', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.appendFileSync(join(versionDirOf(home), ENTRY_RELATIVE), 'edit\n');
  const before = snapshot(home);

  assert.throws(() => uninstallPayload(options), /edited after install/);
  assert.deepEqual(snapshot(home), before);
});

test('a file added beside managed files survives, and its directory with it', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const extra = join(versionDirOf(home), '.github/instructions/notes.md');
  nodeFs.writeFileSync(extra, 'mine\n');

  const result = uninstallPayload(options);

  assert.equal(nodeFs.readFileSync(extra, 'utf8'), 'mine\n');
  assert.equal(
    nodeFs.existsSync(join(versionDirOf(home), ENTRY_RELATIVE)),
    false,
  );
  assert.ok(
    result.lines.some(
      (line) =>
        line.includes('.github/instructions') && line.includes('not empty'),
    ),
  );
  assert.ok(nodeFs.existsSync(receiptOf(home)));
});

test('an edited skill file makes uninstall refuse, and nothing is removed', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.appendFileSync(skillFileOf(home, '.agents'), 'edit\n');
  const before = snapshot(home);

  assert.throws(() => uninstallPayload(options), /edited after install/);
  assert.deepEqual(snapshot(home), before);
});

test('an unlisted file with the same bytes is left in place and not recorded', () => {
  const home = makeHome();
  const options = optionsFor(home);
  const dest = skillFileOf(home, '.claude');
  nodeFs.mkdirSync(dirname(dest), { recursive: true });
  nodeFs.copyFileSync(join(REPO, 'skills', SKILL_RELATIVE), dest);

  installPayload(options);
  assert.ok(
    readReceiptEntries(home).every((entry) => entry.path !== dest),
    'the receipt does not list the identical file',
  );
  uninstallPayload(options);
  assert.equal(
    nodeFs.readFileSync(dest, 'utf8'),
    nodeFs.readFileSync(join(REPO, 'skills', SKILL_RELATIVE), 'utf8'),
  );
});

test('an unlisted file with different bytes makes install refuse and write nothing', () => {
  const home = makeHome();
  const dest = skillFileOf(home, '.claude');
  nodeFs.mkdirSync(dirname(dest), { recursive: true });
  nodeFs.writeFileSync(dest, 'different\n');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(optionsFor(home)),
    new RegExp(
      `${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*different bytes`,
    ),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a pre-existing current link is repointed, its prior target printed, and left in place on uninstall', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const options = optionsFor(home);
  const oldVersion = join(dataRootOf(home), '0.0.1');
  nodeFs.mkdirSync(oldVersion, { recursive: true });
  nodeFs.symlinkSync(oldVersion, currentOf(home));

  const result = installPayload(options);
  assert.equal(result.priorCurrentTarget, oldVersion);
  assert.equal(nodeFs.readlinkSync(currentOf(home)), versionDirOf(home));
  assert.ok(
    readReceiptEntries(home).every((entry) => entry.path !== currentOf(home)),
    'an unlisted current link is not recorded',
  );

  const uninstall = uninstallPayload(options);
  assert.ok(nodeFs.lstatSync(currentOf(home)).isSymbolicLink());
  assert.ok(uninstall.lines.some((line) => line.includes('dangles')));
});

test('a listed link whose target changed makes uninstall refuse', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.unlinkSync(currentOf(home));
  nodeFs.symlinkSync(join(dataRootOf(home), '0.0.1'), currentOf(home));
  const before = snapshot(home);

  assert.throws(() => uninstallPayload(options), /points somewhere else now/);
  assert.deepEqual(snapshot(home), before);
});

test('a listed file replaced by a symbolic link makes uninstall refuse, and the sentinel is unchanged', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const sentinel = join(makeSandbox('user-global-sentinel-'), 'sentinel.txt');
  nodeFs.writeFileSync(sentinel, 'sentinel\n');
  const options = optionsFor(home);
  installPayload(options);
  const managed = skillFileOf(home, '.claude');
  nodeFs.unlinkSync(managed);
  nodeFs.symlinkSync(sentinel, managed);
  const before = snapshot(home);

  assert.throws(() => uninstallPayload(options), /now a symlink/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'sentinel\n');
});

test('an unlisted symbolic link inside a listed directory is not followed', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const sentinelDir = makeSandbox('user-global-sentinel-');
  const sentinel = join(sentinelDir, 'keep.txt');
  nodeFs.writeFileSync(sentinel, 'keep\n');
  const options = optionsFor(home);
  installPayload(options);
  const trap = join(versionDirOf(home), '.github/instructions/trap');
  nodeFs.symlinkSync(sentinelDir, trap);

  const result = uninstallPayload(options);

  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'keep\n');
  assert.ok(nodeFs.lstatSync(trap).isSymbolicLink());
  assert.ok(result.lines.some((line) => line.includes('not empty')));
});

test('a listed path whose parent is a symbolic link out of the root is refused by install', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const outside = makeSandbox('user-global-outside-');
  nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
  nodeFs.symlinkSync(outside, versionDirOf(home));
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /symbolic link/);
  assert.deepEqual(snapshot(home), before);
  assert.deepEqual(nodeFs.readdirSync(outside), []);
});

test('a hand-written receipt that lists a path under no root is refused by install and uninstall', () => {
  const home = makeHome();
  const outsideFile = join(home, 'outside', 'x.txt');
  nodeFs.mkdirSync(dirname(outsideFile), { recursive: true });
  nodeFs.writeFileSync(outsideFile, 'x\n');
  nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
  nodeFs.writeFileSync(
    receiptOf(home),
    JSON.stringify({
      version: 1,
      entries: [{ kind: 'file', path: outsideFile, sha256: sha256('x\n') }],
    }),
  );
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /under no root/);
  assert.throws(() => uninstallPayload(optionsFor(home)), /under no root/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(nodeFs.readFileSync(outsideFile, 'utf8'), 'x\n');
});

test('a data root that is itself a symbolic link is refused by install and uninstall', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const target = join(home, 'elsewhere');
  nodeFs.mkdirSync(target, { recursive: true });
  nodeFs.symlinkSync(target, dataRootOf(home));
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /symbolic link/);
  assert.throws(() => uninstallPayload(optionsFor(home)), /symbolic link/);
  assert.deepEqual(snapshot(home), before);
});

test('a symbolic link at a skill root makes install refuse before any write', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const outside = makeSandbox('user-global-outside-');
  nodeFs.symlinkSync(outside, join(home, '.claude', 'skills'));

  assert.throws(() => installPayload(optionsFor(home)), /symbolic link/);
  assert.deepEqual(nodeFs.readdirSync(outside), []);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('uninstall reports a path under an absent ancestor as already absent and creates nothing', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.rmSync(join(home, '.claude', 'skills'), {
    recursive: true,
    force: true,
  });

  const result = uninstallPayload(options);

  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.ok(result.lines.some((line) => line.startsWith('absent ')));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('uninstall with XDG_DATA_HOME under missing ancestors and no receipt exits quietly', () => {
  const home = makeHome();
  const xdg = join(home, 'missing', 'xdg');
  const result = uninstallPayload({
    env: { HOME: home, XDG_DATA_HOME: xdg },
    homedir: home,
  });

  assert.equal(result.lines.length, 1);
  assert.equal(nodeFs.existsSync(join(home, 'missing')), false);
});

test('a corrupt receipt makes install and uninstall refuse, and nothing changes', () => {
  for (const body of [
    '{ not json',
    JSON.stringify({
      version: 1,
      entries: [{ kind: 'socket', path: join(dataRootOf(makeHome()), 'x') }],
    }),
  ]) {
    const home = makeHome();
    nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
    nodeFs.writeFileSync(receiptOf(home), body);
    const before = snapshot(home);

    assert.throws(() => installPayload(optionsFor(home)), /corrupt/);
    assert.throws(() => uninstallPayload(optionsFor(home)), /corrupt/);
    assert.deepEqual(snapshot(home), before);
  }
});

test('a stale receipt temporary file makes install and uninstall refuse', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  nodeFs.writeFileSync(join(dataRootOf(home), 'receipt.json.tmp-4242'), '{}');
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /crashed run/);
  assert.throws(() => uninstallPayload(optionsFor(home)), /crashed run/);
  assert.deepEqual(snapshot(home), before);
});

test('a failed receipt rewrite does not roll back and names the created paths it does not list', () => {
  const home = makeHome();
  let receiptRenames = 0;
  const fs = hookedFs((op, args) => {
    if (op !== 'renameSync') return;
    const target = String(args[1]);
    if (target.endsWith('receipt.json')) {
      receiptRenames += 1;
      if (receiptRenames === 3) throw new Error('injected rename failure');
    }
  });

  assert.throws(
    () => installPayload(optionsFor(home, { fs })),
    /receipt rewrite failed.*not listed in the receipt/s,
  );
  const entries = readReceiptEntries(home);
  assert.equal(entries.length, 2, 'the receipt keeps its last valid state');
  assert.equal(
    nodeFs.readdirSync(dataRootOf(home)).some((name) => name.includes('.tmp-')),
    false,
    'the failed rename removes its temporary file',
  );
});

test('a failure in a later write rolls back this run and leaves nothing behind', () => {
  const home = makeHome();
  const fs = hookedFs((op, args) => {
    if (
      op === 'openSync' &&
      isWriteCall(op, args) &&
      String(args[0]).includes('/.agents/skills/')
    ) {
      throw new Error('injected write failure');
    }
  });

  assert.throws(() => installPayload(optionsFor(home, { fs })), /rolled back/);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.equal(nodeFs.existsSync(join(home, '.agents', 'skills')), false);
});

test('a failed upgrade restores the replaced skill file and the prior current target', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const v1Claude = nodeFs.readFileSync(skillFileOf(home, '.claude'));
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  const fs = hookedFs((op, args) => {
    if (
      op === 'renameSync' &&
      String(args[1]).endsWith(`/.agents/skills/${SKILL_RELATIVE}`)
    ) {
      throw new Error('injected replacement failure');
    }
  });

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION, fs }),
      ),
    /rolled back/,
  );
  assert.deepEqual(nodeFs.readFileSync(skillFileOf(home, '.claude')), v1Claude);
  assert.equal(nodeFs.readlinkSync(currentOf(home)), versionDirOf(home));
  assert.equal(nodeFs.existsSync(versionDirOf(home, UPGRADE_VERSION)), false);
});

test('an upgrade replaces the listed skill file, re-records its hash, and repoints current', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  const newBytes = nodeFs.readFileSync(join(source, 'skills', SKILL_RELATIVE));

  const result = installPayload(
    optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
  );

  assert.equal(
    nodeFs.readFileSync(skillFileOf(home, '.claude')).toString('utf8'),
    newBytes.toString('utf8'),
  );
  assert.equal(result.priorCurrentTarget, versionDirOf(home));
  assert.equal(
    nodeFs.readlinkSync(currentOf(home)),
    versionDirOf(home, UPGRADE_VERSION),
  );
  const claude = readReceiptEntries(home).find(
    (entry) => entry.path === skillFileOf(home, '.claude'),
  ) as { sha256?: string } | undefined;
  assert.equal(claude?.sha256, sha256(newBytes));
  assert.ok(
    readReceiptEntries(home).some((entry) => entry.path === versionDirOf(home)),
    'the older version stays listed',
  );

  uninstallPayload(
    optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
  );
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('an upgrade refuses a listed skill file that was edited after the last install', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  nodeFs.appendFileSync(skillFileOf(home, '.claude'), 'edit\n');
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
      ),
    /edited after install/,
  );
});

test('an interrupted uninstall leaves the entries not yet removed, and a second run removes them', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const total = readReceiptEntries(home).length;
  let unlinks = 0;
  const fs = hookedFs((op, args) => {
    if (op !== 'unlinkSync') return;
    if (String(args[0]).endsWith('receipt.json')) return;
    unlinks += 1;
    if (unlinks === 3) throw new Error('injected unlink failure');
  });

  assert.throws(
    () => uninstallPayload(optionsFor(home, { fs })),
    /uninstall stopped at/,
  );
  assert.equal(readReceiptEntries(home).length, total - 2);

  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('a missing parent of a skill root makes install refuse before any write', () => {
  const home = makeHome();
  nodeFs.rmSync(join(home, '.agents'), { recursive: true, force: true });
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /does not exist/);
  assert.deepEqual(snapshot(home), before);
});

test('a version outside the required pattern makes install refuse before any write', () => {
  const home = makeHome();
  const before = snapshot(home);

  assert.throws(
    () => installPayload(optionsFor(home, { version: '../escape' })),
    /does not match the required pattern/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a directory that existed before install is not listed and survives uninstall', () => {
  const home = makeHome();
  nodeFs.mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const options = optionsFor(home);
  installPayload(options);

  assert.ok(
    readReceiptEntries(home).every(
      (entry) => entry.path !== join(home, '.claude', 'skills'),
    ),
  );
  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), true);
});

test('a retry after the receipt write failed on a repoint is refused and named', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  let repointed = false;
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op !== 'renameSync') return;
    const target = String(args[1]);
    if (target === currentOf(home)) repointed = true;
    if (repointed && !failed && target.endsWith('receipt.json')) {
      failed = true;
      throw new Error('injected receipt failure');
    }
  });

  assert.throws(
    () => installPayload(optionsFor(home, { fs, version: UPGRADE_VERSION })),
    (error: Error) =>
      /receipt rewrite failed/.test(error.message) &&
      error.message.includes(currentOf(home)),
  );
  assert.equal(
    nodeFs.readlinkSync(currentOf(home)),
    versionDirOf(home, UPGRADE_VERSION),
  );
  const before = snapshot(home);

  assert.throws(
    () => installPayload(optionsFor(home, { version: UPGRADE_VERSION })),
    /receipt records/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a receipt-owned link rewritten with a relative target is repointed to the recorded path', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.unlinkSync(currentOf(home));
  nodeFs.symlinkSync(PACKAGE_VERSION, currentOf(home));

  installPayload(options);
  assert.equal(nodeFs.readlinkSync(currentOf(home)), versionDirOf(home));

  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('a retry after the receipt write failed on a replaced skill file refuses it as user-edited', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  const claudeSkill = skillFileOf(home, '.claude');
  let replaced = false;
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op !== 'renameSync') return;
    const target = String(args[1]);
    if (target === claudeSkill) replaced = true;
    if (replaced && !failed && target.endsWith('receipt.json')) {
      failed = true;
      throw new Error('injected receipt failure');
    }
  });

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION, fs }),
      ),
    /receipt rewrite failed/,
  );
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
      ),
    /edited after install/,
  );
  assert.deepEqual(snapshot(home), before);
});
test('a listed link retargeted by someone else makes install refuse', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const other = join(dataRootOf(home), '0.0.3');
  nodeFs.mkdirSync(other);
  nodeFs.unlinkSync(currentOf(home));
  nodeFs.symlinkSync(other, currentOf(home));
  const before = snapshot(home);

  assert.throws(
    () => installPayload(options),
    /retargeted or its receipt write lagged/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a manifest path that escapes the payload directory makes install refuse before any write', () => {
  const home = makeHome();
  const source = copySourceTree();
  const manifestPath = join(source, 'audit', 'sync-manifest.json');
  const manifest = JSON.parse(nodeFs.readFileSync(manifestPath, 'utf8'));
  const block = manifest.generatedBlocks.find(
    (candidate: { id: string }) => candidate.id === 'idd-template-core-files',
  );
  block.paths.push('idd-template/../escape.md');
  nodeFs.writeFileSync(manifestPath, JSON.stringify(manifest));
  nodeFs.writeFileSync(join(source, 'escape.md'), 'outside\n');
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: PACKAGE_VERSION }),
      ),
    /escapes the payload directory/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a stale temporary file beside a listed skill file makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  nodeFs.writeFileSync(`${skillFileOf(home, '.claude')}.tmp-7`, 'stale\n');
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
      ),
    /crashed run/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a listed skill file with a second hard link makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  nodeFs.linkSync(skillFileOf(home, '.claude'), join(home, 'alias.md'));
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
      ),
    /more than one hard link/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a rollback keeps a listed path listed when this run recreated it and then failed', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const claude = skillFileOf(home, '.claude');
  nodeFs.rmSync(claude);
  nodeFs.rmSync(skillFileOf(home, '.agents'));
  const fs = hookedFs((op, args) => {
    if (
      op === 'openSync' &&
      isWriteCall(op, args) &&
      String(args[0]).includes('/.agents/skills/')
    ) {
      throw new Error('injected write failure');
    }
  });

  assert.throws(() => installPayload(optionsFor(home, { fs })), /rolled back/);
  assert.equal(nodeFs.existsSync(claude), false);
  assert.ok(
    readReceiptEntries(home).some((entry) => entry.path === claude),
    'the receipt still lists the path the rollback removed',
  );
});

test('every placeholder in the installed payload has a mapping', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const pattern = /\{\{([A-Z_]+)\}\}/g;
  const names = new Set<string>();
  const visit = (dir: string): void => {
    for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        for (const match of nodeFs
          .readFileSync(path, 'utf8')
          .matchAll(pattern)) {
          names.add(match[1]);
        }
      }
    }
  };
  visit(versionDirOf(home));
  for (const name of names) {
    assert.ok(
      Object.hasOwn(PAYLOAD_PLACEHOLDER_FIELDS, name),
      `placeholder ${name} has no mapping`,
    );
  }
});
