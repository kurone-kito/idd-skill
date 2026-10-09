import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadLayeredLocalPolicy } from '../src/scripts/idd-config.mts';
import {
  buildEffectiveConfigKeyReport,
  buildEffectiveConfigReport,
} from '../src/scripts/idd-effective-config.mts';

const SCRIPT = fileURLToPath(
  new URL('../scripts/idd-effective-config.mjs', import.meta.url),
);

// A repository with a local policy file and a throwaway user-global home, so
// the outcome never depends on the operator's own configuration.
function fixture(options: {
  local: string | null;
  global: string | null;
  checkout?: string;
}): { cwd: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'idd-effective-config-'));
  const cwd = join(root, options.checkout ?? 'checkout');
  mkdirSync(cwd, { recursive: true });
  if (options.local !== null) {
    mkdirSync(join(cwd, '.github', 'idd'), { recursive: true });
    writeFileSync(join(cwd, '.github', 'idd', 'config.json'), options.local);
  }
  const configHome = join(root, 'config');
  if (options.global !== null) {
    mkdirSync(join(configHome, 'idd-skill'), { recursive: true });
    writeFileSync(join(configHome, 'idd-skill', 'config.json'), options.global);
  }
  return {
    cwd,
    env: { XDG_CONFIG_HOME: configHome },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('the full report names the layer each value came from (#3820)', () => {
  const f = fixture({
    local: '{"reviewPolicy":"repo-choice"}',
    global: '{"threadResolutionPolicy":"global-thread"}',
  });
  try {
    const loaded = loadLayeredLocalPolicy({ cwd: f.cwd, env: f.env });
    const report = buildEffectiveConfigReport(
      loaded,
      '.github/idd/config.json',
    );
    assert.equal(report.repository.policyExists, true);
    assert.equal(report.repository.policyDiagnostic, null);
    assert.equal(report.userGlobalContributed, true);
    assert.equal(report.selectedOverrideIndex, null);
    assert.deepEqual(report.config, {
      reviewPolicy: 'repo-choice',
      threadResolutionPolicy: 'global-thread',
    });
    assert.equal(report.sourceMap.reviewPolicy, 'repository-local');
    assert.equal(report.sourceMap.threadResolutionPolicy, 'user-global');
  } finally {
    f.cleanup();
  }
});

test('--key prints one value and the layer that supplied it (#3820)', () => {
  const f = fixture({
    local: '{"reviewPolicy":"repo-choice"}',
    global: '{"threadResolutionPolicy":"global-thread"}',
  });
  try {
    const loaded = loadLayeredLocalPolicy({ cwd: f.cwd, env: f.env });
    assert.deepEqual(
      buildEffectiveConfigKeyReport(loaded, 'threadResolutionPolicy'),
      {
        key: 'threadResolutionPolicy',
        found: true,
        value: 'global-thread',
        source: 'user-global',
      },
    );
    assert.deepEqual(buildEffectiveConfigKeyReport(loaded, 'missing.path'), {
      key: 'missing.path',
      found: false,
      value: null,
      source: null,
    });
  } finally {
    f.cleanup();
  }
});

test('--no-user-global skips the user-global layers entirely (#3820)', () => {
  const f = fixture({
    local: null,
    global: '{"threadResolutionPolicy":"global-thread"}',
  });
  try {
    const withGlobal = loadLayeredLocalPolicy({ cwd: f.cwd, env: f.env });
    assert.deepEqual(withGlobal.config, {
      threadResolutionPolicy: 'global-thread',
    });
    const withoutGlobal = loadLayeredLocalPolicy({
      cwd: f.cwd,
      env: f.env,
      noUserGlobal: true,
    });
    assert.equal(withoutGlobal.config, null);
    assert.equal(withoutGlobal.userGlobalContributed, false);
  } finally {
    f.cleanup();
  }
});

test('the CLI prints the JSON report and honors --key and --no-user-global (#3820)', () => {
  const f = fixture({
    local: null,
    global: '{"threadResolutionPolicy":"global-thread"}',
  });
  try {
    const run = (args: string[]): unknown =>
      JSON.parse(
        execFileSync(process.execPath, [SCRIPT, ...args], {
          cwd: resolve(f.cwd),
          env: { ...process.env, ...f.env, GITHUB_ACTIONS: '' },
          encoding: 'utf8',
        }),
      );
    const full = run([]) as { config: unknown; userGlobalContributed: boolean };
    assert.deepEqual(full.config, { threadResolutionPolicy: 'global-thread' });
    assert.equal(full.userGlobalContributed, true);
    assert.deepEqual(run(['--key', 'threadResolutionPolicy']), {
      key: 'threadResolutionPolicy',
      found: true,
      value: 'global-thread',
      source: 'user-global',
    });
    const bare = run(['--no-user-global']) as { config: unknown };
    assert.equal(bare.config, null);
  } finally {
    f.cleanup();
  }
});
