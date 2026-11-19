// Absolute-path acceptance for user-global receipts (#5288).
// parseEntry now uses isQualifiedConfigRoot so win32 drive-letter and UNC
// roots parse the same way join() records them.

import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FsOps } from '../src/scripts/user-global-paths.mts';
import { readReceipt } from '../src/scripts/user-global-receipt.mts';

const SHA256 =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** Real node:fs with injectable no-follow flags so Windows can exercise reads. */
function fsWithFlags(): FsOps {
  return {
    ...nodeFs,
    constants: {
      ...nodeFs.constants,
      O_NOFOLLOW: nodeFs.constants.O_NOFOLLOW ?? 0,
      O_NONBLOCK: nodeFs.constants.O_NONBLOCK ?? 0,
    },
  } as unknown as FsOps;
}

function withDataRoot(run: (dataRoot: string) => void): void {
  const dataRoot = nodeFs.mkdtempSync(join(tmpdir(), 'user-global-receipt-'));
  try {
    run(dataRoot);
  } finally {
    nodeFs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

function writeReceiptFile(
  dataRoot: string,
  entries: Record<string, unknown>[],
): void {
  nodeFs.writeFileSync(
    join(dataRoot, 'receipt.json'),
    `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
  );
}

test('a drive-letter entry path parses on win32 (#5288)', {
  skip: process.platform !== 'win32',
}, () => {
  withDataRoot((dataRoot) => {
    const entryPath = join(dataRoot, 'payload.txt');
    writeReceiptFile(dataRoot, [
      { kind: 'file', path: entryPath, sha256: SHA256 },
    ]);
    const result = readReceipt(dataRoot, fsWithFlags());
    assert.equal(result.state, 'valid');
    assert.equal(result.receipt?.entries[0]?.path, entryPath);
  });
});

test('a UNC entry path parses on win32 (#5288)', {
  skip: process.platform !== 'win32',
}, () => {
  withDataRoot((dataRoot) => {
    // UNC shape for the absolute-path rule only; the receipt file itself
    // still lives under the local dataRoot so checkContainment can read it.
    const uncEntry = '\\\\server\\share\\payload.txt';
    writeReceiptFile(dataRoot, [
      { kind: 'file', path: uncEntry, sha256: SHA256 },
    ]);
    const result = readReceipt(dataRoot, fsWithFlags());
    assert.equal(result.state, 'valid');
    assert.equal(result.receipt?.entries[0]?.path, uncEntry);
  });
});

test('a drive-letter current link target parses on win32 (#5288)', {
  skip: process.platform !== 'win32',
}, () => {
  withDataRoot((dataRoot) => {
    const linkPath = join(dataRoot, 'current');
    const target = join(dataRoot, '1.2.3');
    writeReceiptFile(dataRoot, [{ kind: 'link', path: linkPath, target }]);
    const result = readReceipt(dataRoot, fsWithFlags());
    assert.equal(result.state, 'valid');
    assert.deepEqual(result.receipt?.entries[0], {
      kind: 'link',
      path: linkPath,
      target,
    });
  });
});

test('a leading-slash entry path parses on POSIX (#5288)', {
  skip: process.platform === 'win32',
}, () => {
  withDataRoot((dataRoot) => {
    const entryPath = join(dataRoot, 'payload.txt');
    writeReceiptFile(dataRoot, [
      { kind: 'file', path: entryPath, sha256: SHA256 },
    ]);
    const result = readReceipt(dataRoot, fsWithFlags());
    assert.equal(result.state, 'valid');
    assert.equal(result.receipt?.entries[0]?.path, entryPath);
  });
});

test('a relative entry path makes the receipt corrupt (#5288)', () => {
  withDataRoot((dataRoot) => {
    writeReceiptFile(dataRoot, [
      { kind: 'file', path: 'relative/payload.txt', sha256: SHA256 },
    ]);
    assert.throws(
      () => readReceipt(dataRoot, fsWithFlags()),
      /corrupt.*not absolute/,
    );
  });
});

test('a Windows current-drive root entry path makes the receipt corrupt (#5288)', () => {
  withDataRoot((dataRoot) => {
    writeReceiptFile(dataRoot, [
      { kind: 'file', path: '\\config', sha256: SHA256 },
    ]);
    assert.throws(
      () => readReceipt(dataRoot, fsWithFlags()),
      /corrupt.*not absolute/,
    );
  });
});

test('a POSIX // entry path makes the receipt corrupt (#5288)', () => {
  withDataRoot((dataRoot) => {
    writeReceiptFile(dataRoot, [
      { kind: 'file', path: '//evil/payload', sha256: SHA256 },
    ]);
    assert.throws(
      () => readReceipt(dataRoot, fsWithFlags()),
      /corrupt.*not absolute/,
    );
  });
});

test('a relative link target makes the receipt corrupt (#5288)', () => {
  withDataRoot((dataRoot) => {
    writeReceiptFile(dataRoot, [
      {
        kind: 'link',
        path: join(dataRoot, 'current'),
        target: '1.2.3',
      },
    ]);
    assert.throws(
      () => readReceipt(dataRoot, fsWithFlags()),
      /corrupt.*no absolute target/,
    );
  });
});

test("a link that is not the installer's current link is corrupt (#5288)", () => {
  withDataRoot((dataRoot) => {
    writeReceiptFile(dataRoot, [
      {
        kind: 'link',
        path: join(dataRoot, 'other'),
        target: join(dataRoot, '1.2.3'),
      },
    ]);
    assert.throws(
      () => readReceipt(dataRoot, fsWithFlags()),
      /corrupt.*not the installer's current link/,
    );
  });
});

test('an unknown entry kind makes the receipt corrupt (#5288)', () => {
  withDataRoot((dataRoot) => {
    writeReceiptFile(dataRoot, [{ kind: 'socket', path: join(dataRoot, 'x') }]);
    assert.throws(
      () => readReceipt(dataRoot, fsWithFlags()),
      /corrupt.*unknown kind/,
    );
  });
});
