#!/usr/bin/env node
// idd-generated-from: src/scripts/branch-conflict-state.mts
//
// The scripts/branch-conflict-state.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync, spawnSync } from 'node:child_process';

interface PrData {
  headRefOid?: unknown;
  baseRefOid?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
}

interface BranchStateDerivation {
  branchState: string;
  syncRecommendation: string;
  conflictFiles: string[];
  mergeableSource: string;
}

interface BranchConflictResult {
  protocolVersion: string;
  prNumber: number;
  prHeadSha: string;
  prBaseSha: string;
  published: boolean;
  mergeable: string | null;
  mergeStateStatus: string | null;
  branchState: string;
  syncRecommendation: string;
  readOnly: boolean;
  worktreeUnchanged: boolean;
  diagnostics: {
    mergeableSource: string;
    conflictFiles: string[];
    notes: string[];
  };
}

interface ClassifyOptions {
  owner?: string;
  repo?: string;
  _testPrData?: PrData;
  _skipGitProbe?: boolean;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }

  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);

  const result = await classifyBranchConflictState(args.prNumber, {
    owner,
    repo,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function classifyBranchConflictState(
  prNumber: unknown,
  options: ClassifyOptions = {},
): Promise<BranchConflictResult> {
  const { owner, repo, _testPrData, _skipGitProbe } = options;
  const notes: string[] = [];

  const prData: PrData = _testPrData ?? fetchPrData(owner, repo, prNumber);
  const prHeadSha = String(prData.headRefOid ?? '');
  const prBaseSha = String(prData.baseRefOid ?? '');
  const prHeadRef = String(prData.headRefName ?? '');
  const prBaseRef = String(prData.baseRefName ?? '');
  const mergeable = prData.mergeable ?? null;
  const mergeStateStatus = prData.mergeStateStatus ?? null;
  const published = Boolean(prHeadSha);

  if (!prHeadSha || !prBaseSha) {
    return {
      protocolVersion: '1',
      prNumber: Number(prNumber),
      prHeadSha: prHeadSha || '',
      prBaseSha: prBaseSha || '',
      published,
      mergeable: null,
      mergeStateStatus: null,
      branchState: 'unknown',
      syncRecommendation: 'hold-unknown',
      readOnly: true,
      worktreeUnchanged: true,
      diagnostics: {
        mergeableSource: 'none',
        conflictFiles: [],
        notes: [
          'PR head or base SHA unavailable; cannot classify branch state.',
        ],
      },
    };
  }

  const { branchState, syncRecommendation, conflictFiles, mergeableSource } =
    deriveBranchState({
      prHeadSha,
      prBaseSha,
      prHeadRef,
      prBaseRef,
      mergeable,
      mergeStateStatus,
      notes,
      owner,
      repo,
      skipGitProbe: Boolean(_skipGitProbe),
    });

  return {
    protocolVersion: '1',
    prNumber: Number(prNumber),
    prHeadSha,
    prBaseSha,
    published,
    mergeable: normalizeNullable(mergeable),
    mergeStateStatus: normalizeNullable(mergeStateStatus),
    branchState,
    syncRecommendation,
    readOnly: true,
    worktreeUnchanged: true,
    diagnostics: {
      mergeableSource,
      conflictFiles,
      notes,
    },
  };
}

function deriveBranchState({
  prHeadSha,
  prBaseSha,
  prBaseRef,
  mergeable,
  mergeStateStatus,
  notes,
  owner,
  repo,
  skipGitProbe,
}: {
  prHeadSha: string;
  prBaseSha: string;
  prHeadRef?: string;
  prBaseRef: string;
  mergeable: unknown;
  mergeStateStatus: unknown;
  notes: string[];
  owner: string | undefined;
  repo: string | undefined;
  skipGitProbe: boolean;
}): BranchStateDerivation {
  const mergeableNorm = String(mergeable ?? '').toUpperCase();
  const mergeStateNorm = String(mergeStateStatus ?? '').toUpperCase();

  if (mergeableNorm === 'CONFLICTING') {
    const probeResult = skipGitProbe
      ? []
      : probeConflictFilesReadOnly(
          prHeadSha,
          prBaseSha,
          prBaseRef,
          owner,
          repo,
          notes,
        );
    return {
      branchState: 'content-conflict',
      syncRecommendation: 'hold-unknown',
      conflictFiles: probeResult ?? [],
      mergeableSource: 'github-mergeable',
    };
  }

  if (mergeStateNorm === 'DIRTY') {
    return {
      branchState: 'dirty',
      syncRecommendation: 'hold-unknown',
      conflictFiles: [],
      mergeableSource: 'github-merge-state',
    };
  }

  if (mergeableNorm === 'MERGEABLE' && mergeStateNorm === 'CLEAN') {
    return {
      branchState: 'clean',
      syncRecommendation: 'none',
      conflictFiles: [],
      mergeableSource: 'github-mergeable',
    };
  }

  if (mergeStateNorm === 'BEHIND') {
    if (skipGitProbe) {
      return {
        branchState: 'behind-no-conflict',
        syncRecommendation: 'merge-main',
        conflictFiles: [],
        mergeableSource: 'github-merge-state',
      };
    }
    const probeResult = probeConflictFilesReadOnly(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      owner,
      repo,
      notes,
    );
    if (probeResult === null) {
      return {
        branchState: 'unknown',
        syncRecommendation: 'hold-unknown',
        conflictFiles: [],
        mergeableSource: 'git-merge-tree',
      };
    }
    if (probeResult.length > 0) {
      return {
        branchState: 'content-conflict',
        syncRecommendation: 'hold-unknown',
        conflictFiles: probeResult,
        mergeableSource: 'git-merge-tree',
      };
    }
    return {
      branchState: 'behind-no-conflict',
      syncRecommendation: 'merge-main',
      conflictFiles: [],
      mergeableSource: 'git-merge-tree',
    };
  }

  if (mergeableNorm === 'MERGEABLE') {
    return {
      branchState: 'clean',
      syncRecommendation: 'none',
      conflictFiles: [],
      mergeableSource: 'github-mergeable',
    };
  }

  if (mergeableNorm === 'UNKNOWN' || !mergeableNorm) {
    notes.push(
      `Mergeable status is ${mergeable ?? 'null'}; unable to classify definitively.`,
    );
    return {
      branchState: 'unknown',
      syncRecommendation: 'hold-unknown',
      conflictFiles: [],
      mergeableSource: 'none',
    };
  }

  notes.push(
    `Unrecognized mergeable=${mergeable} / mergeStateStatus=${mergeStateStatus}.`,
  );
  return {
    branchState: 'unknown',
    syncRecommendation: 'hold-unknown',
    conflictFiles: [],
    mergeableSource: 'none',
  };
}

function probeConflictFilesReadOnly(
  prHeadSha: string,
  prBaseSha: string,
  prBaseRef: string,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
): string[] | null {
  try {
    let mergeBase = gitText(['merge-base', prHeadSha, prBaseSha]);
    if (!mergeBase) {
      tryFetchBase(prBaseRef, owner, repo, notes);
      mergeBase = gitText(['merge-base', prHeadSha, prBaseSha]);
      if (!mergeBase) {
        notes.push(
          'merge-base not found; cannot prove conflict-free; holding unknown.',
        );
        return null;
      }
    }
    const result = spawnSync(
      'git',
      ['merge-tree', `--merge-base=${mergeBase}`, prHeadSha, prBaseSha],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (result.status !== 0 && result.status !== 1) {
      notes.push(
        `git merge-tree exited with status ${result.status}; cannot probe conflicts.`,
      );
      return null;
    }
    const conflictFiles = parseConflictFiles(result.stdout ?? '');
    if (result.status === 1 && conflictFiles.length === 0) {
      notes.push(
        'git merge-tree exited 1 but no conflict files were parsed; treating as unknown.',
      );
      return null;
    }
    return conflictFiles;
  } catch {
    notes.push(
      'git merge-tree unavailable; falling back to GitHub mergeability signal only.',
    );
    return null;
  }
}

function tryFetchBase(
  prBaseRef: string,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
): void {
  if (!prBaseRef) return;
  try {
    const remote = `https://github.com/${owner}/${repo}.git`;
    execFileSync(
      'git',
      ['fetch', '--no-tags', '--depth=1', remote, prBaseRef],
      {
        stdio: 'ignore',
        encoding: 'utf8',
      },
    );
  } catch {
    notes.push(
      `Could not fetch base ref ${prBaseRef}; merge-base probe may be incomplete.`,
    );
  }
}

export function parseConflictFiles(mergeTreeOutput: string): string[] {
  const files = new Set<string>();
  for (const line of mergeTreeOutput.split('\n')) {
    // "CONFLICT (content): Merge conflict in path/to/file"
    // "CONFLICT (add/add): Merge conflict in path/to/file"
    // Any conflict type whose message ends with "Merge conflict in <path>"
    const mergeConflictMatch = line.match(
      /^CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(.+?)\s*$/i,
    );
    if (mergeConflictMatch) {
      files.add(mergeConflictMatch[1].trim());
      continue;
    }
    // "CONFLICT (modify/delete): <path> deleted in ... and modified in ..."
    // "CONFLICT (rename/delete): <old> renamed to <new> in ..."
    // "CONFLICT (rename/rename): <path> renamed to <a> in X and to <b> in Y"
    // First token after "TYPE): " is the conflicted original path
    const firstTokenMatch = line.match(
      /^CONFLICT\s+\([^)]+\):\s+(.+?)\s+(?:deleted|renamed|added|modified)\s+/i,
    );
    if (firstTokenMatch) {
      files.add(firstTokenMatch[1].trim());
    }
  }
  return [...files];
}

function fetchPrData(
  owner: string | undefined,
  repo: string | undefined,
  prNumber: unknown,
): PrData {
  const raw = ghText([
    'pr',
    'view',
    String(prNumber),
    '-R',
    `${owner}/${repo}`,
    '--json',
    'number,headRefOid,baseRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,headRepository',
    '--jq',
    '.',
  ]);
  try {
    return JSON.parse(raw) as PrData;
  } catch {
    throw new Error(`Failed to parse PR data for PR #${prNumber}`);
  }
}

function normalizeNullable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === '' || s === 'null' || s === 'undefined' ? null : s;
}

function ghText(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function gitText(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function isMainModule(metaUrl: string): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return metaUrl === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): {
  help: boolean;
  prNumber: string | null;
  owner: string | null;
  repo: string | null;
} {
  const args: {
    help: boolean;
    prNumber: string | null;
    owner: string | null;
    repo: string | null;
  } = { help: false, prNumber: null, owner: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else if (argv[i] === '--pr' && argv[i + 1]) {
      args.prNumber = String(argv[++i]);
    } else if (argv[i] === '--owner' && argv[i + 1]) {
      args.owner = String(argv[++i]);
    } else if (argv[i] === '--repo' && argv[i + 1]) {
      args.repo = String(argv[++i]);
    }
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    `Usage:\n  node scripts/branch-conflict-state.mjs --pr <number> [--owner <owner>] [--repo <repo>]\n`,
  );
}
