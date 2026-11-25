import assert from 'node:assert/strict';
import {
  execFileSync,
  type SpawnOptions,
  spawn,
  spawnSync,
} from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  buildCritiqueTelemetryHookPayload,
  buildCritiqueTelemetryHookReport,
  type CritiqueTelemetryHookPayload,
  invokeCritiqueTelemetryHook,
  WIN32_PROCESS_LIST_COMMAND,
  watchdogEnvironment,
} from '../src/scripts/idd-critique-telemetry-hook.mts';
import { trackTempDirectories } from './temp-fixtures.mts';
import { stubExecutable } from './test-utils.mts';

// #4049: every fixture directory below is removed when the file finishes.
const makeTempDir = trackTempDirectories();

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/idd-critique-telemetry-hook.mjs');

/** Run the built CLI with a fully isolated HOME, mirroring
 * idd-critique-delegate.test.mts's runCli helper exactly (same isolation
 * rationale: never leak the real operator's user-global config, and
 * neutralize an inherited GITHUB_ACTIONS=true from the CI runner's own
 * environment). */
function runCli(
  args: string[],
  env?: NodeJS.ProcessEnv,
  input?: string,
): { stdout: string; status: number } {
  const isolatedHome = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-home-'),
  );
  const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    input: input ?? '',
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      ...env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: '',
    },
  });
  return { stdout, status: 0 };
}

// buildCritiqueTelemetryHookReport: every layer combination
// resolveEffectiveCritiqueLoopTelemetryHook already covers (#2679's
// acceptance criteria), verified against the same fixtures
// policy-helpers.test.mts and idd-config.test.mts already use for the
// underlying resolver. Mirrors idd-critique-delegate.test.mts's coverage
// style for buildCritiqueDelegateReport.

test('reports usable:true, source repository-local for a configured local hook', () => {
  const report = buildCritiqueTelemetryHookReport({
    localConfig: {
      critiqueLoop: { telemetryHook: { command: 'local-notify' } },
    },
  });
  assert.deepEqual(report, {
    usable: true,
    source: 'repository-local',
    command: 'local-notify',
    reason: null,
  });
});

test('reports usable:false, reason repository-local-explicit-disable for a null local hook', () => {
  const report = buildCritiqueTelemetryHookReport({
    localConfig: { critiqueLoop: { telemetryHook: null } },
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'repository-local',
    command: null,
    reason: 'repository-local-explicit-disable',
  });
});

test('a malformed repository-local hook fails closed and never inherits a configured global hook', () => {
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-malformed-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'global-notify' } },
    }),
  );
  const report = buildCritiqueTelemetryHookReport({
    localConfig: {
      critiqueLoop: { telemetryHook: { command: 'x', bogus: 1 } },
    },
    globalConfigPath: globalPath,
    env: {},
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'repository-local',
    command: null,
    reason: 'invalid-repository-local-telemetry-hook',
  });
});

test('falls back to a configured user-global hook only when local is entirely absent', () => {
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-global-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'global-notify' } },
    }),
  );
  const report = buildCritiqueTelemetryHookReport({
    localConfig: {},
    globalConfigPath: globalPath,
    env: {},
  });
  assert.deepEqual(report, {
    usable: true,
    source: 'user-global',
    command: 'global-notify',
    reason: null,
  });
});

test('consults an $HOME-resolved user-global hook outside GITHUB_ACTIONS', () => {
  const home = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-remote-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'home-notify' } },
    }),
  );
  const report = buildCritiqueTelemetryHookReport({
    localConfig: {},
    env: { HOME: home },
  });
  assert.deepEqual(report, {
    usable: true,
    source: 'user-global',
    command: 'home-notify',
    reason: null,
  });
});

test('skips the $HOME-resolved user-global hook under GITHUB_ACTIONS=true', () => {
  const home = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-remote-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'home-notify' } },
    }),
  );
  const report = buildCritiqueTelemetryHookReport({
    localConfig: {},
    env: { HOME: home, GITHUB_ACTIONS: 'true' },
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'none',
    command: null,
    reason: 'not-configured',
  });
});

test('skips the $HOME-resolved user-global hook when noUserGlobal is passed explicitly, outside GITHUB_ACTIONS', () => {
  const home = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-remote-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'home-notify' } },
    }),
  );
  const report = buildCritiqueTelemetryHookReport(
    { localConfig: {}, env: { HOME: home } },
    true,
  );
  assert.deepEqual(report, {
    usable: false,
    source: 'none',
    command: null,
    reason: 'not-configured',
  });
});

test('reports usable:false, reason not-configured when neither layer has a hook', () => {
  const report = buildCritiqueTelemetryHookReport({
    localConfig: {},
    env: {},
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'none',
    command: null,
    reason: 'not-configured',
  });
});

test('CLI --help exits 0 and does not require config resolution', () => {
  const output = execFileSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(output, /Usage:/);
});

test('CLI --policy resolves an absent local config to usable:false with an isolated HOME', () => {
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(policyPath, JSON.stringify({}));
  const { stdout } = runCli(['--policy', policyPath]);
  const report = JSON.parse(stdout) as {
    usable: boolean;
    source: string;
    reason: string | null;
  };
  assert.equal(report.usable, false);
  assert.equal(report.source, 'none');
  assert.equal(report.reason, 'not-configured');
});

test('CLI --policy resolves a configured local hook to usable:true', () => {
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-local-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'cli-notify' } },
    }),
  );
  const { stdout } = runCli(['--policy', policyPath]);
  assert.deepEqual(JSON.parse(stdout), {
    usable: true,
    source: 'repository-local',
    command: 'cli-notify',
    reason: null,
  });
});

// --- buildCritiqueTelemetryHookPayload: the exact JSON shape (#2679) -----

const FIXED_TIMESTAMP = '2026-09-08T12:00:00.000Z';

test('buildCritiqueTelemetryHookPayload builds the full documented shape', () => {
  const payload = buildCritiqueTelemetryHookPayload({
    round: 2,
    repo: 'owner/repo',
    issue: 123,
    pr: null,
    findingsCount: 3,
    severityBreakdown: { high: 1, medium: 1, low: 1 },
    acceptedCount: 2,
    rejectedCount: 1,
    delegateUsed: true,
    delegateCommand: 'coderabbit-critique',
    timestamp: FIXED_TIMESTAMP,
  });
  assert.deepEqual(payload, {
    phase: 'C',
    round: 2,
    repo: 'owner/repo',
    issue: 123,
    pr: null,
    findingsCount: 3,
    severityBreakdown: { high: 1, medium: 1, low: 1 },
    acceptedCount: 2,
    rejectedCount: 1,
    delegateUsed: true,
    delegateCommand: 'coderabbit-critique',
    timestamp: FIXED_TIMESTAMP,
  });
});

test('buildCritiqueTelemetryHookPayload defaults pr to null', () => {
  const payload = buildCritiqueTelemetryHookPayload({
    round: 1,
    repo: 'owner/repo',
    issue: 1,
    findingsCount: 0,
    severityBreakdown: { high: 0, medium: 0, low: 0 },
    acceptedCount: 0,
    rejectedCount: 0,
    delegateUsed: false,
    timestamp: FIXED_TIMESTAMP,
  });
  assert.equal(payload.pr, null);
});

test('buildCritiqueTelemetryHookPayload omits delegateCommand (not null) when delegateUsed is false', () => {
  const payload = buildCritiqueTelemetryHookPayload({
    round: 1,
    repo: 'owner/repo',
    issue: 1,
    findingsCount: 0,
    severityBreakdown: { high: 0, medium: 0, low: 0 },
    acceptedCount: 0,
    rejectedCount: 0,
    delegateUsed: false,
    // Deliberately supplied alongside delegateUsed: false -- must still be
    // dropped, not merely defaulted, matching "present only when
    // delegateUsed is true" from the issue's payload contract.
    delegateCommand: 'must-not-appear',
    timestamp: FIXED_TIMESTAMP,
  });
  assert.equal(Object.hasOwn(payload, 'delegateCommand'), false);
});

test('buildCritiqueTelemetryHookPayload includes delegateCommand only when delegateUsed is true', () => {
  const used = buildCritiqueTelemetryHookPayload({
    round: 1,
    repo: 'owner/repo',
    issue: 1,
    findingsCount: 0,
    severityBreakdown: { high: 0, medium: 0, low: 0 },
    acceptedCount: 0,
    rejectedCount: 0,
    delegateUsed: true,
    delegateCommand: 'coderabbit-critique',
    timestamp: FIXED_TIMESTAMP,
  });
  assert.equal(Object.hasOwn(used, 'delegateCommand'), true);
  assert.equal(used.delegateCommand, 'coderabbit-critique');
});

test('buildCritiqueTelemetryHookPayload defaults timestamp to an ISO-8601 string via the injected clock', () => {
  const fixedNow = new Date(FIXED_TIMESTAMP);
  const payload = buildCritiqueTelemetryHookPayload({
    round: 1,
    repo: 'owner/repo',
    issue: 1,
    findingsCount: 0,
    severityBreakdown: { high: 0, medium: 0, low: 0 },
    acceptedCount: 0,
    rejectedCount: 0,
    delegateUsed: false,
    now: () => fixedNow,
  });
  assert.equal(payload.timestamp, FIXED_TIMESTAMP);
});

// --- invokeCritiqueTelemetryHook: the fire-and-forget contract (#2679) ---
//
// Acceptance criterion 3: "a test or fixture demonstrates that a
// failing/absent hook command does not change C-phase control flow".
// Every case below asserts the promise settles (never throws, never
// rejects, never hangs past a short bound) regardless of how the spawned
// command fails.

function samplePayload(): CritiqueTelemetryHookPayload {
  return buildCritiqueTelemetryHookPayload({
    round: 1,
    repo: 'owner/repo',
    issue: 1,
    findingsCount: 0,
    severityBreakdown: { high: 0, medium: 0, low: 0 },
    acceptedCount: 0,
    rejectedCount: 0,
    delegateUsed: false,
    timestamp: FIXED_TIMESTAMP,
  });
}

/** Polls (rather than a single delayed check) until `pid` no longer exists
 * or `timeoutMs` elapses -- robust against this repository's documented
 * heavy concurrent-session scheduling load, which can otherwise delay
 * exactly when an already-issued kill signal actually reaps the process.
 * Only an ESRCH error proves the process is gone. Any other probe error is
 * uncertain (on win32, a live process can fail to open), so it keeps polling. */
async function waitUntilProcessGone(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return true;
      }
    }
    await delay(100);
  }
  return false;
}

/** Polls for `path` to exist and be non-empty, since the CLI's own exit
 * (fire-and-forget) races the spawned hook's node-startup time -- reading
 * immediately after the CLI returns is not reliably far enough along. */
async function waitForNonEmptyFile(
  path: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = readFileSync(path, 'utf8').trim();
      if (content !== '') {
        return content;
      }
    } catch {
      // Not written yet; keep polling.
    }
    await delay(50);
  }
  return readFileSync(path, 'utf8').trim();
}

/** Stub-hook source that records its own pid in `pidPath`, then captures
 * its whole stdin and writes it to `receivedPath` once stdin ends (a single
 * write of the full buffer). */
function captureStdinStubSource(receivedPath: string, pidPath: string): string {
  return `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
  process.exit(0);
});
`;
}

/** Polls by content until the file at `path` holds exactly `expected`, so a
 * read that lands while the stub is still mid-write can never be compared
 * (kurone-kito/idd-skill#3630: the old first-non-blank-poll read could see
 * a partly written 500KB file under load). A file longer than `expected` is
 * returned at once so the caller's assertion shows the mismatch. If the
 * file is still short at the deadline, this throws a failure that says so,
 * rather than returning the short content for a confusing equality diff. */
async function waitForReceivedPayload(
  path: string,
  expected: string,
  timeoutMs: number,
): Promise<string> {
  const expectedBytes = Buffer.from(expected);
  const deadline = Date.now() + timeoutMs;
  let last: Buffer | undefined;
  while (true) {
    try {
      last = readFileSync(path);
      if (last.equals(expectedBytes) || last.length > expectedBytes.length) {
        return last.toString('utf8');
      }
    } catch {
      // Not written yet; keep polling.
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(50);
  }
  if (last?.length === expectedBytes.length) {
    // Same length but different content: let the caller's assertion show it.
    return last.toString('utf8');
  }
  throw new Error(
    `received file stayed short: got ${last?.length ?? 0} of ${expectedBytes.length} bytes at ${path} after ${timeoutMs}ms`,
  );
}

/** Best-effort wait for the capture stub hook whose pid file is `pidPath` to
 * have exited, so that the `restore()` that follows can remove the directory
 * holding its executable (NTFS refuses to delete a running image, and
 * `restore()` makes six attempts over about 1.5 seconds before
 * `removeStubDirectory` polls for about five more seconds). Each of its two
 * phases (the pid file appearing, then the process exiting) is bounded by
 * `timeoutMs`; a timeout in either is silent and `restore()` then runs anyway.
 * A stub that never started, or is already gone, has nothing to wait for. */
async function waitForStubHookExit(
  pidPath: string,
  timeoutMs: number,
): Promise<void> {
  try {
    const pid = Number(await waitForNonEmptyFile(pidPath, timeoutMs));
    if (Number.isInteger(pid) && pid > 0) {
      await waitUntilProcessGone(pid, timeoutMs);
    }
  } catch {
    // The pid file never appeared: the stub did not start.
  }
}

/** Identifies the win32 backup watchdog's own spawn (kurone-kito/idd-skill#5339):
 * `process.execPath -e <script> <pid> <delayMs>`, matched by its `taskkill`
 * call. Host-independent, so the win32-override tests match it on any host. */
function isWin32NodeWatchdogSpawn(args: Parameters<typeof spawn>): boolean {
  const argv = args[1];
  return (
    args[0] === process.execPath &&
    Array.isArray(argv) &&
    argv[0] === '-e' &&
    String(argv[1]).includes('taskkill')
  );
}

/** Identifies the win32 relay (the primary hook spawn), which also starts with
 * `process.execPath`. The win32 watchdog starts with `process.execPath` too,
 * so the relay match excludes it (kurone-kito/idd-skill#5339). */
function isWin32RelaySpawn(args: Parameters<typeof spawn>): boolean {
  return args[0] === process.execPath && !isWin32NodeWatchdogSpawn(args);
}

/** Identifies the backup watchdog's own spawn call among every spawnFn
 * invocation in a round (kurone-kito/idd-skill#2892, #2897 CI follow-up,
 * #5339): POSIX spawns `sh` directly as `args[0]` with `['-c', script]`;
 * win32 spawns `process.execPath` with `['-e', script, pid, delayMs]`. */
function isWatchdogSpawnCall(args: Parameters<typeof spawn>): boolean {
  return isWin32NodeWatchdogSpawn(args) || args[0] === 'sh';
}

/** Extracts the watchdog's script from its captured argv array. On both
 * platforms the script is `argv[1]`: POSIX `['-c', script]`, win32
 * `['-e', script, pid, delayMs]`. */
function extractWatchdogScript(argv: string[] | undefined): string {
  return argv?.[1] ?? '';
}

/** The watchdog's delay in whole seconds, from its captured argv: `sleep <n>;`
 * in the POSIX script, or the delay in milliseconds as the win32 watchdog's
 * fourth argv entry. */
function extractWatchdogDelaySeconds(
  argv: string[] | undefined,
): number | undefined {
  if (!argv) {
    return undefined;
  }
  if (process.platform === 'win32') {
    const ms = Number(argv[3]);
    return Number.isFinite(ms) ? ms / 1000 : undefined;
  }
  const match = /^sleep (\d+);/.exec(argv[1] ?? '');
  return match ? Number(match[1]) : undefined;
}

/**
 * Appends a bare positional argument to a stub `command` string whose
 * `scriptBody` must genuinely stay alive (a `setInterval`-based hang, or
 * async `process.stdin` listeners) rather than exit synchronously
 * (kurone-kito/idd-skill#2892, Codex review on PR #2897).
 *
 * Without any argument, `stubExecutable`'s win32 hardlinked-`node.exe`
 * trick hits Node's own "no script argument, non-TTY stdin -> evaluate
 * stdin as a script" bootstrap path (`node:internal/main/eval_stdin`) --
 * a documented, version-stable Node CLI behavior that never goes through
 * `Module._load` at all, so the preload's own `isMain` override (built
 * for the normal module-loading path) cannot intercept it. The hook's
 * own JSON payload on stdin is not valid top-level JS there, so that path
 * throws a `SyntaxError` and crashes the stub almost instantly -- before
 * a `setInterval`-only `scriptBody` (which never itself calls
 * `process.exit()`) gets a chance to matter, or before async
 * `process.stdin` listeners finish receiving their data -- rather than
 * behaving as the fixture intends. (A `scriptBody` that calls
 * `process.exit()` synchronously and unconditionally, e.g.
 * `'process.exit(0);\n'`, terminates before returning control to Node's
 * bootstrap at all, so it is not affected and does not need this.)
 *
 * A single non-dash-prefixed positional argument routes the launch
 * through `run_main_module` instead, which *does* go through
 * `Module._load` with `isMain: true` -- exactly what the win32 preload's
 * own override already intercepts as a no-op, letting `scriptBody` run
 * normally afterward with no further stdin-bootstrap interference. Must
 * not start with `-`: a leading-dash first argument is rejected by
 * Node's own C++ option parser before any preload runs (this file's own
 * `buildStubPreloadSource` comment documents the same constraint).
 * Verified empirically (not just reasoned from documentation): an
 * otherwise-identical `node --require <preload>` invocation with JSON
 * piped to stdin crashes with exactly this `SyntaxError` when given no
 * trailing argument, and stays alive as intended once given one.
 *
 * A cosmetic no-op on POSIX (harmless — none of the affected
 * `scriptBody`s inspect `process.argv`): the shebang wrapper there
 * already supplies an explicit script-file argument regardless of
 * anything appended here, so POSIX never hits this ambiguity to begin
 * with.
 */
function stayAliveCommand(name: string): string {
  return `${name} idd-stub-stay-alive`;
}

/**
 * Real, host-platform-appropriate process-tree cleanup for a test's own
 * `finally` block -- NOT the code under test (kurone-kito/idd-skill#2892,
 * #2897 CI finding). Several tests inject `platform: 'win32'` to exercise
 * that branch deterministically from any host, but the actual leftover
 * process still belongs to *this host's real OS* regardless of which
 * branch the code under test took -- branching on `process.platform`
 * (the real host), not the injected option, is required so the fallback
 * tests' own documented "leaves a real descendant behind" limitation
 * does not leak a genuine orphan into a `windows-latest` CI run: a POSIX
 * negative-pid group-kill is meaningless there (the same gap this whole
 * issue fixes in the code under test), so it must be `taskkill /PID ...
 * /T /F` on that host instead. Best-effort: swallows any failure (already
 * exited, insufficient privilege, etc.).
 */
function cleanupProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone, or nothing to clean up.
  }
}

test('invokeCritiqueTelemetryHook is a no-op for an empty/whitespace command', async () => {
  assert.deepEqual(await invokeCritiqueTelemetryHook('', samplePayload()), {
    attempted: false,
    ok: false,
  });
  assert.deepEqual(await invokeCritiqueTelemetryHook('   ', samplePayload()), {
    attempted: false,
    ok: false,
  });
  assert.deepEqual(await invokeCritiqueTelemetryHook(null, samplePayload()), {
    attempted: false,
    ok: false,
  });
  assert.deepEqual(
    await invokeCritiqueTelemetryHook(undefined, samplePayload()),
    { attempted: false, ok: false },
  );
});

test('invokeCritiqueTelemetryHook resolves ok:false, never throws, for a command that does not exist', async () => {
  // A generous timeoutMs here: this test asserts correctness (no throw,
  // ok:false), not speed -- the shell's own command-not-found exit is
  // normally fast (well under a second), but under this repository's
  // documented heavy concurrent-session load a shell spawn/exit can be
  // delayed well past a tight bound. The dedicated hanging-command test
  // below is the one that specifically exercises and times the
  // timeoutMs+kill path.
  const result = await invokeCritiqueTelemetryHook(
    'idd-nonexistent-telemetry-hook-2679',
    samplePayload(),
    { timeoutMs: 10_000 },
  );
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
});

test('invokeCritiqueTelemetryHook resolves ok:true for a command that exits 0', async () => {
  const restore = stubExecutable('idd-telemetry-hook-ok', 'process.exit(0);\n');
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-ok',
      samplePayload(),
      { timeoutMs: 5_000 },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
  } finally {
    restore();
  }
});

test('invokeCritiqueTelemetryHook resolves ok:false for a command that exits non-zero', async () => {
  const restore = stubExecutable(
    'idd-telemetry-hook-fail',
    'process.exit(1);\n',
  );
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-fail',
      samplePayload(),
      { timeoutMs: 5_000 },
    );
    assert.deepEqual(result, { attempted: true, ok: false });
  } finally {
    restore();
  }
});

test('invokeCritiqueTelemetryHook resolves ok:false promptly (bounded by timeoutMs) for a hanging command, instead of hanging the caller', async () => {
  const restore = stubExecutable(
    'idd-telemetry-hook-hang',
    // Keep the event loop alive without ever exiting on its own.
    'setInterval(() => {}, 1000);\n',
  );
  try {
    const timeoutMs = 1_000;
    const startedAt = Date.now();
    const result = await invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-hang'),
      samplePayload(),
      { timeoutMs },
    );
    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(result, { attempted: true, ok: false });
    // Generous upper bound vs. the 1s timeout -- proves the call returned
    // because of the timeout+kill path (the stubbed command never exits on
    // its own), not that it happened to hang until some much larger bound.
    // Kept well above timeoutMs itself to tolerate this repository's
    // documented heavy concurrent-session scheduling load.
    assert.ok(
      elapsedMs < 15_000,
      `expected invokeCritiqueTelemetryHook to return within a bounded time of its ${timeoutMs}ms timeout, took ${elapsedMs}ms`,
    );
  } finally {
    restore();
  }
});

// POSIX-shell-only by construction (kurone-kito/idd-skill#2892, issue item
// 6): the command below relies on `&`, `$!`, and `wait`, none of which
// `cmd.exe` (the real `shell: true` wrapper on win32) understands -- it
// would fail with an unrelated-looking parse error rather than exercising
// this test's intended assertion. The Windows tree-kill this issue adds is
// covered by a different, `cmd.exe`-native mechanism instead: the
// `stubExecutable`-based hang/orphan fixtures above (e.g.
// 'idd-telemetry-hook-hang') already reach a real grandchild process one
// level below the `cmd.exe` wrapper on win32, and the dedicated
// `taskkill`-argument tests below assert the win32 kill path directly.
test('invokeCritiqueTelemetryHook kills a backgrounded descendant on timeout, not just the shell wrapper (#2685 review, Codex)', {
  skip: process.platform === 'win32',
}, async () => {
  // Regression fixture: `shell: true` makes the spawned `child` the
  // `/bin/sh -c` wrapper. A command that backgrounds a job of its own
  // (`cmd & wait`) creates a descendant with a *different* pid than that
  // wrapper -- a plain single-pid kill would leave it running as an
  // orphan even though `child` itself died. The fix targets the whole
  // process group (negative pid), which must still reach it.
  const sandbox = makeTempDir(join(tmpdir(), 'idd-telemetry-hook-group-kill-'));
  const pidFile = join(sandbox, 'pid');
  // #2685 review (CodeRabbit): record the backgrounded descendant's pid via
  // the shell's own `$!` immediately after backgrounding it, rather than
  // waiting on the node subprocess to reach and complete its own
  // `writeFileSync` -- with a short 500ms `timeoutMs` below, a slow node
  // startup under this repository's documented heavy concurrent-session
  // load could otherwise race the group-kill and leave `pidFile` never
  // written at all.
  const nodeScript = 'setInterval(() => {}, 1000);';
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(nodeScript)} & echo $! > ${JSON.stringify(pidFile)}; wait`;

  const result = await invokeCritiqueTelemetryHook(command, samplePayload(), {
    timeoutMs: 500,
  });
  assert.deepEqual(result, { attempted: true, ok: false });

  const pid = Number(await waitForNonEmptyFile(pidFile, 5_000));
  assert.ok(
    Number.isInteger(pid) && pid > 0,
    `expected the backgrounded descendant's pid to have been recorded, got ${pid}`,
  );
  const gone = await waitUntilProcessGone(pid, 10_000);
  assert.ok(
    gone,
    `expected the backgrounded descendant (pid ${pid}) to be killed by the process-group signal, but it is still running`,
  );
});

// --- win32 kill/watchdog argument shape (kurone-kito/idd-skill#2892) -----
//
// These two tests give deterministic, non-CI coverage of the *argument
// construction* for the win32 kill path from any OS, using the injectable
// `platform` option the same way `spawnFn` is already injected for
// testability. Originally (kurone-kito/idd-skill#2892), overriding
// `platform` only changed which of `killProcessGroup`/`spawnWatchdog`'s
// own branches the code took, never which real shell the primary
// `shell: true` spawn was interpreted by (always whatever the host OS
// actually provides). kurone-kito/idd-skill#2910 extended `platform` to
// also select the *primary* spawn shape: on any host, an override to
// `'win32'` now routes that primary spawn through the real
// `WIN32_RELAY_SCRIPT` (via `node -e`, not mocked), which itself still
// invokes the host's own real shell for the actual target command one
// hop further in -- so the win32-specific relay logic gets real,
// non-CI-only coverage too, not just the kill/watchdog argument shapes
// this section's own two tests below were originally written for. The
// `windows-latest` CI job (added alongside this file) remains the actual
// behavioral verification gate on every push; the argument-shape tests
// below have also since been cross-checked live on native Windows 11
// during the #2897 CI follow-up (kurone-kito/idd-skill#2892) and the
// #2910 relay work, not only inferred from a non-Windows implementation
// environment.

test('invokeCritiqueTelemetryHook delivers the payload and resolves ok:true through the win32 relay when platform is overridden to win32 (kurone-kito/idd-skill#2910)', async () => {
  // Complements the win32 hang/kill-path tests below (which all exercise
  // `ok:false` outcomes) with the relay's own success path: a quick-exiting
  // target, byte-exact payload delivery, and `ok:true`/exit-code-0
  // forwarding through the relay -- `platform: 'win32'` routes this call
  // through the real `WIN32_RELAY_SCRIPT` (via `node -e`, not mocked) even
  // on this non-Windows test host, the same real-code-path coverage this
  // file's other `platform: 'win32'`-override tests already rely on.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-win32-relay-success-'),
  );
  const receivedPath = join(sandbox, 'received.json');
  const restore = stubExecutable(
    'idd-telemetry-hook-win32-relay-success',
    `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
  process.exit(0);
});
`,
  );
  try {
    const payload = samplePayload();
    const result = await invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-win32-relay-success'),
      payload,
      { timeoutMs: 5_000, platform: 'win32' },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    const received = await waitForNonEmptyFile(receivedPath, 5_000);
    assert.equal(
      received,
      JSON.stringify(payload),
      'expected the relay to forward the full, untruncated payload to the real target',
    );
  } finally {
    restore();
  }
});

test('win32 telemetry relay blocks and records an unexpected gh command (#3755)', async () => {
  const guardRoot = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-relay-guard-'),
  );
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const envKeys = [
    'IDD_TEST_GH_GUARD_ROOT',
    'IDD_TEST_GH_GUARD_LEDGER',
    'IDD_TEST_GH_GUARD_OWNER_PID',
    'IDD_TEST_GH_GUARD_ROOT_OWNER_PID',
    'IDD_TEST_GH_GUARD_SELF_CHECK',
  ];
  const priorEnv = new Map(
    envKeys.map((key) => [key, process.env[key]] as const),
  );
  process.env.IDD_TEST_GH_GUARD_ROOT = guardRoot;
  process.env.IDD_TEST_GH_GUARD_LEDGER = ledgerPath;
  process.env.IDD_TEST_GH_GUARD_OWNER_PID = String(process.pid);
  process.env.IDD_TEST_GH_GUARD_ROOT_OWNER_PID = String(process.pid);
  delete process.env.IDD_TEST_GH_GUARD_SELF_CHECK;
  try {
    const result = await invokeCritiqueTelemetryHook(
      'gh api repos/example/repo',
      samplePayload(),
      { timeoutMs: 5_000, platform: 'win32' },
    );
    assert.deepEqual(result, { attempted: true, ok: false });
    const attempts = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { api?: string; executable?: string });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.api, 'spawn');
    assert.equal(attempts[0]?.executable, 'gh in shell command');
  } finally {
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('invokeCritiqueTelemetryHook win32 relay survives an inherited NODE_OPTIONS=--input-type=module (kurone-kito/idd-skill#2910 review, Codex)', async () => {
  // A caller whose own environment sets NODE_OPTIONS=--input-type=module
  // -- inherited by the relay spawn via `env: {...process.env, ...}` --
  // would otherwise make Node evaluate WIN32_RELAY_SCRIPT as ESM, where
  // `require` is undefined and the relay throws before ever reading its
  // stdin: verified locally (`NODE_OPTIONS=--input-type=module node -e
  // "require('node:child_process')"` throws `ReferenceError: require is
  // not defined in ES module scope`) before this test was written. The
  // fix passes an explicit `--input-type=commonjs` flag, which overrides
  // an inherited `--input-type=module`.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-win32-relay-node-options-'),
  );
  const receivedPath = join(sandbox, 'received.json');
  // stubExecutable's own win32 branch already sets process.env.NODE_OPTIONS
  // (to inject its own `--require <preload>`) as part of the call below --
  // append to THAT current value, not to whatever NODE_OPTIONS held before
  // this call. Appending to a pre-stub snapshot instead would silently
  // discard the stub's own `--require` and break the stub mechanism
  // itself (confirmed live on native Windows: doing it that way made 10
  // unrelated win32 tests fail alongside this one, not just this one).
  const restore = stubExecutable(
    'idd-telemetry-hook-win32-relay-node-options',
    `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
  process.exit(0);
});
`,
  );
  const nodeOptionsAfterStub = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = nodeOptionsAfterStub
      ? `${nodeOptionsAfterStub} --input-type=module`
      : '--input-type=module';
    const payload = samplePayload();
    const result = await invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-win32-relay-node-options'),
      payload,
      { timeoutMs: 5_000, platform: 'win32' },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    const received = await waitForNonEmptyFile(receivedPath, 5_000);
    assert.equal(
      received,
      JSON.stringify(payload),
      'expected the relay to still deliver the payload despite an inherited --input-type=module',
    );
  } finally {
    // Restore to the stub's own NODE_OPTIONS value (pre --input-type
    // append) before restore() unwinds the stub itself -- restore()
    // resets to its own pre-stub snapshot regardless, so this step is
    // only needed if a future edit adds code between here and restore()
    // that reads process.env.NODE_OPTIONS.
    if (nodeOptionsAfterStub === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = nodeOptionsAfterStub;
    }
    restore();
  }
});

test('invokeCritiqueTelemetryHook win32 relay never executes an inherited NODE_OPTIONS preload itself, though the real target still can (kurone-kito/idd-skill#2910 review, Copilot)', async () => {
  // The `--input-type=commonjs` flag and the NODE_OPTIONS-sanitization
  // fix above are meant to stop an inherited `--require`/`--import` from
  // running arbitrary preload code *inside the relay itself* -- but
  // neither of the other two NODE_OPTIONS tests in this file actually
  // proves that: the test above only exercises `--input-type=module`,
  // which the relay's own explicit `--input-type=commonjs` flag already
  // neutralizes on its own, with or without the sanitization fix. This
  // test uses a real `--require` preload instead, and distinguishes "did
  // the relay's own process load it" from "did the real target's
  // process load it" (expected -- the original NODE_OPTIONS, minus
  // --input-type, is deliberately still forwarded there) by having the
  // preload check for the relay-command env var that only the relay's
  // own process ever has set.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-win32-relay-preload-'),
  );
  const relayPoisonedSentinel = join(sandbox, 'relay-poisoned.txt');
  const preloadPath = join(sandbox, 'preload.cjs');
  writeFileSync(
    preloadPath,
    `const fs = require('fs');
if (process.env.IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_COMMAND) {
  fs.writeFileSync(${JSON.stringify(relayPoisonedSentinel)}, 'relay loaded the inherited preload');
}
`,
  );
  const receivedPath = join(sandbox, 'received.json');
  const restore = stubExecutable(
    'idd-telemetry-hook-win32-relay-preload-target',
    `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
  process.exit(0);
});
`,
  );
  const nodeOptionsAfterStub = process.env.NODE_OPTIONS;
  try {
    // Quoted, and forward-slashed on win32 (kurone-kito/idd-skill#2910
    // review, Copilot): tmpdir() can contain a space (a real, if
    // uncommon, path shape on some hosts), and Node's NODE_OPTIONS
    // parser splits on unquoted whitespace, so an unquoted path there
    // would silently fail to load and this test would stop exercising
    // what it claims to. Quoting alone is not enough on win32, though
    // (empirically verified): inside a quoted NODE_OPTIONS token, Node
    // treats a backslash as an escape character, so a quoted native
    // Windows path (`C:\tmp\...`) loses every backslash and fails to
    // resolve -- confirmed live: `--require "C:\tmp\...\preload.cjs"`
    // throws `MODULE_NOT_FOUND` for the mangled path
    // `C:tmp...preload.cjs`. `stubExecutable`'s own `--require` flag
    // (`tests/test-utils.mts`) already works around exactly this by
    // converting to forward slashes before quoting -- do the same here.
    const quotedPreloadPath = `"${preloadPath.replaceAll('\\', '/')}"`;
    process.env.NODE_OPTIONS = nodeOptionsAfterStub
      ? `${nodeOptionsAfterStub} --require ${quotedPreloadPath}`
      : `--require ${quotedPreloadPath}`;
    const payload = samplePayload();
    const result = await invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-win32-relay-preload-target'),
      payload,
      { timeoutMs: 5_000, platform: 'win32' },
    );
    assert.equal(
      existsSync(relayPoisonedSentinel),
      false,
      'expected the relay itself to never load the inherited --require preload',
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    const received = await waitForNonEmptyFile(receivedPath, 5_000);
    assert.equal(
      received,
      JSON.stringify(payload),
      'expected the target to still receive the full payload with the preload forwarded',
    );
  } finally {
    if (nodeOptionsAfterStub === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = nodeOptionsAfterStub;
    }
    restore();
  }
});

test('invokeCritiqueTelemetryHook win32 relay strips a non-canonically-cased Node_Options key too (kurone-kito/idd-skill#2910 review, Copilot)', async () => {
  // Every other NODE_OPTIONS test in this file sets the canonical-case
  // key, which would already pass even with the earlier exact-case-only
  // `const { NODE_OPTIONS, ...relayEnv } = process.env` destructure --
  // none of them actually exercises the case-insensitive scrub itself.
  // Windows environment-variable names are case-insensitive at the OS
  // level but a plain JS object key is not, so a caller whose own
  // environment carries a differently-cased entry (real-world
  // precedent: Windows system variables like ComSpec/Path routinely
  // keep non-canonical casing) needs the scrub to still catch it.
  // `process.env` is a plain object on every platform (this test's own
  // manual assignment below simulates that shape directly, regardless
  // of what the real OS would produce), so setting a mixed-case key
  // here exercises the exact same code path a genuine Windows
  // non-canonical entry would.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-win32-relay-mixed-case-'),
  );
  const relayPoisonedSentinel = join(sandbox, 'relay-poisoned.txt');
  const preloadPath = join(sandbox, 'preload.cjs');
  writeFileSync(
    preloadPath,
    `const fs = require('fs');
if (process.env.IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_COMMAND) {
  fs.writeFileSync(${JSON.stringify(relayPoisonedSentinel)}, 'relay loaded the inherited preload');
}
`,
  );
  const receivedPath = join(sandbox, 'received.json');
  const restore = stubExecutable(
    'idd-telemetry-hook-win32-relay-mixed-case-target',
    `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
  process.exit(0);
});
`,
  );
  // stubExecutable's win32 branch already set the *canonical-case*
  // process.env.NODE_OPTIONS (to inject its own --require <preload>).
  // Move that content onto the non-canonically-cased key below instead
  // of adding a second, separate key alongside it: a real Windows
  // environment has exactly one such variable, just possibly spelled
  // non-canonically -- simultaneously having both NODE_OPTIONS and
  // Node_Options present is not a realistic shape, and this fix's own
  // key-iteration order would nondeterministically clobber one value
  // with the other (confirmed live: an earlier version of this test did
  // exactly that and silently dropped the stub's own --require,
  // breaking the stub mechanism itself, not the fix under test).
  const nodeOptionsAfterStub = process.env.NODE_OPTIONS;
  const hadMixedCaseKey = Object.hasOwn(process.env, 'Node_Options');
  const previousMixedCaseValue = process.env.Node_Options;
  try {
    delete process.env.NODE_OPTIONS;
    // Deliberately the *non*-canonical casing -- the sanitization fix
    // under test matches keys case-insensitively via
    // `key.toUpperCase() === 'NODE_OPTIONS'`, so this specific spelling
    // exercises that comparison rather than an exact-match shortcut.
    // Forward-slashed before quoting -- see the sibling preload test
    // above for why a quoted native Windows backslash path fails to
    // resolve on win32 (Node strips backslashes as escapes inside a
    // quoted NODE_OPTIONS token).
    const myPreloadRequire = `--require "${preloadPath.replaceAll('\\', '/')}"`;
    process.env.Node_Options = nodeOptionsAfterStub
      ? `${nodeOptionsAfterStub} ${myPreloadRequire}`
      : myPreloadRequire;
    const payload = samplePayload();
    const result = await invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-win32-relay-mixed-case-target'),
      payload,
      { timeoutMs: 5_000, platform: 'win32' },
    );
    assert.equal(
      existsSync(relayPoisonedSentinel),
      false,
      'expected the relay itself to never load a preload inherited via a non-canonically-cased NODE_OPTIONS key',
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    const received = await waitForNonEmptyFile(receivedPath, 5_000);
    assert.equal(
      received,
      JSON.stringify(payload),
      'expected the target to still receive the full payload with the preload forwarded',
    );
  } finally {
    if (hadMixedCaseKey) {
      process.env.Node_Options = previousMixedCaseValue;
    } else {
      delete process.env.Node_Options;
    }
    restore();
  }
});

test('invokeCritiqueTelemetryHook win32 relay clears a stale inherited reserved NODE_OPTIONS-channel value before spawning (kurone-kito/idd-skill#2910 review, Codex follow-up)', async () => {
  // The reserved IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_NODE_OPTIONS
  // channel exists purely as transport from the primary process to the
  // relay's own inner spawn (see WIN32_RELAY_SCRIPT's own doc comment) --
  // it is never meant to already be present as an ambient variable on
  // this hook's own process. But if it somehow is (for example leaked
  // from a nested or prior invocation of this same hook), the primary
  // spawn's relayEnv -- a full copy of process.env -- inherits it too;
  // when the real caller's own NODE_OPTIONS happens to be unset,
  // callerNodeOptions comes back undefined, so the conditional re-add
  // contributes nothing and nothing else explicitly clears the stale
  // value out of relayEnv before it reaches the relay. Simulate that leak
  // directly with an intentionally-broken --require target on the stale
  // channel: if it reaches the real target's NODE_OPTIONS without being
  // scrubbed first, the target process fails to even start and the
  // payload never arrives; with the channel properly cleared, the target
  // starts clean and receives the payload normally.
  //
  // Not `stubExecutable` (confirmed live on native Windows): its own win32
  // branch unconditionally sets `process.env.NODE_OPTIONS` itself, to make
  // its exe-copy-plus-preload redirect trick work at all -- deleting
  // NODE_OPTIONS the way this test needs to would break that redirect and
  // fail the test regardless of whether the fix under test is applied,
  // which is exactly what happened when this test was first written
  // against `stubExecutable`. Building the target directly as `node
  // <scriptPath>` sidesteps NODE_OPTIONS entirely for the target's own
  // startup, leaving this test free to control it purely to exercise the
  // reserved-channel leak.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-win32-relay-stale-channel-'),
  );
  const receivedPath = join(sandbox, 'received.json');
  const targetScriptPath = join(sandbox, 'target.cjs');
  writeFileSync(
    targetScriptPath,
    `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
  process.exit(0);
});
`,
  );
  // Two simple quoted paths, no nested quoting or embedded newlines --
  // deliberately avoids `-e "<script>"` here (unlike this file's other
  // directly-built commands), since that would need the whole multi-line
  // script JSON-escaped into one already-quoted command string, which
  // `cmd.exe`'s own quote parsing (the real win32 shell behind `shell:
  // true`) does not handle the same way a POSIX shell does.
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(targetScriptPath)}`;
  const hadNodeOptions = Object.hasOwn(process.env, 'NODE_OPTIONS');
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const hadStaleChannelValue = Object.hasOwn(
    process.env,
    'IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_NODE_OPTIONS',
  );
  const previousStaleChannelValue =
    process.env.IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_NODE_OPTIONS;
  try {
    // NODE_OPTIONS itself must stay unset so callerNodeOptions comes back
    // undefined and the conditional re-add cannot mask the bug under test.
    delete process.env.NODE_OPTIONS;
    process.env.IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_NODE_OPTIONS =
      '--require /idd-2910-nonexistent-stale-channel-preload.cjs';
    const payload = samplePayload();
    const result = await invokeCritiqueTelemetryHook(command, payload, {
      timeoutMs: 5_000,
      platform: 'win32',
    });
    assert.deepEqual(result, { attempted: true, ok: true });
    const received = await waitForNonEmptyFile(receivedPath, 5_000);
    assert.equal(
      received,
      JSON.stringify(payload),
      'expected the target to start clean and receive the full payload, with the stale reserved channel value scrubbed rather than leaked through as its NODE_OPTIONS',
    );
  } finally {
    if (hadStaleChannelValue) {
      process.env.IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_NODE_OPTIONS =
        previousStaleChannelValue;
    } else {
      delete process.env.IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_NODE_OPTIONS;
    }
    if (hadNodeOptions) {
      process.env.NODE_OPTIONS = previousNodeOptions;
    } else {
      delete process.env.NODE_OPTIONS;
    }
  }
});

test('invokeCritiqueTelemetryHook win32 relay preserves a quoted --require path whose own filename embeds "--input-type=" text (kurone-kito/idd-skill#2910 review round 6, Copilot + Codex)', async () => {
  // The --input-type strip (see WIN32_RELAY_SCRIPT's own doc comment) used
  // to be one whole-string regex with no notion of "inside a quoted
  // span" -- so a *legitimate* quoted --require value that happens to
  // contain the literal text "--input-type=" preceded by whitespace (for
  // example a filename that itself embeds that substring, a real if
  // unusual shape) would be mistaken for a genuine top-level option and
  // stripped, truncating the quoted path and breaking the target's own
  // --require. Deliberately construct the preload's *filename* to embed
  // that exact substring, reproducing the review's own repro
  // (`"C:/dir/name --input-type=module.cjs"`) rather than a synthetic
  // stand-in.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-win32-relay-quoted-token-'),
  );
  const targetPreloadSentinel = join(sandbox, 'target-preload-loaded.txt');
  const preloadPath = join(sandbox, 'preload --input-type=module.cjs');
  writeFileSync(
    preloadPath,
    `require('fs').writeFileSync(${JSON.stringify(targetPreloadSentinel)}, 'loaded');\n`,
  );
  const receivedPath = join(sandbox, 'received.json');
  const restore = stubExecutable(
    'idd-telemetry-hook-win32-relay-quoted-token-target',
    `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
  process.exit(0);
});
`,
  );
  const nodeOptionsAfterStub = process.env.NODE_OPTIONS;
  try {
    // Quoted and forward-slashed for the same reasons as this file's
    // other --require-path tests above (tmpdir() can contain a space;
    // a quoted native Windows backslash path loses its backslashes).
    const quotedPreloadPath = `"${preloadPath.replaceAll('\\', '/')}"`;
    process.env.NODE_OPTIONS = nodeOptionsAfterStub
      ? `${nodeOptionsAfterStub} --require ${quotedPreloadPath}`
      : `--require ${quotedPreloadPath}`;
    const payload = samplePayload();
    const result = await invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-win32-relay-quoted-token-target'),
      payload,
      { timeoutMs: 5_000, platform: 'win32' },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    const received = await waitForNonEmptyFile(receivedPath, 5_000);
    assert.equal(
      received,
      JSON.stringify(payload),
      'expected the target to receive the full payload',
    );
    assert.equal(
      existsSync(targetPreloadSentinel),
      true,
      'expected the target to have loaded the --require preload despite its own filename embedding "--input-type="',
    );
  } finally {
    if (nodeOptionsAfterStub === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = nodeOptionsAfterStub;
    }
    restore();
  }
});

test('invokeCritiqueTelemetryHook win32 relay scrubs a non-canonically-cased reserved NODE_OPTIONS-channel key too (kurone-kito/idd-skill#2910 review round 6, Copilot + Codex)', async () => {
  // Defense-in-depth, not a currently observable leak (no-fabrication
  // note): the relay's own lookup of these two reserved names
  // (WIN32_RELAY_SCRIPT's `env['...']` access) is itself exact-case, so a
  // non-canonically-cased duplicate reaching the relay would already be
  // inert there today -- confirmed live, this test's own poisoned
  // lower-cased key produces the same ok:true outcome whether or not the
  // primary-spawn scrub below runs. What this test actually verifies is
  // narrower and still worth pinning: the poisoned key itself must not
  // appear in the env object the primary spawn hands to the relay at
  // all, closing the gap before it could ever matter (for example if the
  // relay's own lookup were ever changed to be case-insensitive too,
  // matching the NODE_OPTIONS scan it already sits next to).
  const restore = stubExecutable(
    'idd-telemetry-hook-win32-relay-mixed-case-reserved',
    'process.exit(0);\n',
  );
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    // Same discriminator as this file's other win32 argument-shape tests:
    // the primary spawn is uniquely identified by process.execPath as
    // args[0] on win32 (the relay itself), unlike the target/taskkill
    // calls this spawnFn also sees.
    if (isWin32RelaySpawn(args)) {
      capturedEnv = (args[2] as { env?: NodeJS.ProcessEnv }).env;
    }
    return child;
  }) as typeof spawn;
  const poisonKey = 'idd_critique_telemetry_hook_win32_relay_node_options';
  const poisonValue = '--require /idd-2910-poison-reserved-channel.cjs';
  const hadPoisonKey = Object.hasOwn(process.env, poisonKey);
  const previousPoisonValue = (process.env as Record<string, string>)[
    poisonKey
  ];
  try {
    (process.env as Record<string, string>)[poisonKey] = poisonValue;
    const result = await invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-win32-relay-mixed-case-reserved'),
      samplePayload(),
      { timeoutMs: 5_000, spawnFn, platform: 'win32' },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    assert.ok(
      capturedEnv,
      'expected the primary win32 spawn to have been observed',
    );
    // Local const, not the outer `let` (TypeScript's control-flow
    // narrowing from the `assert.ok` above does not persist into the
    // filter callback closure below).
    const observedEnv = capturedEnv;
    const leaked = Object.keys(observedEnv).filter(
      (key) =>
        key.toUpperCase() ===
          'IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_NODE_OPTIONS' &&
        observedEnv[key] === poisonValue,
    );
    assert.deepEqual(
      leaked,
      [],
      `expected the poisoned non-canonically-cased reserved key to be scrubbed from the relay's env, found: ${JSON.stringify(leaked)}`,
    );
  } finally {
    if (hadPoisonKey) {
      (process.env as Record<string, string>)[poisonKey] = previousPoisonValue;
    } else {
      delete (process.env as Record<string, string>)[poisonKey];
    }
    restore();
  }
});

test('invokeCritiqueTelemetryHook forwards a compound (a && b) command through the win32 relay when platform is overridden to win32 (kurone-kito/idd-skill#2910 review, Copilot)', async () => {
  // Issue #2910's own "Proposed change" section requires this fix to
  // "keep the existing command config contract (an arbitrary shell
  // command string, including a && b-style compound commands) working
  // the same way it does on POSIX today, since shell: true exists
  // specifically to support that". The win32-relay-success test above
  // only exercises a single executable; this test closes that gap with
  // a genuine `a && b` compound command, forwarded through the relay's
  // own inner `shell: true` hop unchanged. The first stub deliberately
  // does not read stdin (exits synchronously and unconditionally, so it
  // needs no `stayAliveCommand` positional argument per that helper's
  // own doc comment), so the full payload reaches the second stub
  // untouched -- proving the relay does not mangle or truncate the
  // command string across the `&&` boundary.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-win32-relay-compound-'),
  );
  const receivedPath = join(sandbox, 'received.json');
  const restoreFirst = stubExecutable(
    'idd-telemetry-hook-win32-relay-compound-first',
    'process.exit(0);\n',
  );
  const restoreSecond = stubExecutable(
    'idd-telemetry-hook-win32-relay-compound-second',
    `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
  process.exit(0);
});
`,
  );
  try {
    const command =
      'idd-telemetry-hook-win32-relay-compound-first && ' +
      stayAliveCommand('idd-telemetry-hook-win32-relay-compound-second');
    const payload = samplePayload();
    const result = await invokeCritiqueTelemetryHook(command, payload, {
      timeoutMs: 5_000,
      platform: 'win32',
    });
    assert.deepEqual(result, { attempted: true, ok: true });
    const received = await waitForNonEmptyFile(receivedPath, 5_000);
    assert.equal(
      received,
      JSON.stringify(payload),
      'expected the second half of the compound command to receive the full, untruncated payload',
    );
  } finally {
    // LIFO order, matching this file's other multi-stub tests.
    restoreSecond();
    restoreFirst();
  }
});

test('invokeCritiqueTelemetryHook spawns a win32 process-tree kill (taskkill /PID <pid> /T /F) on timeout when platform is overridden to win32', async () => {
  const restore = stubExecutable(
    'idd-telemetry-hook-hang-win32',
    'setInterval(() => {}, 1000);\n',
  );
  try {
    let primaryChild: ReturnType<typeof spawn> | undefined;
    let taskkillArgs: string[] | undefined;
    let taskkillOptions: Record<string, unknown> | undefined;
    const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      // kurone-kito/idd-skill#2910: on win32 the primary spawn is the
      // relay (`process.execPath` with `-e`), not the raw command string
      // -- `process.execPath` is the one value unique to that call among
      // everything else this spawnFn sees (the watchdog and `taskkill`
      // calls both pass a string as args[0]).
      if (isWin32RelaySpawn(args)) {
        primaryChild = child;
      }
      if (
        args[0] === 'taskkill' &&
        args[1]?.[1] === String(primaryChild?.pid)
      ) {
        taskkillArgs = args[1] as string[];
        taskkillOptions = args[2] as Record<string, unknown>;
      }
      return child;
    }) as typeof spawn;

    try {
      const result = await invokeCritiqueTelemetryHook(
        stayAliveCommand('idd-telemetry-hook-hang-win32'),
        samplePayload(),
        { timeoutMs: 500, spawnFn, platform: 'win32' },
      );
      assert.deepEqual(result, { attempted: true, ok: false });
      assert.ok(
        taskkillArgs,
        'expected taskkill to have been spawned on timeout',
      );
      assert.deepEqual(
        taskkillArgs,
        ['/PID', String(primaryChild?.pid), '/T', '/F'],
        `expected taskkill /PID <pid> /T /F, got: ${JSON.stringify(taskkillArgs)}`,
      );
      // Also assert the options object, not just argv: this is the actual
      // option the doc comment claims reliably suppresses taskkill's own
      // window (C1 review, kurone-kito/idd-skill#2892).
      assert.equal(taskkillOptions?.stdio, 'ignore');
      assert.equal(taskkillOptions?.windowsHide, true);
    } finally {
      // The `platform: 'win32'` override above makes killProcessGroup take
      // the taskkill branch. On a non-Windows test host, that spawn is a
      // real no-op (ENOENT, absorbed by its own 'error' listener), so the
      // real hanging process this test spawned is never actually reaped
      // by the code under test -- clean it up directly via
      // cleanupProcessTree (host-appropriate: POSIX group-kill here). On
      // the `windows-latest` CI job this test also runs on, the code
      // under test's own `taskkill` already reaped it for real, so this
      // is a harmless no-op there too.
      const pid = primaryChild?.pid;
      if (typeof pid === 'number' && pid > 0) {
        cleanupProcessTree(pid);
      }
    }
  } finally {
    restore();
  }
});

test('invokeCritiqueTelemetryHook spawns a win32 backup watchdog as a detached node process with no shell hop (node -e, pid, delay) when platform is overridden to win32', async () => {
  // The win32 watchdog is `process.execPath -e <script> <pid> <delayMs>`,
  // spawned directly with `detached: true` and no shell hop. It replaces the
  // `cmd.exe` -> `powershell.exe` watchdog, which opened a Windows Terminal
  // window per spawn (kurone-kito/idd-skill#5339). This test asserts the argv
  // and the options. The real kill and the window count are checked below.
  let watchdogArgs: string[] | undefined;
  let watchdogOptions: Record<string, unknown> | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    if (isWin32NodeWatchdogSpawn(args)) {
      watchdogArgs = args[1] as string[];
      watchdogOptions = args[2] as unknown as Record<string, unknown>;
    }
    return spawn(...args);
  }) as typeof spawn;

  const restore = stubExecutable(
    'idd-telemetry-hook-quick-exit-win32',
    'process.exit(0);\n',
  );
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-quick-exit-win32',
      samplePayload(),
      { timeoutMs: 5_000, spawnFn, platform: 'win32' },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    assert.ok(
      watchdogArgs,
      'expected the win32 watchdog (process.execPath -e) to have been spawned',
    );
    assert.equal(watchdogArgs[0], '-e');
    const script = watchdogArgs[1] ?? '';
    assert.match(
      script,
      /spawn\('taskkill', \['\/PID', process\.argv\[1\], '\/T', '\/F'\], \{\s*stdio: 'ignore',\s*windowsHide: true/,
      `expected the watchdog script to run taskkill /PID <pid> /T /F, got: ${script}`,
    );
    assert.match(
      script,
      /\}, Number\(process\.argv\[2\]\)\);/,
      `expected the watchdog script to wait for the delay argument, got: ${script}`,
    );
    assert.match(
      watchdogArgs[2] ?? '',
      /^\d+$/,
      'expected the kill target pid as the second watchdog argument',
    );
    assert.equal(
      watchdogArgs[3],
      '5000',
      'expected the delay in milliseconds as the third watchdog argument',
    );
    // Options, not just argv (C1 review, kurone-kito/idd-skill#2892):
    // `detached: true` is load-bearing -- drop it and the watchdog dies with
    // the parent at `--invoke`'s `process.exit(0)`, silently disabling the
    // Windows backup deadline. A shell hop is what #5339 removes, so the
    // watchdog must not set `shell`.
    assert.notEqual(watchdogOptions?.shell, true);
    assert.equal(watchdogOptions?.detached, true);
    assert.equal(watchdogOptions?.stdio, 'ignore');
    assert.equal(watchdogOptions?.windowsHide, true);
  } finally {
    restore();
  }
});

/**
 * Counts the top-level windows of class `CASCADIA_HOSTING_WINDOW_CLASS`,
 * which Windows Terminal uses for its windows, visible or hidden. `Get-Process`
 * `MainWindowHandle` does not see those windows, so this uses EnumWindows.
 * Returns -1 when the count cannot be read.
 */
function countCascadiaWindows(): number {
  const script = [
    'Add-Type -TypeDefinition \'using System; using System.Text; using System.Runtime.InteropServices; public class IddCascadiaCount { public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); public static int Count(string cls) { int n = 0; EnumWindows(delegate(IntPtr h, IntPtr l) { StringBuilder s = new StringBuilder(256); GetClassName(h, s, 256); if (s.ToString() == cls) n++; return true; }, IntPtr.Zero); return n; } }\'',
    "[Console]::Out.Write([IddCascadiaCount]::Count('CASCADIA_HOSTING_WINDOW_CLASS'))",
  ].join('; ');
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8' },
    );
    const count = Number.parseInt(out.trim(), 10);
    return Number.isNaN(count) ? -1 : count;
  } catch {
    return -1;
  }
}

// kurone-kito/idd-skill#5339: on a Windows Terminal host, the whole file must
// leave the number of Windows Terminal windows unchanged. The check is a
// file-level before/after measurement, so it runs only when WT_SESSION is set
// and it assumes no other process opens such windows during the run.
let cascadiaWindowsBefore = -1;
if (process.platform === 'win32' && process.env.WT_SESSION) {
  before(() => {
    cascadiaWindowsBefore = countCascadiaWindows();
  });
  after(() => {
    const cascadiaWindowsAfter = countCascadiaWindows();
    assert.ok(
      cascadiaWindowsBefore >= 0 && cascadiaWindowsAfter >= 0,
      'expected the Windows Terminal window count to be readable',
    );
    assert.equal(
      cascadiaWindowsAfter - cascadiaWindowsBefore,
      0,
      `expected no new Windows Terminal window from this file, count went from ${cascadiaWindowsBefore} to ${cascadiaWindowsAfter}`,
    );
  });
}

test('invokeCritiqueTelemetryHook gives the win32 backup watchdog an environment without NODE_OPTIONS, matched case-insensitively (kurone-kito/idd-skill#5339)', async () => {
  // The watchdog is a `node` process, so an inherited NODE_OPTIONS preload
  // could stop it at startup. The relay branch strips the same variable for
  // the same reason. The test sets NODE_OPTIONS for its own duration.
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--no-warnings';
  let watchdogEnv: NodeJS.ProcessEnv | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    if (isWin32NodeWatchdogSpawn(args)) {
      watchdogEnv = (args[2] as { env?: NodeJS.ProcessEnv }).env;
    }
    return spawn(...args);
  }) as typeof spawn;

  const restore = stubExecutable(
    'idd-telemetry-hook-watchdog-env',
    'process.exit(0);\n',
  );
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-watchdog-env',
      samplePayload(),
      { timeoutMs: 5_000, spawnFn, platform: 'win32' },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    assert.ok(
      watchdogEnv,
      'expected the win32 watchdog to have been spawned with an explicit environment',
    );
    assert.deepEqual(
      Object.keys(watchdogEnv).filter(
        (key) => key.toUpperCase() === 'NODE_OPTIONS',
      ),
      [],
      'expected no NODE_OPTIONS key in the watchdog environment',
    );
    assert.equal(
      Object.keys(watchdogEnv).length,
      Object.keys(process.env).filter(
        (key) => key.toUpperCase() !== 'NODE_OPTIONS',
      ).length,
      'expected every other environment variable to pass through unchanged',
    );
  } finally {
    restore();
    if (previousNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previousNodeOptions;
    }
  }
});

test('watchdogEnvironment drops every NODE_OPTIONS spelling and keeps the other variables (kurone-kito/idd-skill#5350 review)', () => {
  // Windows environment names are case-insensitive, but the object this
  // function copies is not. Each spelling must be removed, so a mixed-case
  // key cannot keep a preload alive in the watchdog.
  const env = watchdogEnvironment({
    PATH: '/bin',
    NODE_OPTIONS: '--require /a.cjs',
    Node_Options: '--require /b.cjs',
    node_options: '--require /c.cjs',
    KEEP_ME: 'x',
  });
  assert.deepEqual(env, { PATH: '/bin', KEEP_ME: 'x' });
});

test('invokeCritiqueTelemetryHook keeps the win32 backup watchdog running while the hook runs, and ends it once the hook settles (kurone-kito/idd-skill#5339)', {
  skip: process.platform !== 'win32',
}, async () => {
  // The watchdog's delay is 10 s, and the hook exits on its own at 2.5 s.
  // Two checks follow from that. At 1 s, while the hook still runs, the
  // watchdog must be alive, which catches a watchdog that exits at once. After
  // the hook settles, the watchdog must be gone well before its own 10 s
  // delay, which catches a cancel path that never runs. Without the cancel,
  // the watchdog would still be alive at 7.5 s and the wait would fail.
  const watchdogs: ReturnType<typeof spawn>[] = [];
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    if (isWin32NodeWatchdogSpawn(args)) {
      watchdogs.push(child);
    }
    return child;
  }) as typeof spawn;

  const restore = stubExecutable(
    'idd-telemetry-hook-watchdog-alive',
    'setTimeout(() => process.exit(0), 2_500);\n',
  );
  try {
    const invocation = invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-watchdog-alive'),
      samplePayload(),
      { timeoutMs: 10_000, spawnFn, platform: 'win32' },
    );
    await delay(1_000);
    const watchdog = watchdogs[0];
    assert.ok(
      watchdog?.pid,
      'expected the win32 watchdog (process.execPath -e) to have been spawned',
    );
    assert.equal(
      watchdog.exitCode,
      null,
      'expected the watchdog to still be running 1 second after the hook started',
    );
    let alive = true;
    try {
      process.kill(watchdog.pid, 0);
    } catch {
      alive = false;
    }
    assert.ok(alive, 'expected the watchdog process to still exist');

    const result = await invocation;
    assert.deepEqual(result, { attempted: true, ok: true });
    assert.equal(
      await waitUntilProcessGone(watchdog.pid, 5_000),
      true,
      'expected the watchdog to be gone soon after the hook settled, not at its own 10 s delay',
    );
  } finally {
    restore();
  }
});

test('invokeCritiqueTelemetryHook win32 backup watchdog actually kills a real hung process, not just spawns with correct arguments (#2897 CI follow-up)', {
  skip: process.platform !== 'win32',
}, async (t) => {
  // Complements the command-shape test above (critique finding on PR
  // #2897): that test can pass even when the watchdog silently no-ops,
  // since it only asserts what was spawned, never whether the target
  // process actually died -- the exact gap that let the
  // detached-powershell regression ship unnoticed. This test exercises
  // the real, unmocked win32 path end to end. Runs on real Windows only:
  // the watchdog is real OS behavior, not something a `platform` override
  // can usefully fake from a non-Windows host.
  //
  // Isolation: the primary JS-level timer's own kill path
  // (killProcessGroup -> killProcessTreeWindows -> a direct, non-shell
  // `taskkill /PID <pid> /T /F`) is real and already confirmed working
  // (see this file's other tests), so left uncontrolled it would kill the
  // target on its own and this test would pass whether or not the
  // watchdog itself works. The injected spawnFn below neuters only that
  // direct taskkill call -- matched by args[0] === 'taskkill', which
  // never matches the watchdog's own `node -e` spawn -- so the watchdog is the only thing that can terminate the
  // target here.
  const restore = stubExecutable(
    'idd-telemetry-hook-watchdog-real-kill',
    'setInterval(() => {}, 1000);\n',
  );
  // kurone-kito/idd-skill#2910: on win32 the primary spawn is the relay
  // (`process.execPath` with `-e`), so `hookPid` below is the relay's
  // own pid, not the innermost stub script's pid -- exactly what
  // killProcessGroup/killProcessTreeWindows operate on in production.
  // The watchdog's `taskkill /PID <relay-pid> /T /F` still has to reach
  // through the relay's own `cmd.exe` hop to the real stub script to
  // terminate it, so checking whether the relay's pid is still alive
  // below still proves the watchdog's tree-kill actually worked.
  let hookPid: number | undefined;
  try {
    const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      if (args[0] === 'taskkill') {
        const fake = new EventEmitter() as unknown as ReturnType<typeof spawn>;
        (fake as unknown as { unref: () => void }).unref = () => undefined;
        return fake;
      }
      const child = spawn(...args);
      if (isWin32RelaySpawn(args)) {
        hookPid = child.pid;
      }
      return child;
    }) as typeof spawn;
    const startedAt = Date.now();
    await invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-watchdog-real-kill'),
      samplePayload(),
      { timeoutMs: 1_000, spawnFn },
    );
    assert.ok(hookPid, 'expected the relay to have a real pid');
    // Poll instead of a single fixed-delay sample (issue #3217): under
    // this repository's documented heavy concurrent-session scheduling
    // load, a cold `node` spawn plus its `taskkill` call can
    // take longer than a single fixed wait accounts for, even when the
    // watchdog works correctly. The 20s poll deadline is well inside this
    // job's 15-minute `timeout-minutes`.
    const gone = await waitUntilProcessGone(hookPid as number, 20_000);
    const elapsedMs = Date.now() - startedAt;
    if (gone) {
      t.diagnostic(`win32 watchdog killed pid ${hookPid} after ${elapsedMs}ms`);
    }
    assert.ok(
      gone,
      `expected the win32 watchdog to have killed pid ${hookPid} ` +
        `(elapsed ${elapsedMs}ms since invocation), but it is still running`,
    );
  } finally {
    restore();
    if (hookPid) {
      cleanupProcessTree(hookPid);
    }
  }
});

/** Scripted answers for one run of the win32 watchdog script (see
 * `runWatchdogScript`). The script runs in a real `node` child, and a preload
 * replaces `process.kill` and `child_process.spawn` inside that child. */
type WatchdogHarnessPlan = {
  /** Answers to the relay probes `process.kill(pid, 0)`, in call order: 'ok'
   * (alive), 'ESRCH' (gone), or 'EPERM' (alive, but refused). A call past the
   * end of the list answers 'ok'. */
  probes?: ReadonlyArray<'ok' | 'ESRCH' | 'EPERM'>;
  /** Pids whose `process.kill(pid, 'SIGKILL')` throws. The call is recorded first. */
  killThrows?: ReadonlyArray<number>;
  /** What the fake `taskkill` child does. */
  taskkill: 'started' | 'silent' | 'error' | 'throw' | 'error-after-spawn';
  /** What the fake PowerShell listing child does. Defaults to `never`. */
  listing?: WatchdogListingPlan;
};

/** What the fake PowerShell listing child does. `close` emits its stdout, then
 * 'close' with `code`. Without `text`, the stdout is `rows` as JSON, plus a row
 * for the script's own pid under `selfParentPid` (the preload knows that pid). */
type WatchdogListingPlan =
  | {
      mode: 'close';
      code?: number;
      rows?: ReadonlyArray<Record<string, unknown>>;
      text?: string;
      selfParentPid?: number;
    }
  | { mode: 'error' }
  | { mode: 'throw' }
  | { mode: 'never' };

/** One call the preload recorded, in the order the script made it. */
type WatchdogCall =
  | {
      kind: 'spawn';
      command: string;
      args: string[];
      options: Record<string, unknown>;
    }
  | { kind: 'probe'; pid: number; answer: string }
  | { kind: 'kill'; pid: number; signal: string }
  | { kind: 'child-kill'; command: string; signal: string | null };

type WatchdogRun = {
  status: number | null;
  stderr: string;
  elapsedMs: number;
  calls: WatchdogCall[];
};

/** The relay pid the script-only tests pass to the script. The probes are
 * scripted, so no such process has to exist. */
const FAKE_RELAY_PID = 61_001;

/** The descendant kills for `treeListingRows`, deepest first. */
const TREE_KILL_ORDER = [7102, 7101, 7201];

/**
 * A listing of one relay with a child, a sibling of that child, and a
 * grandchild below the child, in that order (kurone-kito/idd-skill#5382). Rows
 * use the PowerShell names `ProcessId` and `ParentProcessId`.
 */
function treeListingRows(relayPid: number): Array<Record<string, unknown>> {
  return [
    { ProcessId: relayPid, ParentProcessId: 4 },
    { ProcessId: 7101, ParentProcessId: relayPid },
    { ProcessId: 7201, ParentProcessId: relayPid },
    { ProcessId: 7102, ParentProcessId: 7101 },
  ];
}

/** A stand-in `ChildProcess` for a spawn that the test does not run: it emits
 * nothing and can be unref'd. */
function inertChildProcess(): RelayChild {
  const fake = new EventEmitter() as unknown as RelayChild;
  (fake as unknown as { unref: () => void }).unref = () => undefined;
  return fake;
}

/**
 * The watchdog script text that `invokeCritiqueTelemetryHook` passes on win32,
 * captured through an injected `spawnFn` (kurone-kito/idd-skill#5382). The hook
 * is a quick-exit stub, and the watchdog's own spawn gets an inert stand-in, so
 * no real watchdog runs.
 */
async function captureWin32WatchdogScript(): Promise<string> {
  let watchdogArgv: string[] | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    if (isWin32NodeWatchdogSpawn(args)) {
      watchdogArgv = args[1] as string[];
      return inertChildProcess();
    }
    return spawn(...args);
  }) as typeof spawn;
  const restore = stubExecutable(
    'idd-telemetry-hook-watchdog-script-capture',
    'process.exit(0);\n',
  );
  try {
    await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-watchdog-script-capture',
      samplePayload(),
      { timeoutMs: 5_000, spawnFn, platform: 'win32' },
    );
  } finally {
    restore();
  }
  const script = extractWatchdogScript(watchdogArgv);
  assert.ok(
    script.includes('taskkill'),
    'expected the win32 watchdog script to be captured',
  );
  return script;
}

/**
 * Source of the preload that the script child loads with `--require`. It
 * records every `process.kill` and `spawn` call to `recordPath`, one JSON line
 * per call, and answers them from `plan`. The fake children emit their events
 * on the next turn, after the script has attached its listeners.
 */
function watchdogHarnessPreload(
  recordPath: string,
  plan: WatchdogHarnessPlan,
): string {
  const config = {
    recordPath,
    probes: plan.probes ?? [],
    killThrows: plan.killThrows ?? [],
    taskkill: plan.taskkill,
    listing: plan.listing ?? { mode: 'never' },
  };
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const childProcess = require('node:child_process');",
    "const { EventEmitter } = require('node:events');",
    `const config = ${JSON.stringify(config)};`,
    'function record(entry) {',
    "  fs.appendFileSync(config.recordPath, JSON.stringify(entry) + '\\n');",
    '}',
    'let probeCount = 0;',
    'process.kill = (pid, signal) => {',
    '  if (signal === 0) {',
    "    const answer = config.probes[probeCount] ?? 'ok';",
    '    probeCount += 1;',
    "    record({ kind: 'probe', pid, answer });",
    "    if (answer === 'ok') {",
    '      return true;',
    '    }',
    '    const error = new Error(answer);',
    '    error.code = answer;',
    '    throw error;',
    '  }',
    "  record({ kind: 'kill', pid, signal });",
    '  if (config.killThrows.includes(pid)) {',
    "    const error = new Error('synthetic kill failure');",
    "    error.code = 'EPERM';",
    '    throw error;',
    '  }',
    '  return true;',
    '};',
    'function fakeChild(command) {',
    '  const child = new EventEmitter();',
    '  child.stdout = new EventEmitter();',
    '  child.stdout.setEncoding = () => {};',
    '  child.unref = () => {};',
    '  child.kill = (signal) => {',
    "    record({ kind: 'child-kill', command, signal: signal ?? null });",
    '    return true;',
    '  };',
    '  return child;',
    '}',
    'childProcess.spawn = (command, args, options) => {',
    "  record({ kind: 'spawn', command, args, options: JSON.parse(JSON.stringify(options ?? {})) });",
    "  if (command === 'taskkill') {",
    "    if (config.taskkill === 'throw') {",
    "      throw new Error('synthetic taskkill spawn throw');",
    '    }',
    '    const child = fakeChild(command);',
    "    if (config.taskkill === 'started') {",
    "      setImmediate(() => child.emit('spawn'));",
    "      setTimeout(() => child.emit('exit', 0, null), 50);",
    "    } else if (config.taskkill === 'error') {",
    "      setImmediate(() => child.emit('error', new Error('synthetic taskkill spawn error')));",
    "    } else if (config.taskkill === 'error-after-spawn') {",
    "      setImmediate(() => child.emit('spawn'));",
    "      setTimeout(() => child.emit('error', new Error('synthetic late taskkill error')), 200);",
    '    }',
    '    return child;',
    '  }',
    '  const child = fakeChild(command);',
    '  const listing = config.listing;',
    "  if (listing.mode === 'throw') {",
    "    throw new Error('synthetic listing spawn throw');",
    '  }',
    "  if (listing.mode === 'error') {",
    "    setImmediate(() => child.emit('error', new Error('synthetic listing spawn error')));",
    "  } else if (listing.mode === 'close') {",
    '    const rows = (listing.rows ?? []).slice();',
    '    if (listing.selfParentPid !== undefined) {',
    '      rows.push({ ProcessId: process.pid, ParentProcessId: listing.selfParentPid });',
    '    }',
    '    const text = listing.text !== undefined ? listing.text : JSON.stringify(rows);',
    '    setImmediate(() => {',
    "      child.stdout.emit('data', text);",
    "      child.emit('close', listing.code ?? 0);",
    '    });',
    '  }',
    '  return child;',
    '};',
    '',
  ].join('\n');
}

/**
 * Runs the watchdog script text as the real watchdog runs it, with the delay
 * `0`: `node --require <preload> -e <script> <relayPid> 0`, with the environment
 * from `watchdogEnvironment()`. Returns the recorded calls, the exit status, and
 * the elapsed time, which includes the Node start with the preload.
 */
function runWatchdogScript(
  script: string,
  relayPid: number,
  plan: WatchdogHarnessPlan,
): WatchdogRun {
  const dir = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-watchdog-script-'),
  );
  const recordPath = join(dir, 'calls.jsonl');
  const preloadPath = join(dir, 'preload.cjs');
  writeFileSync(preloadPath, watchdogHarnessPreload(recordPath, plan));
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ['--require', preloadPath, '-e', script, String(relayPid), '0'],
    {
      env: watchdogEnvironment(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 20_000,
    },
  );
  const elapsedMs = Date.now() - startedAt;
  const calls = existsSync(recordPath)
    ? readFileSync(recordPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as WatchdogCall)
    : [];
  return { status: result.status, stderr: result.stderr, elapsedMs, calls };
}

/** The recorded calls of one kind, in order. */
function callsOf<K extends WatchdogCall['kind']>(
  run: WatchdogRun,
  kind: K,
): Array<Extract<WatchdogCall, { kind: K }>> {
  return run.calls.filter(
    (call): call is Extract<WatchdogCall, { kind: K }> => call.kind === kind,
  );
}

/**
 * Asserts what every script run must hold: exit code 0, empty stderr, an exit
 * by itself within `boundMs`, and no spawn other than the tree kill and at most
 * one listing (kurone-kito/idd-skill#5382).
 */
function assertWatchdogRunClean(run: WatchdogRun, boundMs: number): void {
  assert.equal(
    run.status,
    0,
    `expected exit code 0, got ${run.status}; stderr: ${run.stderr}`,
  );
  assert.equal(run.stderr, '', 'expected empty stderr');
  assert.ok(
    run.elapsedMs < boundMs,
    `expected the script to exit by itself within ${boundMs} ms, took ${run.elapsedMs} ms`,
  );
  const commands = callsOf(run, 'spawn').map((call) => call.command);
  for (const command of commands) {
    assert.ok(
      command === 'taskkill' || command === 'powershell.exe',
      `expected only taskkill and the listing to be spawned, got ${command}`,
    );
  }
  assert.ok(
    commands.filter((command) => command === 'powershell.exe').length <= 1,
    'expected at most one process listing',
  );
}

test('the win32 watchdog script ends nothing when its taskkill starts, and exits by itself (kurone-kito/idd-skill#5382)', async () => {
  const script = await captureWin32WatchdogScript();
  for (const taskkill of ['started', 'silent'] as const) {
    const run = runWatchdogScript(script, FAKE_RELAY_PID, { taskkill });
    const spawns = callsOf(run, 'spawn');
    assert.equal(spawns.length, 1, `${taskkill}: expected only taskkill`);
    assert.equal(spawns[0].command, 'taskkill');
    assert.deepEqual(spawns[0].args, [
      '/PID',
      String(FAKE_RELAY_PID),
      '/T',
      '/F',
    ]);
    assert.equal(spawns[0].options.stdio, 'ignore');
    assert.equal(spawns[0].options.windowsHide, true);
    assert.equal(spawns[0].options.detached, undefined);
    assert.deepEqual(
      run.calls.filter((call) => call.kind === 'probe' || call.kind === 'kill'),
      [],
      `${taskkill}: expected no process.kill call, probe included`,
    );
    assertWatchdogRunClean(run, 4_000);
  }
});

test('the win32 watchdog script ends the relay descendants deepest first, then the relay, when its taskkill reports an error (kurone-kito/idd-skill#5382)', async () => {
  const script = await captureWin32WatchdogScript();
  const run = runWatchdogScript(script, FAKE_RELAY_PID, {
    taskkill: 'error',
    listing: { mode: 'close', rows: treeListingRows(FAKE_RELAY_PID) },
  });
  const spawns = callsOf(run, 'spawn');
  assert.deepEqual(
    spawns.map((call) => call.command),
    ['taskkill', 'powershell.exe'],
    'expected the tree kill, then the listing',
  );
  assert.deepEqual(spawns[1].args, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WIN32_PROCESS_LIST_COMMAND,
  ]);
  assert.equal(spawns[1].options.windowsHide, true);
  assert.deepEqual(spawns[1].options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(spawns[1].options.detached, undefined);
  assert.equal(spawns[1].options.shell, undefined);
  // The relay is probed before the listing and again after it.
  assert.deepEqual(
    run.calls.map((call) => call.kind),
    ['spawn', 'probe', 'spawn', 'probe', 'kill', 'kill', 'kill', 'kill'],
  );
  const kills = callsOf(run, 'kill');
  assert.deepEqual(
    kills.map((call) => call.pid),
    [...TREE_KILL_ORDER, FAKE_RELAY_PID],
  );
  for (const kill of kills) {
    assert.equal(typeof kill.pid, 'number');
    assert.equal(kill.signal, 'SIGKILL');
  }
  assertWatchdogRunClean(run, 4_000);
});

test('the win32 watchdog script runs the same fallback when its taskkill throws, or reports an error after it started, once (kurone-kito/idd-skill#5382)', async () => {
  const script = await captureWin32WatchdogScript();
  for (const taskkill of ['throw', 'error-after-spawn'] as const) {
    const run = runWatchdogScript(script, FAKE_RELAY_PID, {
      taskkill,
      listing: { mode: 'close', rows: treeListingRows(FAKE_RELAY_PID) },
    });
    assert.deepEqual(
      callsOf(run, 'spawn').map((call) => call.command),
      ['taskkill', 'powershell.exe'],
      `${taskkill}: expected one listing, after the tree kill`,
    );
    assert.deepEqual(
      callsOf(run, 'kill').map((call) => call.pid),
      [...TREE_KILL_ORDER, FAKE_RELAY_PID],
      `${taskkill}: expected the same kills as the error case, once`,
    );
    assertWatchdogRunClean(run, 4_000);
  }
});

test('the win32 watchdog script ends nothing when the relay is already gone, or gone after the listing (kurone-kito/idd-skill#5382)', async () => {
  const script = await captureWin32WatchdogScript();
  // The first probe reports the relay gone: no listing, no kill.
  const first = runWatchdogScript(script, FAKE_RELAY_PID, {
    taskkill: 'error',
    probes: ['ESRCH'],
    listing: { mode: 'close', rows: treeListingRows(FAKE_RELAY_PID) },
  });
  assert.deepEqual(
    callsOf(first, 'spawn').map((call) => call.command),
    ['taskkill'],
    'expected no listing when the relay is already gone',
  );
  assert.deepEqual(callsOf(first, 'kill'), []);
  assertWatchdogRunClean(first, 4_000);
  // The relay is alive at the first probe but gone at the second: the listing
  // runs, and nothing is killed.
  const second = runWatchdogScript(script, FAKE_RELAY_PID, {
    taskkill: 'error',
    probes: ['ok', 'ESRCH'],
    listing: { mode: 'close', rows: treeListingRows(FAKE_RELAY_PID) },
  });
  assert.equal(callsOf(second, 'spawn').length, 2);
  assert.deepEqual(callsOf(second, 'kill'), []);
  assertWatchdogRunClean(second, 4_000);
});

test('the win32 watchdog script treats an EPERM probe as a live relay and still ends it (kurone-kito/idd-skill#5382)', async () => {
  const script = await captureWin32WatchdogScript();
  for (const probes of [['EPERM'], ['ok', 'EPERM']] as const) {
    const run = runWatchdogScript(script, FAKE_RELAY_PID, {
      taskkill: 'error',
      probes: [...probes],
      listing: { mode: 'close', rows: treeListingRows(FAKE_RELAY_PID) },
    });
    assert.deepEqual(
      callsOf(run, 'kill').map((call) => call.pid),
      [...TREE_KILL_ORDER, FAKE_RELAY_PID],
      `probes ${probes.join(',')}: expected the same kills as the successful probes`,
    );
    assertWatchdogRunClean(run, 4_000);
  }
});

test('the win32 watchdog script ends only the relay when the listing fails (kurone-kito/idd-skill#5382)', async () => {
  const script = await captureWin32WatchdogScript();
  const failures: Array<{ label: string; listing: WatchdogListingPlan }> = [
    {
      label: 'a non-zero exit',
      listing: {
        mode: 'close',
        code: 1,
        rows: treeListingRows(FAKE_RELAY_PID),
      },
    },
    {
      label: 'text that is not JSON',
      listing: { mode: 'close', text: 'not json' },
    },
    { label: 'an error event', listing: { mode: 'error' } },
    { label: 'a synchronous throw', listing: { mode: 'throw' } },
  ];
  for (const { label, listing } of failures) {
    const run = runWatchdogScript(script, FAKE_RELAY_PID, {
      taskkill: 'error',
      listing,
    });
    assert.deepEqual(
      callsOf(run, 'kill').map((call) => call.pid),
      [FAKE_RELAY_PID],
      `${label}: expected only the relay to be ended`,
    );
    assertWatchdogRunClean(run, 4_000);
  }
});

test('the win32 watchdog script ends only the relay, and reaps its listing, when the listing never finishes (kurone-kito/idd-skill#5382)', async () => {
  const script = await captureWin32WatchdogScript();
  const run = runWatchdogScript(script, FAKE_RELAY_PID, {
    taskkill: 'error',
    listing: { mode: 'never' },
  });
  assert.deepEqual(
    callsOf(run, 'kill').map((call) => call.pid),
    [FAKE_RELAY_PID],
    'expected only the relay to be ended',
  );
  assert.ok(
    callsOf(run, 'child-kill').some(
      (call) => call.command === 'powershell.exe',
    ),
    'expected the listing to be ended through its handle kill()',
  );
  assertWatchdogRunClean(run, 10_000);
});

test('the win32 watchdog script keeps ending the rest when one kill throws (kurone-kito/idd-skill#5382)', async () => {
  const script = await captureWin32WatchdogScript();
  const descendantThrows = runWatchdogScript(script, FAKE_RELAY_PID, {
    taskkill: 'error',
    killThrows: [7102],
    listing: { mode: 'close', rows: treeListingRows(FAKE_RELAY_PID) },
  });
  assert.deepEqual(
    callsOf(descendantThrows, 'kill').map((call) => call.pid),
    [...TREE_KILL_ORDER, FAKE_RELAY_PID],
    'expected the remaining descendants and the relay to still be ended',
  );
  assertWatchdogRunClean(descendantThrows, 4_000);
  const relayThrows = runWatchdogScript(script, FAKE_RELAY_PID, {
    taskkill: 'error',
    killThrows: [FAKE_RELAY_PID],
    listing: { mode: 'close', rows: treeListingRows(FAKE_RELAY_PID) },
  });
  assert.deepEqual(
    callsOf(relayThrows, 'kill').map((call) => call.pid),
    [...TREE_KILL_ORDER, FAKE_RELAY_PID],
    'expected every kill to be attempted when the relay kill throws',
  );
  assertWatchdogRunClean(relayThrows, 4_000);
});

/**
 * The table's listing as the awaited path reads it: `pid` and `parentPid`. It
 * covers a deep chain below the relay, siblings, a parent outside the relay's
 * tree, a non-numeric and a missing pid, a duplicate, the relay itself, and a
 * cycle the relay does not reach (kurone-kito/idd-skill#5382).
 */
function listingTableRecords(
  relayPid: number,
): Array<{ pid?: unknown; parentPid?: unknown }> {
  // Every fixture pid is an offset from the relay pid, so none can equal the
  // relay, or the pid of a real process the runner may own (CodeRabbit,
  // kurone-kito/idd-skill#5382).
  const at = (offset: number): number => relayPid + offset;
  return [
    { pid: at(101), parentPid: relayPid },
    { pid: at(102), parentPid: at(101) },
    { pid: at(103), parentPid: at(102) },
    { pid: at(201), parentPid: relayPid },
    { pid: at(202), parentPid: at(201) },
    { pid: at(301), parentPid: at(9_990_001) },
    { pid: 'x7401', parentPid: relayPid },
    { parentPid: relayPid },
    { pid: at(101), parentPid: relayPid },
    { pid: relayPid, parentPid: relayPid },
    { pid: at(501), parentPid: at(502) },
    { pid: at(502), parentPid: at(501) },
  ];
}

/** The same records as the PowerShell listing writes them. */
function toListingRows(
  records: Array<{ pid?: unknown; parentPid?: unknown }>,
): Array<Record<string, unknown>> {
  return records.map((record) => ({
    ProcessId: record.pid,
    ParentProcessId: record.parentPid,
  }));
}

/** The descendant kills that listingTableRecords must produce, deepest first. */
function tableDescendantKills(relayPid: number): number[] {
  return [103, 102, 202, 101, 201].map((offset) => relayPid + offset);
}

test('the win32 watchdog script and the awaited path end the same descendants in the same order (kurone-kito/idd-skill#5382)', async () => {
  // The awaited side: a real relay, a failing taskkill, and the injected listing.
  const awaited = await runFakeCollectorTimeout(
    'idd-telemetry-hook-table-parity',
    (relayPid: number) =>
      listingTableRecords(relayPid) as unknown as ReadonlyArray<{
        pid: number;
        parentPid: number;
      }>,
  );
  const relayPid = awaited.relayPid;
  // The script side: the same listing, through the watchdog's own copy.
  const script = await captureWin32WatchdogScript();
  const run = runWatchdogScript(script, relayPid, {
    taskkill: 'error',
    listing: {
      mode: 'close',
      rows: toListingRows(listingTableRecords(relayPid)),
      selfParentPid: relayPid,
    },
  });
  const kills = callsOf(run, 'kill');
  assert.equal(
    kills[kills.length - 1]?.pid,
    relayPid,
    'expected the relay to be the last kill',
  );
  assert.equal(kills[kills.length - 1]?.signal, 'SIGKILL');
  const scriptDescendants = kills.slice(0, -1).map((call) => call.pid);
  assert.ok(
    tableDescendantKills(relayPid).length > 0,
    'expected a non-empty table of kills',
  );
  assert.deepEqual(
    awaited.killed,
    tableDescendantKills(relayPid),
    'expected the awaited path to end the table descendants in order',
  );
  assert.deepEqual(
    scriptDescendants,
    awaited.killed,
    'expected the script to end the same descendants in the same order',
  );
  assertWatchdogRunClean(run, 4_000);
});

test('the win32 watchdog script contains no exec, execFile, or execSync call (kurone-kito/idd-skill#5382)', async () => {
  const script = await captureWin32WatchdogScript();
  assert.doesNotMatch(script, /\bexec(?:File|Sync)?\b/u);
});

/**
 * A preload for the watchdog process (kurone-kito/idd-skill#5382). Its
 * `taskkill` spawn emits an 'error' event, as a spawn that cannot start does,
 * so the real watchdog takes its descendant fallback. It writes `markerPath`
 * when it does so, which proves that the preload was loaded. Every other spawn
 * is real.
 */
function unstartableTaskkillPreloadSource(markerPath: string): string {
  return [
    "'use strict';",
    "const childProcess = require('node:child_process');",
    "const { EventEmitter } = require('node:events');",
    'const realSpawn = childProcess.spawn;',
    'childProcess.spawn = function (command, ...rest) {',
    "  if (command === 'taskkill') {",
    `    require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'intercepted');`,
    '    const fake = new EventEmitter();',
    '    fake.unref = () => {};',
    "    setImmediate(() => fake.emit('error', new Error('synthetic taskkill spawn error')));",
    '    return fake;',
    '  }',
    '  return realSpawn.call(this, command, ...rest);',
    '};',
    '',
  ].join('\n');
}

test('the win32 watchdog ends a real hook descendant tree when its own taskkill cannot start, and spares a process outside it (kurone-kito/idd-skill#5382)', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-watchdog-real-fallback-'),
  );
  const pidPath = join(dir, 'pids.json');
  const preloadPath = join(dir, 'unstartable-taskkill.cjs');
  const markerPath = join(dir, 'taskkill-intercepted.txt');
  writeFileSync(preloadPath, unstartableTaskkillPreloadSource(markerPath));
  const name = 'idd-telemetry-hook-watchdog-real-descendants';
  const restore = descendantStub(name, pidPath);
  // Started by the test, outside the relay's tree: it must still run afterwards.
  const bystander = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);'],
    { stdio: 'ignore', windowsHide: true },
  );
  let relayPid: number | undefined;
  let watchdogPid: number | undefined;
  let pids: DescendantPids | undefined;
  try {
    const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      // The in-process tree kill is neutered, so the watchdog is the only kill.
      if (args[0] === 'taskkill') {
        return inertChildProcess();
      }
      if (isWin32NodeWatchdogSpawn(args)) {
        // The watchdog's environment gets a preload that makes its own
        // taskkill spawn fail. The options are changed after
        // watchdogEnvironment() has built the environment.
        const options = args[2] as SpawnOptions;
        // NODE_OPTIONS reads a backslash as an escape, so a Windows path must
        // be passed with forward slashes, or the preload never loads.
        const preloadForNodeOptions = preloadPath.replace(/\\/g, '/');
        const watchdog = spawn(args[0], args[1] as string[], {
          ...options,
          env: {
            ...options.env,
            NODE_OPTIONS: `--require "${preloadForNodeOptions}"`,
          },
        });
        watchdogPid = watchdog.pid;
        return watchdog;
      }
      const child = spawn(...args);
      if (isWin32RelaySpawn(args)) {
        relayPid = child.pid;
      }
      return child;
    }) as typeof spawn;
    // The watchdog delay leaves the stub time to record its pids, which takes
    // two to three seconds on this host (a PowerShell lookup). The command is
    // stayAliveCommand(name), so the stub does not evaluate its stdin payload
    // as a script (kurone-kito/idd-skill#5382).
    const pending = invokeCritiqueTelemetryHook(
      stayAliveCommand(name),
      samplePayload(),
      {
        timeoutMs: 15_000,
        spawnFn,
        platform: 'win32',
      },
    );
    pids = await readDescendantPids(pidPath);
    assert.equal(pids.relay, relayPid, 'expected the recorded relay pid');
    await pending;
    const gone = await Promise.all([
      waitUntilProcessGone(pids.relay, 20_000),
      waitUntilProcessGone(pids.hook, 20_000),
      waitUntilProcessGone(pids.child, 20_000),
    ]);
    assert.deepEqual(
      gone,
      [true, true, true],
      `expected the watchdog to end the relay (${pids.relay}), the hook (${pids.hook}), and the child (${pids.child}) within 20 seconds`,
    );
    assert.ok(
      existsSync(markerPath),
      'expected the watchdog taskkill spawn to be made unstartable, so the fallback ran',
    );
    assert.ok(
      isProcessRunning(bystander.pid as number),
      'expected the process outside the relay tree to still be running',
    );
  } finally {
    restore();
    reapPid(bystander.pid);
    reapPid(watchdogPid);
    // The tree kill reaches the hook and its child even when the pids were
    // never recorded, which reapPid cannot do.
    if (relayPid) {
      cleanupProcessTree(relayPid);
    }
    if (pids) {
      reapPid(pids.hook);
      reapPid(pids.child);
    }
  }
});

/**
 * Lists the PIDs of every currently-running process with a visible top-level
 * window (a nonzero `MainWindowHandle`) -- the same signal Windows itself
 * uses to distinguish a console-subsystem process that actually shows a
 * window from one that does not. Real, unmocked native-Windows check, not an
 * `args`/option-shape assertion: `windowsHide: true`'s effectiveness is
 * exactly the kind of claim that a mocked `spawnFn` cannot verify (#2892
 * review, Copilot).
 */
function listVisibleWindowPids(): Set<string> {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -ExpandProperty Id',
    ],
    { encoding: 'utf8' },
  );
  return new Set(
    out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

test('invokeCritiqueTelemetryHook does not create a visible console window on win32, for a command that exits quickly or one that hangs and is killed (#2892 acceptance criterion, review follow-up)', {
  skip: process.platform !== 'win32',
}, async () => {
  // Issue #2892's third acceptance criterion ("does not create a new
  // visible console window ... for a command that exits quickly or is
  // killed on timeout") was left unverified through every prior round of
  // this fix -- the code comment on `windowsHide` in the source honestly
  // says so. This test closes that gap with a real, native-Windows check
  // using the unmocked `invokeCritiqueTelemetryHook` spawn path, covering
  // both halves of the acceptance criterion's wording.
  const quickRestore = stubExecutable(
    'idd-telemetry-hook-window-check-quick',
    'setTimeout(() => {}, 2_000);\n',
  );
  const hangRestore = stubExecutable(
    'idd-telemetry-hook-window-check-hang',
    'setInterval(() => {}, 1_000);\n',
  );
  try {
    // Half 1: a command that exits quickly on its own. Snapshot window
    // state WHILE it is still running (#2892 review, Copilot) --
    // `invokeCritiqueTelemetryHook` only resolves once the child has
    // already exited, so awaiting it before snapshotting would capture
    // state *after* the process (and any window that opened and closed
    // along with it) is already gone, silently passing even if a window
    // briefly appeared.
    const beforeQuick = listVisibleWindowPids();
    const quickPromise = invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-window-check-quick'),
      samplePayload(),
      { timeoutMs: 5_000 },
    );
    await delay(300);
    const duringQuick = listVisibleWindowPids();
    const newVisibleQuick = [...duringQuick].filter(
      (pid) => !beforeQuick.has(pid),
    );
    assert.deepEqual(
      newVisibleQuick,
      [],
      `expected no new visible-window process while the quick-exit command ran, saw PIDs: ${newVisibleQuick.join(', ')}`,
    );
    // Let the stub's own 2s sleep finish naturally, well within the 5s
    // timeoutMs, before moving on to Half 2.
    await quickPromise;

    // Half 2: a command that hangs and is killed on timeout.
    // kurone-kito/idd-skill#2910: on win32 the primary spawn is the relay
    // (`process.execPath` with `-e`), so `hangPid` below (used only for
    // this test's own cleanup, not an assertion) is the relay's pid.
    let hangPid: number | undefined;
    const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      if (isWin32RelaySpawn(args)) {
        hangPid = child.pid;
      }
      return child;
    }) as typeof spawn;
    const beforeHang = listVisibleWindowPids();
    const hangPromise = invokeCritiqueTelemetryHook(
      stayAliveCommand('idd-telemetry-hook-window-check-hang'),
      samplePayload(),
      { timeoutMs: 1_000, spawnFn },
    );
    await delay(300);
    const duringHang = listVisibleWindowPids();
    const newVisibleHang = [...duringHang].filter(
      (pid) => !beforeHang.has(pid),
    );
    assert.deepEqual(
      newVisibleHang,
      [],
      `expected no new visible-window process while the hung command ran (pre-kill), saw PIDs: ${newVisibleHang.join(', ')}`,
    );
    await hangPromise;
    if (hangPid) {
      cleanupProcessTree(hangPid);
    }
  } finally {
    // LIFO order: each stubExecutable() call captures PATH/NODE_OPTIONS as
    // they stood immediately before that call, so restoring in creation
    // order would have hangRestore() (created second, after quickRestore's
    // own stub was already prepended) overwrite NODE_OPTIONS back to a
    // `--require <quickRestore's already-deleted preload.cjs>` value --
    // breaking every subsequent test's own stubExecutable-based child
    // processes. Restore the most-recently-created stub first instead.
    hangRestore();
    quickRestore();
  }
});

/** Directory holding one `<stub name>.pid` record per fallback-test stub
 * (see `recordingStubBody`). Created on first use; the file-level `after`
 * hook below asserts that no recorded stub survives, then removes it. */
let stubPidDirectory: string | undefined;

function stubPidFile(name: string): string {
  if (stubPidDirectory === undefined) {
    stubPidDirectory = mkdtempSync(join(tmpdir(), 'idd-hook-stub-pids-'));
  }
  return join(stubPidDirectory, `${name}.pid`);
}

/** A stub's own record of itself: its pid, and the exact path of the program
 * it runs. Both are needed, because a pid can be reused by another invocation
 * of a stub with the same name, and only the full path tells them apart. */
type StubRecord = { pid: number; path: string };

/** Stub body that records its own pid and program path in `pidFile` as it
 * starts, then keeps running until it is killed. On win32 the stub is a
 * hardlink, so `process.execPath` is its own path; on POSIX the stub runs
 * `node <bodyPath>`, so `process.argv[1]` is its body path. The fallback tests
 * read the record back so they can end the stub directly, rather than through
 * the relay's pid, which is already dead by the time the cleanup runs. */
function recordingStubBody(pidFile: string): string {
  return (
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, ` +
    "String(process.pid) + '\\n' + " +
    "(process.platform === 'win32' ? process.execPath : process.argv[1]) + '\\n');\n" +
    'setInterval(() => {}, 1000);\n'
  );
}

/** Reads a stub's record. A torn or partial read does not match the full
 * two-line shape, so it is never taken as a record. */
function readStubRecord(pidFile: string): StubRecord | undefined {
  try {
    const match = /^([1-9]\d*)\n(.+)\n$/u.exec(readFileSync(pidFile, 'utf8'));
    return match ? { pid: Number(match[1]), path: match[2] } : undefined;
  } catch {
    return undefined;
  }
}

/** Waits up to `timeoutMs` for a stub to write its record. A stub that never
 * starts fails the test, since nothing was proven about it. */
async function waitForStubRecord(
  pidFile: string,
  timeoutMs: number,
): Promise<StubRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readStubRecord(pidFile);
    if (record !== undefined) {
      return record;
    }
    await delay(50);
  }
  assert.fail(
    `stub did not write its record ${pidFile} within ${timeoutMs} ms`,
  );
}

/** Ends a stub that a fallback test started, by its recorded pid. It acts only
 * while `recordedStubState` reports that pid as the running stub, since a
 * pid can be reused. On POSIX the stub shares the relay's process group, so
 * `cleanupProcessTree` may already have ended it; the check comes first, and
 * the direct SIGKILL is the fallback when the group kill did not reach it. */
function endRecordedStub(record: StubRecord): void {
  if (recordedStubState(record) !== 'running') {
    return;
  }
  const { pid } = record;
  if (process.platform === 'win32') {
    cleanupProcessTree(pid);
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** What the recorded stub's pid is now, judged against its full recorded path.
 * `running`: the pid is alive and runs exactly the recorded program. The pid
 * alone is not proof, because a pid can be reused, so the full executable
 * path (win32) or the full stub body path in the command line (POSIX) must
 * match as well.
 * `gone`: the pid no longer exists, or a successful lookup shows another
 * program owns it.
 * `unknown`: a probe or lookup failed and says nothing either way. Only
 * `running` may be acted on, so an unknown result never terminates a process
 * and never counts as a clean exit. */
type RecordedStubState = 'running' | 'gone' | 'unknown';

function recordedStubState(record: StubRecord): RecordedStubState {
  const { pid } = record;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // Only ESRCH proves the pid is gone. Any other probe error (EPERM, for
    // example) is inconclusive.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? 'gone'
      : 'unknown';
  }
  if (process.platform === 'win32') {
    const lookup = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (lookup.error !== undefined || lookup.status !== 0) {
      return 'unknown';
    }
    return lookup.stdout.trim().toLowerCase() === record.path.toLowerCase()
      ? 'running'
      : 'gone';
  }
  const lookup = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  if (lookup.error !== undefined || lookup.status !== 0) {
    return 'unknown';
  }
  return lookup.stdout.includes(record.path) ? 'running' : 'gone';
}

/** Polls until the recorded stub is `gone`, since a POSIX SIGKILL is delivered
 * asynchronously. Returns false if it is still `running` or `unknown` at the
 * deadline, so a stub that cannot be verified fails the test. */
async function waitUntilRecordedStubGone(
  record: StubRecord,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (recordedStubState(record) !== 'gone') {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(100);
  }
  return true;
}

after(async () => {
  const directory = stubPidDirectory;
  if (directory === undefined) {
    return;
  }
  stubPidDirectory = undefined;
  const survivors: string[] = [];
  try {
    for (const entry of readdirSync(directory)) {
      const name = entry.replace(/\.pid$/u, '');
      const record = readStubRecord(join(directory, entry));
      if (record === undefined) {
        continue;
      }
      // A stub that its own test's finally did not end is ended here, by its
      // verified record, so a failed cleanup cannot keep the worktree locked.
      // Every record is processed before anything is reported, so one
      // survivor cannot hide another.
      endRecordedStub(record);
      if (!(await waitUntilRecordedStubGone(record, 5_000))) {
        survivors.push(`${name} (pid ${record.pid})`);
      }
    }
    assert.deepEqual(
      survivors,
      [],
      `recorded stubs still running after their fallback tests: ${survivors.join(', ')}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invokeCritiqueTelemetryHook falls back to killing just the wrapper when the win32 taskkill spawn itself throws synchronously', async () => {
  // Covers killProcessGroup's win32 last-resort path (C1 review,
  // kurone-kito/idd-skill#2892): when killProcessTreeWindows's own
  // `spawnFn('taskkill', ...)` call throws synchronously (e.g. taskkill.exe
  // is somehow unresolvable), killProcessGroup falls back to
  // `child.kill('SIGKILL')` on the immediate wrapper -- the pre-fix
  // Windows behavior, kept only as a last resort -- rather than attempting
  // nothing at all.
  const stubName = 'idd-telemetry-hook-hang-win32-throw';
  const restore = stubExecutable(
    stubName,
    recordingStubBody(stubPidFile(stubName)),
  );
  try {
    let primaryChild: ReturnType<typeof spawn> | undefined;
    let stubRecord: StubRecord | undefined;
    const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      if (args[0] === 'taskkill') {
        throw new Error('synthetic taskkill spawn failure');
      }
      const child = spawn(...args);
      // kurone-kito/idd-skill#2910: see the win32 taskkill-on-timeout
      // test above for why `process.execPath` (not the raw command
      // string) now uniquely identifies the primary spawn on win32.
      if (isWin32RelaySpawn(args)) {
        primaryChild = child;
      }
      return child;
    }) as typeof spawn;

    try {
      const result = await invokeCritiqueTelemetryHook(
        stayAliveCommand('idd-telemetry-hook-hang-win32-throw'),
        samplePayload(),
        // Long enough that the relay has spawned its stub before the kill.
        { timeoutMs: 2_000, spawnFn, platform: 'win32' },
      );
      stubRecord = await waitForStubRecord(stubPidFile(stubName), 5_000);
      assert.deepEqual(result, { attempted: true, ok: false });
      assert.ok(
        primaryChild,
        'expected the primary command to have been spawned',
      );
      // `ChildProcess#kill('SIGKILL')` (unlike the negative-pid group kill
      // it replaces on win32, or the working `taskkill /T` tree-kill this
      // fallback stands in for) targets only the immediate wrapper pid --
      // it does NOT promise to reach a further descendant. Empirically
      // confirmed on this POSIX test host: `/bin/sh -c '<stub>'`, whose
      // stub script itself execs into a further `node` process, does not
      // collapse into a single pid here, so a plain single-pid kill can
      // leave that further process running -- the *same* structural gap
      // this whole issue exists to fix, exactly why this fallback is
      // documented as a last resort rather than the primary mechanism.
      // Assert only what `child.kill('SIGKILL')` actually guarantees: the
      // immediate wrapper process itself is gone.
      const gone = await waitUntilProcessGone(
        primaryChild?.pid as number,
        10_000,
      );
      assert.ok(
        gone,
        `expected the fallback single-process kill to have terminated the wrapper (pid ${primaryChild?.pid})`,
      );
    } finally {
      // See the assertion comment above: this fallback's own known
      // limitation can leave a real descendant behind, on any host --
      // including a real `windows-latest` CI run, where this fallback's
      // `child.kill('SIGKILL')` only reaches the immediate wrapper, same
      // as everywhere else. Reap it directly via cleanupProcessTree
      // (host-appropriate real tree-kill), so this test does not leak an
      // orphan into the rest of the suite (kurone-kito/idd-skill#2897 CI
      // finding: a POSIX-only `process.kill(-pid, ...)` here is silently
      // meaningless on a real Windows host and previously left this
      // exact orphan running for the rest of the job).
      const pid = primaryChild?.pid;
      if (typeof pid === 'number' && pid > 0) {
        cleanupProcessTree(pid);
      }
      // The stub is the process that outlives the relay here, so end it by
      // its own recorded pid. The relay's pid is no longer a valid handle.
      if (stubRecord !== undefined) {
        endRecordedStub(stubRecord);
      }
    }
  } finally {
    restore();
  }
});

test('invokeCritiqueTelemetryHook falls back to killing just the wrapper when the win32 taskkill spawn fails asynchronously (Codex review on PR #2897)', async () => {
  // Regression fixture, distinct from the synchronous-throw fallback test
  // above: killProcessGroup's own `if (!spawned)` fallback branch only
  // covers a `spawnFn('taskkill', ...)` call that throws *synchronously*.
  // The far more realistic real-world failure (e.g. `taskkill.exe`
  // unresolvable on `PATH`) instead returns a `ChildProcess` handle
  // normally and reports the failure *asynchronously* via that handle's
  // own `'error'` event -- by which point `killProcessTreeWindows` has
  // already returned `true` and `killProcessGroup`'s own fallback branch
  // has already been skipped. `killProcessTreeWindows` now attempts the
  // same last-resort single-process kill directly inside its own
  // `'error'` listener instead, so this async case does not silently
  // regress to "kill nothing at all". A fake `EventEmitter` standing in
  // for the real `taskkill` child (rather than an actually-unresolvable
  // binary, which is not reliably reproducible across environments)
  // always carries the production `'error'` listener already attached
  // by the time this test emits on it, so this does not hit the
  // listener-less-emitter reporting quirk the watchdog `'error'`-listener
  // test above documents and deliberately avoids.
  const stubName = 'idd-telemetry-hook-hang-win32-async-throw';
  const restore = stubExecutable(
    stubName,
    recordingStubBody(stubPidFile(stubName)),
  );
  try {
    let primaryChild: ReturnType<typeof spawn> | undefined;
    let stubRecord: StubRecord | undefined;
    const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      if (args[0] === 'taskkill') {
        const fakeKiller = new EventEmitter() as unknown as ReturnType<
          typeof spawn
        >;
        (fakeKiller as unknown as { unref: () => void }).unref = () => {};
        // Asynchronous, like a real spawn failure -- never emitted
        // synchronously from inside this spawnFn call itself, so
        // killProcessTreeWindows's own try/catch cannot see it either.
        queueMicrotask(() => {
          fakeKiller.emit(
            'error',
            new Error('synthetic asynchronous taskkill spawn failure'),
          );
        });
        return fakeKiller;
      }
      const child = spawn(...args);
      // kurone-kito/idd-skill#2910: see the win32 taskkill-on-timeout
      // test above for why `process.execPath` (not the raw command
      // string) now uniquely identifies the primary spawn on win32.
      if (isWin32RelaySpawn(args)) {
        primaryChild = child;
      }
      return child;
    }) as typeof spawn;

    try {
      const result = await invokeCritiqueTelemetryHook(
        stayAliveCommand('idd-telemetry-hook-hang-win32-async-throw'),
        samplePayload(),
        // Long enough that the relay has spawned its stub before the kill.
        { timeoutMs: 2_000, spawnFn, platform: 'win32' },
      );
      stubRecord = await waitForStubRecord(stubPidFile(stubName), 5_000);
      assert.deepEqual(result, { attempted: true, ok: false });
      assert.ok(
        primaryChild,
        'expected the primary command to have been spawned',
      );
      // Same guarantee (and same known limitation vs. a further
      // descendant) as `child.kill('SIGKILL')` in the synchronous-throw
      // fallback test above -- see that test's own comment.
      const gone = await waitUntilProcessGone(
        primaryChild?.pid as number,
        10_000,
      );
      assert.ok(
        gone,
        `expected the asynchronous-error fallback to have terminated the wrapper (pid ${primaryChild?.pid})`,
      );
    } finally {
      // See the assertion comment above: this fallback's own known
      // limitation can leave a real descendant behind, on any host. Reap
      // it directly via cleanupProcessTree, same as the synchronous-throw
      // fallback test above.
      const pid = primaryChild?.pid;
      if (typeof pid === 'number' && pid > 0) {
        cleanupProcessTree(pid);
      }
      // As in the synchronous-throw test above: end the stub by its own
      // recorded record, since the relay's pid is no longer a valid handle.
      if (stubRecord !== undefined) {
        endRecordedStub(stubRecord);
      }
    }
  } finally {
    restore();
  }
});

// --- win32 descendant kill on a failed tree kill (kurone-kito/idd-skill#5362) ---
//
// The timeout first asks `taskkill /T /F` to end the relay's whole tree, with
// no process listing before it. When that tree kill cannot be started (a
// synchronous throw, or an asynchronous 'error' event), the fallback lists the
// relay's descendants once, asynchronously, and ends them, deepest first,
// before it ends the relay. The fake-collector tests inject
// platform 'win32', so that branch runs on any host. The real-process tests
// need a real Windows process tree, so they run on win32 only.

type InvokeOptions = NonNullable<
  Parameters<typeof invokeCritiqueTelemetryHook>[2]
>;
type RelayChild = ReturnType<typeof spawn>;
type RelayState = { relay?: RelayChild };
type DescendantPids = { relay: number; hook: number; child: number };

/** Stub hook that records its own pid in `pidPath`, then stays alive, so a
 * test can end it directly. */
function recordingStayAliveStub(name: string, pidPath: string): () => void {
  return stubExecutable(
    name,
    `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
  );
}

/** Stub hook for the real-process tests. It starts a long-lived `ping` (a
 * non-Node process, so the stub's own preload is not re-entered by the
 * child). It records the relay's pid, its own pid, and the child's pid in
 * `pidPath`, then stays alive. The relay is found as the parent of the
 * stub's own parent: on win32 the hook runs under a `cmd.exe` wrapper, and
 * that wrapper runs under the relay. */
function descendantStub(name: string, pidPath: string): () => void {
  return stubExecutable(
    name,
    [
      "const { spawn, execFileSync } = require('node:child_process');",
      'const wrapperPid = process.ppid;',
      "const relayPid = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', \"(Get-CimInstance Win32_Process -Filter 'ProcessId=\" + wrapperPid + \"').ParentProcessId\"], { encoding: 'utf8', windowsHide: true }).trim());",
      // Resolved and validated before `ping` starts, so a failed lookup leaves
      // no `ping` behind that the test could not record for cleanup.
      "if (!Number.isSafeInteger(relayPid) || relayPid <= 0) { throw new Error('could not resolve the relay pid'); }",
      "const child = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });",
      `require('fs').writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ relay: relayPid, hook: process.pid, child: child.pid }));`,
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
}

/** Waits for a recording stub to write its pid, so the stub is running before
 * the timeout fires. */
async function awaitRecordedPid(pidPath: string): Promise<number> {
  return Number(await waitForNonEmptyFile(pidPath, 20_000));
}

async function readDescendantPids(pidPath: string): Promise<DescendantPids> {
  const pids = JSON.parse(
    await waitForNonEmptyFile(pidPath, 20_000),
  ) as DescendantPids;
  assert.ok(
    isPositivePid(pids.relay) &&
      isPositivePid(pids.hook) &&
      isPositivePid(pids.child),
    `expected the stub to record the relay's, its own, and its child's pids, got ${JSON.stringify(pids)}`,
  );
  return pids;
}

function isPositivePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort end of a leftover process, for a test's own `finally` block.
 * Does nothing when the pid is not running. */
function reapPid(pid: number | undefined): void {
  if (typeof pid !== 'number' || pid <= 0 || !isProcessRunning(pid)) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone; ignore.
  }
}

function reapRecordedPid(pidPath: string): void {
  try {
    reapPid(Number(readFileSync(pidPath, 'utf8')));
  } catch {
    // The stub never recorded its pid; nothing to reap.
  }
}

async function assertEnded(pid: number, label: string): Promise<void> {
  // An invalid pid would only poll until the timeout, so reject one first.
  assert.ok(isPositivePid(pid), `expected a real pid for ${label}, got ${pid}`);
  assert.ok(
    await waitUntilProcessGone(pid, 10_000),
    `expected ${label} (pid ${pid}) to have been ended within 10 seconds`,
  );
}

/**
 * `spawnFn` for the win32 descendant tests. The relay spawn is real and is kept
 * in `state.relay`. A `taskkill` aimed at that relay is answered by
 * `answerRelayTaskkill` instead of being run. Every other spawn is real, except
 * the win32 backup watchdog, which is refused (see the comment in the body).
 */
function relayTaskkillSpawnFn(
  state: RelayState,
  answerRelayTaskkill: (relay: RelayChild) => RelayChild,
): typeof spawn {
  return ((...args: Parameters<typeof spawn>) => {
    // The backup watchdog is refused here. Left running, it tree-kills the
    // relay on its own deadline, which can end the descendants before the
    // fallback under test runs, so the test would pass without the fix.
    if (isWin32NodeWatchdogSpawn(args)) {
      throw new Error('synthetic watchdog spawn failure');
    }
    const taskkillArgs =
      args[0] === 'taskkill' ? (args[1] as string[]) : undefined;
    if (state.relay && taskkillArgs?.[1] === String(state.relay.pid)) {
      return answerRelayTaskkill(state.relay);
    }
    const child = spawn(...args);
    if (isWin32RelaySpawn(args)) {
      state.relay = child;
    }
    return child;
  }) as typeof spawn;
}

/**
 * A stand-in for the `taskkill` child that reports its failure asynchronously,
 * through its own 'error' event, as a real failed spawn does. `beforeError`
 * runs first and may end the relay and wait for it. `afterError` runs right
 * after the 'error' event is emitted, which is after the production fallback
 * listener has run, so a test can tell when the fallback has finished.
 */
function asyncFailingKiller(
  beforeError: () => Promise<void>,
  afterError: () => void,
): RelayChild {
  const killer = new EventEmitter() as unknown as RelayChild;
  (killer as unknown as { unref: () => void }).unref = () => {};
  void beforeError().then(() => {
    killer.emit(
      'error',
      new Error('synthetic asynchronous taskkill spawn failure'),
    );
    afterError();
  });
  return killer;
}

/**
 * A stand-in for a `taskkill` child that starts and reports nothing else. Its
 * 'spawn' event is emitted on the next turn, after the code under test has
 * attached its listeners, as a real successful spawn does.
 */
function startedTaskkillKiller(): RelayChild {
  const killer = new EventEmitter() as unknown as RelayChild;
  (killer as unknown as { unref: () => void }).unref = () => {};
  setImmediate(() => {
    killer.emit('spawn');
  });
  return killer;
}

/**
 * Runs one win32 timeout whose `taskkill` spawn throws, with an injected
 * collector and kill, against a stub hook that records its own pid. The
 * stub's pid is awaited before the timeout fires, so the stub is running then.
 * Asserts that the relay was ended, and returns the result, the relay pid, and
 * every pid that was passed to `killPid`.
 */
async function runFakeCollectorTimeout(
  stubName: string,
  collectDescendants: InvokeOptions['collectDescendants'],
  killPid?: (pid: number) => void,
): Promise<{
  result: { attempted: boolean; ok: boolean };
  relayPid: number;
  killed: number[];
}> {
  const pidPath = join(
    makeTempDir(join(tmpdir(), 'idd-critique-telemetry-hook-fake-collector-')),
    'hook.pid',
  );
  const restore = recordingStayAliveStub(stubName, pidPath);
  const state: RelayState = {};
  const killed: number[] = [];
  try {
    const spawnFn = relayTaskkillSpawnFn(state, () => {
      throw new Error('synthetic taskkill spawn failure');
    });
    const pending = invokeCritiqueTelemetryHook(
      stayAliveCommand(stubName),
      samplePayload(),
      {
        timeoutMs: 3_000,
        spawnFn,
        platform: 'win32',
        collectDescendants,
        killPid: (pid) => {
          killed.push(pid);
          killPid?.(pid);
        },
      },
    );
    await awaitRecordedPid(pidPath);
    const result = await pending;
    const relayPid = state.relay?.pid as number;
    assert.ok(relayPid, 'expected the win32 relay to have been spawned');
    await assertEnded(relayPid, 'the relay');
    return { result, relayPid, killed };
  } finally {
    reapRecordedPid(pidPath);
    reapPid(state.relay?.pid);
    restore();
  }
}

test('invokeCritiqueTelemetryHook ends the win32 relay and its real hook descendants when the taskkill spawn throws (kurone-kito/idd-skill#5362)', {
  skip: process.platform !== 'win32',
}, async () => {
  const pidPath = join(
    makeTempDir(join(tmpdir(), 'idd-critique-telemetry-hook-real-throw-')),
    'pids.json',
  );
  const name = 'idd-telemetry-hook-real-descendants-throw';
  const restore = descendantStub(name, pidPath);
  const state: RelayState = {};
  let descendants: DescendantPids | undefined;
  try {
    const spawnFn = relayTaskkillSpawnFn(state, () => {
      throw new Error('synthetic taskkill spawn failure');
    });
    const pending = invokeCritiqueTelemetryHook(
      stayAliveCommand(name),
      samplePayload(),
      { timeoutMs: 20_000, spawnFn, platform: 'win32' },
    );
    // The hook records the relay's pid, its own pid, and its child's pid before
    // the timeout fires. The lookup of the relay pid takes about a second.
    descendants = await readDescendantPids(pidPath);
    const result = await pending;
    assert.deepEqual(result, { attempted: true, ok: false });
    const relayPid = state.relay?.pid as number;
    assert.ok(relayPid, 'expected the win32 relay to have been spawned');
    assert.equal(
      descendants.relay,
      relayPid,
      'expected the hook command to run under the relay, through its cmd.exe wrapper',
    );
    await assertEnded(relayPid, 'the relay');
    await assertEnded(descendants.hook, 'the hook command');
    await assertEnded(descendants.child, 'the hook command child process');
  } finally {
    reapPid(state.relay?.pid);
    reapPid(descendants?.child);
    reapPid(descendants?.hook);
    restore();
  }
});

test('invokeCritiqueTelemetryHook ends the win32 relay and its real hook descendants when the taskkill spawn reports an asynchronous error (kurone-kito/idd-skill#5362)', {
  skip: process.platform !== 'win32',
}, async () => {
  const pidPath = join(
    makeTempDir(join(tmpdir(), 'idd-critique-telemetry-hook-real-async-')),
    'pids.json',
  );
  const name = 'idd-telemetry-hook-real-descendants-async';
  const restore = descendantStub(name, pidPath);
  const state: RelayState = {};
  let descendants: DescendantPids | undefined;
  try {
    const spawnFn = relayTaskkillSpawnFn(state, () =>
      asyncFailingKiller(
        async () => {},
        () => {},
      ),
    );
    const pending = invokeCritiqueTelemetryHook(
      stayAliveCommand(name),
      samplePayload(),
      { timeoutMs: 20_000, spawnFn, platform: 'win32' },
    );
    descendants = await readDescendantPids(pidPath);
    const result = await pending;
    assert.deepEqual(result, { attempted: true, ok: false });
    const relayPid = state.relay?.pid as number;
    assert.ok(relayPid, 'expected the win32 relay to have been spawned');
    assert.equal(
      descendants.relay,
      relayPid,
      'expected the hook command to run under the relay, through its cmd.exe wrapper',
    );
    await assertEnded(relayPid, 'the relay');
    await assertEnded(descendants.hook, 'the hook command');
    await assertEnded(descendants.child, 'the hook command child process');
  } finally {
    reapPid(state.relay?.pid);
    reapPid(descendants?.child);
    reapPid(descendants?.hook);
    restore();
  }
});

test('invokeCritiqueTelemetryHook never passes a collected pid to killPid when its parent is neither the relay nor a collected descendant (kurone-kito/idd-skill#5362)', async () => {
  const { result, killed } = await runFakeCollectorTimeout(
    'idd-telemetry-hook-descendants-unknown-parent',
    (relayPid) => [
      { pid: 900011, parentPid: relayPid },
      // Its parent is neither the relay nor a collected descendant.
      { pid: 900012, parentPid: 900099 },
      // Reachable only through the rejected record above.
      { pid: 900013, parentPid: 900012 },
    ],
  );
  assert.deepEqual(result, { attempted: true, ok: false });
  assert.deepEqual(killed, [900011]);
});

test('invokeCritiqueTelemetryHook keeps ending the remaining descendants and the relay when killPid throws for one pid (kurone-kito/idd-skill#5362)', async () => {
  const { result, killed } = await runFakeCollectorTimeout(
    'idd-telemetry-hook-descendants-kill-throws',
    (relayPid) => [
      { pid: 900021, parentPid: relayPid },
      { pid: 900022, parentPid: 900021 },
    ],
    (pid) => {
      if (pid === 900022) {
        throw new Error('synthetic refused kill');
      }
    },
  );
  assert.deepEqual(result, { attempted: true, ok: false });
  // Deepest first, and the refused kill does not stop the one after it.
  assert.deepEqual(killed, [900022, 900021]);
});

test('invokeCritiqueTelemetryHook still ends the relay, and kills nothing else, when the descendant collector throws (kurone-kito/idd-skill#5362)', async () => {
  const { result, killed } = await runFakeCollectorTimeout(
    'idd-telemetry-hook-descendants-collector-throws',
    () => {
      throw new Error('synthetic collector failure');
    },
  );
  assert.deepEqual(result, { attempted: true, ok: false });
  assert.deepEqual(killed, []);
});

test('invokeCritiqueTelemetryHook treats a null descendant list as unknown and still ends the relay (kurone-kito/idd-skill#5362)', async () => {
  const { result, killed } = await runFakeCollectorTimeout(
    'idd-telemetry-hook-descendants-collector-null',
    () => null,
  );
  assert.deepEqual(result, { attempted: true, ok: false });
  assert.deepEqual(killed, []);
});

test('invokeCritiqueTelemetryHook ends no descendant when the relay has already exited by the time its taskkill failure is reported (kurone-kito/idd-skill#5362)', async () => {
  const name = 'idd-telemetry-hook-descendants-relay-exited';
  const pidPath = join(
    makeTempDir(join(tmpdir(), 'idd-critique-telemetry-hook-relay-exited-')),
    'hook.pid',
  );
  const restore = recordingStayAliveStub(name, pidPath);
  // A process the test started and the collector reports as a descendant. The
  // test ends it itself in `finally`; the code under test must not.
  const otherProcess = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);'],
    { stdio: 'ignore', windowsHide: true },
  );
  const state: RelayState = {};
  const killed: number[] = [];
  let fallbackRan = false;
  let collectorCalls = 0;
  try {
    const spawnFn = relayTaskkillSpawnFn(state, (relay) =>
      asyncFailingKiller(
        // End the relay, then wait until it has really exited. A synchronous
        // throw cannot wait for an event, so the failure is reported
        // asynchronously here.
        async () => {
          relay.kill('SIGKILL');
          await new Promise<void>((resolve) => {
            relay.once('exit', () => resolve());
          });
        },
        () => {
          fallbackRan = true;
        },
      ),
    );
    const pending = invokeCritiqueTelemetryHook(
      stayAliveCommand(name),
      samplePayload(),
      {
        timeoutMs: 3_000,
        spawnFn,
        platform: 'win32',
        collectDescendants: (relayPid) => {
          collectorCalls += 1;
          return [{ pid: otherProcess.pid as number, parentPid: relayPid }];
        },
        killPid: (pid) => {
          killed.push(pid);
        },
      },
    );
    await awaitRecordedPid(pidPath);
    const result = await pending;
    assert.deepEqual(result, { attempted: true, ok: false });
    // The invocation settles before the fallback runs, so wait for the
    // fallback before asserting that it ended nothing.
    for (let i = 0; i < 200 && !fallbackRan; i += 1) {
      await delay(50);
    }
    assert.ok(
      fallbackRan,
      'expected the asynchronous taskkill failure to reach the fallback',
    );
    assert.equal(
      collectorCalls,
      0,
      'expected no descendant listing once the relay had exited',
    );
    assert.deepEqual(
      killed,
      [],
      'expected no descendant to be ended once the relay had exited',
    );
    assert.ok(
      isProcessRunning(otherProcess.pid as number),
      'expected the collected process to still be running',
    );
  } finally {
    otherProcess.kill('SIGKILL');
    reapRecordedPid(pidPath);
    reapPid(state.relay?.pid);
    restore();
  }
});

test('invokeCritiqueTelemetryHook leaves a process that is not a descendant of the win32 relay running (kurone-kito/idd-skill#5362)', {
  skip: process.platform !== 'win32',
}, async () => {
  const pidPath = join(
    makeTempDir(join(tmpdir(), 'idd-critique-telemetry-hook-bystander-')),
    'hook.pid',
  );
  const name = 'idd-telemetry-hook-descendants-bystander';
  const restore = recordingStayAliveStub(name, pidPath);
  // Started by this test, not by the relay, so it is not in the relay's tree.
  const bystander = spawn('ping', ['-n', '60', '127.0.0.1'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const state: RelayState = {};
  try {
    const spawnFn = relayTaskkillSpawnFn(state, () => {
      throw new Error('synthetic taskkill spawn failure');
    });
    const pending = invokeCritiqueTelemetryHook(
      stayAliveCommand(name),
      samplePayload(),
      { timeoutMs: 3_000, spawnFn, platform: 'win32' },
    );
    await awaitRecordedPid(pidPath);
    const result = await pending;
    assert.deepEqual(result, { attempted: true, ok: false });
    const relayPid = state.relay?.pid as number;
    assert.ok(relayPid, 'expected the win32 relay to have been spawned');
    await assertEnded(relayPid, 'the relay');
    assert.ok(
      isProcessRunning(bystander.pid as number),
      'expected the process outside the relay tree to still be running',
    );
  } finally {
    bystander.kill('SIGKILL');
    reapRecordedPid(pidPath);
    reapPid(state.relay?.pid);
    restore();
  }
});

test('invokeCritiqueTelemetryHook makes no extra kill when the win32 taskkill tree kill succeeds (kurone-kito/idd-skill#5362)', {
  skip: process.platform !== 'win32',
}, async () => {
  const pidPath = join(
    makeTempDir(join(tmpdir(), 'idd-critique-telemetry-hook-tree-kill-ok-')),
    'hook.pid',
  );
  const name = 'idd-telemetry-hook-descendants-tree-kill-ok';
  const restore = recordingStayAliveStub(name, pidPath);
  const state: RelayState = {};
  const killed: number[] = [];
  try {
    // The real spawn is used throughout, so the real `taskkill /T /F` runs.
    // The backup watchdog is refused, as in relayTaskkillSpawnFn above.
    const spawnFn = ((...args: Parameters<typeof spawn>) => {
      if (isWin32NodeWatchdogSpawn(args)) {
        throw new Error('synthetic watchdog spawn failure');
      }
      const child = spawn(...args);
      if (isWin32RelaySpawn(args)) {
        state.relay = child;
      }
      return child;
    }) as typeof spawn;
    const pending = invokeCritiqueTelemetryHook(
      stayAliveCommand(name),
      samplePayload(),
      {
        timeoutMs: 3_000,
        spawnFn,
        platform: 'win32',
        collectDescendants: (relayPid) => [
          { pid: 900041, parentPid: relayPid },
        ],
        killPid: (pid) => {
          killed.push(pid);
        },
      },
    );
    const hookPid = await awaitRecordedPid(pidPath);
    const result = await pending;
    assert.deepEqual(result, { attempted: true, ok: false });
    const relayPid = state.relay?.pid as number;
    assert.ok(relayPid, 'expected the win32 relay to have been spawned');
    await assertEnded(relayPid, 'the relay');
    // The real tree kill must end the hook too, not only the relay.
    await assertEnded(hookPid, 'the hook command');
    assert.deepEqual(killed, []);
  } finally {
    reapPid(state.relay?.pid);
    reapRecordedPid(pidPath);
    restore();
  }
});

test('invokeCritiqueTelemetryHook makes no listing and no kill when the win32 taskkill spawn reports that it started (kurone-kito/idd-skill#5362)', async () => {
  const name = 'idd-telemetry-hook-descendants-taskkill-started';
  const pidPath = join(
    makeTempDir(
      join(tmpdir(), 'idd-critique-telemetry-hook-taskkill-started-'),
    ),
    'hook.pid',
  );
  const restore = recordingStayAliveStub(name, pidPath);
  const state: RelayState = {};
  let collectorCalls = 0;
  const killed: number[] = [];
  try {
    // The taskkill stand-in reports 'spawn' and nothing else, so the code under
    // test must trust the tree kill: no listing, and no per-pid kill.
    const spawnFn = relayTaskkillSpawnFn(state, () => startedTaskkillKiller());
    const pending = invokeCritiqueTelemetryHook(
      stayAliveCommand(name),
      samplePayload(),
      {
        timeoutMs: 3_000,
        spawnFn,
        platform: 'win32',
        collectDescendants: () => {
          collectorCalls += 1;
          return [];
        },
        killPid: (pid) => {
          killed.push(pid);
        },
      },
    );
    await awaitRecordedPid(pidPath);
    const result = await pending;
    assert.deepEqual(result, { attempted: true, ok: false });
    assert.equal(
      collectorCalls,
      0,
      'expected no descendant listing once taskkill reported that it started',
    );
    assert.deepEqual(killed, []);
  } finally {
    reapRecordedPid(pidPath);
    reapPid(state.relay?.pid);
    restore();
  }
});

test('invokeCritiqueTelemetryHook still ends the relay when an injected collector never settles (kurone-kito/idd-skill#5362)', async () => {
  const { result, killed } = await runFakeCollectorTimeout(
    'idd-critique-telemetry-hook-never-settles.mjs',
    () => new Promise(() => {}),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(killed, []);
});

test('invokeCritiqueTelemetryHook ends nothing when the relay exits while the win32 descendant listing runs (kurone-kito/idd-skill#5362)', async () => {
  const name = 'idd-telemetry-hook-descendants-relay-exits-during-listing';
  const pidPath = join(
    makeTempDir(join(tmpdir(), 'idd-critique-telemetry-hook-during-listing-')),
    'hook.pid',
  );
  const restore = recordingStayAliveStub(name, pidPath);
  const state: RelayState = {};
  const killed: number[] = [];
  let listingReturned = false;
  try {
    // taskkill cannot be started, so the fallback lists the descendants.
    const spawnFn = relayTaskkillSpawnFn(state, () => {
      throw new Error('synthetic taskkill spawn failure');
    });
    const pending = invokeCritiqueTelemetryHook(
      stayAliveCommand(name),
      samplePayload(),
      {
        timeoutMs: 3_000,
        spawnFn,
        platform: 'win32',
        collectDescendants: async (relayPid) => {
          // The relay exits while the listing is still running.
          const relay = state.relay as RelayChild;
          relay.kill('SIGKILL');
          await new Promise<void>((resolve) => {
            relay.once('exit', () => resolve());
          });
          listingReturned = true;
          return [{ pid: 900061, parentPid: relayPid }];
        },
        killPid: (pid) => {
          killed.push(pid);
        },
      },
    );
    await awaitRecordedPid(pidPath);
    const result = await pending;
    // The invocation can settle as soon as the relay exits, before the fallback
    // has finished. Wait for the listing to return, then for the fallback's
    // continuation to run.
    for (let i = 0; i < 200 && !listingReturned; i += 1) {
      await delay(50);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(listingReturned, 'expected the descendant listing to return');
    assert.deepEqual(result, { attempted: true, ok: false });
    assert.deepEqual(
      killed,
      [],
      'expected no descendant to be ended once the relay had exited',
    );
    await assertEnded(state.relay?.pid as number, 'the relay');
  } finally {
    reapRecordedPid(pidPath);
    reapPid(state.relay?.pid);
    restore();
  }
});

test('invokeCritiqueTelemetryHook disarms the watchdog once the hook exits well before timeoutMs (#2685 review, Codex)', async () => {
  // Regression fixture for the PID-reuse race: a hook that settles quickly
  // used to leave its watchdog asleep for the rest of timeoutMs, so a
  // process/group id it recycled inside that window could be killed by
  // mistake. `timeoutMs` here is deliberately large (well beyond this
  // test's own assertion deadline) -- if disarming did NOT happen, the
  // watchdog would still be alive (mid-`sleep`) when this test checks it,
  // proving the assertion actually exercises cancellation rather than the
  // watchdog's own natural, on-time expiry.
  let watchdogChild: ReturnType<typeof spawn> | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    if (isWatchdogSpawnCall(args)) {
      watchdogChild = child;
    }
    return child;
  }) as typeof spawn;

  const restore = stubExecutable(
    'idd-telemetry-hook-quick-exit',
    'process.exit(0);\n',
  );
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-quick-exit',
      samplePayload(),
      { timeoutMs: 30_000, spawnFn },
    );
    assert.deepEqual(result, { attempted: true, ok: true });

    assert.ok(watchdogChild, 'expected the watchdog to have been spawned');
    const watchdogPid = watchdogChild?.pid;
    assert.ok(
      typeof watchdogPid === 'number' && watchdogPid > 0,
      `expected the watchdog to report a pid, got ${watchdogPid}`,
    );
    const gone = await waitUntilProcessGone(watchdogPid as number, 10_000);
    assert.ok(
      gone,
      `expected the watchdog (pid ${watchdogPid}) to be killed once the hook exited, well before its own 30s timeoutMs sleep, but it is still running`,
    );
  } finally {
    restore();
  }
});

test("invokeCritiqueTelemetryHook attaches an 'error' listener to the watchdog, guarding against an asynchronous spawn failure (#2685 review, Codex)", async () => {
  // Regression fixture: `spawn('sh', ...)` for a shell that cannot be
  // started at all (e.g. no POSIX shell on `PATH`, notably a bare Windows
  // install) does not throw synchronously -- it still returns a
  // `ChildProcess` and emits `'error'` on it *asynchronously*, which
  // `spawnWatchdog`'s own `try`/`catch` around the `spawnFn(...)` call
  // cannot see. An `EventEmitter` with no `'error'` listener rethrows an
  // emitted `'error'` as an uncaught exception -- which would crash
  // whatever process called this hook, directly violating its "never
  // throws" contract.
  //
  // Asserting on the listener being attached (rather than actually
  // triggering and observing an uncaught exception end-to-end) is
  // deliberate: `node --test` tracks which async resources belong to which
  // test, and an exception thrown from a listener-less `EventEmitter`
  // fired via `queueMicrotask` from inside this test's body was observed,
  // empirically, to be attributed to a *different* ("after this test
  // ended") pseudo-test instead of failing this one -- see this commit's
  // message for the concrete repro. A direct check that the watchdog
  // carries an `'error'` listener is deterministic and avoids that
  // reporting quirk entirely, while still failing this test (with the
  // real fix reverted, `watchdogChild.listenerCount('error')` is `0`) --
  // manually verified against a version of the file without the fix,
  // instead of the fragile emit-and-observe alternative.
  let watchdogChild: ReturnType<typeof spawn> | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    if (isWatchdogSpawnCall(args)) {
      watchdogChild = child;
    }
    return child;
  }) as typeof spawn;

  const restore = stubExecutable(
    'idd-telemetry-hook-quick-exit-2',
    'process.exit(0);\n',
  );
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-quick-exit-2',
      samplePayload(),
      { timeoutMs: 30_000, spawnFn },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    assert.ok(watchdogChild, 'expected the watchdog to have been spawned');
    assert.ok(
      (watchdogChild?.listenerCount('error') ?? 0) > 0,
      "expected the watchdog to have an 'error' listener attached, guarding against an asynchronous spawn failure",
    );
  } finally {
    restore();
  }
});

test("invokeCritiqueTelemetryHook's onWatchdogArmed waits for the watchdog's own 'spawn' confirmation, not the synchronous spawnFn() return (kurone-kito/idd-skill#2897 CI finding)", async () => {
  // Regression fixture: a real `windows-latest` CI run showed --invoke's
  // near-immediate process.exit() could race ahead of the watchdog's own
  // OS process creation actually finishing, silently discarding it before
  // it ever existed -- see onWatchdogArmed's own doc comment for the full
  // evidence. This simulates that race deterministically instead of
  // relying on real Windows timing: a fake watchdog spawnFn returns an
  // `EventEmitter` standing in for the real `ChildProcess`, and only
  // emits `'spawn'` after a queued microtask -- never synchronously --
  // so `onWatchdogArmed` firing before that emit would prove the callback
  // is wired to the wrong signal (e.g. spawnFn's own synchronous return,
  // which is exactly what let the real race through). `.kill`/`.unref`
  // stubs are required: cancelWatchdog (invoked once the quick-exiting
  // primary hook below settles) calls both on whatever `spawnWatchdog`
  // returned, real `ChildProcess` or not.
  let armedCallCount = 0;
  let watchdogSpawnEmitted = false;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    if (isWatchdogSpawnCall(args)) {
      const fakeWatchdog = new EventEmitter() as unknown as ReturnType<
        typeof spawn
      >;
      const fakeWatchdogHandle = fakeWatchdog as unknown as {
        unref: () => void;
        kill: () => boolean;
      };
      fakeWatchdogHandle.unref = () => {};
      fakeWatchdogHandle.kill = () => true;
      queueMicrotask(() => {
        watchdogSpawnEmitted = true;
        fakeWatchdog.emit('spawn');
      });
      return fakeWatchdog;
    }
    return spawn(...args);
  }) as typeof spawn;

  const restore = stubExecutable(
    'idd-telemetry-hook-quick-exit-armed',
    'process.exit(0);\n',
  );
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-quick-exit-armed',
      samplePayload(),
      {
        timeoutMs: 30_000,
        spawnFn,
        onWatchdogArmed: () => {
          armedCallCount += 1;
          assert.ok(
            watchdogSpawnEmitted,
            "expected onWatchdogArmed to fire only after the watchdog's own 'spawn' event, not before",
          );
        },
      },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    assert.equal(
      armedCallCount,
      1,
      'expected onWatchdogArmed to fire exactly once',
    );
  } finally {
    restore();
  }
});

test('invokeCritiqueTelemetryHook signals payload delivery only after the last byte of a 500,000-character-scale payload was written (kurone-kito/idd-skill#3630)', async () => {
  // Deterministic counterpart to the process-level large-payload test:
  // instead of racing a real pipe and real scheduling, the fake child's
  // stdin accepts the payload one 64 KiB slice at a time, only when this
  // test releases a slice, and holds the write callback until the last one.
  // `onPayloadDelivered` must not fire before that point (a regression
  // that signalled delivery right after `end()` would fail here) and must
  // fire exactly once after it.
  const SLICE_BYTES = 64 * 1024;
  const bigPayload = { ...samplePayload(), padding: 'x'.repeat(500_000) };
  const expected = JSON.stringify(bigPayload);
  const sliceCount = Math.ceil(Buffer.byteLength(expected) / SLICE_BYTES);
  assert.ok(sliceCount >= 2, 'expected the payload to need several slices');

  const accepted: Buffer[] = [];
  let pending: { chunk: Buffer; offset: number; done: () => void } | undefined;
  const stdin = new Writable({
    highWaterMark: SLICE_BYTES,
    write(chunk: Buffer, _encoding, callback) {
      pending = { chunk, offset: 0, done: callback };
    },
  });
  // Hands the next slice to the fake pipe; completes the pending write
  // (`callback`) only with the last one. Returns whether that was the last.
  const releaseNextSlice = (): boolean => {
    assert.ok(pending, 'expected a chunk waiting on the fake pipe');
    const { chunk, offset, done } = pending;
    const slice = chunk.subarray(offset, offset + SLICE_BYTES);
    accepted.push(slice);
    pending.offset = offset + slice.length;
    if (pending.offset < chunk.length) {
      return false;
    }
    pending = undefined;
    done();
    return true;
  };

  const fakeChild = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  Object.assign(fakeChild, { stdin, kill: () => true, unref: () => {} });
  // No `pid`, so no backup watchdog is spawned; this spawn is the only one.
  const spawnFn: typeof spawn = (() => fakeChild) as unknown as typeof spawn;

  let deliveredCount = 0;
  const result = invokeCritiqueTelemetryHook('idd-fake-hook', bigPayload, {
    spawnFn,
    platform: 'linux',
    timeoutMs: 60_000,
    onPayloadDelivered: () => {
      deliveredCount += 1;
    },
  });

  for (let slice = 1; slice <= sliceCount; slice += 1) {
    await nextTurn();
    assert.equal(
      deliveredCount,
      0,
      `expected no delivery signal before slice ${slice} of ${sliceCount} was written`,
    );
    assert.equal(releaseNextSlice(), slice === sliceCount);
  }
  await nextTurn();
  assert.equal(
    deliveredCount,
    1,
    'expected exactly one delivery signal once the last slice was written',
  );
  assert.equal(
    Buffer.concat(accepted).toString('utf8'),
    expected,
    'expected every byte of the payload to reach the fake pipe',
  );

  // Let the fake hook "exit" so the returned promise settles and clears
  // the timeout timer.
  fakeChild.emit('exit', 0);
  assert.deepEqual(await result, { attempted: true, ok: true });
  assert.equal(deliveredCount, 1);
});

test('invokeCritiqueTelemetryHook falls back to the default timeout for a non-finite timeoutMs (#2685 review, Copilot)', async () => {
  // `?? DEFAULT_INVOKE_TIMEOUT_MS` alone only substitutes for
  // `null`/`undefined` -- a caller-supplied `NaN` would otherwise pass
  // straight through to `setTimeout`, which treats a non-finite delay as
  // firing on (near-)the next tick, killing a perfectly healthy hook
  // almost instantly instead of respecting the intended (here, implicitly
  // default) bound. Capture the watchdog's `sleep` argument via a spawnFn
  // spy to prove the sanitized value reached it, rather than waiting out
  // a real default-5s timeout in this test.
  let watchdogArgs: string[] | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    if (isWatchdogSpawnCall(args)) {
      watchdogArgs = args[1] as string[];
    }
    return spawn(...args);
  }) as typeof spawn;

  const restore = stubExecutable(
    'idd-telemetry-hook-quick-exit-3',
    'process.exit(0);\n',
  );
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-quick-exit-3',
      samplePayload(),
      { timeoutMs: Number.NaN, spawnFn },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    assert.ok(watchdogArgs, 'expected the watchdog to have been spawned');
    assert.equal(
      extractWatchdogDelaySeconds(watchdogArgs),
      5,
      `expected a NaN timeoutMs to fall back to the default 5s bound, got: ${extractWatchdogScript(watchdogArgs)}`,
    );
  } finally {
    restore();
  }
});

test('spawnWatchdog rounds a fractional timeoutMs up to a whole second (#2685 review, Copilot)', async () => {
  // Some POSIX `sleep` implementations only accept integer seconds; a
  // fractional argument (a `timeoutMs` not a multiple of 1000, as several
  // tests in this file configure) can make those implementations reject
  // or skip the delay, SIGKILLing (near-)immediately. Assert the
  // watchdog's `sleep` argument is always a whole number, rounded *up*
  // (never down, which could fire the backup before the primary JS-level
  // timer it exists to survive past).
  let watchdogArgs: string[] | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    if (isWatchdogSpawnCall(args)) {
      watchdogArgs = args[1] as string[];
    }
    return spawn(...args);
  }) as typeof spawn;

  const restore = stubExecutable(
    'idd-telemetry-hook-quick-exit-4',
    'process.exit(0);\n',
  );
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-quick-exit-4',
      samplePayload(),
      { timeoutMs: 1_500, spawnFn },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    assert.equal(
      extractWatchdogDelaySeconds(watchdogArgs),
      2,
      `expected timeoutMs: 1500 to round up to a 2s sleep, got: ${extractWatchdogScript(watchdogArgs)}`,
    );
  } finally {
    restore();
  }
});

test('invokeCritiqueTelemetryHook clamps a timeoutMs above the Node timer limit to the largest whole-second delay, for the win32 watchdog too (kurone-kito/idd-skill#5350)', async () => {
  // Node timers reset a delay above 2,147,483,647 ms to 1 ms. A 30-day request
  // must therefore reach the win32 watchdog as the clamped delay, not as the
  // raw value, or the backup would kill the hook almost at once.
  let watchdogArgs: string[] | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    if (isWin32NodeWatchdogSpawn(args)) {
      watchdogArgs = args[1] as string[];
    }
    return spawn(...args);
  }) as typeof spawn;

  const restore = stubExecutable(
    'idd-telemetry-hook-quick-exit-clamp',
    'process.exit(0);\n',
  );
  try {
    const result = await invokeCritiqueTelemetryHook(
      'idd-telemetry-hook-quick-exit-clamp',
      samplePayload(),
      { timeoutMs: 30 * 24 * 60 * 60 * 1000, spawnFn, platform: 'win32' },
    );
    assert.deepEqual(result, { attempted: true, ok: true });
    assert.ok(watchdogArgs, 'expected the win32 watchdog to have been spawned');
    assert.equal(
      watchdogArgs[3],
      '2147483000',
      'expected a 30-day timeoutMs to reach the watchdog as the largest whole-second Node timer delay',
    );
  } finally {
    restore();
  }
});

// --- CLI --invoke: fire-and-forget at the process boundary (#2679) -------
//
// The fixture acceptance criterion 3 asks for at the process-boundary
// level, not just the function-unit level above: a caller can pipe a
// payload into `... --invoke` and the process always exits 0 promptly,
// whether the resolved hook succeeds, fails, or doesn't exist.

test('CLI --invoke exits 0 with no output when no hook is configured', () => {
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-none-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(policyPath, JSON.stringify({}));
  const { stdout } = runCli(
    ['--policy', policyPath, '--invoke'],
    undefined,
    JSON.stringify(samplePayload()),
  );
  assert.equal(stdout, '');
});

test('CLI --invoke exits 0 promptly when the resolved hook command fails', () => {
  const restore = stubExecutable(
    'idd-telemetry-hook-cli-fail',
    'process.exit(1);\n',
  );
  try {
    const sandbox = makeTempDir(
      join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-fail-'),
    );
    const policyPath = join(sandbox, 'config.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        critiqueLoop: {
          telemetryHook: { command: 'idd-telemetry-hook-cli-fail' },
        },
      }),
    );
    const startedAt = Date.now();
    const { stdout } = runCli(
      ['--policy', policyPath, '--invoke'],
      undefined,
      JSON.stringify(samplePayload()),
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(stdout, '');
    assert.ok(
      elapsedMs < 30_000,
      `expected --invoke to return promptly, took ${elapsedMs}ms`,
    );
  } finally {
    restore();
  }
});

test('CLI --invoke does not wait for a hanging resolved hook up to its default 5s timeout, and the hook is still killed after the CLI exits (#2685 review, Copilot + Codex)', async () => {
  // The regression fixture for the core review finding: --invoke must not
  // itself block its caller for up to the hook's own timeoutMs (default
  // 5000ms) -- the CLI process must exit as soon as it has handed the
  // payload off, regardless of how long (or whether) the resolved command
  // ever finishes. Before the fix, this test would take >= 5000ms; the
  // bound below is comfortably under that while still generous for this
  // repository's documented heavy concurrent-session load.
  //
  // The second half proves the *other* half of the same review round: once
  // the CLI process (and with it, the JS-level timeout timer) is gone, the
  // hung hook must still not run forever -- only the detached watchdog can
  // enforce that deadline at this point, since nothing else survives to.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-hang-'),
  );
  const pidFile = join(sandbox, 'pid');
  const restore = stubExecutable(
    'idd-telemetry-hook-cli-hang',
    // Record this stub's own pid, then hang -- lets the assertions below
    // confirm it was actually killed, not merely that the CLI returned.
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      'setInterval(() => {}, 1000);\n',
  );
  try {
    const policyPath = join(sandbox, 'config.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        critiqueLoop: {
          telemetryHook: {
            command: stayAliveCommand('idd-telemetry-hook-cli-hang'),
          },
        },
      }),
    );
    const startedAt = Date.now();
    const { stdout } = runCli(
      ['--policy', policyPath, '--invoke'],
      undefined,
      JSON.stringify(samplePayload()),
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(stdout, '');
    // Generous vs. WATCHDOG_ARMED_TIMEOUT_MS's 3s bound (kurone-kito/idd-
    // skill#2892, #2897 CI follow-up): --invoke now also waits, separately
    // from payload delivery, for the backup watchdog's own spawn to be
    // confirmed one way or the other before exiting -- still comfortably
    // under the hook's own much longer 5s default timeout.
    assert.ok(
      elapsedMs < 6_000,
      `expected --invoke to return well under the hook's 5s default timeout even though it hangs, took ${elapsedMs}ms`,
    );

    // The CLI's own exit (fire-and-forget) races the spawned hook's
    // node-startup time -- the pid file may not exist yet at this exact
    // instant even though the CLI itself has already returned.
    const pid = Number(await waitForNonEmptyFile(pidFile, 5_000));
    assert.ok(
      Number.isInteger(pid) && pid > 0,
      `expected the hung hook to have written its own pid, got ${pid}`,
    );
    // This one waits out the CLI's *default* 5s timeout (no --invoke flag
    // overrides it), so the poll budget below is more generous than the
    // configured-short-timeout tests above.
    const gone = await waitUntilProcessGone(pid, 20_000);
    assert.ok(
      gone,
      `expected the hung hook (pid ${pid}) to be killed by the watchdog after the CLI process itself exited, but it is still running`,
    );
  } finally {
    restore();
  }
});

/** The CLI's own payload-delivery bound, `PAYLOAD_DELIVERY_TIMEOUT_MS` in
 * `src/scripts/idd-critique-telemetry-hook.mts`. That constant is private,
 * so the process-level tests mirror its value as a literal. */
const CLI_DELIVERY_BOUND_MS = 1_000;

/** How long the process-level payload tests wait for a stub hook to write
 * its received file (it starts a node process, so it can be slow under load). */
const RECEIVED_FILE_TIMEOUT_MS = 15_000;

/** How many times the large-payload test retries an attempt whose CLI took
 * at least {@link CLI_DELIVERY_BOUND_MS} before it gives up and skips. */
const LARGE_PAYLOAD_MAX_ATTEMPTS = 5;

test('CLI --invoke waits for a large payload to fully reach the hook before exiting (#2685 review, CodeRabbit)', async (t) => {
  // win32 (kurone-kito/idd-skill#2910): this test used to be skipped on
  // win32 -- the production spawn shape it exercises, `shell: true` +
  // `detached: true` + piped stdin, never delivered ANY stdin payload to
  // the target command on native Windows, at any size. #2910's fix
  // (a `shell: false` `node.exe` relay hop on win32 only, see
  // `WIN32_RELAY_SCRIPT`) resolves the underlying defect, so this test
  // now runs for real on every platform (unless every attempt below is
  // inconclusive and it skips), exercising the fixed, unmocked
  // `invokeCritiqueTelemetryHook` spawn path end to end.
  // Regression fixture: `runInvoke` used to fire `invokeCritiqueTelemetryHook`
  // and call `process.exit(0)` right after, without waiting for the stdin
  // write to the hook's pipe to actually finish -- fine for a small
  // payload that completes in a single synchronous write, but a payload
  // well over the OS pipe buffer (64KB on Linux) cannot land in one write
  // and needs the child to keep draining it across several event-loop
  // ticks; exiting mid-write would truncate what the hook receives.
  //
  // kurone-kito/idd-skill#3630: `--invoke` deliberately stops waiting for
  // the stdin handoff after `CLI_DELIVERY_BOUND_MS`, so under heavy load
  // the CLI can exit on that bound with only part of the payload delivered
  // -- which says nothing about the wait wiring. An attempt is therefore
  // conclusive only when the externally measured wall-clock time of the
  // whole CLI process stays strictly under that bound (the bound timer
  // starts after node startup, so a faster exit is caused by delivery
  // completing, or by an error path that the byte-exact assertion below
  // catches). Anything slower is retried in a fresh sandbox, and the test
  // skips when every attempt was inconclusive. The deterministic coverage
  // of the same wiring is the `invokeCritiqueTelemetryHook` backpressure
  // test above.
  const bigPayload = { ...samplePayload(), padding: 'x'.repeat(500_000) };
  const expected = JSON.stringify(bigPayload);
  const elapsedTimes: number[] = [];
  for (let attempt = 1; attempt <= LARGE_PAYLOAD_MAX_ATTEMPTS; attempt += 1) {
    // Fresh sandbox, received-file path and stub name per attempt, so a
    // straggler hook left by an earlier attempt can never satisfy or
    // corrupt this attempt's read.
    const sandbox = makeTempDir(
      join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-large-payload-'),
    );
    const receivedPath = join(sandbox, 'received.json');
    const pidPath = join(sandbox, 'pid');
    const stubName = `idd-telemetry-hook-capture-stdin-large-${attempt}`;
    const restore = stubExecutable(
      stubName,
      captureStdinStubSource(receivedPath, pidPath),
    );
    try {
      const policyPath = join(sandbox, 'config.json');
      writeFileSync(
        policyPath,
        JSON.stringify({
          critiqueLoop: {
            telemetryHook: { command: stayAliveCommand(stubName) },
          },
        }),
      );
      const startedAt = performance.now();
      const { stdout } = runCli(
        ['--policy', policyPath, '--invoke'],
        undefined,
        expected,
      );
      const elapsedMs = performance.now() - startedAt;
      elapsedTimes.push(Math.round(elapsedMs));
      assert.equal(stdout, '');
      // Generous vs. the 1s delivery bound -- proves the CLI still returns
      // promptly rather than waiting for the hook process itself (which,
      // unlike the hanging-hook test above, actually does exit quickly
      // here, but this test is about the write completing, not about the
      // hook's own runtime).
      assert.ok(
        elapsedMs < 5_000,
        `expected --invoke to return promptly even for a large payload, took ${Math.round(elapsedMs)}ms`,
      );
      if (elapsedMs >= CLI_DELIVERY_BOUND_MS) {
        continue;
      }
      t.diagnostic(
        `attempt ${attempt} of ${LARGE_PAYLOAD_MAX_ATTEMPTS} was conclusive (CLI took ${Math.round(elapsedMs)}ms)`,
      );
      const received = await waitForReceivedPayload(
        receivedPath,
        expected,
        RECEIVED_FILE_TIMEOUT_MS,
      );
      assert.equal(
        received,
        expected,
        'expected the hook to receive the full, untruncated payload',
      );
      return;
    } finally {
      // Whether the attempt was conclusive, inconclusive or failed, let its
      // hook exit before `restore()` removes the directory holding its
      // executable (a retry would otherwise race a still-running straggler).
      await waitForStubHookExit(pidPath, RECEIVED_FILE_TIMEOUT_MS);
      restore();
    }
  }
  t.skip(
    `every attempt took at least ${CLI_DELIVERY_BOUND_MS}ms (${elapsedTimes.join(', ')}ms, including node startup and the watchdog spawn wait), so none can show whether the wait wiring delivered the payload`,
  );
});

test('CLI --invoke waits for a small payload to fully reach the hook before exiting on win32 (kurone-kito/idd-skill#2910)', {
  // The large-payload test above covers win32 for a payload well over the
  // OS pipe buffer whenever one of its attempts is conclusive (it skips when
  // every attempt is inconclusive; the backpressure test above still covers
  // the delivery wiring then); #2910's own reproduction found the defect
  // was size-independent (0B and every size up to 500KB+ all failed
  // identically), so this test closes the acceptance criterion's other
  // explicit half -- a small (well under 1KB), single-write payload --
  // on real win32 specifically, where the relay hop actually matters.
  // POSIX needs no separate small-payload win32 case since it never took
  // the relay path to begin with.
  skip: process.platform !== 'win32',
}, async () => {
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-small-payload-'),
  );
  const receivedPath = join(sandbox, 'received.json');
  const restore = stubExecutable(
    'idd-telemetry-hook-capture-stdin-small',
    `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
  process.exit(0);
});
`,
  );
  try {
    const policyPath = join(sandbox, 'config.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        critiqueLoop: {
          telemetryHook: {
            command: stayAliveCommand('idd-telemetry-hook-capture-stdin-small'),
          },
        },
      }),
    );
    const expected = JSON.stringify(samplePayload());
    const { stdout } = runCli(
      ['--policy', policyPath, '--invoke'],
      undefined,
      expected,
    );
    assert.equal(stdout, '');

    const received = await waitForNonEmptyFile(receivedPath, 5_000);
    assert.equal(
      received,
      expected,
      'expected the hook to receive the full, untruncated small payload',
    );
  } finally {
    restore();
  }
});

test('CLI --invoke delivers a production-sized payload to a real hook byte for byte on every platform (kurone-kito/idd-skill#3630)', async () => {
  // Unlike the win32-only small-payload test above, this one never skips:
  // the payload the hook receives in production is a small JSON object
  // (241 bytes for a realistic one), so this is the test that exercises
  // the real `--invoke` spawn path at the size it actually runs at, on
  // every platform.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-production-'),
  );
  const receivedPath = join(sandbox, 'received.json');
  const pidPath = join(sandbox, 'pid');
  const stubName = 'idd-telemetry-hook-capture-stdin-production';
  const restore = stubExecutable(
    stubName,
    captureStdinStubSource(receivedPath, pidPath),
  );
  try {
    const policyPath = join(sandbox, 'config.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        critiqueLoop: {
          telemetryHook: { command: stayAliveCommand(stubName) },
        },
      }),
    );
    const expected = JSON.stringify(samplePayload());
    assert.ok(
      Buffer.byteLength(expected) <= 2_048,
      `expected a production-sized payload of at most 2 KiB, got ${Buffer.byteLength(expected)} bytes`,
    );
    const { stdout } = runCli(
      ['--policy', policyPath, '--invoke'],
      undefined,
      expected,
    );
    assert.equal(stdout, '');

    const received = await waitForReceivedPayload(
      receivedPath,
      expected,
      RECEIVED_FILE_TIMEOUT_MS,
    );
    assert.equal(
      received,
      expected,
      'expected the hook to receive the full, untruncated production-sized payload',
    );
  } finally {
    await waitForStubHookExit(pidPath, RECEIVED_FILE_TIMEOUT_MS);
    restore();
  }
});

test('CLI --invoke absorbs a resolution failure (malformed --policy file) instead of exiting non-zero (#2685 review, Codex)', () => {
  // loadPolicyConfig throws for an explicit --policy path that is missing
  // or malformed JSON -- deliberately, for the default (non-invoke) mode,
  // where that throw is the caller-visible signal. Under --invoke it must
  // not be: this is a pure observability hook, and the documented contract
  // is "always exits 0, never surfaces an error" regardless of why the
  // hook turned out to be unusable.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-malformed-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(policyPath, '{ not valid json');
  const isolatedHome = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-invoke-malformed-home-'),
  );
  const result = spawnSync(
    process.execPath,
    [CLI_PATH, '--policy', policyPath, '--invoke'],
    {
      encoding: 'utf8',
      timeout: 30_000,
      input: JSON.stringify(samplePayload()),
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        HOME: isolatedHome,
        XDG_CONFIG_HOME: '',
      },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('CLI --invoke exits 0 when a resolved hook succeeds', () => {
  const restore = stubExecutable(
    'idd-telemetry-hook-cli-ok',
    'process.exit(0);\n',
  );
  try {
    const sandbox = makeTempDir(
      join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-ok-'),
    );
    const policyPath = join(sandbox, 'config.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        critiqueLoop: {
          telemetryHook: { command: 'idd-telemetry-hook-cli-ok' },
        },
      }),
    );
    const { stdout } = runCli(
      ['--policy', policyPath, '--invoke'],
      undefined,
      JSON.stringify(samplePayload()),
    );
    assert.equal(stdout, '');
  } finally {
    restore();
  }
});

test('CLI --invoke exits 0 without hanging when stdin carries no payload at all', () => {
  // Distinct from the "no hook configured" case above: this exercises the
  // bounded stdin-read timeout itself (STDIN_READ_TIMEOUT_MS) rather than
  // an empty-but-terminated payload -- runCli's execFileSync always closes
  // stdin after writing `input`, so an empty string here still reaches
  // 'end' promptly; this asserts that path resolves cleanly too.
  const sandbox = makeTempDir(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-empty-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(policyPath, JSON.stringify({}));
  const { stdout } = runCli(['--policy', policyPath, '--invoke']);
  assert.equal(stdout, '');
});
