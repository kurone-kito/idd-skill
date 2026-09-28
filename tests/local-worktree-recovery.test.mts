import assert from 'node:assert/strict';
import {
  execFileSync,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type PrimaryRecoveryLockMarker,
  recordGeneratedClaimTokens,
} from '../src/scripts/claim-lock.mts';
import {
  assertRepositoryOverrideMatchesLocal,
  copyPathWithSafeSymlinks,
  countTaggedStashEntries,
  detectInProgressOperation,
  evaluatePrunableShortcut,
  extractDirtyEntries,
  extractDirtyPaths,
  extractIgnoredPaths,
  extractRecoveredClaim,
  hasWorkingTreeChanges,
  isAcceptedBlockReason,
  isPathContainedIn,
  isSafeRelativePath,
  type LocalGitCommandResult,
  type LocalWorktreeRecoveryDeps,
  normalizeGitWorktreePathForComparison,
  type PathPresence,
  parseArgs,
  resolveDevelopmentBranchProduction,
  resolveEffectiveRealpath,
  runLocalWorktreeRecovery,
  submoduleStatusEntries,
} from '../src/scripts/local-worktree-recovery.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

test('copyPathWithSafeSymlinks materializes in-tree links and preserves external links', {
  // Windows does not expose a no-reparse open flag through Node's standard
  // fs API, so production code fails closed before copying regular files.
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-copy-'));
  const source = join(root, 'source');
  const destination = join(root, 'preserve', 'destination');
  const external = join(root, 'external.txt');
  try {
    mkdirSync(source);
    writeFileSync(join(source, 'inside.txt'), 'inside\n');
    writeFileSync(join(source, 'executable.sh'), '#!/bin/sh\n');
    chmodSync(join(source, 'executable.sh'), 0o755);
    writeFileSync(external, 'external\n');
    symlinkSync(join(source, 'inside.txt'), join(source, 'inside-link'));
    symlinkSync(external, join(source, 'external-link'));
    symlinkSync('../external.txt', join(source, 'external-relative-link'));

    copyPathWithSafeSymlinks(source, destination, source);
    rmSync(source, { recursive: true, force: true });

    assert.equal(
      lstatSync(join(destination, 'inside-link')).isSymbolicLink(),
      false,
    );
    assert.equal(
      readFileSync(join(destination, 'inside-link'), 'utf8'),
      'inside\n',
    );
    assert.equal(
      lstatSync(join(destination, 'executable.sh')).mode & 0o111,
      0o111,
    );
    assert.equal(
      lstatSync(join(destination, 'external-link')).isSymbolicLink(),
      true,
    );
    assert.equal(readlinkSync(join(destination, 'external-link')), external);
    assert.equal(
      lstatSync(join(destination, 'external-relative-link')).isSymbolicLink(),
      true,
    );
    assert.equal(
      readFileSync(join(destination, 'external-relative-link'), 'utf8'),
      'external\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('copyPathWithSafeSymlinks materializes links into the enclosing worktree', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-copy-scope-'));
  const worktree = join(root, 'worktree');
  const scope = join(worktree, 'submodule');
  const gitDir = join(root, 'gitdir');
  const destination = join(root, 'preserve', 'shared-link');
  try {
    mkdirSync(scope, { recursive: true });
    mkdirSync(gitDir);
    writeFileSync(join(worktree, 'shared.txt'), 'shared\n');
    symlinkSync('../shared.txt', join(scope, 'link.txt'));

    copyPathWithSafeSymlinks(scope, destination, gitDir, [worktree, scope]);
    rmSync(worktree, { recursive: true, force: true });

    assert.equal(
      readFileSync(join(destination, 'link.txt'), 'utf8'),
      'shared\n',
    );
    assert.equal(
      lstatSync(join(destination, 'link.txt')).isSymbolicLink(),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('copyPathWithSafeSymlinks refuses a symlinked destination parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-copy-parent-'));
  const source = join(root, 'source.txt');
  const outside = join(root, 'outside');
  const destinationParent = join(root, 'preserve');
  try {
    writeFileSync(source, 'source\n');
    mkdirSync(outside);
    symlinkSync(outside, destinationParent);
    assert.throws(
      () => copyPathWithSafeSymlinks(source, join(destinationParent, 'copy')),
      /destination parent is not a real directory/,
    );
    assert.equal(existsSync(join(outside, 'copy')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('copyPathWithSafeSymlinks replaces a destination leaf symlink safely', {
  // See the platform note on the materialization test above.
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-copy-leaf-'));
  const source = join(root, 'source.txt');
  const outside = join(root, 'outside.txt');
  const destination = join(root, 'preserve', 'copy.txt');
  try {
    writeFileSync(source, 'source\n');
    writeFileSync(outside, 'outside\n');
    mkdirSync(join(root, 'preserve'));
    symlinkSync(outside, destination);

    copyPathWithSafeSymlinks(source, destination);

    assert.equal(lstatSync(destination).isSymbolicLink(), false);
    assert.equal(readFileSync(destination, 'utf8'), 'source\n');
    assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('copyPathWithSafeSymlinks refuses special files before copying', {
  // `mkfifo` is a POSIX utility; Windows has no equivalent fixture in this
  // test environment, while the production guard is covered by the POSIX CI.
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-copy-special-'));
  const source = join(root, 'source.pipe');
  const destination = join(root, 'preserve', 'copy');
  try {
    execFileSync('mkfifo', [source]);
    assert.throws(
      () => copyPathWithSafeSymlinks(source, destination),
      /unsupported special file in recovery source/,
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('copyPathWithSafeSymlinks refuses a directory outside declared source roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-copy-root-'));
  const source = join(root, 'source');
  const declaredRoot = join(root, 'declared');
  const destination = join(root, 'preserve', 'destination');
  try {
    mkdirSync(source);
    mkdirSync(declaredRoot);
    writeFileSync(join(source, 'outside.txt'), 'outside\n');
    assert.throws(
      () => copyPathWithSafeSymlinks(source, destination, declaredRoot),
      /source directory escaped the declared roots during copy/,
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('primary recovery refuses malformed local config before default-branch lookup', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-config-'));
  try {
    mkdirSync(join(root, '.github/idd'), { recursive: true });
    writeFileSync(join(root, '.github/idd/config.json'), '{broken');
    assert.throws(
      () =>
        resolveDevelopmentBranchProduction(
          { owner: 'owner', repo: 'repo' },
          root,
        ),
      /could not read .*config\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('primary recovery rejects an owner/repo override for another local repository', () => {
  assert.throws(
    () =>
      assertRepositoryOverrideMatchesLocal(
        { owner: 'other-owner', repo: 'other-repo' },
        { owner: 'local-owner', repo: 'local-repo' },
      ),
    /do not match the local repository/,
  );
  assert.doesNotThrow(() =>
    assertRepositoryOverrideMatchesLocal(
      { owner: 'LOCAL-OWNER', repo: 'LOCAL-REPO' },
      { owner: 'local-owner', repo: 'local-repo' },
    ),
  );
});

test('parseArgs rejects issue numbers that are not safe positive integers', () => {
  assert.equal(
    parseArgs(['--issue', '3536', '--worktree', '/repo/linked']).issue,
    3536,
  );
  assert.equal(
    parseArgs([
      '--issue',
      String(Number.MAX_SAFE_INTEGER),
      '--worktree',
      '/repo/linked',
    ]).issue,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    parseArgs(['--issue', '9007199254740992', '--worktree', '/repo/linked'])
      .issue,
    null,
  );
  assert.equal(
    parseArgs([
      '--issue',
      '999999999999999999999',
      '--worktree',
      '/repo/linked',
    ]).issue,
    null,
  );
});

test('isAcceptedBlockReason accepts only the two §LWR step 1 prefixes', () => {
  assert.equal(
    isAcceptedBlockReason('stale-claim-local-worktree-occupied'),
    true,
  );
  assert.equal(
    isAcceptedBlockReason('released-claim-local-worktree-unreadable'),
    true,
  );
  assert.equal(isAcceptedBlockReason('active-claim-non-stale'), false);
  assert.equal(isAcceptedBlockReason('legacy-absent'), false);
});

test('extractRecoveredClaim prefers active_claim, falls back to evidence.released_claim', () => {
  assert.deepEqual(
    extractRecoveredClaim({
      state: 'local_worktree_occupied',
      reason: 'stale-claim-local-worktree-occupied',
      active_claim: { claim_id: 'claim-a', branch: 'issue/1-task' },
    }),
    { claimId: 'claim-a', branch: 'issue/1-task' },
  );
  assert.deepEqual(
    extractRecoveredClaim({
      state: 'local_worktree_occupied',
      reason: 'released-claim-local-worktree-occupied',
      active_claim: null,
      evidence: {
        released_claim: { claim_id: null, branch: 'issue/2-task' },
      },
    }),
    { claimId: null, branch: 'issue/2-task' },
  );
  assert.deepEqual(
    extractRecoveredClaim({
      state: 'local_worktree_occupied',
      reason: 'stale-claim-local-worktree-occupied',
      active_claim: null,
    }),
    { claimId: null, branch: null },
  );
});

test('hasWorkingTreeChanges ignores only `!!`-prefixed (ignored) lines', () => {
  assert.equal(hasWorkingTreeChanges(''), false);
  assert.equal(hasWorkingTreeChanges('!! node_modules/\n'), false);
  assert.equal(hasWorkingTreeChanges(' M tracked.txt\n'), true);
  assert.equal(hasWorkingTreeChanges('?? untracked.txt\n'), true);
});

test('extractIgnoredPaths reads only `!! `-prefixed lines', () => {
  assert.deepEqual(
    extractIgnoredPaths(
      ' M tracked.txt\n!! .env\n?? untracked.txt\n!! dist/\n',
    ),
    ['.env', 'dist/'],
  );
  assert.deepEqual(extractIgnoredPaths(''), []);
});

test('extractIgnoredPaths decodes quoted and NUL-delimited porcelain paths', () => {
  assert.deepEqual(
    extractIgnoredPaths('!! "caf\\303\\251.tmp"\n!! plain.tmp\n'),
    ['café.tmp', 'plain.tmp'],
  );
  assert.deepEqual(
    extractIgnoredPaths('!! unicode-\u00e9.tmp\0!! "tab\\tname.tmp"\0'),
    ['unicode-é.tmp', '"tab\\tname.tmp"'],
  );
  assert.deepEqual(extractIgnoredPaths('!! "tab\\tname.tmp"\n'), [
    'tab\tname.tmp',
  ]);
});

test('countTaggedStashEntries counts only entries whose final message is the tag', () => {
  const stashList = [
    'stash@{0}: On issue/1-task: idd-lwr claim-x',
    'stash@{1}: On main: unrelated',
    'stash@{2}: On issue/1-task: idd-lwr claim-x',
  ].join('\n');
  assert.equal(countTaggedStashEntries(stashList, 'idd-lwr claim-x'), 2);
  assert.equal(countTaggedStashEntries('', 'idd-lwr claim-x'), 0);
  assert.equal(
    countTaggedStashEntries(
      'stash@{0}: On issue/1-task: idd-lwr claim-x2\n',
      'idd-lwr claim-x',
    ),
    0,
    'a claim-id prefix must not count as this recovery attempt',
  );
});

test('evaluatePrunableShortcut requires prunable + absent + unlocked + matching branch', () => {
  const pathExists = (p: string) => p === '/present';
  const base = {
    path: '/gone',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  assert.equal(
    evaluatePrunableShortcut([base], '/gone', 'issue/1-task', pathExists)
      .eligible,
    true,
  );
  assert.equal(
    evaluatePrunableShortcut(
      [{ ...base, locked: true }],
      '/gone',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
    'a locked prunable-absent record must never be shortcut',
  );
  assert.equal(
    evaluatePrunableShortcut(
      [{ ...base, path: '/present' }],
      '/present',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
    'present-on-disk must never be shortcut',
  );
  assert.equal(
    evaluatePrunableShortcut(
      [{ ...base, branchRef: 'refs/heads/other-branch' }],
      '/gone',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
    'an unrelated matching branch must never be shortcut',
  );
  assert.equal(
    evaluatePrunableShortcut(
      [base],
      '/nonexistent-record',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
  );
});

test('evaluatePrunableShortcut fails closed on a detached record, even prunable+absent+unlocked (C1 finding)', () => {
  // inspectLocalWorktreeBranch (local-worktree-occupancy.mts) can never
  // resolve a detached record's branch once its path is already absent --
  // its own resolveDetachedBranch sequencer lookup needs to read files at
  // that path. It always treats this shape as blocking/unreadable, so the
  // shortcut must never authorize a force-remove here either, regardless of
  // whether the branch happens to be unresolvable rather than genuinely
  // unrelated.
  const pathExists = () => false;
  const detachedRecord = {
    path: '/gone',
    branchRef: null,
    detached: true,
    bare: false,
    locked: false,
    prunable: true,
  };
  assert.equal(
    evaluatePrunableShortcut(
      [detachedRecord],
      '/gone',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
  );
});

test('evaluatePrunableShortcut fails closed when the requested branch is unknown', () => {
  const record = {
    path: '/gone',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  assert.equal(
    evaluatePrunableShortcut([record], '/gone', null, () => false).eligible,
    false,
  );
});

test('evaluatePrunableShortcut fails closed when the target path is unreadable', () => {
  const record = {
    path: '/restricted/gone',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const presence: PathPresence = 'unknown';
  const verdict = evaluatePrunableShortcut(
    [record],
    record.path,
    'issue/1-task',
    () => false,
    () => presence,
  );
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /unknown/);
});

test('normalizes Git forward-slash worktree paths only for Windows comparisons', () => {
  assert.equal(
    normalizeGitWorktreePathForComparison('C:/repo/linked', '\\'),
    'C:/repo/linked',
  );
  assert.equal(
    normalizeGitWorktreePathForComparison('C:\\repo\\linked', '\\'),
    'C:/repo/linked',
  );
  assert.equal(
    normalizeGitWorktreePathForComparison('/repo/with\\backslash', '/'),
    '/repo/with\\backslash',
  );
});

test('detectInProgressOperation reads orig-head for an in-progress rebase, not HEAD', () => {
  const runGit = (argv: string[]): LocalGitCommandResult => {
    if (argv[0] === 'rev-parse' && argv.includes('MERGE_HEAD')) {
      return { ok: false, status: 1, stdout: '', stderr: '' };
    }
    if (argv[0] === 'rev-parse' && argv.includes('--git-path')) {
      if (argv.includes('rebase-merge')) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/.git/rebase-merge\n',
          stderr: '',
        };
      }
      return { ok: true, status: 0, stdout: 'rebase-apply\n', stderr: '' };
    }
    return { ok: true, status: 0, stdout: 'replay-tip-sha\n', stderr: '' };
  };
  const pathExists = (p: string) => p === '/repo/.git/rebase-merge';
  const readFile = (p: string) =>
    p === '/repo/.git/rebase-merge/orig-head' ? 'orig-head-sha\n' : null;
  const result = detectInProgressOperation(
    '/repo',
    runGit,
    pathExists,
    readFile,
  );
  assert.deepEqual(result, { kind: 'rebase', tipSha: 'orig-head-sha' });
});

test('detectInProgressOperation reports null when nothing is in progress', () => {
  const runGit = (): LocalGitCommandResult => ({
    ok: false,
    status: 1,
    stdout: '',
    stderr: '',
  });
  const result = detectInProgressOperation(
    '/repo',
    runGit,
    () => false,
    () => null,
  );
  assert.equal(result, null);
});

test('detectInProgressOperation fails closed when rebase metadata is unreadable', () => {
  const runGit = (argv: string[]): LocalGitCommandResult => {
    if (
      argv[0] === 'rev-parse' &&
      (argv.includes('MERGE_HEAD') || argv.includes('CHERRY_PICK_HEAD'))
    ) {
      return { ok: false, status: 1, stdout: '', stderr: '' };
    }
    if (
      argv[0] === 'rev-parse' &&
      argv.includes('--git-path') &&
      argv.includes('rebase-merge')
    ) {
      return {
        ok: true,
        status: 0,
        stdout: '/repo/.git/rebase-merge\n',
        stderr: '',
      };
    }
    return { ok: true, status: 0, stdout: '', stderr: '' };
  };
  const result = detectInProgressOperation(
    '/repo',
    runGit,
    () => false,
    () => null,
    () => 'unknown',
  );
  assert.deepEqual(result, { kind: 'rebase', tipSha: null });
});

for (const operationCase of [
  { kind: 'merge', marker: 'MERGE_HEAD' },
  { kind: 'cherry-pick', marker: 'CHERRY_PICK_HEAD' },
] as const) {
  test(`detectInProgressOperation fails closed when ${operationCase.kind} metadata is present but unreadable`, () => {
    const runGit = (argv: string[]): LocalGitCommandResult => {
      if (argv[0] === 'rev-parse' && argv.includes(operationCase.marker)) {
        if (argv.includes('--git-path')) {
          return {
            ok: true,
            status: 0,
            stdout: `/repo/.git/${operationCase.marker}\n`,
            stderr: '',
          };
        }
        return { ok: false, status: 1, stdout: '', stderr: '' };
      }
      if (argv[0] === 'rev-parse' && argv.includes('--git-path')) {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return { ok: false, status: 1, stdout: '', stderr: '' };
    };
    const result = detectInProgressOperation(
      '/repo',
      runGit,
      () => false,
      () => null,
      () => 'unknown',
    );
    assert.deepEqual(result, { kind: operationCase.kind, tipSha: null });
  });
}

test('detectInProgressOperation fails closed when bisect metadata is unreadable', () => {
  const runGit = (argv: string[]): LocalGitCommandResult => {
    if (
      argv[0] === 'rev-parse' &&
      (argv.includes('MERGE_HEAD') || argv.includes('CHERRY_PICK_HEAD'))
    ) {
      return { ok: false, status: 1, stdout: '', stderr: '' };
    }
    if (
      argv[0] === 'rev-parse' &&
      argv.includes('--git-path') &&
      argv.includes('BISECT_LOG')
    ) {
      return {
        ok: true,
        status: 0,
        stdout: '/repo/.git/BISECT_LOG\n',
        stderr: '',
      };
    }
    return { ok: true, status: 0, stdout: '', stderr: '' };
  };
  const result = detectInProgressOperation(
    '/repo',
    runGit,
    () => false,
    () => null,
    () => 'unknown',
  );
  assert.deepEqual(result, { kind: 'bisect', tipSha: null });
});

test('submoduleStatusEntries parses a path containing spaces (Copilot review finding)', () => {
  const raw = [
    ' abc123def456abc123def456abc123def456abcd libs/my module (heads/main)',
    '-0000000000000000000000000000000000000000 uninit/sub with space',
    '+1111111111111111111111111111111111111111 dirty/no-space-path (heads/x)',
  ].join('\n');
  assert.deepEqual(submoduleStatusEntries(raw), [
    { status: ' ', path: 'libs/my module' },
    { status: '-', path: 'uninit/sub with space' },
    { status: '+', path: 'dirty/no-space-path' },
  ]);
});

test('extractDirtyPaths reads tracked/untracked paths, follows a rename arrow, and skips ignored lines', () => {
  const status = [
    ' M tracked.txt',
    '?? untracked.txt',
    'R  old.txt -> new.txt',
    ' M conflict -> target',
    '!! ignored.txt',
  ].join('\n');
  assert.deepEqual(extractDirtyPaths(status), [
    'tracked.txt',
    'untracked.txt',
    'new.txt',
    'conflict -> target',
  ]);
});

test('extractDirtyEntries preserves staged and unstaged status columns', () => {
  assert.deepEqual(
    extractDirtyEntries('M  staged-gitlink\n M dirty-submodule\n?? new.txt\n'),
    [
      { path: 'staged-gitlink', indexStatus: 'M', worktreeStatus: ' ' },
      { path: 'dirty-submodule', indexStatus: ' ', worktreeStatus: 'M' },
      { path: 'new.txt', indexStatus: '?', worktreeStatus: '?' },
    ],
  );
});

test('isSafeRelativePath rejects absolute paths and any `..` segment', () => {
  assert.equal(isSafeRelativePath('a/b.txt'), true);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('../escape.txt'), false);
  assert.equal(isSafeRelativePath('a/../../escape.txt'), false);
  assert.equal(
    isSafeRelativePath('a\\..\\secret'),
    process.platform !== 'win32',
    'backslashes are separators only on Windows',
  );
  assert.equal(isSafeRelativePath(''), false);
});

test('isPathContainedIn is platform-portable, not a hardcoded `/`-prefix check (Copilot review finding)', () => {
  assert.equal(isPathContainedIn('/target', '/target'), true);
  assert.equal(isPathContainedIn('/target/sub', '/target'), true);
  assert.equal(isPathContainedIn('/other', '/target'), false);
  // A sibling directory sharing a string prefix must never read as
  // "contained" -- the exact bug a bare `startsWith` check produces.
  assert.equal(isPathContainedIn('/target-sibling', '/target'), false);
  assert.equal(isPathContainedIn('/target', '/target/sub'), false);
  assert.equal(isPathContainedIn('/target/..backup', '/target'), true);
  assert.equal(isPathContainedIn('/target/../other', '/target'), false);
  assert.equal(
    isPathContainedIn('/target/safe\\..\\backup', '/target'),
    process.platform !== 'win32',
    'backslashes are filename characters on POSIX but separators on Windows',
  );
});

test('resolveEffectiveRealpath walks up to the nearest existing ancestor and re-appends the missing suffix', () => {
  const fakeFs: Record<string, string> = { '/real/base': '/real/base' };
  const realpathOrNull = (p: string) => fakeFs[p] ?? null;
  // '/link' is a symlink resolving to '/real/base'; '/link/new/dir' does
  // not exist yet, so a plain realpath call on it returns null and would
  // previously skip the containment check entirely.
  fakeFs['/link'] = '/real/base';
  assert.equal(
    resolveEffectiveRealpath('/link/new/dir', realpathOrNull),
    '/real/base/new/dir',
  );
  assert.equal(resolveEffectiveRealpath('/link', realpathOrNull), '/real/base');
  assert.equal(
    resolveEffectiveRealpath('/nowhere/at/all', realpathOrNull),
    null,
  );
});

test('submoduleStatusEntries keeps a parenthesized uninitialized submodule path intact (Codex review finding)', () => {
  // An uninitialized (`-`) entry never carries a trailing "(describe)"
  // suffix (there is nothing checked out to describe), so a path that
  // itself ends in a parenthesized component must not be stripped.
  const raw = '-0000000000000000000000000000000000000000 lib (foo)';
  assert.deepEqual(submoduleStatusEntries(raw), [
    { status: '-', path: 'lib (foo)' },
  ]);
  // An initialized entry's real describe suffix is still stripped.
  const initialized =
    ' abc123def456abc123def456abc123def456abcd lib (heads/main)';
  assert.deepEqual(submoduleStatusEntries(initialized), [
    { status: ' ', path: 'lib' },
  ]);
});

test('submoduleStatusEntries strips nested parentheses from an initialized describe suffix (Copilot review finding)', () => {
  const raw =
    ' abc123def456abc123def456abc123def456abcd lib (heads/feature(foo))';
  assert.deepEqual(submoduleStatusEntries(raw), [{ status: ' ', path: 'lib' }]);
});

test('submoduleStatusEntries accepts SHA-256 object ids (Copilot review finding)', () => {
  const sha256 = 'a'.repeat(64);
  assert.deepEqual(
    submoduleStatusEntries(` ${sha256} modules/sha256 (heads/main)`),
    [{ status: ' ', path: 'modules/sha256' }],
  );
});

test('detectInProgressOperation preserves the BISECT_START ref tip, not the mid-bisect HEAD (Codex review finding)', () => {
  const runGit = (argv: string[]): LocalGitCommandResult => {
    if (argv[0] === 'rev-parse' && argv.includes('MERGE_HEAD')) {
      return { ok: false, status: 1, stdout: '', stderr: '' };
    }
    if (argv[0] === 'rev-parse' && argv.includes('CHERRY_PICK_HEAD')) {
      return { ok: false, status: 1, stdout: '', stderr: '' };
    }
    if (argv[0] === 'rev-parse' && argv.includes('--git-path')) {
      if (argv.includes('BISECT_LOG')) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/.git/BISECT_LOG\n',
          stderr: '',
        };
      }
      if (argv.includes('BISECT_START')) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/.git/BISECT_START\n',
          stderr: '',
        };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    }
    if (argv[0] === 'rev-parse' && argv[1] === 'issue/1-task') {
      return {
        ok: true,
        status: 0,
        stdout: 'pre-bisect-tip-sha\n',
        stderr: '',
      };
    }
    return {
      ok: true,
      status: 0,
      stdout: 'mid-bisect-tested-sha\n',
      stderr: '',
    };
  };
  const pathExists = (p: string) => p === '/repo/.git/BISECT_LOG';
  const readFile = (p: string) =>
    p === '/repo/.git/BISECT_START' ? 'issue/1-task\n' : null;
  const result = detectInProgressOperation(
    '/repo',
    runGit,
    pathExists,
    readFile,
  );
  assert.deepEqual(result, { kind: 'bisect', tipSha: 'pre-bisect-tip-sha' });
});

test('detectInProgressOperation reports a bisect with a null tip when BISECT_START cannot be resolved', () => {
  const runGit = (argv: string[]): LocalGitCommandResult => {
    if (
      argv[0] === 'rev-parse' &&
      (argv.includes('MERGE_HEAD') || argv.includes('CHERRY_PICK_HEAD'))
    ) {
      return { ok: false, status: 1, stdout: '', stderr: '' };
    }
    if (argv[0] === 'rev-parse' && argv.includes('--git-path')) {
      if (argv.includes('BISECT_LOG')) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/.git/BISECT_LOG\n',
          stderr: '',
        };
      }
      return { ok: false, status: 1, stdout: '', stderr: '' };
    }
    return { ok: true, status: 0, stdout: '', stderr: '' };
  };
  const pathExists = (p: string) => p === '/repo/.git/BISECT_LOG';
  const result = detectInProgressOperation(
    '/repo',
    runGit,
    pathExists,
    () => null,
  );
  assert.deepEqual(result, { kind: 'bisect', tipSha: null });
});

// ---------------------------------------------------------------------------
// Orchestration unit tests (fully injected deps -- no real git, no gh)
// ---------------------------------------------------------------------------

function baseArgs(
  overrides: Partial<Parameters<typeof runLocalWorktreeRecovery>[0]> = {},
) {
  return {
    issue: 1,
    worktree: '/repo/linked',
    operatorConfirmedNoLiveSession: false,
    apply: false,
    agentId: 'test-agent',
    owner: '',
    repo: '',
    policy: '',
    now: '',
    preserveDir: '',
    help: false,
    ...overrides,
  };
}

/**
 * A clean repo's `git` fallback: reports no in-progress
 * merge/rebase/cherry-pick/bisect, and a generic `ok: true` empty result
 * for anything else. Tests that supply their own `runGit` override should
 * delegate to this for any argv they do not specifically handle, instead
 * of a bare `{ ok: true, ... }` literal, which would otherwise make
 * `detectInProgressOperation` spuriously report a `merge` in progress (a
 * real repo only ever resolves `MERGE_HEAD` etc. when that operation is
 * genuinely active).
 */
function cleanRepoRunGit(
  argv: string[],
  cwd = '/repo/linked',
): LocalGitCommandResult {
  if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
    return {
      ok: true,
      status: 0,
      stdout:
        cwd === '/repo/primary'
          ? '/repo/primary/.git\n'
          : '/repo/primary/.git/worktrees/linked\n',
      stderr: '',
    };
  }
  if (
    (argv[0] === 'rev-parse' &&
      argv.includes('-q') &&
      (argv.includes('MERGE_HEAD') || argv.includes('CHERRY_PICK_HEAD'))) ||
    (argv[0] === 'rev-parse' &&
      argv.includes('--git-path') &&
      argv.includes('BISECT_LOG'))
  ) {
    return { ok: false, status: 1, stdout: '', stderr: '' };
  }
  if (argv[0] === 'symbolic-ref' && argv.includes('--short')) {
    return { ok: true, status: 0, stdout: 'main\n', stderr: '' };
  }
  return { ok: true, status: 0, stdout: '', stderr: '' };
}

function fakeDeps(
  overrides: Partial<LocalWorktreeRecoveryDeps> = {},
): LocalWorktreeRecoveryDeps {
  const okRouting = {
    state: 'local_worktree_occupied',
    reason: 'stale-claim-local-worktree-occupied',
    active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
    evidence: {
      local_worktree: {
        status: 'occupied',
        paths: ['/repo/linked'],
        reason: null,
      },
    },
  };
  const deps: LocalWorktreeRecoveryDeps = {
    cwd: () => '/repo/primary',
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    confirmBlock: () => ({ ok: true, routing: okRouting, error: null }),
    checkLock: () => ({
      path: '/repo/linked/.git/idd-claim.lock',
      present: true,
      holder: {
        agentId: 'agent-x',
        claimId: 'claim-x',
        acquiredAt: '2026-09-24T00:00:00Z',
      },
    }),
    removeLockIfMatches: () => true,
    runGit: cleanRepoRunGit,
    pathExists: () => true,
    readDirectoryIdentity: (path) => ({
      dev: `dev:${path}`,
      ino: `ino:${path}`,
    }),
    realpathOrNull: (p: string) => p,
    readlinkOrNull: () => null,
    acquireCloneLock: () => ({ path: '/repo/.idd-clone.lock', token: 'tok' }),
    releaseCloneLock: () => {},
    resolveDevelopmentBranch: () => 'main',
    copyPath: () => {},
    removePath: () => {},
    ensurePreserveDir: () => '/tmp/preserve',
    now: () => '2026-09-25T00:00:00Z',
  };
  deps.removeWorktreeIfLockMatches = (
    worktreePath,
    repoPath,
    _expected,
    force,
  ) =>
    deps.runGit(
      ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath],
      repoPath,
    );
  return Object.assign(deps, overrides);
}

test('never mutates without --operator-confirmed-no-live-session, regardless of --apply', () => {
  const deps = fakeDeps();
  let gitCalls = 0;
  deps.runGit = (argv) => {
    if (argv[0] === 'worktree' && argv[1] === 'remove') gitCalls += 1;
    if (argv[0] === 'stash' && argv[1] === 'push') gitCalls += 1;
    if (argv[0] === 'update-ref') gitCalls += 1;
    return cleanRepoRunGit(argv);
  };
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: false }),
    deps,
  );
  assert.equal(verdict.mutated, false);
  assert.equal(gitCalls, 0);
  assert.match(verdict.result, /operator-confirmed-no-live-session/);
});

test('default (no --apply) never mutates, and reports the full plan', () => {
  const deps = fakeDeps();
  let mutatingCalls = 0;
  deps.runGit = (argv) => {
    if (
      (argv[0] === 'worktree' && argv[1] === 'remove') ||
      (argv[0] === 'stash' && argv[1] === 'push') ||
      argv[0] === 'update-ref'
    ) {
      mutatingCalls += 1;
    }
    if (argv[0] === 'status') {
      return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
    }
    return cleanRepoRunGit(argv);
  };
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: false, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.mutated, false);
  assert.equal(mutatingCalls, 0);
  assert.equal(verdict.plan.stashes[0]?.hasChanges, true);
  assert.equal(verdict.plan.stashes[0]?.stashed, false);
  assert.ok(verdict.plan.removal?.wouldRun);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(
    verdict.plan.removal?.detail ?? '',
    /freshly verified unmerged fallback/,
  );
});

test('step 4 acquires the clone-scoped lock, re-checks, then removes, releasing even on failure', () => {
  const callOrder: string[] = [];
  const deps = fakeDeps({
    acquireCloneLock: () => {
      callOrder.push('acquire');
      return { path: '/repo/.idd-clone.lock', token: 'tok' };
    },
    releaseCloneLock: () => {
      callOrder.push('release');
    },
    confirmBlock: (() => {
      let call = 0;
      return () => {
        call += 1;
        callOrder.push(call === 1 ? 'confirm-step1' : 'confirm-recheck');
        return {
          ok: true,
          routing: {
            state: 'local_worktree_occupied',
            reason: 'stale-claim-local-worktree-occupied',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: 'occupied',
                paths: ['/repo/linked'],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        callOrder.push('remove');
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.mutated, true);
  assert.deepEqual(callOrder, [
    'confirm-step1',
    'acquire',
    'confirm-recheck',
    'confirm-recheck',
    'confirm-recheck',
    'confirm-recheck',
    'remove',
    'release',
  ]);
});

test('linked cleanup stops when an ignored path is reclassified by stash', () => {
  let ignoredStatusCalls = 0;
  let stashListCalls = 0;
  let cleanCalled = false;
  let sourcePresent = true;
  const events: string[] = [];
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
        ignoredStatusCalls += 1;
        return {
          ok: true,
          status: 0,
          // The modified ignore file initially hides this path. After the
          // stash restores the committed ignore rules, it is untracked and
          // therefore absent from the late ignored-only scan.
          stdout: ignoredStatusCalls === 1 ? '!! hidden.env\0' : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: ' M .gitignore\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        stashListCalls += 1;
        return {
          ok: true,
          status: 0,
          stdout:
            stashListCalls === 1
              ? ''
              : 'stash@{0}: On issue/1-task: idd-lwr claim-x\n',
          stderr: '',
        };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        events.push('stash');
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'clean') {
        cleanCalled = true;
        sourcePresent = false;
        events.push('clean');
        assert.deepEqual(argv, ['clean', '-fdx', '--', ':(literal)hidden.env']);
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        events.push('remove');
        return cleanCalled
          ? { ok: true, status: 0, stdout: '', stderr: '' }
          : {
              ok: false,
              status: 1,
              stdout: '',
              stderr: 'contains modified or untracked files',
            };
      }
      return cleanRepoRunGit(argv);
    },
    copyPath: () => events.push('copy'),
    pathExists: (path) =>
      path === '/repo/linked/hidden.env' ? sourcePresent : true,
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(events, ['copy', 'stash']);
  assert.equal(cleanCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /changed status before cleanup/);
});

test('step 4 stops when the target worktree is replaced while waiting for the clone lock', () => {
  let phase: 'before' | 'after' = 'before';
  let removeCalls = 0;
  const deps = fakeDeps({
    acquireCloneLock: () => {
      phase = 'after';
      return { path: '/repo/.idd-clone.lock', token: 'tok' };
    },
    readDirectoryIdentity: (path) => ({
      dev: 'dev',
      ino: `${phase}:${path}`,
    }),
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalls += 1;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(removeCalls, 0);
  assert.match(
    verdict.result,
    /identity changed while waiting for the clone lock/,
  );
  assert.equal(verdict.plan.removal?.ran, false);
});

test('step 4 still releases the clone lock when removal fails', () => {
  const callOrder: string[] = [];
  const deps = fakeDeps({
    acquireCloneLock: () => {
      callOrder.push('acquire');
      return { path: '/repo/.idd-clone.lock', token: 'tok' };
    },
    releaseCloneLock: () => {
      callOrder.push('release');
    },
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        callOrder.push('remove-failed');
        return { ok: false, status: 1, stdout: '', stderr: 'boom' };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.mutated, false);
  assert.deepEqual(callOrder, ['acquire', 'remove-failed', 'release']);
});

test('step 4 reports failure when worktree pruning fails after removal', () => {
  const callOrder: string[] = [];
  const deps = fakeDeps({
    acquireCloneLock: () => {
      callOrder.push('acquire');
      return { path: '/repo/.idd-clone.lock', token: 'tok' };
    },
    releaseCloneLock: () => {
      callOrder.push('release');
    },
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        callOrder.push('remove');
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'prune') {
        callOrder.push('prune-failed');
        return { ok: false, status: 1, stdout: '', stderr: 'stale admin data' };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.mutated, true);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /git worktree prune failed: stale admin data/);
  assert.deepEqual(callOrder, ['acquire', 'remove', 'prune-failed', 'release']);
});

test('step 4 returns a preservation verdict when clone-lock acquisition throws', () => {
  let stashListCalls = 0;
  const deps = fakeDeps({
    ensurePreserveDir: () => '/tmp/preserve',
    runGit: (argv) => {
      if (argv[0] === 'status' && argv.includes('--porcelain=v1')) {
        return { ok: true, status: 0, stdout: '!! .env\0', stderr: '' };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        stashListCalls += 1;
        return {
          ok: true,
          status: 0,
          stdout:
            stashListCalls === 1
              ? ''
              : 'stash@{0}: On issue/1-task: idd-lwr claim-x',
          stderr: '',
        };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv);
    },
    acquireCloneLock: () => {
      throw new Error('clone lock timeout');
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.preserveDir, null);
  assert.equal(verdict.plan.stashes.length, 0);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /clone-scoped lock: clone lock timeout/);
});

test('regression: a successful step-3 stash before a failed step-4 removal must not report success (CodeRabbit finding)', () => {
  // Reproduces the exact shape that made `verdict.mutated` alone unsafe for
  // the CLI's exit-code decision: step 3 stashes real changes (so `mutated`
  // becomes true) BEFORE step 4's `git worktree remove` fails. The caller
  // (`runCli`) must key off `verdict.plan.removal.ran`, not `mutated` --
  // this test pins the verdict shape that fix depends on.
  let stashListCalls = 0;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        stashListCalls += 1;
        // First call is the pre-push baseline (empty); every call after the
        // stash push itself reports the tagged entry landed.
        return {
          ok: true,
          status: 0,
          stdout:
            stashListCalls === 1
              ? ''
              : 'stash@{0}: On issue/1-task: idd-lwr claim-x',
          stderr: '',
        };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        return { ok: false, status: 1, stdout: '', stderr: 'boom' };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.stashed, true);
  assert.equal(verdict.mutated, true, 'step 3 did mutate (stashed changes)');
  assert.equal(
    verdict.plan.removal?.ran,
    false,
    'step 4 never actually removed the worktree',
  );
  // The exact formula runCli() uses under --apply: success iff removal ran.
  const success = verdict.plan.removal?.ran ?? false;
  assert.equal(success, false);
});

test('step 4 stops removal when the worktree-local lock no longer matches the recovered claim-id at recheck time', () => {
  // Step 1's own checkLock call must still see a MATCHING lock (so step 1
  // itself passes) -- only the step-4 recheck (the second call) sees a
  // different claim-id, simulating a takeover that happened in the window
  // between step 1 and step 4 acquiring the clone-scoped lock.
  let checkLockCalls = 0;
  const deps = fakeDeps({
    checkLock: () => {
      checkLockCalls += 1;
      if (checkLockCalls === 1) {
        return {
          path: '/repo/linked/.git/idd-claim.lock',
          present: true,
          holder: {
            agentId: 'agent-x',
            claimId: 'claim-x',
            acquiredAt: '2026-09-24T00:00:00Z',
          },
        };
      }
      return {
        path: '/repo/linked/.git/idd-claim.lock',
        present: true,
        holder: {
          agentId: 'someone-else',
          claimId: 'a-different-claim-id',
          acquiredAt: '2026-09-25T00:00:00Z',
        },
      };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /no longer matches the recovered claim-id/);
});

test('step 1 refuses an active or stale claim whose local lock is absent', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    checkLock: () => ({
      path: '/repo/linked/.git/idd-claim.lock',
      present: false,
    }),
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') removeCalled = true;
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'lock-mismatch');
  assert.equal(removeCalled, false);
});

test('step 1 refuses a lockless active legacy claim', () => {
  const deps = fakeDeps({
    checkLock: () => ({
      path: '/repo/linked/.git/idd-claim.lock',
      present: false,
    }),
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'local_worktree_occupied',
        reason: 'stale-claim-local-worktree-occupied',
        active_claim: { claim_id: null, branch: 'issue/1-task' },
        evidence: {
          local_worktree: {
            status: 'occupied',
            paths: ['/repo/linked'],
            reason: null,
          },
        },
      },
      error: null,
    }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'lock-mismatch');
  assert.match(verdict.result, /active legacy claim/);
});

test('step 4 proceeds when the worktree-local lock is absent at recheck time (legacy release)', () => {
  const deps = fakeDeps({
    checkLock: () => ({ path: '/x', present: false }),
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'local_worktree_occupied',
        reason: 'released-claim-local-worktree-occupied',
        active_claim: null,
        evidence: {
          released_claim: { claim_id: null, branch: 'issue/1-task' },
          local_worktree: {
            status: 'occupied',
            paths: ['/repo/linked'],
            reason: null,
          },
        },
      },
      error: null,
    }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.removal?.ran, true);
});

test('step 1 always calls confirmBlock, even for a prunable-and-absent record (never skips the network check)', () => {
  let confirmCalls = 0;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
      },
    ],
    pathExists: (p) => p !== '/repo/linked',
    confirmBlock: () => {
      confirmCalls += 1;
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied',
          reason: 'stale-claim-local-worktree-occupied',
          active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
          evidence: {
            local_worktree: {
              status: 'unreadable',
              paths: ['/repo/linked'],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
  });
  const verdict = runLocalWorktreeRecovery(baseArgs({ apply: false }), deps);
  assert.equal(confirmCalls, 1);
  assert.equal(verdict.step1.outcome, 'blocked-prunable');
  assert.equal(verdict.plan.prunableShortcut, true);
});

test('prunable shortcut accepts the explicit absent probe from routing', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
      },
    ],
    pathExists: (path) => path !== '/repo/linked',
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'stale',
        reason: 'active-claim-stale',
        active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
        evidence: {
          local_worktree: { status: 'absent', paths: [], reason: null },
        },
      },
      error: null,
    }),
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'blocked-prunable');
  assert.equal(verdict.plan.removal?.ran, true);
  assert.equal(removeCalled, true);
});

test('prunable shortcut accepts the legacy-released routing shape', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
      },
    ],
    pathExists: (path) => path !== '/repo/linked',
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'unclaimed',
        reason: 'legacy-released',
        active_claim: null,
        evidence: {
          released_claim: { claim_id: null, branch: 'issue/1-task' },
          local_worktree: { status: 'absent', paths: [], reason: null },
        },
      },
      error: null,
    }),
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'blocked-prunable');
  assert.equal(verdict.plan.removal?.ran, true);
  assert.equal(removeCalled, true);
});

test('prunable shortcut refuses a fresh non-stale absent routing result', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
      },
    ],
    pathExists: (path) => path !== '/repo/linked',
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'non_inheritable',
        reason: 'active-claim-non-stale',
        active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
        evidence: {
          local_worktree: { status: 'absent', paths: [], reason: null },
        },
      },
      error: null,
    }),
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'not-blocked');
  assert.equal(removeCalled, false);
  assert.match(verdict.result, /state=non_inheritable/);
});

test('step 4 re-verifies the prunable shortcut fresh under the clone lock, not just step 1s stale read (CodeRabbit finding)', () => {
  // The window between step 1's read and the clone-scoped lock acquisition
  // is exactly what the lock exists to close -- the shortcut path must be
  // re-checked fresh too, not exempted from the re-check the ordinary path
  // gets.
  let listCalls = 0;
  const prunableRecord = {
    path: '/repo/linked',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const primaryRecord = {
    path: '/repo/primary',
    branchRef: 'refs/heads/main',
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  };
  let removeCalled = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => {
      listCalls += 1;
      // First call (step 1) sees the prunable-and-absent record; the
      // second call (step 4's fresh re-check, while the clone lock is
      // held) finds it now LOCKED -- simulating another session having
      // touched it in the window between step 1 and the lock acquisition.
      return listCalls === 1
        ? [primaryRecord, prunableRecord]
        : [primaryRecord, { ...prunableRecord, locked: true }];
    },
    pathExists: (p) => p !== '/repo/linked',
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'blocked-prunable');
  assert.equal(removeCalled, false, 'must never remove on a stale shortcut');
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /no longer matches at recheck time/);
});

test('prunable shortcut rechecks takeover eligibility before removal', () => {
  let confirmCalls = 0;
  let removeCalled = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
      },
    ],
    pathExists: (path) => path !== '/repo/linked',
    confirmBlock: () => {
      confirmCalls += 1;
      const stale = confirmCalls === 1;
      return {
        ok: true,
        routing: {
          state: stale ? 'stale' : 'non_inheritable',
          reason: stale ? 'active-claim-stale' : 'active-claim-non-stale',
          active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
          evidence: {
            local_worktree: { status: 'absent', paths: [], reason: null },
          },
        },
        error: null,
      };
    },
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(confirmCalls, 2);
  assert.equal(verdict.step1.outcome, 'blocked-prunable');
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /no longer matches at recheck time/);
});

test('prunable shortcut removes the worktree with `--force`', () => {
  const removeArgv: string[][] = [];
  const record = {
    path: '/repo/linked',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      record,
    ],
    pathExists: () => false,
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeArgv.push(argv);
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(removeArgv, [
    ['worktree', 'remove', '--force', '/repo/linked'],
  ]);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('prunable shortcut preserves the vanished worktree private admin directory', () => {
  const copied: string[] = [];
  const deps = fakeDeps({
    pathExists: (path) => path !== '/repo/linked',
    findWorktreeAdminDir: () => ({
      path: '/repo/primary/.git/worktrees/linked',
      error: null,
    }),
    copyPath: (_from, to) => copied.push(to),
  });
  deps.listWorktreeRecords = () => [
    {
      path: '/repo/primary',
      branchRef: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    },
    {
      path: '/repo/linked',
      branchRef: 'refs/heads/issue/1-task',
      detached: false,
      bare: false,
      locked: false,
      prunable: true,
    },
  ];
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(copied, ['/tmp/preserve/prunable-gitdir']);
  assert.equal(verdict.plan.prunableAdminCopy?.copiedTo, copied[0]);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('retains a partial prunable admin copy and blocks removal', () => {
  const deps = fakeDeps({
    pathExists: (path) => path !== '/repo/linked',
    findWorktreeAdminDir: () => ({
      path: '/repo/primary/.git/worktrees/linked',
      error: null,
    }),
    copyPath: () => {
      throw new Error('copy interrupted');
    },
  });
  deps.listWorktreeRecords = () => [
    {
      path: '/repo/primary',
      branchRef: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    },
    {
      path: '/repo/linked',
      branchRef: 'refs/heads/issue/1-task',
      detached: false,
      bare: false,
      locked: false,
      prunable: true,
    },
  ];
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(verdict.plan.prunableAdminCopy, {
    source: '/repo/primary/.git/worktrees/linked',
    copiedTo: '/tmp/preserve/prunable-gitdir',
    copyFailed: true,
    plannedTo: '/tmp/preserve/prunable-gitdir',
  });
  assert.equal(verdict.preserveDir, '/tmp/preserve');
  assert.equal(verdict.mutated, true);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /could not copy the prunable/);
});

test('prunable shortcut rechecks claim identity after copying private admin data', () => {
  let confirmCalls = 0;
  let removeCalled = false;
  const deps = fakeDeps({
    confirmBlock: () => {
      confirmCalls += 1;
      const claimId = confirmCalls >= 4 ? 'claim-y' : 'claim-x';
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied',
          reason: 'stale-claim-local-worktree-occupied',
          active_claim: { claim_id: claimId, branch: 'issue/1-task' },
          evidence: {
            local_worktree: {
              status: 'unreadable',
              paths: ['/repo/linked'],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
    pathExists: (path) => path !== '/repo/linked',
    findWorktreeAdminDir: () => ({
      path: '/repo/primary/.git/worktrees/linked',
      error: null,
    }),
    copyPath: () => {},
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  deps.listWorktreeRecords = () => [
    {
      path: '/repo/primary',
      branchRef: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    },
    {
      path: '/repo/linked',
      branchRef: 'refs/heads/issue/1-task',
      detached: false,
      bare: false,
      locked: false,
      prunable: true,
    },
  ];
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(confirmCalls, 4);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /final prunable-worktree routing/);
});

test('prunable shortcut rechecks legacy release status before removal', () => {
  let confirmCalls = 0;
  let removeCalled = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
      },
    ],
    pathExists: (path) => path !== '/repo/linked',
    confirmBlock: () => {
      confirmCalls += 1;
      const released = confirmCalls < 5;
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied',
          reason: released
            ? 'released-claim-local-worktree-occupied'
            : 'stale-claim-local-worktree-occupied',
          active_claim: released
            ? null
            : { claim_id: null, branch: 'issue/1-task' },
          evidence: {
            released_claim: {
              claim_id: null,
              branch: 'issue/1-task',
            },
            local_worktree: {
              status: 'unreadable',
              paths: ['/repo/linked'],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
    findWorktreeAdminDir: () => ({
      path: '/repo/primary/.git/worktrees/linked',
      error: null,
    }),
    copyPath: () => {},
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(confirmCalls, 5);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /final prunable-worktree routing/);
});

test('prunable shortcut re-verifies the admin backup immediately before removal', () => {
  let confirmCalls = 0;
  let backupExists = false;
  let removeCalled = false;
  const record = {
    path: '/repo/linked',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      record,
    ],
    pathExists: (path) => {
      if (path === '/repo/linked') return false;
      if (path === '/tmp/preserve/prunable-gitdir') return backupExists;
      return true;
    },
    confirmBlock: () => {
      confirmCalls += 1;
      if (confirmCalls >= 4) backupExists = false;
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied',
          reason: 'stale-claim-local-worktree-occupied',
          active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
          evidence: {
            local_worktree: {
              status: 'unreadable',
              paths: ['/repo/linked'],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
    findWorktreeAdminDir: () => ({
      path: '/repo/primary/.git/worktrees/linked',
      error: null,
    }),
    copyPath: () => {
      backupExists = true;
    },
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(confirmCalls, 4);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /admin-data backup disappeared or moved/);
});

test('prunable shortcut rechecks claim identity after final backup verification', () => {
  let confirmCalls = 0;
  let removeCalled = false;
  const record = {
    path: '/repo/linked',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      record,
    ],
    pathExists: (path) => path !== '/repo/linked',
    confirmBlock: () => {
      confirmCalls += 1;
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied',
          reason: 'stale-claim-local-worktree-occupied',
          active_claim: {
            claim_id: confirmCalls >= 5 ? 'claim-y' : 'claim-x',
            branch: 'issue/1-task',
          },
          evidence: {
            local_worktree: {
              status: 'unreadable',
              paths: ['/repo/linked'],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
    findWorktreeAdminDir: () => ({
      path: '/repo/primary/.git/worktrees/linked',
      error: null,
    }),
    copyPath: () => {},
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(confirmCalls, 5);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /final prunable-worktree routing/);
});

test('prunable shortcut stops when the target is recreated after the final record check', () => {
  let targetPathChecks = 0;
  let removeCalled = false;
  const record = {
    path: '/repo/linked',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      record,
    ],
    pathExists: (path) => {
      if (path !== '/repo/linked') return false;
      targetPathChecks += 1;
      // The second final shortcut predicate observes a checkout recreated
      // after the first final record check. It must fail closed instead of
      // accepting ordinary occupied routing and force-removing it.
      return targetPathChecks >= 5;
    },
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'local_worktree_occupied',
        reason: 'stale-claim-local-worktree-occupied',
        active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
        evidence: {
          local_worktree: {
            status: 'unreadable',
            paths: ['/repo/linked'],
            reason: 'recreated checkout is unreadable',
          },
        },
      },
      error: null,
    }),
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /final prunable-worktree routing/);
});

test('prunable shortcut stops when private admin-directory ownership cannot be established', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
      },
    ],
    pathExists: (path) => path !== '/repo/linked',
    findWorktreeAdminDir: () => ({
      path: null,
      error: 'no readable gitdir pointer matched the target',
    }),
    runGit: (argv, cwd) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv, cwd);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );

  assert.equal(removeCalled, false);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /could not locate the prunable worktree/);
});

test('dry-run planning failures clear the ready gate', () => {
  const deps = fakeDeps({
    pathExists: (path) => path !== '/repo/linked' && path !== '/tmp/explicit',
    findWorktreeAdminDir: () => ({
      path: null,
      error: 'no readable gitdir pointer matched the target',
    }),
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
      },
    ],
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: false, preserveDir: '/tmp/explicit' }),
    deps,
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /could not plan the prunable/);
});

test('dry-run preservation probe failures clear the ready gate', () => {
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: false, status: 128, stdout: '', stderr: 'status failed' };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: false, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(
    verdict.result,
    /dry-run preservation probes were incomplete or failed/,
  );
});

test('dry-run rejects an existing explicit preserve directory', () => {
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: false, preserveDir: '/tmp/preserve' }),
    fakeDeps(),
  );
  assert.equal(verdict.step1.outcome, 'preserve-dir-exists');
  assert.equal(verdict.ready, false);
  assert.equal(verdict.mutated, false);
  assert.match(verdict.result, /must name a new directory/);
});

test('apply reserves an explicit preserve directory before any Git mutation', () => {
  const mutatingCalls: string[][] = [];
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      preserveDir: '/tmp/preserve',
      operatorConfirmedNoLiveSession: true,
    }),
    fakeDeps({
      ensurePreserveDir: () => {
        throw new Error('EEXIST: destination already exists');
      },
      runGit: (argv) => {
        if (
          (argv[0] === 'stash' && argv[1] === 'push') ||
          argv[0] === 'update-ref'
        ) {
          mutatingCalls.push(argv);
        }
        return cleanRepoRunGit(argv);
      },
    }),
  );
  assert.deepEqual(mutatingCalls, []);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.mutated, false);
  assert.match(verdict.result, /reserve --preserve-dir before preservation/);
});

test('dry-run plans a prunable worktree private admin-directory backup without creating it', () => {
  let ensureCalls = 0;
  const deps = fakeDeps({
    pathExists: (path) => path !== '/repo/linked' && path !== '/tmp/explicit',
    findWorktreeAdminDir: () => ({
      path: '/repo/primary/.git/worktrees/linked',
      error: null,
    }),
    ensurePreserveDir: () => {
      ensureCalls += 1;
      return '/tmp/explicit';
    },
  });
  deps.listWorktreeRecords = () => [
    {
      path: '/repo/primary',
      branchRef: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    },
    {
      path: '/repo/linked',
      branchRef: 'refs/heads/issue/1-task',
      detached: false,
      bare: false,
      locked: false,
      prunable: true,
    },
  ];
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: false, preserveDir: '/tmp/explicit' }),
    deps,
  );
  assert.equal(ensureCalls, 0);
  assert.equal(verdict.preserveDir, '/tmp/explicit');
  assert.deepEqual(verdict.plan.prunableAdminCopy, {
    source: '/repo/primary/.git/worktrees/linked',
    copiedTo: null,
    copyFailed: false,
    plannedTo: '/tmp/explicit/prunable-gitdir',
  });
  assert.equal(verdict.plan.removal?.ran, false);
});

test('prunable shortcut stops when the record becomes locked immediately before force removal', () => {
  let listCalls = 0;
  let removeCalled = false;
  const record = {
    path: '/repo/linked',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const deps = fakeDeps({
    listWorktreeRecords: () => {
      listCalls += 1;
      return [
        {
          path: '/repo/primary',
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
        listCalls >= 3 ? { ...record, locked: true } : record,
      ];
    },
    pathExists: () => false,
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(listCalls, 3);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /before forced removal/);
});

test('forced retry uses the identity-bound removal guard', () => {
  let forcedRunCalled = false;
  let guardCalls = 0;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (
        argv[0] === 'worktree' &&
        argv[1] === 'remove' &&
        argv[2] === '--force'
      ) {
        forcedRunCalled = true;
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        return {
          ok: false,
          status: 1,
          stdout: '',
          stderr: 'submodules cannot be moved or removed',
        };
      }
      return cleanRepoRunGit(argv);
    },
    removeWorktreeIfLockMatches: (_path, _repo, _expected, force) => {
      guardCalls += 1;
      return force
        ? null
        : {
            ok: false,
            status: 1,
            stdout: '',
            stderr: 'submodules cannot be moved or removed',
          };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(guardCalls, 2);
  assert.equal(forcedRunCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /identity-bound forced removal/);
});

test('forced retry re-verifies preservation after the final identity checks', () => {
  let firstRemovalAttempt = false;
  let guardCalls = 0;
  let stashListCalls = 0;
  const tag = 'idd-lwr claim-x';
  const stashEntry = `stash@{0}: On issue/1-task: ${tag}`;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status' && argv.includes('--porcelain=v1')) {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: firstRemovalAttempt ? '' : ' M tracked.txt\n',
          stderr: '',
        };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        stashListCalls += 1;
        return {
          ok: true,
          status: 0,
          stdout:
            stashListCalls === 1 || stashListCalls === 9
              ? ''
              : `${stashEntry}\n`,
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
    removeWorktreeIfLockMatches: (_path, _repo, _expected, force) => {
      guardCalls += 1;
      if (!force) {
        firstRemovalAttempt = true;
        return {
          ok: false,
          status: 1,
          stdout: '',
          stderr: 'submodules cannot be moved or removed',
        };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(stashListCalls, 9);
  assert.equal(guardCalls, 1);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /forced-removal preservation artifact/);
});

test('forced retry accepts sequential stashes with the same recovery tag', () => {
  let firstRemovalAttempt = false;
  let stashPushCount = 0;
  let guardCalls = 0;
  const tag = 'idd-lwr claim-x';
  const first = `stash@{0}: On issue/1-task: ${tag}`;
  const both = `${first}\nstash@{1}: On issue/1-task: ${tag}`;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status' && argv.includes('--porcelain=v1')) {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: firstRemovalAttempt ? ' M late.txt\n' : ' M tracked.txt\n',
          stderr: '',
        };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        stashPushCount += 1;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        return {
          ok: true,
          status: 0,
          stdout:
            stashPushCount >= 2
              ? `${both}\n`
              : stashPushCount === 1
                ? `${first}\n`
                : '',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
    removeWorktreeIfLockMatches: (_path, _repo, _expected, force) => {
      guardCalls += 1;
      if (!force) {
        firstRemovalAttempt = true;
        return {
          ok: false,
          status: 1,
          stdout: '',
          stderr: 'submodules cannot be moved or removed',
        };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(stashPushCount, 2);
  assert.equal(guardCalls, 2);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('generic removal failures do not authorize forced retry after an unmerged fallback', () => {
  let guardCalls = 0;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: 'UU conflict.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return {
          ok: false,
          status: 1,
          stdout: 'conflict.txt: needs merge\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
    removeWorktreeIfLockMatches: (_path, _repo, _expected, force) => {
      guardCalls += 1;
      return force
        ? { ok: true, status: 0, stdout: '', stderr: '' }
        : {
            ok: false,
            status: 1,
            stdout: '',
            stderr: 'fatal: cannot remove dirty worktree',
          };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(guardCalls, 1);
  assert.equal(verdict.plan.stashes[0]?.unmergedFallbackAllPreserved, true);
  assert.equal(verdict.plan.removal?.ran, false);
});

test('verified unmerged fallback authorizes a narrow forced retry for dirty removal', () => {
  let guardCalls = 0;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: 'UU conflict.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return {
          ok: false,
          status: 1,
          stdout: 'conflict.txt: needs merge\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
    removeWorktreeIfLockMatches: (_path, _repo, _expected, force) => {
      guardCalls += 1;
      return force
        ? { ok: true, status: 0, stdout: '', stderr: '' }
        : {
            ok: false,
            status: 1,
            stdout: '',
            stderr:
              "fatal: '/repo/linked' contains modified or untracked files, use --force to delete it",
          };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(guardCalls, 2);
  assert.equal(verdict.plan.stashes[0]?.unmergedFallbackAllPreserved, true);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('legacy lockless claims may complete the forced retry through the guard', () => {
  let guardCalls = 0;
  const deps = fakeDeps({
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'local_worktree_occupied',
        reason: 'released-claim-local-worktree-occupied',
        active_claim: null,
        evidence: {
          local_worktree: {
            status: 'occupied',
            paths: ['/repo/linked'],
            reason: null,
          },
          released_claim: { claim_id: null, branch: 'issue/1-task' },
        },
      },
      error: null,
    }),
    checkLock: () => ({
      path: '/repo/linked/.git/idd-claim.lock',
      present: false,
    }),
    removeWorktreeIfLockMatches: (_path, _repo, _expected, force) => {
      guardCalls += 1;
      return force
        ? {
            ok: true,
            status: 0,
            stdout: '',
            stderr: '',
          }
        : {
            ok: false,
            status: 1,
            stdout: '',
            stderr: 'submodules cannot be moved or removed',
          };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(guardCalls, 2);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('verified prunable shortcuts may keep unreadable routing during final checks', () => {
  let removeCalled = false;
  let confirmCalls = 0;
  const record = {
    path: '/repo/linked',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      record,
    ],
    pathExists: (p) => p !== '/repo/linked',
    confirmBlock: () => {
      confirmCalls += 1;
      const finalCheck = confirmCalls >= 2;
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied' as const,
          reason: finalCheck
            ? 'stale-claim-local-worktree-unreadable'
            : 'stale-claim-local-worktree-occupied',
          active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
          evidence: {
            local_worktree: {
              status: finalCheck
                ? ('unreadable' as const)
                : ('occupied' as const),
              paths: ['/repo/linked'],
              reason: finalCheck ? 'prunable path is absent' : null,
            },
          },
        },
        error: null,
      };
    },
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(removeCalled, true);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('dry-run never creates the preserve directory for an uninitialized submodule', () => {
  let ensureCalls = 0;
  const deps = fakeDeps({
    ensurePreserveDir: () => {
      ensureCalls += 1;
      return '/tmp/preserve';
    },
    runGit: (argv) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return { ok: true, status: 0, stdout: '-abc123 sub\n', stderr: '' };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: false, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(ensureCalls, 0, 'dry-run must have zero side effects');
  assert.equal(verdict.plan.uninitializedSubmodules[0]?.copiedTo, null);
});

test('unknown uninitialized-submodule paths block removal before preservation is trusted', () => {
  let removeCalled = false;
  const copied: string[] = [];
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? '-0000000000000000000000000000000000000000 uninitialized\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv, cwd);
    },
    pathPresence: (path) =>
      path === '/repo/linked/uninitialized' ? 'unknown' : 'present',
    copyPath: (_from, to) => copied.push(to),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.uninitializedSubmodules[0]?.copiedTo, null);
  assert.equal(
    copied.some((path) => path.includes('uninitialized-')),
    false,
  );
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal, null);
  assert.match(verdict.result, /stopping before removal/);
});

test('retains a partial uninitialized-submodule copy and blocks removal', () => {
  const copied: string[] = [];
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: cwd === '/repo/linked' ? '-abc123 submodule\n' : '',
          stderr: '',
        };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv, cwd);
    },
    pathPresence: () => 'present',
    copyPath: (_from, to) => {
      copied.push(to);
      throw new Error('unsupported special file in recovery source');
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  const entry = verdict.plan.uninitializedSubmodules[0];
  assert.equal(entry?.copiedTo, copied[0]);
  assert.equal(entry?.copyFailed, true);
  assert.equal(verdict.mutated, true);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal, null);
  assert.match(verdict.result, /could not be fully verified/);
});

test('excludes uninitialized submodule contents from the parent stash', () => {
  const stashCalls: string[][] = [];
  let stashPushed = false;
  const sha = '0'.repeat(40);
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: cwd === '/repo/linked' ? `-${sha} uninitialized*\n` : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked' ? ' M tracked.txt\n?? uninitialized*\n' : '',
          stderr: '',
        };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        return {
          ok: true,
          status: 0,
          stdout: stashPushed
            ? 'stash@{0}: On issue/1-task: idd-lwr claim-x\n'
            : '',
          stderr: '',
        };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        stashPushed = true;
        stashCalls.push(argv);
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv, cwd);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(stashCalls, [
    [
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'idd-lwr claim-x',
      '--',
      '.',
      ':(exclude,literal)uninitialized*',
    ],
  ]);
  assert.equal(
    verdict.plan.uninitializedSubmodules[0]?.copiedTo !== null,
    true,
  );
  assert.equal(verdict.plan.removal?.ran, true);
});

test('refuses the cwd-inside-target invariant before step 1 ever runs', () => {
  let confirmCalls = 0;
  const deps = fakeDeps({
    cwd: () => '/repo/linked/nested',
    confirmBlock: () => {
      confirmCalls += 1;
      return { ok: true, routing: null, error: null };
    },
  });
  const verdict = runLocalWorktreeRecovery(baseArgs({ apply: false }), deps);
  assert.equal(verdict.step1.outcome, 'cwd-inside-target');
  assert.equal(confirmCalls, 0);
});

test('refuses invocation from a linked worktree even when targeting the primary', () => {
  let confirmCalls = 0;
  const deps = fakeDeps({
    cwd: () => '/repo/linked',
    confirmBlock: () => {
      confirmCalls += 1;
      return { ok: true, routing: null, error: null };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ worktree: '/repo/primary' }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'cwd-outside-primary');
  assert.equal(confirmCalls, 0);
});

test('refuses a present linked worktree when its private gitdir cannot be resolved', () => {
  let confirmCalls = 0;
  const deps = fakeDeps({
    confirmBlock: () => {
      confirmCalls += 1;
      return { ok: true, routing: null, error: null };
    },
    runGit: (argv) => {
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        return { ok: false, status: 1, stdout: '', stderr: 'probe failed' };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(baseArgs(), deps);
  assert.equal(verdict.step1.outcome, 'target-gitdir-unresolved');
  assert.equal(confirmCalls, 0);
});

test('refuses --preserve-dir inside the target worktree before any mutation (Copilot review finding)', () => {
  const deps = fakeDeps({
    realpathOrNull: (p) => p,
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      preserveDir: '/repo/linked/backup',
    }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'preserve-dir-inside-target');
  assert.equal(verdict.mutated, false);
});

test('refuses a dangling preserve-dir symlink into the target worktree', () => {
  const deps = fakeDeps({
    realpathOrNull: (p) => (p === '/repo/linked' ? p : null),
    readlinkOrNull: (p) =>
      p === '/tmp/preserve-link' ? '/repo/linked/not-created' : null,
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      preserveDir: '/tmp/preserve-link',
    }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'preserve-dir-inside-target');
  assert.equal(verdict.mutated, false);
});

test('refuses a preserve directory inside the linked worktree private gitdir', () => {
  const deps = fakeDeps({
    realpathOrNull: (p) => p,
    runGit: (argv) => {
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/primary/.git/worktrees/linked\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      preserveDir: '/repo/primary/.git/worktrees/linked/preserve',
    }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'preserve-dir-inside-target-gitdir');
  assert.equal(verdict.mutated, false);
});

test('refuses an ignored-file destination whose child symlink points into the target', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    realpathOrNull: (p) => (p === '/repo/linked' ? p : null),
    readlinkOrNull: (p) =>
      p === '/tmp/preserve/ignored' ? '/repo/linked/.redirect' : null,
    runGit: (argv) => {
      if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
        return {
          ok: true,
          status: 0,
          stdout: '!! secret.env\0',
          stderr: '',
        };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      preserveDir: '/tmp/preserve',
    }),
    deps,
  );
  assert.equal(verdict.plan.ignoredFilesScanFailed, true);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
});

test('refuses an ignored-file destination whose child symlink points into the linked private gitdir', () => {
  let removeCalled = false;
  const privateGitDir = '/repo/primary/.git/worktrees/linked';
  const deps = fakeDeps({
    realpathOrNull: (p) =>
      p === '/repo/linked' || p === privateGitDir ? p : null,
    readlinkOrNull: (p) =>
      p === '/tmp/preserve/ignored' ? `${privateGitDir}/redirect` : null,
    runGit: (argv, cwd) => {
      if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
        return {
          ok: true,
          status: 0,
          stdout: '!! secret.env\0',
          stderr: '',
        };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv, cwd);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      preserveDir: '/tmp/preserve',
    }),
    deps,
  );
  assert.equal(verdict.plan.ignoredFilesScanFailed, true);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
});

test('uses collision-safe destinations for uninitialized submodule paths', () => {
  const copiedTo: string[] = [];
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        const sha = '0'.repeat(40);
        return {
          ok: true,
          status: 0,
          stdout: `-${sha} a/b\n-${sha} a_b\n`,
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
    pathExists: (path) => !path.includes('/.git/worktrees/linked/modules/'),
    copyPath: (_from, to) => copiedTo.push(to),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.removal?.ran, true);
  assert.equal(copiedTo.length, 4);
  assert.equal(new Set(copiedTo).size, 2);
});

test('refuses a fresh routing state of `-local-worktree-unreadable` outside the prunable shortcut (Copilot review finding)', () => {
  const deps = fakeDeps({
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'local_worktree_occupied',
        reason: 'stale-claim-local-worktree-unreadable',
        active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
        evidence: {
          local_worktree: {
            status: 'unreadable',
            paths: ['/repo/linked'],
            reason: 'some read failure',
          },
        },
      },
      error: null,
    }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'blocked-unreadable');
  assert.equal(verdict.mutated, false);
});

test('independently verified prunable worktrees may be unreadable at recheck', () => {
  let confirmCalls = 0;
  let removeCalled = false;
  const record = {
    path: '/repo/linked',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      record,
    ],
    pathExists: (path) => path !== '/repo/linked',
    confirmBlock: () => {
      confirmCalls += 1;
      const unreadable = confirmCalls >= 2;
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied' as const,
          reason: unreadable
            ? 'stale-claim-local-worktree-unreadable'
            : 'stale-claim-local-worktree-occupied',
          active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
          evidence: {
            local_worktree: {
              status: unreadable
                ? ('unreadable' as const)
                : ('occupied' as const),
              paths: ['/repo/linked'],
              reason: unreadable ? 'prunable path is absent' : null,
            },
          },
        },
        error: null,
      };
    },
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(removeCalled, true);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('a failed status probe blocks removal even with no other changes detected (Codex/Copilot review finding)', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: false, status: 128, stdout: '', stderr: 'boom' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.statusReadFailed, true);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
  assert.match(verdict.result, /could not be fully verified/);
});

test('a submodule-only parent status does not create a pointless parent stash', () => {
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            ' abc123def456abc123def456abc123def456abcd submodule (heads/main)\n',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: cwd === '/repo/linked' ? ' M submodule\n' : '',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.hasChanges, false);
  assert.equal(verdict.plan.stashes[0]?.stashed, false);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('an unstaged submodule HEAD difference stays in the parent scope', () => {
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            '+abc123def456abc123def456abc123def456abcd submodule (heads/main)\n',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: cwd === '/repo/linked' ? ' M submodule\n' : '',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(
    verdict.plan.stashes[0]?.hasChanges,
    true,
    'a `+` submodule status changes the parent gitlink and must be preserved there',
  );
});

test('a `+` submodule preserves its private admin data even when no ref is unpushed', () => {
  const copied: string[] = [];
  const stashCounts = new Map<string, number>();
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'stash' && argv[1] === 'push') {
        stashCounts.set(cwd, (stashCounts.get(cwd) ?? 0) + 1);
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        const count = stashCounts.get(cwd) ?? 0;
        return {
          ok: true,
          status: 0,
          stdout: Array.from(
            { length: count },
            (_, index) => `stash@{${index}}: idd-lwr claim-x`,
          ).join('\n'),
          stderr: '',
        };
      }
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? '+abc123def456abc123def456abc123def456abcd submodule (heads/main)\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? ' M submodule\n'
              : cwd === '/repo/linked/submodule'
                ? ' M changed.txt\n'
                : '',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'rev-parse' &&
        argv.includes('--absolute-git-dir')
      ) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/linked/.git/modules/submodule\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (_from, to) => copied.push(to),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(copied, ['/tmp/preserve/submodule-gitdir/c3VibW9kdWxl']);
  assert.equal(
    verdict.plan.stashes.find((stash) => stash.scope === 'submodule')
      ?.hasChanges,
    true,
    'a changed `+` submodule keeps its own files in the submodule scope',
  );
  assert.equal(verdict.plan.removal?.ran, true);
});

test('late preservation rescans initialized submodule ignored files before removal', () => {
  const copied: Array<{
    to: string;
    sourceRoot: string | undefined;
    additionalSourceRoots: string[] | undefined;
  }> = [];
  let submoduleIgnoredScans = 0;
  const cleanedPaths = new Set<string>();
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? ' abc123def456abc123def456abc123def456abcd submodule (heads/main)\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
        if (cwd === '/repo/linked/submodule') {
          submoduleIgnoredScans += 1;
          return {
            ok: true,
            status: 0,
            stdout:
              submoduleIgnoredScans === 1
                ? ''
                : submoduleIgnoredScans <= 3
                  ? '!! cache.tmp\0'
                  : '!! final-cache.tmp\0',
            stderr: '',
          };
        }
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: cwd === '/repo/linked' ? ' M submodule\n' : '',
          stderr: '',
        };
      }
      if (argv[0] === 'clean') {
        cleanedPaths.add(
          `/repo/linked/submodule/${String(argv.at(-1)).replace(':(literal)', '')}`,
        );
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'rev-parse' &&
        argv.includes('--absolute-git-dir')
      ) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/primary/.git/modules/submodule\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (_from, to, sourceRoot, additionalSourceRoots) =>
      copied.push({ to, sourceRoot, additionalSourceRoots }),
    pathExists: (path) => !cleanedPaths.has(path),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(copied, [
    {
      to: '/tmp/preserve/ignored/submodule/cache.tmp',
      sourceRoot: '/repo/linked',
      additionalSourceRoots: [
        '/repo/linked',
        '/repo/linked/submodule',
        '/repo/primary/.git/worktrees/linked',
        '/repo/primary/.git/modules/submodule',
      ],
    },
    {
      to: '/tmp/preserve/ignored/final-removal/submodule/final-cache.tmp',
      sourceRoot: '/repo/linked',
      additionalSourceRoots: [
        '/repo/linked',
        '/repo/linked/submodule',
        '/repo/primary/.git/worktrees/linked',
        '/repo/primary/.git/modules/submodule',
      ],
    },
  ]);
  assert.equal(submoduleIgnoredScans, 5);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('records partial ignored-file copies and blocks removal when a later copy fails', () => {
  let copyCalls = 0;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
        return {
          ok: true,
          status: 0,
          stdout: '!! first.tmp\0!! second.tmp\0',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv);
    },
    copyPath: (_from, to) => {
      copyCalls += 1;
      if (to.endsWith('second.tmp')) {
        throw new Error('synthetic copy failure');
      }
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(copyCalls, 2);
  assert.equal(verdict.plan.ignoredFilesScanFailed, true);
  assert.equal(verdict.plan.ignoredFilesCopied[0]?.copiedTo !== null, true);
  assert.equal(
    verdict.plan.ignoredFilesCopied[1]?.copiedTo,
    '/tmp/preserve/ignored/second.tmp',
  );
  assert.equal(verdict.plan.ignoredFilesCopied[1]?.copyFailed, true);
  assert.equal(verdict.mutated, true);
  assert.equal(verdict.plan.removal, null);
});

test('late preservation refreshes uninitialized submodule copies before removal', () => {
  const copied: Array<{
    to: string;
    additionalSourceRoots: string[] | undefined;
  }> = [];
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? '-0000000000000000000000000000000000000000 uninitialized\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/primary/.git/worktrees/linked\n',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    pathExists: (path) => !path.includes('/.git/worktrees/linked/modules/'),
    copyPath: (_from, to, _sourceRoot, additionalSourceRoots) =>
      copied.push({ to, additionalSourceRoots }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(copied.length, 2);
  assert.equal(copied[0]?.to, copied[1]?.to);
  assert.deepEqual(copied[0]?.additionalSourceRoots, [
    '/repo/primary/.git/worktrees/linked',
  ]);
  assert.deepEqual(copied[1]?.additionalSourceRoots, [
    '/repo/primary/.git/worktrees/linked',
  ]);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('late preservation discovers an uninitialized submodule that appears after the initial scan', () => {
  let submoduleStatusCalls = 0;
  const copied: string[] = [];
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        if (cwd === '/repo/linked') submoduleStatusCalls += 1;
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? '-0000000000000000000000000000000000000000 late-submodule\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/primary/.git/worktrees/linked\n',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    pathExists: (path) =>
      path === '/repo/linked' ||
      (path === '/repo/linked/late-submodule' && submoduleStatusCalls >= 2) ||
      path.startsWith('/tmp/preserve'),
    copyPath: (_from, to) => copied.push(to),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(submoduleStatusCalls, 2);
  assert.equal(copied.length, 1);
  assert.equal(verdict.plan.uninitializedSubmodules[0]?.path, 'late-submodule');
  assert.equal(verdict.plan.uninitializedSubmodules[0]?.copiedTo, copied[0]);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('late preservation rejects an uninitialized submodule that becomes initialized', () => {
  let submoduleStatusCalls = 0;
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        if (cwd === '/repo/linked') submoduleStatusCalls += 1;
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? submoduleStatusCalls === 1
                ? '-abc123 late-submodule\n'
                : ' abc123 late-submodule (heads/main)\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv, cwd);
    },
    pathExists: (path) =>
      path === '/repo/linked' ||
      path === '/repo/linked/late-submodule' ||
      path.startsWith('/tmp/preserve'),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(submoduleStatusCalls, 2);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /became initialized before removal/);
});

test('late preservation rejects an unreadable ownership suffix after refresh', () => {
  let confirmCalls = 0;
  let removeCalled = false;
  const deps = fakeDeps({
    confirmBlock: () => {
      confirmCalls += 1;
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied',
          reason:
            confirmCalls >= 4
              ? 'stale-claim-local-worktree-unreadable'
              : 'stale-claim-local-worktree-occupied',
          active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
          evidence: {
            local_worktree: {
              status: confirmCalls >= 4 ? 'unreadable' : 'occupied',
              paths: ['/repo/linked'],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? '-0000000000000000000000000000000000000000 uninitialized\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: () => {},
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(confirmCalls, 4);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /changed during late preservation/);
});

test('preserves nested deinitialized submodule admin data', () => {
  const copied: Array<{ from: string; to: string }> = [];
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? ' abc123def456abc123def456abc123def456abcd parent (heads/main)\n-0000000000000000000000000000000000000000 parent/child\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (from, to) => copied.push({ from, to }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.ok(
    copied.some(
      ({ from, to }) =>
        from ===
          '/repo/primary/.git/worktrees/linked/modules/parent/modules/child' &&
        to === '/tmp/preserve/submodule-gitdir/cGFyZW50L2NoaWxk',
    ),
  );
  assert.equal(verdict.plan.removal?.ran, true);
});

test('preserves slash-containing deinitialized submodule admin data', () => {
  const copied: Array<{ from: string; to: string }> = [];
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? '-0000000000000000000000000000000000000000 libs/parent\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (from, to) => copied.push({ from, to }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.ok(
    copied.some(
      ({ from, to }) =>
        from === '/repo/primary/.git/worktrees/linked/modules/libs/parent' &&
        to ===
          `/tmp/preserve/submodule-gitdir/${Buffer.from('libs/parent').toString('base64url')}`,
    ),
  );
  assert.equal(verdict.plan.removal?.ran, true);
});

test('late preservation refuses a claim change before removal', () => {
  let confirmCalls = 0;
  let removeCalled = false;
  const deps = fakeDeps({
    confirmBlock: () => {
      confirmCalls += 1;
      const claimId = confirmCalls >= 4 ? 'claim-y' : 'claim-x';
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied',
          reason: 'stale-claim-local-worktree-occupied',
          active_claim: { claim_id: claimId, branch: 'issue/1-task' },
          evidence: {
            local_worktree: {
              status: 'occupied',
              paths: ['/repo/linked'],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? '-0000000000000000000000000000000000000000 uninitialized\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: () => {},
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(confirmCalls, 4);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /changed during late preservation/);
});

test('ordinary linked removal rechecks claim identity immediately before removal', () => {
  let confirmCalls = 0;
  let removeCalled = false;
  const deps = fakeDeps({
    confirmBlock: () => {
      confirmCalls += 1;
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied',
          reason: 'stale-claim-local-worktree-occupied',
          active_claim: {
            claim_id: confirmCalls >= 4 ? 'claim-y' : 'claim-x',
            branch: 'issue/1-task',
          },
          evidence: {
            local_worktree: {
              status: 'occupied',
              paths: ['/repo/linked'],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(confirmCalls, 4);
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /immediately before removal/);
});

test('a staged superproject gitlink is not excluded as a submodule-only change', () => {
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            ' abc123def456abc123def456abc123def456abcd submodule (heads/main)\n',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: cwd === '/repo/linked' ? 'M  submodule\n' : '',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(
    verdict.plan.stashes[0]?.hasChanges,
    true,
    'a staged gitlink must remain in the parent preservation scope',
  );
});

test('captures ignored files before stash can change the ignore rules', () => {
  const events: string[] = [];
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
        return {
          ok: true,
          status: 0,
          stdout: '!! secret.env\0 M .gitignore\0',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: ' M .gitignore\n',
          stderr: '',
        };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        events.push('stash');
      }
      return cleanRepoRunGit(argv);
    },
    copyPath: () => events.push('copy'),
  });
  runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(events.slice(0, 2), ['copy', 'stash']);
});

test('rescans ignored files immediately before ordinary linked removal', () => {
  let ignoredScanCalls = 0;
  const copied: string[] = [];
  const cleanedPaths = new Set<string>();
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
        ignoredScanCalls += 1;
        return {
          ok: true,
          status: 0,
          stdout:
            ignoredScanCalls === 1
              ? ''
              : ignoredScanCalls <= 3
                ? '!! late.env\0'
                : '!! final.env\0',
          stderr: '',
        };
      }
      if (argv[0] === 'clean') {
        cleanedPaths.add(
          `/repo/linked/${String(argv.at(-1)).replace(':(literal)', '')}`,
        );
      }
      return cleanRepoRunGit(argv);
    },
    copyPath: (_from, to) => copied.push(to),
    pathExists: (path) => !cleanedPaths.has(path),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(ignoredScanCalls, 5);
  assert.deepEqual(copied, [
    '/tmp/preserve/ignored/late.env',
    '/tmp/preserve/ignored/final-removal/final.env',
  ]);
  assert.equal(verdict.plan.ignoredFilesCopied.at(-1)?.path, 'final.env');
  assert.equal(verdict.plan.removal?.ran, true);
});

test('linked removal rechecks routing after final ignored-file cleanup', () => {
  let ignoredScanCalls = 0;
  let finalScanComplete = false;
  let removalAttempted = false;
  const cleanedPaths = new Set<string>();
  const deps = fakeDeps({
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'local_worktree_occupied',
        reason: 'stale-claim-local-worktree-occupied',
        active_claim: {
          claim_id: finalScanComplete ? 'claim-y' : 'claim-x',
          branch: finalScanComplete ? 'issue/2-other' : 'issue/1-task',
        },
        evidence: {
          local_worktree: {
            status: 'occupied',
            paths: ['/repo/linked'],
            reason: null,
          },
        },
      },
      error: null,
    }),
    runGit: (argv) => {
      if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
        ignoredScanCalls += 1;
        if (ignoredScanCalls === 4) finalScanComplete = true;
        return {
          ok: true,
          status: 0,
          stdout:
            ignoredScanCalls === 1
              ? ''
              : ignoredScanCalls <= 3
                ? '!! late.env\0'
                : '!! final.env\0',
          stderr: '',
        };
      }
      if (argv[0] === 'clean') {
        cleanedPaths.add(
          `/repo/linked/${String(argv.at(-1)).replace(':(literal)', '')}`,
        );
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removalAttempted = true;
      }
      return cleanRepoRunGit(argv);
    },
    copyPath: () => {},
    pathExists: (path) => !cleanedPaths.has(path),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(ignoredScanCalls, 5);
  assert.equal(removalAttempted, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /changed after final ignored-file cleanup/);
});

test('a failed stash-list probe blocks removal before trusting clean or stashed state', () => {
  let stashListCalls = 0;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        stashListCalls += 1;
        return stashListCalls === 1
          ? { ok: true, status: 0, stdout: '', stderr: '' }
          : { ok: false, status: 128, stdout: '', stderr: 'stash unavailable' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.stashListReadFailed, true);
  assert.equal(verdict.plan.removal?.ran, undefined);
  assert.match(verdict.result, /could not be fully verified/);
});

test('a failed `git submodule status` list blocks removal instead of silently reading as no submodules (advisor-caught gap)', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return { ok: false, status: 128, stdout: '', stderr: 'boom' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.submoduleListFailed, true);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
  assert.match(verdict.result, /could not be fully verified/);
});

test('malformed `git submodule status` output blocks removal instead of dropping a submodule', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: 'not a submodule record\n',
          stderr: '',
        };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.submoduleListFailed, true);
  assert.equal(removeCalled, false);
  assert.match(verdict.result, /could not be fully verified/);
});

test('unsafe `git submodule status` paths fail closed before preservation mutation (Copilot review finding)', () => {
  let removeCalled = false;
  let stashPushCalled = false;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout: ' abc123def456abc123def456abc123def456abcd ../../outside\n',
          stderr: '',
        };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        stashPushCalled = true;
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.submoduleListFailed, true);
  assert.equal(stashPushCalled, false);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
  assert.match(verdict.result, /could not be fully verified/);
});

test('step 4 stops removal when the fresh claim/branch identity no longer matches step 1 (Copilot review finding)', () => {
  const deps = fakeDeps({
    confirmBlock: (() => {
      let call = 0;
      return () => {
        call += 1;
        return {
          ok: true,
          routing: {
            state: 'local_worktree_occupied',
            reason: 'stale-claim-local-worktree-occupied',
            // First call (step 1) recovers claim-x; the recheck (step 4)
            // now reports a DIFFERENT claim occupying the same path --
            // simulating the issue moving to another stale/legacy claim
            // while this session waited for the clone lock.
            active_claim: {
              claim_id: call === 1 ? 'claim-x' : 'claim-y',
              branch: 'issue/1-task',
            },
            evidence: {
              local_worktree: {
                status: 'occupied',
                paths: ['/repo/linked'],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.removal?.ran, false);
  assert.equal(verdict.ready, false);
  assert.match(verdict.result, /claim being recovered changed since step 1/);
});

test('step 4 stops removal when a preservation artifact no longer verifies fresh under the clone lock (Copilot review finding)', () => {
  // Call order for `git stash list` against the single stashed scope:
  // 1st = baseline (pre-push, empty); 2nd = post-push verify (one tagged
  // entry -- so the pre-lock `preservationVerified` check passes); 3rd =
  // the FRESH re-check inside the clone lock, which finds it gone again --
  // simulating a concurrent pop/drop in the lock-wait window.
  let stashListCalls = 0;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        stashListCalls += 1;
        return {
          ok: true,
          status: 0,
          stdout:
            stashListCalls === 2
              ? 'stash@{0}: On issue/1-task: idd-lwr claim-x'
              : '',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.stashed, true);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /no longer verifies fresh under the clone lock/);
});

test('fresh stash verification rejects a stale duplicate tag after the new stash disappears', () => {
  let stashListCalls = 0;
  const tag = 'idd-lwr claim-x';
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        stashListCalls += 1;
        const one = `stash@{0}: On issue/1-task: ${tag}`;
        const two = `${one}\nstash@{1}: On issue/1-task: ${tag}`;
        return {
          ok: true,
          status: 0,
          stdout: stashListCalls === 2 ? `${two}\n` : `${one}\n`,
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.baselineCount, 1);
  assert.equal(verdict.plan.stashes[0]?.verifiedCount, 2);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /no longer verifies fresh under the clone lock/);
});

test('fresh preservation verification rejects a copied artifact redirected into the target', () => {
  let redirected = false;
  let removeCalled = false;
  const copiedIgnoredFile = '/tmp/preserve/ignored/.env';
  const deps = fakeDeps({
    acquireCloneLock: () => {
      redirected = true;
      return { path: '/repo/.idd-clone.lock', token: 'tok' };
    },
    ensurePreserveDir: () => '/tmp/preserve',
    runGit: (argv) => {
      if (argv[0] === 'status' && argv.includes('--porcelain=v1')) {
        return { ok: true, status: 0, stdout: '!! .env\0', stderr: '' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
    realpathOrNull: (path) =>
      redirected && path === copiedIgnoredFile
        ? '/repo/linked/.git/redirected-artifact'
        : path,
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(removeCalled, false);
  assert.equal(verdict.plan.removal, null);
  assert.match(verdict.result, /step 3 preservation/);
});

for (const operationCase of [
  { kind: 'merge', cleanup: ['merge', '--abort'] },
  { kind: 'rebase', cleanup: ['rebase', '--quit'] },
  { kind: 'cherry-pick', cleanup: ['cherry-pick', '--abort'] },
  { kind: 'bisect', cleanup: ['bisect', 'reset'] },
] as const) {
  test(`primary-worktree cleanup clears ${operationCase.kind} before checkout`, () => {
    const root = mkdtempSync(join(tmpdir(), 'idd-lwr-primary-operation-'));
    const operationRoot = join(root, '.git');
    const rebaseDir = join(operationRoot, 'rebase-merge');
    const bisectLog = join(operationRoot, 'BISECT_LOG');
    const bisectStart = join(operationRoot, 'BISECT_START');
    let operationActive = true;
    let confirmCalls = 0;
    const events: string[] = [];
    let rebaseResetArgv: string[] | null = null;
    try {
      if (operationCase.kind === 'rebase') {
        mkdirSync(rebaseDir, { recursive: true });
        writeFileSync(join(rebaseDir, 'orig-head'), 'pre-operation-sha\n');
      }
      if (operationCase.kind === 'bisect') {
        mkdirSync(operationRoot, { recursive: true });
        writeFileSync(bisectLog, 'bisect\n');
        writeFileSync(bisectStart, 'issue/1-task\n');
      }
      const deps = fakeDeps({
        cwd: () => root,
        listWorktreeRecords: () => [
          {
            path: root,
            branchRef: 'refs/heads/main',
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
          },
        ],
        pathExists: (path) => path === root || existsSync(path),
        confirmBlock: () => {
          confirmCalls += 1;
          const occupied = confirmCalls < 4;
          return {
            ok: true,
            routing: {
              state: occupied ? 'local_worktree_occupied' : 'stale',
              reason: occupied
                ? 'stale-claim-local-worktree-occupied'
                : 'active-claim-stale',
              active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
              evidence: {
                local_worktree: {
                  status: occupied ? 'occupied' : 'absent',
                  paths: occupied ? [root] : [],
                  reason: null,
                },
              },
            },
            error: null,
          };
        },
        runGit: (argv, cwd) => {
          if (
            argv[0] === 'rev-parse' &&
            argv.includes('-q') &&
            argv.includes('MERGE_HEAD')
          ) {
            return operationCase.kind === 'merge' && operationActive
              ? { ok: true, status: 0, stdout: 'merge-head\n', stderr: '' }
              : { ok: false, status: 1, stdout: '', stderr: '' };
          }
          if (
            argv[0] === 'rev-parse' &&
            argv.includes('-q') &&
            argv.includes('CHERRY_PICK_HEAD')
          ) {
            return operationCase.kind === 'cherry-pick' && operationActive
              ? { ok: true, status: 0, stdout: 'cherry-head\n', stderr: '' }
              : { ok: false, status: 1, stdout: '', stderr: '' };
          }
          if (
            argv[0] === 'rev-parse' &&
            argv.includes('--git-path') &&
            argv.includes('rebase-merge')
          ) {
            return operationCase.kind === 'rebase' && operationActive
              ? { ok: true, status: 0, stdout: `${rebaseDir}\n`, stderr: '' }
              : { ok: true, status: 0, stdout: '', stderr: '' };
          }
          if (
            argv[0] === 'rev-parse' &&
            argv.includes('--git-path') &&
            argv.includes('rebase-apply')
          ) {
            return { ok: true, status: 0, stdout: '', stderr: '' };
          }
          if (
            argv[0] === 'rev-parse' &&
            argv.includes('--git-path') &&
            argv.includes('BISECT_LOG')
          ) {
            return operationCase.kind === 'bisect' && operationActive
              ? { ok: true, status: 0, stdout: `${bisectLog}\n`, stderr: '' }
              : { ok: true, status: 0, stdout: '', stderr: '' };
          }
          if (
            argv[0] === 'rev-parse' &&
            argv.includes('--git-path') &&
            argv.includes('BISECT_START')
          ) {
            return operationCase.kind === 'bisect' && operationActive
              ? {
                  ok: true,
                  status: 0,
                  stdout: `${bisectStart}\n`,
                  stderr: '',
                }
              : { ok: true, status: 0, stdout: '', stderr: '' };
          }
          if (
            argv[0] === 'rev-parse' &&
            argv.length === 2 &&
            argv[1] === 'issue/1-task'
          ) {
            return {
              ok: true,
              status: 0,
              stdout: 'pre-operation-sha\n',
              stderr: '',
            };
          }
          if (argv[0] === 'rev-parse' && argv.includes('HEAD')) {
            return {
              ok: true,
              status: 0,
              stdout: 'pre-operation-sha\n',
              stderr: '',
            };
          }
          if (
            argv[0] === 'rev-parse' &&
            argv.includes('--verify') &&
            argv.includes('refs/idd-lwr/issue/1-task')
          ) {
            return {
              ok: true,
              status: 0,
              stdout: 'pre-operation-sha\n',
              stderr: '',
            };
          }
          if (
            argv[0] === operationCase.cleanup[0] &&
            argv.slice(1).join(' ') === operationCase.cleanup.slice(1).join(' ')
          ) {
            events.push('cleanup');
            operationActive = false;
            if (operationCase.kind === 'rebase') {
              rmSync(rebaseDir, { recursive: true, force: true });
            }
            if (operationCase.kind === 'bisect') {
              rmSync(bisectLog, { force: true });
              rmSync(bisectStart, { force: true });
            }
            return { ok: true, status: 0, stdout: '', stderr: '' };
          }
          if (
            operationCase.kind === 'rebase' &&
            argv[0] === 'diff' &&
            argv.includes('--diff-filter=U')
          ) {
            return {
              ok: true,
              status: 0,
              stdout: 'conflict.txt\n',
              stderr: '',
            };
          }
          if (operationCase.kind === 'rebase' && argv[0] === 'reset') {
            events.push('index-reset');
            rebaseResetArgv = argv;
            return { ok: true, status: 0, stdout: '', stderr: '' };
          }
          if (argv[0] === 'checkout') {
            events.push('checkout');
          }
          if (argv[0] === 'update-ref') {
            return { ok: true, status: 0, stdout: '', stderr: '' };
          }
          return cleanRepoRunGit(argv, cwd);
        },
        checkLock: () => ({
          path: join(root, '.git/idd-claim.lock'),
          present: true,
          holder: {
            agentId: 'test-agent',
            claimId: 'claim-x',
            acquiredAt: '2026-09-27T00:00:00Z',
          },
        }),
        removeLockIfMatches: () => true,
      });
      const verdict = runLocalWorktreeRecovery(
        baseArgs({
          apply: true,
          operatorConfirmedNoLiveSession: true,
          worktree: root,
        }),
        deps,
      );
      assert.deepEqual(
        verdict.plan.inProgressOperation?.kind,
        operationCase.kind,
      );
      assert.equal(verdict.plan.removal?.ran, true);
      assert.ok(events.indexOf('cleanup') >= 0);
      if (operationCase.kind === 'rebase') {
        assert.ok(events.indexOf('index-reset') >= 0);
        assert.ok(events.indexOf('index-reset') < events.indexOf('checkout'));
        assert.deepEqual(rebaseResetArgv, ['reset', '--hard']);
      }
      assert.ok(events.indexOf('checkout') >= 0);
      assert.ok(events.indexOf('cleanup') < events.indexOf('checkout'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('primary-worktree cleanup clears an in-progress submodule operation before checkout', () => {
  const root = mkdtempSync(
    join(tmpdir(), 'idd-lwr-primary-submodule-operation-'),
  );
  const submodulePath = join(root, 'submodule');
  const submoduleGitDir = join(submodulePath, '.git');
  const rebaseDir = join(submoduleGitDir, 'rebase-merge');
  const preserveDir = mkdtempSync(
    join(tmpdir(), 'idd-lwr-primary-submodule-preserve-'),
  );
  let operationActive = true;
  let submoduleRefWritten = false;
  let confirmCalls = 0;
  const events: string[] = [];
  try {
    mkdirSync(rebaseDir, { recursive: true });
    writeFileSync(join(rebaseDir, 'orig-head'), 'submodule-tip\n');
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      confirmBlock: () => {
        confirmCalls += 1;
        const occupied = confirmCalls < 4;
        return {
          ok: true,
          routing: {
            state: occupied ? 'local_worktree_occupied' : 'stale',
            reason: occupied
              ? 'stale-claim-local-worktree-occupied'
              : 'active-claim-stale',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: occupied ? 'occupied' : 'absent',
                paths: occupied ? [root] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      pathExists: (path) =>
        path === root ||
        path === submodulePath ||
        path === submoduleGitDir ||
        path.startsWith(preserveDir) ||
        existsSync(path),
      realpathOrNull: (path) => path,
      readlinkOrNull: () => null,
      ensurePreserveDir: () => preserveDir,
      copyPath: (_from, to) => {
        mkdirSync(to, { recursive: true });
      },
      runGit: (argv, cwd) => {
        if (argv[0] === 'submodule' && argv[1] === 'status') {
          return {
            ok: true,
            status: 0,
            stdout:
              '+1234567890abcdef1234567890abcdef12345678 submodule (heads/main)\n',
            stderr: '',
          };
        }
        if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
          return {
            ok: true,
            status: 0,
            stdout: `${cwd === submodulePath ? submoduleGitDir : join(root, '.git')}\n`,
            stderr: '',
          };
        }
        if (
          argv[0] === 'rev-parse' &&
          argv.includes('-q') &&
          (argv.includes('MERGE_HEAD') || argv.includes('CHERRY_PICK_HEAD'))
        ) {
          return { ok: false, status: 1, stdout: '', stderr: '' };
        }
        if (argv[0] === 'rev-parse' && argv.includes('--git-path')) {
          if (
            cwd === submodulePath &&
            argv.includes('rebase-merge') &&
            operationActive
          ) {
            return {
              ok: true,
              status: 0,
              stdout: `${rebaseDir}\n`,
              stderr: '',
            };
          }
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'rev-parse' && argv.includes('HEAD')) {
          return {
            ok: true,
            status: 0,
            stdout: 'primary-head\n',
            stderr: '',
          };
        }
        if (argv[0] === 'rebase' && argv[1] === '--quit') {
          events.push('submodule-cleanup');
          operationActive = false;
          rmSync(rebaseDir, { recursive: true, force: true });
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (
          argv[0] === 'update-ref' &&
          cwd === submodulePath &&
          argv[1] === 'refs/idd-lwr/issue/1-task'
        ) {
          submoduleRefWritten = true;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (
          argv[0] === 'rev-parse' &&
          argv.includes('--verify') &&
          argv.includes('refs/idd-lwr/issue/1-task') &&
          cwd === submodulePath &&
          submoduleRefWritten
        ) {
          return {
            ok: true,
            status: 0,
            stdout: 'submodule-tip\n',
            stderr: '',
          };
        }
        if (argv[0] === 'ls-tree') {
          return {
            ok: true,
            status: 0,
            stdout: `160000 commit ${'a'.repeat(40)}\tsubmodule\0`,
            stderr: '',
          };
        }
        if (argv[0] === 'checkout') {
          events.push('checkout');
        }
        return cleanRepoRunGit(argv, cwd);
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      }),
      removeLockIfMatches: () => true,
    });
    const verdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
      }),
      deps,
    );
    assert.deepEqual(verdict.plan.submoduleInProgressOperations, [
      {
        path: 'submodule',
        operation: { kind: 'rebase', tipSha: 'submodule-tip' },
      },
    ]);
    assert.equal(verdict.plan.removal?.ran, true);
    assert.deepEqual(events, ['submodule-cleanup', 'checkout']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(preserveDir, { recursive: true, force: true });
  }
});

test('primary recovery refuses a fresh claim during post-checkout absence confirmation', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-primary-fresh-claim-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  let confirmCalls = 0;
  let lockRemoved = false;
  try {
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      pathExists: (path) => path === root || existsSync(path),
      confirmBlock: () => {
        confirmCalls += 1;
        const absent = confirmCalls >= 4;
        return {
          ok: true,
          routing: {
            state: absent ? 'non_inheritable' : 'local_worktree_occupied',
            reason: absent
              ? 'active-claim-non-stale'
              : 'stale-claim-local-worktree-occupied',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: absent ? 'absent' : 'occupied',
                paths: absent ? [] : [root],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      runGit: (argv, cwd) => {
        if (argv[0] === 'checkout') {
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        return cleanRepoRunGit(argv, cwd);
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      }),
      removeLockIfMatches: () => {
        lockRemoved = true;
        return true;
      },
    });
    const verdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
      }),
      deps,
    );
    assert.equal(lockRemoved, false);
    assert.equal(verdict.plan.removal?.ran, false);
    assert.match(verdict.result, /same recovered claim\/branch absent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('primary recovery resumes after a post-checkout confirmation failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-primary-resume-'));
  const preserveDir = `${root}-preserve`;
  mkdirSync(join(root, '.git'), { recursive: true });
  let checkoutDone = false;
  let firstAttempt = true;
  let primaryMarker: PrimaryRecoveryLockMarker | null = {
    phase: 'primary-checkout',
    worktree: root,
    claimId: 'claim-x',
    branch: 'issue/1-task',
    developmentBranch: 'main',
    releasedClaim: false,
  };
  let submoduleSyncCalls = 0;
  let submoduleUpdateCalls = 0;
  let ensurePreserveDirCalls = 0;
  let lockRemoved = false;
  try {
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      pathExists: (path) => path === root || existsSync(path),
      ensurePreserveDir: () => {
        ensurePreserveDirCalls += 1;
        if (existsSync(preserveDir)) {
          throw new Error('preserve directory already exists');
        }
        mkdirSync(preserveDir);
        return preserveDir;
      },
      confirmBlock: () => {
        if (!firstAttempt) {
          return {
            ok: true,
            routing: {
              state: 'unclaimed',
              reason: 'no-active-claim',
              active_claim: null,
              evidence: {
                local_worktree: {
                  status: 'absent',
                  paths: [],
                  reason: null,
                },
                released_claim: {
                  claim_id: 'claim-x',
                  branch: 'issue/1-task',
                },
              },
            },
            error: null,
          };
        }
        const postCheckoutFailure = checkoutDone;
        return {
          ok: true,
          routing: {
            state: postCheckoutFailure
              ? 'non_inheritable'
              : 'local_worktree_occupied',
            reason: postCheckoutFailure
              ? 'active-claim-non-stale'
              : 'stale-claim-local-worktree-occupied',
            active_claim: {
              claim_id: postCheckoutFailure ? 'claim-y' : 'claim-x',
              branch: postCheckoutFailure ? 'issue/2-other' : 'issue/1-task',
            },
            evidence: {
              local_worktree: {
                status: postCheckoutFailure ? 'absent' : 'occupied',
                paths: postCheckoutFailure ? [] : [root],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      runGit: (argv, cwd) => {
        if (argv[0] === 'checkout') {
          checkoutDone = true;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'submodule' && argv[1] === 'sync') {
          submoduleSyncCalls += 1;
        }
        if (argv[0] === 'submodule' && argv[1] === 'update') {
          submoduleUpdateCalls += 1;
        }
        return cleanRepoRunGit(argv, cwd);
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
          ...(primaryMarker === null ? {} : { primaryRecovery: primaryMarker }),
        },
      }),
      updatePrimaryRecoveryLockMarker: (_path, _expected, marker) => {
        primaryMarker = marker;
        return true;
      },
      removeLockIfMatches: () => {
        lockRemoved = true;
        return true;
      },
    });
    const firstVerdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
        preserveDir,
      }),
      deps,
    );
    assert.equal(firstVerdict.plan.removal?.ran, false);
    assert.match(firstVerdict.result, /same recovered claim\/branch absent/);
    assert.equal(firstVerdict.preserveDir, preserveDir);
    assert.equal(ensurePreserveDirCalls, 1);
    assert.notEqual(primaryMarker, null);
    assert.equal(typeof primaryMarker?.preservation, 'string');

    firstAttempt = false;
    assert.equal(primaryMarker?.preserveDir, preserveDir);
    const savedPreservation = primaryMarker?.preservation;
    const dryRunVerdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: false,
        worktree: root,
        preserveDir,
      }),
      deps,
    );
    assert.equal(dryRunVerdict.step1.outcome, 'blocked-primary-resume');
    assert.equal(dryRunVerdict.preserveDir, preserveDir);
    assert.equal(dryRunVerdict.plan.removal?.ran, false);
    assert.equal(primaryMarker?.preservation, savedPreservation);
    const resumedVerdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
        preserveDir,
      }),
      deps,
    );
    assert.equal(resumedVerdict.step1.outcome, 'blocked-primary-resume');
    assert.equal(resumedVerdict.plan.removal?.ran, true);
    assert.equal(lockRemoved, true);
    assert.equal(submoduleSyncCalls, 2);
    assert.equal(submoduleUpdateCalls, 2);
    assert.equal(ensurePreserveDirCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(preserveDir, { recursive: true, force: true });
  }
});

test('primary legacy recovery reserves an absent lock before checkout', () => {
  const root = '/repo/primary';
  let checkoutDone = false;
  let lockPresent = false;
  let primaryMarker: PrimaryRecoveryLockMarker | null = null;
  let lockRemoved = false;
  const deps = fakeDeps({
    cwd: () => root,
    listWorktreeRecords: () => [
      {
        path: root,
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    pathExists: (path) => path === root || path === `${root}/.git`,
    confirmBlock: () => ({
      ok: true,
      routing: checkoutDone
        ? {
            state: 'unclaimed',
            reason: 'legacy-released',
            active_claim: null,
            evidence: {
              local_worktree: {
                status: 'absent',
                paths: [],
                reason: null,
              },
              released_claim: {
                claim_id: null,
                branch: 'legacy-task',
              },
            },
          }
        : {
            state: 'local_worktree_occupied',
            reason: 'released-claim-local-worktree-occupied',
            active_claim: null,
            evidence: {
              local_worktree: {
                status: 'occupied',
                paths: [root],
                reason: null,
              },
              released_claim: {
                claim_id: null,
                branch: 'legacy-task',
              },
            },
          },
      error: null,
    }),
    runGit: (argv, cwd) => {
      if (argv[0] === 'checkout') checkoutDone = true;
      return cleanRepoRunGit(argv, cwd);
    },
    checkLock: () =>
      lockPresent
        ? {
            path: `${root}/.git/idd-claim.lock`,
            present: true,
            holder: {
              agentId: '',
              claimId: '',
              acquiredAt: '2026-09-28T00:00:00Z',
              ...(primaryMarker === null
                ? {}
                : { primaryRecovery: primaryMarker }),
            },
          }
        : {
            path: `${root}/.git/idd-claim.lock`,
            present: false,
          },
    updatePrimaryRecoveryLockMarker: (_path, expected, marker) => {
      if (!expected.present && marker !== null) {
        assert.equal(marker.claimId, '');
        assert.equal(marker.releasedClaim, true);
        lockPresent = true;
      }
      if (marker === null) {
        lockPresent = false;
      } else {
        primaryMarker = marker;
      }
      return true;
    },
    removeLockIfMatches: () => {
      lockRemoved = true;
      return true;
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: root,
    }),
    deps,
  );
  assert.equal(checkoutDone, true);
  assert.equal(lockRemoved, true);
  assert.equal(verdict.plan.removal?.ran, true, JSON.stringify(verdict));
});

test('primary recovery rechecks claim and lock identity immediately before checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-primary-pre-checkout-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  let confirmCalls = 0;
  let checkoutAttempted = false;
  let lockRemoved = false;
  try {
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      pathExists: (path) => path === root || existsSync(path),
      confirmBlock: () => {
        confirmCalls += 1;
        const changed = confirmCalls >= 3;
        return {
          ok: true,
          routing: {
            state: 'local_worktree_occupied',
            reason: 'stale-claim-local-worktree-occupied',
            active_claim: {
              claim_id: changed ? 'claim-y' : 'claim-x',
              branch: changed ? 'issue/2-other' : 'issue/1-task',
            },
            evidence: {
              local_worktree: {
                status: 'occupied',
                paths: [root],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      runGit: (argv, cwd) => {
        if (argv[0] === 'checkout') checkoutAttempted = true;
        return cleanRepoRunGit(argv, cwd);
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      }),
      removeLockIfMatches: () => {
        lockRemoved = true;
        return true;
      },
    });
    const verdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
      }),
      deps,
    );
    assert.equal(confirmCalls, 3);
    assert.equal(checkoutAttempted, false);
    assert.equal(lockRemoved, false);
    assert.equal(verdict.plan.removal?.ran, false);
    assert.match(verdict.result, /immediately before checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('primary recovery resolves the development branch before preservation', () => {
  let mutationCalls = 0;
  const deps = fakeDeps({
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'local_worktree_occupied',
        reason: 'stale-claim-local-worktree-occupied',
        active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
        evidence: {
          local_worktree: {
            status: 'occupied',
            paths: ['/repo/primary'],
            reason: null,
          },
        },
      },
      error: null,
    }),
    resolveDevelopmentBranch: () => {
      throw new Error('local config is unreadable');
    },
    runGit: (argv) => {
      if (
        (argv[0] === 'stash' && argv[1] === 'push') ||
        argv[0] === 'update-ref' ||
        argv[0] === 'checkout'
      ) {
        mutationCalls += 1;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: '/repo/primary',
    }),
    deps,
  );
  assert.equal(mutationCalls, 0);
  assert.equal(verdict.mutated, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /before preservation/);
});

test('primary recovery verifies the development branch exists before preservation', () => {
  let preservationMutation = false;
  const deps = fakeDeps({
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'local_worktree_occupied',
        reason: 'stale-claim-local-worktree-occupied',
        active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
        evidence: {
          local_worktree: {
            status: 'occupied',
            paths: ['/repo/primary'],
            reason: null,
          },
        },
      },
      error: null,
    }),
    runGit: (argv) => {
      if (argv[0] === 'show-ref') {
        return {
          ok: false,
          status: 1,
          stdout: '',
          stderr: 'missing branch',
        };
      }
      if (
        (argv[0] === 'stash' && argv[1] === 'push') ||
        argv[0] === 'update-ref' ||
        argv[0] === 'checkout'
      ) {
        preservationMutation = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: '/repo/primary',
    }),
    deps,
  );
  assert.equal(preservationMutation, false);
  assert.equal(verdict.mutated, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /not available locally/);
});

test('primary recovery does not abort a merge already cleared by stash', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-primary-stash-merge-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  let operationActive = true;
  let stashCreated = false;
  let confirmCalls = 0;
  let abortCalled = false;
  let submoduleUpdateCalled = false;
  try {
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      pathExists: (path) => path === root || existsSync(path),
      confirmBlock: () => {
        confirmCalls += 1;
        const occupied = confirmCalls < 4;
        return {
          ok: true,
          routing: {
            state: occupied ? 'local_worktree_occupied' : 'stale',
            reason: occupied
              ? 'stale-claim-local-worktree-occupied'
              : 'active-claim-stale',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: occupied ? 'occupied' : 'absent',
                paths: occupied ? [root] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      runGit: (argv, cwd) => {
        if (
          argv[0] === 'rev-parse' &&
          argv.includes('-q') &&
          argv.includes('MERGE_HEAD')
        ) {
          return operationActive
            ? { ok: true, status: 0, stdout: 'merge-head\n', stderr: '' }
            : { ok: false, status: 1, stdout: '', stderr: '' };
        }
        if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (
          argv[0] === 'status' &&
          stashCreated &&
          argv.includes('--ignore-submodules=none')
        ) {
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'status') {
          return {
            ok: true,
            status: 0,
            stdout: ' M tracked.txt\n',
            stderr: '',
          };
        }
        if (argv[0] === 'stash' && argv[1] === 'list') {
          return {
            ok: true,
            status: 0,
            stdout: stashCreated ? 'stash@{0}: On main: idd-lwr claim-x\n' : '',
            stderr: '',
          };
        }
        if (argv[0] === 'stash' && argv[1] === 'push') {
          stashCreated = true;
          operationActive = false;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'merge' && argv[1] === '--abort') {
          abortCalled = true;
          return {
            ok: false,
            status: 128,
            stdout: '',
            stderr: 'There is no merge to abort',
          };
        }
        if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
          return { ok: true, status: 0, stdout: `${root}/.git\n`, stderr: '' };
        }
        if (argv[0] === 'rev-parse' && argv.includes('HEAD')) {
          return { ok: true, status: 0, stdout: 'head-sha\n', stderr: '' };
        }
        if (argv[0] === 'rev-parse' && argv[1] === '--verify') {
          return { ok: true, status: 0, stdout: 'head-sha\n', stderr: '' };
        }
        if (argv[0] === 'checkout') {
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'submodule' && argv[1] === 'update') {
          submoduleUpdateCalled = true;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        return cleanRepoRunGit(argv, cwd);
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      }),
      removeLockIfMatches: () => true,
    });
    const verdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
      }),
      deps,
    );
    assert.equal(abortCalled, false);
    assert.equal(submoduleUpdateCalled, true);
    assert.equal(verdict.plan.removal?.ran, true, JSON.stringify(verdict));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('primary recovery stops when checkout leaves a detached or different branch', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-primary-branch-verify-'));
  let confirmCalls = 0;
  let lockRemoved = false;
  let checkoutAttempted = false;
  try {
    mkdirSync(join(root, '.git'), { recursive: true });
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      confirmBlock: () => {
        confirmCalls += 1;
        const occupied = confirmCalls < 4;
        return {
          ok: true,
          routing: {
            state: occupied ? 'local_worktree_occupied' : 'stale',
            reason: occupied
              ? 'stale-claim-local-worktree-occupied'
              : 'active-claim-stale',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: occupied ? 'occupied' : 'absent',
                paths: occupied ? [root] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      runGit: (argv, cwd) => {
        if (argv[0] === 'checkout') {
          checkoutAttempted = true;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'submodule' && argv[1] === 'update') {
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'symbolic-ref') {
          return { ok: true, status: 0, stdout: 'release\n', stderr: '' };
        }
        return cleanRepoRunGit(argv, cwd);
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      }),
      removeLockIfMatches: () => {
        lockRemoved = true;
        return true;
      },
    });
    const verdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
      }),
      deps,
    );
    assert.equal(checkoutAttempted, true);
    assert.equal(lockRemoved, false);
    assert.equal(verdict.plan.removal?.ran, false);
    assert.match(verdict.result, /landed on release, not the configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('primary recovery removes initialized submodules deleted by the target branch', () => {
  const root = mkdtempSync(
    join(tmpdir(), 'idd-lwr-primary-deleted-submodule-'),
  );
  const submodulePath = join(root, 'submodule');
  let submodulePresent = true;
  let submoduleStashCreated = false;
  let submoduleStashPushes = 0;
  let checkedOut = false;
  let confirmCalls = 0;
  const events: string[] = [];
  try {
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(submodulePath);
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      pathExists: (path) =>
        path === root ||
        path === join(root, '.git') ||
        path === join(root, '.git/modules/submodule') ||
        path.startsWith('/tmp/preserve') ||
        (submodulePresent && path === submodulePath) ||
        existsSync(path),
      confirmBlock: () => {
        confirmCalls += 1;
        const occupied = confirmCalls < 4;
        return {
          ok: true,
          routing: {
            state: occupied ? 'local_worktree_occupied' : 'stale',
            reason: occupied
              ? 'stale-claim-local-worktree-occupied'
              : 'active-claim-stale',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: occupied ? 'occupied' : 'absent',
                paths: occupied ? [root] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      runGit: (argv, cwd) => {
        if (
          cwd === submodulePath &&
          !submodulePresent &&
          argv[0] === 'stash' &&
          argv[1] === 'list'
        ) {
          return {
            ok: false,
            status: 128,
            stdout: '',
            stderr: 'submodule checkout was removed',
          };
        }
        if (argv[0] === 'submodule' && argv[1] === 'status') {
          return {
            ok: true,
            status: 0,
            stdout:
              cwd === root
                ? ' abc123def456abc123def456abc123def456abcd submodule (heads/main)\n'
                : '',
            stderr: '',
          };
        }
        if (argv[0] === 'stash' && argv[1] === 'push') {
          submoduleStashCreated = true;
          submoduleStashPushes += 1;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (
          argv[0] === 'stash' &&
          argv[1] === 'list' &&
          cwd === submodulePath &&
          submoduleStashCreated
        ) {
          return {
            ok: true,
            status: 0,
            stdout: Array.from(
              { length: submoduleStashPushes },
              (_, index) => `stash@{${index}}: idd-lwr claim-x`,
            ).join('\n'),
            stderr: '',
          };
        }
        if (argv[0] === 'status') {
          return {
            ok: true,
            status: 0,
            stdout:
              argv[1] === '--porcelain=v1'
                ? ''
                : cwd === root
                  ? checkedOut
                    ? ''
                    : ' M submodule\n'
                  : cwd === submodulePath
                    ? submoduleStashPushes > 0
                      ? ' M changed-after-initial-preservation.txt\n'
                      : ' M changed.txt\n'
                    : '',
            stderr: '',
          };
        }
        if (argv[0] === 'ls-tree') {
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
          return {
            ok: true,
            status: 0,
            stdout:
              cwd === root
                ? `${root}/.git\n`
                : `${root}/.git/modules/submodule\n`,
            stderr: '',
          };
        }
        if (argv[0] === 'checkout') {
          checkedOut = true;
          events.push('checkout');
        }
        if (argv[0] === 'submodule' && argv[1] === 'sync') {
          events.push('submodule-sync');
        }
        if (argv[0] === 'submodule' && argv[1] === 'update') {
          events.push('submodule-update');
        }
        return cleanRepoRunGit(argv, cwd);
      },
      removePath: (path) => {
        events.push('remove-submodule');
        submodulePresent = false;
        rmSync(path, { recursive: true, force: true });
      },
      copyPath: (_from, _to, sourceRoot) => {
        if (sourceRoot === `${root}/.git/modules/submodule`) {
          events.push('copy-submodule-admin');
        }
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      }),
      removeLockIfMatches: () => true,
    });
    const verdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
      }),
      deps,
    );
    assert.equal(events.includes('copy-submodule-admin'), true);
    assert.equal(submoduleStashPushes, 2);
    assert.deepEqual(events.slice(-4), [
      'remove-submodule',
      'checkout',
      'submodule-sync',
      'submodule-update',
    ]);
    assert.equal(existsSync(submodulePath), false);
    assert.equal(verdict.plan.removal?.ran, true, JSON.stringify(verdict));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('primary recovery stops when an initialized submodule tip changes late', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-primary-late-tip-'));
  const submodulePath = join(root, 'submodule');
  let submoduleHeadReads = 0;
  let destructiveCall = false;
  let confirmCalls = 0;
  try {
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(submodulePath, '.git'), { recursive: true });
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      pathExists: (path) =>
        path === root ||
        path === submodulePath ||
        path === join(root, '.git') ||
        path === join(submodulePath, '.git') ||
        path.startsWith('/tmp/preserve'),
      confirmBlock: () => {
        confirmCalls += 1;
        return {
          ok: true,
          routing: {
            state: 'local_worktree_occupied',
            reason: 'stale-claim-local-worktree-occupied',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: 'occupied',
                paths: [root],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      runGit: (argv, cwd) => {
        if (argv[0] === 'submodule' && argv[1] === 'status') {
          return {
            ok: true,
            status: 0,
            stdout:
              cwd === root
                ? ' abc123def456abc123def456abc123def456abcd submodule (heads/main)\n'
                : '',
            stderr: '',
          };
        }
        if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
          return {
            ok: true,
            status: 0,
            stdout:
              cwd === submodulePath
                ? `${submodulePath}/.git\n`
                : `${root}/.git\n`,
            stderr: '',
          };
        }
        if (argv[0] === 'rev-parse' && argv.includes('HEAD')) {
          if (cwd === submodulePath) {
            submoduleHeadReads += 1;
            return {
              ok: true,
              status: 0,
              stdout: `${submoduleHeadReads === 1 ? 'initial' : 'late'}-tip\n`,
              stderr: '',
            };
          }
          return { ok: true, status: 0, stdout: 'primary-tip\n', stderr: '' };
        }
        if (argv[0] === 'status') {
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'worktree' && argv[1] === 'remove') {
          destructiveCall = true;
        }
        return cleanRepoRunGit(argv, cwd);
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      }),
      removeLockIfMatches: () => {
        destructiveCall = true;
        return true;
      },
    });
    const verdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
      }),
      deps,
    );
    assert.equal(confirmCalls, 2);
    assert.equal(submoduleHeadReads, 2);
    assert.equal(destructiveCall, false);
    assert.equal(verdict.plan.removal?.ran, false);
    assert.match(verdict.result, /changed its preserved tip or admin state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('primary recovery removes late ignored files before reporting release', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-primary-ignored-'));
  const preserveDir = mkdtempSync(
    join(tmpdir(), 'idd-lwr-primary-ignored-preserve-'),
  );
  const ignoredPath = join(root, 'stale*');
  const postCheckoutIgnoredPath = join(root, 'generated-during-checkout*');
  const finalIgnoredPath = join(root, 'generated-before-release*');
  let ignoredPresent = true;
  let postCheckoutIgnoredPresent = false;
  let finalIgnoredPresent = false;
  let ignoredScanCalls = 0;
  let confirmCalls = 0;
  let submoduleUpdateArgs: string[] = [];
  const events: string[] = [];
  try {
    mkdirSync(join(root, '.git'), { recursive: true });
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      pathExists: (path) =>
        path === root ||
        path === join(root, '.git') ||
        path.startsWith(preserveDir) ||
        (ignoredPresent && path === ignoredPath) ||
        (postCheckoutIgnoredPresent && path === postCheckoutIgnoredPath) ||
        (finalIgnoredPresent && path === finalIgnoredPath) ||
        existsSync(path),
      ensurePreserveDir: () => preserveDir,
      confirmBlock: () => {
        confirmCalls += 1;
        const occupied = confirmCalls < 4;
        return {
          ok: true,
          routing: {
            state: occupied ? 'local_worktree_occupied' : 'stale',
            reason: occupied
              ? 'stale-claim-local-worktree-occupied'
              : 'active-claim-stale',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: occupied ? 'occupied' : 'absent',
                paths: occupied ? [root] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      copyPath: (_from, to) => {
        events.push(`copy:${to}`);
        mkdirSync(to, { recursive: true });
      },
      runGit: (argv, cwd) => {
        if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
          ignoredScanCalls += 1;
          if (ignoredScanCalls === 4) postCheckoutIgnoredPresent = true;
          if (ignoredScanCalls === 6) finalIgnoredPresent = true;
          return {
            ok: true,
            status: 0,
            stdout:
              ignoredScanCalls === 1
                ? ''
                : ignoredScanCalls <= 3
                  ? '!! stale*\0'
                  : ignoredScanCalls <= 5
                    ? '!! generated-during-checkout*\0'
                    : '!! generated-before-release*\0',
            stderr: '',
          };
        }
        if (argv[0] === 'clean') {
          events.push(
            `clean:${cwd}:${argv.slice(1, 3).join(' ')}:${argv.at(-1)}`,
          );
          ignoredPresent = false;
          postCheckoutIgnoredPresent = false;
          finalIgnoredPresent = false;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
          return {
            ok: true,
            status: 0,
            stdout: `${root}/.git\n`,
            stderr: '',
          };
        }
        if (argv[0] === 'checkout') {
          events.push('checkout');
        }
        if (argv[0] === 'submodule' && argv[1] === 'update') {
          events.push('submodule-update');
          submoduleUpdateArgs = argv;
        }
        return cleanRepoRunGit(argv, cwd);
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      }),
      removeLockIfMatches: () => true,
    });
    const verdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
      }),
      deps,
    );
    assert.equal(ignoredScanCalls, 7);
    assert.equal(events.includes(`copy:${preserveDir}/ignored/stale*`), true);
    assert.equal(
      events.includes(
        `copy:${preserveDir}/ignored/post-checkout/generated-during-checkout*`,
      ),
      true,
    );
    assert.equal(
      events.includes(
        `copy:${preserveDir}/ignored/final-lock/generated-before-release*`,
      ),
      true,
    );
    assert.equal(ignoredPresent, false);
    assert.equal(finalIgnoredPresent, false);
    assert.deepEqual(submoduleUpdateArgs, [
      'submodule',
      'update',
      '--recursive',
    ]);
    assert.equal(verdict.plan.removal?.ran, true, JSON.stringify(verdict));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(preserveDir, { recursive: true, force: true });
  }
});

test('primary recovery removes preserved deinitialized submodule paths before checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-primary-submodule-'));
  const preserveDir = mkdtempSync(
    join(tmpdir(), 'idd-lwr-primary-submodule-preserve-'),
  );
  const submodulePath = join(root, 'vendor');
  let submodulePresent = true;
  let confirmCalls = 0;
  const events: string[] = [];
  try {
    mkdirSync(join(root, '.git'), { recursive: true });
    const deps = fakeDeps({
      cwd: () => root,
      listWorktreeRecords: () => [
        {
          path: root,
          branchRef: 'refs/heads/main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
      pathExists: (path) =>
        path === root ||
        path === join(root, '.git') ||
        path.startsWith(preserveDir) ||
        (submodulePresent && path === submodulePath),
      ensurePreserveDir: () => preserveDir,
      confirmBlock: () => {
        confirmCalls += 1;
        const occupied = confirmCalls < 4;
        return {
          ok: true,
          routing: {
            state: occupied ? 'local_worktree_occupied' : 'stale',
            reason: occupied
              ? 'stale-claim-local-worktree-occupied'
              : 'active-claim-stale',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: occupied ? 'occupied' : 'absent',
                paths: occupied ? [root] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      },
      copyPath: (_from, to) => {
        events.push(`copy:${to}`);
        mkdirSync(to, { recursive: true });
      },
      removePath: (path) => {
        events.push(`remove:${path}`);
        submodulePresent = false;
      },
      runGit: (argv, cwd) => {
        if (argv[0] === 'submodule' && argv[1] === 'status') {
          return {
            ok: true,
            status: 0,
            stdout:
              cwd === root
                ? '-0000000000000000000000000000000000000000 vendor\n'
                : '',
            stderr: '',
          };
        }
        if (argv[0] === 'status' && argv[1] === '--porcelain=v1') {
          return { ok: true, status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'checkout') events.push('checkout');
        if (argv[0] === 'submodule' && argv[1] === 'sync') {
          events.push('submodule-sync');
        }
        if (argv[0] === 'submodule' && argv[1] === 'update') {
          events.push('submodule-update');
        }
        if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
          return { ok: true, status: 0, stdout: `${root}/.git\n`, stderr: '' };
        }
        return cleanRepoRunGit(argv, cwd);
      },
      checkLock: () => ({
        path: join(root, '.git/idd-claim.lock'),
        present: true,
        holder: {
          agentId: 'test-agent',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      }),
      removeLockIfMatches: () => true,
    });
    const verdict = runLocalWorktreeRecovery(
      baseArgs({
        apply: true,
        operatorConfirmedNoLiveSession: true,
        worktree: root,
      }),
      deps,
    );
    const uninitializedCopy = `copy:${join(
      preserveDir,
      `uninitialized-${Buffer.from('vendor').toString('base64url')}`,
    )}`;
    assert.equal(
      events.filter((event) => event === uninitializedCopy).length,
      2,
    );
    assert.deepEqual(events.slice(-4), [
      `remove:${submodulePath}`,
      'checkout',
      'submodule-sync',
      'submodule-update',
    ]);
    assert.equal(submodulePresent, false);
    assert.equal(verdict.plan.removal?.ran, true, JSON.stringify(verdict));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(preserveDir, { recursive: true, force: true });
  }
});

test('primary-worktree release only deletes a lock the fresh recheck positively observed', () => {
  let unlinkAttempted = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    cwd: () => '/repo/primary',
    checkLock: () => ({
      path: '/repo/primary/.git/idd-claim.lock',
      present: false,
    }),
    confirmBlock: (() => {
      let call = 0;
      return () => {
        call += 1;
        return {
          ok: true,
          routing: {
            state: 'local_worktree_occupied',
            reason: 'released-claim-local-worktree-occupied',
            active_claim: null,
            evidence: {
              released_claim: { claim_id: null, branch: 'issue/1-task' },
              local_worktree: {
                status: call <= 3 ? 'occupied' : 'absent',
                paths: call <= 3 ? ['/repo/primary'] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
    runGit: (argv) => {
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        unlinkAttempted = true;
        return {
          ok: true,
          status: 0,
          stdout: '/repo/primary/.git\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: '/repo/primary',
    }),
    deps,
  );
  assert.equal(verdict.primaryOrLinked, 'primary');
  assert.equal(verdict.plan.removal?.ran, true);
  assert.equal(
    unlinkAttempted,
    false,
    'must never attempt to resolve/delete a lock file the recheck found absent',
  );
});

test('primary-worktree release rechecks the complete status immediately before lock removal', () => {
  let lockRemoved = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    cwd: () => '/repo/primary',
    confirmBlock: (() => {
      let calls = 0;
      return () => {
        calls += 1;
        const occupied = calls <= 3;
        return {
          ok: true,
          routing: {
            state: occupied ? 'local_worktree_occupied' : 'stale',
            reason: occupied
              ? 'stale-claim-local-worktree-occupied'
              : 'active-claim-stale',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: occupied ? 'occupied' : 'absent',
                paths: occupied ? ['/repo/primary'] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
    runGit: (argv) => {
      if (argv[0] === 'status' && argv.includes('--untracked-files=all')) {
        return {
          ok: true,
          status: 0,
          stdout: ' M created-after-final-scan.txt\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
    removeLockIfMatches: () => {
      lockRemoved = true;
      return true;
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: '/repo/primary',
    }),
    deps,
  );
  assert.equal(lockRemoved, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /final primary-worktree status/);
});

test('primary-worktree release accepts a new-format claim after checkout', () => {
  // confirmBlock call sequence: 1 = step 1 (occupied, path included);
  // 2 = step 4's first recheck (still occupied, path included);
  // 3 = the immediate pre-checkout identity recheck (still occupied);
  // 4 = the post-checkout confirmAbsent check (new-format released claim,
  // absent path). The routing contract retains the released claim-id in
  // evidence after the active claim is gone. checkLock
  // call sequence: 1 = step 1; 2 = step 4's first recheck; 3 = immediate
  // pre-checkout identity recheck; 4 = the FINAL, post-checkout check, which
  // must see a lock created DURING the checkout window (simulating
  // another session racing in); 5 = the immediately-before-delete check; 6 =
  // the final ignored-file preservation check after those identity checks.
  // The post-checkout and immediately-before-delete checks must see the
  // current lock, not skip deletion based on a stale pre-checkout observation.
  let confirmCalls = 0;
  let checkLockCalls = 0;
  let unlinkAttempted = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    cwd: () => '/repo/primary',
    checkLock: () => {
      checkLockCalls += 1;
      // Calls 1-3 are step 1, step 4's first recheck, and the immediate
      // pre-checkout recheck. Call 4 is the FINAL, post-checkout check and
      // call 5 is the immediately-before-delete check; call 6 is the final
      // ignored-file preservation check. All six must observe the recovered
      // claim's lock before deletion is authorized.
      return {
        path: '/repo/primary/.git/idd-claim.lock',
        present: true,
        holder: {
          agentId: 'claude-a0b633a6',
          claimId: 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      };
    },
    removeLockIfMatches: () => {
      unlinkAttempted = true;
      return true;
    },
    confirmBlock: () => {
      confirmCalls += 1;
      return {
        ok: true,
        routing: {
          state: confirmCalls <= 3 ? 'local_worktree_occupied' : 'unclaimed',
          reason:
            confirmCalls <= 3
              ? 'released-claim-local-worktree-occupied'
              : 'no-active-claim',
          active_claim: null,
          evidence: {
            released_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            local_worktree: {
              status: confirmCalls <= 3 ? 'occupied' : 'absent',
              paths: confirmCalls <= 3 ? ['/repo/primary'] : [],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
    runGit: (argv) => {
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        unlinkAttempted = true;
        return {
          ok: true,
          status: 0,
          stdout: '/repo/primary/.git\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: '/repo/primary',
    }),
    deps,
  );
  assert.equal(checkLockCalls, 6);
  assert.equal(
    unlinkAttempted,
    true,
    'the post-checkout lock, not the earlier absent pre-checkout read, must drive the deletion attempt',
  );
  assert.equal(verdict.plan.removal?.ran, true);
});

test('primary-worktree release does not delete a lock replaced by another claim', () => {
  let checkLockCalls = 0;
  let unlinkAttempted = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    cwd: () => '/repo/primary',
    checkLock: () => {
      checkLockCalls += 1;
      return {
        path: '/repo/primary/.git/idd-claim.lock',
        present: true,
        holder: {
          agentId: 'someone-else',
          claimId: checkLockCalls === 3 ? 'claim-y' : 'claim-x',
          acquiredAt: '2026-09-27T00:00:00Z',
        },
      };
    },
    confirmBlock: (() => {
      let call = 0;
      return () => {
        call += 1;
        return {
          ok: true,
          routing: {
            state: call <= 3 ? 'local_worktree_occupied' : 'stale',
            reason:
              call <= 3
                ? 'stale-claim-local-worktree-occupied'
                : 'active-claim-stale',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: call <= 3 ? 'occupied' : 'absent',
                paths: call <= 3 ? ['/repo/primary'] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
    runGit: (argv) => {
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        unlinkAttempted = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: '/repo/primary',
    }),
    deps,
  );
  assert.equal(checkLockCalls, 3);
  assert.equal(unlinkAttempted, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /identity changed immediately before checkout/);
});

test('primary-worktree release stops when the recovered claim lock disappears at final check', () => {
  let checkLockCalls = 0;
  let unlinkAttempted = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    cwd: () => '/repo/primary',
    checkLock: () => {
      checkLockCalls += 1;
      return checkLockCalls < 4
        ? {
            path: '/repo/primary/.git/idd-claim.lock',
            present: true,
            holder: {
              agentId: 'agent-x',
              claimId: 'claim-x',
              acquiredAt: '2026-09-27T00:00:00Z',
            },
          }
        : {
            path: '/repo/primary/.git/idd-claim.lock',
            present: false,
          };
    },
    confirmBlock: (() => {
      let call = 0;
      return () => {
        call += 1;
        return {
          ok: true,
          routing: {
            state: call <= 3 ? 'local_worktree_occupied' : 'stale',
            reason:
              call <= 3
                ? 'stale-claim-local-worktree-occupied'
                : 'active-claim-stale',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              released_claim: { claim_id: null, branch: 'issue/1-task' },
              local_worktree: {
                status: call <= 3 ? 'occupied' : 'absent',
                paths: call <= 3 ? ['/repo/primary'] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
    runGit: (argv) => {
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        unlinkAttempted = true;
        return {
          ok: true,
          status: 0,
          stdout: '/repo/primary/.git\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: '/repo/primary',
    }),
    deps,
  );
  assert.equal(checkLockCalls, 4);
  assert.equal(unlinkAttempted, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /lock disappeared before the final check/);
});

test('primary legacy release refuses a non-legacy lock at the final check', () => {
  let checkLockCalls = 0;
  let unlinkAttempted = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    cwd: () => '/repo/primary',
    checkLock: () => {
      checkLockCalls += 1;
      return checkLockCalls < 4
        ? {
            path: '/repo/primary/.git/idd-claim.lock',
            present: false,
          }
        : {
            path: '/repo/primary/.git/idd-claim.lock',
            present: true,
            holder: {
              agentId: 'new-agent',
              claimId: 'new-claim',
              acquiredAt: '2026-09-27T00:01:00Z',
            },
          };
    },
    confirmBlock: (() => {
      let call = 0;
      return () => {
        call += 1;
        return {
          ok: true,
          routing: {
            state: 'local_worktree_occupied',
            reason: 'released-claim-local-worktree-occupied',
            active_claim: null,
            evidence: {
              released_claim: { claim_id: null, branch: 'issue/1-task' },
              local_worktree: {
                status: call <= 3 ? 'occupied' : 'absent',
                paths: call <= 3 ? ['/repo/primary'] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
    runGit: (argv) => {
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        unlinkAttempted = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: '/repo/primary',
    }),
    deps,
  );
  assert.equal(checkLockCalls, 4);
  assert.equal(unlinkAttempted, false);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /different claim-id/);
});

test('hard stash-push failure (not the verified unmerged-path case) blocks removal (Copilot review finding)', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return {
          ok: false,
          status: 1,
          stdout: '',
          stderr: 'fatal: Unable to create temp file: Permission denied',
        };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.hardStashFailure, true);
  assert.equal(verdict.plan.stashes[0]?.unmergedFallbackCopiedTo, null);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
});

test('a genuinely unmerged-path stash failure still takes the copy-out fallback', () => {
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: '?? conflict.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return {
          ok: false,
          status: 1,
          stdout: 'conflict.txt: needs merge\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.hardStashFailure, false);
  assert.equal(
    verdict.plan.stashes[0]?.unmergedFallbackCopiedTo !== null,
    true,
  );
});

test('a non-unmerged stash error mentioning an unmerged filename stays a hard failure', () => {
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: 'UU conflict.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return {
          ok: false,
          status: 1,
          stdout: '',
          stderr: 'fatal: cannot open unmerged.txt: Permission denied',
        };
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.hardStashFailure, true);
  assert.equal(verdict.plan.stashes[0]?.unmergedFallbackCopiedTo, null);
  assert.equal(verdict.mutated, false);
});

test('an unmerged index entry preserves its working-tree conflict file', () => {
  let copied: string | null = null;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: 'UU conflict.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return {
          ok: false,
          status: 1,
          stdout: 'conflict.txt: needs merge\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
    copyPath: (_from, to) => {
      copied = to;
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.notEqual(copied, null);
  assert.equal(verdict.plan.stashes[0]?.unmergedFallbackAllPreserved, true);
  assert.equal(verdict.plan.stashes[0]?.unmergedFallbackCopiedFiles.length, 1);
});

test('retains a partial unmerged fallback copy and blocks removal', () => {
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: 'UU conflict.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return {
          ok: false,
          status: 1,
          stdout: 'conflict.txt: needs merge\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv);
    },
    copyPath: () => {
      throw new Error('copy interrupted after partial write');
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(
    verdict.plan.stashes[0]?.unmergedFallbackCopiedTo,
    '/tmp/preserve/unmerged-Lg',
  );
  assert.deepEqual(verdict.plan.stashes[0]?.unmergedFallbackCopiedFiles, [
    '/tmp/preserve/unmerged-Lg/conflict.txt',
  ]);
  assert.equal(verdict.plan.stashes[0]?.unmergedFallbackAllPreserved, false);
  assert.equal(verdict.mutated, true);
  assert.equal(verdict.plan.removal, null);
  assert.match(verdict.result, /step 3 preservation/);
});

test('unmerged initialized-submodule fallback uses the parent worktree as symlink root', () => {
  const sourceRoots: Array<string | undefined> = [];
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? ' abc123def456abc123def456abc123def456abcd submodule (heads/main)\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status' && argv.includes('--porcelain=v1')) {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? ' M submodule\n'
              : cwd === '/repo/linked/submodule'
                ? '?? conflict.txt\n'
                : '',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'stash' &&
        argv[1] === 'push'
      ) {
        return {
          ok: false,
          status: 1,
          stdout: 'conflict.txt: needs merge\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (_from, _to, sourceRoot) => sourceRoots.push(sourceRoot),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(sourceRoots, ['/repo/linked']);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('an unmerged fallback refuses staged index contents it cannot copy', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: 'MM conflict.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return {
          ok: false,
          status: 1,
          stdout: 'conflict.txt: needs merge\n',
          stderr: '',
        };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.unmergedFallbackAllPreserved, false);
  assert.equal(verdict.plan.stashes[0]?.unmergedFallbackCopiedTo, null);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
});

test('copies an initialized submodule admin dir for pre-existing stashes or local-only refs', () => {
  const copied: string[] = [];
  let queriedAllSubmoduleRefs = false;
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            ' abc123def456abc123def456abc123def456abcd submodule (heads/main)\n',
          stderr: '',
        };
      }
      if (cwd === '/repo/linked/submodule' && argv[0] === 'for-each-ref') {
        queriedAllSubmoduleRefs = argv.includes('refs');
        return {
          ok: true,
          status: 0,
          stdout: 'refs/bisect/private-ref\n',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'stash' &&
        argv[1] === 'list'
      ) {
        return {
          ok: true,
          status: 0,
          stdout: 'stash@{0}: On main: pre-existing\n',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'rev-list' &&
        argv.includes('--not')
      ) {
        return { ok: true, status: 0, stdout: 'local-only-sha\n', stderr: '' };
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'rev-parse' &&
        argv.includes('--absolute-git-dir')
      ) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/linked/.git/modules/submodule\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (_from, to) => copied.push(to),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(
    verdict.plan.submoduleAdminCopies.length,
    1,
    'pre-existing submodule admin data must be copied before removal',
  );
  assert.equal(
    queriedAllSubmoduleRefs,
    true,
    'submodule preservation must inspect every disposable ref namespace',
  );
  assert.equal(verdict.plan.submoduleAdminCopies[0]?.path, 'submodule');
  assert.equal(verdict.plan.submoduleAdminCopies[0]?.copiedTo !== null, true);
  assert.equal(copied.length, 1);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('copies linked worktree admin data for top-level local refs', () => {
  const copied: Array<{ from: string; to: string }> = [];
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (cwd === '/repo/linked' && argv[0] === 'for-each-ref') {
        return {
          ok: true,
          status: 0,
          stdout: 'refs/worktree/private-ref\n',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked' &&
        argv[0] === 'rev-list' &&
        argv.includes('--not')
      ) {
        return { ok: true, status: 0, stdout: 'local-only-sha\n', stderr: '' };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (from, to) => copied.push({ from, to }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(verdict.plan.worktreeAdminCopy, {
    copiedTo: '/tmp/preserve/worktree-gitdir',
    plannedTo: '/tmp/preserve/worktree-gitdir',
  });
  assert.deepEqual(copied, [
    {
      from: '/repo/primary/.git/worktrees/linked',
      to: '/tmp/preserve/worktree-gitdir',
    },
  ]);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('retains a partial top-level worktree admin copy and blocks removal', () => {
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (cwd === '/repo/linked' && argv[0] === 'for-each-ref') {
        return {
          ok: true,
          status: 0,
          stdout: 'refs/worktree/private-ref\n',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked' &&
        argv[0] === 'rev-list' &&
        argv.includes('--not')
      ) {
        return { ok: true, status: 0, stdout: 'local-only-sha\n', stderr: '' };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: () => {
      throw new Error('copy interrupted');
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(verdict.plan.worktreeAdminCopy, {
    copiedTo: '/tmp/preserve/worktree-gitdir',
    plannedTo: '/tmp/preserve/worktree-gitdir',
  });
  assert.equal(verdict.mutated, true);
  assert.equal(verdict.plan.removal, null);
  assert.match(verdict.result, /preservation could not be fully verified/);
});

test('copies linked worktree admin data for top-level private bisect refs', () => {
  const copied: Array<{ from: string; to: string }> = [];
  let queriedBisectRefs = false;
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (cwd === '/repo/linked' && argv[0] === 'for-each-ref') {
        queriedBisectRefs = argv.includes('refs/bisect');
        return {
          ok: true,
          status: 0,
          stdout: 'refs/bisect/private-ref\n',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked' &&
        argv[0] === 'rev-list' &&
        argv.includes('--not')
      ) {
        return { ok: true, status: 0, stdout: 'local-only-sha\n', stderr: '' };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (from, to) => copied.push({ from, to }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(queriedBisectRefs, true);
  assert.notEqual(verdict.plan.worktreeAdminCopy, null);
  assert.deepEqual(copied, [
    {
      from: '/repo/primary/.git/worktrees/linked',
      to: '/tmp/preserve/worktree-gitdir',
    },
  ]);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('does not copy linked worktree admin data for shared refs alone', () => {
  let copied = false;
  let queriedWorktreeRefs = false;
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (cwd === '/repo/linked' && argv[0] === 'for-each-ref') {
        queriedWorktreeRefs = argv.includes('refs/worktree');
        return {
          ok: true,
          status: 0,
          stdout: '',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: () => {
      copied = true;
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(queriedWorktreeRefs, true);
  assert.equal(verdict.plan.worktreeAdminCopy, null);
  assert.equal(copied, false);
  assert.equal(verdict.plan.removal?.ran, true);
});

test('copies linked worktree admin data for an interrupted operation without local-only commits', () => {
  const copied: Array<{ from: string; to: string }> = [];
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (
        cwd === '/repo/linked' &&
        argv[0] === 'rev-parse' &&
        argv.includes('-q') &&
        argv.includes('MERGE_HEAD')
      ) {
        return { ok: true, status: 0, stdout: 'merge-head\n', stderr: '' };
      }
      if (cwd === '/repo/linked' && argv[0] === 'for-each-ref') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (from, to) => copied.push({ from, to }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.deepEqual(verdict.plan.worktreeAdminCopy, {
    copiedTo: '/tmp/preserve/worktree-gitdir',
    plannedTo: '/tmp/preserve/worktree-gitdir',
  });
  assert.deepEqual(copied, [
    {
      from: '/repo/primary/.git/worktrees/linked',
      to: '/tmp/preserve/worktree-gitdir',
    },
  ]);
});

test('dry-run plans an initialized submodule admin export without copying it', () => {
  const copied: string[] = [];
  const deps = fakeDeps({
    pathExists: (path) => path !== '/tmp/preserve',
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? ' abc123def456abc123def456abc123def456abcd submodule (heads/main)\n'
              : '',
          stderr: '',
        };
      }
      if (argv[0] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked/submodule'
              ? ' M changed.txt\n'
              : ' M submodule\n',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'rev-parse' &&
        argv.includes('--absolute-git-dir')
      ) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/linked/.git/modules/submodule\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (_from, to) => copied.push(to),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: false, preserveDir: '/tmp/preserve' }),
    deps,
  );
  assert.deepEqual(copied, []);
  assert.deepEqual(verdict.plan.submoduleAdminCopies, [
    {
      path: 'submodule',
      copiedTo: null,
      plannedTo: '/tmp/preserve/submodule-gitdir/c3VibW9kdWxl',
      copyFailed: false,
    },
  ]);
  assert.equal(verdict.plan.removal?.ran, false);
});

test('retains a partial initialized-submodule admin copy and blocks removal', () => {
  const copied: string[] = [];
  const deps = fakeDeps({
    runGit: (argv, cwd) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return {
          ok: true,
          status: 0,
          stdout:
            cwd === '/repo/linked'
              ? ' abc123def456abc123def456abc123def456abcd submodule (heads/main)\n'
              : '',
          stderr: '',
        };
      }
      if (cwd === '/repo/linked/submodule' && argv[0] === 'for-each-ref') {
        return {
          ok: true,
          status: 0,
          stdout: 'refs/tags/private-tag\n',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'stash' &&
        argv[1] === 'list'
      ) {
        return {
          ok: true,
          status: 0,
          stdout: 'stash@{0}: On main: pre-existing\n',
          stderr: '',
        };
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'rev-list' &&
        argv.includes('--not')
      ) {
        return { ok: true, status: 0, stdout: 'local-only-sha\n', stderr: '' };
      }
      if (
        cwd === '/repo/linked/submodule' &&
        argv[0] === 'rev-parse' &&
        argv.includes('--absolute-git-dir')
      ) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/linked/.git/modules/submodule\n',
          stderr: '',
        };
      }
      return cleanRepoRunGit(argv, cwd);
    },
    copyPath: (_from, to) => {
      copied.push(to);
      throw new Error('copy interrupted after partial write');
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  const entry = verdict.plan.submoduleAdminCopies[0];
  assert.equal(entry?.copiedTo, '/tmp/preserve/submodule-gitdir/c3VibW9kdWxl');
  assert.equal(entry?.copyFailed, true);
  assert.deepEqual(copied, ['/tmp/preserve/submodule-gitdir/c3VibW9kdWxl']);
  assert.equal(verdict.plan.removal, null);
  assert.equal(verdict.mutated, true);
});

test('a failed `git log @{u}..HEAD` (or HEAD) probe blocks removal instead of reading as no unpushed commits (Copilot/Codex review finding)', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'rev-parse' && argv[1] === '--abbrev-ref') {
        return { ok: true, status: 0, stdout: 'origin/main\n', stderr: '' };
      }
      if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') {
        return { ok: true, status: 0, stdout: 'headsha\n', stderr: '' };
      }
      if (argv[0] === 'log') {
        return {
          ok: false,
          status: 128,
          stdout: '',
          stderr: 'fatal: bad object',
        };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return cleanRepoRunGit(argv);
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.backupRefs[0]?.unpushedQueryFailed, true);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
});

test('a failed `git worktree list` stops before any mutation instead of reading as an empty list (Copilot review finding)', () => {
  const deps = fakeDeps({ listWorktreeRecords: () => null });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'worktree-list-failed');
  assert.equal(verdict.mutated, false);
});

test('an empty `git worktree list` stops before any mutation', () => {
  const deps = fakeDeps({ listWorktreeRecords: () => [] });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'worktree-list-failed');
  assert.equal(verdict.mutated, false);
});

// ---------------------------------------------------------------------------
// Real sandboxed git end-to-end tests -- spawns the compiled CLI so
// argument threading, the real `resume-claim-routing.mjs` composition, and
// real git stash/ref/removal semantics are all exercised together, mirroring
// tests/resume-claim-routing.test.mts's own `--worktree end-to-end` sandbox
// technique (a disposable standalone sandbox repo, `gh` stubbed via
// stubExecutable, spawning the real compiled CLI).
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'idd-test',
  GIT_AUTHOR_EMAIL: 'idd-test@example.com',
  GIT_COMMITTER_NAME: 'idd-test',
  GIT_COMMITTER_EMAIL: 'idd-test@example.com',
};

/** Stub `gh` so `resume-claim-routing.mjs` (spawned by the helper under
 * test) reports a stale `claimed-by claim-x` on `branch` for `issueNumber`,
 * without ever touching the network. Mirrors
 * `tests/resume-claim-routing.test.mts`'s own `trustedLadderFixture`. */
function stubGhForStaleClaim(options: {
  issueNumber: number;
  branch: string;
  claimId: string;
  createdAt: string;
}): () => void {
  const commentJson = JSON.stringify({
    id: 1,
    node_id: 'IC_1',
    body: `<!-- claimed-by: agent-x ${options.claimId} supersedes: none ${options.createdAt} branch: ${options.branch} -->`,
    created_at: options.createdAt,
    updated_at: options.createdAt,
    user: { login: 'maintainer' },
  });
  return stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
const commentJson = ${JSON.stringify(commentJson)};
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write('viewer-login\\n');
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(args.includes('owner') ? 'o\\n' : 'r\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql' && args.some((a) => /nodes\\(ids/.test(a))) {
  const ids = args.filter((a) => /^ids\\[\\]=/.test(a)).map((a) => a.slice('ids[]='.length));
  process.stdout.write(JSON.stringify({ data: { nodes: ids.map((id) => ({ id, lastEditedAt: null })) } }));
  process.exit(0);
}
if (args[0] === 'api' && args.some((a) => a.includes('/issues/${options.issueNumber}/comments'))) {
  process.stdout.write(commentJson + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args.some((a) => a.endsWith('/issues/${options.issueNumber}'))) {
  process.stdout.write(JSON.stringify({ number: ${options.issueNumber}, title: 'lwr sandbox', state: 'open', html_url: 'https://github.com/o/r/issues/${options.issueNumber}' }));
  process.exit(0);
}
process.stderr.write('unexpected gh call: ' + JSON.stringify(args) + '\\n');
process.exit(1);
`,
  );
}

interface Sandbox {
  root: string;
  primary: string;
  remote: string;
  linked: string;
  policyPath: string;
  cleanup: () => void;
}

/** Build a disposable sandbox: a bare `remote`, a `primary` clone on `main`,
 * and a `linked` worktree checked out on `branch` -- with an upstream set
 * for both, so "no upstream" never falsely marks every commit unpushed
 * (a real remote is required for the clean-worktree scenario to correctly
 * report zero unpushed commits). */
function buildSandbox(branch: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-sandbox-'));
  const primary = join(root, 'primary');
  const remote = join(root, 'remote.git');
  const linked = join(root, 'linked');
  mkdirSync(primary, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '--quiet', '-b', 'main'], {
    cwd: primary,
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'root',
    ],
    { cwd: primary, stdio: 'ignore', env: GIT_ENV },
  );
  execFileSync('git', ['remote', 'add', 'origin', remote], {
    cwd: primary,
    stdio: 'ignore',
  });
  execFileSync('git', ['push', '--quiet', '-u', 'origin', 'main'], {
    cwd: primary,
    stdio: 'ignore',
    env: GIT_ENV,
  });
  execFileSync('git', ['worktree', 'add', '-b', branch, linked], {
    cwd: primary,
    stdio: 'ignore',
  });
  execFileSync('git', ['push', '--quiet', '-u', 'origin', branch], {
    cwd: linked,
    stdio: 'ignore',
    env: GIT_ENV,
  });
  const policyPath = join(root, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({ trustedMarkerActors: ['maintainer'] }),
  );
  return {
    root,
    primary,
    remote,
    linked,
    policyPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(
  sandbox: Sandbox,
  issueNumber: number,
  extraArgs: string[],
): SpawnSyncReturns<string> {
  execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/claim-lock.mjs'),
      '--acquire',
      '--worktree',
      sandbox.linked,
      '--agent-id',
      'agent-x',
      '--claim-id',
      `claim-${issueNumber}`,
    ],
    { cwd: sandbox.primary, encoding: 'utf8' },
  );
  recordGeneratedClaimTokens(sandbox.linked, {
    agentId: 'agent-x',
    claimId: `claim-${issueNumber}`,
    nonce: `nonce-${issueNumber}`,
  });
  return spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/local-worktree-recovery.mjs'),
      '--issue',
      String(issueNumber),
      '--worktree',
      sandbox.linked,
      '--owner',
      'o',
      '--repo',
      'r',
      '--policy',
      sandbox.policyPath,
      ...(extraArgs.includes('--apply')
        ? []
        : ['--now', '2026-09-25T01:00:00Z']),
      ...extraArgs,
    ],
    {
      cwd: sandbox.primary,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: GIT_ENV.GIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: GIT_ENV.GIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: GIT_ENV.GIT_COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: GIT_ENV.GIT_COMMITTER_EMAIL,
      },
    },
  );
}

test('sandbox: clean worktree, no changes -- no stash, no backup ref, removal proceeds under --apply', () => {
  const sandbox = buildSandbox('issue/101-task');
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 101,
    branch: 'issue/101-task',
    claimId: 'claim-101',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 101, [
      '--apply',
      '--operator-confirmed-no-live-session',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.step1.outcome, 'blocked-stale');
    assert.equal(output.plan.stashes[0].hasChanges, false);
    assert.equal(output.plan.stashes[0].stashed, false);
    assert.equal(output.plan.backupRefs[0].hasUnpushed, false);
    assert.equal(output.plan.backupRefs[0].written, false);
    assert.equal(output.plan.removal.ran, true);
    assert.equal(output.mutated, true);
    const worktreeList = execFileSync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: sandbox.primary, encoding: 'utf8' },
    );
    assert.ok(!worktreeList.includes(sandbox.linked));
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});

test('sandbox: uncommitted tracked + untracked changes -- stashed with the idd-lwr <claim-id> tag', () => {
  const sandbox = buildSandbox('issue/102-task');
  writeFileSync(join(sandbox.linked, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: sandbox.linked });
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'tracked baseline',
    ],
    { cwd: sandbox.linked, env: GIT_ENV },
  );
  execFileSync('git', ['push', '--quiet'], {
    cwd: sandbox.linked,
    env: GIT_ENV,
  });
  writeFileSync(join(sandbox.linked, 'tracked.txt'), 'modified\n');
  writeFileSync(join(sandbox.linked, 'untracked.txt'), 'new\n');
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 102,
    branch: 'issue/102-task',
    claimId: 'claim-102',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 102, [
      '--apply',
      '--operator-confirmed-no-live-session',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.plan.stashes[0].hasChanges, true);
    assert.equal(output.plan.stashes[0].stashed, true);
    assert.equal(output.plan.stashes[0].tag, 'idd-lwr claim-102');
    assert.equal(
      output.plan.stashes[0].verifiedCount,
      output.plan.stashes[0].baselineCount + 1,
    );
    const stashList = execFileSync('git', ['stash', 'list'], {
      cwd: sandbox.primary,
      encoding: 'utf8',
    });
    assert.match(stashList, /idd-lwr claim-102/);
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});

test('sandbox: unpushed commits -- refs/idd-lwr/<branch> resolves to the recorded tip', () => {
  const sandbox = buildSandbox('issue/103-task');
  writeFileSync(join(sandbox.linked, 'unpushed.txt'), 'x\n');
  execFileSync('git', ['add', 'unpushed.txt'], { cwd: sandbox.linked });
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'unpushed change',
    ],
    { cwd: sandbox.linked, env: GIT_ENV },
  );
  const tipSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sandbox.linked,
    encoding: 'utf8',
  }).trim();
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 103,
    branch: 'issue/103-task',
    claimId: 'claim-103',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 103, [
      '--apply',
      '--operator-confirmed-no-live-session',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.plan.backupRefs[0].hasUnpushed, true);
    assert.equal(output.plan.backupRefs[0].tipSha, tipSha);
    assert.equal(output.plan.backupRefs[0].written, true);
    assert.equal(output.plan.backupRefs[0].verifiedOid, tipSha);
    const resolved = execFileSync(
      'git',
      ['rev-parse', 'refs/idd-lwr/issue/103-task'],
      { cwd: sandbox.primary, encoding: 'utf8' },
    ).trim();
    assert.equal(resolved, tipSha);
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});

test('sandbox: refusal without --operator-confirmed-no-live-session never mutates', () => {
  const sandbox = buildSandbox('issue/104-task');
  writeFileSync(join(sandbox.linked, 'untracked.txt'), 'new\n');
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 104,
    branch: 'issue/104-task',
    claimId: 'claim-104',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 104, ['--apply']);
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mutated, false);
    assert.match(output.result, /operator-confirmed-no-live-session/);
    const worktreeList = execFileSync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: sandbox.primary, encoding: 'utf8' },
    );
    assert.ok(worktreeList.includes(sandbox.linked));
    const stashList = execFileSync('git', ['stash', 'list'], {
      cwd: sandbox.linked,
      encoding: 'utf8',
    });
    assert.equal(stashList.trim(), '');
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});

test('sandbox: default (no --apply) never mutates even with the operator flag', () => {
  const sandbox = buildSandbox('issue/105-task');
  writeFileSync(join(sandbox.linked, 'untracked.txt'), 'new\n');
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 105,
    branch: 'issue/105-task',
    claimId: 'claim-105',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 105, [
      '--operator-confirmed-no-live-session',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, 'dry-run');
    assert.equal(output.mutated, false);
    assert.equal(output.plan.stashes[0].hasChanges, true);
    assert.equal(output.plan.stashes[0].stashed, false);
    const worktreeList = execFileSync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: sandbox.primary, encoding: 'utf8' },
    );
    assert.ok(worktreeList.includes(sandbox.linked));
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});
