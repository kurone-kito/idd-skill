import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type {
  AutoDecisionRecord,
  ConfirmationIssueInput,
  ConfirmationIssueRead,
} from '../src/scripts/auto-decision-records.mts';
import type {
  TrustedAutoDecideReport,
  TrustedAutoDecideSnapshot,
} from '../src/scripts/idd-config.mts';
import {
  canonicalSubject,
  claimBasisProblem,
  createDefaultEvidencePorts,
  entryChangeTimeMs,
  evaluateClassGate,
  evaluateConfirmationRecord,
  evaluateQuietWindowAndProcesses,
  evidenceBasisProblem,
  inspectProcessDirectories,
  isDecisionIdText,
  MINIMUM_STALE_AGE_MS,
  newEvidenceReport,
  type ProcPorts,
  parseConfirmationReference,
  type RecordRequest,
  setCondition,
  staleAgeProblem,
  type WalkEntry,
  type WalkPorts,
  walkQuietWindow,
} from '../src/scripts/worktree-remnant-evidence.mts';

const POSIX = process.platform !== 'win32';
const HOUR = 60 * 60 * 1000;

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'idd-wre-')));
  roots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// A virtual tree for the walk and the process check
// ---------------------------------------------------------------------------

interface VirtualEntry extends WalkEntry {
  children?: string[];
  readFails?: string;
  listFails?: string;
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function virtualWalk(tree: Record<string, VirtualEntry>): {
  ports: WalkPorts;
  listed: string[];
} {
  const listed: string[] = [];
  return {
    listed,
    ports: {
      lstat: (path) => {
        const entry = tree[path];
        if (entry === undefined) throw errno('ENOENT');
        if (entry.readFails !== undefined) throw errno(entry.readFails);
        return entry;
      },
      readdir: (path) => {
        listed.push(path);
        const entry = tree[path];
        if (entry?.listFails !== undefined) throw errno(entry.listFails);
        return entry?.children ?? [];
      },
    },
  };
}

function old(overrides: Partial<VirtualEntry> = {}): VirtualEntry {
  return {
    isDirectory: false,
    nlink: 1,
    mtimeMs: 0,
    ctimeMs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Entry time
// ---------------------------------------------------------------------------

test('entryChangeTimeMs: a multiply linked file counts by mtime only', () => {
  const linked = { isDirectory: false, nlink: 2, mtimeMs: 10, ctimeMs: 999 };
  assert.equal(entryChangeTimeMs(linked), 10);
});

test('entryChangeTimeMs: a single link or a directory counts by the later time', () => {
  assert.equal(
    entryChangeTimeMs({
      isDirectory: false,
      nlink: 1,
      mtimeMs: 10,
      ctimeMs: 30,
    }),
    30,
  );
  assert.equal(
    entryChangeTimeMs({
      isDirectory: false,
      nlink: 1,
      mtimeMs: 40,
      ctimeMs: 30,
    }),
    40,
  );
  // A directory's link count counts subdirectories, not hard links.
  assert.equal(
    entryChangeTimeMs({
      isDirectory: true,
      nlink: 7,
      mtimeMs: 10,
      ctimeMs: 30,
    }),
    30,
  );
});

// ---------------------------------------------------------------------------
// Condition 4: the quiet-window walk
// ---------------------------------------------------------------------------

test('walkQuietWindow: a tree that is all older than the window is quiet', () => {
  const { ports } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['a', 'b'] }),
    '/wt/a': old(),
    '/wt/b': old({ isDirectory: true, children: ['c'] }),
    '/wt/b/c': old(),
  });
  const result = walkQuietWindow(ports, ['/wt'], HOUR, 10 * HOUR);
  assert.equal(result.status, 'quiet');
  assert.equal(result.walked, 4);
  assert.equal(result.entry, null);
});

test('walkQuietWindow: a change inside the window is recent and names the entry', () => {
  const now = 10 * HOUR;
  const { ports } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['a', 'hot'] }),
    '/wt/a': old(),
    '/wt/hot': old({ mtimeMs: now - 5 * 60 * 1000 }),
  });
  const result = walkQuietWindow(ports, ['/wt'], HOUR, now);
  assert.equal(result.status, 'recent');
  assert.equal(result.entry, '/wt/hot');
  assert.match(result.detail, /\/wt\/hot changed 300 s ago/);
});

test('walkQuietWindow: the change time of a single-link entry counts', () => {
  const now = 10 * HOUR;
  const { ports } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['chmodded'] }),
    '/wt/chmodded': old({ ctimeMs: now - 1000 }),
  });
  assert.equal(walkQuietWindow(ports, ['/wt'], HOUR, now).status, 'recent');
});

test('walkQuietWindow: a multiply linked file with a recent ctime is quiet', () => {
  const now = 10 * HOUR;
  const { ports } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['store'] }),
    '/wt/store': old({ nlink: 3, ctimeMs: now - 1000 }),
  });
  assert.equal(walkQuietWindow(ports, ['/wt'], HOUR, now).status, 'quiet');
});

test('walkQuietWindow: a time exactly one window old is not recent', () => {
  const now = 10 * HOUR;
  const { ports } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['edge'] }),
    '/wt/edge': old({ mtimeMs: now - HOUR, ctimeMs: now - HOUR }),
  });
  assert.equal(walkQuietWindow(ports, ['/wt'], HOUR, now).status, 'quiet');
});

test('walkQuietWindow: a time in the future counts as recent', () => {
  const now = 10 * HOUR;
  const { ports } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['later'] }),
    '/wt/later': old({ mtimeMs: now + 60_000 }),
  });
  const result = walkQuietWindow(ports, ['/wt'], HOUR, now);
  assert.equal(result.status, 'recent');
  assert.match(result.detail, /time in the future/);
});

test('walkQuietWindow: a time that is not a number counts as recent', () => {
  const { ports } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['nan'] }),
    '/wt/nan': old({ mtimeMs: Number.NaN }),
  });
  assert.equal(
    walkQuietWindow(ports, ['/wt'], HOUR, 10 * HOUR).status,
    'recent',
  );
});

test('walkQuietWindow: an unreadable entry or directory fails the condition', () => {
  const unreadableEntry = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['locked'] }),
    '/wt/locked': old({ readFails: 'EACCES' }),
  });
  const entry = walkQuietWindow(
    unreadableEntry.ports,
    ['/wt'],
    HOUR,
    10 * HOUR,
  );
  assert.equal(entry.status, 'unreadable');
  assert.equal(entry.entry, '/wt/locked');
  assert.match(entry.detail, /EACCES/);

  const unreadableDirectory = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['sub'] }),
    '/wt/sub': old({ isDirectory: true, listFails: 'EACCES' }),
  });
  const directory = walkQuietWindow(
    unreadableDirectory.ports,
    ['/wt'],
    HOUR,
    10 * HOUR,
  );
  assert.equal(directory.status, 'unreadable');
  assert.match(directory.detail, /could not be listed/);
});

test('walkQuietWindow: an entry that vanishes during the walk fails the condition', () => {
  const { ports } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['gone'] }),
  });
  const result = walkQuietWindow(ports, ['/wt'], HOUR, 10 * HOUR);
  assert.equal(result.status, 'unreadable');
  assert.match(result.detail, /ENOENT/);
});

test('walkQuietWindow: a symlink is one entry and is never followed', () => {
  const { ports, listed } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['link'] }),
    // lstat reports the link itself, so it is not a directory.
    '/wt/link': old({ isDirectory: false }),
    '/elsewhere': old({ isDirectory: true, children: ['hot'] }),
    '/elsewhere/hot': old({ mtimeMs: 10 * HOUR }),
  });
  const result = walkQuietWindow(ports, ['/wt'], HOUR, 10 * HOUR);
  assert.equal(result.status, 'quiet');
  assert.deepEqual(listed, ['/wt']);
});

test('walkQuietWindow: a root that is not a directory cannot be walked', () => {
  const { ports } = virtualWalk({ '/wt': old({ isDirectory: false }) });
  const result = walkQuietWindow(ports, ['/wt'], HOUR, 10 * HOUR);
  assert.equal(result.status, 'unreadable');
  assert.match(result.detail, /not a directory/);
});

test('walkQuietWindow: every root is walked', () => {
  const { ports } = virtualWalk({
    '/wt': old({ isDirectory: true }),
    '/admin': old({ isDirectory: true, children: ['index'] }),
    '/admin/index': old({ mtimeMs: 10 * HOUR - 1000 }),
  });
  const result = walkQuietWindow(ports, ['/wt', '/admin'], HOUR, 10 * HOUR);
  assert.equal(result.status, 'recent');
  assert.equal(result.entry, '/admin/index');
});

test('walkQuietWindow: real files, a backdated mtime, and the real change time', {
  skip: !POSIX,
}, () => {
  const root = scratch();
  const tree = join(root, 'wt');
  mkdirSync(tree);
  const longAgo = new Date(Date.now() - 72 * HOUR);
  const real = createDefaultEvidencePorts({
    repository: { owner: 'o', repo: 'r' },
  }).walk;
  // A directory's change time cannot be backdated, so the directories read as
  // old here; the files are real.
  const ports: WalkPorts = {
    readdir: real.readdir,
    lstat: (path) => {
      const entry = real.lstat(path);
      return entry.isDirectory ? { ...entry, mtimeMs: 0, ctimeMs: 0 } : entry;
    },
  };

  // One link: the change time counts, and a chmod after the backdating moves
  // it to now while the modification time stays old.
  const single = join(tree, 'single.bin');
  writeFileSync(single, 's\n');
  utimesSync(single, longAgo, longAgo);
  chmodSync(single, 0o600);
  const recent = walkQuietWindow(ports, [tree], HOUR, Date.now());
  assert.equal(recent.status, 'recent');
  assert.equal(recent.entry, single);
  rmSync(single);

  // More than one link: a link added by another worktree's install moves the
  // change time, and the walk ignores that and reads the modification time.
  const store = join(root, 'store.bin');
  writeFileSync(store, 's\n');
  utimesSync(store, longAgo, longAgo);
  linkSync(store, join(tree, 'store.bin'));
  const linked = walkQuietWindow(ports, [tree], HOUR, Date.now());
  assert.equal(linked.status, 'quiet', linked.detail);

  // A modification inside the window counts for a multiply linked file too.
  const now = new Date();
  utimesSync(join(tree, 'store.bin'), now, now);
  assert.equal(
    walkQuietWindow(ports, [tree], HOUR, Date.now()).status,
    'recent',
  );

  // The unmodified fixture is quiet once the clock moves past its change time.
  assert.equal(
    walkQuietWindow(real, [tree], HOUR, Date.now() + 24 * HOUR).status,
    'quiet',
  );
});

test('walkQuietWindow: a real symlink to a directory is not followed', {
  skip: !POSIX,
}, () => {
  const root = scratch();
  const tree = join(root, 'wt');
  const outside = join(root, 'outside');
  mkdirSync(tree);
  mkdirSync(outside);
  writeFileSync(join(outside, 'hot.txt'), 'hot\n');
  symlinkSync(outside, join(tree, 'link'));
  const longAgo = new Date(Date.now() - 72 * HOUR);
  utimesSync(tree, longAgo, longAgo);
  // The link's own times are recent; only the entry itself is judged.
  const ports = createDefaultEvidencePorts({
    repository: { owner: 'o', repo: 'r' },
  }).walk;
  const result = walkQuietWindow(ports, [tree], HOUR, Date.now() + 24 * HOUR);
  assert.equal(result.status, 'quiet');
  assert.equal(result.walked, 2);
});

// ---------------------------------------------------------------------------
// Condition 5: process working directories
// ---------------------------------------------------------------------------

/** The user these tests run as; a process owned by another user is 2000. */
const ME = 1000;

function virtualProc(
  workDirs: Record<string, string | Error>,
  extra: Partial<ProcPorts> = {},
): ProcPorts {
  return {
    platform: 'linux',
    listPids: () => Object.keys(workDirs),
    readCwd: (pid) => {
      const value = workDirs[pid];
      if (value === undefined) throw errno('ENOENT');
      if (value instanceof Error) throw value;
      return value;
    },
    ownerUid: () => ME,
    currentUid: ME,
    realpath: (path) => path,
    ...extra,
  };
}

test('inspectProcessDirectories: a process inside the worktree matches', () => {
  const result = inspectProcessDirectories(
    virtualProc({ '100': '/other', '200': '/repo/wt/src' }),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'match');
  assert.deepEqual(result.matches, [{ pid: 200, cwd: '/repo/wt/src' }]);
  assert.match(result.detail, /process 200/);
});

test('inspectProcessDirectories: a process at the worktree root matches', () => {
  const result = inspectProcessDirectories(virtualProc({ '7': '/repo/wt' }), [
    '/repo/wt',
  ]);
  assert.equal(result.status, 'match');
});

test('inspectProcessDirectories: a sibling path that shares a prefix does not match', () => {
  const result = inspectProcessDirectories(
    virtualProc({ '7': '/repo/wt2/src' }),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'clear');
});

test('inspectProcessDirectories: a removed directory below the worktree still matches', () => {
  const result = inspectProcessDirectories(
    virtualProc({ '7': '/repo/wt/gone (deleted)' }),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'match');
});

test('inspectProcessDirectories: the resolved path is compared too', () => {
  // The root was named through a link; the kernel reports the real path.
  const result = inspectProcessDirectories(
    virtualProc(
      { '7': '/real/wt/src' },
      { realpath: (path) => (path === '/link/wt' ? '/real/wt' : path) },
    ),
    ['/link/wt'],
  );
  assert.equal(result.status, 'match');

  // And a working directory that is a link into the worktree matches by its
  // own resolved path.
  const viaCwd = inspectProcessDirectories(
    virtualProc(
      { '7': '/somewhere/alias' },
      {
        realpath: (path) =>
          path === '/somewhere/alias' ? '/repo/wt/src' : path,
      },
    ),
    ['/repo/wt'],
  );
  assert.equal(viaCwd.status, 'match');
});

test('inspectProcessDirectories: an exited process is skipped', () => {
  const result = inspectProcessDirectories(
    virtualProc({ '1': errno('ENOENT'), '2': errno('ESRCH') }),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'clear');
  assert.equal(result.notInspected.count, 0);
});

test('inspectProcessDirectories: a process that denies the read is listed, not refused', () => {
  const result = inspectProcessDirectories(
    virtualProc({ '5': errno('EACCES'), '6': '/elsewhere' }),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'clear');
  assert.deepEqual(result.notInspected, {
    count: 1,
    sample: [{ pid: 5, reason: 'EACCES' }],
  });
  assert.match(result.detail, /1 process\(es\) denied the read/);
});

test('inspectProcessDirectories: a denied read does not hide a match', () => {
  const result = inspectProcessDirectories(
    virtualProc({ '5': errno('EACCES'), '6': '/repo/wt' }),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'match');
  assert.equal(result.notInspected.count, 1);
});

test('inspectProcessDirectories: the not-inspected list is capped but the count is exact', () => {
  const workDirs: Record<string, Error> = {};
  for (let pid = 1; pid <= 120; pid += 1)
    workDirs[String(pid)] = errno('EACCES');
  const result = inspectProcessDirectories(virtualProc(workDirs), ['/repo/wt']);
  assert.equal(result.notInspected.count, 120);
  assert.equal(result.notInspected.sample.length, 50);
});

test('inspectProcessDirectories: any other read error fails the condition', () => {
  for (const code of ['EIO', 'EPERM', 'EMFILE', 'ELOOP']) {
    const result = inspectProcessDirectories(
      virtualProc({ '5': errno(code) }),
      ['/repo/wt'],
    );
    assert.equal(result.status, 'error', code);
    assert.match(result.detail, new RegExp(code));
  }
});

test('inspectProcessDirectories: a path that cannot be resolved fails the condition', () => {
  const throwing = (): string | null => {
    throw errno('EACCES');
  };
  const root = inspectProcessDirectories(
    virtualProc({ '7': '/elsewhere' }, { realpath: throwing }),
    ['/repo/wt'],
  );
  assert.equal(root.status, 'error');
  assert.match(root.detail, /a root could not be resolved: EACCES/);
  let calls = 0;
  const later = inspectProcessDirectories(
    virtualProc(
      { '7': '/elsewhere' },
      {
        realpath: (path) => {
          calls += 1;
          if (calls > 1) throw errno('EACCES');
          return path;
        },
      },
    ),
    ['/repo/wt'],
  );
  assert.equal(later.status, 'error');
  assert.match(later.detail, /process 7 could not be resolved/);
});

test('inspectProcessDirectories: a process of another user is outside the condition', () => {
  const result = inspectProcessDirectories(
    virtualProc(
      { '7': '/repo/wt/src', '8': '/repo/wt/lib' },
      { ownerUid: (pid) => (pid === '7' ? 2000 : ME) },
    ),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'match');
  assert.deepEqual(result.matches, [{ pid: 8, cwd: '/repo/wt/lib' }]);
  assert.equal(result.otherUsers, 1);
  const only = inspectProcessDirectories(
    virtualProc({ '7': '/repo/wt/src' }, { ownerUid: () => 2000 }),
    ['/repo/wt'],
  );
  assert.equal(only.status, 'clear');
  assert.equal(only.otherUsers, 1);
  assert.match(
    only.detail,
    /1 process\(es\) of other users are there and are not counted/,
  );
});

test('inspectProcessDirectories: a denied read counts only for this user or root', () => {
  const result = inspectProcessDirectories(
    virtualProc(
      {
        '1': errno('EACCES'),
        '2': errno('EACCES'),
        '3': errno('EACCES'),
        '4': errno('EACCES'),
      },
      {
        ownerUid: (pid) => ({ '1': ME, '2': 0, '3': 2000, '4': ME })[pid] ?? 0,
      },
    ),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'clear');
  assert.deepEqual(
    result.notInspected.sample.map((entry) => entry.pid),
    [1, 2, 4],
  );
  assert.equal(result.notInspected.count, 3);
});

test('inspectProcessDirectories: a process that exits before its owner is read is skipped', () => {
  const result = inspectProcessDirectories(
    virtualProc(
      { '7': '/repo/wt/src', '8': errno('EACCES') },
      {
        ownerUid: () => {
          throw errno('ENOENT');
        },
      },
    ),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'clear');
  assert.equal(result.notInspected.count, 0);
});

test('inspectProcessDirectories: an owner that cannot be read, or no current user, fails the condition', () => {
  for (const workDirs of [
    { '7': '/repo/wt/src' },
    { '7': errno('EACCES') },
  ] as Array<Record<string, string | Error>>) {
    const result = inspectProcessDirectories(
      virtualProc(workDirs, {
        ownerUid: () => {
          throw errno('EIO');
        },
      }),
      ['/repo/wt'],
    );
    assert.equal(result.status, 'error');
    assert.match(
      result.detail,
      /the owner of process 7 could not be read: EIO/,
    );
  }
  const noUser = inspectProcessDirectories(
    virtualProc({ '7': '/elsewhere' }, { currentUid: null }),
    ['/repo/wt'],
  );
  assert.equal(noUser.status, 'error');
  assert.match(noUser.detail, /current user could not be determined/);
});

test('evaluateQuietWindowAndProcesses: the process check covers only its own roots', () => {
  const report = newEvidenceReport();
  const { ports: walk } = virtualWalk({
    '/wt': old({ isDirectory: true }),
    '/admin': old({ isDirectory: true }),
  });
  // A process inside the admin directory is outside the worktree.
  evaluateQuietWindowAndProcesses(
    {
      walk,
      proc: virtualProc({ '7': '/admin/sub' }),
      nowMs: () => 10 * HOUR,
    },
    report,
    ['/wt', '/admin'],
    ['/wt'],
    HOUR,
  );
  assert.equal(report.conditions[3]?.status, 'met');
  assert.equal(report.conditions[4]?.status, 'met');
  evaluateQuietWindowAndProcesses(
    {
      walk,
      proc: virtualProc({ '7': '/admin/sub' }),
      nowMs: () => 10 * HOUR,
    },
    report,
    ['/wt', '/admin'],
    ['/wt', '/admin'],
    HOUR,
  );
  assert.equal(report.conditions[4]?.status, 'unmet');
});

test('inspectProcessDirectories: an unreadable /proc fails the condition', () => {
  const result = inspectProcessDirectories(
    virtualProc(
      {},
      {
        listPids: () => {
          throw errno('ENOENT');
        },
      },
    ),
    ['/repo/wt'],
  );
  assert.equal(result.status, 'error');
});

test('inspectProcessDirectories: a platform without /proc fails the condition', () => {
  for (const platform of ['darwin', 'win32', 'freebsd'] as const) {
    const result = inspectProcessDirectories(
      virtualProc({ '5': '/elsewhere' }, { platform }),
      ['/repo/wt'],
    );
    assert.equal(result.status, 'unsupported', platform);
  }
});

test('inspectProcessDirectories: the production reader sees this process', {
  skip: process.platform !== 'linux',
}, () => {
  const root = scratch();
  const ports = createDefaultEvidencePorts({
    repository: { owner: 'o', repo: 'r' },
  }).proc;
  const own = ports.listPids();
  assert.ok(own.includes(String(process.pid)));
  assert.equal(ports.readCwd(String(process.pid)), realpathSync(process.cwd()));
  assert.equal(ports.currentUid, process.getuid?.() ?? null);
  assert.equal(ports.ownerUid(String(process.pid)), process.getuid?.());
  assert.equal(inspectProcessDirectories(ports, [root]).status, 'clear');
  assert.equal(
    inspectProcessDirectories(ports, [realpathSync(process.cwd())]).status,
    'match',
  );
});

// ---------------------------------------------------------------------------
// Conditions 1 and 3: the class gate and the basis
// ---------------------------------------------------------------------------

function trustedSnapshot(
  overrides: Partial<TrustedAutoDecideReport> = {},
  policyConfig: TrustedAutoDecideSnapshot['policyConfig'] = null,
): TrustedAutoDecideSnapshot {
  return {
    report: {
      status: 'readable',
      source: 'repository',
      ref: 'main',
      master: 'enabled',
      classes: {
        decisionIssue: 'class-off',
        runtimeQuestion: 'class-off',
        authoringChoice: 'class-off',
        worktreeRemnant: 'enabled',
        b1Leftover: 'class-off',
      },
      confirmationLabelName: 'status:needs-confirmation',
      maxPendingConfirmations: 10,
      maxDecisionsPerClaim: 3,
      quietWindow: 'PT2H',
      ...overrides,
    },
    policyConfig,
  };
}

const STALE = {
  reason: 'stale-claim-local-worktree-occupied',
  claimId: 'claim-x',
  staleAgeMs: MINIMUM_STALE_AGE_MS,
};

test('claimBasisProblem: a stale or released reason with a claim ID passes', () => {
  assert.equal(claimBasisProblem(STALE), null);
  assert.equal(
    claimBasisProblem({
      reason: 'released-claim-local-worktree-occupied',
      claimId: 'claim-x',
      staleAgeMs: null,
    }),
    null,
  );
  assert.equal(
    claimBasisProblem({
      reason: 'stale-claim-local-worktree-unreadable',
      claimId: 'claim-x',
      staleAgeMs: null,
    }),
    null,
  );
});

test('claimBasisProblem: an explicit-absence reason keeps the attestation path', () => {
  for (const reason of [
    'active-claim-stale',
    'no-active-claim',
    'legacy-released',
  ]) {
    assert.match(
      claimBasisProblem({ ...STALE, reason }) ?? '',
      /neither stale-claim-\* nor released-claim-\*/,
      reason,
    );
  }
});

test('claimBasisProblem: a claim ID that is missing from the routing JSON never passes', () => {
  // A missing field reads as undefined, not null.
  for (const claimId of [undefined, 7, {}, []] as unknown[]) {
    assert.match(
      claimBasisProblem({ ...STALE, claimId: claimId as string | null }) ?? '',
      /no claim ID/,
      String(claimId),
    );
  }
});

test('claimBasisProblem: a legacy release has no claim ID', () => {
  for (const claimId of [null, '']) {
    assert.match(
      claimBasisProblem({ ...STALE, claimId }) ?? '',
      /legacy release/,
    );
  }
});

test('staleAgeProblem: only a stale reason needs the 24-hour floor', () => {
  assert.equal(staleAgeProblem(STALE), null);
  assert.match(
    staleAgeProblem({ ...STALE, staleAgeMs: MINIMUM_STALE_AGE_MS - 1 }) ?? '',
    /below the 86400000 ms \(PT24H\) floor/,
  );
  assert.match(
    staleAgeProblem({ ...STALE, staleAgeMs: null }) ?? '',
    /no readable stale age/,
  );
  assert.match(
    staleAgeProblem({ ...STALE, staleAgeMs: Number.NaN }) ?? '',
    /no readable stale age/,
  );
  assert.equal(
    staleAgeProblem({
      reason: 'released-claim-local-worktree-occupied',
      claimId: 'claim-x',
      staleAgeMs: 1,
    }),
    null,
  );
});

test('evidenceBasisProblem: reports the claim problem first, then the age', () => {
  assert.equal(evidenceBasisProblem(STALE), null);
  assert.match(
    evidenceBasisProblem({ ...STALE, reason: 'active-claim-stale' }) ?? '',
    /neither stale-claim/,
  );
  assert.match(
    evidenceBasisProblem({ ...STALE, staleAgeMs: 1 }) ?? '',
    /PT24H/,
  );
});

test('evaluateClassGate: an enabled class with a quiet window and a fresh stale age passes', () => {
  const gate = evaluateClassGate(
    () => trustedSnapshot(),
    { owner: 'o', repo: 'r' },
    STALE,
  );
  assert.equal(gate.ok, true, gate.detail);
  assert.equal(gate.quietWindow, 'PT2H');
  assert.equal(gate.quietWindowMs, 2 * HOUR);
  assert.ok(gate.snapshot !== null);
  assert.match(gate.detail, /enabled at ref main/);
});

test('evaluateClassGate: a released claim needs no stale age', () => {
  const gate = evaluateClassGate(
    () => trustedSnapshot(),
    { owner: 'o', repo: 'r' },
    {
      reason: 'released-claim-local-worktree-occupied',
      claimId: 'claim-x',
      staleAgeMs: null,
    },
  );
  assert.equal(gate.ok, true, gate.detail);
});

test('evaluateClassGate: a repository whose own stale age is shorter still gets the floor', () => {
  const gate = evaluateClassGate(
    () => trustedSnapshot(),
    { owner: 'o', repo: 'r' },
    { ...STALE, staleAgeMs: 4 * HOUR },
  );
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /PT24H/);
});

test('evaluateClassGate: the class off, the master off, or an unreadable read refuses', () => {
  const read = (snapshot: TrustedAutoDecideSnapshot) => () => snapshot;
  const repository = { owner: 'o', repo: 'r' };
  for (const verdict of ['class-off', 'master-off', 'unreadable'] as const) {
    const gate = evaluateClassGate(
      read(
        trustedSnapshot({
          classes: {
            decisionIssue: 'class-off',
            runtimeQuestion: 'class-off',
            authoringChoice: 'class-off',
            worktreeRemnant: verdict,
            b1Leftover: 'class-off',
          },
        }),
      ),
      repository,
      STALE,
    );
    assert.equal(gate.ok, false, verdict);
    assert.match(gate.detail, new RegExp(`class is ${verdict}`));
  }
  const unreadable = evaluateClassGate(
    read(
      trustedSnapshot({
        status: 'unreadable',
        error: 'no network',
      }),
    ),
    repository,
    STALE,
  );
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.detail, /unreadable: no network/);
});

test('evaluateClassGate: a quiet window that is missing or malformed refuses', () => {
  for (const quietWindow of [undefined, 'PT0S', 'soon', '']) {
    const gate = evaluateClassGate(
      () => trustedSnapshot({ quietWindow }),
      { owner: 'o', repo: 'r' },
      STALE,
    );
    assert.equal(gate.ok, false, String(quietWindow));
    assert.equal(gate.quietWindowMs, null);
    assert.match(gate.detail, /quietWindow/);
  }
});

test('evaluateClassGate: a read that throws refuses', () => {
  const gate = evaluateClassGate(
    () => {
      throw new Error('boom');
    },
    { owner: 'o', repo: 'r' },
    STALE,
  );
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /threw: boom/);
  assert.equal(gate.snapshot, null);
});

test('evaluateClassGate: reads the repository it is given, with no base ref', () => {
  const seen: unknown[] = [];
  evaluateClassGate(
    (input) => {
      seen.push(input);
      return trustedSnapshot();
    },
    { owner: 'kurone-kito', repo: 'idd-skill' },
    STALE,
  );
  assert.deepEqual(seen, [{ owner: 'kurone-kito', repo: 'idd-skill' }]);
});

// ---------------------------------------------------------------------------
// Conditions 4 and 5 together
// ---------------------------------------------------------------------------

test('evaluateQuietWindowAndProcesses: sets both conditions and the report fields', () => {
  const report = newEvidenceReport();
  const { ports: walk } = virtualWalk({
    '/wt': old({ isDirectory: true, children: ['a'] }),
    '/wt/a': old(),
  });
  evaluateQuietWindowAndProcesses(
    {
      walk,
      proc: virtualProc({ '5': errno('EACCES') }),
      nowMs: () => 10 * HOUR,
    },
    report,
    ['/wt'],
    ['/wt'],
    HOUR,
  );
  const [four, five] = [report.conditions[3], report.conditions[4]];
  assert.equal(four?.status, 'met');
  assert.equal(five?.status, 'met');
  assert.equal(report.entriesWalked, 2);
  assert.equal(report.processesNotInspected.count, 1);
});

test('evaluateQuietWindowAndProcesses: an unread quiet window leaves condition 4 unevaluated', () => {
  const report = newEvidenceReport();
  const { ports: walk } = virtualWalk({ '/wt': old({ isDirectory: true }) });
  evaluateQuietWindowAndProcesses(
    { walk, proc: virtualProc({}), nowMs: () => 10 * HOUR },
    report,
    ['/wt'],
    ['/wt'],
    null,
  );
  assert.equal(report.conditions[3]?.status, 'not-evaluated');
  assert.equal(report.conditions[4]?.status, 'met');
});

test('evaluateQuietWindowAndProcesses: the walk uses the clock it is given', () => {
  const report = newEvidenceReport();
  const { ports: walk } = virtualWalk({
    '/wt': old({ isDirectory: true, mtimeMs: 9 * HOUR + 30 * 60 * 1000 }),
  });
  const proc = virtualProc({});
  evaluateQuietWindowAndProcesses(
    { walk, proc, nowMs: () => 10 * HOUR },
    report,
    ['/wt'],
    ['/wt'],
    HOUR,
  );
  assert.equal(report.conditions[3]?.status, 'unmet');
  evaluateQuietWindowAndProcesses(
    { walk, proc, nowMs: () => 12 * HOUR },
    report,
    ['/wt'],
    ['/wt'],
    HOUR,
  );
  assert.equal(report.conditions[3]?.status, 'met');
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

test('newEvidenceReport: six conditions, none evaluated, and the basis statement', () => {
  const report = newEvidenceReport();
  assert.equal(report.basis, 'mechanical-evidence');
  assert.deepEqual(
    report.conditions.map((condition) => [condition.number, condition.id]),
    [
      [1, 'class-enabled'],
      [2, 'linked-worktree'],
      [3, 'stale-or-released-claim'],
      [4, 'quiet-window'],
      [5, 'no-process-cwd'],
      [6, 'confirmation-record'],
    ],
  );
  assert.ok(report.conditions.every((c) => c.status === 'not-evaluated'));
  assert.equal(report.met, false);
  assert.match(report.statement, /not an attestation/);
  assert.match(report.statement, /does not prove|No condition proves/);
  assert.equal(report.openRisks.length, 3);
});

test('setCondition: the report is met only when all six are met', () => {
  const report = newEvidenceReport();
  for (let number = 1; number <= 6; number += 1) {
    assert.equal(report.met, false);
    setCondition(report, number, 'met', 'ok');
  }
  assert.equal(report.met, true);
  setCondition(report, 4, 'unmet', 'recent');
  assert.equal(report.met, false);
  assert.throws(
    () => setCondition(report, 7, 'met', 'x'),
    /no evidence condition 7/,
  );
});

// ---------------------------------------------------------------------------
// Condition 6: the confirmation record
// ---------------------------------------------------------------------------

const SOURCE = 'kurone-kito/idd-skill#4969';

function record(
  overrides: Partial<AutoDecisionRecord> = {},
): AutoDecisionRecord {
  return {
    issue: 5200,
    from: 'body',
    class: 'worktreeRemnant',
    source: SOURCE,
    claim: 'claim-x',
    set: 'none',
    decision: 'decision-1',
    subject: '/repo.issue-1',
    locationNote: false,
    failureNote: false,
    ...overrides,
  };
}

function readable(
  overrides: Partial<
    Extract<ConfirmationIssueRead, { status: 'readable' }>
  > = {},
): ConfirmationIssueRead {
  return {
    status: 'readable',
    number: 5200,
    state: 'open',
    confirmationLabel: true,
    authoringLabel: false,
    bodyRecordCounts: true,
    bodyRecordReason: null,
    records: [record()],
    voidedDecisions: [],
    conflictingDecisions: [],
    notes: [],
    ...overrides,
  };
}

function recordRequest(overrides: Partial<RecordRequest> = {}): RecordRequest {
  return {
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    issue: 4969,
    confirmation: { owner: 'kurone-kito', repo: 'idd-skill', number: 5200 },
    decision: 'decision-1',
    claimId: 'claim-x',
    subject: '/repo.issue-1',
    ...overrides,
  };
}

function check(
  read: ConfirmationIssueRead,
  request: RecordRequest = recordRequest(),
  snapshot: TrustedAutoDecideSnapshot | null = trustedSnapshot(),
) {
  return evaluateConfirmationRecord(() => read, snapshot, request);
}

test('evaluateConfirmationRecord: an open, labeled, released record that matches passes', () => {
  const result = check(readable());
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /decision-1/);
});

test('evaluateConfirmationRecord: no --confirmation or --decision is unmet', () => {
  assert.equal(
    check(readable(), recordRequest({ confirmation: null })).ok,
    false,
  );
  assert.equal(check(readable(), recordRequest({ decision: null })).ok, false);
  assert.equal(check(readable(), recordRequest({ decision: '' })).ok, false);
  assert.match(
    check(readable(), recordRequest({ confirmation: null })).detail,
    /no --confirmation and --decision/,
  );
});

test('evaluateConfirmationRecord: another repository, or the claimed issue itself, is unmet', () => {
  assert.match(
    check(
      readable(),
      recordRequest({
        confirmation: { owner: 'someone', repo: 'else', number: 5200 },
      }),
    ).detail,
    /another issue of this repository/,
  );
  assert.match(
    check(
      readable(),
      recordRequest({
        confirmation: { owner: 'kurone-kito', repo: 'idd-skill', number: 4969 },
      }),
    ).detail,
    /another issue of this repository/,
  );
  // The repository name compares case-insensitively.
  assert.equal(
    check(
      readable(),
      recordRequest({
        confirmation: { owner: 'Kurone-Kito', repo: 'IDD-Skill', number: 5200 },
      }),
    ).ok,
    true,
  );
});

test('evaluateConfirmationRecord: an unreadable record is unmet', () => {
  const result = check({ status: 'unreadable', error: 'page missing' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /unreadable: page missing/);
});

test('evaluateConfirmationRecord: a closed, unlabeled, or still held issue is unmet', () => {
  assert.match(check(readable({ state: 'closed' })).detail, /not open/);
  assert.match(
    check(readable({ confirmationLabel: false })).detail,
    /lacks the status:needs-confirmation label/,
  );
  assert.match(
    check(readable({ authoringLabel: true })).detail,
    /still carries the authoring label/,
  );
  const several = check(
    readable({
      state: 'closed',
      confirmationLabel: false,
      authoringLabel: true,
    }),
  );
  assert.equal(several.ok, false);
  assert.match(several.detail, /not open, it lacks .* it still carries/);
});

test('evaluateConfirmationRecord: another claim, subject, decision, class, or source is unmet', () => {
  for (const override of [
    { claim: 'claim-y' },
    { subject: '/repo.issue-2' },
    { decision: 'decision-2' },
    { class: 'b1Leftover' as const },
    { source: 'kurone-kito/idd-skill#1' },
  ]) {
    const result = check(readable({ records: [record(override)] }));
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.match(result.detail, /matches no record/);
  }
});

test('evaluateConfirmationRecord: no record at all is unmet', () => {
  assert.equal(check(readable({ records: [] })).ok, false);
});

test('evaluateConfirmationRecord: a voided decision is unmet and says so', () => {
  const result = check(
    readable({ records: [], voidedDecisions: ['decision-1'] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /it is voided/);
});

test('evaluateConfirmationRecord: disagreeing records are unmet and say so', () => {
  const result = check(
    readable({ records: [], conflictingDecisions: ['decision-1'] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /its records disagree/);
});

test('evaluateConfirmationRecord: a counting location or failure note is unmet', () => {
  const located = check(
    readable({ records: [record({ locationNote: true })] }),
  );
  assert.equal(located.ok, false);
  assert.match(located.detail, /counting location note/);
  assert.match(located.detail, /a new attempt needs a new decision/);
  const failed = check(readable({ records: [record({ failureNote: true })] }));
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /counting failure note/);
});

test('evaluateConfirmationRecord: an unavailable trusted read is unmet', () => {
  assert.equal(check(readable(), recordRequest(), null).ok, false);
  assert.match(
    check(
      readable(),
      recordRequest(),
      trustedSnapshot({ status: 'unreadable', error: 'x' }),
    ).detail,
    /trusted policy read is unavailable/,
  );
  assert.match(
    check(
      readable(),
      recordRequest(),
      trustedSnapshot({ confirmationLabelName: ' ' }),
    ).detail,
    /confirmation label name/,
  );
});

test('evaluateConfirmationRecord: a reader that throws is unmet', () => {
  const result = evaluateConfirmationRecord(
    () => {
      throw new Error('gh failed');
    },
    trustedSnapshot(),
    recordRequest(),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /could not be read: gh failed/);
});

test('evaluateConfirmationRecord: reads with the trusted label and the trusted policy', () => {
  let seen: ConfirmationIssueInput | undefined;
  const policyConfig = {
    markerPrefix: 'idd-skill',
    issueAuthoring: { authoringLabelName: 'status:drafting' },
  } as unknown as TrustedAutoDecideSnapshot['policyConfig'];
  const result = evaluateConfirmationRecord(
    (input) => {
      seen = input;
      return readable();
    },
    trustedSnapshot({ confirmationLabelName: 'confirm-me' }, policyConfig),
    recordRequest(),
  );
  assert.equal(result.ok, true, result.detail);
  assert.equal(seen?.confirmationLabel, 'confirm-me');
  assert.equal(seen?.authoringLabel, 'status:drafting');
  assert.equal(seen?.number, 5200);
  assert.deepEqual(seen?.repository, {
    owner: 'kurone-kito',
    repo: 'idd-skill',
  });
  assert.equal(seen?.trustedPolicyConfig, policyConfig);
  assert.equal(seen?.policyPath, undefined);
});

// ---------------------------------------------------------------------------
// Subject, reference, and decision parsing
// ---------------------------------------------------------------------------

test('canonicalSubject: the parent is resolved and the last component is kept as written', {
  skip: !POSIX,
}, () => {
  const root = scratch();
  const real = join(root, 'real');
  mkdirSync(real);
  symlinkSync(real, join(root, 'alias'));
  const ports = createDefaultEvidencePorts({
    repository: { owner: 'o', repo: 'r' },
  });
  const realpath = ports.guards.realpath;
  // The parent is a link: it resolves.
  assert.equal(
    canonicalSubject(join(root, 'alias', 'repo.issue-1'), realpath),
    join(real, 'repo.issue-1'),
  );
  // The last component is a link: it is kept, not followed.
  symlinkSync(real, join(real, 'last-link'));
  assert.equal(
    canonicalSubject(join(real, 'last-link'), realpath),
    join(real, 'last-link'),
  );
  // A parent that does not resolve keeps the absolute path.
  assert.equal(
    canonicalSubject(join(root, 'nope', 'x'), () => null),
    join(root, 'nope', 'x'),
  );
});

test('parseConfirmationReference: owner/repo#number only', () => {
  assert.deepEqual(parseConfirmationReference('kurone-kito/idd-skill#5200'), {
    owner: 'kurone-kito',
    repo: 'idd-skill',
    number: 5200,
  });
  for (const text of [
    '5200',
    '#5200',
    'a/b#0',
    'a/b#',
    'a/b#-1',
    'a b/c#1',
    '',
  ]) {
    assert.equal(parseConfirmationReference(text), null, text);
  }
});

test('isDecisionIdText: one token with no whitespace, no semicolon, no marker end', () => {
  assert.equal(isDecisionIdText('decision-1'), true);
  assert.equal(isDecisionIdText('a'.repeat(128)), true);
  for (const text of ['', 'a b', 'a;b', 'a-->b', 'a'.repeat(129)]) {
    assert.equal(isDecisionIdText(text), false, text);
  }
});

// ---------------------------------------------------------------------------
// Production ports
// ---------------------------------------------------------------------------

test('createDefaultEvidencePorts: the state root follows the environment and the platform', () => {
  const ports = createDefaultEvidencePorts({
    repository: { owner: 'o', repo: 'r' },
    env: { XDG_STATE_HOME: '/state' },
    platform: 'linux',
    home: '/home/nobody',
  });
  assert.equal(ports.guards.stateRoot, '/state');
  assert.deepEqual(ports.repository, { owner: 'o', repo: 'r' });
  assert.equal(ports.proc.platform, 'linux');
  assert.equal(typeof ports.nowMs(), 'number');
  const fallback = createDefaultEvidencePorts({
    repository: { owner: 'o', repo: 'r' },
    env: {},
    platform: 'linux',
    home: '/home/nobody',
  });
  assert.equal(fallback.guards.stateRoot, '/home/nobody/.local/state');
});

test('createDefaultEvidencePorts: the guard filesystem reads real directories', {
  skip: !POSIX,
}, () => {
  const root = scratch();
  const dir = join(root, 'd');
  mkdirSync(dir);
  writeFileSync(join(root, 'f'), 'x');
  symlinkSync(dir, join(root, 'l'));
  const { guards } = createDefaultEvidencePorts({
    repository: { owner: 'o', repo: 'r' },
  });
  assert.equal(guards.lstat(dir), 'directory');
  assert.equal(guards.lstat(join(root, 'f')), 'file');
  assert.equal(guards.lstat(join(root, 'l')), 'symlink');
  assert.equal(guards.lstat(join(root, 'nope')), 'absent');
  assert.match(guards.directoryIdentity(dir) ?? '', /^\d+:\d+$/);
  assert.equal(guards.directoryIdentity(join(root, 'l')), null);
  assert.equal(guards.directoryIdentity(join(root, 'nope')), null);
  assert.equal(guards.realpath(join(root, 'l')), dir);
  assert.equal(guards.realpath(join(root, 'nope')), null);
  assert.equal(guards.inspectDirectoryPrivacy(dir) === 'unsafe', false);
  const made = join(root, 'made');
  guards.mkdir(made, 0o700);
  assert.equal(guards.lstat(made), 'directory');
  assert.equal(guards.inspectDirectoryPrivacy(made), 'private');
});
