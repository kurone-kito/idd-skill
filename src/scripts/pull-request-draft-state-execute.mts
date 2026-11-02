#!/usr/bin/env node

// idd-generated-from: src/scripts/pull-request-draft-state-execute.mts
//
// The scripts/pull-request-draft-state-execute.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Command wrapper for the draft-state transition core (#4909). A dry run is the
// default; --apply sends the transition. The core owns every refusal and the
// post-change verification, so this file parses flags, runs `gh`, and prints
// the report as JSON. The exit status is 0 for a dry run, a transition, or an
// already-correct state, and 1 for any refusal or unverified outcome.

import { parseCliArgs } from './cli-args.mts';
import { ghText } from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  classifyHelperError,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  type DraftTarget,
  type DraftTransitionDeps,
  evaluatePullRequestDraftTransition,
  type GhResult,
} from './pull-request-draft-state.mts';

const DRAFT_STATE_FLAG_SPEC = {
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--number': { type: 'string' },
  '--target': { type: 'string' },
  '--expected-head-sha': { type: 'string' },
  '--apply': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

const SUCCESS_VERDICTS = new Set([
  'dry-run',
  'transitioned',
  'already-in-target-state',
]);

export interface DraftStateExecuteArgs {
  owner: string;
  repo: string;
  number: number;
  target: DraftTarget;
  expectedHeadSha: string;
  apply: boolean;
  help: boolean;
}

function usageError(message: string): Error {
  return markCliUsageError(new Error(`pull-request-draft-state: ${message}`));
}

/** Parses and validates the flags. Usage problems throw before any `gh` call. */
export function parseArgs(argv: string[]): DraftStateExecuteArgs {
  const { values, help } = parseCliArgs(argv, DRAFT_STATE_FLAG_SPEC);
  const owner = ((values.owner as string | undefined) ?? '').trim();
  const repo = ((values.repo as string | undefined) ?? '').trim();
  const numberRaw = ((values.number as string | undefined) ?? '').trim();
  const target = ((values.target as string | undefined) ?? '').trim();
  const expectedHeadSha = (
    (values['expected-head-sha'] as string | undefined) ?? ''
  ).trim();
  if (help) {
    return {
      owner,
      repo,
      number: 0,
      target: 'draft',
      expectedHeadSha,
      apply: false,
      help: true,
    };
  }
  if (owner === '' || repo === '') {
    throw usageError('--owner and --repo are both required');
  }
  // A value above Number.MAX_SAFE_INTEGER would be rounded by Number(), so the
  // number that reached the REST path could name a different pull request.
  if (
    !/^\d+$/.test(numberRaw) ||
    !Number.isSafeInteger(Number(numberRaw)) ||
    Number(numberRaw) <= 0
  ) {
    throw usageError(
      '--number must be a positive pull request number within the safe integer range',
    );
  }
  if (target !== 'draft' && target !== 'ready') {
    throw usageError('--target must be draft or ready');
  }
  if (expectedHeadSha === '') {
    throw usageError('--expected-head-sha is required');
  }
  return {
    owner,
    repo,
    number: Number(numberRaw),
    target,
    expectedHeadSha,
    apply: Boolean(values.apply),
    help: false,
  };
}

function printHelp(): void {
  process.stdout.write(`
Usage:
  node scripts/pull-request-draft-state-execute.mjs --owner <owner> --repo <repo> --number <n> --target <draft|ready> --expected-head-sha <40-hex> [--apply]

  #4909: moves one open pull request between draft and ready-for-review through
  the #4908 transition core. Default (no --apply): dry run. It reads the pull
  request, refuses an unsafe state, and reports the observed state without
  sending a transition request. --apply sends one GraphQL mutation and confirms
  it with a fresh read. The helper never merges, pushes, changes labels, or
  releases a claim.

  Exit status: 0 for a dry run, a transition, or an already-correct state; 1 for
  a refusal or an unverified outcome; usage errors are reported before any call.
`);
}

/**
 * The gh runner the core uses in production. Calls go through the shared gh
 * layer (gh-exec.mts), and a failed call becomes a non-zero GhResult so the
 * core can classify it.
 */
function runGh(args: readonly string[]): GhResult {
  try {
    return { status: 0, stdout: ghText([...args]), stderr: '' };
  } catch (error: unknown) {
    const failure = error as {
      status?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    return {
      status: typeof failure.status === 'number' ? failure.status : -1,
      stdout: '',
      stderr: String(failure.stderr ?? failure.message ?? ''),
    };
  }
}

function runCli(): HelperCliResult {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const deps: DraftTransitionDeps = { gh: runGh };
  const report = evaluatePullRequestDraftTransition(
    {
      owner: args.owner,
      repo: args.repo,
      number: args.number,
      target: args.target,
      expectedHeadSha: args.expectedHeadSha,
      apply: args.apply,
    },
    deps,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return SUCCESS_VERDICTS.has(report.verdict) ? 0 : 1;
}

if (import.meta.main) {
  // Keeps the same error envelope contract as the other execute helpers
  // (#3343): an uncaught throw becomes a classified exit, never a stack trace.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('pull-request-draft-state', () => {
      try {
        return runCli();
      } catch (error: unknown) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        const classified = classifyHelperError(error);
        return {
          exitCode: 1,
          kind: classified.kind,
          message: classified.message,
          httpStatus: classified.httpStatus,
        };
      }
    });
  } else {
    try {
      applyHelperCliOutcomeWhenDisabled(runCli());
    } catch (error: unknown) {
      process.stderr.write(`Error: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}
