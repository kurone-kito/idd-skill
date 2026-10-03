#!/usr/bin/env node
// idd-generated-from: src/scripts/delete-remote-branch.mts
//
// The scripts/delete-remote-branch.mjs copy is generated from this .mts
// source by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { spawnSync } from 'node:child_process';
import { parseCliArgs } from './cli-args.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';

const DELETE_REMOTE_BRANCH_FLAG_SPEC = {
  '--branch': { type: 'string' },
  '--expected-sha': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
};
const REMOTE_NAME = 'origin';
function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
}
function gitFailureDetail(result) {
  const detail = result.stderr.trim() || result.error?.trim();
  return detail || `git exited with status ${String(result.status)}`;
}
function hold(input, action, detail, observedSha = null) {
  return {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    mode: input.apply ? 'apply' : 'dry-run',
    status: 'hold',
    action,
    branch: input.branch,
    expectedSha: input.expectedSha,
    observedSha,
    detail,
  };
}
function complete(input, action, detail, observedSha) {
  return {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    mode: input.apply ? 'apply' : 'dry-run',
    status: 'complete',
    action,
    branch: input.branch,
    expectedSha: input.expectedSha,
    observedSha,
    detail,
  };
}
function readRemoteRef(ref, git) {
  const result = git(['ls-remote', '--refs', REMOTE_NAME, ref]);
  if (result.status !== 0) {
    return {
      kind: 'error',
      sha: null,
      detail: gitFailureDetail(result),
    };
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return { kind: 'absent', sha: null, detail: 'remote ref is absent' };
  }
  if (lines.length !== 1) {
    return {
      kind: 'error',
      sha: null,
      detail: `expected one remote-ref result, received ${lines.length}`,
    };
  }
  const [sha, returnedRef, ...extra] = lines[0].trim().split(/\s+/);
  if (
    extra.length > 0 ||
    returnedRef !== ref ||
    !/^[0-9a-f]{40}$/.test(sha ?? '')
  ) {
    return {
      kind: 'error',
      sha: null,
      detail: 'remote returned an unreadable or unexpected ref result',
    };
  }
  return { kind: 'present', sha, detail: 'remote ref is present' };
}
function readDefaultBranch(git) {
  const result = git(['ls-remote', '--symref', REMOTE_NAME, 'HEAD']);
  if (result.status !== 0) {
    return null;
  }
  const refs = result.stdout
    .split(/\r?\n/)
    .map((line) => /^ref: (refs\/heads\/\S+)\s+HEAD$/.exec(line)?.[1])
    .filter((ref) => Boolean(ref));
  return refs.length === 1 ? refs[0] : null;
}
/**
 * Dry-run or atomically delete one remote branch after confirming its
 * current SHA. All Git calls receive argument arrays; branch data never
 * enters shell source. The explicit lease protects the gap between the
 * read and delete, while the post-read reconciles concurrent deletion or
 * branch recreation without retrying a failed mutation.
 */
export function runRemoteBranchDelete(input, git = runGit) {
  const ref = `refs/heads/${input.branch}`;
  if (!/^[0-9a-f]{40}$/.test(input.expectedSha)) {
    return hold(
      input,
      'invalid-expected-sha',
      'expected SHA must be a full 40-character lowercase hexadecimal value',
    );
  }
  const formatResult = git(['check-ref-format', ref]);
  if (formatResult.status !== 0) {
    return hold(
      input,
      'invalid-ref',
      `branch is not a valid Git ref: ${gitFailureDetail(formatResult)}`,
    );
  }
  const before = readRemoteRef(ref, git);
  if (before.kind === 'error') {
    return hold(input, 'remote-read-failed', before.detail);
  }
  if (before.kind === 'absent') {
    return complete(input, 'already-absent', before.detail, null);
  }
  if (before.sha !== input.expectedSha) {
    return hold(
      input,
      'remote-sha-mismatch',
      'remote branch no longer matches the verified merged PR head',
      before.sha,
    );
  }
  const defaultBranch = readDefaultBranch(git);
  if (!defaultBranch) {
    return hold(
      input,
      'default-branch-unverified',
      'could not resolve origin HEAD to exactly one default branch',
      before.sha,
    );
  }
  if (defaultBranch === ref) {
    return hold(
      input,
      'default-branch-refused',
      'refusing to delete the remote default branch',
      before.sha,
    );
  }
  if (!input.apply) {
    return complete(
      input,
      'would-delete',
      'remote SHA matches; apply will use an atomic expected-SHA lease',
      before.sha,
    );
  }
  const push = git([
    'push',
    `--force-with-lease=${ref}:${input.expectedSha}`,
    REMOTE_NAME,
    `:${ref}`,
  ]);
  const after = readRemoteRef(ref, git);
  if (after.kind === 'error') {
    return hold(
      input,
      'deletion-unconfirmed',
      `could not verify remote state after the delete attempt: ${after.detail}`,
      null,
    );
  }
  if (after.kind === 'absent') {
    return complete(
      input,
      push.status === 0 ? 'deleted' : 'already-absent',
      push.status === 0
        ? 'remote deletion succeeded and absence was confirmed'
        : 'remote ref is absent after the failed delete attempt; no retry was made',
      null,
    );
  }
  if (after.sha !== input.expectedSha) {
    return hold(
      input,
      'remote-changed',
      'remote branch changed during deletion; the new ref was left untouched',
      after.sha,
    );
  }
  return hold(
    input,
    push.status === 0 ? 'deletion-unconfirmed' : 'delete-failed',
    push.status === 0
      ? 'git push reported success but the expected remote ref remains present'
      : `atomic remote deletion failed: ${gitFailureDetail(push)}`,
    after.sha,
  );
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, DELETE_REMOTE_BRANCH_FLAG_SPEC);
  const branch = values.branch?.trim() ?? null;
  const expectedSha = values['expected-sha']?.trim() ?? null;
  if (branch !== null && branch.length === 0) {
    throw markCliUsageError(new Error('--branch must not be empty'));
  }
  if (expectedSha !== null && !/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw markCliUsageError(
      new Error(
        '--expected-sha must be a full 40-character lowercase hexadecimal value',
      ),
    );
  }
  return { help, branch, expectedSha, apply: values.apply === true };
}
function printUsage() {
  process.stdout.write(
    `Usage:\n  node scripts/delete-remote-branch.mjs --branch <name> --expected-sha <40-hex> [--apply]\n\n` +
      'Dry-run is the default. --apply uses an atomic expected-SHA lease.\n',
  );
}
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('delete-remote-branch', main);
  } else {
    main().then(applyHelperCliOutcomeWhenDisabled, (error) => {
      throw error;
    });
  }
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.branch || !args.expectedSha) {
    throw markCliUsageError(
      new Error('missing required --branch and --expected-sha arguments'),
    );
  }
  const verdict = runRemoteBranchDelete({
    branch: args.branch,
    expectedSha: args.expectedSha,
    apply: args.apply,
  });
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  return verdict.status === 'complete' ? 0 : 1;
}
