import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  buildCritiqueTelemetryHookPayload,
  buildCritiqueTelemetryHookReport,
  type CritiqueTelemetryHookPayload,
  invokeCritiqueTelemetryHook,
} from '../src/scripts/idd-critique-telemetry-hook.mts';
import { stubExecutable } from './test-utils.mts';

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
  const isolatedHome = mkdtempSync(
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
  const sandbox = mkdtempSync(
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
  const sandbox = mkdtempSync(
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
  const home = mkdtempSync(
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
  const home = mkdtempSync(
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
  const home = mkdtempSync(
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
  const sandbox = mkdtempSync(
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
  const sandbox = mkdtempSync(
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
 * exactly when an already-issued kill signal actually reaps the process. */
async function waitUntilProcessGone(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
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

/** The backup watchdog's own spawned binary name on this platform
 * (kurone-kito/idd-skill#2892): `sh` on POSIX, `powershell.exe` on win32 --
 * used by the spawnFn-spy tests below to pick the watchdog's own spawn
 * call out from every other spawnFn invocation in a round. */
const WATCHDOG_BINARY = process.platform === 'win32' ? 'powershell.exe' : 'sh';

/** Extracts the watchdog's own sleep-then-kill script from its captured
 * spawn args, regardless of platform: POSIX passes `['-c', script]` to
 * `sh`; win32 passes `[..., '-Command', script]` to `powershell.exe`. */
function extractWatchdogScript(args: string[] | undefined): string {
  if (!args) {
    return '';
  }
  if (process.platform === 'win32') {
    const commandIndex = args.indexOf('-Command');
    return commandIndex === -1 ? '' : (args[commandIndex + 1] ?? '');
  }
  return args[1] ?? '';
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
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-telemetry-hook-group-kill-'));
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
// This implementation environment has no native Windows runtime to
// verify against -- the new `windows-latest` CI job (added alongside this
// file) is the actual behavioral verification gate. These two tests give
// deterministic, non-CI coverage of the *argument construction* for the
// win32 kill path from any OS, using the injectable `platform` option the
// same way `spawnFn` is already injected for testability -- overriding
// `platform` only changes which of `killProcessGroup`/`spawnWatchdog`'s
// own branches this code takes; it does not change which real shell the
// still-real `shell: true` spawn below is interpreted by (that is always
// whatever the host OS actually provides).

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
      if (args[0] === stayAliveCommand('idd-telemetry-hook-hang-win32')) {
        primaryChild = child;
      }
      if (args[0] === 'taskkill') {
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
      // the taskkill branch. On this (non-Windows) test host, that spawn
      // is a real no-op (ENOENT, absorbed by its own 'error' listener), so
      // the real hanging process this test spawned is never actually
      // reaped by the code under test -- clean it up directly via the
      // real (POSIX) group-kill this host actually supports. (On the
      // `windows-latest` CI job this test also runs on, `taskkill` is the
      // real, working reaper instead, and this POSIX cleanup line is
      // itself the no-op -- harmless either way, since it is wrapped in
      // its own try/catch below.)
      const pid = primaryChild?.pid;
      if (typeof pid === 'number' && pid > 0) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  } finally {
    restore();
  }
});

test('invokeCritiqueTelemetryHook spawns a win32 backup watchdog (powershell.exe Start-Sleep + Start-Process taskkill -WindowStyle Hidden) when platform is overridden to win32', async () => {
  let watchdogArgs: string[] | undefined;
  let watchdogOptions: Record<string, unknown> | undefined;
  const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
    if (args[0] === 'powershell.exe') {
      watchdogArgs = args[1] as string[];
      watchdogOptions = args[2] as Record<string, unknown>;
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
      'expected the win32 watchdog (powershell.exe) to have been spawned',
    );
    assert.deepEqual(
      watchdogArgs?.slice(0, 4),
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden'],
      `expected powershell.exe's leading flags, got: ${JSON.stringify(watchdogArgs)}`,
    );
    assert.equal(watchdogArgs?.[4], '-Command');
    const script = watchdogArgs?.[5] ?? '';
    assert.match(
      script,
      /^Start-Sleep -Seconds 5; Start-Process -FilePath taskkill -ArgumentList '\/PID',\d+,'\/T','\/F' -WindowStyle Hidden -Wait$/,
      `expected the win32 watchdog script shape, got: ${script}`,
    );
    // Also assert the options object, not just argv (C1 review,
    // kurone-kito/idd-skill#2892): `detached: true` in particular is load-
    // bearing -- drop it and this watchdog would die together with the
    // parent the instant `--invoke`'s `process.exit(0)` fires, silently
    // disabling the entire Windows backup-deadline mechanism this issue
    // adds, with no argv-only assertion able to catch the regression.
    assert.equal(watchdogOptions?.detached, true);
    assert.equal(watchdogOptions?.stdio, 'ignore');
    assert.equal(watchdogOptions?.windowsHide, true);
  } finally {
    restore();
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
  const restore = stubExecutable(
    'idd-telemetry-hook-hang-win32-throw',
    'setInterval(() => {}, 1000);\n',
  );
  try {
    let primaryChild: ReturnType<typeof spawn> | undefined;
    const spawnFn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      if (args[0] === 'taskkill') {
        throw new Error('synthetic taskkill spawn failure');
      }
      const child = spawn(...args);
      if (args[0] === stayAliveCommand('idd-telemetry-hook-hang-win32-throw')) {
        primaryChild = child;
      }
      return child;
    }) as typeof spawn;

    try {
      const result = await invokeCritiqueTelemetryHook(
        stayAliveCommand('idd-telemetry-hook-hang-win32-throw'),
        samplePayload(),
        { timeoutMs: 500, spawnFn, platform: 'win32' },
      );
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
      // limitation can leave a real descendant behind on this (POSIX)
      // test host. Reap it directly via the real POSIX group-kill (the
      // process group persists under its original leader's pid even
      // after that leader has exited, as long as a member is still
      // alive), so this test does not leak an orphan into the rest of
      // the suite.
      const pid = primaryChild?.pid;
      if (typeof pid === 'number' && pid > 0) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  } finally {
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
    if (args[0] === WATCHDOG_BINARY) {
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
    if (args[0] === WATCHDOG_BINARY) {
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
    if (args[0] === WATCHDOG_BINARY) {
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
    const script = extractWatchdogScript(watchdogArgs);
    const expectedPattern =
      process.platform === 'win32' ? /^Start-Sleep -Seconds 5;/ : /^sleep 5;/;
    assert.match(
      script,
      expectedPattern,
      `expected a NaN timeoutMs to fall back to the default 5s bound, got: ${script}`,
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
    if (args[0] === WATCHDOG_BINARY) {
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
    const script = extractWatchdogScript(watchdogArgs);
    const expectedPattern =
      process.platform === 'win32' ? /^Start-Sleep -Seconds 2;/ : /^sleep 2;/;
    assert.match(
      script,
      expectedPattern,
      `expected timeoutMs: 1500 to round up to a 2s sleep, got: ${script}`,
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
  const sandbox = mkdtempSync(
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
    const sandbox = mkdtempSync(
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
  const sandbox = mkdtempSync(
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
    assert.ok(
      elapsedMs < 3_000,
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

test('CLI --invoke waits for a large payload to fully reach the hook before exiting (#2685 review, CodeRabbit)', async () => {
  // Regression fixture: `runInvoke` used to fire `invokeCritiqueTelemetryHook`
  // and call `process.exit(0)` right after, without waiting for the stdin
  // write to the hook's pipe to actually finish -- fine for a small
  // payload that completes in a single synchronous write, but a payload
  // well over the OS pipe buffer (64KB on Linux) cannot land in one write
  // and needs the child to keep draining it across several event-loop
  // ticks; exiting mid-write would truncate what the hook receives.
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-large-payload-'),
  );
  const receivedPath = join(sandbox, 'received.json');
  const restore = stubExecutable(
    'idd-telemetry-hook-capture-stdin',
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
            command: stayAliveCommand('idd-telemetry-hook-capture-stdin'),
          },
        },
      }),
    );
    const bigPayload = { ...samplePayload(), padding: 'x'.repeat(500_000) };
    const expected = JSON.stringify(bigPayload);
    const startedAt = Date.now();
    const { stdout } = runCli(
      ['--policy', policyPath, '--invoke'],
      undefined,
      expected,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(stdout, '');
    // Generous vs. PAYLOAD_DELIVERY_TIMEOUT_MS's 1s bound -- proves the CLI
    // still returns promptly rather than waiting for the hook process
    // itself (which, unlike the hanging-hook test above, actually does
    // exit quickly here, but this test is about the write completing, not
    // about the hook's own runtime).
    assert.ok(
      elapsedMs < 5_000,
      `expected --invoke to return promptly even for a large payload, took ${elapsedMs}ms`,
    );

    const received = await waitForNonEmptyFile(receivedPath, 5_000);
    assert.equal(
      received,
      expected,
      'expected the hook to receive the full, untruncated payload',
    );
  } finally {
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
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-malformed-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(policyPath, '{ not valid json');
  const isolatedHome = mkdtempSync(
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
    const sandbox = mkdtempSync(
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
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-critique-telemetry-hook-cli-invoke-empty-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(policyPath, JSON.stringify({}));
  const { stdout } = runCli(['--policy', policyPath, '--invoke']);
  assert.equal(stdout, '');
});
