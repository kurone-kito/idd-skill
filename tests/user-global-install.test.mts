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

  assert.throws(
    () => installPayload(optionsFor(home)),
    /under no root|not a path the installer creates/,
  );
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /under no root|not a path the installer creates/,
  );
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

test('a symbolic-link data root is refused as a link, not as a stale temporary file', () => {
  const home = makeHome();
  const target = join(home, 'elsewhere');
  nodeFs.mkdirSync(target, { recursive: true });
  nodeFs.writeFileSync(join(target, 'receipt.json.tmp-3'), '{}');
  nodeFs.symlinkSync(target, dataRootOf(home));

  assert.throws(
    () => installPayload(optionsFor(home)),
    (error: Error) =>
      /symbolic link/.test(error.message) && !/crashed run/.test(error.message),
  );
});

test('a receipt that lists a user symbolic link as a link entry is corrupt for install and uninstall', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const userLink = join(home, '.claude', 'skills', 'user-link');
  nodeFs.mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  nodeFs.symlinkSync('/elsewhere/user-owned', userLink);
  nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
  nodeFs.writeFileSync(
    receiptOf(home),
    JSON.stringify({
      version: 1,
      entries: [
        { kind: 'link', path: userLink, target: '/elsewhere/user-owned' },
      ],
    }),
  );
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /corrupt/);
  assert.throws(() => uninstallPayload(optionsFor(home)), /corrupt/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(nodeFs.readlinkSync(userLink), '/elsewhere/user-owned');
});

test('a receipt that lists a path the installer never creates is refused by install and uninstall', () => {
  const home = makeHome();
  const userFile = join(home, '.claude', 'notes.md');
  nodeFs.writeFileSync(userFile, 'mine\n');
  nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
  nodeFs.writeFileSync(
    receiptOf(home),
    JSON.stringify({
      version: 1,
      entries: [
        { kind: 'directory', path: join(home, '.claude') },
        { kind: 'file', path: userFile, sha256: sha256('mine\n') },
      ],
    }),
  );
  const before = snapshot(home);

  assert.throws(
    () => installPayload(optionsFor(home)),
    /not a path the installer creates/,
  );
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /not a path the installer creates/,
  );
  assert.deepEqual(snapshot(home), before);
  assert.equal(nodeFs.readFileSync(userFile, 'utf8'), 'mine\n');
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

// ---------------------------------------------------------------------------
// An upgrade prunes the skill files the new package no longer ships (#4302)
// ---------------------------------------------------------------------------

const DROPPED_RELATIVE = 'issue-authoring/references/draft-patterns.md';
const SPEC_DROPPED_RELATIVE = 'idd-spec-audit/references/report-template.md';

const droppedOf = (home: string, root: '.claude' | '.agents'): string =>
  join(home, root, 'skills', DROPPED_RELATIVE);

/** A source tree copy that no longer ships the named files under `skills/`. */
function copySourceWithout(...relatives: string[]): string {
  const dir = copySourceTree();
  for (const relative of relatives) {
    nodeFs.rmSync(join(dir, 'skills', relative));
  }
  return dir;
}

/** Options that install `source` as the upgrade version. */
function upgradeOptions(
  home: string,
  source: string,
  extra: Partial<UserGlobalOptions> = {},
): UserGlobalOptions {
  return optionsFor(home, {
    sourceRoot: source,
    version: UPGRADE_VERSION,
    ...extra,
  });
}

type ReceiptRow = { path: string; kind: string; sha256?: string };

const receiptRows = (home: string): ReceiptRow[] =>
  readReceiptEntries(home) as ReceiptRow[];

const isListed = (home: string, path: string): boolean =>
  receiptRows(home).some((entry) => entry.path === path);

/** Every listed file exists and still has the hash the receipt records. */
function assertListedFilesMatchDisk(home: string): void {
  for (const entry of receiptRows(home)) {
    if (entry.kind !== 'file') continue;
    assert.equal(
      sha256(nodeFs.readFileSync(entry.path)),
      entry.sha256,
      `${entry.path} matches the receipt`,
    );
  }
}

/** The path a refusal is expected to name, as a literal pattern. */
const literal = (value: string): RegExp =>
  new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/**
 * An fs whose bigint `lstatSync` reports one fixed device and inode for each
 * named path. A filesystem that folds case or Unicode form reports one file for
 * two spellings; real inodes cannot show that here, so the fs reports it.
 */
function fsReportingIdentity(paths: string[], dev: bigint, ino: bigint): FsOps {
  const real = nodeFs as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  return {
    ...nodeFs,
    lstatSync: (path: string, options?: { bigint?: boolean }) => {
      const stat = real.lstatSync(path, options) as object;
      return paths.includes(path) && options?.bigint
        ? Object.create(stat, { dev: { value: dev }, ino: { value: ino } })
        : stat;
    },
  } as unknown as FsOps;
}

test('an upgrade that drops an unchanged skill file removes it and its receipt entry', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = [droppedOf(home, '.claude'), droppedOf(home, '.agents')];
  for (const path of dropped) {
    assert.ok(nodeFs.existsSync(path), 'the file is installed first');
    assert.ok(isListed(home, path), 'the receipt lists it first');
  }

  const result = installPayload(upgradeOptions(home, source));

  for (const path of dropped) {
    assert.equal(nodeFs.existsSync(path), false);
    assert.equal(isListed(home, path), false);
    assert.ok(result.lines.includes(`remove ${path}`));
  }
  const kept = join(home, '.claude', 'skills', 'issue-authoring', 'references');
  assert.ok(
    nodeFs.existsSync(join(kept, 'contract.md')),
    'a shipped file stays',
  );
  assert.ok(isListed(home, join(kept, 'contract.md')));
  assert.ok(isListed(home, kept), 'the directory stays listed');
  const olderFile = join(versionDirOf(home), ENTRY_RELATIVE);
  assert.ok(nodeFs.existsSync(olderFile), 'the older version stays on disk');
  assert.ok(isListed(home, olderFile), 'the older version stays listed');
  assertListedFilesMatchDisk(home);

  // The prune is finished, so a repeat install writes nothing at all.
  let writes = 0;
  installPayload(
    upgradeOptions(home, source, {
      fs: hookedFs((op, args) => {
        if (isWriteCall(op, args)) writes += 1;
      }),
    }),
  );
  assert.equal(writes, 0);

  uninstallPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.equal(nodeFs.existsSync(join(home, '.agents', 'skills')), false);
});

test('a dropped skill file that was edited after install is refused, named, and left in place', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const edited = droppedOf(home, '.claude');
  nodeFs.appendFileSync(edited, 'my own notes\n');
  const before = snapshot(home);

  for (const run of [
    () => installPayload(upgradeOptions(home, source)),
    () => planInstall(upgradeOptions(home, source)),
  ]) {
    assert.throws(
      run,
      (error: Error) =>
        literal(edited).test(error.message) &&
        /edited after install/.test(error.message) &&
        /nothing was written/.test(error.message),
    );
  }
  assert.deepEqual(snapshot(home), before);
  assert.ok(nodeFs.readFileSync(edited, 'utf8').endsWith('my own notes\n'));
  assert.ok(
    nodeFs.existsSync(droppedOf(home, '.agents')),
    'the unedited copy is not removed either',
  );
  assert.ok(isListed(home, edited));
});

test('a dropped skill file that is now a symbolic link is refused and nothing is followed', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const sentinel = join(makeSandbox('user-global-sentinel-'), 'sentinel.txt');
  nodeFs.writeFileSync(sentinel, 'sentinel\n');
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  nodeFs.unlinkSync(dropped);
  nodeFs.symlinkSync(sentinel, dropped);
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /is now a symlink/.test(error.message) &&
      /move or delete it, then install again/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
  assert.ok(nodeFs.lstatSync(dropped).isSymbolicLink());
  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'sentinel\n');
});

test('a dropped skill file that is now a directory is refused and left in place', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  nodeFs.unlinkSync(dropped);
  nodeFs.mkdirSync(dropped);
  nodeFs.writeFileSync(join(dropped, 'mine.txt'), 'mine\n');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /is now a directory/.test(error.message) &&
      /move or delete it, then install again/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a dropped skill file with a second hard link is refused and left in place', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  nodeFs.linkSync(dropped, join(home, 'alias.md'));
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /more than one hard link/.test(error.message) &&
      /move or delete it, then install again/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a dropped skill file that is already absent is unlisted and not recreated', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(SPEC_DROPPED_RELATIVE);
  const claudeCopy = join(home, '.claude', 'skills', SPEC_DROPPED_RELATIVE);
  const agentsCopy = join(home, '.agents', 'skills', SPEC_DROPPED_RELATIVE);
  // One copy loses its whole directory, the other only the file.
  nodeFs.rmSync(dirname(claudeCopy), { recursive: true });
  nodeFs.rmSync(agentsCopy);

  const result = installPayload(upgradeOptions(home, source));

  for (const path of [claudeCopy, agentsCopy]) {
    assert.equal(nodeFs.existsSync(path), false, `${path} is not recreated`);
    assert.equal(isListed(home, path), false);
    assert.ok(
      result.lines.includes(
        `remove ${path} (already absent; dropping its receipt entry)`,
      ),
    );
  }

  uninstallPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('a stale temporary file beside an already-absent dropped skill file makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const absent = droppedOf(home, '.claude');
  nodeFs.rmSync(absent);
  nodeFs.writeFileSync(`${absent}.tmp-7`, 'stale\n');
  const before = snapshot(home);

  for (const run of [
    () => installPayload(upgradeOptions(home, source)),
    () => planInstall(upgradeOptions(home, source)),
  ]) {
    assert.throws(
      run,
      (error: Error) =>
        literal(`${absent}.tmp-7`).test(error.message) &&
        /crashed run/.test(error.message) &&
        /nothing was written/.test(error.message),
    );
  }
  assert.deepEqual(snapshot(home), before);
  assert.ok(isListed(home, absent), 'the entry stays listed');
});

test('a stale temporary file beside a dropped skill file that is the same file as a shipped one still refuses', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const shipped = join(dirname(dropped), 'contract.md');
  nodeFs.writeFileSync(`${dropped}.tmp-7`, 'stale\n');
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        upgradeOptions(home, source, {
          fs: fsReportingIdentity([dropped, shipped], 7n, 7n),
        }),
      ),
    /crashed run/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('an edited dropped file of the second shipped skill is refused too', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(SPEC_DROPPED_RELATIVE);
  const edited = join(home, '.agents', 'skills', SPEC_DROPPED_RELATIVE);
  nodeFs.appendFileSync(edited, 'my own notes\n');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      literal(edited).test(error.message) &&
      /edited after install/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a hard link made to a dropped skill file after the plan stops the prune and removes nothing', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const alias = join(home, 'alias.md');
  let fired = false;
  const fs = hookedFs((op, args) => {
    // The repoint comes after planning and before the prune.
    if (op === 'renameSync' && String(args[1]) === currentOf(home)) {
      fired = true;
      nodeFs.linkSync(dropped, alias);
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /more than one hard link/.test(error.message) &&
      /payload is installed/.test(error.message),
  );
  assert.ok(fired);
  assert.ok(nodeFs.existsSync(dropped));
  assert.ok(nodeFs.existsSync(alias));
  assert.ok(isListed(home, dropped));
});

test('a file the user added beside a dropped skill file survives the prune', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const mine = join(dirname(droppedOf(home, '.claude')), 'mine.md');
  nodeFs.writeFileSync(mine, 'mine\n');

  installPayload(upgradeOptions(home, source));

  assert.equal(nodeFs.existsSync(droppedOf(home, '.claude')), false);
  assert.equal(nodeFs.readFileSync(mine, 'utf8'), 'mine\n');
  assert.equal(isListed(home, mine), false);
});

test('a receipt entry that is not a path the prune may touch is refused and the file is untouched', () => {
  const user = 'mine\n';
  const cases = [
    {
      name: 'a path that climbs out of the skill tree',
      path: (home: string) =>
        `${home}/.claude/skills/issue-authoring/../../notes.md`,
      file: (home: string) => join(home, '.claude', 'notes.md'),
      message: /not a path the installer creates|under no root/,
    },
    {
      name: 'a non-normalized path that stays inside another skill',
      path: (home: string) =>
        `${home}/.claude/skills/issue-authoring/../idd-spec-audit/SKILL.md`,
      file: (home: string) =>
        join(home, '.claude', 'skills', 'idd-spec-audit', 'SKILL.md'),
      message: /not in normalized form/,
    },
    {
      name: 'a skill the package does not ship',
      path: (home: string) =>
        join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md'),
      file: (home: string) =>
        join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md'),
      message: /not a path the installer creates/,
    },
  ];
  for (const { name, path, file, message } of cases) {
    const home = makeHome();
    nodeFs.mkdirSync(dirname(file(home)), { recursive: true });
    nodeFs.writeFileSync(file(home), user);
    nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
    nodeFs.writeFileSync(
      receiptOf(home),
      JSON.stringify({
        version: 1,
        entries: [{ kind: 'file', path: path(home), sha256: sha256(user) }],
      }),
    );
    const before = snapshot(home);

    assert.throws(() => installPayload(optionsFor(home)), message, name);
    assert.deepEqual(snapshot(home), before, name);
    assert.equal(nodeFs.readFileSync(file(home), 'utf8'), user, name);
  }
});

test('a dropped skill file under a directory that was swapped for a link is refused and nothing is followed', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const references = dirname(droppedOf(home, '.claude'));
  const outside = join(makeSandbox('user-global-outside-'), 'references');
  nodeFs.cpSync(references, outside, { recursive: true });
  nodeFs.rmSync(references, { recursive: true });
  nodeFs.symlinkSync(outside, references);
  const outsideBefore = snapshot(outside);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    /symbolic link/,
  );
  assert.deepEqual(snapshot(outside), outsideBefore);
  assert.ok(nodeFs.existsSync(join(outside, 'draft-patterns.md')));
});

test('a dropped skill file that is the same file as a shipped one is kept, not removed', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const shipped = join(dirname(dropped), 'contract.md');

  const result = installPayload(
    upgradeOptions(home, source, {
      fs: fsReportingIdentity([dropped, shipped], 7n, 7n),
    }),
  );

  assert.ok(
    result.lines.includes(`keep ${dropped} (the same file as ${shipped})`),
  );
  assert.ok(nodeFs.existsSync(dropped), 'the aliased file is not removed');
  assert.ok(isListed(home, dropped), 'its entry stays listed');
  assert.equal(
    nodeFs.existsSync(droppedOf(home, '.agents')),
    false,
    'the other copy is a different file and is removed',
  );
  assertListedFilesMatchDisk(home);

  uninstallPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
});

test('a filesystem that reports no inode number does not turn every dropped skill file into an alias', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const shipped = join(dirname(dropped), 'contract.md');

  installPayload(
    upgradeOptions(home, source, {
      fs: fsReportingIdentity([dropped, shipped], 0n, 0n),
    }),
  );

  assert.equal(nodeFs.existsSync(dropped), false);
  assert.equal(isListed(home, dropped), false);
});

test('two skill files with the same inode number on different devices are not the same file', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const shipped = join(dirname(dropped), 'contract.md');
  const real = nodeFs as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const fs = {
    ...nodeFs,
    lstatSync: (path: string, options?: { bigint?: boolean }) => {
      const stat = real.lstatSync(path, options) as object;
      if (!options?.bigint) return stat;
      if (path === dropped) {
        return Object.create(stat, { dev: { value: 7n }, ino: { value: 5n } });
      }
      if (path === shipped) {
        return Object.create(stat, { dev: { value: 8n }, ino: { value: 5n } });
      }
      return stat;
    },
  } as unknown as FsOps;

  installPayload(upgradeOptions(home, source, { fs }));

  assert.equal(nodeFs.existsSync(dropped), false);
  assert.equal(isListed(home, dropped), false);
});

test('a byte-identical file that was there before install is never listed, so the prune never touches it', () => {
  const home = makeHome();
  for (const root of ['.claude', '.agents'] as const) {
    const path = droppedOf(home, root);
    nodeFs.mkdirSync(dirname(path), { recursive: true });
    nodeFs.copyFileSync(join(REPO, 'skills', DROPPED_RELATIVE), path);
  }
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);

  const result = installPayload(upgradeOptions(home, source));

  for (const root of ['.claude', '.agents'] as const) {
    const path = droppedOf(home, root);
    assert.ok(nodeFs.existsSync(path), `${path} is left in place`);
    assert.equal(isListed(home, path), false);
    assert.equal(result.lines.includes(`remove ${path}`), false);
  }
});

test('a stale temporary file beside a dropped skill file makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  nodeFs.writeFileSync(`${droppedOf(home, '.claude')}.tmp-7`, 'stale\n');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      /crashed run/.test(error.message) &&
      /refusing to remove/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a dropped skill file edited after the plan stops the prune, keeps the edit, and a retry refuses it', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const racing = droppedOf(home, '.claude');
  let opens = 0;
  const fs = hookedFs((op, args) => {
    if (op !== 'openSync' || String(args[0]) !== racing) return;
    opens += 1;
    // The first open is the plan's hash read; the second is the removal's.
    if (opens === 2) nodeFs.appendFileSync(racing, 'edited late\n');
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(racing).test(error.message) &&
      literal(droppedOf(home, '.agents')).test(error.message) &&
      /payload is installed/.test(error.message) &&
      /install again/.test(error.message),
  );
  assert.equal(opens, 2, 'the removal opened the file once after the plan');
  assert.ok(nodeFs.readFileSync(racing, 'utf8').endsWith('edited late\n'));
  assert.equal(
    nodeFs.readlinkSync(currentOf(home)),
    versionDirOf(home, UPGRADE_VERSION),
    'the new version stays installed',
  );
  assert.ok(isListed(home, racing), 'the edited file stays listed');
  assert.ok(nodeFs.existsSync(droppedOf(home, '.agents')));

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    /edited after install/,
  );
});

test('a failed removal leaves the new version installed and a consistent receipt, and a retry finishes the prune', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const first = droppedOf(home, '.claude');
  const second = droppedOf(home, '.agents');
  const fs = hookedFs((op, args) => {
    if (op === 'unlinkSync' && String(args[0]) === second) {
      throw new Error('injected unlink failure');
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      /payload is installed/.test(error.message) &&
      /injected unlink failure/.test(error.message) &&
      literal(second).test(error.message) &&
      literal(`current used to point at ${versionDirOf(home)}`).test(
        error.message,
      ) &&
      /install again/.test(error.message),
  );
  assert.equal(nodeFs.existsSync(first), false);
  assert.equal(isListed(home, first), false);
  assert.ok(nodeFs.existsSync(second));
  assert.ok(isListed(home, second));
  assert.equal(
    nodeFs.readlinkSync(currentOf(home)),
    versionDirOf(home, UPGRADE_VERSION),
  );
  assertListedFilesMatchDisk(home);

  installPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(second), false);
  assert.equal(isListed(home, second), false);
  assertListedFilesMatchDisk(home);
});

test('a failed receipt rewrite after a removal names the path, and a retry drops it as absent', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const first = droppedOf(home, '.claude');
  const second = droppedOf(home, '.agents');
  let removed = false;
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op === 'unlinkSync' && String(args[0]) === first) removed = true;
    if (
      op === 'renameSync' &&
      removed &&
      !failed &&
      String(args[1]).endsWith('receipt.json')
    ) {
      failed = true;
      throw new Error('injected receipt failure');
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      /receipt rewrite failed/.test(error.message) &&
      literal(first).test(error.message) &&
      /gone from disk but still listed/.test(error.message),
  );
  assert.equal(nodeFs.existsSync(first), false);
  assert.ok(isListed(home, first), 'the receipt still lists the removed file');
  assert.ok(nodeFs.existsSync(second));
  assert.equal(
    nodeFs.readdirSync(dataRootOf(home)).some((name) => name.includes('.tmp-')),
    false,
    'the failed rename removes its temporary file',
  );
  assert.ok(
    planUninstall(upgradeOptions(home, source)).lines.includes(
      `absent ${first}`,
    ),
    'uninstall reports the removed file as absent',
  );

  const retry = installPayload(upgradeOptions(home, source));
  assert.ok(
    retry.lines.includes(
      `remove ${first} (already absent; dropping its receipt entry)`,
    ),
  );
  assert.ok(retry.lines.includes(`remove ${second}`));
  assert.equal(isListed(home, first), false);
  assert.equal(isListed(home, second), false);
  assertListedFilesMatchDisk(home);
});

test('a failed receipt rewrite after the last removal says that nothing else is left', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const last = droppedOf(home, '.agents');
  nodeFs.rmSync(droppedOf(home, '.claude'));
  let removed = false;
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op === 'unlinkSync' && String(args[0]) === last) removed = true;
    if (
      op === 'renameSync' &&
      removed &&
      !failed &&
      String(args[1]).endsWith('receipt.json')
    ) {
      failed = true;
      throw new Error('injected receipt failure');
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(last).test(error.message) &&
      /not yet handled: none/.test(error.message),
  );
  assert.ok(failed);
});

test('an absent dropped skill file whose name the new version uses for a directory stays listed as that directory', () => {
  const home = makeHome();
  const oldSource = copySourceTree();
  nodeFs.writeFileSync(
    join(oldSource, 'skills', 'issue-authoring', 'notes'),
    'old\n',
  );
  installPayload(
    optionsFor(home, { sourceRoot: oldSource, version: '98.0.0' }),
  );
  const names = ['.claude', '.agents'].map((root) =>
    join(home, root, 'skills', 'issue-authoring', 'notes'),
  );
  for (const name of names) {
    assert.ok(isListed(home, name));
    nodeFs.rmSync(name);
  }
  const source = copySourceTree();
  nodeFs.mkdirSync(join(source, 'skills', 'issue-authoring', 'notes'));
  nodeFs.writeFileSync(
    join(source, 'skills', 'issue-authoring', 'notes', 'x.md'),
    'new\n',
  );

  installPayload(upgradeOptions(home, source));

  for (const name of names) {
    assert.ok(nodeFs.statSync(name).isDirectory());
    assert.equal(
      receiptRows(home).find((entry) => entry.path === name)?.kind,
      'directory',
      `${name} is listed as the directory it now is`,
    );
  }
  assertListedFilesMatchDisk(home);
  uninstallPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.equal(nodeFs.existsSync(join(home, '.agents', 'skills')), false);
});

test('an upgrade that replaces one skill file, drops another, and keeps an entry file lists all of it', () => {
  const home = makeHome();
  const harnesses = ['claude'] as const;
  installPayload(optionsFor(home, { harnesses }));
  const source = copySourceWithout(DROPPED_RELATIVE);
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  const newBytes = nodeFs.readFileSync(join(source, 'skills', SKILL_RELATIVE));
  const entryFile = join(home, '.claude', 'CLAUDE.md');
  const entryBefore = nodeFs.readFileSync(entryFile);

  installPayload(upgradeOptions(home, source, { harnesses }));

  const replaced = skillFileOf(home, '.claude');
  assert.deepEqual(nodeFs.readFileSync(replaced), newBytes);
  assert.equal(
    receiptRows(home).find((entry) => entry.path === replaced)?.sha256,
    sha256(newBytes),
  );
  assert.equal(nodeFs.existsSync(droppedOf(home, '.claude')), false);
  assert.equal(isListed(home, droppedOf(home, '.claude')), false);
  assert.deepEqual(nodeFs.readFileSync(entryFile), entryBefore);
  assert.ok(isListed(home, entryFile));
  assertListedFilesMatchDisk(home);

  uninstallPayload(upgradeOptions(home, source, { harnesses }));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.deepEqual(nodeFs.readdirSync(join(home, '.claude')), []);
});

test('a dropped skill file that vanishes between the plan and the prune is only unlisted', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = [droppedOf(home, '.claude'), droppedOf(home, '.agents')];
  let fired = false;
  const fs = hookedFs((op, args) => {
    // The repoint comes after planning and before the prune.
    if (op === 'renameSync' && String(args[1]) === currentOf(home)) {
      fired = true;
      for (const path of dropped) nodeFs.rmSync(path);
    }
  });

  installPayload(upgradeOptions(home, source, { fs }));

  assert.ok(fired, 'the files were removed between the plan and the prune');

  for (const path of dropped) {
    assert.equal(isListed(home, path), false);
    assert.equal(nodeFs.existsSync(path), false);
  }
  assertListedFilesMatchDisk(home);
});

test('a dropped skill file swapped for a symbolic link after the plan is not followed', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const sentinel = join(makeSandbox('user-global-sentinel-'), 'sentinel.txt');
  nodeFs.writeFileSync(sentinel, 'sentinel\n');
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  let fired = false;
  const fs = hookedFs((op, args) => {
    // The repoint comes after planning and before the prune.
    if (op === 'renameSync' && String(args[1]) === currentOf(home)) {
      fired = true;
      nodeFs.unlinkSync(dropped);
      nodeFs.symlinkSync(sentinel, dropped);
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /payload is installed/.test(error.message),
  );
  assert.ok(fired);
  assert.ok(nodeFs.lstatSync(dropped).isSymbolicLink());
  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'sentinel\n');
  assert.ok(isListed(home, dropped));
});

test('a skill directory swapped for a symbolic link after the plan is not followed by the prune', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const references = dirname(dropped);
  const outside = join(makeSandbox('user-global-outside-'), 'references');
  nodeFs.cpSync(references, outside, { recursive: true });
  const outsideBefore = snapshot(outside);
  let fired = false;
  const fs = hookedFs((op, args) => {
    if (op === 'renameSync' && String(args[1]) === currentOf(home)) {
      fired = true;
      nodeFs.rmSync(references, { recursive: true });
      nodeFs.symlinkSync(outside, references);
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /symbolic link/.test(error.message) &&
      /payload is installed/.test(error.message),
  );
  assert.ok(fired);
  assert.deepEqual(snapshot(outside), outsideBefore);
  assert.ok(nodeFs.existsSync(join(outside, 'draft-patterns.md')));
});

test('a failure in a late install step leaves the dropped skill files in place and listed', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = [droppedOf(home, '.claude'), droppedOf(home, '.agents')];
  let fired = false;
  const fs = hookedFs((op, args) => {
    if (
      op === 'openSync' &&
      isWriteCall(op, args) &&
      String(args[0]) === join(home, '.claude', 'CLAUDE.md')
    ) {
      fired = true;
      throw new Error('injected entry-file write failure');
    }
  });

  assert.throws(
    () =>
      installPayload(
        upgradeOptions(home, source, { fs, harnesses: ['claude'] }),
      ),
    /rolled back/,
  );
  assert.ok(fired);
  for (const path of dropped) {
    assert.ok(nodeFs.existsSync(path), `${path} is untouched`);
    assert.ok(isListed(home, path), `${path} is still listed`);
  }
  assert.equal(nodeFs.readlinkSync(currentOf(home)), versionDirOf(home));
  assert.equal(nodeFs.existsSync(versionDirOf(home, UPGRADE_VERSION)), false);
  assertListedFilesMatchDisk(home);
});

test('an older version directory inside a skill directory is not taken for a skill file', () => {
  const home = makeHome();
  const xdg = join(home, '.claude', 'skills', 'issue-authoring', 'xdg');
  nodeFs.mkdirSync(xdg, { recursive: true });
  const env = { HOME: home, XDG_DATA_HOME: xdg };
  installPayload({ env, homedir: home });
  const olderFile = join(xdg, 'idd-skill', PACKAGE_VERSION, ENTRY_RELATIVE);
  assert.ok(nodeFs.existsSync(olderFile));

  installPayload({
    env,
    homedir: home,
    sourceRoot: copySourceTree(),
    version: UPGRADE_VERSION,
  });

  assert.ok(nodeFs.existsSync(olderFile), 'the older version stays on disk');
  assert.ok(
    (
      JSON.parse(
        nodeFs.readFileSync(join(xdg, 'idd-skill', 'receipt.json'), 'utf8'),
      ).entries as ReceiptRow[]
    ).some((entry) => entry.path === olderFile),
    'the older version stays listed',
  );
});

test('a source skill with no SKILL.md makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout('idd-spec-audit/SKILL.md');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    /has no SKILL\.md/,
  );
  assert.deepEqual(snapshot(home), before);
  assert.ok(
    nodeFs.existsSync(
      join(home, '.claude', 'skills', 'idd-spec-audit', 'SKILL.md'),
    ),
  );

  const fresh = makeHome();
  assert.throws(
    () => installPayload(upgradeOptions(fresh, source)),
    /has no SKILL\.md/,
  );
  assert.equal(nodeFs.existsSync(dataRootOf(fresh)), false);
});

test('an upgrade that drops nothing reports no removal and keeps every listed entry', () => {
  for (const harnesses of [[], ['claude']] as const) {
    const home = makeHome();
    installPayload(optionsFor(home, { harnesses }));
    const before = receiptRows(home);
    const skillsBefore = [
      ...snapshot(join(home, '.claude', 'skills')),
      ...snapshot(join(home, '.agents', 'skills')),
    ];
    const source = copySourceTree();

    const result = installPayload(upgradeOptions(home, source, { harnesses }));

    assert.ok(
      result.lines.every(
        (line) => !line.startsWith('remove ') && !line.startsWith('absent '),
      ),
      'no removal is reported',
    );
    const after = receiptRows(home);
    // The upgrade adds entries for the new version and updates the link, and
    // keeps every earlier entry listed, in its original order.
    const earlier = after.filter((entry) =>
      before.some((prior) => prior.path === entry.path),
    );
    assert.deepEqual(
      earlier.map((entry) => [entry.path, entry.kind, entry.sha256]),
      before.map((entry) => [entry.path, entry.kind, entry.sha256]),
    );
    assert.deepEqual(
      [
        ...snapshot(join(home, '.claude', 'skills')),
        ...snapshot(join(home, '.agents', 'skills')),
      ],
      skillsBefore,
      'the skill trees keep their bytes',
    );
  }
});

test('planInstall reports the removals an upgrade would make and writes nothing', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const before = snapshot(home);

  const plan = planInstall(upgradeOptions(home, source));

  for (const root of ['.claude', '.agents'] as const) {
    assert.ok(plan.lines.includes(`remove ${droppedOf(home, root)}`));
  }
  assert.deepEqual(snapshot(home), before);
});
