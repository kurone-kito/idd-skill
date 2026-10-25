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
// assert, every git and gh read, the audit, the gate, and the push. The gate
// is the only child that runs through host-local admission (issue #4525): the
// payload's own `idd-local-admission -- /bin/sh -c <gate>`, except on Windows,
// where it runs in a shell directly as before.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mjs';
import {
  parseCanonicalIntegerOrThrow,
  parseCliArgs,
  requireFlag,
} from './cli-args.mjs';
import { GENERATED_SOURCE_BANNER_PATTERN } from './consistency-helpers.mjs';
import { parseCandidateFiles } from './discover-shared-file-overlap.mjs';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mjs';
import { isNotDispatchedRefusal } from './github-api-refusal.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadLayeredLocalPolicy } from './idd-config.mjs';
import { parseLocalWorktreeList } from './local-worktree-occupancy.mjs';
import { maskMarkdownForScan } from './markdown-code.mjs';
import { normalizeMarkerPrefix } from './marker-helpers.mjs';
import {
  inspectDevelopmentBranch,
  resolveEffectiveDevelopmentBranch,
} from './policy-helpers.mjs';

const CLAIMED_PUSH_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--nonce': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
};
/** The remote is fixed: the helper never takes a remote argument. */
const REMOTE_NAME = 'origin';
/** The claim assert is the existing helper, run as a child process. */
const CLAIM_ASSERT_SCRIPT = 'resume-claim-routing.mjs';
/** The scope check runs the existing authored-issue audit as it stands. */
const AUDIT_SCRIPT = 'audit-authored-issue.mjs';
/** The gate runs through the payload's own host-local admission helper. */
const LOCAL_ADMISSION_SCRIPT = 'idd-local-admission.mjs';
/**
 * The shell the admitted gate string goes to, as one argv element after `-c`.
 * It is the shell `shell: true` uses on POSIX, so the string parses as before.
 */
const GATE_SHELL = '/bin/sh';
/** Exit status of an admission wait that reached `maxWait` (issue #4428). */
const ADMISSION_EXPIRED_STATUS = 75;
/** Exit status of an admission refusal, or of a stop it could not deliver. */
const ADMISSION_REFUSED_STATUS = 2;
/** The one audit finding the scope step reads. */
const EFFORT_FINDING_ID = 'effort-candidate-file-limit';
/** The sync manifest, read at the branch point for its `syncPairs` targets. */
const SYNC_MANIFEST_PATH = 'audit/sync-manifest.json';
/** Modes whose `target` is a generated copy rather than a canonical path. */
const GENERATED_SYNC_PAIR_MODES = new Set(['exact', 'concreted']);
/** Every sync-pair mode the scope check can classify. */
const SUPPORTED_SYNC_PAIR_MODES = new Set([
  'exact',
  'concreted',
  'contains',
  'structure',
]);
/** The only default-branch read the `gh` kind runs. */
const REPO_DEFAULT_BRANCH_ARGS = [
  'repo',
  'view',
  '--json',
  'defaultBranchRef',
  '--jq',
  '.defaultBranchRef.name',
];
/** An ATX heading, as the `## Candidate files` parser recognizes one. */
const ATX_HEADING = /^ {0,3}#{1,6}\s+/u;
/*
 * The parser's Setext rules (`discover-shared-file-overlap.mts`, which does
 * not export them): an underline ends the section when the line over it is
 * a non-blank paragraph line, not a list item, a quote, or a list item's
 * indented continuation.
 */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const LIST_OR_QUOTE_LINE = /^ {0,3}(?:[-*+][ \t]+|\d+[.)][ \t]+|>)/u;
const INDENTED_LINE = /^[ \t]+\S/u;
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
  admissionExpired:
    'if the stderr above has a "local-admission: expired" line (a helper error envelope JSON line can follow it), the gate did not start: report it, and do not rerun the helper or push by hand; otherwise the gate itself exited 75: fix the failure, commit, and rerun',
  admissionRefused:
    'if the stderr above has a "local-admission:" line that ends with "command not started" (admission refused before the gate started) or says the lock stays held until the command exits (the gate started and could not be stopped), stop and report without changing the repository policy, and do not rerun; otherwise the gate itself exited 2: fix the failure, commit, and rerun',
  commitOrDiscard: 'commit or discard what the gate changed, then rerun',
  rerunForHead: 'rerun the helper so the gate sees the new HEAD',
  readGitError: 'read the git error in the worktree and fix it, then rerun',
  pushRejected: (branch) =>
    `read git's message, fetch and inspect ${REMOTE_NAME}/${branch}, never force`,
  pushUnknown: 'read the remote branch before any new push, no retry',
  scopeOverrun:
    'stop without pushing and follow the Scope overrun rule in idd-work.instructions.md',
  staleBase: (base) =>
    `run node scripts/clone-lock.mjs --exec --agent-id <your agent id> -- git fetch ${REMOTE_NAME} +refs/heads/${base}:refs/remotes/${REMOTE_NAME}/${base} (see docs/idd-helper-scripts.md, "Clone-scoped lock"), then rerun the helper once; if the base is still stale, stop, report both SHAs, and do not push`,
};
function classifyEnd(result) {
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
function firstLine(text) {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}
function withDetail(summary, detail) {
  return detail === '' ? summary : `${summary}: ${detail}`;
}
function failed(reason, nextAction, exitStatus) {
  return {
    status: 'failed',
    reason,
    nextAction,
    ...(exitStatus === undefined ? {} : { exitStatus }),
  };
}
function describeEnd(what, end) {
  if (end.kind === 'exit') {
    return `${what} exited ${end.status}`;
  }
  if (end.kind === 'signal') {
    return withDetail(`${what} was killed by signal ${end.signal}`, end.detail);
  }
  return `${what} could not start: ${end.detail}`;
}
/** Run one git read in the worktree; any non-zero end is a failed read. */
function readGit(ctx, args, cwd = ctx.worktree) {
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
function readHead(ctx) {
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
function runAssert(ctx) {
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
function claimedBranchOf(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const claim =
      typeof parsed === 'object' && parsed !== null
        ? parsed.active_claim
        : undefined;
    const branch =
      typeof claim === 'object' && claim !== null ? claim.branch : undefined;
    return typeof branch === 'string' && branch.trim() !== ''
      ? branch.trim()
      : null;
  } catch {
    return null;
  }
}
function stepAssert(ctx) {
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
function resolveRepoName(origin, primary) {
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
function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
function stepLocation(ctx) {
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
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Run one allowed `gh` read in the worktree; any non-zero end refuses. */
function readGh(ctx, args) {
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
      failure: result.notDispatched
        ? failed(
            withDetail(
              `${what} was refused by GitHub API load control before it started`,
              end.detail,
            ),
            NEXT_ACTION.stopAndReport,
            null,
          )
        : failed(describeEnd(what, end), NEXT_ACTION.helperInstallation, null),
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
function readIssue(ctx) {
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
  let parsed;
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
/**
 * Item 4(c): the effective base, which must exist on origin and as its
 * remote-tracking ref. A remote-tracking ref that is missing or differs from
 * the SHA `git ls-remote` prints is stale and refuses with the fetch next
 * action, naming both SHAs: a ref behind origin would add paths to the
 * branch-point diff, and a ref ahead of or diverged from origin (after a
 * force-push) would hide paths, so no verdict is trusted against either.
 */
function resolveBase(ctx, policy) {
  let liveDefault = null;
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
function gitPathList(stdout) {
  return stdout.split('\0').filter((path) => path !== '');
}
/** Generated-copy targets in the branch-point manifest's `syncPairs`. */
function readGeneratedSyncTargets(ctx, worktree, branchPoint) {
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
  const malformed = (detail) => ({
    ok: false,
    failure: failed(
      `${SYNC_MANIFEST_PATH} at the branch point ${branchPoint} is malformed: ${detail}`,
      NEXT_ACTION.stopAndReport,
      null,
    ),
  });
  let manifest;
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
  const targets = new Set();
  for (const [index, pair] of pairs.entries()) {
    const target = isRecord(pair) ? pair.target : undefined;
    if (typeof target !== 'string' || target === '') {
      return malformed(`syncPairs entry ${index + 1} has no target`);
    }
    const mode = isRecord(pair) ? pair.mode : undefined;
    if (typeof mode !== 'string') {
      return malformed(`syncPairs entry ${index + 1} has no string mode`);
    }
    if (!SUPPORTED_SYNC_PAIR_MODES.has(mode)) {
      return malformed(
        `syncPairs entry ${index + 1} has unsupported mode ${JSON.stringify(mode)}`,
      );
    }
    if (GENERATED_SYNC_PAIR_MODES.has(mode)) {
      targets.add(target);
    }
  }
  return { ok: true, value: targets };
}
/**
 * Item 4(d): every path the branch changed since its branch point, committed
 * or not, minus generated copies and branch-point `syncPairs` targets whose
 * mode is `exact` or `concreted`. `contains` and `structure` targets remain
 * canonical. Both exclusions read the branch point, never the branch, so a
 * branch cannot exclude its own files.
 */
function readCanonicalPaths(ctx, base) {
  const worktree = ctx.worktree ?? ctx.input.cwd;
  const gitFailure = (read) => ({
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
  const generatedTargets = readGeneratedSyncTargets(ctx, worktree, branchPoint);
  if (!generatedTargets.ok) {
    return generatedTargets;
  }
  const paths = [];
  for (const path of changed) {
    if (generatedTargets.value.has(path)) {
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
function canonicalSection(paths) {
  return `## Candidate files\n\n${paths.map((path) => `- \`${path}\``).join('\n')}\n\n`;
}
/** Whether the body has an ATX heading after its first line, as the parser masks it. */
function hasHeadingAfterFirstLine(body) {
  const lines = maskMarkdownForScan(body, {
    inlineCode: 'keep',
    htmlComments: 'mask',
    htmlBlocks: 'mask',
  }).split(/\r?\n/u);
  return lines.some(
    (line, index) =>
      index >= 1 &&
      (ATX_HEADING.test(line) ||
        (index >= 2 &&
          SETEXT_UNDERLINE.test(line) &&
          isSetextContentLine(lines, index - 1))),
  );
}
/** Whether `lines[index]` can be the text of a Setext heading under it. */
function isSetextContentLine(lines, index) {
  const line = lines[index] ?? '';
  if (line.trim() === '' || LIST_OR_QUOTE_LINE.test(line)) {
    return false;
  }
  if (!INDENTED_LINE.test(line)) {
    return true;
  }
  let above = index - 1;
  while (above >= 0 && INDENTED_LINE.test(lines[above] ?? '')) {
    above -= 1;
  }
  return !LIST_OR_QUOTE_LINE.test(lines[above] ?? '');
}
/** The `effort-candidate-file-limit` finding of one audit's JSON report. */
function effortFindingOf(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return 'malformed';
  }
  if (!isRecord(report) || !Array.isArray(report.findings)) {
    return 'malformed';
  }
  const finding = report.findings.find(
    (entry) => isRecord(entry) && entry.id === EFFORT_FINDING_ID,
  );
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
function runAudit(ctx, label, body, markerPrefix, title) {
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
function sameList(left, right) {
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
function stepScope(ctx) {
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
  // A backtick ends the bullet's code span early and a line break ends the
  // bullet, so the parser would read another path, or none, for such a path.
  // A replacement character means git printed bytes that are not UTF-8, so
  // two such paths can decode to one string and count once.
  const unwritable = paths.filter((path) => /[`\r\n\uFFFD]/u.test(path));
  if (unwritable.length > 0) {
    return failed(
      `the canonical path(s) ${unwritable.map((path) => JSON.stringify(path)).join(', ')} hold a backtick, a line break, or bytes that are not UTF-8, so a ## Candidate files bullet cannot carry them and the audit could not count them`,
      NEXT_ACTION.stopAndReport,
      0,
    );
  }
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
function checkCleanTree(ctx, when) {
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
/**
 * The next action for a gate that exited non-zero. The helper cannot read the
 * admission's stderr lines (they stream to this process's stderr with the
 * gate's output), so for the two statuses `idd-local-admission` also returns
 * for its own outcomes, the next action names the line that tells them from
 * the gate's own status (core "Admission expiry": bare `75` is command
 * status).
 */
function gateFailureAction(admission, status) {
  if (admission && status === ADMISSION_EXPIRED_STATUS) {
    return NEXT_ACTION.admissionExpired;
  }
  if (admission && status === ADMISSION_REFUSED_STATUS) {
    return NEXT_ACTION.admissionRefused;
  }
  return NEXT_ACTION.fixThenRerun;
}
function stepGate(ctx) {
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
  const admission = ctx.deps.platform !== 'win32';
  const result = ctx.deps.run({
    kind: 'gate',
    command: gate.command,
    cwd: ctx.worktree ?? ctx.input.cwd,
    admission,
  });
  const end = classifyEnd(result);
  const what = admission
    ? 'commands.pre-push-validate through idd-local-admission'
    : 'commands.pre-push-validate';
  if (end.kind === 'no-start') {
    // A gate run by hand would run outside admission, so an admission child
    // that cannot start points at the installation instead.
    return failed(
      describeEnd(what, end),
      admission ? NEXT_ACTION.helperInstallation : NEXT_ACTION.configureGate,
      null,
    );
  }
  if (end.kind === 'signal') {
    return failed(describeEnd(what, end), NEXT_ACTION.fixThenRerun, null);
  }
  if (end.status !== 0) {
    return failed(
      describeEnd(what, end),
      gateFailureAction(admission, end.status),
      end.status,
    );
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
function stepReassert(ctx) {
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
function gitMessage(result) {
  return [result.stderr.trim(), result.stdout.trim()]
    .filter((part) => part !== '')
    .join('\n');
}
function stepPush(ctx) {
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
const STEPS = [
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
export function runClaimedPush(input, deps = createProductionDeps()) {
  const ctx = {
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
  const steps = [];
  let failedStep = null;
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
function fromSpawn(result) {
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
function isAllowedGhRead(args) {
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
function outputText(value) {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}
/**
 * Run an allowed `gh` read through the repository's `gh` layer. `ghText`
 * takes no directory and runs in this process's directory, the worktree; `gh`
 * resolves the repository from the git remote the worktree shares with the
 * primary checkout.
 */
function runGhRead(args) {
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
      ...(isNotDispatchedRefusal(error) ? { notDispatched: true } : {}),
    };
  }
}
/** A child helper's path in the payload's own `scripts/` directory. */
function helperScriptPath(script) {
  return join(resolveBundleRoot(import.meta.dirname), 'scripts', script);
}
/** A child helper missing from the payload: a result with no exit status. */
function missingScript(path) {
  return {
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    error: `${path} does not exist`,
  };
}
/**
 * The spawn of one gate request. With admission it is
 * `node <admissionScript> -- /bin/sh -c <command>`, the command the last argv
 * element, byte for byte; without it (Windows) the command runs in a shell, as
 * before. Neither form sets `env`, so the child inherits this process's
 * environment as it is, `IDD_LOCAL_ADMISSION` set or unset. There is no
 * timeout, and the gate's stdout goes to this process's stderr so that stdout
 * carries only the report.
 */
export function gateSpawn(request, admissionScript) {
  const stdio = ['ignore', 2, 2];
  if (!request.admission) {
    return {
      file: request.command,
      options: { cwd: request.cwd, shell: true, stdio },
    };
  }
  return {
    file: process.execPath,
    args: [admissionScript, '--', GATE_SHELL, '-c', request.command],
    options: { cwd: request.cwd, stdio },
  };
}
/**
 * Run one gate request. The admission script is the payload's own
 * `scripts/idd-local-admission.mjs`, resolved as the other child helpers are;
 * a missing one is a result with no exit status.
 */
export function runGate(request, admissionScript) {
  let script = '';
  if (request.admission) {
    script = admissionScript ?? helperScriptPath(LOCAL_ADMISSION_SCRIPT);
    if (!existsSync(script)) {
      return missingScript(script);
    }
  }
  const plan = gateSpawn(request, script);
  return fromSpawn(
    plan.args === undefined
      ? spawnSync(plan.file, plan.options)
      : spawnSync(plan.file, plan.args, plan.options),
  );
}
/**
 * The production runner. It never throws: a failure to resolve or spawn is a
 * result with no exit status, so a refusal always reaches the JSON report.
 */
export function runProductionCommand(request) {
  try {
    if (request.kind === 'gate') {
      return runGate(request);
    }
    if (request.kind === 'gh') {
      return runGhRead(request.args);
    }
    let file = 'git';
    let args = request.kind === 'git' ? request.args : [];
    let stdin;
    if (request.kind === 'helper') {
      stdin = request.stdin;
      const script = helperScriptPath(request.script);
      if (!existsSync(script)) {
        return missingScript(script);
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
function realpathOrNull(path) {
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
export function readEffectiveGateCommand(worktree, options = {}) {
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
        ? commands['pre-push-validate']
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
export function readPrimaryPolicy(worktree, options = {}) {
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
 * -- :(literal)<path>` prints nothing and exits 0 for a path absent there, and `git show
 * <branch point>:<path>` reads a present file. An entry that is not a file
 * (a submodule) is present with no text. Any other git failure is an error.
 */
export function makeBaseTextReader(run) {
  return (worktree, branchPoint, path) => {
    const describe = (what, result) => {
      const end = classifyEnd(result);
      return withDetail(
        describeEnd(what, end),
        end.kind === 'exit' ? firstLine(result.stderr) : '',
      );
    };
    const listing = run({
      kind: 'git',
      // `:(literal)` keeps a name such as `:(top)src` from reading as magic.
      args: ['ls-tree', '-z', branchPoint, '--', `:(literal)${path}`],
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
export function createProductionDeps() {
  return {
    run: runProductionCommand,
    platform: process.platform,
    realpath: realpathOrNull,
    readGateCommand: (worktree) => readEffectiveGateCommand(worktree),
    readPolicy: (worktree) => readPrimaryPolicy(worktree),
    readBaseText: makeBaseTextReader(runProductionCommand),
    parseCandidates: parseCandidateFiles,
  };
}
export function parseArgs(argv) {
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
  const nonceValue = values.nonce;
  if (nonceValue !== undefined && nonceValue.trim() === '') {
    throw markCliUsageError(new Error('--nonce must not be empty'));
  }
  return { help, issue, claimId, nonce: nonceValue?.trim() ?? null, apply };
}
function printUsage(stdout) {
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
      'once. The gate runs as idd-local-admission -- /bin/sh -c <gate>\n' +
      '(directly in a shell on Windows). The helper never forces, never\n' +
      'retries, and never creates a commit. --nonce is passed to the claim\n' +
      'check only when given.\n',
  );
}
/**
 * Parse `argv`, run the steps, and write the JSON report to `stdout`. Exits
 * `0` only when no step failed.
 */
export function runCli(argv, deps = createProductionDeps(), options = {}) {
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
function main() {
  return runCli(process.argv.slice(2));
}
