import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  DistributionRoutingResult,
  DistributionSelectionReport,
} from '../src/scripts/distribution-selection.mts';
import {
  computeActivation,
  computeActivationForSession,
  resolveInstalledPayloadRoot,
} from '../src/scripts/idd-activation.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY_PATH = join(REPO_ROOT, 'idd-template/user-global/entry.md');
const ENTRY_LIMIT_BYTES = 1200;

function sandbox(): {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'idd-activation-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
  git(dir, ['commit', '--allow-empty', '--quiet', '-m', 'init']);
  return realpathSync(dir);
}

function writeFile(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

function installPayload(env: NodeJS.ProcessEnv): void {
  writeFile(
    join(
      env.XDG_DATA_HOME as string,
      'idd-skill',
      'current',
      '.github/instructions/idd-overview-core.instructions.md',
    ),
    '# core\n',
  );
}

function writeUserGlobal(env: NodeJS.ProcessEnv, document: unknown): void {
  const dir = join(env.XDG_CONFIG_HOME as string, 'idd-skill');
  writeFile(join(dir, 'config.json'), JSON.stringify(document));
}

function listTree(dir: string): string[] {
  const entries: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      // git writes its own bookkeeping, such as maintenance locks, from
      // background processes, so the snapshot covers working files only.
      if (name === '.git') continue;
      const path = join(current, name);
      entries.push(path.slice(dir.length));
      if (statSync(path).isDirectory()) visit(path);
    }
  };
  visit(dir);
  return entries;
}

function fakeRouting(
  overrides: Partial<DistributionSelectionReport> = {},
  route: DistributionRoutingResult['route'] = 'prepared-set',
  instructionsRoot = '/prepared/idd-template',
): DistributionRoutingResult {
  return {
    report: {
      schemaVersion: 1,
      repository: 'acme/app',
      session: { id: 'session-one', binding: 'bound' },
      verdict: 'session-bound',
      selected: { sourceCommit: 'a'.repeat(40), components: {} },
      previousVerifiedSet: null,
      packageVersion: null,
      preparation: 'prepared',
      compatibility: 'compatible',
      source: 'global-current',
      recovery: 'none',
      receipt: { status: 'verified' },
      mutation: 'none',
      ...overrides,
    },
    route,
    instructionsRoot: route === 'none' ? null : instructionsRoot,
  };
}

test('payload root prefers a qualified XDG_DATA_HOME', () => {
  assert.equal(
    resolveInstalledPayloadRoot({
      env: {
        XDG_DATA_HOME: resolve('activation-xdg-data'),
        HOME: resolve('activation-home'),
      },
    }),
    join(resolve('activation-xdg-data'), 'idd-skill', 'current'),
  );
});

test('payload root falls back to HOME when XDG_DATA_HOME is unset', () => {
  assert.equal(
    resolveInstalledPayloadRoot({ env: { HOME: resolve('activation-home') } }),
    join(resolve('activation-home'), '.local', 'share', 'idd-skill', 'current'),
  );
});

test('payload root ignores a relative XDG_DATA_HOME', () => {
  assert.equal(
    resolveInstalledPayloadRoot({
      env: { XDG_DATA_HOME: 'relative/data', HOME: resolve('activation-home') },
    }),
    join(resolve('activation-home'), '.local', 'share', 'idd-skill', 'current'),
  );
});

test('payload root is undefined when no qualified root exists', () => {
  assert.equal(resolveInstalledPayloadRoot({ env: {} }), undefined);
});

test('a directory outside Git stays inactive', () => {
  const box = sandbox();
  try {
    const dir = join(box.root, 'plain');
    mkdirSync(dir);
    const result = computeActivation({ cwd: dir, env: box.env });
    assert.equal(result.active, false);
    assert.equal(result.reason, 'not-a-git-work-tree');
    assert.equal(result.tier, 'none');
    assert.equal(result.instructionsRoot, null);
  } finally {
    box.cleanup();
  }
});

test('a repository with its own instruction files is repository-local', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(
      join(repo, '.github/instructions/idd-overview-core.instructions.md'),
      '# core\n',
    );
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.deepEqual(result, {
      active: true,
      tier: 'repository-local',
      instructionsRoot: repo,
      reason: 'repository-instruction-files',
    });
  } finally {
    box.cleanup();
  }
});

test('session activation opens only the selected route after binding', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(
      join(repo, '.github/instructions/idd-overview-core.instructions.md'),
      '# core\n',
    );
    const result = computeActivationForSession({
      cwd: repo,
      env: box.env,
      sessionId: 'session-one',
      inspectRouting: () => fakeRouting({}, 'repository-local', repo),
    });
    assert.equal(result.active, true);
    assert.equal(result.selection?.status, 'ready');
    assert.equal(result.instructionsRoot, repo);
  } finally {
    box.cleanup();
  }
});

test('an unbound selected set requires explicit binding before opening', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(join(repo, '.github/idd/config.json'), '{}\n');
    const result = computeActivationForSession({
      cwd: repo,
      env: box.env,
      sessionId: 'session-one',
      inspectRouting: () =>
        fakeRouting({
          session: { id: 'session-one', binding: 'unbound' },
          verdict: 'coherent-candidate',
        }),
    });
    assert.equal(result.active, true);
    assert.equal(result.selection?.status, 'binding-required');
    assert.equal(result.instructionsRoot, null);
  } finally {
    box.cleanup();
  }
});

test('an active policy with non-ready selection stays active and has no root', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(join(repo, '.github/idd/config.json'), '{}\n');
    const result = computeActivationForSession({
      cwd: repo,
      env: box.env,
      sessionId: 'session-one',
      inspectRouting: () =>
        fakeRouting(
          {
            session: { id: 'session-one', binding: 'unbound' },
            verdict: 'preparation-missing',
            selected: null,
            preparation: 'preparation-missing',
            compatibility: 'unknown',
            recovery: 'prepare',
          },
          'none',
        ),
    });
    assert.equal(result.active, true);
    assert.equal(result.selection?.status, 'not-ready');
    assert.equal(result.selection?.recovery, 'prepare');
    assert.equal(result.instructionsRoot, null);
  } finally {
    box.cleanup();
  }
});

test('a missing stable session ID stops active routing without inspecting', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(join(repo, '.github/idd/config.json'), '{}\n');
    let inspected = false;
    const result = computeActivationForSession({
      cwd: repo,
      env: box.env,
      inspectRouting: () => {
        inspected = true;
        return fakeRouting();
      },
    });
    assert.equal(result.active, true);
    assert.equal(result.selection?.status, 'not-ready');
    assert.equal(result.selection?.reason, 'session-id-required');
    assert.equal(result.instructionsRoot, null);
    assert.equal(inspected, false);
  } finally {
    box.cleanup();
  }
});

test('a linked worktree uses its own instruction files as the root', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    const linked = join(box.root, 'repo-linked');
    git(repo, ['worktree', 'add', '--quiet', linked]);
    writeFile(
      join(linked, '.github/instructions/idd-overview-core.instructions.md'),
      '# core\n',
    );
    const result = computeActivation({
      cwd: linked,
      env: box.env,
    });
    assert.equal(result.tier, 'repository-local');
    assert.equal(result.instructionsRoot, realpathSync(linked));
  } finally {
    box.cleanup();
  }
});

test('a repository with only a policy document is a minimal import', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(join(repo, '.github/idd/config.json'), '{}\n');
    installPayload(box.env);
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.deepEqual(result, {
      active: true,
      tier: 'repository-local',
      instructionsRoot: join(
        box.env.XDG_DATA_HOME as string,
        'idd-skill',
        'current',
      ),
      reason: 'repository-policy-minimal-import',
    });
  } finally {
    box.cleanup();
  }
});

test('a policy-only repository fails closed when no payload root resolves', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(join(repo, '.github/idd/config.json'), '{}\n');
    const result = computeActivation({ cwd: repo, env: {} });
    assert.equal(result.active, false);
    assert.equal(result.reason, 'payload-root-unresolved');
  } finally {
    box.cleanup();
  }
});

test('a repository with instruction files and a matching override resolves to repository-local', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(
      join(repo, '.github/instructions/idd-overview-core.instructions.md'),
      '# core\n',
    );
    writeUserGlobal(box.env, {
      overrides: [
        { match: { path: basename(repo) }, config: { issueScope: 'roadmap' } },
      ],
    });
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.equal(result.tier, 'repository-local');
    assert.equal(result.instructionsRoot, repo);
  } finally {
    box.cleanup();
  }
});

test('a matching user-global override activates with the installed payload', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    installPayload(box.env);
    writeUserGlobal(box.env, {
      overrides: [
        { match: { path: basename(repo) }, config: { issueScope: 'roadmap' } },
      ],
    });
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.deepEqual(result, {
      active: true,
      tier: 'user-global-override',
      instructionsRoot: join(
        box.env.XDG_DATA_HOME as string,
        'idd-skill',
        'current',
      ),
      reason: 'user-global-override-match',
    });
  } finally {
    box.cleanup();
  }
});

test('a user-global document with no matching override stays inactive', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeUserGlobal(box.env, {
      overrides: [
        {
          match: { path: 'somewhere-else' },
          config: { issueScope: 'roadmap' },
        },
      ],
    });
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.equal(result.active, false);
    assert.equal(result.reason, 'no-activation-rule');
  } finally {
    box.cleanup();
  }
});

test('a bare user-global document never activates by itself', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeUserGlobal(box.env, { issueScope: 'roadmap' });
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.equal(result.active, false);
    assert.equal(result.reason, 'no-activation-rule');
  } finally {
    box.cleanup();
  }
});

test('activation runs with HOME unset and writes nothing', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(
      join(repo, '.github/instructions/idd-overview-core.instructions.md'),
      '# core\n',
    );
    const before = listTree(box.root);
    const result = computeActivation({ cwd: repo, env: {} });
    assert.equal(result.tier, 'repository-local');
    assert.deepEqual(listTree(box.root), before);
  } finally {
    box.cleanup();
  }
});

test('the user-global entry names installed activation fallbacks', () => {
  const text = readFileSync(ENTRY_PATH, 'utf8');
  assert.ok(
    Buffer.byteLength(text, 'utf8') <= ENTRY_LIMIT_BYTES,
    `entry text must stay within ${ENTRY_LIMIT_BYTES} bytes`,
  );
  assert.match(text, /idd-activation/);
  assert.match(text, /--session-id/);
  assert.match(text, /binding-required/);
  assert.match(text, /selection\.status: ready/);
  assert.match(text, /selection\.recovery/);
  assert.match(
    text,
    /idd-onboard --distribution prepare --session-id <id> --source <checkout>/,
  );
  assert.match(text, /idd-onboard --distribution inspect --session-id <id>/);
  assert.match(text, /rerun activation after recovery/);
  assert.match(text, /~\/\.local\/bin\/idd-activation/);
  assert.ok(text.includes('& "$HOME\\.local\\bin\\idd-activation.cmd"'));
  assert.ok(text.includes('"%USERPROFILE%\\.local\\bin\\idd-activation.cmd"'));
  assert.doesNotMatch(text, /\$PAYLOAD\/scripts\/idd-activation\.mjs/);
});

test('Windows cmd resolves the user-profile activation fallback', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'idd-activation-cmd-'));
  try {
    const home = join(root, 'home with spaces');
    const localBin = join(home, '.local', 'bin');
    const command = join(localBin, 'idd-activation.cmd');
    mkdirSync(localBin, { recursive: true });
    writeFileSync(
      command,
      '@echo off\r\n"%IDD_NODE_EXECUTABLE%" "%IDD_ACTIVATION_SCRIPT%" %*\r\nexit /b %ERRORLEVEL%\r\n',
    );

    const commandLine =
      '""%USERPROFILE%\\.local\\bin\\idd-activation.cmd" --help"';
    const result = spawnSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', commandLine],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          USERPROFILE: home,
          IDD_NODE_EXECUTABLE: process.execPath,
          IDD_ACTIVATION_SCRIPT: resolve(
            REPO_ROOT,
            'scripts/idd-activation.mjs',
          ),
        },
        timeout: 10_000,
        windowsVerbatimArguments: true,
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows PowerShell resolves the user-profile activation fallback', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), 'idd-activation-powershell-'),
  );
  try {
    const home = join(root, 'home with spaces');
    const localBin = join(home, '.local', 'bin');
    const command = join(localBin, 'idd-activation.cmd');
    mkdirSync(localBin, { recursive: true });
    writeFileSync(
      command,
      '@echo off\r\necho idd-powershell-activation-fallback-ok\r\nexit /b 0\r\n',
    );

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Set-Variable -Name HOME -Value $env:IDD_TEST_HOME -Force; & "$HOME\\.local\\bin\\idd-activation.cmd"',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          IDD_TEST_HOME: home,
        },
        timeout: 10_000,
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /idd-powershell-activation-fallback-ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the activation CLI prints the JSON verdict for a directory', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(
      join(repo, '.github/instructions/idd-overview-core.instructions.md'),
      '# core\n',
    );
    const script = resolve(REPO_ROOT, 'scripts/idd-activation.mjs');
    assert.ok(existsSync(script), 'the built helper must exist');
    const result = spawnSync(
      process.execPath,
      [script, '--cwd', repo, '--session-id', 'session-cli'],
      {
        env: box.env,
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout) as {
      active: boolean;
      tier: string;
      instructionsRoot: string | null;
      selection: {
        status: string;
        report?: { session: { id: string } };
      };
    };
    assert.equal(verdict.active, true);
    assert.equal(verdict.tier, 'repository-local');
    assert.equal(verdict.instructionsRoot, null);
    assert.equal(verdict.selection.status, 'not-ready');
    assert.equal(verdict.selection.report?.session.id, 'session-cli');
  } finally {
    box.cleanup();
  }
});

test('a legacy idd-policy.json also makes a minimal import', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(join(repo, 'idd-policy.json'), '{}\n');
    installPayload(box.env);
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.equal(result.tier, 'repository-local');
    assert.equal(result.reason, 'repository-policy-minimal-import');
  } finally {
    box.cleanup();
  }
});

test('a policy-only repository reports a payload that is not installed', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(join(repo, '.github/idd/config.json'), '{}\n');
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.equal(result.active, false);
    assert.equal(result.reason, 'payload-not-installed');
  } finally {
    box.cleanup();
  }
});

test('inherited GIT_* variables do not redirect the repository lookup', () => {
  const box = sandbox();
  const saved = process.env.GIT_DIR;
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(
      join(repo, '.github/instructions/idd-overview-core.instructions.md'),
      '# core\n',
    );
    process.env.GIT_DIR = join(box.root, 'not-a-git-dir');
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.equal(result.tier, 'repository-local');
    assert.equal(result.instructionsRoot, repo);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
    box.cleanup();
  }
});

test('a directory at the instruction path does not count as instruction files', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    mkdirSync(
      join(repo, '.github/instructions/idd-overview-core.instructions.md'),
      { recursive: true },
    );
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.equal(result.active, false);
    assert.equal(result.reason, 'no-activation-rule');
  } finally {
    box.cleanup();
  }
});

test('a directory at the installed instruction path reports a payload that is not installed', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    writeFile(join(repo, '.github/idd/config.json'), '{}\n');
    mkdirSync(
      join(
        box.env.XDG_DATA_HOME as string,
        'idd-skill',
        'current',
        '.github/instructions/idd-overview-core.instructions.md',
      ),
      { recursive: true },
    );
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.equal(result.active, false);
    assert.equal(result.reason, 'payload-not-installed');
  } finally {
    box.cleanup();
  }
});

test('a directory at a policy path does not select minimal-import mode', () => {
  const box = sandbox();
  try {
    const repo = makeRepo(join(box.root, 'repo'));
    mkdirSync(join(repo, '.github/idd/config.json'), { recursive: true });
    installPayload(box.env);
    const result = computeActivation({ cwd: repo, env: box.env });
    assert.equal(result.active, false);
    assert.equal(result.reason, 'no-activation-rule');
  } finally {
    box.cleanup();
  }
});
