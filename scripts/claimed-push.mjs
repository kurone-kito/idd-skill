#!/usr/bin/env node
// idd-generated-from: src/scripts/claimed-push.mts
//
// The scripts/claimed-push.mjs copy is generated from this .mts source by
// `pnpm run build`. Edit the .mts source, never the generated .mjs. See
// docs/typescript-sources.md.
//
// Pushes a claimed branch only after the claim, the worktree location, and
// the configured `commands.pre-push-validate` gate have all passed in order
// (issue #4375). The helper never forces, never retries, and never creates a
// commit. Every child process runs through an injectable runner, so a test
// can stub the claim assert, every git call, the gate, and the push.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mjs';
import {
  parseCanonicalIntegerOrThrow,
  parseCliArgs,
  requireFlag,
} from './cli-args.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadLayeredLocalPolicy } from './idd-config.mjs';

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
/** Captured child output above this size is reported as a failed run. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** A dirty-tree reason lists at most this many status lines. */
const MAX_STATUS_LINES = 20;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
/** A github.com origin: https, http, git, ssh, or scp-style. */
const GITHUB_ORIGIN_PATTERN =
  /^(?:(?:https?|ssh|git):\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/|(?:[^/@:]+@)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/*$/iu;
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
  pushRejected: (branch) =>
    `read git's message, fetch and inspect ${REMOTE_NAME}/${branch}, never force`,
  pushUnknown: 'read the remote branch before any new push, no retry',
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
  };
}
function readHead(ctx) {
  const head = readGit(ctx, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    return { failure: failed(head.reason, NEXT_ACTION.readGitError) };
  }
  const sha = head.stdout.trim();
  if (!GIT_OBJECT_ID.test(sha)) {
    return {
      failure: failed(
        'git rev-parse HEAD did not print an object id',
        NEXT_ACTION.readGitError,
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
    return failed('no claimed branch or worktree', NEXT_ACTION.stopAndReport);
  }
  const prefix = `issue/${ctx.input.issue}-`;
  if (!branch.startsWith(prefix)) {
    return failed(
      `the claimed branch ${branch} does not start with ${prefix}`,
      NEXT_ACTION.stopAndReport,
    );
  }
  const list = readGit(ctx, ['worktree', 'list', '--porcelain', '-z']);
  if (!list.ok) {
    return failed(list.reason, NEXT_ACTION.runFromWorktree);
  }
  const firstField = list.stdout.split('\0')[0] ?? '';
  const primary = firstField.startsWith('worktree ')
    ? firstField.slice('worktree '.length)
    : '';
  if (primary === '') {
    return failed(
      'git worktree list did not name the primary checkout first',
      NEXT_ACTION.runFromWorktree,
    );
  }
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
    );
  }
  const origin = originEnd.status === 0 ? originRead.stdout.trim() : '';
  const repoName = resolveRepoName(origin, primary);
  if (!repoName.ok) {
    return failed(repoName.reason, NEXT_ACTION.runFromWorktree);
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
    );
  }
  const current = readGit(ctx, ['branch', '--show-current']);
  if (!current.ok) {
    return failed(current.reason, NEXT_ACTION.switchBranch);
  }
  const currentBranch = current.stdout.trim();
  if (currentBranch === '') {
    return failed(
      'HEAD is detached; the worktree is on no branch',
      NEXT_ACTION.switchBranch,
    );
  }
  if (currentBranch !== branch) {
    return failed(
      `the worktree is on branch ${currentBranch}, not the claimed branch ${branch}`,
      NEXT_ACTION.switchBranch,
    );
  }
  return {
    status: 'passed',
    reason: `the worktree ${actualReal} is the sibling path of ${branch} and is on that branch`,
  };
}
/** A failed outcome when the tree is dirty or unreadable, else null. */
function checkCleanTree(ctx, when) {
  const status = readGit(ctx, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (!status.ok) {
    return failed(status.reason, NEXT_ACTION.readGitError);
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
  );
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
    return { ...after, exitStatus: 0 };
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
    return failed(tip.reason, NEXT_ACTION.readGitError, 0);
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
  { id: 'gate', run: stepGate, applyOnly: true },
  { id: 'reassert', run: stepReassert, applyOnly: true },
  { id: 'push', run: stepPush, applyOnly: true },
];
/**
 * Run the five steps in order, stopping at the first failure. Without
 * `input.apply`, only the claim assert and the location check run. The
 * report always lists all five steps; the ones not run are `skipped`.
 */
export function runClaimedPush(input, deps = createProductionDeps()) {
  const ctx = {
    input,
    deps,
    worktree: null,
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
 * The production runner. It never throws: a failure to resolve or spawn is a
 * result with no exit status, so a refusal always reaches the JSON report.
 * The gate runs through a shell with no timeout, and its stdout goes to this
 * process's stderr so that stdout carries only the report.
 */
export function runProductionCommand(request) {
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
    let file = 'git';
    let args = request.kind === 'git' ? request.args : [];
    if (request.kind === 'helper') {
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
        stdio: ['ignore', 'pipe', 'pipe'],
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
export function createProductionDeps() {
  return {
    run: runProductionCommand,
    realpath: realpathOrNull,
    readGateCommand: (worktree) => readEffectiveGateCommand(worktree),
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
      'location, and the configured pre-push gate have passed in order, then\n' +
      're-checks the claim and the gated commit just before the push.\n' +
      'Dry-run is the default: it checks the claim and the location, skips the\n' +
      'gate and the push, and exits 0 when both pass. --apply also runs the\n' +
      'gate and pushes once. The helper never forces, never retries, and never\n' +
      'creates a commit. --nonce is passed to the claim check only when given.\n',
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
