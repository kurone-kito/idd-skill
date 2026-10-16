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
import { parseLocalWorktreeList } from './local-worktree-occupancy.mts';
import { resolveCollaboratorMarkerTrust } from './policy-helpers.mts';
import { composeGateTrustedMarkerLogins } from './protocol-helpers.mts';
import {
  activeGithubHost,
  createGithubProviderAdapter,
  gitChildEnvironment,
  isPlainRemoteUrl,
  originNamesRepository,
  repositoryFromRemoteUrl,
} from './provider-adapter-github.mts';
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
    (record) =>
      !record.prunable &&
      !record.bare &&
      realpathOrNull(record.path) === target,
  );
}

function isRegisteredWorktree(worktree: string): boolean | null {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    encoding: 'utf8',
    env: gitChildEnvironment(),
  });
  return result.status === 0
    ? matchRegisteredWorktree(result.stdout, worktree)
    : null;
}

/**
 * The options of the spawned claim check. The child reads git state for the
 * supplied worktree only, so the caller's Git environment overrides (every
 * `GIT_` name, in any case) are dropped. Everything else passes through,
 * including `PATH` and the GitHub token variables the check's own GitHub reads
 * need.
 */
export function claimCheckSpawnOptions(): ExecFileSyncOptionsWithStringEncoding {
  return {
    encoding: 'utf8',
    env: gitChildEnvironment(),
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
 * stdout. Exit 0 with an `already_owned` / `keep` verdict whose reason is
 * `claim-id-match`, naming this claim ID and a branch, is `owned`. A non-zero exit whose `state` and `action` are
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
    reason?: unknown;
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
    routing.reason === 'claim-id-match' &&
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
    env: gitChildEnvironment(),
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
      (row) => row.headRefName === branch && row.isCrossRepository === false,
    )
    .map((row) => ({
      number: Number(row.number),
      merged: row.state === 'MERGED',
    }))
    .filter((row) => Number.isSafeInteger(row.number) && row.number > 0);
}

/**
 * The origin remote's URL as git reports it, raw but for its final newline;
 * null when the checkout has no origin or git cannot read it.
 */
function readOriginUrl(): string | null {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    env: gitChildEnvironment(),
  });
  if (result.status !== 0) return null;
  const url = (result.stdout ?? '').replace(/\n$/, '');
  return url === '' ? null : url;
}

/**
 * The repository the current checkout's origin remote names, read locally with
 * no `gh` call, so an inherited `GH_REPO` cannot change it. Throws when the
 * checkout has no origin or the remote is not a repository URL. The URL is
 * checked raw, the same way the origin check checks it, before it is parsed.
 */
export function resolveCheckoutRepository(): { owner: string; repo: string } {
  const url = readOriginUrl();
  if (url === null) {
    throw new Error(
      'the current checkout has no origin remote that names a repository',
    );
  }
  if (!isPlainRemoteUrl(url)) {
    throw new Error(
      "the checkout's origin URL contains characters that a repository URL does not",
    );
  }
  const named = repositoryFromRemoteUrl(url);
  if (named === null) {
    throw new Error(
      'the current checkout has no origin remote that names a repository',
    );
  }
  return { owner: named.owner, repo: named.repo };
}

/** The host `GH_HOST` names once `activeGithubHost` reads it back as an https
 * host (which drops port 443), or null when the value cannot be read. */
function readBackAsGhHost(host: string): string | null {
  try {
    return new URL(`https://${host}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/** An origin URL for `owner/repo` on the active host, in a scheme that keeps
 * the host's port: https keeps any port but 443, which it treats as the
 * default, and http keeps 443 but drops 80. */
function exampleOriginUrl(active: string, owner: string, repo: string): string {
  const scheme = readBackAsGhHost(active) === active ? 'https' : 'http';
  return `${scheme}://${active}/${owner}/${repo}.git`;
}

/**
 * Why the origin check refused `owner/repo`, given the origin URL and the
 * active GitHub host as the caller read them (null when unread). Each message
 * names a fix that passes the check once it is applied, or the setting to
 * correct first. The check compares the origin host, port included, with the
 * active host that `GH_HOST` (or `GITHUB_SERVER_URL`) names after it is read
 * back.
 */
export function originMismatchMessage(
  owner: string,
  repo: string,
  originUrl: string | null,
  active: string | null,
): string {
  if (originUrl !== null && !isPlainRemoteUrl(originUrl)) {
    return `${owner}/${repo} is not confirmed: the checkout's origin URL contains characters that a repository URL does not`;
  }
  const named = originUrl === null ? null : repositoryFromRemoteUrl(originUrl);
  if (named === null) {
    return `${owner}/${repo} is not confirmed: the current checkout has no origin remote that names a repository`;
  }
  if (
    named.owner.toLowerCase() !== owner.toLowerCase() ||
    named.repo.toLowerCase() !== repo.toLowerCase()
  ) {
    return `${owner}/${repo} is not the repository the current checkout's origin names (${named.owner}/${named.repo})`;
  }
  const host = named.host.toLowerCase();
  if (active !== null && host === active) {
    // The name and the host agree with the active host, so only a read that
    // failed or changed between the two checks can refuse it: a retry is the fix.
    return `the current checkout's origin names ${owner}/${repo} on ${active}, but the origin could not be confirmed; retry, or check the origin remote`;
  }
  const httpOrigin = /^https?:\/\//i.test(originUrl ?? '');
  const hostOnly = host.replace(/:\d+$/, '');
  const hasPort = hostOnly !== host;
  // An HTTP(S) origin's port is part of its host, so GH_HOST carries it, unless
  // GH_HOST reads it back differently (port 443 is the https default). An SSH or
  // git:// port is compared with the host too. GH_HOST could carry it, but every
  // gh call would then go to that port, so the origin URL should drop it.
  const portCarried = hasPort && httpOrigin && readBackAsGhHost(host) === host;
  const activeText = active ?? 'an unreadable host';
  if (active !== null && hostOnly === active) {
    const fix = portCarried
      ? `use an origin URL without a port, or set GH_HOST to ${host} to use it`
      : 'use an origin URL without a port';
    return `the current checkout's origin names ${owner}/${repo} on ${host}, a host with a port that the origin check does not match to the active GitHub host ${active}; ${fix}`;
  }
  if (!httpOrigin && hostOnly === 'ssh.github.com') {
    // GitHub's SSH-over-443 endpoint names the repository too, but it is not an
    // API host, so GH_HOST must not be pointed at it.
    if (active === null) {
      return `the current checkout's origin names ${owner}/${repo} on ssh.github.com, GitHub's SSH endpoint and not an API host; the active GitHub host cannot be read, so set GH_HOST to a readable host, or unset it and set GITHUB_SERVER_URL to its https:// URL, and then use an origin URL on that host`;
    }
    return `the current checkout's origin names ${owner}/${repo} on ssh.github.com, GitHub's SSH endpoint and not an API host; use an origin URL on the API host, for example ${exampleOriginUrl(active, owner, repo)}`;
  }
  if (readBackAsGhHost(hostOnly) !== hostOnly) {
    if (active === null) {
      return `the current checkout's origin names ${owner}/${repo} on ${host}, which GH_HOST cannot name, and the active GitHub host cannot be read either; set GH_HOST to a readable host, or unset it and set GITHUB_SERVER_URL to its https:// URL, and then use an origin URL on that host`;
    }
    return `the current checkout's origin names ${owner}/${repo} on ${host}, which GH_HOST cannot name; use an origin URL on ${active}, for example ${exampleOriginUrl(active, owner, repo)}`;
  }
  if (!hasPort || portCarried) {
    return `the current checkout's origin names ${owner}/${repo} on ${host}, but the active GitHub host is ${activeText}; set GH_HOST to ${host} to use it`;
  }
  return `the current checkout's origin names ${owner}/${repo} on ${host}, but the active GitHub host is ${activeText}; set GH_HOST to ${hostOnly} and use an origin URL without a port to use it`;
}

/**
 * The production callbacks for one repository. The trusted logins are the
 * viewer, the trusted configuration (read from the repository's default
 * branch, never the worktree), `IDD_TRUSTED_MARKER_ACTORS`, and, when
 * collaborator-marker trust is on, collaborators with write access. No flag
 * can add to them: this command takes none.
 *
 * The repository is resolved from the checkout's origin on the first GitHub
 * access, not up front, so a
 * refusal that needs no GitHub read (an unregistered worktree) makes no
 * GitHub call. The command passes `resolveCheckoutRepository`, which reads
 * the repository from the checkout's origin without `gh`.
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
      if (!owner || !repo) {
        throw new Error(
          'the repository of the current checkout could not be resolved',
        );
      }
      // The registration check and this origin check both read the process
      // working directory, so they describe the same checkout. A name the
      // origin does not confirm is refused; the origin host must be the active
      // GitHub host (GH_HOST, else GITHUB_SERVER_URL, else github.com).
      if (!originNamesRepository(owner, repo)) {
        throw new Error(
          originMismatchMessage(
            owner,
            repo,
            readOriginUrl(),
            activeGithubHost(),
          ),
        );
      }
      // Every gh call of this process goes to the host the check just confirmed,
      // in its normalized form. With GH_HOST unset, gh would use its own default
      // host, which can be another server with a same-named repository.
      const confirmedHost = activeGithubHost();
      if (confirmedHost === null) {
        throw new Error('the active GitHub host could not be read');
      }
      process.env.GH_HOST = confirmedHost;
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
    checkoutRepositoryError() {
      try {
        locate();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
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
