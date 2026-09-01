import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCritiqueDelegateReport } from '../src/scripts/idd-critique-delegate.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/idd-critique-delegate.mjs');

/** Run the built CLI with a fully isolated HOME so the real operator's
 * user-global config (if any) never leaks into a test result, and return
 * the parsed JSON report. Also neutralizes GITHUB_ACTIONS: in CI, the test
 * runner's own environment carries it as "true", which would otherwise
 * leak into every spawned CLI process's inherited env and silently
 * trigger the GITHUB_ACTIONS auto-skip this suite tests separately as its
 * own behavior; pass `env: { GITHUB_ACTIONS: 'true' }` to opt back in. */
function runCli(args: string[], env?: NodeJS.ProcessEnv): unknown {
  const isolatedHome = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-home-'),
  );
  const output = execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      ...env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: '',
    },
  });
  return JSON.parse(output);
}

// buildCritiqueDelegateReport: every layer combination
// resolveEffectiveCritiqueLoopDelegate already covers (#2329's acceptance
// criteria), verified against the same fixtures policy-helpers.test.mts and
// idd-config.test.mts already use for the underlying resolver.

test('reports usable:true, source repository-local for a configured local delegate', () => {
  const report = buildCritiqueDelegateReport({
    localConfig: { critiqueLoop: { delegate: { command: 'local-review' } } },
  });
  assert.deepEqual(report, {
    usable: true,
    source: 'repository-local',
    command: 'local-review',
    mode: 'fallback',
    reason: null,
  });
});

test('reports the configured mode when present alongside command', () => {
  const report = buildCritiqueDelegateReport({
    localConfig: {
      critiqueLoop: { delegate: { command: 'local-review', mode: 'combined' } },
    },
  });
  assert.equal(report.usable, true);
  assert.equal(report.mode, 'combined');
});

test('reports usable:false, reason repository-local-explicit-disable for a null local delegate', () => {
  const report = buildCritiqueDelegateReport({
    localConfig: { critiqueLoop: { delegate: null } },
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'repository-local',
    command: null,
    mode: null,
    reason: 'repository-local-explicit-disable',
  });
});

test('a malformed repository-local delegate fails closed and never inherits a configured global delegate', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-malformed-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      critiqueLoop: { delegate: { command: 'global-review' } },
    }),
  );
  const report = buildCritiqueDelegateReport({
    localConfig: {
      critiqueLoop: { delegate: { command: 'x', mode: 'not-a-mode' } },
    },
    globalConfigPath: globalPath,
    env: {},
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'repository-local',
    command: null,
    mode: null,
    reason: 'invalid-repository-local-delegate',
  });
});

test('falls back to a configured user-global delegate only when local is entirely absent', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-critique-delegate-global-'));
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      critiqueLoop: { delegate: { command: 'global-review' } },
    }),
  );
  const report = buildCritiqueDelegateReport({
    localConfig: {},
    globalConfigPath: globalPath,
    env: {},
  });
  assert.deepEqual(report, {
    usable: true,
    source: 'user-global',
    command: 'global-review',
    mode: 'fallback',
    reason: null,
  });
});

test('consults an $HOME-resolved user-global delegate outside GITHUB_ACTIONS', () => {
  const home = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-remote-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({ critiqueLoop: { delegate: { command: 'home-review' } } }),
  );
  const report = buildCritiqueDelegateReport({
    localConfig: {},
    env: { HOME: home },
  });
  assert.deepEqual(report, {
    usable: true,
    source: 'user-global',
    command: 'home-review',
    mode: 'fallback',
    reason: null,
  });
});

test('skips the $HOME-resolved user-global delegate under GITHUB_ACTIONS=true (#2329 review)', () => {
  const home = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-remote-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({ critiqueLoop: { delegate: { command: 'home-review' } } }),
  );
  const report = buildCritiqueDelegateReport({
    localConfig: {},
    env: { HOME: home, GITHUB_ACTIONS: 'true' },
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'none',
    command: null,
    mode: null,
    reason: 'not-configured',
  });
});

test('skips the $HOME-resolved user-global delegate when noUserGlobal is passed explicitly, outside GITHUB_ACTIONS (#2329 review)', () => {
  const home = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-remote-home-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({ critiqueLoop: { delegate: { command: 'home-review' } } }),
  );
  const report = buildCritiqueDelegateReport(
    { localConfig: {}, env: { HOME: home } },
    true,
  );
  assert.deepEqual(report, {
    usable: false,
    source: 'none',
    command: null,
    mode: null,
    reason: 'not-configured',
  });
});

test('noUserGlobal also clears an explicitly supplied globalConfigPath, not just env (#2329 review)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-explicit-global-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      critiqueLoop: { delegate: { command: 'global-review' } },
    }),
  );
  const report = buildCritiqueDelegateReport(
    { localConfig: {}, globalConfigPath: globalPath, env: {} },
    true,
  );
  assert.deepEqual(report, {
    usable: false,
    source: 'none',
    command: null,
    mode: null,
    reason: 'not-configured',
  });
});

test('GITHUB_ACTIONS=true also clears an explicitly supplied globalConfigPath, not just env (#2329 review)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-explicit-global-ci-'),
  );
  const globalPath = join(sandbox, 'config.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      critiqueLoop: { delegate: { command: 'global-review' } },
    }),
  );
  const report = buildCritiqueDelegateReport({
    localConfig: {},
    globalConfigPath: globalPath,
    env: { GITHUB_ACTIONS: 'true' },
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'none',
    command: null,
    mode: null,
    reason: 'not-configured',
  });
});

test('noUserGlobal also clears an explicitly supplied homedir, not just env (#2329 review)', () => {
  const home = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-explicit-homedir-'),
  );
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({
      critiqueLoop: { delegate: { command: 'homedir-review' } },
    }),
  );
  const report = buildCritiqueDelegateReport(
    { localConfig: {}, homedir: home, env: {} },
    true,
  );
  assert.deepEqual(report, {
    usable: false,
    source: 'none',
    command: null,
    mode: null,
    reason: 'not-configured',
  });
});

test('reports usable:false, reason not-configured when neither layer has a delegate', () => {
  const report = buildCritiqueDelegateReport({
    localConfig: {},
    env: {},
  });
  assert.deepEqual(report, {
    usable: false,
    source: 'none',
    command: null,
    mode: null,
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
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-critique-delegate-cli-'));
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(policyPath, JSON.stringify({}));
  const report = runCli(['--policy', policyPath]) as {
    usable: boolean;
    source: string;
    reason: string | null;
  };
  assert.equal(report.usable, false);
  assert.equal(report.source, 'none');
  assert.equal(report.reason, 'not-configured');
});

test('CLI --policy resolves a configured local delegate to usable:true', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-cli-local-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(
    policyPath,
    JSON.stringify({ critiqueLoop: { delegate: { command: 'cli-review' } } }),
  );
  const report = runCli(['--policy', policyPath]) as {
    usable: boolean;
    source: string;
    command: string | null;
    mode: string | null;
  };
  assert.deepEqual(report, {
    usable: true,
    source: 'repository-local',
    command: 'cli-review',
    mode: 'fallback',
    reason: null,
  });
});

test('CLI --no-user-global skips an otherwise-picked-up $HOME delegate (#2329 review)', () => {
  const home = mkdtempSync(join(tmpdir(), 'idd-critique-delegate-cli-home-'));
  mkdirSync(join(home, '.config', 'idd-skill'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'idd-skill', 'config.json'),
    JSON.stringify({ critiqueLoop: { delegate: { command: 'home-review' } } }),
  );
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-critique-delegate-cli-empty-'),
  );
  const policyPath = join(sandbox, 'config.json');
  writeFileSync(policyPath, JSON.stringify({}));
  const commonEnv = {
    ...process.env,
    GITHUB_ACTIONS: '',
    HOME: home,
    XDG_CONFIG_HOME: '',
  };

  const withGlobal = execFileSync(
    process.execPath,
    [CLI_PATH, '--policy', policyPath],
    { encoding: 'utf8', timeout: 60_000, env: commonEnv },
  );
  assert.equal(JSON.parse(withGlobal).usable, true);

  const withoutGlobal = execFileSync(
    process.execPath,
    [CLI_PATH, '--policy', policyPath, '--no-user-global'],
    { encoding: 'utf8', timeout: 60_000, env: commonEnv },
  );
  assert.deepEqual(JSON.parse(withoutGlobal), {
    usable: false,
    source: 'none',
    command: null,
    mode: null,
    reason: 'not-configured',
  });
});
