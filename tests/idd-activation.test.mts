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
import {
  computeActivation,
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
      const path = join(current, name);
      entries.push(path.slice(dir.length));
      if (statSync(path).isDirectory()) visit(path);
    }
  };
  visit(dir);
  return entries;
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

test('the user-global entry text stays within its byte limit and names the helper', () => {
  const text = readFileSync(ENTRY_PATH, 'utf8');
  assert.ok(
    Buffer.byteLength(text, 'utf8') <= ENTRY_LIMIT_BYTES,
    `entry text must stay within ${ENTRY_LIMIT_BYTES} bytes`,
  );
  assert.match(text, /idd-activation/);
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
    const result = spawnSync(process.execPath, [script, '--cwd', repo], {
      env: box.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout) as {
      active: boolean;
      tier: string;
    };
    assert.equal(verdict.active, true);
    assert.equal(verdict.tier, 'repository-local');
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
