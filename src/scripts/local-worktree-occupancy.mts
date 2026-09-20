#!/usr/bin/env node

// idd-generated-from: src/scripts/local-worktree-occupancy.mts
//
// The scripts/local-worktree-occupancy.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join as joinPath } from 'node:path';

/** The local occupancy result used by claim and Discover gates. */
export interface LocalWorktreeInspection {
  status: 'absent' | 'occupied' | 'unreadable';
  paths: string[];
  reason: string | null;
}

/** The branch-bearing fields needed from one porcelain worktree record. */
export interface LocalWorktreeRecord {
  path: string;
  branchRef: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

function malformedWorktreeList(reason: string): never {
  throw new Error(`malformed git worktree list: ${reason}`);
}

/** Parse the NUL-delimited porcelain worktree listing without name greps. */
export function parseLocalWorktreeList(output: string): LocalWorktreeRecord[] {
  if (output.length > 0 && !output.endsWith('\0\0')) {
    malformedWorktreeList('listing is not record-terminated');
  }
  const records: LocalWorktreeRecord[] = [];
  for (const stanza of output.split('\0\0')) {
    if (!stanza) {
      continue;
    }
    const lines = stanza.split('\0').filter((line) => line.length > 0);
    const worktreeLines = lines.filter((line) => line.startsWith('worktree '));
    const headLines = lines.filter((line) => line.startsWith('HEAD '));
    const branchLines = lines.filter((line) => line.startsWith('branch '));
    const detachedCount = lines.filter((line) => line === 'detached').length;
    const bareCount = lines.filter((line) => line === 'bare').length;
    const lockedLines = lines.filter(
      (line) => line === 'locked' || line.startsWith('locked '),
    );
    const bare = bareCount === 1;
    if (worktreeLines.length !== 1 || !worktreeLines[0].slice(9)) {
      malformedWorktreeList('record has no unique worktree path');
    }
    if (headLines.length > 1) {
      malformedWorktreeList('record repeats HEAD');
    }
    if (!bare && (headLines.length !== 1 || !headLines[0].slice(5).trim())) {
      malformedWorktreeList('record has no unique HEAD');
    }
    if (
      branchLines.length > 1 ||
      detachedCount > 1 ||
      bareCount > 1 ||
      lockedLines.length > 1
    ) {
      malformedWorktreeList('record repeats branch state');
    }
    const stateCount = branchLines.length + detachedCount + bareCount;
    if (stateCount !== 1) {
      malformedWorktreeList('record has no unique branch state');
    }
    const knownLine = (line: string): boolean =>
      line.startsWith('worktree ') ||
      line.startsWith('HEAD ') ||
      line.startsWith('branch ') ||
      line === 'detached' ||
      line === 'bare' ||
      line === 'locked' ||
      line.startsWith('locked ') ||
      line === 'prunable' ||
      line.startsWith('prunable ');
    if (lines.some((line) => !knownLine(line))) {
      malformedWorktreeList('record contains an unknown field');
    }
    const worktreeLine = worktreeLines[0];
    let branchRef: string | null = null;
    let detached = false;
    let locked = false;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith('branch ')) {
        branchRef = line.slice('branch '.length);
        if (!branchRef) {
          malformedWorktreeList('record has an empty branch ref');
        }
      } else if (line === 'detached') {
        detached = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        locked = true;
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        prunable = true;
      }
    }
    records.push({
      path: worktreeLine.slice('worktree '.length),
      branchRef,
      detached,
      bare,
      locked,
      prunable,
    });
  }
  return records;
}

function branchNameFromRef(ref: string): string | null {
  const value = ref;
  if (!value) {
    return null;
  }
  if (value.startsWith('refs/') && !value.startsWith('refs/heads/')) {
    return null;
  }
  const fullBranchRef = value.startsWith('refs/heads/');
  const branch = fullBranchRef ? value.slice('refs/heads/'.length) : value;
  const hasForbiddenCharacter = [...branch].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      (codePoint !== undefined && codePoint <= 0x20) ||
      codePoint === 0x7f ||
      '~^:?*[\\'.includes(character)
    );
  });
  if (
    !branch ||
    (!fullBranchRef && (branch === '@' || branch.startsWith('-'))) ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    hasForbiddenCharacter ||
    branch
      .split('/')
      .some(
        (part) => part === '' || part.startsWith('.') || part.endsWith('.lock'),
      )
  ) {
    return null;
  }
  return branch;
}

function removeTrailingLineEnding(value: string): string {
  if (!value.endsWith('\n')) {
    return value;
  }
  const withoutLf = value.slice(0, -1);
  return withoutLf.endsWith('\r') ? withoutLf.slice(0, -1) : withoutLf;
}

/** Strip Git's LF terminator without removing a valid POSIX path character. */
function removeTrailingGitLineFeed(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function hasLocalBranchRef(
  worktreePath: string,
  branchName: string,
  env: NodeJS.ProcessEnv,
  execute: typeof execFileSync,
): boolean {
  try {
    const resolved = execute(
      'git',
      [
        '-C',
        worktreePath,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branchName}`,
      ],
      {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return Boolean(String(resolved).trim());
  } catch {
    return false;
  }
}

function isAbsoluteGitPath(value: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

function joinGitPath(worktreePath: string, relative: string): string {
  if (isAbsoluteGitPath(relative)) {
    return relative;
  }
  return joinPath(worktreePath, relative);
}

function sanitizedGitEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
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

function readGitPath(
  worktreePath: string,
  name: string,
  env: NodeJS.ProcessEnv,
  execute: typeof execFileSync,
): string | null {
  try {
    return removeTrailingGitLineFeed(
      execute('git', ['-C', worktreePath, 'rev-parse', '--git-path', name], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch {
    return null;
  }
}

function readRegularMetadataFile(
  path: string,
  normalize: (value: string) => string,
): string | null {
  try {
    if (!lstatSync(path).isFile()) {
      return null;
    }
    return normalize(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isCanonicalWorktreeRoot(
  worktreePath: string,
  env: NodeJS.ProcessEnv,
  execute: typeof execFileSync,
): boolean {
  let expectedRoot: string;
  try {
    expectedRoot = realpathSync(worktreePath);
  } catch {
    return false;
  }
  try {
    const discoveredRoot = removeTrailingGitLineFeed(
      execute('git', ['-C', worktreePath, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    return (
      Boolean(discoveredRoot) && realpathSync(discoveredRoot) === expectedRoot
    );
  } catch {
    return false;
  }
}

interface DetachedBranchResolution {
  branchName: string | null;
  unreadable: boolean;
}

function resolveDetachedBranch(
  worktreePath: string,
  env: NodeJS.ProcessEnv,
  execute: typeof execFileSync,
): DetachedBranchResolution {
  // `git -C` may discover an enclosing repository when the recorded
  // worktree's own metadata is missing or malformed. Refuse to read rebase or
  // bisect state until Git proves that the discovered root is this worktree.
  if (!isCanonicalWorktreeRoot(worktreePath, env, execute)) {
    return { branchName: null, unreadable: true };
  }
  let sequencerPath: string | null = null;
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const gitPath = readGitPath(worktreePath, name, env, execute);
    if (!gitPath) {
      return { branchName: null, unreadable: true };
    }
    const candidatePath = joinGitPath(worktreePath, gitPath);
    const sequencerStatus = inspectWorktreePath(candidatePath);
    if (sequencerStatus === 'absent') {
      continue;
    }
    if (sequencerStatus === 'unreadable') {
      return { branchName: null, unreadable: true };
    }
    if (sequencerPath !== null) {
      return { branchName: null, unreadable: true };
    }
    sequencerPath = candidatePath;
  }
  const bisectPath = readGitPath(worktreePath, 'BISECT_START', env, execute);
  if (!bisectPath) {
    return { branchName: null, unreadable: true };
  }
  const bisectStartPath = joinGitPath(worktreePath, bisectPath);
  const bisectStatus = inspectWorktreePath(bisectStartPath);
  if (bisectStatus === 'unreadable') {
    return { branchName: null, unreadable: true };
  }
  if (bisectStatus === 'present') {
    if (sequencerPath !== null) {
      return { branchName: null, unreadable: true };
    }
    const bisectBranch = readRegularMetadataFile(
      bisectStartPath,
      removeTrailingLineEnding,
    );
    if (!bisectBranch) {
      return { branchName: null, unreadable: true };
    }
    const branchName = branchNameFromRef(bisectBranch);
    if (!branchName) {
      return { branchName: null, unreadable: true };
    }
    if (
      /^[0-9a-f]{4,64}$/i.test(branchName) &&
      !hasLocalBranchRef(worktreePath, branchName, env, execute)
    ) {
      return { branchName: null, unreadable: true };
    }
    return {
      branchName,
      unreadable: false,
    };
  }
  if (sequencerPath !== null) {
    const headName = readRegularMetadataFile(
      joinPath(sequencerPath, 'head-name'),
      removeTrailingLineEnding,
    );
    if (!headName) {
      return { branchName: null, unreadable: true };
    }
    const branchName = branchNameFromRef(headName);
    if (!branchName) {
      return { branchName: null, unreadable: true };
    }
    return {
      branchName,
      unreadable: false,
    };
  }
  // A detached worktree with no recoverable branch metadata is unknown, not
  // proven unrelated. Fail closed so stale-claim takeover cannot proceed.
  return { branchName: null, unreadable: true };
}

function inspectWorktreePath(
  worktreePath: string,
): 'present' | 'absent' | 'unreadable' {
  try {
    const entry = lstatSync(worktreePath);
    return entry.isSymbolicLink() ? 'unreadable' : 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
  }
}

/**
 * Inspect one branch in the current clone. A prunable record is stale git
 * metadata only when its path is absent, its branch metadata is valid and
 * proven unrelated, and it is not locked; a target, malformed, unknown,
 * locked, present, or unreadable record fails closed. Every other matching
 * record blocks a stale claim takeover, including a clean worktree. Listing
 * failures are unreadable and therefore fail closed at the claim/discover
 * callers.
 */
export function inspectLocalWorktreeBranch(
  branchName: string,
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
  execute: typeof execFileSync = execFileSync,
): LocalWorktreeInspection {
  const requestedBranch = branchNameFromRef(branchName);
  if (!requestedBranch) {
    return {
      status: 'unreadable',
      paths: [],
      reason: `invalid branch name: ${branchName}`,
    };
  }
  const env = sanitizedGitEnvironment(environment);
  let output: string;
  try {
    output = execute('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'unreadable', paths: [], reason: detail };
  }

  let records: LocalWorktreeRecord[];
  try {
    records = parseLocalWorktreeList(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'unreadable', paths: [], reason: detail };
  }
  if (records.length === 0) {
    return {
      status: 'unreadable',
      paths: [],
      reason: 'git worktree list returned no parseable records',
    };
  }

  const matches: LocalWorktreeRecord[] = [];
  const unreadablePaths: string[] = [];
  for (const record of records) {
    if (record.bare) {
      if (record.prunable) {
        unreadablePaths.push(record.path);
      }
      continue;
    }
    if (record.prunable) {
      const parsedBranchRef = record.branchRef
        ? branchNameFromRef(record.branchRef)
        : null;
      if (record.branchRef && !parsedBranchRef) {
        unreadablePaths.push(record.path);
        continue;
      }
      let prunableBranch = parsedBranchRef;
      const pathStatus = inspectWorktreePath(record.path);
      if (!prunableBranch && record.detached && pathStatus !== 'present') {
        unreadablePaths.push(record.path);
        continue;
      }
      if (!prunableBranch && record.detached) {
        const detached = resolveDetachedBranch(record.path, env, execute);
        if (detached.unreadable) {
          unreadablePaths.push(record.path);
          continue;
        }
        prunableBranch = detached.branchName;
      }
      if (pathStatus === 'absent') {
        if (
          record.locked ||
          prunableBranch === null ||
          prunableBranch === requestedBranch
        ) {
          unreadablePaths.push(record.path);
        }
        continue;
      }
      if (prunableBranch !== requestedBranch) {
        continue;
      }
      unreadablePaths.push(record.path);
      continue;
    }
    const parsedBranchRef = record.branchRef
      ? branchNameFromRef(record.branchRef)
      : null;
    if (record.branchRef && !parsedBranchRef) {
      unreadablePaths.push(record.path);
      continue;
    }
    let resolvedBranch = parsedBranchRef;
    if (!resolvedBranch && record.detached) {
      const detached = resolveDetachedBranch(record.path, env, execute);
      if (detached.unreadable) {
        unreadablePaths.push(record.path);
        continue;
      }
      resolvedBranch = detached.branchName;
    }
    if (resolvedBranch === requestedBranch) {
      matches.push(record);
    }
  }
  if (unreadablePaths.length > 0) {
    return {
      status: 'unreadable',
      paths: unreadablePaths,
      reason: 'cannot inspect matching local worktree metadata',
    };
  }
  if (matches.length === 0) {
    return { status: 'absent', paths: [], reason: null };
  }
  return {
    status: 'occupied',
    paths: matches.map((record) => record.path),
    reason: `matching local worktree for ${requestedBranch}`,
  };
}
