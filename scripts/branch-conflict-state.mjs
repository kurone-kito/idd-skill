#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw new Error("missing required --pr <number> argument");
  }

  const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
  const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);

  const result = await classifyBranchConflictState(args.prNumber, { owner, repo });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function classifyBranchConflictState(prNumber, options = {}) {
  const { owner, repo, _testPrData, _skipGitProbe } = options;
  const notes = [];

  const prData = _testPrData ?? fetchPrData(owner, repo, prNumber);
  const prHeadSha = String(prData.headRefOid ?? "");
  const prBaseSha = String(prData.baseRefOid ?? "");
  const prHeadRef = String(prData.headRefName ?? "");
  const prBaseRef = String(prData.baseRefName ?? "");
  const mergeable = prData.mergeable ?? null;
  const mergeStateStatus = prData.mergeStateStatus ?? null;
  const published = Boolean(prData.headRepository?.pushedAt ?? prHeadSha);

  if (!prHeadSha || !prBaseSha) {
    return {
      protocolVersion: "1",
      prNumber: Number(prNumber),
      prHeadSha: prHeadSha || "",
      prBaseSha: prBaseSha || "",
      published,
      mergeable: null,
      mergeStateStatus: null,
      branchState: "unknown",
      syncRecommendation: "hold-unknown",
      readOnly: true,
      worktreeUnchanged: true,
      diagnostics: {
        mergeableSource: "none",
        conflictFiles: [],
        notes: ["PR head or base SHA unavailable; cannot classify branch state."],
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
    protocolVersion: "1",
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
}) {
  const mergeableNorm = String(mergeable ?? "").toUpperCase();
  const mergeStateNorm = String(mergeStateStatus ?? "").toUpperCase();

  if (mergeableNorm === "CONFLICTING") {
    const conflictFiles = skipGitProbe ? [] : probeConflictFilesReadOnly(prHeadSha, prBaseSha, prBaseRef, owner, repo, notes);
    return {
      branchState: "content-conflict",
      syncRecommendation: "hold-unknown",
      conflictFiles,
      mergeableSource: "github-mergeable",
    };
  }

  if (mergeStateNorm === "DIRTY") {
    return {
      branchState: "dirty",
      syncRecommendation: "hold-unknown",
      conflictFiles: [],
      mergeableSource: "github-merge-state",
    };
  }

  if (mergeableNorm === "MERGEABLE" && mergeStateNorm === "CLEAN") {
    return {
      branchState: "clean",
      syncRecommendation: "none",
      conflictFiles: [],
      mergeableSource: "github-mergeable",
    };
  }

  if (mergeStateNorm === "BEHIND") {
    const conflictFiles = skipGitProbe ? [] : probeConflictFilesReadOnly(prHeadSha, prBaseSha, prBaseRef, owner, repo, notes);
    if (conflictFiles.length > 0) {
      return {
        branchState: "content-conflict",
        syncRecommendation: "hold-unknown",
        conflictFiles,
        mergeableSource: "git-merge-tree",
      };
    }
    return {
      branchState: "behind-no-conflict",
      syncRecommendation: "merge-main",
      conflictFiles: [],
      mergeableSource: "git-merge-tree",
    };
  }

  if (mergeableNorm === "MERGEABLE") {
    return {
      branchState: "clean",
      syncRecommendation: "none",
      conflictFiles: [],
      mergeableSource: "github-mergeable",
    };
  }

  if (mergeableNorm === "UNKNOWN" || !mergeableNorm) {
    notes.push(`Mergeable status is ${mergeable ?? "null"}; unable to classify definitively.`);
    return {
      branchState: "unknown",
      syncRecommendation: "hold-unknown",
      conflictFiles: [],
      mergeableSource: "none",
    };
  }

  notes.push(`Unrecognized mergeable=${mergeable} / mergeStateStatus=${mergeStateStatus}.`);
  return {
    branchState: "unknown",
    syncRecommendation: "hold-unknown",
    conflictFiles: [],
    mergeableSource: "none",
  };
}

function probeConflictFilesReadOnly(prHeadSha, prBaseSha, prBaseRef, owner, repo, notes) {
  try {
    const mergeBase = gitText(["merge-base", prHeadSha, prBaseSha]);
    if (!mergeBase) {
      tryFetchBase(prBaseRef, owner, repo, notes);
      const mergeBase2 = gitText(["merge-base", prHeadSha, prBaseSha]);
      if (!mergeBase2) {
        notes.push("merge-base not found; skipping read-only conflict probe.");
        return [];
      }
    }
    const result = spawnSync("git", ["merge-tree", "--no-messages", "--merge-base=" + (mergeBase || prBaseSha), prHeadSha, prBaseSha], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 && result.status !== 1) {
      notes.push(`git merge-tree exited with status ${result.status}; cannot probe conflicts.`);
      return [];
    }
    const conflictFiles = parseConflictFiles(result.stdout ?? "");
    return conflictFiles;
  } catch {
    notes.push("git merge-tree unavailable; falling back to GitHub mergeability signal only.");
    return [];
  }
}

function tryFetchBase(prBaseRef, owner, repo, notes) {
  if (!prBaseRef) return;
  try {
    const remote = `https://github.com/${owner}/${repo}.git`;
    execFileSync("git", ["fetch", "--no-tags", "--depth=1", remote, prBaseRef], {
      stdio: "ignore",
      encoding: "utf8",
    });
  } catch {
    notes.push(`Could not fetch base ref ${prBaseRef}; merge-base probe may be incomplete.`);
  }
}

function parseConflictFiles(mergeTreeOutput) {
  const files = new Set();
  for (const line of mergeTreeOutput.split("\n")) {
    const match = line.match(/^CONFLICT\s+\([^)]+\):\s+(.+?)\s+in\s+/i)
      ?? line.match(/^CONFLICT\s+\([^)]+\):\s+(.+?)$/i);
    if (match) {
      files.add(match[1].trim());
    }
  }
  return [...files];
}

function fetchPrData(owner, repo, prNumber) {
  const raw = ghText([
    "pr",
    "view",
    String(prNumber),
    "-R",
    `${owner}/${repo}`,
    "--json",
    "number,headRefOid,baseRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,headRepository",
    "--jq",
    ".",
  ]);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse PR data for PR #${prNumber}`);
  }
}

function normalizeNullable(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === "" || s === "null" || s === "undefined" ? null : s;
}

function ghText(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function gitText(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return metaUrl === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = { help: false, prNumber: null, owner: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") {
      args.help = true;
    } else if (argv[i] === "--pr" && argv[i + 1]) {
      args.prNumber = String(argv[++i]);
    } else if (argv[i] === "--owner" && argv[i + 1]) {
      args.owner = String(argv[++i]);
    } else if (argv[i] === "--repo" && argv[i + 1]) {
      args.repo = String(argv[++i]);
    }
  }
  return args;
}

function printUsage() {
  process.stdout.write(
    `Usage:\n  node scripts/branch-conflict-state.mjs --pr <number> [--owner <owner>] [--repo <repo>]\n`,
  );
}
