import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildEvent,
  resolveOutPath,
  writeEvent,
} from '../src/scripts/token-cost-event.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/token-cost-event.mjs');
const NOW = new Date('2026-09-01T12:00:00.000Z');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'idd-token-cost-event-test-'));
}

// Stripped from the spawned child's inherited env by default so a CLI
// test's assertions stay deterministic regardless of whether the real
// host process (this very test run included) happens to have
// CLAUDE_CODE_SESSION_ID set. A test exercising the stamping behavior
// itself passes it back in via runCli's own envOverrides.
function stripVendorSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_SESSION_ID: _omit, ...rest } = env;
  return rest;
}

function runCli(
  args: readonly string[],
  envOverrides: NodeJS.ProcessEnv = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...stripVendorSessionEnv(process.env), ...envOverrides },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// ---------------------------------------------------------------------------
// resolveOutPath
// ---------------------------------------------------------------------------

test('resolveOutPath prefers an explicit --out', () => {
  assert.equal(
    resolveOutPath('/explicit/path/events.jsonl', {}),
    '/explicit/path/events.jsonl',
  );
});

test('resolveOutPath falls back to XDG_STATE_HOME', () => {
  assert.equal(
    resolveOutPath(undefined, { XDG_STATE_HOME: '/xdg-state' }),
    join('/xdg-state', 'idd-skill', 'token-cost', 'events.jsonl'),
  );
});

test('resolveOutPath falls back to $HOME/.local/state when XDG_STATE_HOME is unset', () => {
  const out = resolveOutPath(undefined, { HOME: '/home/example' });
  assert.equal(
    out,
    join(
      '/home/example',
      '.local',
      'state',
      'idd-skill',
      'token-cost',
      'events.jsonl',
    ),
  );
});

// ---------------------------------------------------------------------------
// buildEvent
// ---------------------------------------------------------------------------

test('buildEvent builds a schema-shaped enter event', () => {
  const event = buildEvent(
    { stage: 'discover', enter: true, exit: false, vendor: 'claude' },
    NOW,
    {},
  );
  assert.deepEqual(event, {
    schemaVersion: 1,
    event: 'enter',
    stageId: 'discover',
    at: NOW.toISOString(),
    vendor: 'claude',
  });
});

test('buildEvent builds a schema-shaped exit event with an issue number', () => {
  const event = buildEvent(
    { stage: 'work', enter: false, exit: true, vendor: 'codex', issue: '2293' },
    NOW,
    {},
  );
  assert.deepEqual(event, {
    schemaVersion: 1,
    event: 'exit',
    stageId: 'work',
    at: NOW.toISOString(),
    vendor: 'codex',
    issueNumber: 2293,
  });
});

test('buildEvent throws when neither --enter nor --exit is given', () => {
  assert.throws(
    () => buildEvent({ stage: 'discover', vendor: 'claude' }, NOW),
    /exactly one of --enter or --exit is required/,
  );
});

test('buildEvent throws when both --enter and --exit are given', () => {
  assert.throws(
    () =>
      buildEvent(
        { stage: 'discover', enter: true, exit: true, vendor: 'claude' },
        NOW,
      ),
    /exactly one of --enter or --exit is required/,
  );
});

test('buildEvent throws when --stage is missing', () => {
  assert.throws(
    () => buildEvent({ enter: true, vendor: 'claude' }, NOW),
    /--stage is required/,
  );
});

test('buildEvent throws when --vendor is missing', () => {
  assert.throws(
    () => buildEvent({ stage: 'discover', enter: true }, NOW),
    /--vendor is required/,
  );
});

test('buildEvent throws on a non-integer --issue', () => {
  assert.throws(
    () =>
      buildEvent(
        { stage: 'discover', enter: true, vendor: 'claude', issue: 'abc' },
        NOW,
      ),
    /--issue must be a positive integer/,
  );
});

test('buildEvent throws on a non-positive --issue', () => {
  assert.throws(
    () =>
      buildEvent(
        { stage: 'discover', enter: true, vendor: 'claude', issue: '0' },
        NOW,
      ),
    /--issue must be a positive integer/,
  );
});

// ---------------------------------------------------------------------------
// buildEvent -- vendorSessionId auto-derive (#2424)
// ---------------------------------------------------------------------------

test('buildEvent stamps vendorSessionId from CLAUDE_CODE_SESSION_ID for vendor claude', () => {
  const event = buildEvent(
    { stage: 'work', enter: true, vendor: 'claude' },
    NOW,
    { CLAUDE_CODE_SESSION_ID: 'sess-abc123' },
  );
  assert.equal(event.vendorSessionId, 'sess-abc123');
});

test('buildEvent leaves vendorSessionId unset for vendor claude when CLAUDE_CODE_SESSION_ID is unset', () => {
  const event = buildEvent(
    { stage: 'work', enter: true, vendor: 'claude' },
    NOW,
    {},
  );
  assert.equal('vendorSessionId' in event, false);
});

test('buildEvent leaves vendorSessionId unset for a vendor with no known session env var', () => {
  const event = buildEvent(
    { stage: 'work', enter: true, vendor: 'grok' },
    NOW,
    { CLAUDE_CODE_SESSION_ID: 'sess-abc123' },
  );
  assert.equal('vendorSessionId' in event, false);
});

test('buildEvent rejects a path-like CLAUDE_CODE_SESSION_ID value rather than stamping it', () => {
  const event = buildEvent(
    { stage: 'work', enter: true, vendor: 'claude' },
    NOW,
    { CLAUDE_CODE_SESSION_ID: '/etc/passwd' },
  );
  assert.equal('vendorSessionId' in event, false);
});

// ---------------------------------------------------------------------------
// writeEvent
// ---------------------------------------------------------------------------

test('writeEvent appends one schema-valid JSONL line, creating the parent directory', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'nested', 'events.jsonl');
    const event = buildEvent(
      { stage: 'claim', enter: true, vendor: 'grok' },
      NOW,
      {},
    );
    writeEvent(event, outPath);
    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), event);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeEvent appends without truncating an existing file', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    writeEvent(
      buildEvent({ stage: 'claim', enter: true, vendor: 'grok' }, NOW, {}),
      outPath,
    );
    writeEvent(
      buildEvent({ stage: 'claim', exit: true, vendor: 'grok' }, NOW, {}),
      outPath,
    );
    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeEvent throws for a stageId the schema does not enumerate', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    const event = buildEvent(
      { stage: 'bogus-stage', enter: true, vendor: 'claude' },
      NOW,
      {},
    );
    assert.throws(() => writeEvent(event, outPath), /fails schema validation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeEvent throws for a vendor the schema does not enumerate', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    const event = buildEvent(
      { stage: 'discover', enter: true, vendor: 'bogus-vendor' },
      NOW,
      {},
    );
    assert.throws(() => writeEvent(event, outPath), /fails schema validation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI (spawns the compiled scripts/token-cost-event.mjs)
// ---------------------------------------------------------------------------

test('CLI --strict writes a schema-valid JSONL line for a legal --stage/--enter pair', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    const result = runCli([
      '--stage',
      'discover',
      '--enter',
      '--vendor',
      'claude',
      '--issue',
      '2293',
      '--out',
      outPath,
      '--now',
      NOW.toISOString(),
      '--strict',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      schemaVersion: 1,
      event: 'enter',
      stageId: 'discover',
      at: NOW.toISOString(),
      vendor: 'claude',
      issueNumber: 2293,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --strict rejects an unknown --stage and writes nothing', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    const result = runCli([
      '--stage',
      'bogus-stage',
      '--enter',
      '--vendor',
      'claude',
      '--out',
      outPath,
      '--strict',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fails schema validation/);
    assert.throws(() => readFileSync(outPath, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI default (non-strict) mode exits 0 with a warning when --out is on a read-only path', () => {
  const dir = tempDir();
  try {
    const readonlyDir = join(dir, 'readonly');
    mkdirSync(readonlyDir);
    chmodSync(readonlyDir, 0o500);
    const outPath = join(readonlyDir, 'nested', 'events.jsonl');
    const result = runCli([
      '--stage',
      'discover',
      '--enter',
      '--vendor',
      'claude',
      '--out',
      outPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /token-cost-event: warning:/);
  } finally {
    chmodSync(join(dir, 'readonly'), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI default (non-strict) mode exits 0 with a warning on a malformed invocation (missing --stage)', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    const result = runCli(['--enter', '--vendor', 'claude', '--out', outPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /token-cost-event: warning: --stage is required/,
    );
    assert.throws(() => readFileSync(outPath, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --strict mode exits non-zero on the same malformed invocation (missing --stage)', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    const result = runCli([
      '--enter',
      '--vendor',
      'claude',
      '--out',
      outPath,
      '--strict',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--stage is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --help exits 0 and prints usage without touching --out', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--stage <id>/);
});

test('CLI --claim-id is accepted but not persisted in the written event', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    const result = runCli([
      '--stage',
      'work',
      '--exit',
      '--vendor',
      'grok',
      '--claim-id',
      'abc123',
      '--out',
      outPath,
      '--now',
      NOW.toISOString(),
      '--strict',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(readFileSync(outPath, 'utf8').trim());
    assert.equal('claimId' in written, false);
    assert.equal('claim-id' in written, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI stamps vendorSessionId from an inherited CLAUDE_CODE_SESSION_ID for --vendor claude', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    const result = runCli(
      [
        '--stage',
        'work',
        '--enter',
        '--vendor',
        'claude',
        '--out',
        outPath,
        '--now',
        NOW.toISOString(),
        '--strict',
      ],
      { CLAUDE_CODE_SESSION_ID: 'sess-cli-test' },
    );
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(readFileSync(outPath, 'utf8').trim());
    assert.equal(written.vendorSessionId, 'sess-cli-test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI omits vendorSessionId by default (no CLAUDE_CODE_SESSION_ID inherited)', () => {
  const dir = tempDir();
  try {
    const outPath = join(dir, 'events.jsonl');
    const result = runCli([
      '--stage',
      'work',
      '--enter',
      '--vendor',
      'claude',
      '--out',
      outPath,
      '--now',
      NOW.toISOString(),
      '--strict',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(readFileSync(outPath, 'utf8').trim());
    assert.equal('vendorSessionId' in written, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
