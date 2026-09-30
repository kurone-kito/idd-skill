import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';

import {
  decodeIcaclsSave,
  evaluateWindowsAcl,
  parseIcaclsSave,
  readWindowsAcl,
} from '../src/scripts/windows-acl.mts';

const USER_SID = 'S-1-5-21-1000000001-2000000002-3000000003-1001';

function fixture(name: string): Buffer {
  return readFileSync(
    new URL(`./fixtures/windows-acl/${name}.sddl`, import.meta.url),
  );
}

function parsedFixture(name: string) {
  return parseIcaclsSave(decodeIcaclsSave(fixture(name)));
}

test('windows acl parser: decodes UTF-16LE with and without a BOM, and UTF-8', () => {
  const text = 'dir\r\nD:PAI(A;;FA;;;SY)\r\n';
  const bare = Buffer.from(text, 'utf16le');
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), bare]);
  assert.equal(decodeIcaclsSave(bare), text);
  assert.equal(decodeIcaclsSave(withBom), text);
  assert.equal(decodeIcaclsSave(Buffer.from(text, 'utf8')), text);
  // The real `icacls /save` output carries no BOM.
  assert.equal(fixture('private-user-only')[0], 0x43);
  assert.equal(fixture('private-user-only')[1], 0x00);
});

test('windows acl parser: a real user-only directory is private for that user', () => {
  const parsed = parsedFixture('private-user-only');
  assert.deepEqual(parsed, {
    kind: 'entries',
    entries: [{ sid: USER_SID, allow: true }],
  });
  assert.equal(
    evaluateWindowsAcl({ ...parsed, currentSid: USER_SID }),
    'private',
  );
  // Another account is a different principal, and so is an absent current SID.
  assert.equal(
    evaluateWindowsAcl({ ...parsed, currentSid: 'S-1-5-21-9-9-9-1002' }),
    'permissive',
  );
  assert.equal(evaluateWindowsAcl(parsed), 'permissive');
});

test('windows acl parser: Everyone and Users grants make a real directory permissive', () => {
  for (const name of ['everyone-read', 'users-read']) {
    const parsed = parsedFixture(name);
    assert.equal(parsed.kind, 'entries');
    assert.equal(
      evaluateWindowsAcl({ ...parsed, currentSid: USER_SID }),
      'permissive',
      name,
    );
  }
  const everyone = parsedFixture('everyone-read');
  assert.ok(
    everyone.kind === 'entries' &&
      everyone.entries.some((entry) => entry.sid === 'S-1-1-0'),
  );
  const users = parsedFixture('users-read');
  assert.ok(
    users.kind === 'entries' &&
      users.entries.some((entry) => entry.sid === 'S-1-5-32-545'),
  );
});

test('windows acl parser: an inherited profile ACL with extra principals is permissive', () => {
  const parsed = parsedFixture('inherited');
  assert.equal(parsed.kind, 'entries');
  if (parsed.kind !== 'entries') return;
  // SYSTEM and Administrators aliases were expanded to their SIDs.
  const sids = parsed.entries.map((entry) => entry.sid);
  assert.ok(sids.includes('S-1-5-18'));
  assert.ok(sids.includes('S-1-5-32-544'));
  // Inherit-only ACEs are read too: they propagate to the cache files.
  assert.ok(sids.some((sid) => sid.startsWith('S-1-15-3-')));
  assert.equal(
    evaluateWindowsAcl({ ...parsed, currentSid: USER_SID }),
    'permissive',
  );
});

test('windows acl parser: only the DACL counts, and audit or label ACEs are not allows', () => {
  const parsed = parseIcaclsSave(
    'dir\r\nO:BAG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)S:(AU;SAFA;FA;;;WD)(ML;;NW;;;LW)\r\n',
  );
  assert.deepEqual(parsed, {
    kind: 'entries',
    entries: [
      { sid: 'S-1-5-18', allow: true },
      { sid: 'S-1-5-32-544', allow: true },
    ],
  });
  assert.equal(evaluateWindowsAcl(parsed), 'private');
});

test('windows acl parser: conditional ACEs nest parentheses and deny ACEs are ignored', () => {
  const parsed = parseIcaclsSave(
    'dir\r\nD:PAI(XA;;FA;;;SY;(@User.dept==1))(D;;FR;;;WD)(A;;FA;;;BA)\r\n',
  );
  assert.deepEqual(parsed, {
    kind: 'entries',
    entries: [
      { sid: 'S-1-5-18', allow: true },
      { sid: 'S-1-1-0', allow: false },
      { sid: 'S-1-5-32-544', allow: true },
    ],
  });
  assert.equal(evaluateWindowsAcl(parsed), 'private');
});

test('windows acl parser: a NULL or empty DACL, a foreign ACE type, or malformed text is unreadable', () => {
  const cases = [
    'dir\r\nD:NO_ACCESS_CONTROL\r\n',
    'dir\r\nD:PAI\r\n',
    'dir\r\nD:(AL;;FA;;;SY)\r\n',
    'dir\r\nD:(A;;FA;;;SY\r\n',
    'dir\r\nD:(A;;FA;;;)\r\n',
    'dir\r\nno sddl here\r\n',
    '',
  ];
  for (const text of cases) {
    assert.deepEqual(parseIcaclsSave(text), { kind: 'unreadable' }, text);
  }
});

test('windows acl rule: well-known and unknown principals other than the three permitted are permissive', () => {
  const allow = (sid: string) => ({
    kind: 'entries',
    entries: [{ sid, allow: true }],
    currentSid: USER_SID,
  });
  for (const sid of [
    'S-1-1-0',
    'S-1-5-32-545',
    'S-1-5-11',
    'S-1-3-0',
    'S-1-15-2-1',
    'S-1-5-21-9-9-9-9',
    'XX',
  ]) {
    assert.equal(evaluateWindowsAcl(allow(sid)), 'permissive', sid);
  }
  for (const sid of [
    'S-1-5-18',
    'S-1-5-32-544',
    USER_SID,
    USER_SID.toLowerCase(),
  ]) {
    assert.equal(evaluateWindowsAcl(allow(sid)), 'private', sid);
  }
});

test('windows acl rule: a result that is not well formed, or grants nothing, is unreadable', () => {
  const cases: unknown[] = [
    null,
    undefined,
    'entries',
    {},
    { kind: 'unreadable' },
    { kind: 'entries' },
    { kind: 'entries', entries: 'nope' },
    { kind: 'entries', entries: [] },
    { kind: 'entries', entries: [{ sid: 'S-1-5-18' }] },
    { kind: 'entries', entries: [{ sid: 5, allow: true }] },
    { kind: 'entries', entries: [{ sid: ' ', allow: true }] },
    // Only deny entries: nobody is granted anything, which cannot be shown private.
    { kind: 'entries', entries: [{ sid: 'S-1-1-0', allow: false }] },
  ];
  for (const result of cases) {
    assert.equal(evaluateWindowsAcl(result), 'unreadable', String(result));
  }
});

interface ExecCall {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

function fakeExec(sddl: string, calls: ExecCall[]) {
  return (file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    if (file.endsWith('whoami.exe')) {
      return `"HOST\\user","${USER_SID}"\r\n`;
    }
    if (file.endsWith('icacls.exe')) {
      writeFileSync(args[2] as string, Buffer.from(sddl, 'utf16le'));
      return '';
    }
    throw new Error(`unexpected process ${file}`);
  };
}

test('windows acl reader: runs absolute system32 tools with argv arrays and returns the parsed ACL', () => {
  const calls: ExecCall[] = [];
  const result = readWindowsAcl('C:\\cache', {
    env: { SystemRoot: 'C:\\Windows' },
    execFile: fakeExec('dir\r\nD:PAI(A;;FA;;;SY)\r\n', calls) as never,
  });
  assert.deepEqual(result, {
    kind: 'entries',
    entries: [{ sid: 'S-1-5-18', allow: true }],
    currentSid: USER_SID,
  });
  const [whoami, icacls] = calls;
  assert.ok(
    /[\\/]Windows[\\/]System32[\\/]whoami\.exe$/.test(whoami?.file ?? ''),
  );
  assert.deepEqual(whoami?.args, ['/user', '/fo', 'csv', '/nh']);
  assert.ok(
    /[\\/]Windows[\\/]System32[\\/]icacls\.exe$/.test(icacls?.file ?? ''),
  );
  assert.equal(icacls?.args[0], 'C:\\cache');
  assert.equal(icacls?.args[1], '/save');
  assert.equal(icacls?.args[3], '/q');
  for (const call of calls) {
    assert.equal(call.options.windowsHide, true);
    assert.equal(typeof call.options.timeout, 'number');
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  }
  // The scratch file's directory is gone once the read returns.
  assert.equal(existsSync(dirname(icacls?.args[2] as string)), false);
});

test('windows acl reader: whoami runs once per process starter while icacls runs every read', () => {
  const calls: ExecCall[] = [];
  const exec = fakeExec('dir\r\nD:PAI(A;;FA;;;SY)\r\n', calls) as never;
  readWindowsAcl('C:\\a', {
    env: { SystemRoot: 'C:\\Windows' },
    execFile: exec,
  });
  readWindowsAcl('C:\\b', {
    env: { SystemRoot: 'C:\\Windows' },
    execFile: exec,
  });
  assert.equal(
    calls.filter((call) => call.file.endsWith('whoami.exe')).length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.file.endsWith('icacls.exe')).length,
    2,
  );
});

test('windows acl reader: a failing tool, unparseable output, or an unknown user is unreadable', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  // icacls exits non-zero.
  assert.deepEqual(
    readWindowsAcl('C:\\c', {
      env,
      execFile: ((file: string) => {
        if (file.endsWith('whoami.exe')) return `"H\\u","${USER_SID}"\r\n`;
        throw new Error('exit 5');
      }) as never,
    }),
    { kind: 'unreadable' },
  );
  // icacls exits zero but writes nothing usable (the /q summary lies).
  assert.deepEqual(
    readWindowsAcl('C:\\c', {
      env,
      execFile: fakeExec('dir\r\nno sddl\r\n', []) as never,
    }),
    { kind: 'unreadable' },
  );
  // whoami output has no SID.
  assert.deepEqual(
    readWindowsAcl('C:\\c', {
      env,
      execFile: (() => 'garbage') as never,
    }),
    { kind: 'unreadable' },
  );
  // whoami itself fails.
  assert.deepEqual(
    readWindowsAcl('C:\\c', {
      env,
      execFile: (() => {
        throw new Error('no whoami');
      }) as never,
    }),
    { kind: 'unreadable' },
  );
});

test('windows acl parser: UTF-16LE is detected even when the directory name is outside Latin-1', () => {
  // The first code unit's high byte is not NUL for a Japanese or Cyrillic name.
  for (const name of ['日本語 cache', 'Кэш', 'キャッシュ']) {
    const text = `C:\\Users\\x\\${name}\r\nD:PAI(A;OICI;FA;;;SY)\r\n`;
    const bytes = Buffer.from(text, 'utf16le');
    assert.equal(decodeIcaclsSave(bytes), text, name);
    assert.deepEqual(parseIcaclsSave(decodeIcaclsSave(bytes)), {
      kind: 'entries',
      entries: [{ sid: 'S-1-5-18', allow: true }],
    });
    // A name that starts with the non-Latin character itself.
    const leading = Buffer.from(
      `${name}\r\nD:PAI(A;OICI;FA;;;SY)\r\n`,
      'utf16le',
    );
    assert.equal(
      parseIcaclsSave(decodeIcaclsSave(leading)).kind,
      'entries',
      name,
    );
  }
});

test('windows acl parser: the name line is never read as SDDL, and a file without an SDDL line is unreadable', () => {
  // A drive-root style name that looks like the start of a DACL.
  assert.deepEqual(parseIcaclsSave('D:\\cache\r\nD:PAI(A;OICI;FA;;;SY)\r\n'), {
    kind: 'entries',
    entries: [{ sid: 'S-1-5-18', allow: true }],
  });
  // A crafted name must not stand in for the ACL when icacls wrote none.
  assert.deepEqual(parseIcaclsSave('D:\\c(A;;FA;;;SY)\r\n'), {
    kind: 'unreadable',
  });
  assert.deepEqual(
    parseIcaclsSave('D:\\c(A;;FA;;;SY)\r\nD:PAI(A;;FR;;;WD)\r\n'),
    { kind: 'entries', entries: [{ sid: 'S-1-1-0', allow: true }] },
  );
});

test('windows acl parser: LA and LG resolve against the current account domain only', () => {
  const text = 'dir\r\nD:PAI(A;OICI;FA;;;LA)(A;;FR;;;LG)\r\n';
  const domain = 'S-1-5-21-1000000001-2000000002-3000000003';
  const withDomain = parseIcaclsSave(text, {
    LA: `${domain}-500`,
    LG: `${domain}-501`,
  });
  assert.deepEqual(withDomain, {
    kind: 'entries',
    entries: [
      { sid: `${domain}-500`, allow: true },
      { sid: `${domain}-501`, allow: true },
    ],
  });
  // Guest is another principal, so this is permissive even for RID 500.
  assert.equal(
    evaluateWindowsAcl({ ...withDomain, currentSid: `${domain}-500` }),
    'permissive',
  );
  // Without the aliases they are unknown principals, permissive.
  const bare = parseIcaclsSave(text);
  assert.equal(bare.kind, 'entries');
  assert.equal(
    evaluateWindowsAcl({ ...bare, currentSid: `${domain}-500` }),
    'permissive',
  );
});

test('windows acl reader: the built-in Administrator running the process owns its own directory', () => {
  const domain = 'S-1-5-21-1000000001-2000000002-3000000003';
  const admin = `${domain}-500`;
  const exec = ((file: string, args: string[]) => {
    if (file.endsWith('whoami.exe')) return `"H\\Administrator","${admin}"\r\n`;
    writeFileSync(
      args[2] as string,
      Buffer.from('dir\r\nD:PAI(A;OICI;FA;;;LA)\r\n', 'utf16le'),
    );
    return '';
  }) as never;
  const result = readWindowsAcl('C:\\cache', {
    env: { SystemRoot: 'C:\\Windows' },
    execFile: exec,
  });
  assert.equal(evaluateWindowsAcl(result), 'private');
});

test('windows acl reader: a relative SystemRoot is ignored so the tools are always absolute', () => {
  const calls: string[] = [];
  const exec = ((file: string, args: string[]) => {
    calls.push(file);
    if (file.endsWith('whoami.exe')) return `"H\\u","${USER_SID}"\r\n`;
    writeFileSync(
      args[2] as string,
      Buffer.from('dir\r\nD:PAI(A;;FA;;;SY)\r\n', 'utf16le'),
    );
    return '';
  }) as never;
  readWindowsAcl('C:\\cache', {
    env: { SystemRoot: 'evil', windir: '' },
    execFile: exec,
  });
  assert.ok(calls.length > 0);
  for (const file of calls) {
    assert.ok(/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('/'), file);
    assert.ok(!file.startsWith('evil'), file);
  }
});
