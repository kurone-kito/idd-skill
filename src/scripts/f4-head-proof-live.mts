// idd-generated-from: src/scripts/f4-head-proof-live.mts
//
// The scripts/f4-head-proof-live.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// The production wiring of `f4-head-proof-gate.mts` (#4368): the real `git`,
// `gh`, claim-lock, and provider-adapter calls behind each callback of
// {@link F4HeadProofGateDeps}. The flow itself has no I/O and is tested with
// fake callbacks; this module is the only place the flow touches the host.

import {
  type ExecFileSyncOptionsWithStringEncoding,
  execFileSync,
  spawnSync,
} from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mts';
import { checkClaimLock, readGeneratedClaimTokens } from './claim-lock.mts';
import {
  type CollaboratorPermissionCache,
  resolveTrustedCollaboratorMarkerLogins,
} from './collaborator-permission.mts';
import type {
  ClaimAssertOutcome,
  ClaimAssertRequest,
  CommitRead,
  F4HeadProofGateDeps,
  PullRequestRead,
  PullRequestSummary,
} from './f4-head-proof-gate.mts';
import type { LocalRef } from './f4-head-proof-verdict.mts';
import { GH_TEXT_LOOP_OPTIONS, ghApiJson, ghText } from './gh-exec.mts';
import { loadTrustedActorConfig } from './idd-config.mts';
import {
  parseLocalWorktreeList,
  sanitizedGitEnvironment,
} from './local-worktree-occupancy.mts';
import { resolveCollaboratorMarkerTrust } from './policy-helpers.mts';
import { composeGateTrustedMarkerLogins } from './protocol-helpers.mts';
import { createGithubProviderAdapter } from './provider-adapter-github.mts';
import type { ProviderComment } from './provider-port.mts';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const CLAIM_ASSERT_TIMEOUT_MS = 120_000;
const PR_LIST_LIMIT = 100;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * Whether `worktree` is one of the worktrees in `git worktree list
 * --porcelain -z` output, compared by real path. Output that does not parse
 * (the strict parser of local-worktree-occupancy.mts fails closed on an
 * unknown field) is `null`; a worktree path that does not exist, or a record
 * marked prunable, never matches.
 */
export function matchRegisteredWorktree(
  output: string,
  worktree: string,
): boolean | null {
  let records: ReturnType<typeof parseLocalWorktreeList>;
  try {
    records = parseLocalWorktreeList(output);
  } catch {
    return null;
  }
  const target = realpathOrNull(worktree);
  if (target === null) {
    return false;
  }
  return records.some(
    (record) => !record.prunable && realpathOrNull(record.path) === target,
  );
}

function isRegisteredWorktree(worktree: string): boolean | null {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    encoding: 'utf8',
    env: sanitizedGitEnvironment(),
  });
  return result.status === 0
    ? matchRegisteredWorktree(result.stdout, worktree)
    : null;
}

/**
 * The options of the spawned claim check. The child reads git state for the
 * supplied worktree only, so the caller's Git environment overrides (`GIT_DIR`,
 * `GIT_WORK_TREE`, and the rest of `sanitizedGitEnvironment`'s list) are
 * dropped. Everything else passes through, including `PATH` and the GitHub
 * token variables the check's own GitHub reads need.
 */
export function claimCheckSpawnOptions(): ExecFileSyncOptionsWithStringEncoding {
  return {
    encoding: 'utf8',
    env: sanitizedGitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CLAIM_ASSERT_TIMEOUT_MS,
  };
}

/**
 * Run `resume-claim-routing --assert` through the compiled sibling script and
 * classify the result (see `classifyClaimAssertResult`).
 */
function assertClaim(
  request: ClaimAssertRequest,
  options: { owner: string; repo: string },
): ClaimAssertOutcome {
  const script = join(
    resolveBundleRoot(import.meta.dirname),
    'scripts/resume-claim-routing.mjs',
  );
  const argv = [
    script,
    '--issue',
    String(request.issueNumber),
    '--assert',
    '--claim-id',
    request.claimId,
    '--nonce',
    request.nonce,
    '--worktree',
    request.worktree,
    '--owner',
    options.owner,
    '--repo',
    options.repo,
  ];
  let stdout = '';
  let exited = 0;
  try {
    stdout = execFileSync(process.execPath, argv, claimCheckSpawnOptions());
  } catch (error) {
    const failure = error as { status?: unknown; stdout?: unknown };
    exited = typeof failure.status === 'number' ? failure.status : 1;
    stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
  }
  return classifyClaimAssertResult(exited, stdout, request.claimId);
}

/**
 * The `state` and `action` values `resume-claim-routing` prints (its routing
 * module assigns each one). Only a verdict made of these values can be an
 * answer about the claim.
 */
const ROUTING_STATES: ReadonlySet<string> = new Set([
  'unclaimed',
  'stale',
  'non_inheritable',
  'disputed',
  'owner_evidence_required',
  'already_owned',
  'local_worktree_occupied',
]);
const ROUTING_ACTIONS: ReadonlySet<string> = new Set([
  'keep',
  're_claim',
  'stop',
  'takeover',
]);

/**
 * Classify one `resume-claim-routing --assert` run from its exit status and
 * stdout. Exit 0 with an `already_owned` / `keep` verdict naming this claim
 * ID and a branch is `owned`. A non-zero exit whose `state` and `action` are
 * both in the routing vocabulary is `not-owned`: that is the routing answer
 * that the claim is not held by this session, and `owner_evidence_required` is
 * one of them (the claim ID matches but the local proof failed). Anything
 * else, including a verdict outside the vocabulary, is `unreadable`, which
 * holds the run instead of ending it quietly.
 */
export function classifyClaimAssertResult(
  exited: number,
  stdout: string,
  claimId: string,
): ClaimAssertOutcome {
  let routing: {
    state?: unknown;
    action?: unknown;
    active_claim?: { claim_id?: unknown; branch?: unknown } | null;
  };
  try {
    routing = JSON.parse(stdout);
  } catch {
    return {
      status: 'unreadable',
      detail: `resume-claim-routing --assert printed no readable JSON (exit ${exited})`,
    };
  }
  if (
    routing === null ||
    typeof routing !== 'object' ||
    typeof routing.state !== 'string' ||
    typeof routing.action !== 'string'
  ) {
    return {
      status: 'unreadable',
      detail: `resume-claim-routing --assert printed no routing verdict (exit ${exited})`,
    };
  }
  const branch = routing.active_claim?.branch;
  if (
    exited === 0 &&
    routing.state === 'already_owned' &&
    routing.action === 'keep' &&
    routing.active_claim?.claim_id === claimId &&
    typeof branch === 'string' &&
    branch !== ''
  ) {
    return { status: 'owned', branch };
  }
  // Exit 0 is the only exit that goes with `already_owned` / `keep`, so that
  // verdict with a non-zero exit means the run was cut short after printing.
  const ownedVerdict =
    routing.state === 'already_owned' && routing.action === 'keep';
  if (exited === 0 || ownedVerdict) {
    return {
      status: 'unreadable',
      detail: `resume-claim-routing --assert exited ${exited} with state ${routing.state} and action ${routing.action}, which does not prove this claim ID`,
    };
  }
  if (
    !ROUTING_STATES.has(routing.state) ||
    !ROUTING_ACTIONS.has(routing.action)
  ) {
    return {
      status: 'unreadable',
      detail: `resume-claim-routing --assert printed an unrecognized verdict (state ${routing.state}, action ${routing.action})`,
    };
  }
  return { status: 'not-owned' };
}

function runGit(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    env: sanitizedGitEnvironment(),
  });
  return { status: result.status, stdout: (result.stdout ?? '').trim() };
}

/**
 * Classify the git reads behind a local branch ref. `verified` is
 * `git rev-parse --verify refs/heads/<branch>`: exit 0 with a full SHA is a
 * present ref. When it fails, `exists` is `git show-ref --verify --quiet` for
 * the same ref: exit 1 is a ref that does not exist (absent); any other exit,
 * or no second read, is an error. A broken repository fails `rev-parse` the
 * same way a missing ref does, which is why the second read decides.
 */
export function classifyLocalRefReads(
  verified: { status: number | null; stdout: string },
  exists: { status: number | null } | null,
): LocalRef {
  if (verified.status === 0) {
    return FULL_SHA_PATTERN.test(verified.stdout)
      ? { state: 'present', tip: verified.stdout }
      : { state: 'error', tip: null };
  }
  return exists !== null && exists.status === 1
    ? { state: 'absent', tip: null }
    : { state: 'error', tip: null };
}

function readLocalRef(worktree: string, branch: string): LocalRef {
  const ref = `refs/heads/${branch}`;
  const verified = runGit(['-C', worktree, 'rev-parse', '--verify', ref]);
  if (verified.status === 0) {
    return classifyLocalRefReads(verified, null);
  }
  return classifyLocalRefReads(
    verified,
    runGit(['-C', worktree, 'show-ref', '--verify', '--quiet', ref]),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The pull requests of `gh pr list --head <branch> --json
 * number,state,headRefName,isCrossRepository` that belong to this repository
 * and have exactly this head branch, as number and merged flag. A fork's pull
 * request of the same branch name is dropped. A list that reached `limit`
 * rows may be truncated, and the flow proceeds only on exactly one merged pull
 * request, so a possibly truncated list throws instead of being trusted.
 */
export function selectPullRequests(
  rows: unknown,
  branch: string,
  limit: number,
): PullRequestSummary[] {
  if (!Array.isArray(rows)) {
    throw new Error('gh pr list did not return a JSON array');
  }
  if (rows.length >= limit) {
    throw new Error(
      `gh pr list returned ${rows.length} rows, the cap of ${limit}, so the list may be truncated and cannot prove that exactly one merged pull request has ${branch} as its head branch`,
    );
  }
  return rows
    .map(asRecord)
    .filter(
      (row) => row.headRefName === branch && row.isCrossRepository !== true,
    )
    .map((row) => ({
      number: Number(row.number),
      merged: row.state === 'MERGED',
    }))
    .filter((row) => Number.isSafeInteger(row.number) && row.number > 0);
}

/**
 * The production callbacks for one repository. The trusted logins are the
 * viewer, the trusted configuration (read from the repository's default
 * branch, never the worktree), `IDD_TRUSTED_MARKER_ACTORS`, and, when
 * collaborator-marker trust is on, collaborators with write access. No flag
 * can add to them: this command takes none.
 *
 * The repository is resolved on the first GitHub access, not up front, so a
 * refusal that needs no GitHub read (an unregistered worktree) makes no
 * GitHub call.
 */
export function createLiveF4HeadProofDeps(options: {
  resolveRepo: () => { owner: string; repo: string };
}): F4HeadProofGateDeps {
  let located: {
    owner: string;
    repo: string;
    adapter: ReturnType<typeof createGithubProviderAdapter>;
  } | null = null;
  const locate = () => {
    if (located === null) {
      const { owner, repo } = options.resolveRepo();
      located = {
        owner,
        repo,
        adapter: createGithubProviderAdapter(owner, repo),
      };
    }
    return located;
  };
  const permissionCache: CollaboratorPermissionCache = new Map();
  let viewerLogin: string | null = null;
  let trustConfig: ReturnType<typeof loadTrustedActorConfig> | undefined;

  return {
    isRegisteredWorktree,
    readTokens: readGeneratedClaimTokens,
    checkLock: checkClaimLock,
    assertClaim: (request) => {
      const { owner, repo } = locate();
      return assertClaim(request, { owner, repo });
    },
    resolveTrustedLogins(comments: readonly ProviderComment[]) {
      const { owner, repo, adapter } = locate();
      viewerLogin ??= adapter.resolveViewerLogin();
      if (trustConfig === undefined) {
        trustConfig = loadTrustedActorConfig({ owner, repo, baseRefName: '' });
      }
      const collaboratorMarkerLogins = resolveCollaboratorMarkerTrust(
        trustConfig,
        process.env.IDD_TRUST_COLLABORATOR_MARKERS,
      )
        ? resolveTrustedCollaboratorMarkerLogins(
            owner,
            repo,
            comments.map((comment) => ({
              body: comment.body,
              user: { login: comment.authorLogin },
            })),
            { cache: permissionCache },
          )
        : [];
      return composeGateTrustedMarkerLogins({
        viewerLogin,
        envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
        config: trustConfig,
        collaboratorMarkerLogins,
      });
    },
    listIssueComments: (issueNumber) =>
      locate().adapter.listWorkItemComments(issueNumber, {
        includeEditState: true,
      }),
    listPullRequests(branch: string): PullRequestSummary[] {
      const { owner, repo } = locate();
      const raw = ghText(
        [
          'pr',
          'list',
          '--repo',
          `${owner}/${repo}`,
          '--head',
          branch,
          '--state',
          'all',
          '--json',
          'number,state,headRefName,isCrossRepository',
          '--limit',
          String(PR_LIST_LIMIT),
        ],
        GH_TEXT_LOOP_OPTIONS,
      );
      return selectPullRequests(JSON.parse(raw || '[]'), branch, PR_LIST_LIMIT);
    },
    listPullRequestComments: (prNumber) =>
      locate().adapter.listWorkItemComments(prNumber, {
        includeEditState: true,
      }),
    readPullRequest(prNumber: number): PullRequestRead {
      const { owner, repo } = locate();
      const pr = asRecord(
        ghApiJson(`repos/${owner}/${repo}/pulls/${prNumber}`),
      );
      const head = asRecord(pr.head);
      return {
        state: String(pr.state ?? ''),
        merged: pr.merged === true,
        mergeCommitSha:
          typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null,
        headSha: typeof head.sha === 'string' ? head.sha : null,
      };
    },
    readCommit(sha: string): CommitRead {
      const { owner, repo } = locate();
      const commit = asRecord(
        ghApiJson(`repos/${owner}/${repo}/git/commits/${sha}`),
      );
      const parents = Array.isArray(commit.parents) ? commit.parents : [];
      return {
        sha: typeof commit.sha === 'string' ? commit.sha : null,
        parents: parents.map((parent) => {
          const entry = asRecord(parent);
          return typeof entry.sha === 'string' ? entry.sha : null;
        }),
      };
    },
    isValidRefName: (branch) =>
      runGit(['check-ref-format', `refs/heads/${branch}`]).status === 0,
    readLocalRef,
    postComment(issueNumber: number, body: string) {
      const posted = locate().adapter.postWorkItemComment(issueNumber, body);
      return { id: posted.id, htmlUrl: posted.htmlUrl };
    },
    sleep: sleepSync,
  };
}
