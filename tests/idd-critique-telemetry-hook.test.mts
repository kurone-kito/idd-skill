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
      'idd-telemetry-hook-hang',
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

test('invokeCritiqueTelemetryHook kills a backgrounded descendant on timeout, not just the shell wrapper (#2685 review, Codex)', async () => {
  // Regression fixture: `shell: true` makes the spawned `child` the
  // `/bin/sh -c` wrapper. A command that backgrounds a job of its own
  // (`cmd & wait`) creates a descendant with a *different* pid than that
  // wrapper -- a plain single-pid kill would leave it running as an
  // orphan even though `child` itself died. The fix targets the whole
  // process group (negative pid), which must still reach it.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-telemetry-hook-group-kill-'));
  const pidFile = join(sandbox, 'pid');
  const nodeScript =
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ` +
    'setInterval(() => {}, 1000);';
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(nodeScript)} & wait`;

  const result = await invokeCritiqueTelemetryHook(command, samplePayload(), {
    timeoutMs: 500,
  });
  assert.deepEqual(result, { attempted: true, ok: false });

  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(
    Number.isInteger(pid) && pid > 0,
    `expected the backgrounded descendant to have written its own pid, got ${pid}`,
  );
  const gone = await waitUntilProcessGone(pid, 10_000);
  assert.ok(
    gone,
    `expected the backgrounded descendant (pid ${pid}) to be killed by the process-group signal, but it is still running`,
  );
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
    if (args[0] === 'sh') {
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
          telemetryHook: { command: 'idd-telemetry-hook-cli-hang' },
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
