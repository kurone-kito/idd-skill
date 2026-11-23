import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  parseWindowsProcessRecords,
  readWindowsProcessRecords,
} from '../src/scripts/windows-process-cwd.mts';

const USER_SID = 'S-1-5-21-1000000001-2000000002-3000000003-1001';
const OTHER_SID = 'S-1-5-21-1000000001-2000000002-3000000003-1002';
const SYSTEM_SID = 'S-1-5-18';

const FAKE = {
  currentSid: USER_SID,
  records: [
    {
      pid: 4,
      kind: 'exited',
      bitness: null,
      ownerSid: null,
      directory: null,
      reason: null,
    },
    {
      pid: 8,
      kind: 'denied',
      bitness: null,
      ownerSid: SYSTEM_SID,
      directory: null,
      reason: null,
    },
    {
      pid: 12,
      kind: 'live',
      bitness: 64,
      ownerSid: USER_SID,
      directory: 'C:\\work\\repo',
      reason: null,
    },
    {
      pid: 16,
      kind: 'error',
      bitness: null,
      ownerSid: null,
      directory: null,
      reason: 'OpenProcess failed with Win32 error 31',
    },
  ],
};

function withRecords(records: unknown[], currentSid: unknown = USER_SID) {
  return JSON.stringify({ currentSid, records });
}

type ExecCall = {
  file: string;
  args: string[];
  options: Record<string, unknown>;
};

test('parser reads one record of each kind', () => {
  const parsed = parseWindowsProcessRecords(JSON.stringify(FAKE));
  assert.deepEqual(parsed, FAKE);
  assert.deepEqual(
    parsed.records.map((record) => record.kind),
    ['exited', 'denied', 'live', 'error'],
  );
  // A denied record may also have no readable owner, and a field the reader
  // does not know is ignored.
  const lenient = parseWindowsProcessRecords(
    withRecords([
      {
        pid: 9,
        kind: 'denied',
        bitness: null,
        ownerSid: null,
        directory: null,
        reason: null,
        extra: 'ignored',
      },
    ]),
  );
  assert.deepEqual(lenient.records, [
    {
      pid: 9,
      kind: 'denied',
      bitness: null,
      ownerSid: null,
      directory: null,
      reason: null,
    },
  ]);
  assert.equal(parseWindowsProcessRecords(withRecords([])).records.length, 0);
});

test('parser rejects malformed output', () => {
  const live = {
    pid: 12,
    kind: 'live',
    bitness: 64,
    ownerSid: USER_SID,
    directory: 'C:\\work',
    reason: null,
  };
  // Output that is not an object with `currentSid` and `records`.
  for (const text of [
    '',
    'not json',
    'null',
    '[]',
    '"text"',
    '{}',
    JSON.stringify({ currentSid: USER_SID }),
    JSON.stringify({ currentSid: USER_SID, records: {} }),
    JSON.stringify({ records: [] }),
    withRecords([], 'not-a-sid'),
    withRecords([], 42),
    withRecords([], 'S-1-5'),
  ]) {
    assert.throws(() => parseWindowsProcessRecords(text), `rejects ${text}`);
  }
  const rejected = (record: Record<string, unknown>) =>
    assert.throws(
      () => parseWindowsProcessRecords(withRecords([record])),
      JSON.stringify(record),
    );
  // A record that is not an object, or whose pid or kind is wrong.
  assert.throws(() => parseWindowsProcessRecords(withRecords([null])));
  assert.throws(() => parseWindowsProcessRecords(withRecords(['live'])));
  for (const pid of [0, -1, 1.5, '12', null, Number.NaN]) {
    rejected({ ...live, pid });
  }
  rejected({ ...live, pid: undefined });
  rejected({ ...live, kind: 'unknown' });
  rejected({ ...live, kind: 'LIVE' });
  rejected({ ...live, kind: undefined });
  // A live record needs a bitness of 32 or 64.
  rejected({ ...live, bitness: null });
  rejected({ ...live, bitness: 16 });
  rejected({ ...live, bitness: '64' });
  // A 64-bit live record needs a directory.
  rejected({ ...live, directory: null });
  rejected({ ...live, directory: '' });
  rejected({ ...live, directory: 7 });
  // A 32-bit live record has no directory, and one that has a directory is
  // rejected.
  rejected({ ...live, bitness: 32 });
  rejected({ ...live, bitness: 32, directory: '' });
  // An error record needs a reason, and no other kind may carry one.
  const error = {
    pid: 16,
    kind: 'error',
    bitness: null,
    ownerSid: null,
    directory: null,
    reason: 'broken',
  };
  rejected({ ...error, reason: null });
  rejected({ ...error, reason: '' });
  rejected({ ...error, reason: 5 });
  rejected({ ...live, reason: 'why' });
  rejected({
    pid: 4,
    kind: 'exited',
    bitness: null,
    ownerSid: null,
    directory: null,
    reason: 'why',
  });
  rejected({
    pid: 4,
    kind: 'denied',
    bitness: null,
    ownerSid: null,
    directory: null,
    reason: 'why',
  });
  // An exited or denied record has no bitness and no directory.
  for (const kind of ['exited', 'denied']) {
    const base = {
      pid: 4,
      kind,
      bitness: null,
      ownerSid: null,
      directory: null,
      reason: null,
    };
    rejected({ ...base, bitness: 64 });
    rejected({ ...base, bitness: 32 });
    rejected({ ...base, directory: 'C:\\work' });
  }
  // An exited process has no owner either.
  rejected({
    pid: 4,
    kind: 'exited',
    bitness: null,
    ownerSid: OTHER_SID,
    directory: null,
    reason: null,
  });
  // A malformed record fails the whole output, even beside a good one.
  assert.throws(() =>
    parseWindowsProcessRecords(withRecords([live, { ...live, pid: 0 }])),
  );
});

test('parser accepts a 32-bit live record without a directory', () => {
  const parsed = parseWindowsProcessRecords(
    withRecords([
      {
        pid: 20,
        kind: 'live',
        bitness: 32,
        ownerSid: OTHER_SID,
        directory: null,
        reason: null,
      },
    ]),
  );
  assert.deepEqual(parsed.records, [
    {
      pid: 20,
      kind: 'live',
      bitness: 32,
      ownerSid: OTHER_SID,
      directory: null,
      reason: null,
    },
  ]);
  assert.equal(parsed.records[0]?.bitness, 32);
  assert.equal(parsed.records[0]?.directory, null);
});

test('reader throws when the whole call fails', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  assert.throws(
    () =>
      readWindowsProcessRecords({
        env,
        execFile: (() => {
          throw new Error('powershell.exe exited with status 1');
        }) as never,
      }),
    /status 1/,
  );
  // A timeout reaches the caller the same way.
  assert.throws(
    () =>
      readWindowsProcessRecords({
        env,
        execFile: (() => {
          throw Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), {
            code: 'ETIMEDOUT',
          });
        }) as never,
      }),
    /ETIMEDOUT/,
  );
});

test('reader throws for output that is not the object', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  for (const text of [
    '',
    'Add-Type : error',
    '[]',
    JSON.stringify({ currentSid: USER_SID, records: 'none' }),
    JSON.stringify({ currentSid: 'nobody', records: [] }),
    withRecords([{ pid: 1, kind: 'live', bitness: 64, directory: null }]),
  ]) {
    assert.throws(
      () => readWindowsProcessRecords({ env, execFile: (() => text) as never }),
      `rejects ${JSON.stringify(text)}`,
    );
  }
});

test('reader calls the exec once and returns its records', () => {
  const calls: ExecCall[] = [];
  const result = readWindowsProcessRecords({
    env: { SystemRoot: 'C:\\Windows', PATH: 'x' },
    execFile: ((
      file: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ file, args, options });
      return JSON.stringify(FAKE);
    }) as never,
  });
  assert.deepEqual(result, FAKE);
  assert.equal(result.currentSid, USER_SID);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  // The absolute System32 PowerShell, never a bare name.
  assert.ok(
    /[\\/]Windows[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/.test(
      call.file,
    ),
  );
  assert.deepEqual(call.args.slice(0, 4), [
    '-NoProfile',
    '-NonInteractive',
    '-NoLogo',
    '-Command',
  ]);
  assert.equal(call.args.length, 5);
  const script = call.args[4] as string;
  // One constant program: it names the native calls the issue specifies.
  for (const name of [
    'Get-Process',
    'IsWow64Process2',
    'OpenProcessToken',
    'NtQueryInformationProcess',
    'ReadProcessMemory',
    'ConvertTo-Json -InputObject',
  ]) {
    assert.ok(script.includes(name), `the script uses ${name}`);
  }
  assert.equal(call.options.timeout, 30_000);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.encoding, 'utf8');
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('reader ignores a relative SystemRoot so the tool is always absolute', () => {
  const files: string[] = [];
  readWindowsProcessRecords({
    env: { SystemRoot: 'evil', windir: '' },
    execFile: ((file: string) => {
      files.push(file);
      return withRecords([]);
    }) as never,
  });
  assert.equal(files.length, 1);
  for (const file of files) {
    assert.ok(/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('/'), file);
    assert.ok(!file.startsWith('evil'), file);
  }
});

const REAL = { skip: process.platform !== 'win32' };

/**
 * End a child and everything it started, by process id and never by name, then
 * wait for it to exit so its directory can be removed.
 */
async function endChild(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null) {
    try {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // The process may already be gone; kill() below is the fallback.
    }
  }
  child.kill();
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
    ]);
  }
}

function removeRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A leftover temporary directory must not fail the test.
  }
}

test('real reader sees a child process of the current user', REAL, async () => {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'idd-process-cwd-')),
  );
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await once(child, 'spawn');
    const { currentSid, records } = readWindowsProcessRecords();
    const record = records.find((entry) => entry.pid === child.pid);
    assert.ok(record, `a record for pid ${child.pid}`);
    assert.equal(record.kind, 'live');
    assert.equal(record.directory, root);
    assert.equal(record.ownerSid, currentSid);
    assert.equal(record.bitness, 64);
    assert.equal(record.reason, null);
  } finally {
    await endChild(child);
    removeRoot(root);
  }
});

test('real reader sees a 32-bit child process', REAL, async () => {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'idd-process-cwd-')),
  );
  const cmd = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'SysWOW64',
    'cmd.exe',
  );
  const child = spawn(cmd, ['/d', '/c', 'ping', '-n', '60', '127.0.0.1'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await once(child, 'spawn');
    const { records } = readWindowsProcessRecords();
    const record = records.find((entry) => entry.pid === child.pid);
    assert.ok(record, `a record for pid ${child.pid}`);
    assert.equal(record.kind, 'live');
    assert.equal(record.bitness, 32);
    assert.equal(record.directory, null);
  } finally {
    await endChild(child);
    removeRoot(root);
  }
});
