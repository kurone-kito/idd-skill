#!/usr/bin/env node
// idd-generated-from: src/scripts/local-worktree-occupancy.mts
//
// The scripts/local-worktree-occupancy.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
/** Parse the NUL-delimited porcelain worktree listing without name greps. */
export function parseLocalWorktreeList(output) {
  const records = [];
  for (const stanza of output.split('\0\0')) {
    const lines = stanza.split('\0').filter((line) => line.length > 0);
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    if (!worktreeLine) {
      continue;
    }
    let branchRef = null;
    let detached = false;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith('branch ')) {
        branchRef = line.slice('branch '.length).trim();
      } else if (line === 'detached') {
        detached = true;
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        prunable = true;
      }
    }
    records.push({
      path: worktreeLine.slice('worktree '.length),
      branchRef,
      detached,
      prunable,
    });
  }
  return records;
}
function branchNameFromRef(ref) {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}
function isAbsoluteGitPath(value) {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}
function joinGitPath(worktreePath, relative) {
  if (isAbsoluteGitPath(relative)) {
    return relative;
  }
  return `${worktreePath.replace(/[\\/]+$/, '')}/${relative}`;
}
function sanitizedGitEnvironment(environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG')) {
      delete env[key];
    }
  }
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}
function readGitPath(worktreePath, name, env) {
  try {
    return execFileSync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--git-path', name],
      {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    return null;
  }
}
function resolveDetachedBranch(worktreePath, env) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const gitPath = readGitPath(worktreePath, name, env);
    if (!gitPath) {
      return { branchName: null, unreadable: true };
    }
    const sequencerPath = joinGitPath(worktreePath, gitPath);
    if (!existsSync(sequencerPath)) {
      continue;
    }
    try {
      const headName = readFileSync(
        `${sequencerPath}/head-name`,
        'utf8',
      ).trim();
      if (headName) {
        return {
          branchName: branchNameFromRef(headName),
          unreadable: false,
        };
      }
    } catch {
      return { branchName: null, unreadable: true };
    }
  }
  return { branchName: null, unreadable: false };
}
function inspectWorktreePath(worktreePath) {
  try {
    statSync(worktreePath);
    return 'present';
  } catch (error) {
    const code = error.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
  }
}
/**
 * Inspect one branch in the current clone. A prunable record is stale git
 * metadata only when its path is absent; a present or unreadable path fails
 * closed. Every other matching record blocks a stale claim takeover,
 * including a clean worktree. Listing failures are unreadable and therefore
 * fail closed at the claim/discover callers.
 */
export function inspectLocalWorktreeBranch(
  branchName,
  cwd = process.cwd(),
  environment = process.env,
) {
  const env = sanitizedGitEnvironment(environment);
  let output;
  try {
    output = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'unreadable', paths: [], reason: detail };
  }
  const records = parseLocalWorktreeList(output);
  if (records.length === 0) {
    return {
      status: 'unreadable',
      paths: [],
      reason: 'git worktree list returned no parseable records',
    };
  }
  const matches = [];
  const unreadablePaths = [];
  for (const record of records) {
    if (record.prunable) {
      if (inspectWorktreePath(record.path) !== 'absent') {
        unreadablePaths.push(record.path);
      }
      continue;
    }
    let resolvedBranch = record.branchRef
      ? branchNameFromRef(record.branchRef)
      : null;
    if (!resolvedBranch && record.detached) {
      const detached = resolveDetachedBranch(record.path, env);
      if (detached.unreadable) {
        unreadablePaths.push(record.path);
        continue;
      }
      resolvedBranch = detached.branchName;
    }
    if (resolvedBranch === branchName) {
      matches.push(record);
    }
  }
  if (unreadablePaths.length > 0) {
    return {
      status: 'unreadable',
      paths: unreadablePaths,
      reason: 'cannot inspect detached worktree rebase metadata',
    };
  }
  if (matches.length === 0) {
    return { status: 'absent', paths: [], reason: null };
  }
  return {
    status: 'occupied',
    paths: matches.map((record) => record.path),
    reason: `matching local worktree for ${branchName}`,
  };
}
