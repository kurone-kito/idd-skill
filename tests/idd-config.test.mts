import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { platform } from 'node:process';
import { test } from 'node:test';

import {
  buildIddConfigContentsArgs,
  deriveRepositoryIdentity,
  evaluateForcedHandoffPreflight,
  isUpstreamEscalationEnabled,
  loadIddConfig,
  loadPolicyConfig,
  loadRepositoryPolicyDocument,
  loadTrustedActorConfig,
  loadTrustedIddConfig,
  loadUserGlobalPolicyDocument,
  REPOSITORY_POLICY_FIELDS,
  readRepositoryPolicyFile,
  readTrustedForcedHandoffMode,
  resolveEffectiveCritiqueLoopDelegateFromEnv,
  resolveEffectiveCritiqueLoopTelemetryHookFromEnv,
  resolveLayeredPolicy,
  resolveUserGlobalConfigPath,
  selectTrustedConfigRef,
} from '../src/scripts/idd-config.mts';

const HEAD = '1111111111111111111111111111111111111111';

function toEncodedConfig(config: unknown): string {
  return Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
}

function syntheticNotFoundError(): Error & { stderr?: string } {
  const notFound = new Error('Not Found (HTTP 404)') as Error & {
    stderr?: string;
  };
  notFound.stderr = 'Not Found (HTTP 404)';
  return notFound;
}

// Every scenario runs inside its own freshly `mkdtempSync`-created sandbox
// (never the real repo cwd), mirroring the sandboxing already used by
// forced-handoff-marker.test.mts's `forcedHandoff.mode` tests.
function withSandboxCwd<T>(run: (sandbox: string) => T): T {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-idd-config-test-'));
  process.chdir(sandbox);
  try {
    return run(sandbox);
  } finally {
    process.chdir(originalCwd);
  }
}

function writeConfig(sandbox: string, body: string): void {
  mkdirSync(join(sandbox, '.github', 'idd'), { recursive: true });
  writeFileSync(join(sandbox, '.github', 'idd', 'config.json'), body);
}

function identityFromGit(remote: string | null, commonDir: string) {
  return deriveRepositoryIdentity({
    cwd: '/checkout/worktree',
    runGit: (args, cwd) => {
      assert.equal(cwd, resolve('/checkout/worktree'));
      if (args.length === 1 && args[0] === 'remote') {
        return remote === null ? 'upstream\n' : 'origin\nupstream\n';
      }
      if (args.join(' ') === 'remote get-url origin') {
        assert.notEqual(remote, null);
        return remote ?? '';
      }
      if (
        args.join(' ') === 'rev-parse --path-format=absolute --git-common-dir'
      ) {
        return commonDir;
      }
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    },
  });
}

function writeRepositoryPolicy(
  root: string,
  relativePath: string,
  body: string,
): string {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

test('loadIddConfig returns null when the config file is missing', () => {
  withSandboxCwd(() => {
    assert.equal(loadIddConfig(), null);
  });
});

test('loadIddConfig returns null on invalid JSON', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, '{ not valid json');
    assert.equal(loadIddConfig(), null);
  });
});

test('loadIddConfig parses a valid config file', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(
      sandbox,
      JSON.stringify({
        trustedMarkerActors: ['kurone-kito'],
        advisoryBotLogins: ['coderabbitai[bot]'],
      }),
    );
    assert.deepEqual(loadIddConfig(), {
      trustedMarkerActors: ['kurone-kito'],
      advisoryBotLogins: ['coderabbitai[bot]'],
    });
  });
});

test('loadIddConfig always re-reads the file: a later on-disk edit in the same cwd is observed', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['first'] }));
    assert.deepEqual(loadIddConfig(), { trustedMarkerActors: ['first'] });

    // Overwrite the same file in the same cwd — a caller that reads config
    // more than once per process (e.g. idd-merge-execute.mts's deliberate
    // "re-validate immediately before merging" second pass) must observe
    // this edit, not a stale cached value.
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['second'] }));
    assert.deepEqual(loadIddConfig(), { trustedMarkerActors: ['second'] });
  });
});

test('loadIddConfig reads fresh content for a different cwd (a different sandbox)', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['third'] }));
    assert.deepEqual(loadIddConfig(), { trustedMarkerActors: ['third'] });
  });
});

// loadPolicyConfig (#1721): explicit-path-aware reader for the nine
// --policy/--config-aware helpers, with stricter default-path semantics
// than loadIddConfig above (see that function's doc comment).

test('loadPolicyConfig default path: returns { config: null } when the file is genuinely absent (ENOENT)', () => {
  withSandboxCwd((sandbox) => {
    const result = loadPolicyConfig();
    assert.equal(result.config, null);
    assert.equal(result.path, resolve(sandbox, '.github/idd/config.json'));
  });
});

test('loadPolicyConfig default path: parses a valid config and resolves an absolute path', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['a'] }));
    const result = loadPolicyConfig();
    assert.deepEqual(result.config, { trustedMarkerActors: ['a'] });
    assert.equal(result.path, resolve(sandbox, '.github/idd/config.json'));
  });
});

test('loadPolicyConfig default path: throws (does not silently default) on malformed JSON', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, '{ not valid json');
    assert.throws(
      () => loadPolicyConfig(),
      /failed to load policy from .*config\.json: /,
    );
  });
});

test('loadPolicyConfig explicit path: throws on a nonexistent file, naming the path', () => {
  withSandboxCwd(() => {
    assert.throws(
      () => loadPolicyConfig('does-not-exist.json'),
      /failed to load policy from .*does-not-exist\.json: /,
    );
  });
});

test('loadPolicyConfig explicit path: throws on malformed JSON, naming the path', () => {
  withSandboxCwd((sandbox) => {
    const badPath = join(sandbox, 'bad-policy.json');
    writeFileSync(badPath, '{ not valid json');
    assert.throws(
      () => loadPolicyConfig('bad-policy.json'),
      /failed to load policy from .*bad-policy\.json: /,
    );
  });
});

test('loadPolicyConfig explicit path: parses a valid config and resolves it against cwd', () => {
  withSandboxCwd((sandbox) => {
    const goodPath = join(sandbox, 'good-policy.json');
    writeFileSync(goodPath, JSON.stringify({ markerPrefix: 'custom' }));
    const result = loadPolicyConfig('good-policy.json');
    assert.deepEqual(result.config, { markerPrefix: 'custom' });
    assert.equal(result.path, resolve(sandbox, 'good-policy.json'));
  });
});

test('loadPolicyConfig explicit path: an empty string is treated as "no explicit path" (default-path ENOENT semantics)', () => {
  withSandboxCwd(() => {
    const result = loadPolicyConfig('');
    assert.equal(result.config, null);
  });
});

// Regression coverage for a Copilot review finding on PR #1776:
// `JSON.parse('null')` succeeds (it does not throw), so an existing config
// file whose top-level JSON value is `null` (or any other non-object, e.g.
// an array) previously flowed through the success path unchecked and
// returned `{ config: null }` -- indistinguishable from this function's own
// "absent" sentinel, silently reopening the fail-open gap this function
// exists to close.

test('loadPolicyConfig default path: throws on a top-level JSON null (existing file, not ENOENT)', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, 'null');
    assert.throws(
      () => loadPolicyConfig(),
      /failed to load policy from .*config\.json: expected a JSON object at the top level, got null/,
    );
  });
});

test('loadPolicyConfig default path: throws on a top-level JSON array', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, '[]');
    assert.throws(
      () => loadPolicyConfig(),
      /expected a JSON object at the top level, got an array/,
    );
  });
});

test('loadPolicyConfig explicit path: throws on a top-level JSON null, naming the path', () => {
  withSandboxCwd((sandbox) => {
    const nullPath = join(sandbox, 'null-policy.json');
    writeFileSync(nullPath, 'null');
    assert.throws(
      () => loadPolicyConfig('null-policy.json'),
      /failed to load policy from .*null-policy\.json: expected a JSON object at the top level, got null/,
    );
  });
});

test('loadPolicyConfig explicit path: throws on a top-level JSON number', () => {
  withSandboxCwd((sandbox) => {
    const numberPath = join(sandbox, 'number-policy.json');
    writeFileSync(numberPath, '42');
    assert.throws(
      () => loadPolicyConfig('number-policy.json'),
      /expected a JSON object at the top level, got a number/,
    );
  });
});

// Permission-denied is a distinct failure from ENOENT and must throw on the
// default path too (never silently treated as "absent"). Skipped when
// running as root or on a platform where chmod does not restrict the
// owning user's own read access (root ignores POSIX permission bits;
// Windows chmod semantics differ).
const canTestPermissionDenied =
  platform !== 'win32' &&
  typeof process.getuid === 'function' &&
  process.getuid() !== 0;

test('loadPolicyConfig default path: throws (not silently absent) on a permission error', {
  skip: !canTestPermissionDenied,
}, () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['x'] }));
    const configPath = join(sandbox, '.github', 'idd', 'config.json');
    chmodSync(configPath, 0o000);
    try {
      assert.throws(
        () => loadPolicyConfig(),
        /failed to load policy from .*config\.json: /,
      );
    } finally {
      chmodSync(configPath, 0o644);
    }
  });
});

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// #3820: run with an optional user-global file under a throwaway
// XDG_CONFIG_HOME, and with GITHUB_ACTIONS pinned, so the outcome never
// depends on the host operator's config or on the CI runner executing this
// suite.
function withUserGlobal<T>(
  body: string | null,
  githubActions: string | undefined,
  run: () => T,
): T {
  const saved = {
    xdg: process.env.XDG_CONFIG_HOME,
    ci: process.env.GITHUB_ACTIONS,
  };
  const configHome = mkdtempSync(join(tmpdir(), 'idd-idd-config-global-'));
  if (body !== null) {
    mkdirSync(join(configHome, 'idd-skill'), { recursive: true });
    writeFileSync(join(configHome, 'idd-skill', 'config.json'), body);
  }
  setEnv('XDG_CONFIG_HOME', configHome);
  setEnv('GITHUB_ACTIONS', githubActions);
  try {
    return run();
  } finally {
    setEnv('XDG_CONFIG_HOME', saved.xdg);
    setEnv('GITHUB_ACTIONS', saved.ci);
    rmSync(configHome, { recursive: true, force: true });
  }
}

// #3820: the default loaders read the user-global layers as well as the
// repository file. A repository-owned field from the user-global base is
// ignored once a repository file exists (see REPOSITORY_POLICY_FIELDS).
test('loadIddConfig reads the user-global base when the repository has no policy file (#3820)', () => {
  withSandboxCwd(() =>
    withUserGlobal('{"reviewPolicy":"copilot-advisory"}', undefined, () => {
      assert.deepEqual(loadIddConfig(), { reviewPolicy: 'copilot-advisory' });
    }),
  );
});

test('repository leaves win over the user-global base, and a repository-owned field from the base is ignored (#3820)', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, '{"reviewPolicy":"repo-choice"}');
    withUserGlobal(
      '{"reviewPolicy":"global-choice","threadResolutionPolicy":"fast-agent-resolve","trustedMarkerActors":["global-login"]}',
      undefined,
      () => {
        assert.deepEqual(loadIddConfig(), {
          reviewPolicy: 'repo-choice',
          threadResolutionPolicy: 'fast-agent-resolve',
        });
      },
    );
  });
});

test('under GITHUB_ACTIONS=true the user-global layers are never read (#3820)', () => {
  withSandboxCwd((sandbox) => {
    withUserGlobal('{"reviewPolicy":"global-choice"}', 'true', () => {
      assert.equal(loadIddConfig(), null);
      writeConfig(sandbox, '{"reviewPolicy":"repo-choice"}');
      assert.deepEqual(loadIddConfig(), { reviewPolicy: 'repo-choice' });
    });
  });
});

test('an explicit --policy path reads only that file, never the user-global layers (#3820)', () => {
  withSandboxCwd((sandbox) => {
    writeRepositoryPolicy(
      sandbox,
      'policy.json',
      '{"reviewPolicy":"explicit"}',
    );
    withUserGlobal('{"threadResolutionPolicy":"global"}', undefined, () => {
      assert.deepEqual(loadPolicyConfig('policy.json').config, {
        reviewPolicy: 'explicit',
      });
    });
  });
});

test('the legacy idd-policy.json is never read as the local policy (#3820)', () => {
  withSandboxCwd((sandbox) => {
    writeRepositoryPolicy(
      sandbox,
      'idd-policy.json',
      '{"reviewPolicy":"legacy"}',
    );
    withUserGlobal(null, undefined, () => {
      assert.equal(loadIddConfig(), null);
      assert.equal(loadPolicyConfig().config, null);
    });
  });
});

// #3820: a legacy file that exists but cannot be inspected still blocks the
// user-global repository fields. The symlink target sits in a directory with no
// search permission, so stat fails with EACCES rather than ENOENT. POSIX
// permissions do not apply on Windows, and root ignores them.
const canLockDirectories =
  platform !== 'win32' &&
  typeof process.getuid === 'function' &&
  process.getuid() !== 0;
test('an uninspectable legacy idd-policy.json still blocks user-global repository fields (#3820)', {
  skip: !canLockDirectories,
}, () => {
  withSandboxCwd((sandbox) => {
    const locked = join(sandbox, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'policy.json'), '{"reviewPolicy":"legacy"}');
    symlinkSync(join(locked, 'policy.json'), join(sandbox, 'idd-policy.json'));
    chmodSync(locked, 0o000);
    try {
      withUserGlobal(
        '{"trustedMarkerActors":["global-login"],"threadResolutionPolicy":"fast-agent-resolve"}',
        undefined,
        () => {
          assert.deepEqual(loadIddConfig(), {
            threadResolutionPolicy: 'fast-agent-resolve',
          });
        },
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

// #3820: a dangling canonical symlink is an existing repository file that cannot
// be read. The user-global layers must not stand in for it.
test('a dangling canonical policy symlink fails closed and never falls back to user-global fields (#3820)', () => {
  withSandboxCwd((sandbox) => {
    mkdirSync(join(sandbox, '.github', 'idd'), { recursive: true });
    symlinkSync(
      join(sandbox, 'missing-target.json'),
      join(sandbox, '.github', 'idd', 'config.json'),
    );
    withUserGlobal(
      '{"threadResolutionPolicy":"fast-agent-resolve"}',
      undefined,
      () => {
        assert.equal(loadIddConfig(), null);
        assert.throws(
          () => loadPolicyConfig(),
          /failed to load policy from .*config\.json/,
        );
      },
    );
  });
});

// #3820: a dangling symlink is still a legacy entry, so it blocks the
// user-global repository fields too. Only a missing entry counts as absent.
test('a dangling legacy idd-policy.json symlink still blocks user-global repository fields (#3820)', () => {
  withSandboxCwd((sandbox) => {
    symlinkSync(
      join(sandbox, 'missing-target.json'),
      join(sandbox, 'idd-policy.json'),
    );
    withUserGlobal(
      '{"trustedMarkerActors":["global-login"],"threadResolutionPolicy":"fast-agent-resolve"}',
      undefined,
      () => {
        assert.deepEqual(loadIddConfig(), {
          threadResolutionPolicy: 'fast-agent-resolve',
        });
      },
    );
  });
});

test('a legacy idd-policy.json blocks user-global repository-owned fields but is never read as policy (#3820)', () => {
  withSandboxCwd((sandbox) => {
    writeRepositoryPolicy(
      sandbox,
      'idd-policy.json',
      '{"reviewPolicy":"legacy"}',
    );
    withUserGlobal(
      '{"trustedMarkerActors":["global-login"],"threadResolutionPolicy":"fast-agent-resolve"}',
      undefined,
      () => {
        assert.deepEqual(loadIddConfig(), {
          threadResolutionPolicy: 'fast-agent-resolve',
        });
      },
    );
  });
});

test('the default loader merges the user-global layers while the raw reader stays repository-only (#3820)', () => {
  withSandboxCwd(() => {
    withUserGlobal(
      '{"threadResolutionPolicy":"fast-agent-resolve"}',
      undefined,
      () => {
        assert.deepEqual(loadPolicyConfig().config, {
          threadResolutionPolicy: 'fast-agent-resolve',
        });
        assert.equal(readRepositoryPolicyFile().config, null);
      },
    );
  });
});

test('a malformed repository file keeps the null contract even with a user-global file present (#3820)', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, '{"reviewPolicy":');
    withUserGlobal('{"threadResolutionPolicy":"global"}', undefined, () => {
      assert.equal(loadIddConfig(), null);
      assert.throws(
        () => loadPolicyConfig(),
        /failed to load policy from .*config\.json/,
      );
    });
  });
});

// `isQualifiedConfigRoot` (src/scripts/idd-config.mts) requires a
// Windows-native absolute root (a drive letter or a UNC `\\` prefix) on
// win32, and a POSIX absolute root (leading `/`, not `//`) otherwise --
// so the accepted XDG/HOME roots below must be platform-native for the
// tests to actually exercise that acceptance path rather than its
// rejection path.
const XDG_CONFIG_HOME_ROOT =
  platform === 'win32' ? 'C:\\xdg-config' : '/xdg-config';
const HOME_ROOT =
  platform === 'win32' ? 'C:\\Users\\operator' : '/home/operator';

test('resolveUserGlobalConfigPath prefers XDG_CONFIG_HOME over HOME (#2257)', () => {
  assert.equal(
    resolveUserGlobalConfigPath({
      env: {
        XDG_CONFIG_HOME: XDG_CONFIG_HOME_ROOT,
        HOME: HOME_ROOT,
      },
    }),
    join(XDG_CONFIG_HOME_ROOT, 'idd-skill', 'config.json'),
  );
});

test('resolveUserGlobalConfigPath falls back to HOME/.config when XDG_CONFIG_HOME is empty (#2257)', () => {
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { XDG_CONFIG_HOME: '  ', HOME: HOME_ROOT },
    }),
    join(HOME_ROOT, '.config', 'idd-skill', 'config.json'),
  );
});

test('resolveUserGlobalConfigPath does not consult process.env when env is injected (#2257)', () => {
  assert.equal(resolveUserGlobalConfigPath({ env: {} }), undefined);
});

test('resolveUserGlobalConfigPath ignores a relative XDG_CONFIG_HOME and requires an absolute HOME (#2257)', () => {
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { XDG_CONFIG_HOME: 'config', HOME: HOME_ROOT },
    }),
    join(HOME_ROOT, '.config', 'idd-skill', 'config.json'),
  );
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { HOME: 'relative-home' },
    }),
    undefined,
  );
});

test('resolveUserGlobalConfigPath rejects a Windows current-drive root such as \\config (#2257)', () => {
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { XDG_CONFIG_HOME: '\\config', HOME: HOME_ROOT },
    }),
    join(HOME_ROOT, '.config', 'idd-skill', 'config.json'),
  );
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { HOME: '\\config' },
    }),
    undefined,
  );
});

test('resolveUserGlobalConfigPath ignores a Windows drive root on POSIX (#2257)', {
  skip: process.platform === 'win32',
}, () => {
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { XDG_CONFIG_HOME: 'C:\\Users\\op', HOME: '/home/operator' },
    }),
    join('/home/operator', '.config', 'idd-skill', 'config.json'),
  );
});

test('resolveUserGlobalConfigPath documents that POSIX slash roots are Unix-only (#2257)', () => {
  if (process.platform === 'win32') {
    assert.equal(
      resolveUserGlobalConfigPath({
        env: { XDG_CONFIG_HOME: '/config', HOME: 'C:\\Users\\operator' },
      }),
      join('C:\\Users\\operator', '.config', 'idd-skill', 'config.json'),
    );
    return;
  }
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { XDG_CONFIG_HOME: '/xdg-config' },
    }),
    join('/xdg-config', 'idd-skill', 'config.json'),
  );
});

test('loadUserGlobalPolicyDocument treats a missing file as absent (#2257)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-missing-'));
  const result = loadUserGlobalPolicyDocument({
    path: join(sandbox, 'missing.json'),
  });
  assert.equal(result.status, 'absent');
  assert.equal(result.config, undefined);
});

test('loadUserGlobalPolicyDocument treats malformed JSON as absent (#2257)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-badjson-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(path, '{ not json');
  const result = loadUserGlobalPolicyDocument({ path });
  assert.equal(result.status, 'absent');
  assert.equal(result.path, path);
});

test('resolveEffectiveCritiqueLoopDelegateFromEnv ignores global keys other than critiqueLoop.delegate (#2257)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-extra-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      mergePolicy: 'must-not-apply',
      critiqueLoop: { delegate: { command: 'global-review' } },
    }),
  );
  const result = loadUserGlobalPolicyDocument({ path });
  assert.equal(result.status, 'present');
  const resolved = resolveEffectiveCritiqueLoopDelegateFromEnv({
    localConfig: {},
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'global',
    source: 'user-global',
    delegate: { command: 'global-review', mode: 'fallback' },
  });
});

test('resolveEffectiveCritiqueLoopDelegateFromEnv skips the global file when local policy already decides (#2257)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-skipped-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      critiqueLoop: { delegate: { command: 'must-not-load' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopDelegateFromEnv({
    localConfig: { critiqueLoop: { delegate: { command: 'local-review' } } },
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'local',
    source: 'repository-local',
    delegate: { command: 'local-review', mode: 'fallback' },
  });
});

test('resolveEffectiveCritiqueLoopDelegateFromEnv does not read HOME when path is injected (#2257)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-injected-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      critiqueLoop: { delegate: { command: 'injected-review' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopDelegateFromEnv({
    localConfig: {},
    globalConfigPath: path,
    env: { HOME: '/this-must-not-be-read', XDG_CONFIG_HOME: '/neither' },
  });
  assert.deepEqual(resolved, {
    status: 'global',
    source: 'user-global',
    delegate: { command: 'injected-review', mode: 'fallback' },
  });
});

// #2258: close the remaining gaps in layered C1 delegate coverage --
// unreadable/top-level-invalid global documents, broader leak-proofing
// beyond a single `mergePolicy` key, and the env-level entry point's own
// fail-safe branches (previously only exercised through the pure
// `resolveEffectiveCritiqueLoopDelegate` in policy-helpers.test.mts).

test('loadUserGlobalPolicyDocument treats a top-level JSON array as absent (#2258)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-array-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(path, '[]');
  const result = loadUserGlobalPolicyDocument({ path });
  assert.equal(result.status, 'absent');
  assert.equal(result.path, path);
});

test('loadUserGlobalPolicyDocument treats a top-level JSON number as absent (#2258)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-number-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(path, '42');
  const result = loadUserGlobalPolicyDocument({ path });
  assert.equal(result.status, 'absent');
  assert.equal(result.path, path);
});

test('loadUserGlobalPolicyDocument treats an unreadable (permission-denied) file as absent (#2258)', {
  skip: !canTestPermissionDenied,
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-denied-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({ critiqueLoop: { delegate: { command: 'x' } } }),
  );
  chmodSync(path, 0o000);
  try {
    const result = loadUserGlobalPolicyDocument({ path });
    assert.equal(result.status, 'absent');
    assert.equal(result.path, path);
  } finally {
    chmodSync(path, 0o644);
  }
});

test('resolveEffectiveCritiqueLoopDelegateFromEnv: commands, mergePolicy, reviewPolicy, and CI-related global keys do not leak into the resolved delegate (#2258)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-leak-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      commands: { 'pre-push-validate': 'echo must-not-apply' },
      mergePolicy: 'fully_autonomous_merge',
      reviewPolicy: 'copilot-advisory',
      ciWait: { runningTimeout: 'PT99H' },
      critiqueLoop: { delegate: { command: 'global-review' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopDelegateFromEnv({
    localConfig: {},
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'global',
    source: 'user-global',
    delegate: { command: 'global-review', mode: 'fallback' },
  });
});

test('resolveEffectiveCritiqueLoopDelegateFromEnv honors a repository-local null disable even when a global delegate file exists (#2258)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-disabled-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      critiqueLoop: { delegate: { command: 'must-not-apply' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopDelegateFromEnv({
    localConfig: { critiqueLoop: { delegate: null } },
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'disabled',
    source: 'repository-local',
  });
});

test('resolveEffectiveCritiqueLoopDelegateFromEnv fails closed on a malformed repository-local delegate without inheriting the global object (#2258)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-user-global-malformed-'));
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      critiqueLoop: { delegate: { command: 'must-not-apply' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopDelegateFromEnv({
    localConfig: {
      critiqueLoop: { delegate: { command: 'local-review', bogus: 1 } },
    },
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'local-malformed',
    source: 'repository-local',
    reason: 'invalid-repository-local-delegate',
  });
});

// #2679: resolveEffectiveCritiqueLoopTelemetryHookFromEnv, mirroring every
// resolveEffectiveCritiqueLoopDelegateFromEnv case above (#2257/#2258) for
// the simpler `{ command }`-only critiqueLoop.telemetryHook shape.

test('resolveEffectiveCritiqueLoopTelemetryHookFromEnv ignores global keys other than critiqueLoop.telemetryHook (#2679)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-user-global-telemetry-hook-extra-'),
  );
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      mergePolicy: 'must-not-apply',
      critiqueLoop: { telemetryHook: { command: 'global-hook' } },
    }),
  );
  const result = loadUserGlobalPolicyDocument({ path });
  assert.equal(result.status, 'present');
  const resolved = resolveEffectiveCritiqueLoopTelemetryHookFromEnv({
    localConfig: {},
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'global',
    source: 'user-global',
    hook: { command: 'global-hook' },
  });
});

test('resolveEffectiveCritiqueLoopTelemetryHookFromEnv skips the global file when local policy already decides (#2679)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-user-global-telemetry-hook-skipped-'),
  );
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'must-not-load' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopTelemetryHookFromEnv({
    localConfig: {
      critiqueLoop: { telemetryHook: { command: 'local-hook' } },
    },
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'local',
    source: 'repository-local',
    hook: { command: 'local-hook' },
  });
});

test('resolveEffectiveCritiqueLoopTelemetryHookFromEnv does not read HOME when path is injected (#2679)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-user-global-telemetry-hook-injected-'),
  );
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'injected-hook' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopTelemetryHookFromEnv({
    localConfig: {},
    globalConfigPath: path,
    env: { HOME: '/this-must-not-be-read', XDG_CONFIG_HOME: '/neither' },
  });
  assert.deepEqual(resolved, {
    status: 'global',
    source: 'user-global',
    hook: { command: 'injected-hook' },
  });
});

test('resolveEffectiveCritiqueLoopTelemetryHookFromEnv: commands, mergePolicy, reviewPolicy, and CI-related global keys do not leak into the resolved hook (#2679)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-user-global-telemetry-hook-leak-'),
  );
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      commands: { 'pre-push-validate': 'echo must-not-apply' },
      mergePolicy: 'fully_autonomous_merge',
      reviewPolicy: 'copilot-advisory',
      ciWait: { runningTimeout: 'PT99H' },
      critiqueLoop: { telemetryHook: { command: 'global-hook' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopTelemetryHookFromEnv({
    localConfig: {},
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'global',
    source: 'user-global',
    hook: { command: 'global-hook' },
  });
});

test('resolveEffectiveCritiqueLoopTelemetryHookFromEnv honors a repository-local null disable even when a global hook file exists (#2679)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-user-global-telemetry-hook-disabled-'),
  );
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'must-not-apply' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopTelemetryHookFromEnv({
    localConfig: { critiqueLoop: { telemetryHook: null } },
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'disabled',
    source: 'repository-local',
  });
});

test('resolveEffectiveCritiqueLoopTelemetryHookFromEnv fails closed on a malformed repository-local hook without inheriting the global object (#2679)', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-user-global-telemetry-hook-malformed-'),
  );
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      critiqueLoop: { telemetryHook: { command: 'must-not-apply' } },
    }),
  );
  const resolved = resolveEffectiveCritiqueLoopTelemetryHookFromEnv({
    localConfig: {
      critiqueLoop: { telemetryHook: { command: 'local-hook', bogus: 1 } },
    },
    globalConfigPath: path,
    env: {},
  });
  assert.deepEqual(resolved, {
    status: 'local-malformed',
    source: 'repository-local',
    reason: 'invalid-repository-local-telemetry-hook',
  });
});

// --- buildIddConfigContentsArgs (regression: #1434 review, Codex P2; moved
// from tests/rerun-advisory-convergence.test.mts by #2373) --------------
//
// This pure args-builder accepts whatever `ref` its caller passes. Both
// current production callers pin `ref` to a TRUSTED value the PR under
// evaluation cannot itself steer -- `rerun-advisory-convergence.mts` pins
// it to the repository's default branch, `pre-merge-readiness.mts` (#2373)
// pins it to the PR's base branch (falling back to the default branch) --
// never the PR's own head SHA; see loadTrustedIddConfig's own doc comment
// for the full rationale. `--method GET` is required alongside `-f
// ref=...`: `gh api` defaults to POST as soon as any `-f` value is
// present, and the Contents API only accepts GET -- confirmed empirically
// that an unqualified `-f ref=...` 404s on every call, which
// loadTrustedIddConfig's own catch block would otherwise silently treat as
// "config genuinely absent, use defaults".

test('buildIddConfigContentsArgs includes --method GET and pins -f ref to the given ref value', () => {
  const args = buildIddConfigContentsArgs('kurone-kito', 'idd-skill', HEAD);
  assert.deepEqual(args, [
    'api',
    'repos/kurone-kito/idd-skill/contents/.github/idd/config.json',
    '--method',
    'GET',
    '-f',
    `ref=${HEAD}`,
    '--jq',
    '.content',
  ]);
});

test('buildIddConfigContentsArgs places --method immediately before GET (gh api requires the value to follow its flag)', () => {
  const args = buildIddConfigContentsArgs('o', 'r', HEAD);
  const methodIndex = args.indexOf('--method');
  assert.notEqual(methodIndex, -1);
  assert.equal(args[methodIndex + 1], 'GET');
});

// --- loadTrustedIddConfig (#2373) ---------------------------------------

test('loadTrustedIddConfig decodes and parses a fetched base64 config', () => {
  const config = loadTrustedIddConfig('kurone-kito', 'idd-skill', 'main', () =>
    toEncodedConfig({ claimTiming: { staleAge: 'PT48H' } }),
  );
  assert.deepEqual(config, { claimTiming: { staleAge: 'PT48H' } });
});

test('loadTrustedIddConfig passes owner/repo/ref through to the injected fetch', () => {
  const seen: { owner: string; repo: string; ref: string }[] = [];
  loadTrustedIddConfig('o', 'r', 'feature-branch', (owner, repo, ref) => {
    seen.push({ owner, repo, ref });
    return toEncodedConfig({});
  });
  assert.deepEqual(seen, [{ owner: 'o', repo: 'r', ref: 'feature-branch' }]);
});

test('loadTrustedIddConfig returns null on a confirmed 404 (config absent at ref)', () => {
  const config = loadTrustedIddConfig('o', 'r', 'main', () => {
    throw syntheticNotFoundError();
  });
  assert.equal(config, null);
});

// #3820: a trusted read falls back to the user-global layers only when the
// base file and the legacy idd-policy.json are both confirmed absent (404).
const httpNotFound = (): never => {
  throw new Error('gh: Not Found (HTTP 404)');
};
const httpServerError = (): never => {
  throw new Error('gh: Internal Server Error (HTTP 500)');
};
const legacyPresent = (): void => undefined;

// #3820: the forced-handoff authority is repository-only. A user-global
// human-gated mode must not authorize a handoff when the repository has no file.
test('the forced-handoff reader ignores a user-global mode when the repository file is absent (#3820)', () => {
  withUserGlobal('{"forcedHandoff":{"mode":"human-gated"}}', undefined, () => {
    assert.equal(
      readTrustedForcedHandoffMode('o', 'r', 'main', httpNotFound).status,
      'other',
    );
  });
});

// #3820: the CI exclusion holds for the single-file loader too, not only for
// loadIddConfig.
test('loadPolicyConfig default path never reads user-global layers under GITHUB_ACTIONS=true (#3820)', () => {
  withSandboxCwd(() => {
    withUserGlobal(
      '{"threadResolutionPolicy":"fast-agent-resolve"}',
      'true',
      () => {
        assert.equal(loadPolicyConfig().config, null);
      },
    );
  });
});

test('a trusted read with the base and legacy files absent uses the user-global layers (#3820)', () => {
  withUserGlobal('{"reviewPolicy":"global-choice"}', undefined, () => {
    assert.deepEqual(
      loadTrustedIddConfig('o', 'r', 'main', httpNotFound, httpNotFound),
      { reviewPolicy: 'global-choice' },
    );
  });
});

test('a trusted read with the legacy idd-policy.json present does not fall back (#3820)', () => {
  withUserGlobal('{"reviewPolicy":"global-choice"}', undefined, () => {
    assert.equal(
      loadTrustedIddConfig('o', 'r', 'main', httpNotFound, legacyPresent),
      null,
    );
  });
});

test('a trusted read whose legacy probe is not a clean 404 fails closed (#3820)', () => {
  withUserGlobal('{"reviewPolicy":"global-choice"}', undefined, () => {
    assert.throws(
      () =>
        loadTrustedIddConfig('o', 'r', 'main', httpNotFound, httpServerError),
      /cannot confirm idd-policy\.json for o\/r@main/,
    );
  });
});

test('a trusted read never falls back to user-global layers under GITHUB_ACTIONS=true (#3820)', () => {
  withUserGlobal('{"reviewPolicy":"global-choice"}', 'true', () => {
    assert.equal(
      loadTrustedIddConfig('o', 'r', 'main', httpNotFound, httpNotFound),
      null,
    );
  });
});

test('a trusted read with no user-global file makes no legacy probe and returns null (#3820)', () => {
  withUserGlobal(null, undefined, () => {
    let probed = false;
    assert.equal(
      loadTrustedIddConfig('o', 'r', 'main', httpNotFound, () => {
        probed = true;
      }),
      null,
    );
    assert.equal(probed, false);
  });
});

test('a trusted read that finds the base file uses it and ignores the user-global layers (#3820)', () => {
  withUserGlobal('{"reviewPolicy":"global-choice"}', undefined, () => {
    const config = loadTrustedIddConfig('o', 'r', 'main', () =>
      Buffer.from('{"reviewPolicy":"repo-choice"}', 'utf8').toString('base64'),
    );
    assert.deepEqual(config, { reviewPolicy: 'repo-choice' });
  });
});

test('a trusted read with a base-file failure other than 404 fails closed even with a user-global file (#3820)', () => {
  withUserGlobal('{"reviewPolicy":"global-choice"}', undefined, () => {
    assert.throws(
      () =>
        loadTrustedIddConfig('o', 'r', 'main', httpServerError, httpNotFound),
      /cannot confirm \.github\/idd\/config\.json for o\/r@main/,
    );
  });
});

test('a trusted read applies a repository-slug override and never a path override (#3820)', () => {
  withUserGlobal(
    JSON.stringify({
      threadResolutionPolicy: 'global-thread',
      overrides: [
        { match: { repo: 'o/r' }, config: { reviewPolicy: 'slug-choice' } },
        {
          match: { path: 'checkout' },
          config: { reviewPolicy: 'path-choice' },
        },
      ],
    }),
    undefined,
    () => {
      assert.deepEqual(
        loadTrustedIddConfig('o', 'r', 'main', httpNotFound, httpNotFound),
        {
          threadResolutionPolicy: 'global-thread',
          reviewPolicy: 'slug-choice',
        },
      );
    },
  );
});

test('loadTrustedIddConfig rethrows (fail-closed) on a non-404 failure', () => {
  assert.throws(
    () =>
      loadTrustedIddConfig('o', 'r', 'main', () => {
        throw new Error('network timeout');
      }),
    /cannot confirm \.github\/idd\/config\.json for o\/r@main/,
  );
});

test('loadTrustedIddConfig rethrows on malformed (non-JSON) fetched content', () => {
  assert.throws(
    () =>
      loadTrustedIddConfig('o', 'r', 'main', () =>
        Buffer.from('not json', 'utf8').toString('base64'),
      ),
    /cannot confirm \.github\/idd\/config\.json for o\/r@main/,
  );
});

// Regression: mirrors loadPolicyConfig's own #1776 fix (JSON.parse('null')
// succeeds without throwing, so a syntactically-valid top-level scalar/
// array/null would otherwise masquerade as this function's own "absent"
// (404) sentinel).

test('loadTrustedIddConfig rethrows on a top-level JSON null instead of treating it as absent', () => {
  assert.throws(
    () => loadTrustedIddConfig('o', 'r', 'main', () => toEncodedConfig(null)),
    /cannot confirm \.github\/idd\/config\.json for o\/r@main: .*expected a JSON object at the top level, got null/,
  );
});

test('loadTrustedIddConfig rethrows on a top-level JSON array', () => {
  assert.throws(
    () => loadTrustedIddConfig('o', 'r', 'main', () => toEncodedConfig([])),
    /expected a JSON object at the top level, got an array/,
  );
});

// #2373 acceptance criterion: "an empty-but-fetched .content rethrows
// rather than silently falling back to a permissive default" -- decoding
// an empty string yields an empty JSON document, which JSON.parse rejects
// (SyntaxError, no HTTP status text), so this already falls into the
// non-404 rethrow path; this test names that criterion explicitly.

test('loadTrustedIddConfig rethrows when the fetch returns empty content', () => {
  assert.throws(
    () => loadTrustedIddConfig('o', 'r', 'main', () => ''),
    /cannot confirm \.github\/idd\/config\.json for o\/r@main/,
  );
});

test('isUpstreamEscalationEnabled resolves to false when the key is absent', () => {
  assert.equal(isUpstreamEscalationEnabled({}), false);
});

test('isUpstreamEscalationEnabled resolves to false for a null/undefined config', () => {
  assert.equal(isUpstreamEscalationEnabled(null), false);
  assert.equal(isUpstreamEscalationEnabled(undefined), false);
});

test('isUpstreamEscalationEnabled resolves to false for explicit enabled: false', () => {
  assert.equal(
    isUpstreamEscalationEnabled({ upstreamEscalation: { enabled: false } }),
    false,
  );
});

test('isUpstreamEscalationEnabled resolves to true for explicit enabled: true', () => {
  assert.equal(
    isUpstreamEscalationEnabled({ upstreamEscalation: { enabled: true } }),
    true,
  );
});

// --- selectTrustedConfigRef / loadTrustedActorConfig (#3454) ------------

test('a non-empty base ref is fetched and the live default branch is not consulted', () => {
  assert.equal(selectTrustedConfigRef('develop', 'main'), 'develop');
  let defaultReads = 0;
  const fetches: string[] = [];
  const config = loadTrustedActorConfig({
    owner: 'o',
    repo: 'r',
    baseRefName: 'develop',
    readDefaultBranch: () => {
      defaultReads += 1;
      return 'main';
    },
    fetchEncodedConfig: (_owner, _repo, ref) => {
      fetches.push(ref);
      return toEncodedConfig({ trustedMarkerActors: ['ada'] });
    },
  });
  assert.equal(defaultReads, 0);
  assert.deepEqual(fetches, ['develop']);
  assert.deepEqual(config, { trustedMarkerActors: ['ada'] });
});

test('an empty base ref fetches the live default branch', () => {
  assert.equal(selectTrustedConfigRef('', 'main'), 'main');
  assert.equal(selectTrustedConfigRef('   ', 'main'), 'main');
  const fetches: string[] = [];
  const config = loadTrustedActorConfig({
    owner: 'o',
    repo: 'r',
    baseRefName: '   ',
    readDefaultBranch: (owner, repo) => {
      assert.equal(owner, 'o');
      assert.equal(repo, 'r');
      return 'main';
    },
    fetchEncodedConfig: (_owner, _repo, ref) => {
      fetches.push(ref);
      return toEncodedConfig({});
    },
  });
  assert.deepEqual(fetches, ['main']);
  assert.deepEqual(config, {});
});

test('an empty base ref and an unavailable default branch throw', () => {
  assert.throws(
    () => selectTrustedConfigRef('', null),
    /no base ref was supplied/,
  );
  assert.throws(
    () => selectTrustedConfigRef('  ', '   '),
    /no base ref was supplied/,
  );
  assert.throws(
    () =>
      loadTrustedActorConfig({
        owner: 'o',
        repo: 'r',
        baseRefName: '',
        readDefaultBranch: () => null,
        fetchEncodedConfig: () => {
          throw new Error('should not fetch');
        },
      }),
    /no base ref was supplied/,
  );
});

test('deriveRepositoryIdentity recognizes HTTPS, SSH URL, and SCP GitHub origins', () => {
  for (const remote of [
    'https://github.com/Owner/Repo.git',
    'ssh://git@GITHUB.COM/Owner/Repo',
    'git@github.com:Owner/Repo.git',
  ]) {
    assert.deepEqual(identityFromGit(remote, '/repos/repo/.git'), {
      githubSlug: 'owner/repo',
      hasGithubOrigin: true,
      mainWorktreeRoot: '/repos/repo',
    });
  }
});

test('deriveRepositoryIdentity resolves linked and bare common-directory layouts', () => {
  const linked = identityFromGit(
    'git@gitlab.com:owner/repo.git',
    '/srv/main/.git',
  );
  assert.equal(linked.mainWorktreeRoot, '/srv/main');
  assert.equal(linked.hasGithubOrigin, false);
  assert.equal(
    identityFromGit(null, '/srv/repository.git').mainWorktreeRoot,
    '/srv/repository',
  );
});

test('a non-GitHub origin identity can select a path override', () => {
  const identity = identityFromGit(
    'git@gitlab.com:owner/repo.git',
    '/srv/operators/team/project/.git',
  );
  const result = resolveLayeredPolicy({
    localDocument: { exists: false },
    identity,
    userGlobalConfig: {
      overrides: [
        {
          match: { path: 'operators/team/project' },
          config: { issueScope: 'path' },
        },
      ],
    },
  });
  assert.equal(identity.githubSlug, null);
  assert.equal(result.config.issueScope, 'path');
});

test('deriveRepositoryIdentity rejects lookalike hosts and malformed GitHub slugs', () => {
  for (const remote of [
    'https://github.com.evil.test/owner/repo.git',
    'http://github.com/owner/repo.git',
    'https://github.com:443/owner/repo.git',
    'https://user@github.com/owner/repo.git',
    'git@github.com:owner/repo/extra.git',
    'git@github.com:owner/repo?query',
    'git@github.com:owner/..',
  ]) {
    assert.equal(
      identityFromGit(remote, '/srv/project/.git').githubSlug,
      null,
      remote,
    );
  }
});

test('path overrides stay disabled for an invalid GitHub origin URL', () => {
  for (const remote of [
    'https://user@github.com/owner/repo.git',
    'https:/github.com/owner/repo.git',
    'https://github.com /owner/repo.git',
    'git@github.com :owner/repo.git',
  ]) {
    const identity = identityFromGit(remote, '/srv/team/repo/.git');
    assert.equal(identity.githubSlug, null, remote);
    assert.equal(identity.hasGithubOrigin, true, remote);

    const result = resolveLayeredPolicy({
      localDocument: { exists: false },
      identity,
      userGlobalConfig: {
        overrides: [
          { match: { path: 'team/repo' }, config: { issueScope: 'roadmap' } },
        ],
      },
    });

    assert.equal(result.selectedOverrideIndex, null, remote);
    assert.equal(result.config.issueScope, undefined, remote);
  }
});

test('resolveLayeredPolicy matches path suffixes on whole segments and by specificity', () => {
  const result = resolveLayeredPolicy({
    localDocument: { exists: false },
    identity: {
      githubSlug: null,
      hasGithubOrigin: false,
      mainWorktreeRoot: '/srv/foobar/bar/repo',
    },
    userGlobalConfig: {
      overrides: [
        { match: { path: 'foo/bar/repo' }, config: { issueScope: 'wrong' } },
        { match: { path: 'bar/repo' }, config: { issueScope: 'shorter' } },
        {
          match: { path: 'foobar/bar/repo' },
          config: { issueScope: 'specific' },
        },
      ],
    },
  });
  assert.equal(result.selectedOverrideIndex, 2);
  assert.equal(result.config.issueScope, 'specific');
  assert.equal(result.sourceMap.issueScope, 'user-global-override');
});

test('resolveLayeredPolicy ignores path entries for GitHub identities and folds Windows paths', () => {
  const github = resolveLayeredPolicy({
    localDocument: { exists: false },
    identity: {
      githubSlug: 'owner/repo',
      hasGithubOrigin: true,
      mainWorktreeRoot: '/srv/owner/repo',
    },
    userGlobalConfig: {
      overrides: [
        { match: { path: 'owner/repo' }, config: { issueScope: 'path' } },
      ],
    },
  });
  assert.equal(github.selectedOverrideIndex, null);
  assert.equal(github.config.issueScope, undefined);

  const windows = resolveLayeredPolicy({
    localDocument: { exists: false },
    identity: {
      githubSlug: null,
      hasGithubOrigin: false,
      mainWorktreeRoot: 'C:\\Users\\Operator\\Repos\\Widget',
    },
    platform: 'win32',
    userGlobalConfig: {
      overrides: [
        {
          match: { path: 'users/operator/repos/widget' },
          config: { issueScope: 'windows-match' },
        },
      ],
    },
  });
  assert.equal(windows.config.issueScope, 'windows-match');
});

test('resolveLayeredPolicy reports tied matching overrides and applies none', () => {
  const result = resolveLayeredPolicy({
    localDocument: { exists: false },
    identity: {
      githubSlug: 'owner/repo',
      hasGithubOrigin: true,
      mainWorktreeRoot: '/srv/repo',
    },
    defaults: { issueScope: 'default' },
    userGlobalConfig: {
      overrides: [
        { match: { repo: 'OWNER/REPO' }, config: { issueScope: 'first' } },
        { match: { repo: 'owner/repo' }, config: { issueScope: 'second' } },
      ],
    },
  });
  assert.equal(result.selectedOverrideIndex, null);
  assert.equal(result.config.issueScope, 'default');
  assert.ok(
    result.diagnostics.some((entry) =>
      entry.includes('conflicting user-global overrides'),
    ),
  );
});

test('resolveLayeredPolicy reports invalid override match values', () => {
  const result = resolveLayeredPolicy({
    localDocument: { exists: false },
    identity: {
      githubSlug: null,
      hasGithubOrigin: false,
      mainWorktreeRoot: '/srv/team/repo',
    },
    userGlobalConfig: {
      overrides: [
        { match: { path: 'team/../repo' }, config: { issueScope: 'roadmap' } },
        { match: { repo: 'malformed' }, config: { issueScope: 'roadmap' } },
        {
          match: { repo: 'owner/repo?query' },
          config: { issueScope: 'roadmap' },
        },
        { match: { repo: 'owner/..' }, config: { issueScope: 'roadmap' } },
      ],
    },
  });

  assert.equal(result.selectedOverrideIndex, null);
  assert.equal(result.diagnostics.length, 4);
  assert.ok(result.diagnostics[0]?.includes('match.path'));
  assert.ok(result.diagnostics[1]?.includes('match.repo'));
  assert.ok(result.diagnostics[2]?.includes('match.repo'));
  assert.ok(result.diagnostics[3]?.includes('match.repo'));
});

test('resolveLayeredPolicy merges nested leaves, replaces arrays, and reports sources', () => {
  const result = resolveLayeredPolicy({
    localDocument: {
      exists: true,
      config: {
        issueScope: 'local',
        critiqueLoop: { nested: { localOnly: true, globalOnly: null } },
      },
    },
    identity: {
      githubSlug: 'owner/repo',
      hasGithubOrigin: true,
      mainWorktreeRoot: '/srv/repo',
    },
    defaults: {
      issueScope: 'default',
      critiqueLoop: {
        deferAfterRounds: [1],
        deferByUrgency: 'low',
        nested: { defaultOnly: true },
      },
    },
    userGlobalConfig: {
      issueScope: 'global',
      critiqueLoop: {
        deferAfterRounds: [2],
        deferByUrgency: 'medium',
        nested: { globalOnly: 'global' },
      },
      overrides: [
        {
          match: { repo: 'owner/repo' },
          config: {
            issueScope: 'override',
            critiqueLoop: {
              deferAfterRounds: [3, 4],
              nested: { overrideOnly: true },
            },
          },
        },
      ],
    },
  });

  assert.deepEqual(result.config, {
    issueScope: 'local',
    critiqueLoop: {
      deferAfterRounds: [3, 4],
      deferByUrgency: 'medium',
      nested: {
        defaultOnly: true,
        globalOnly: null,
        overrideOnly: true,
        localOnly: true,
      },
    },
  });
  assert.deepEqual(result.sourceMap, {
    issueScope: 'repository-local',
    'critiqueLoop.deferAfterRounds': 'user-global-override',
    'critiqueLoop.deferByUrgency': 'user-global',
    'critiqueLoop.nested.defaultOnly': 'default',
    'critiqueLoop.nested.globalOnly': 'repository-local',
    'critiqueLoop.nested.overrideOnly': 'user-global-override',
    'critiqueLoop.nested.localOnly': 'repository-local',
  });
  assert.equal(result.selectedOverrideIndex, 0);
});

test('resolveLayeredPolicy escapes dotted keys and keeps leaf provenance distinct', () => {
  const result = resolveLayeredPolicy({
    localDocument: {
      exists: true,
      config: {
        'x-a.b': 'literal extension',
        'x-a': { b: 'nested extension' },
      },
    },
    identity: {
      githubSlug: 'owner/repo',
      hasGithubOrigin: true,
      mainWorktreeRoot: '/srv/repo',
    },
    defaults: {
      'x-a.b': 'default literal extension',
      'x-a': { b: 'default nested extension' },
    },
  });

  assert.deepEqual(result.config, {
    'x-a.b': 'literal extension',
    'x-a': { b: 'nested extension' },
  });
  assert.deepEqual(result.sourceMap, {
    'x-a\\.b': 'repository-local',
    'x-a.b': 'repository-local',
  });
});

test('resolveLayeredPolicy removes stale empty-object provenance after a child merge', () => {
  const result = resolveLayeredPolicy({
    localDocument: { exists: false },
    identity: {
      githubSlug: 'owner/repo',
      hasGithubOrigin: true,
      mainWorktreeRoot: '/srv/repo',
    },
    defaults: { critiqueLoop: {} },
    userGlobalConfig: {
      critiqueLoop: {},
      overrides: [
        {
          match: { repo: 'owner/repo' },
          config: { critiqueLoop: { deferByUrgency: 'low' } },
        },
      ],
    },
  });

  assert.equal(result.sourceMap.critiqueLoop, undefined);
  assert.equal(
    result.sourceMap['critiqueLoop.deferByUrgency'],
    'user-global-override',
  );
});

test('repository-policy fields stay local when a local document exists', () => {
  const identity = {
    githubSlug: 'owner/repo',
    hasGithubOrigin: true,
    mainWorktreeRoot: '/srv/repo',
  };
  const repositoryPolicyAliases = {
    'forced-handoff': { mode: 'disabled' },
    forcedHandoffMode: 'disabled',
    'forced-handoff-mode': 'disabled',
    forcedHandoffAuthority: 'owners-and-maintainers-only',
    'forced-handoff-authority': 'owners-and-maintainers-only',
    markerTrustAllowCollaboratorMarkers: false,
    allowCollaboratorMarkers: false,
    reviewPolicy: 'no-advisory',
  };
  const userGlobalConfig = {
    ...repositoryPolicyAliases,
    localValidationEvidence: { maxAge: 'PT9H' },
    helperRuntime: { profile: 'package-manager' },
    markerPrefix: 'global',
    mergePolicy: 'fully_autonomous_merge',
    mergeGate: { soloCodeownerAdminFallback: 'auto-admin-retry' },
    issueScope: 'roadmap-first',
    overrides: [
      {
        match: { repo: 'owner/repo' },
        config: {
          'forced-handoff': { mode: 'human-gated' },
          forcedHandoffMode: 'human-gated',
          'forced-handoff-mode': 'human-gated',
          forcedHandoffAuthority: 'all-write-permission-actors',
          'forced-handoff-authority': 'all-write-permission-actors',
          markerTrustAllowCollaboratorMarkers: true,
          allowCollaboratorMarkers: true,
          reviewPolicy: 'copilot-advisory',
          localValidationEvidence: { maxAge: 'PT12H' },
          helperRuntime: { profile: 'vendored-node' },
          markerPrefix: 'override',
          mergeGate: { soloCodeownerAdminFallback: 'hold-and-report' },
          issueScope: 'orphan-first',
        },
      },
    ],
  };
  const local = resolveLayeredPolicy({
    localDocument: { exists: true, config: { markerPrefix: 'local' } },
    identity,
    defaults: {
      helperRuntime: { profile: 'instructions-only' },
      markerPrefix: 'default',
      mergePolicy: 'human_merge',
      mergeGate: { soloCodeownerAdminFallback: 'auto-admin-retry' },
    },
    userGlobalConfig,
  });
  assert.equal(
    local.config.helperRuntime &&
      (local.config.helperRuntime as { profile: string }).profile,
    'instructions-only',
  );
  assert.equal(local.config.markerPrefix, 'local');
  assert.equal(local.config.mergePolicy, 'human_merge');
  assert.equal(local.config.localValidationEvidence, undefined);
  for (const key of Object.keys(repositoryPolicyAliases)) {
    assert.equal(
      Object.hasOwn(local.config, key),
      false,
      `global repository-policy alias ${key} must be filtered`,
    );
  }
  assert.deepEqual(local.config.mergeGate, {
    soloCodeownerAdminFallback: 'auto-admin-retry',
  });
  assert.equal(local.config.issueScope, 'orphan-first');
  assert.equal(local.sourceMap['helperRuntime.profile'], 'default');
  assert.equal(local.sourceMap.markerPrefix, 'repository-local');
  assert.equal(local.sourceMap.issueScope, 'user-global-override');

  const noLocal = resolveLayeredPolicy({
    localDocument: { exists: false },
    identity,
    userGlobalConfig,
  });
  assert.equal(
    noLocal.config.helperRuntime &&
      (noLocal.config.helperRuntime as { profile: string }).profile,
    'vendored-node',
  );
  assert.equal(noLocal.config.markerPrefix, 'override');
  assert.equal(noLocal.config.mergePolicy, 'fully_autonomous_merge');
  assert.equal(noLocal.config['forced-handoff-mode'], 'human-gated');
  assert.equal(noLocal.config.forcedHandoffMode, 'human-gated');
  assert.equal(
    noLocal.config['forced-handoff-authority'],
    'all-write-permission-actors',
  );
  assert.equal(noLocal.config.markerTrustAllowCollaboratorMarkers, true);
  assert.equal(noLocal.config.allowCollaboratorMarkers, true);
  assert.equal(noLocal.config.reviewPolicy, 'copilot-advisory');
  assert.deepEqual(noLocal.config.localValidationEvidence, {
    maxAge: 'PT12H',
  });
  assert.deepEqual(noLocal.config.mergeGate, {
    soloCodeownerAdminFallback: 'hold-and-report',
  });
  assert.equal(noLocal.sourceMap.mergePolicy, 'user-global');
});

test('a malformed higher-layer value blocks inheritance at that field', () => {
  const result = resolveLayeredPolicy({
    localDocument: {
      exists: true,
      config: { critiqueLoop: 'not-an-object' },
    },
    identity: {
      githubSlug: null,
      hasGithubOrigin: false,
      mainWorktreeRoot: '/srv/repo',
    },
    defaults: { critiqueLoop: { deferAfterRounds: [1] } },
    userGlobalConfig: {
      critiqueLoop: { deferAfterRounds: [2] },
    },
  });
  assert.equal(result.config.critiqueLoop, 'not-an-object');
  assert.equal(result.sourceMap.critiqueLoop, 'repository-local');
  assert.equal(result.sourceMap['critiqueLoop.deferAfterRounds'], undefined);
});

test('malformed repository-local delegates do not inherit global commands', () => {
  const result = resolveLayeredPolicy({
    localDocument: {
      exists: true,
      config: { critiqueLoop: { delegate: { mode: 'combined' } } },
    },
    identity: {
      githubSlug: 'owner/repo',
      hasGithubOrigin: true,
      mainWorktreeRoot: '/srv/repo',
    },
    userGlobalConfig: {
      critiqueLoop: {
        delegate: { command: 'global-reviewer', mode: 'combined' },
      },
    },
  });

  assert.deepEqual(result.config.critiqueLoop, {
    delegate: { mode: 'combined' },
  });
  assert.equal(
    result.sourceMap['critiqueLoop.delegate.mode'],
    'repository-local',
  );
  assert.equal(result.sourceMap['critiqueLoop.delegate.command'], undefined);
});

test('malformed local issue-authoring delegates do not inherit global commands', () => {
  const result = resolveLayeredPolicy({
    localDocument: {
      exists: true,
      config: {
        issueAuthoring: {
          adversarialReview: { delegate: { mode: 'combined' } },
        },
      },
    },
    identity: {
      githubSlug: 'owner/repo',
      hasGithubOrigin: true,
      mainWorktreeRoot: '/srv/repo',
    },
    userGlobalConfig: {
      issueAuthoring: {
        adversarialReview: {
          delegate: { command: 'global-reviewer', mode: 'combined' },
        },
      },
    },
  });

  assert.deepEqual(
    (result.config.issueAuthoring as { adversarialReview: unknown })
      .adversarialReview,
    { delegate: { mode: 'combined' } },
  );
  assert.equal(
    result.sourceMap['issueAuthoring.adversarialReview.delegate.mode'],
    'repository-local',
  );
  assert.equal(
    result.sourceMap['issueAuthoring.adversarialReview.delegate.command'],
    undefined,
  );
});

test('loadRepositoryPolicyDocument applies canonical-first and legacy fallback semantics', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-repository-policy-'));
  const legacyPath = writeRepositoryPolicy(
    root,
    'idd-policy.json',
    JSON.stringify({ markerPrefix: 'legacy' }),
  );
  const legacy = loadRepositoryPolicyDocument(root);
  assert.equal(legacy.exists, true);
  assert.equal(legacy.path, legacyPath);
  assert.deepEqual(legacy.config, { markerPrefix: 'legacy' });

  const canonicalPath = writeRepositoryPolicy(
    root,
    '.github/idd/config.json',
    JSON.stringify({ markerPrefix: 'canonical' }),
  );
  const canonical = loadRepositoryPolicyDocument(root);
  assert.equal(canonical.path, canonicalPath);
  assert.deepEqual(canonical.config, { markerPrefix: 'canonical' });

  writeFileSync(canonicalPath, '{ malformed');
  const brokenCanonical = loadRepositoryPolicyDocument(root);
  assert.equal(brokenCanonical.exists, true);
  assert.equal(brokenCanonical.path, canonicalPath);
  assert.equal(brokenCanonical.config, undefined);
  assert.match(
    brokenCanonical.diagnostic ?? '',
    /cannot parse repository policy/u,
  );

  const blocked = resolveLayeredPolicy({
    localDocument: brokenCanonical,
    identity: {
      githubSlug: 'owner/repo',
      hasGithubOrigin: true,
      mainWorktreeRoot: '/srv/repo',
    },
    defaults: {
      markerPrefix: 'default',
      helperRuntime: { profile: 'instructions-only' },
    },
    userGlobalConfig: {
      markerPrefix: 'global',
      helperRuntime: { profile: 'package-manager' },
      issueScope: 'roadmap-first',
    },
  });
  assert.equal(blocked.config.markerPrefix, 'default');
  assert.equal(
    blocked.config.helperRuntime &&
      (blocked.config.helperRuntime as { profile: string }).profile,
    'instructions-only',
  );
  assert.equal(blocked.config.issueScope, 'roadmap-first');
  assert.equal(blocked.diagnostics.length, 1);
});

test('REPOSITORY_POLICY_FIELDS is covered by policy schema properties', () => {
  const policySchema = JSON.parse(
    readFileSync(
      new URL('../schemas/policy.schema.json', import.meta.url),
      'utf8',
    ),
  ) as { properties: Record<string, unknown> };
  const fields = Object.keys(REPOSITORY_POLICY_FIELDS);
  for (const field of fields) {
    assert.ok(
      Object.hasOwn(policySchema.properties, field),
      `${field} missing from policy schema`,
    );
  }
  for (const required of [
    'helperRuntime',
    'trustedMarkerActors',
    'ciGate',
    'advisoryWait',
    'advisoryConvergence',
    'mergePolicy',
    'mergeGate',
    'markerPrefix',
    'localValidationEvidence',
  ]) {
    assert.ok(
      fields.includes(required),
      `${required} missing from repository policy fields`,
    );
  }
});

// --- forced-handoff preflight reader (#3872) ----------------------------

test('readTrustedForcedHandoffMode reports human-gated when the trusted copy sets it', () => {
  const reading = readTrustedForcedHandoffMode('o', 'r', 'main', () =>
    toEncodedConfig({ forcedHandoff: { mode: 'human-gated' } }),
  );
  assert.deepEqual(reading, { status: 'human-gated', ref: 'main' });
});

test('readTrustedForcedHandoffMode resolves the legacy forcedHandoffMode alias the way F2 does', () => {
  const reading = readTrustedForcedHandoffMode('o', 'r', 'main', () =>
    toEncodedConfig({ forcedHandoffMode: 'human-gated' }),
  );
  assert.deepEqual(reading, { status: 'human-gated', ref: 'main' });
});

test('readTrustedForcedHandoffMode reports another mode, and an absent block as disabled', () => {
  assert.deepEqual(
    readTrustedForcedHandoffMode('o', 'r', 'main', () =>
      toEncodedConfig({ forcedHandoff: { mode: 'disabled' } }),
    ),
    { status: 'other', ref: 'main', mode: 'disabled' },
  );
  assert.deepEqual(
    readTrustedForcedHandoffMode('o', 'r', 'main', () =>
      toEncodedConfig({ claimTiming: { staleAge: 'PT24H' } }),
    ),
    { status: 'other', ref: 'main', mode: 'disabled' },
  );
});

test('readTrustedForcedHandoffMode reports a confirmed 404 (no config file at the ref) as other', () => {
  const reading = readTrustedForcedHandoffMode('o', 'r', 'main', () => {
    throw syntheticNotFoundError();
  });
  assert.deepEqual(reading, { status: 'other', ref: 'main', mode: null });
});

test('readTrustedForcedHandoffMode keeps a read or parse failure unreadable, never other', () => {
  const network = readTrustedForcedHandoffMode('o', 'r', 'main', () => {
    throw new Error('network timeout');
  });
  assert.equal(network.status, 'unreadable');
  assert.ok(
    network.status === 'unreadable' &&
      network.error.includes('network timeout'),
  );

  const notAnObject = readTrustedForcedHandoffMode('o', 'r', 'main', () =>
    toEncodedConfig(null),
  );
  assert.equal(notAnObject.status, 'unreadable');
});

// --- forced-handoff preflight evaluator (#3872) -------------------------

const PREFLIGHT_CLAIM = 'issue/1-add-x';

test('evaluateForcedHandoffPreflight passes when the PR base and the claim branch confirm human-gated', () => {
  const reads: string[] = [];
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [{ number: 2, baseRefName: 'main' }],
    deps: {
      readMode: (_owner, _repo, ref) => {
        reads.push(ref);
        return { status: 'human-gated', ref };
      },
      readDefaultBranch: () => {
        throw new Error('default branch is not read when PR bases are known');
      },
      probeBranch: () => {
        throw new Error('the branch is not probed when a PR proves it');
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.refusal, null);
  assert.deepEqual(reads, ['main', PREFLIGHT_CLAIM]);
});

test('evaluateForcedHandoffPreflight reads each distinct PR base once, across several PRs', () => {
  const reads: string[] = [];
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [
      { number: 2, baseRefName: 'main' },
      { number: 3, baseRefName: 'main' },
      { number: 4, baseRefName: 'release/1' },
    ],
    deps: {
      readMode: (_owner, _repo, ref) => {
        reads.push(ref);
        return { status: 'human-gated', ref };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(reads, ['main', 'release/1', PREFLIGHT_CLAIM]);
});

test('evaluateForcedHandoffPreflight with no open PR checks the default branch and a present claim branch', () => {
  const reads: string[] = [];
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [],
    deps: {
      readMode: (_owner, _repo, ref) => {
        reads.push(ref);
        return { status: 'human-gated', ref };
      },
      readDefaultBranch: () => 'trunk',
      probeBranch: () => 'present',
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(reads, ['trunk', PREFLIGHT_CLAIM]);
});

test('evaluateForcedHandoffPreflight fails closed on a PR row with no base ref', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [{ number: 2, baseRefName: '' }],
    deps: {
      readMode: (_owner, _repo, ref) => ({ status: 'human-gated', ref }),
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.refusal?.includes('the base branch of PR #2 could not be read'),
    result.refusal ?? 'no refusal',
  );
  assert.ok(
    result.refusal?.includes('no base ref was returned for PR #2'),
    result.refusal ?? 'no refusal',
  );
});

test('evaluateForcedHandoffPreflight records a throwing read as unreadable and never throws', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [{ number: 2, baseRefName: 'main' }],
    deps: {
      readMode: () => {
        throw new Error('boom');
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].reading.status, 'unreadable');
  assert.ok(result.refusal?.includes('boom'), result.refusal ?? 'no refusal');
});

test('evaluateForcedHandoffPreflight names the copy and the sequence in its refusal', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [{ number: 2, baseRefName: 'main' }],
    deps: {
      readMode: (_owner, _repo, ref) =>
        ref === 'main'
          ? { status: 'other', ref, mode: 'disabled' }
          : { status: 'human-gated', ref },
    },
  });
  assert.equal(result.ok, false);
  const refusal = result.refusal ?? '';
  assert.ok(refusal.includes('the base branch main'), refusal);
  assert.ok(refusal.includes('sets forcedHandoff.mode to disabled'), refusal);
  assert.ok(refusal.includes('claim-id-mismatch'), refusal);
  assert.ok(refusal.includes('push the merge'), refusal);
  assert.ok(refusal.includes('the opt-in must land there'), refusal);
  assert.ok(
    refusal.includes(
      'Commit the opt-in to the base branch through its normal pull-request path',
    ),
    refusal,
  );
});

test('evaluateForcedHandoffPreflight with no PR asks for the mode on a claim branch that sets another mode', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [],
    deps: {
      readMode: (_owner, _repo, ref) =>
        ref === PREFLIGHT_CLAIM
          ? { status: 'other', ref, mode: 'disabled' }
          : { status: 'human-gated', ref },
      readDefaultBranch: () => 'trunk',
      probeBranch: () => 'present',
    },
  });
  assert.equal(result.ok, false);
  const refusal = result.refusal ?? '';
  assert.ok(
    refusal.includes(
      `the claim branch ${PREFLIGHT_CLAIM} sets forcedHandoff.mode to disabled`,
    ),
    refusal,
  );
  assert.ok(
    refusal.includes(
      'Set forcedHandoff.mode to human-gated on the claim branch issue/1-add-x',
    ),
    refusal,
  );
});

test('evaluateForcedHandoffPreflight with no PR merges the default branch into a claim branch that has no config file', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [],
    deps: {
      readMode: (_owner, _repo, ref) =>
        ref === PREFLIGHT_CLAIM
          ? { status: 'other', ref, mode: null }
          : { status: 'human-gated', ref },
      readDefaultBranch: () => 'trunk',
      probeBranch: () => 'present',
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    (result.refusal ?? '').includes(
      'merge the default branch into it and push the merge',
    ),
    result.refusal ?? 'no refusal',
  );
});

test('evaluateForcedHandoffPreflight restores a read rather than writing when the claim branch probe fails', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [],
    deps: {
      readMode: (_owner, _repo, ref) => ({ status: 'human-gated', ref }),
      readDefaultBranch: () => 'trunk',
      probeBranch: () => {
        throw new Error('gh: API rate limit (HTTP 500)');
      },
    },
  });
  assert.equal(result.ok, false);
  const refusal = result.refusal ?? '';
  assert.ok(refusal.includes('HTTP 500'), refusal);
  assert.ok(
    refusal.endsWith('Restore the read named above, then rerun.'),
    refusal,
  );
  assert.equal(refusal.includes('repair that file'), false, refusal);
  assert.equal(/merge the default branch/i.test(refusal), false, refusal);
});

test('evaluateForcedHandoffPreflight asks for the mode on a PR claim branch that lacks the opt-in, not a commit to the base', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [{ number: 2, baseRefName: 'main' }],
    deps: {
      readMode: (_owner, _repo, ref) =>
        ref === PREFLIGHT_CLAIM
          ? { status: 'other', ref, mode: 'disabled' }
          : { status: 'human-gated', ref },
    },
  });
  assert.equal(result.ok, false);
  const refusal = result.refusal ?? '';
  assert.ok(
    refusal.includes(
      'Set forcedHandoff.mode to human-gated on the claim branch issue/1-add-x',
    ),
    refusal,
  );
  assert.equal(refusal.includes('Commit the opt-in'), false, refusal);
});

test('evaluateForcedHandoffPreflight restores a failed lookup, and offers a conditional config repair for a config read', () => {
  const unknownDefault = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [],
    deps: {
      readMode: (_owner, _repo, ref) => ({ status: 'human-gated', ref }),
      readDefaultBranch: () => null,
      probeBranch: () => 'absent',
    },
  });
  const missingBase = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [{ number: 2, baseRefName: '' }],
    deps: {
      readMode: (_owner, _repo, ref) => ({ status: 'human-gated', ref }),
    },
  });
  for (const result of [unknownDefault, missingBase]) {
    const refusal = result.refusal ?? '';
    assert.ok(
      refusal.endsWith('Restore the read named above, then rerun.'),
      refusal,
    );
    assert.equal(refusal.includes('Commit the opt-in'), false, refusal);
  }
  // A config that could not be read may also be repaired at its source.
  const configRead = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [],
    deps: {
      readMode: (_owner, _repo, ref) =>
        ref === 'trunk'
          ? { status: 'unreadable', ref, error: 'expected a JSON object' }
          : { status: 'human-gated', ref },
      readDefaultBranch: () => 'trunk',
      probeBranch: () => 'absent',
    },
  });
  assert.ok(
    (configRead.refusal ?? '').includes(
      'is not valid JSON or is not a JSON object, repair that file',
    ),
    configRead.refusal ?? 'no refusal',
  );
});

test('evaluateForcedHandoffPreflight with no PR asks for the opt-in on the default branch when that copy lacks it', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [],
    deps: {
      readMode: (_owner, _repo, ref) => ({
        status: 'other',
        ref,
        mode: 'disabled',
      }),
      readDefaultBranch: () => 'trunk',
      probeBranch: () => 'absent',
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    (result.refusal ?? '').includes(
      'Commit the opt-in to the default branch through its normal pull-request path, then rerun.',
    ),
    result.refusal ?? 'no refusal',
  );
});

test('evaluateForcedHandoffPreflight merges the PR base into a PR claim branch that has no config file', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [{ number: 2, baseRefName: 'main' }],
    deps: {
      readMode: (_owner, _repo, ref) =>
        ref === PREFLIGHT_CLAIM
          ? { status: 'other', ref, mode: null }
          : { status: 'human-gated', ref },
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    (result.refusal ?? '').includes(
      "merge the PR's base branch into it and push the merge",
    ),
    result.refusal ?? 'no refusal',
  );
});

test('evaluateForcedHandoffPreflight refuses when the live default branch cannot be determined', () => {
  const result = evaluateForcedHandoffPreflight({
    owner: 'o',
    repo: 'r',
    claimBranch: PREFLIGHT_CLAIM,
    openPrs: [],
    deps: {
      readMode: (_owner, _repo, ref) => ({ status: 'human-gated', ref }),
      readDefaultBranch: () => null,
      probeBranch: () => 'absent',
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.refusal?.includes('could not determine the live default branch'),
    result.refusal ?? 'no refusal',
  );
});

const LAYERED_TEST_IDENTITY = {
  githubSlug: 'owner/repo',
  hasGithubOrigin: true,
  mainWorktreeRoot: '/srv/repo',
};

test('a malformed local telemetry hook does not inherit a global command', () => {
  const result = resolveLayeredPolicy({
    localDocument: {
      exists: true,
      config: { critiqueLoop: { telemetryHook: {} } },
    },
    identity: LAYERED_TEST_IDENTITY,
    userGlobalConfig: {
      critiqueLoop: { telemetryHook: { command: 'global-hook' } },
    },
  });

  assert.deepEqual(result.config.critiqueLoop, { telemetryHook: {} });
  assert.equal(
    result.sourceMap['critiqueLoop.telemetryHook.command'],
    undefined,
  );
});

test('a local document keeps inheriting the global adversarial-review delegate', () => {
  const result = resolveLayeredPolicy({
    localDocument: {
      exists: true,
      config: { issueAuthoring: { authoringLabelName: 'status:drafting' } },
    },
    identity: LAYERED_TEST_IDENTITY,
    userGlobalConfig: {
      issueAuthoring: {
        authoringLabelName: 'global-label',
        adversarialReview: {
          delegate: { command: 'global-reviewer', mode: 'combined' },
        },
      },
    },
  });
  const issueAuthoring = result.config.issueAuthoring as {
    authoringLabelName: unknown;
    adversarialReview: unknown;
  };

  assert.equal(issueAuthoring.authoringLabelName, 'status:drafting');
  assert.deepEqual(issueAuthoring.adversarialReview, {
    delegate: { command: 'global-reviewer', mode: 'combined' },
  });
});

test('a malformed local adversarialReview container blocks the global delegate', () => {
  const result = resolveLayeredPolicy({
    localDocument: {
      exists: true,
      config: { issueAuthoring: { adversarialReview: { typo: true } } },
    },
    identity: LAYERED_TEST_IDENTITY,
    userGlobalConfig: {
      issueAuthoring: {
        adversarialReview: {
          delegate: { command: 'global-reviewer', mode: 'combined' },
        },
      },
    },
  });

  assert.deepEqual(
    (result.config.issueAuthoring as { adversarialReview: unknown })
      .adversarialReview,
    { typo: true },
  );
});
