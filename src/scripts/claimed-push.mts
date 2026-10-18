#!/usr/bin/env node
// idd-generated-from: src/scripts/claimed-push.mts
//
// The scripts/claimed-push.mjs copy is generated from this .mts source by
// `pnpm run build`. Edit the .mts source, never the generated .mjs. See
// docs/typescript-sources.md.
//
// Pushes a claimed branch only after the claim, the worktree location, the
// B3 scope check, and the configured `commands.pre-push-validate` gate have
// all passed in order (issues #4375 and #4480). The six steps are `assert`,
// `location`, `scope`, `gate`, `reassert`, and `push`. The `scope` step only
// reads: it runs `audit-authored-issue` on the issue body and on a copy whose
// leading `## Candidate files` section lists the paths the branch changed
// since its branch point, so an over-scope branch stops before the push. The
// helper never forces, never retries, and never creates a commit. Every child
// process runs through an injectable runner, so a test can stub the claim
// assert, every git and gh read, the audit, the gate, and the push.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { resolveBundleRoot } from './bundle-root.mts';
import {
  parseCanonicalIntegerOrThrow,
  parseCliArgs,
  requireFlag,
} from './cli-args.mts';
import { GENERATED_SOURCE_BANNER_PATTERN } from './consistency-helpers.mts';
import { parseCandidateFiles } from './discover-shared-file-overlap.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadLayeredLocalPolicy } from './idd-config.mts';
import { parseLocalWorktreeList } from './local-worktree-occupancy.mts';
import { maskMarkdownForScan } from './markdown-code.mts';
import { normalizeMarkerPrefix } from './marker-helpers.mts';
import {
  inspectDevelopmentBranch,
  resolveEffectiveDevelopmentBranch,
} from './policy-helpers.mts';

const CLAIMED_PUSH_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--nonce': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

/** The remote is fixed: the helper never takes a remote argument. */
const REMOTE_NAME = 'origin';

/** The claim assert is the existing helper, run as a child process. */
const CLAIM_ASSERT_SCRIPT = 'resume-claim-routing.mjs';

/** The scope check runs the existing authored-issue audit as it stands. */
const AUDIT_SCRIPT = 'audit-authored-issue.mjs';

/** The one audit finding the scope step reads. */
const EFFORT_FINDING_ID = 'effort-candidate-file-limit';

/** The sync manifest, read at the branch point for its `syncPairs` targets. */
const SYNC_MANIFEST_PATH = 'audit/sync-manifest.json';

/** The only default-branch read the `gh` kind runs. */
const REPO_DEFAULT_BRANCH_ARGS = [
  'repo',
  'view',
  '--json',
  'defaultBranchRef',
  '--jq',
  '.defaultBranchRef.name',
] as const;

/** An ATX heading, as the `## Candidate files` parser recognizes one. */
const ATX_HEADING = /^ {0,3}#{1,6}\s+/u;

/**
 * A generated-from banner is read from a file's first 200 bytes, the window
 * `build-ts` and `audit-docs` use, so an example banner line further down a
 * document (as in `docs/typescript-sources.md`) never marks it generated.
 */
const GENERATED_BANNER_SCAN_BYTES = 200;

/** How the audit counts canonical paths, stated in every scope reason. */
const AUDIT_COUNT_RULE =
  'the audit counts distinct parsed keys, so paths that share a key count once, and its parser drops a token with no "/" or "." or with whitespace, so such a path is not counted';

/** Captured child output above this size is reported as a failed run. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** A dirty-tree reason lists at most this many status lines. */
const MAX_STATUS_LINES = 20;

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** A github.com origin: https, http, git, ssh, git+ssh, ssh+git, or scp-style. */
const GITHUB_ORIGIN_PATTERN =
  /^(?:(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/|(?:[^/@:]+@)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/*$/iu;

/** An origin whose host is github.com, however malformed its path. */
const GITHUB_HOST_PATTERN =
  /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/@]+@)?github\.com(?=[:/]|$)/iu;

/** The next action each refusal carries, one per row of the issue's table. */
const NEXT_ACTION = {
  staleClaim: 'stop and re-read the claim',
  helperInstallation: 'check the helper installation, then rerun',
  stopAndReport: 'stop and report',
  runFromWorktree: 'run the helper from the claimed worktree',
  switchBranch: 'switch the worktree to the claimed branch',
  commitThenRerun: 'stage and commit, then rerun',
  fixThenRerun: 'fix the failure, commit, and rerun',
  configureGate: 'configure the command or run the written gate by hand',
  commitOrDiscard: 'commit or discard what the gate changed, then rerun',
  rerunForHead: 'rerun the helper so the gate sees the new HEAD',
  readGitError: 'read the git error in the worktree and fix it, then rerun',
  pushRejected: (branch: string): string =>
    `read git's message, fetch and inspect ${REMOTE_NAME}/${branch}, never force`,
  pushUnknown: 'read the remote branch before any new push, no retry',
  scopeOverrun:
    'stop without pushing and follow the Scope overrun rule in idd-work.instructions.md',
  staleBase: (base: string): string =>
    `run node scripts/clone-lock.mjs --exec --agent-id <your agent id> -- git fetch ${REMOTE_NAME} +refs/heads/${base}:refs/remotes/${REMOTE_NAME}/${base} (see docs/idd-helper-scripts.md, "Clone-scoped lock"), then rerun the helper once; if the base is still stale, stop, report both SHAs, and do not push`,
} as const;

/** What a child process reported. `status` is null without an exit status. */
export interface CommandResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type CommandRequest =
  | { kind: 'git'; args: readonly string[]; cwd: string }
  | {
      kind: 'helper';
      script: string;
      args: readonly string[];
      cwd: string;
      /** Written to the child's input; without it the input is ignored. */
      stdin?: string;
    }
  | {
      /** Only the issue read and the default-branch read; see `isAllowedGhRead`. */
      kind: 'gh';
      args: readonly string[];
      cwd: string;
    }
  | { kind: 'gate'; command: string; cwd: string };

export type CommandRunner = (request: CommandRequest) => CommandResult;

export type GateCommandRead =
  | { ok: true; command: string }
  | { ok: false; reason: string };

/** The layered effective policy; `policy` is null when no tier has a file. */
export type PolicyRead =
  | { ok: true; policy: unknown }
  | { ok: false; reason: string };

/** One file's text at the branch point. */
export type BaseTextRead =
  | { status: 'present'; text: string }
  | { status: 'absent' }
  | { status: 'error'; reason: string };

export interface ClaimedPushDeps {
  run: CommandRunner;
  /** Canonical path, or null when the path cannot be resolved. */
  realpath: (path: string) => string | null;
  /** The effective `commands.pre-push-validate`, read for this worktree. */
  readGateCommand: (worktree: string) => GateCommandRead;
  /** The layered effective policy of the primary checkout, never the worktree's copy. */
  readPolicy: (worktree: string) => PolicyRead;
  /** A file's text at the branch point (`git ls-tree`, then `git show`). */
  readBaseText: (
    worktree: string,
    branchPoint: string,
    path: string,
  ) => BaseTextRead;
  /** The `## Candidate files` parser the audit counts with. */
  parseCandidates: (body: string) => string[];
}

export interface ClaimedPushInput {
  issue: number;
  claimId: string;
  nonce: string | null;
  apply: boolean;
  /** Directory the worktree is resolved from (`git rev-parse --show-toplevel`). */
  cwd: string;
}

export type ClaimedPushStepId =
  | 'assert'
  | 'location'
  | 'scope'
  | 'gate'
  | 'reassert'
  | 'push';

export interface ClaimedPushStep {
  id: ClaimedPushStepId;
  status: 'passed' | 'failed' | 'skipped';
  /** Present when a command ran; null when it ended without an exit status. */
  exitStatus?: number | null;
  reason: string;
  /** Non-empty on every failed step. */
  nextAction?: string;
}

export interface ClaimedPushReport {
  mode: 'dry-run' | 'apply';
  /** True after a push, false when none ran, null when its outcome is unknown. */
  pushed: boolean | null;
  issue: number;
  branch: string | null;
  worktree: string | null;
  steps: ClaimedPushStep[];
  pushedSha?: string;
  pushMessage?: string;
}

type StepOutcome = Omit<ClaimedPushStep, 'id'>;

interface Context {
  input: ClaimedPushInput;
  deps: ClaimedPushDeps;
  worktree: string | null;
  /** The primary checkout, as the `location` step read it. */
  primary: string | null;
  branch: string | null;
  recordedHead: string | null;
  pushed: boolean | null;
  pushedSha: string | null;
  pushMessage: string | null;
}

type CommandEnd =
  | { kind: 'exit'; status: number }
  | { kind: 'signal'; signal: string; detail: string }
  | { kind: 'no-start'; detail: string };

function classifyEnd(result: CommandResult): CommandEnd {
  if (result.status !== null) {
    return { kind: 'exit', status: result.status };
  }
  if (result.signal !== null && result.signal !== '') {
    return {
      kind: 'signal',
      signal: result.signal,
      detail: result.error?.trim() ?? '',
    };
  }
  return {
    kind: 'no-start',
    detail: result.error?.trim() || 'no exit status was reported',
  };
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

function withDetail(summary: string, detail: string): string {
  return detail === '' ? summary : `${summary}: ${detail}`;
}

function failed(
  reason: string,
  nextAction: string,
  exitStatus?: number | null,
): StepOutcome {
  return {
    status: 'failed',
    reason,
    nextAction,
    ...(exitStatus === undefined ? {} : { exitStatus }),
  };
}

function describeEnd(what: string, end: CommandEnd): string {
  if (end.kind === 'exit') {
    return `${what} exited ${end.status}`;
  }
  if (end.kind === 'signal') {
    return withDetail(`${what} was killed by signal ${end.signal}`, end.detail);
  }
  return `${what} could not start: ${end.detail}`;
}

type GitRead =
  | { ok: true; stdout: string }
  | { ok: false; reason: string; exitStatus: number | null };

/** Run one git read in the worktree; any non-zero end is a failed read. */
function readGit(
  ctx: Context,
  args: readonly string[],
  cwd: string | null = ctx.worktree,
): GitRead {
  const result = ctx.deps.run({ kind: 'git', args, cwd: cwd ?? ctx.input.cwd });
  const end = classifyEnd(result);
  if (end.kind === 'exit' && end.status === 0) {
    return { ok: true, stdout: result.stdout };
  }
  return {
    ok: false,
    reason: withDetail(
      describeEnd(`git ${args.join(' ')}`, end),
      end.kind === 'exit' ? firstLine(result.stderr) : '',
    ),
    exitStatus: end.kind === 'exit' ? end.status : null,
  };
}

function readHead(
  ctx: Context,
):
  | { sha: string; failure?: undefined }
  | { sha?: undefined; failure: StepOutcome } {
  const head = readGit(ctx, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    return {
      failure: failed(head.reason, NEXT_ACTION.readGitError, head.exitStatus),
    };
  }
  const sha = head.stdout.trim();
  if (!GIT_OBJECT_ID.test(sha)) {
    return {
      failure: failed(
        'git rev-parse HEAD did not print an object id',
        NEXT_ACTION.readGitError,
        0,
      ),
    };
  }
  return { sha };
}

/** Run the claim assert for the context's worktree and identity. */
function runAssert(ctx: Context): {
  outcome: StepOutcome;
  branch: string | null;
} {
  const { input, worktree } = ctx;
  const args = [
    '--issue',
    String(input.issue),
    '--assert',
    '--claim-id',
    input.claimId,
    ...(input.nonce === null ? [] : ['--nonce', input.nonce]),
    '--worktree',
    worktree ?? '',
  ];
  const result = ctx.deps.run({
    kind: 'helper',
    script: CLAIM_ASSERT_SCRIPT,
    args,
    cwd: worktree ?? input.cwd,
  });
  const end = classifyEnd(result);
  const what = 'the claim assert';
  if (end.kind === 'no-start') {
    return {
      outcome: failed(
        describeEnd(what, end),
        NEXT_ACTION.helperInstallation,
        null,
      ),
      branch: null,
    };
  }
  if (end.kind === 'signal') {
    return {
      outcome: failed(describeEnd(what, end), NEXT_ACTION.staleClaim, null),
      branch: null,
    };
  }
  if (end.status !== 0) {
    return {
      outcome: failed(
        withDetail(describeEnd(what, end), firstLine(result.stderr)),
        NEXT_ACTION.staleClaim,
        end.status,
      ),
      branch: null,
    };
  }
  const branch = claimedBranchOf(result.stdout);
  if (branch === null) {
    return {
      outcome: failed(
        'the claim assert exited 0 but its output named no claimed branch',
        NEXT_ACTION.staleClaim,
        0,
      ),
      branch: null,
    };
  }
  return {
    outcome: {
      status: 'passed',
      exitStatus: 0,
      reason: `the claim holds for issue ${input.issue} on branch ${branch}`,
    },
    branch,
  };
}

function claimedBranchOf(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const claim =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { active_claim?: unknown }).active_claim
        : undefined;
    const branch =
      typeof claim === 'object' && claim !== null
        ? (claim as { branch?: unknown }).branch
        : undefined;
    return typeof branch === 'string' && branch.trim() !== ''
      ? branch.trim()
      : null;
  } catch {
    return null;
  }
}

function stepAssert(ctx: Context): StepOutcome {
  const top = readGit(ctx, ['rev-parse', '--show-toplevel'], ctx.input.cwd);
  // Only the line terminator goes; a path may legally end in whitespace.
  const worktree = top.ok ? top.stdout.replace(/\r?\n$/u, '') : '';
  if (!top.ok || worktree === '') {
    return failed(
      top.ok ? 'git rev-parse --show-toplevel printed nothing' : top.reason,
      NEXT_ACTION.runFromWorktree,
      top.ok ? 0 : top.exitStatus,
    );
  }
  ctx.worktree = worktree;
  const { outcome, branch } = runAssert(ctx);
  ctx.branch = branch;
  return outcome;
}

/** The repository part of the origin slug, else the primary basename. */
function resolveRepoName(
  origin: string,
  primary: string,
): { ok: true; name: string } | { ok: false; reason: string } {
  const match = GITHUB_ORIGIN_PATTERN.exec(origin);
  if (match?.[2] !== undefined) {
    return { ok: true, name: match[2] };
  }
  if (GITHUB_HOST_PATTERN.test(origin)) {
    return {
      ok: false,
      // The URL is left out: it can carry credentials, and the report is pasted.
      reason:
        'the origin URL is on github.com but is not an owner/repository path',
    };
  }
  return { ok: true, name: basename(primary) };
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function stepLocation(ctx: Context): StepOutcome {
  const { branch, worktree } = ctx;
  if (branch === null || worktree === null) {
    // Unreachable: runClaimedPush skips this step after any failed step, and
    // a passed assert sets both values. A missing value is a programming
    // error, not a refusal of the claim or the tree.
    throw new Error(
      'claimed-push: the location step ran without a passed assert',
    );
  }
  const prefix = `issue/${ctx.input.issue}-`;
  if (!branch.startsWith(prefix)) {
    return failed(
      `the claimed branch ${branch} does not start with ${prefix}`,
      NEXT_ACTION.stopAndReport,
      0,
    );
  }

  const list = readGit(ctx, ['worktree', 'list', '--porcelain', '-z']);
  if (!list.ok) {
    return failed(list.reason, NEXT_ACTION.runFromWorktree, list.exitStatus);
  }
  const firstField = list.stdout.split('\0')[0] ?? '';
  const primary = firstField.startsWith('worktree ')
    ? firstField.slice('worktree '.length)
    : '';
  if (primary === '') {
    return failed(
      'git worktree list did not name the primary checkout first',
      NEXT_ACTION.runFromWorktree,
      0,
    );
  }
  // The scope step runs the audit from here, so it reads the primary's policy.
  ctx.primary = primary;

  // A repository without an origin remote falls back to the primary basename.
  const originRead = ctx.deps.run({
    kind: 'git',
    args: ['remote', 'get-url', REMOTE_NAME],
    cwd: worktree,
  });
  const originEnd = classifyEnd(originRead);
  if (originEnd.kind !== 'exit') {
    return failed(
      describeEnd(`git remote get-url ${REMOTE_NAME}`, originEnd),
      NEXT_ACTION.runFromWorktree,
      null,
    );
  }
  const origin = originEnd.status === 0 ? originRead.stdout.trim() : '';
  const repoName = resolveRepoName(origin, primary);
  if (!repoName.ok) {
    return failed(repoName.reason, NEXT_ACTION.runFromWorktree, 0);
  }

  const expected = join(
    dirname(primary),
    `${repoName.name}.${branch.replaceAll('/', '-')}`,
  );
  const expectedReal = ctx.deps.realpath(expected);
  if (expectedReal === null) {
    return failed(
      `the expected sibling worktree ${expected} does not exist or cannot be resolved`,
      NEXT_ACTION.runFromWorktree,
    );
  }
  const actualReal = ctx.deps.realpath(worktree);
  if (actualReal === null) {
    return failed(
      `the worktree ${worktree} cannot be resolved`,
      NEXT_ACTION.runFromWorktree,
    );
  }
  if (!samePath(expectedReal, actualReal)) {
    return failed(
      `the worktree ${actualReal} is not the sibling path ${expectedReal} of the claimed branch`,
      NEXT_ACTION.runFromWorktree,
      0,
    );
  }

  const current = readGit(ctx, ['branch', '--show-current']);
  if (!current.ok) {
    return failed(current.reason, NEXT_ACTION.switchBranch, current.exitStatus);
  }
  const currentBranch = current.stdout.trim();
  if (currentBranch === '') {
    return failed(
      'HEAD is detached; the worktree is on no branch',
      NEXT_ACTION.switchBranch,
      0,
    );
  }
  if (currentBranch !== branch) {
    return failed(
      `the worktree is on branch ${currentBranch}, not the claimed branch ${branch}`,
      NEXT_ACTION.switchBranch,
      0,
    );
  }
  return {
    status: 'passed',
    exitStatus: 0,
    reason: `the worktree ${actualReal} is the sibling path of ${branch} and is on that branch`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Read<T> = { ok: true; value: T } | { ok: false; failure: StepOutcome };

/** Run one allowed `gh` read in the worktree; any non-zero end refuses. */
function readGh(ctx: Context, args: readonly string[]): Read<string> {
  const result = ctx.deps.run({
    kind: 'gh',
    args,
    cwd: ctx.worktree ?? ctx.input.cwd,
  });
  const end = classifyEnd(result);
  const what = `gh ${args.slice(0, 2).join(' ')}`;
  if (end.kind === 'no-start') {
    return {
      ok: false,
      failure: failed(
        describeEnd(what, end),
        NEXT_ACTION.helperInstallation,
        null,
      ),
    };
  }
  if (end.kind === 'signal' || end.status !== 0) {
    return {
      ok: false,
      failure: failed(
        withDetail(
          describeEnd(what, end),
          end.kind === 'exit' ? firstLine(result.stderr) : '',
        ),
        NEXT_ACTION.stopAndReport,
        end.kind === 'exit' ? end.status : null,
      ),
    };
  }
  return { ok: true, value: result.stdout };
}

/** Item 4(a) of issue #4480: the issue title and body, both non-empty. */
function readIssue(ctx: Context): Read<{ title: string; body: string }> {
  const read = readGh(ctx, [
    'issue',
    'view',
    String(ctx.input.issue),
    '--json',
    'title,body',
  ]);
  if (!read.ok) {
    return read;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value);
  } catch {
    parsed = undefined;
  }
  const title = isRecord(parsed) ? parsed.title : undefined;
  const body = isRecord(parsed) ? parsed.body : undefined;
  if (typeof title !== 'string' || typeof body !== 'string') {
    return {
      ok: false,
      failure: failed(
        `gh issue view ${ctx.input.issue} did not print a JSON object with a title and a body`,
        NEXT_ACTION.stopAndReport,
        0,
      ),
    };
  }
  if (title.trim() === '' || body.trim() === '') {
    return {
      ok: false,
      failure: failed(
        `issue ${ctx.input.issue} has an empty ${title.trim() === '' ? 'title' : 'body'}`,
        NEXT_ACTION.stopAndReport,
        0,
      ),
    };
  }
  return { ok: true, value: { title: title.trim(), body } };
}

interface BaseState {
  base: string;
}

/**
 * Item 4(c): the effective base, which must exist on origin and as its
 * remote-tracking ref. A remote-tracking ref that is missing or differs from
 * the SHA `git ls-remote` prints is stale and refuses with the fetch next
 * action, naming both SHAs: a ref behind origin would add paths to the
 * branch-point diff, and a ref ahead of or diverged from origin (after a
 * force-push) would hide paths, so no verdict is trusted against either.
 */
function resolveBase(ctx: Context, policy: unknown): Read<BaseState> {
  let liveDefault: string | null = null;
  if (inspectDevelopmentBranch(policy).status === 'absent') {
    const read = readGh(ctx, REPO_DEFAULT_BRANCH_ARGS);
    if (!read.ok) {
      return read;
    }
    const name = read.value.trim();
    if (
      inspectDevelopmentBranch({ developmentBranch: name }).status !==
      'configured'
    ) {
      return {
        ok: false,
        failure: failed(
          `the live default branch name is unusable (${JSON.stringify(name)})`,
          NEXT_ACTION.stopAndReport,
          0,
        ),
      };
    }
    liveDefault = name;
  }
  const target = resolveEffectiveDevelopmentBranch(policy, liveDefault);
  if (
    (target.status !== 'configured' && target.status !== 'default') ||
    target.branch === undefined
  ) {
    return {
      ok: false,
      failure: failed(
        target.status === 'invalid'
          ? `the policy's developmentBranch is invalid: ${target.reason ?? 'unknown reason'}`
          : 'no development branch could be resolved',
        NEXT_ACTION.stopAndReport,
        null,
      ),
    };
  }
  const base = target.branch;
  const remote = readGit(ctx, ['ls-remote', '--heads', REMOTE_NAME, base]);
  if (!remote.ok) {
    return {
      ok: false,
      failure: failed(
        remote.reason,
        NEXT_ACTION.readGitError,
        remote.exitStatus,
      ),
    };
  }
  const remoteLine = remote.stdout
    .split(/\r?\n/u)
    .find((line) => line.trimEnd().endsWith(`\trefs/heads/${base}`));
  const remoteSha = remoteLine?.split('\t')[0]?.trim() ?? '';
  if (!GIT_OBJECT_ID.test(remoteSha)) {
    return {
      ok: false,
      failure: failed(
        `${REMOTE_NAME} has no branch ${base}`,
        NEXT_ACTION.stopAndReport,
        0,
      ),
    };
  }
  const tracking = ctx.deps.run({
    kind: 'git',
    args: [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${REMOTE_NAME}/${base}`,
    ],
    cwd: ctx.worktree ?? ctx.input.cwd,
  });
  const trackingEnd = classifyEnd(tracking);
  const trackingSha = tracking.stdout.trim();
  if (
    trackingEnd.kind === 'exit' &&
    trackingEnd.status === 1 &&
    trackingSha === ''
  ) {
    return {
      ok: false,
      failure: failed(
        `the base ${base} is stale: ${REMOTE_NAME} has ${remoteSha}, and refs/remotes/${REMOTE_NAME}/${base} is missing`,
        NEXT_ACTION.staleBase(base),
        1,
      ),
    };
  }
  if (trackingEnd.kind !== 'exit' || trackingEnd.status !== 0) {
    return {
      ok: false,
      failure: failed(
        withDetail(
          describeEnd(
            `git rev-parse refs/remotes/${REMOTE_NAME}/${base}`,
            trackingEnd,
          ),
          trackingEnd.kind === 'exit' ? firstLine(tracking.stderr) : '',
        ),
        NEXT_ACTION.readGitError,
        trackingEnd.kind === 'exit' ? trackingEnd.status : null,
      ),
    };
  }
  if (!GIT_OBJECT_ID.test(trackingSha)) {
    return {
      ok: false,
      failure: failed(
        `git rev-parse refs/remotes/${REMOTE_NAME}/${base} did not print an object id`,
        NEXT_ACTION.readGitError,
        0,
      ),
    };
  }
  if (trackingSha !== remoteSha) {
    return {
      ok: false,
      failure: failed(
        `the base ${base} is stale: ${REMOTE_NAME} has ${remoteSha}, and refs/remotes/${REMOTE_NAME}/${base} has ${trackingSha}`,
        NEXT_ACTION.staleBase(base),
        0,
      ),
    };
  }
  return { ok: true, value: { base } };
}

function gitPathList(stdout: string): string[] {
  return stdout.split('\0').filter((path) => path !== '');
}

/** The `syncPairs` targets of the manifest at the branch point. */
function readManifestTargets(
  ctx: Context,
  worktree: string,
  branchPoint: string,
): Read<Set<string>> {
  const read = ctx.deps.readBaseText(worktree, branchPoint, SYNC_MANIFEST_PATH);
  if (read.status === 'error') {
    return {
      ok: false,
      failure: failed(read.reason, NEXT_ACTION.readGitError, null),
    };
  }
  if (read.status === 'absent') {
    return { ok: true, value: new Set() };
  }
  const malformed = (detail: string): Read<Set<string>> => ({
    ok: false,
    failure: failed(
      `${SYNC_MANIFEST_PATH} at the branch point ${branchPoint} is malformed: ${detail}`,
      NEXT_ACTION.stopAndReport,
      null,
    ),
  });
  let manifest: unknown;
  try {
    manifest = JSON.parse(read.text);
  } catch (error) {
    return malformed(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(manifest)) {
    return malformed('it is not a JSON object');
  }
  const pairs = manifest.syncPairs;
  if (pairs === undefined) {
    return { ok: true, value: new Set() };
  }
  if (!Array.isArray(pairs)) {
    return malformed('syncPairs is not an array');
  }
  const targets = new Set<string>();
  for (const pair of pairs) {
    const target = isRecord(pair) ? pair.target : undefined;
    if (typeof target !== 'string' || target === '') {
      return malformed('a syncPairs entry has no target');
    }
    targets.add(target);
  }
  return { ok: true, value: targets };
}

/**
 * Item 4(d): every path the branch changed since its branch point, committed
 * or not, minus the generated copies and the sync-manifest targets that exist
 * at the branch point. Both exclusions read the branch point, never the
 * branch, so a branch cannot exclude its own files.
 */
function readCanonicalPaths(
  ctx: Context,
  base: string,
): Read<{ branchPoint: string; paths: string[] }> {
  const worktree = ctx.worktree ?? ctx.input.cwd;
  const gitFailure = (read: GitRead & { ok: false }): Read<never> => ({
    ok: false,
    failure: failed(read.reason, NEXT_ACTION.readGitError, read.exitStatus),
  });
  const mergeBase = readGit(ctx, [
    'merge-base',
    `refs/remotes/${REMOTE_NAME}/${base}`,
    'HEAD',
  ]);
  if (!mergeBase.ok) {
    return gitFailure(mergeBase);
  }
  const branchPoint = mergeBase.stdout.trim();
  if (!GIT_OBJECT_ID.test(branchPoint)) {
    return {
      ok: false,
      failure: failed(
        'git merge-base did not print an object id',
        NEXT_ACTION.readGitError,
        0,
      ),
    };
  }
  // -z keeps core.quotePath from quoting a path; --no-renames lists both
  // sides of a rename.
  const diff = readGit(ctx, [
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    branchPoint,
  ]);
  if (!diff.ok) {
    return gitFailure(diff);
  }
  const untracked = readGit(ctx, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (!untracked.ok) {
    return gitFailure(untracked);
  }
  const changed = [
    ...new Set([...gitPathList(diff.stdout), ...gitPathList(untracked.stdout)]),
  ].sort();

  const targets = readManifestTargets(ctx, worktree, branchPoint);
  if (!targets.ok) {
    return targets;
  }
  const paths: string[] = [];
  for (const path of changed) {
    if (targets.value.has(path)) {
      continue;
    }
    const text = ctx.deps.readBaseText(worktree, branchPoint, path);
    if (text.status === 'error') {
      return {
        ok: false,
        failure: failed(text.reason, NEXT_ACTION.readGitError, null),
      };
    }
    if (text.status === 'present') {
      const banner = GENERATED_SOURCE_BANNER_PATTERN.exec(
        Buffer.from(text.text, 'utf8')
          .subarray(0, GENERATED_BANNER_SCAN_BYTES)
          .toString('utf8'),
      );
      if (banner?.[1] !== undefined && banner[1] !== path) {
        continue;
      }
    }
    paths.push(path);
  }
  if (paths.length === 0) {
    return {
      ok: false,
      failure: failed(
        `the branch changed no canonical path since its branch point ${branchPoint}`,
        NEXT_ACTION.stopAndReport,
        0,
      ),
    };
  }
  return { ok: true, value: { branchPoint, paths } };
}

/** The canonical `## Candidate files` section the copy leads with. */
function canonicalSection(paths: readonly string[]): string {
  return `## Candidate files\n\n${paths.map((path) => `- \`${path}\``).join('\n')}\n\n`;
}

/** Whether the body has an ATX heading after its first line, as the parser masks it. */
function hasHeadingAfterFirstLine(body: string): boolean {
  return maskMarkdownForScan(body, {
    inlineCode: 'keep',
    htmlComments: 'mask',
    htmlBlocks: 'mask',
  })
    .split(/\r?\n/u)
    .slice(1)
    .some((line) => ATX_HEADING.test(line));
}

type AuditVerdict =
  | { ok: true; result: 'pass' | 'fail'; detail: string; exitStatus: number }
  | { ok: false; failure: StepOutcome };

/** The `effort-candidate-file-limit` finding of one audit's JSON report. */
function effortFindingOf(
  stdout: string,
): { result: 'pass' | 'fail'; detail: string } | 'malformed' | 'missing' {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return 'malformed';
  }
  if (!isRecord(report) || !Array.isArray(report.findings)) {
    return 'malformed';
  }
  const finding = report.findings.find(
    (entry: unknown) => isRecord(entry) && entry.id === EFFORT_FINDING_ID,
  ) as Record<string, unknown> | undefined;
  if (finding === undefined) {
    return 'missing';
  }
  if (finding.result !== 'pass' && finding.result !== 'fail') {
    return 'malformed';
  }
  return {
    result: finding.result,
    detail: typeof finding.detail === 'string' ? finding.detail : '',
  };
}

/** Item 5: one audit run; its exit status is not the verdict. */
function runAudit(
  ctx: Context,
  label: string,
  body: string,
  markerPrefix: string,
  title: string,
): AuditVerdict {
  const result = ctx.deps.run({
    kind: 'helper',
    script: AUDIT_SCRIPT,
    args: [
      '--shape',
      'child',
      '--stdin',
      '--marker-prefix',
      markerPrefix,
      '--title',
      title,
    ],
    cwd: ctx.primary ?? ctx.input.cwd,
    stdin: body,
  });
  const end = classifyEnd(result);
  const what = `the audit of ${label}`;
  if (end.kind === 'no-start') {
    return {
      ok: false,
      failure: failed(
        describeEnd(what, end),
        NEXT_ACTION.helperInstallation,
        null,
      ),
    };
  }
  if (end.kind === 'signal') {
    return {
      ok: false,
      failure: failed(describeEnd(what, end), NEXT_ACTION.stopAndReport, null),
    };
  }
  const finding = effortFindingOf(result.stdout);
  if (finding === 'malformed' || finding === 'missing') {
    return {
      ok: false,
      failure: failed(
        withDetail(
          `${describeEnd(what, end)} ${
            finding === 'malformed'
              ? 'and did not print one JSON object with a findings array'
              : `and reported no ${EFFORT_FINDING_ID} finding`
          }`,
          firstLine(result.stderr),
        ),
        NEXT_ACTION.stopAndReport,
        end.status,
      ),
    };
  }
  return { ok: true, ...finding, exitStatus: end.status };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * The B3 scope check of `idd-work.instructions.md`, read-only. It reads the
 * issue, the primary checkout's policy, and the base, builds the canonical
 * paths, and runs `audit-authored-issue` on the issue body and on a copy that
 * leads with those paths as its `## Candidate files` section. The verdict of
 * each run is its `effort-candidate-file-limit` finding.
 */
function stepScope(ctx: Context): StepOutcome {
  const { worktree, primary } = ctx;
  if (worktree === null || primary === null) {
    // Unreachable: a passed location step sets both values.
    throw new Error(
      'claimed-push: the scope step ran without a passed location',
    );
  }
  const policyRead = ctx.deps.readPolicy(worktree);
  if (!policyRead.ok) {
    return failed(policyRead.reason, NEXT_ACTION.stopAndReport, null);
  }
  const policy = policyRead.policy ?? null;

  const issue = readIssue(ctx);
  if (!issue.ok) {
    return issue.failure;
  }
  const markerPrefix = normalizeMarkerPrefix(
    isRecord(policy) ? policy.markerPrefix : undefined,
  );
  const baseRead = resolveBase(ctx, policy);
  if (!baseRead.ok) {
    return baseRead.failure;
  }
  const { base } = baseRead.value;
  const canonical = readCanonicalPaths(ctx, base);
  if (!canonical.ok) {
    return canonical.failure;
  }
  const { paths } = canonical.value;
  const { title, body } = issue.value;

  if (!hasHeadingAfterFirstLine(body)) {
    return failed(
      `issue ${ctx.input.issue}'s body has no heading after its first line, so a leading ## Candidate files section would run to the end of the body`,
      NEXT_ACTION.stopAndReport,
      0,
    );
  }
  const section = canonicalSection(paths);
  const copy = `${section}${body}`;
  const sectionKeys = ctx.deps.parseCandidates(section);
  if (!sameList(ctx.deps.parseCandidates(copy), sectionKeys)) {
    return failed(
      'the copy of the body does not parse to exactly the canonical ## Candidate files section, so the audit would not count the canonical paths',
      NEXT_ACTION.stopAndReport,
      null,
    );
  }
  const counted = `${paths.length} canonical path(s), which the audit counts as ${sectionKeys.length} (${paths.join(', ')}); ${AUDIT_COUNT_RULE}`;

  const original = runAudit(ctx, 'the issue body', body, markerPrefix, title);
  if (!original.ok) {
    return original.failure;
  }
  const scoped = runAudit(
    ctx,
    'the body with the canonical paths',
    copy,
    markerPrefix,
    title,
  );
  if (!scoped.ok) {
    return scoped.failure;
  }
  if (original.result === 'pass' && scoped.result === 'pass') {
    return {
      status: 'passed',
      exitStatus: 0,
      reason: `${EFFORT_FINDING_ID} passes on the issue body (${original.detail}) and with the canonical paths (${scoped.detail}); ${counted}`,
    };
  }
  const parts = [
    ...(original.result === 'fail'
      ? [`${EFFORT_FINDING_ID} fails on the issue body: ${original.detail}`]
      : []),
    ...(scoped.result === 'fail'
      ? [
          `${EFFORT_FINDING_ID} fails with the canonical paths: ${scoped.detail}`,
        ]
      : []),
    counted,
  ];
  return failed(
    parts.join('; '),
    NEXT_ACTION.scopeOverrun,
    original.result === 'fail' ? original.exitStatus : scoped.exitStatus,
  );
}

/** A failed outcome when the tree is dirty or unreadable, else null. */
function checkCleanTree(
  ctx: Context,
  when: 'before' | 'after',
): StepOutcome | null {
  // --ignore-submodules=none overrides diff.ignoreSubmodules and
  // submodule.<name>.ignore, which would otherwise hide a dirty submodule.
  const status = readGit(ctx, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (!status.ok) {
    return failed(status.reason, NEXT_ACTION.readGitError, status.exitStatus);
  }
  const lines = status.stdout.split(/\r?\n/u).filter((line) => line !== '');
  if (lines.length === 0) {
    return null;
  }
  const shown = lines.slice(0, MAX_STATUS_LINES).join('\n');
  const more =
    lines.length > MAX_STATUS_LINES
      ? `\n... and ${lines.length - MAX_STATUS_LINES} more`
      : '';
  return failed(
    `the working tree is not clean ${when} the gate:\n${shown}${more}`,
    when === 'before'
      ? NEXT_ACTION.commitThenRerun
      : NEXT_ACTION.commitOrDiscard,
    0,
  );
}

function stepGate(ctx: Context): StepOutcome {
  const dirty = checkCleanTree(ctx, 'before');
  if (dirty !== null) {
    return dirty;
  }
  const head = readHead(ctx);
  if (head.failure !== undefined) {
    return head.failure;
  }
  ctx.recordedHead = head.sha;

  const gate = ctx.deps.readGateCommand(ctx.worktree ?? ctx.input.cwd);
  if (!gate.ok) {
    return failed(gate.reason, NEXT_ACTION.configureGate);
  }
  const result = ctx.deps.run({
    kind: 'gate',
    command: gate.command,
    cwd: ctx.worktree ?? ctx.input.cwd,
  });
  const end = classifyEnd(result);
  const what = 'commands.pre-push-validate';
  if (end.kind === 'no-start') {
    return failed(describeEnd(what, end), NEXT_ACTION.configureGate, null);
  }
  if (end.kind === 'signal') {
    return failed(describeEnd(what, end), NEXT_ACTION.fixThenRerun, null);
  }
  if (end.status !== 0) {
    return failed(describeEnd(what, end), NEXT_ACTION.fixThenRerun, end.status);
  }
  const after = checkCleanTree(ctx, 'after');
  if (after !== null) {
    return after;
  }
  return {
    status: 'passed',
    exitStatus: 0,
    reason: `${what} exited 0 and left the working tree clean`,
  };
}

function stepReassert(ctx: Context): StepOutcome {
  const { outcome, branch } = runAssert(ctx);
  if (outcome.status === 'failed') {
    return outcome;
  }
  if (branch !== ctx.branch) {
    return failed(
      `the second claim assert names branch ${branch}, not the claimed branch ${ctx.branch}`,
      NEXT_ACTION.staleClaim,
      0,
    );
  }
  const head = readHead(ctx);
  if (head.failure !== undefined) {
    return head.failure;
  }
  const sha = head.sha;
  if (sha !== ctx.recordedHead) {
    return failed(
      `HEAD moved from ${ctx.recordedHead} to ${sha} while the gate ran`,
      NEXT_ACTION.rerunForHead,
      0,
    );
  }
  const tip = readGit(ctx, [
    'rev-parse',
    '--verify',
    `refs/heads/${ctx.branch}`,
  ]);
  if (!tip.ok) {
    return failed(tip.reason, NEXT_ACTION.readGitError, tip.exitStatus);
  }
  if (tip.stdout.trim() !== ctx.recordedHead) {
    return failed(
      `the tip of ${ctx.branch} is ${tip.stdout.trim()}, not the gated commit ${ctx.recordedHead}`,
      NEXT_ACTION.rerunForHead,
      0,
    );
  }
  return {
    ...outcome,
    reason: `${outcome.reason}; HEAD and the branch tip are still ${sha}`,
  };
}

function gitMessage(result: CommandResult): string {
  return [result.stderr.trim(), result.stdout.trim()]
    .filter((part) => part !== '')
    .join('\n');
}

function stepPush(ctx: Context): StepOutcome {
  const branch = ctx.branch ?? '';
  const upstream = ctx.deps.run({
    kind: 'git',
    args: [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      `${branch}@{upstream}`,
    ],
    cwd: ctx.worktree ?? ctx.input.cwd,
  });
  const upstreamEnd = classifyEnd(upstream);
  if (upstreamEnd.kind !== 'exit') {
    ctx.pushed = false;
    return failed(
      describeEnd('the upstream check', upstreamEnd),
      NEXT_ACTION.readGitError,
      null,
    );
  }
  const args =
    upstreamEnd.status === 0
      ? ['push', REMOTE_NAME, branch]
      : ['push', '-u', REMOTE_NAME, branch];
  const result = ctx.deps.run({
    kind: 'git',
    args,
    cwd: ctx.worktree ?? ctx.input.cwd,
  });
  const end = classifyEnd(result);
  if (end.kind !== 'exit') {
    ctx.pushed = null;
    return failed(
      `${describeEnd('git push', end)}; the push may or may not have reached the remote`,
      NEXT_ACTION.pushUnknown,
      null,
    );
  }
  const message = gitMessage(result);
  if (end.status !== 0) {
    ctx.pushed = false;
    return failed(
      withDetail(describeEnd('git push', end), message),
      NEXT_ACTION.pushRejected(branch),
      end.status,
    );
  }
  ctx.pushed = true;
  ctx.pushedSha = ctx.recordedHead;
  ctx.pushMessage = message;
  return {
    status: 'passed',
    exitStatus: 0,
    reason: `pushed ${branch} to ${REMOTE_NAME}${upstream.status === 0 ? '' : ' and set its upstream'}`,
  };
}

const STEPS: ReadonlyArray<{
  id: ClaimedPushStepId;
  run: (ctx: Context) => StepOutcome;
  /** Steps that run only with `--apply`. */
  applyOnly: boolean;
}> = [
  { id: 'assert', run: stepAssert, applyOnly: false },
  { id: 'location', run: stepLocation, applyOnly: false },
  { id: 'scope', run: stepScope, applyOnly: false },
  { id: 'gate', run: stepGate, applyOnly: true },
  { id: 'reassert', run: stepReassert, applyOnly: true },
  { id: 'push', run: stepPush, applyOnly: true },
];

/**
 * Run the six steps in order, stopping at the first failure. Without
 * `input.apply`, only the claim assert, the location check, and the scope
 * check run. The report always lists all six steps; the ones not run are
 * `skipped`.
 */
export function runClaimedPush(
  input: ClaimedPushInput,
  deps: ClaimedPushDeps = createProductionDeps(),
): ClaimedPushReport {
  const ctx: Context = {
    input,
    deps,
    worktree: null,
    primary: null,
    branch: null,
    recordedHead: null,
    pushed: false,
    pushedSha: null,
    pushMessage: null,
  };
  const steps: ClaimedPushStep[] = [];
  let failedStep: ClaimedPushStepId | null = null;
  for (const step of STEPS) {
    if (failedStep !== null) {
      steps.push({
        id: step.id,
        status: 'skipped',
        reason: `skipped because the ${failedStep} step failed`,
      });
    } else if (step.applyOnly && !input.apply) {
      steps.push({
        id: step.id,
        status: 'skipped',
        reason: 'dry run: --apply was not given',
      });
    } else {
      const outcome = step.run(ctx);
      steps.push({ id: step.id, ...outcome });
      if (outcome.status === 'failed') {
        failedStep = step.id;
      }
    }
  }
  return {
    mode: input.apply ? 'apply' : 'dry-run',
    pushed: ctx.pushed,
    issue: input.issue,
    branch: ctx.branch,
    worktree: ctx.worktree,
    steps,
    ...(ctx.pushed === true && ctx.pushedSha !== null
      ? { pushedSha: ctx.pushedSha, pushMessage: ctx.pushMessage ?? '' }
      : {}),
  };
}

function fromSpawn(result: ReturnType<typeof spawnSync>): CommandResult {
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
}

/**
 * The two argument lists the `gh` kind runs: the issue read and the
 * default-branch read. Every other list is refused before any process starts.
 */
function isAllowedGhRead(args: readonly string[]): boolean {
  if (
    args.length === 5 &&
    args[0] === 'issue' &&
    args[1] === 'view' &&
    /^[1-9][0-9]*$/u.test(args[2] ?? '') &&
    args[3] === '--json' &&
    args[4] === 'title,body'
  ) {
    return true;
  }
  return sameList(args, REPO_DEFAULT_BRANCH_ARGS);
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

/**
 * Run an allowed `gh` read through the repository's `gh` layer. `ghText`
 * takes no directory and runs in this process's directory, the worktree; `gh`
 * resolves the repository from the git remote the worktree shares with the
 * primary checkout.
 */
function runGhRead(args: readonly string[]): CommandResult {
  if (!isAllowedGhRead(args)) {
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: `the gh kind refuses this argument list: gh ${args.join(' ')}`,
    };
  }
  try {
    return {
      status: 0,
      signal: null,
      stdout: ghText([...args], GH_TEXT_LOOP_TIMEOUT_OPTIONS),
      stderr: '',
    };
  } catch (error) {
    const fields = isRecord(error) ? error : {};
    const status = typeof fields.status === 'number' ? fields.status : null;
    const signal =
      typeof fields.signal === 'string' && fields.signal !== ''
        ? fields.signal
        : null;
    return {
      status,
      signal,
      stdout: outputText(fields.stdout),
      stderr: outputText(fields.stderr),
      ...(status === null
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
    };
  }
}

/**
 * The production runner. It never throws: a failure to resolve or spawn is a
 * result with no exit status, so a refusal always reaches the JSON report.
 * The gate runs through a shell with no timeout, and its stdout goes to this
 * process's stderr so that stdout carries only the report.
 */
export function runProductionCommand(request: CommandRequest): CommandResult {
  try {
    if (request.kind === 'gate') {
      return fromSpawn(
        spawnSync(request.command, {
          cwd: request.cwd,
          shell: true,
          stdio: ['ignore', 2, 2],
        }),
      );
    }
    if (request.kind === 'gh') {
      return runGhRead(request.args);
    }
    let file = 'git';
    let args: readonly string[] = request.kind === 'git' ? request.args : [];
    let stdin: string | undefined;
    if (request.kind === 'helper') {
      stdin = request.stdin;
      const script = join(
        resolveBundleRoot(import.meta.dirname),
        'scripts',
        request.script,
      );
      if (!existsSync(script)) {
        return {
          status: null,
          signal: null,
          stdout: '',
          stderr: '',
          error: `${script} does not exist`,
        };
      }
      file = process.execPath;
      args = [script, ...request.args];
    }
    return fromSpawn(
      spawnSync(file, [...args], {
        cwd: request.cwd,
        encoding: 'utf8',
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(stdin === undefined ? {} : { input: stdin }),
        maxBuffer: MAX_BUFFER_BYTES,
      }),
    );
  } catch (error) {
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return null;
  }
}

/**
 * Read the effective `commands.pre-push-validate` for one worktree. The
 * policy loaders resolve `.github/idd/config.json` from the directory they
 * are given, so the worktree path is passed explicitly. The value is the
 * layered policy's: the repository file wins leaf by leaf, and the
 * user-global tier supplies a command the repository omits, which is how an
 * installed payload serves a repository with a minimal policy file
 * (`commands` is not a repository-owned field in `layered-policy.mts`). A
 * repository policy file that cannot be read refuses instead of falling
 * through to a user-global entry.
 */
export function readEffectiveGateCommand(
  worktree: string,
  options: { env?: NodeJS.ProcessEnv; homedir?: string } = {},
): GateCommandRead {
  try {
    const loaded = loadLayeredLocalPolicy({
      cwd: worktree,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.homedir === undefined ? {} : { homedir: options.homedir }),
    });
    if (loaded.local.diagnostic !== undefined) {
      return {
        ok: false,
        reason: `the repository policy is unreadable: ${loaded.local.diagnostic}`,
      };
    }
    const commands = loaded.config?.commands;
    const value =
      typeof commands === 'object' && commands !== null
        ? (commands as Record<string, unknown>)['pre-push-validate']
        : undefined;
    if (typeof value !== 'string' || value.trim() === '') {
      return {
        ok: false,
        reason:
          'commands.pre-push-validate is not configured in the effective policy',
      };
    }
    return { ok: true, command: value.trim() };
  } catch (error) {
    return {
      ok: false,
      reason: `could not read the effective policy: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Read the layered effective policy of the primary checkout: the first record
 * of `git worktree list --porcelain -z` run from the worktree, then the same
 * loader the claim uses, with the primary as its directory. The branch's own
 * copy of the policy is never read. A null policy means no tier has a file.
 * A repository policy file that cannot be read refuses.
 */
export function readPrimaryPolicy(
  worktree: string,
  options: { env?: NodeJS.ProcessEnv; homedir?: string } = {},
): PolicyRead {
  try {
    const list = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: worktree,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER_BYTES,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (list.error !== undefined || list.status !== 0) {
      return {
        ok: false,
        reason: withDetail(
          'git worktree list could not be read',
          list.error?.message ?? firstLine(list.stderr ?? ''),
        ),
      };
    }
    const main = parseLocalWorktreeList(list.stdout)[0];
    if (main === undefined || main.path === '' || main.bare) {
      return {
        ok: false,
        reason: 'git worktree list names no primary checkout',
      };
    }
    const loaded = loadLayeredLocalPolicy({
      cwd: main.path,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.homedir === undefined ? {} : { homedir: options.homedir }),
    });
    if (loaded.local.diagnostic !== undefined) {
      return {
        ok: false,
        reason: `the repository policy of the primary checkout ${main.path} is unreadable: ${loaded.local.diagnostic}`,
      };
    }
    return { ok: true, policy: loaded.config ?? null };
  } catch (error) {
    return {
      ok: false,
      reason: `could not read the policy of the primary checkout: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * A `readBaseText` built on a command runner: `git ls-tree -z <branch point>
 * -- <path>` prints nothing and exits 0 for a path absent there, and `git show
 * <branch point>:<path>` reads a present file. An entry that is not a file
 * (a submodule) is present with no text. Any other git failure is an error.
 */
export function makeBaseTextReader(
  run: CommandRunner,
): ClaimedPushDeps['readBaseText'] {
  return (worktree, branchPoint, path) => {
    const describe = (what: string, result: CommandResult): string => {
      const end = classifyEnd(result);
      return withDetail(
        describeEnd(what, end),
        end.kind === 'exit' ? firstLine(result.stderr) : '',
      );
    };
    const listing = run({
      kind: 'git',
      args: ['ls-tree', '-z', branchPoint, '--', path],
      cwd: worktree,
    });
    if (listing.status !== 0) {
      return {
        status: 'error',
        reason: describe(`git ls-tree ${branchPoint} -- ${path}`, listing),
      };
    }
    const entry = listing.stdout.split('\0').find((line) => line !== '');
    if (entry === undefined) {
      return { status: 'absent' };
    }
    if (entry.split(/\s/u)[1] !== 'blob') {
      return { status: 'present', text: '' };
    }
    const shown = run({
      kind: 'git',
      args: ['show', `${branchPoint}:${path}`],
      cwd: worktree,
    });
    if (shown.status !== 0) {
      return {
        status: 'error',
        reason: describe(`git show ${branchPoint}:${path}`, shown),
      };
    }
    return { status: 'present', text: shown.stdout };
  };
}

export function createProductionDeps(): ClaimedPushDeps {
  return {
    run: runProductionCommand,
    realpath: realpathOrNull,
    readGateCommand: (worktree) => readEffectiveGateCommand(worktree),
    readPolicy: (worktree) => readPrimaryPolicy(worktree),
    readBaseText: makeBaseTextReader(runProductionCommand),
    parseCandidates: parseCandidateFiles,
  };
}

export function parseArgs(argv: string[]): {
  help: boolean;
  issue: number | null;
  claimId: string | null;
  nonce: string | null;
  apply: boolean;
} {
  const { values, help } = parseCliArgs(argv, CLAIMED_PUSH_FLAG_SPEC);
  const apply = values.apply === true;
  if (help) {
    return { help, issue: null, claimId: null, nonce: null, apply };
  }
  const issue = parseCanonicalIntegerOrThrow(
    requireFlag(values.issue, '--issue'),
    '--issue',
  );
  const claimId = requireFlag(values['claim-id'], '--claim-id');
  const nonceValue = values.nonce as string | undefined;
  if (nonceValue !== undefined && nonceValue.trim() === '') {
    throw markCliUsageError(new Error('--nonce must not be empty'));
  }
  return { help, issue, claimId, nonce: nonceValue?.trim() ?? null, apply };
}

function printUsage(stdout: { write: (text: string) => unknown }): void {
  stdout.write(
    `Usage:\n  node scripts/claimed-push.mjs --issue <n> --claim-id <id> [--nonce <nonce>] [--apply]\n\n` +
      'Pushes the claimed branch to origin only after the claim, the worktree\n' +
      'location, the scope check, and the configured pre-push gate have passed\n' +
      'in order, then re-checks the claim and the gated commit just before the\n' +
      'push. The six steps are assert, location, scope, gate, reassert, and\n' +
      'push. The scope step runs audit-authored-issue on the issue body and on\n' +
      'a copy whose leading ## Candidate files section lists the paths the\n' +
      'branch changed since its branch point, and fails when either\n' +
      'effort-candidate-file-limit finding fails.\n' +
      'Dry-run is the default: it runs the claim assert, the location check,\n' +
      'and the scope check, skips the gate, the second assert, and the push,\n' +
      'and exits 0 when all three pass. --apply runs all six steps and pushes\n' +
      'once. The helper never forces, never retries, and never creates a\n' +
      'commit. --nonce is passed to the claim check only when given.\n',
  );
}

/**
 * Parse `argv`, run the steps, and write the JSON report to `stdout`. Exits
 * `0` only when no step failed.
 */
export function runCli(
  argv: string[],
  deps: ClaimedPushDeps = createProductionDeps(),
  options: {
    cwd?: string;
    stdout?: { write: (text: string) => unknown };
  } = {},
): HelperCliResult {
  const args = parseArgs(argv);
  const stdout = options.stdout ?? process.stdout;
  if (args.help || args.issue === null || args.claimId === null) {
    printUsage(stdout);
    return 0;
  }
  const report = runClaimedPush(
    {
      issue: args.issue,
      claimId: args.claimId,
      nonce: args.nonce,
      apply: args.apply,
      cwd: options.cwd ?? process.cwd(),
    },
    deps,
  );
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.steps.some((step) => step.status === 'failed') ? 1 : 0;
}

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('claimed-push', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}

function main(): HelperCliResult {
  return runCli(process.argv.slice(2));
}
