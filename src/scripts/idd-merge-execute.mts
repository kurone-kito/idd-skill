#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-merge-execute.mts
//
// The scripts/idd-merge-execute.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Thin F3 merge-gate evaluator + executor. It WRAPS the read-only
// pre-merge-readiness collector (reuses its gate logic verbatim) and
// introduces NO new decision authority: `decisionAuthority` stays
// `instructions`. In the default dry-run it only collects evidence and
// reports the bound merge command; the ONLY mutation anywhere is the
// `gh pr merge` issued under `--apply` once every F3 gate holds and the
// head + claim re-validate immediately before the merge.

import { ghText } from './gh-exec.mts';
import { collectPreMergeReadiness } from './pre-merge-readiness.mts';
import { computePreMergeReadinessBlockers } from './protocol-helpers.mts';

/** One failing F3 gate, keyed by the gate name plus a human detail. */
export interface MergeBlocker {
  gate: string;
  detail: string;
}

/**
 * JSON verdict document printed by the `idd-merge-execute` CLI. The
 * helper is evidence + execution convenience only, so `decisionAuthority`
 * stays `instructions` (consistent with pre-merge-readiness).
 */
export interface IddMergeExecuteVerdict {
  protocolVersion: '1';
  decisionAuthority: 'instructions';
  mode: 'dry-run' | 'apply';
  prNumber: number;
  prHeadSha: string;
  ready: boolean;
  blockers: MergeBlocker[];
  mergeCommand: string;
  merged: boolean;
  mergeResult: string;
}

/** Parsed CLI arguments mirroring pre-merge-readiness, plus `--apply`. */
interface IddMergeExecuteArgs {
  prNumber: number | null;
  passthrough: string[];
  apply: boolean;
  /**
   * `<owner>/<repo>` repo scope, set only when BOTH `--owner` and `--repo`
   * are provided. The head re-fetch, the merge, and the emitted
   * `mergeCommand` are all scoped to this repo so the helper never validates
   * one repo (via the collector's `--owner/--repo`) while operating on a
   * different current-directory repo. `null` keeps current-directory `gh`
   * behavior.
   */
  repoRef: string | null;
}

/**
 * Evaluate every F3 gate against `report` (the pre-merge-readiness summary),
 * returning one blocker per unmet gate (`ready` is true only when the list is
 * empty). Delegates to the shared `computePreMergeReadinessBlockers` rollup in
 * `protocol-helpers.mts` — the single source of the merge-gate AND that
 * `buildPreMergeReadinessSummary` also embeds as `{ ready, blockers }` — so the
 * conjunction is defined once and no caller re-implements it. Recomputing from
 * the report's nested evidence (rather than trusting a possibly-absent
 * `report.blockers` field) keeps the merge gate fail-closed; the conditions
 * mirror the written F3 gate checklist exactly and add no stricter
 * sub-condition.
 */
export function evaluateMergeGates(
  report: Record<string, unknown>,
): MergeBlocker[] {
  return computePreMergeReadinessBlockers(report);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Injectable side-effecting dependencies. Tests substitute these to drive
 * the dry-run / apply / fail-closed paths without faking the full live
 * GitHub state; production uses the real readiness collector and `gh`.
 */
export interface MergeExecuteDeps {
  /** Collect the read-only pre-merge readiness report from live state. */
  collect: (passthrough: string[]) => Record<string, unknown>;
  /**
   * Re-fetch the current PR head SHA immediately before merging, scoped to
   * `repoRef` (`<owner>/<repo>`) when set, else the current-directory repo.
   */
  fetchHeadSha: (prNumber: number, repoRef: string | null) => string;
  /**
   * Execute the bound merge commit and return gh's stdout, scoped to
   * `repoRef` (`<owner>/<repo>`) when set, else the current-directory repo.
   */
  mergePr: (
    prNumber: number,
    headSha: string,
    repoRef: string | null,
  ) => string;
}

// Prepend `-R <repoRef>` to a `gh` argument array only when a repo scope is
// set; otherwise pass the args verbatim (current-directory repo).
function scopedGhArgs(repoRef: string | null, args: string[]): string[] {
  return repoRef ? ['-R', repoRef, ...args] : args;
}

const defaultDeps: MergeExecuteDeps = {
  collect: (passthrough) =>
    collectPreMergeReadiness(passthrough) as Record<string, unknown>,
  fetchHeadSha: (prNumber, repoRef) =>
    ghText(
      scopedGhArgs(repoRef, [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'headRefOid',
        '--jq',
        '.headRefOid',
      ]),
    ),
  mergePr: (prNumber, headSha, repoRef) =>
    ghText(
      scopedGhArgs(repoRef, [
        'pr',
        'merge',
        String(prNumber),
        // Always a merge commit — never squash/rebase. Bind to the head.
        '--merge',
        '--match-head-commit',
        headSha,
      ]),
    ),
};

/**
 * Build the F3 verdict and, under `--apply`, execute the merge. The
 * dry-run path performs NO mutation. The apply path fails closed: if the
 * gate is not ready it exits without merging; if it is ready it RE-FETCHES
 * the head SHA and RE-VALIDATES the claim immediately before merging, and
 * refuses to merge (clear message) on any head drift or lost claim.
 */
export function runMergeExecute(
  argv: string[],
  deps: MergeExecuteDeps = defaultDeps,
): {
  verdict: IddMergeExecuteVerdict;
  exitCode: number;
} {
  const args = parseArgs(argv);
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }

  const report = deps.collect(args.passthrough);
  const prHeadSha = String(report.prHeadSha ?? '');
  const blockers = evaluateMergeGates(report);
  const ready = blockers.length === 0;
  // Scope the printed command to the same repo the merge would run against so
  // it matches what `--apply` executes (current-directory repo when unset).
  const repoScope = args.repoRef ? `-R ${args.repoRef} ` : '';
  // Suppress the copy-pasteable command when the head is invalid (the
  // head-sha gate fired): binding --match-head-commit to a non-SHA would
  // emit a malformed, unsafe command despite the helper failing closed.
  const hasHeadShaBlocker = blockers.some((b) => b.gate === 'head-sha');
  const mergeCommand = hasHeadShaBlocker
    ? ''
    : `gh ${repoScope}pr merge ${args.prNumber} --merge --match-head-commit ${prHeadSha}`;

  const verdict: IddMergeExecuteVerdict = {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    mode: args.apply ? 'apply' : 'dry-run',
    prNumber: args.prNumber,
    prHeadSha,
    ready,
    blockers,
    mergeCommand,
    merged: false,
    mergeResult: '',
  };

  if (!args.apply) {
    // Dry-run: read-only. Never merge.
    return { verdict, exitCode: ready ? 0 : 1 };
  }

  if (!ready) {
    // Apply but not ready: fail closed, do not merge.
    verdict.mergeResult =
      'not-ready: gate blockers present; no merge attempted';
    return { verdict, exitCode: 1 };
  }

  // Ready under --apply: re-fetch the head and re-validate the claim
  // immediately before merging, then fail closed on any drift.
  const liveHeadSha = deps.fetchHeadSha(args.prNumber, args.repoRef);
  if (liveHeadSha !== prHeadSha) {
    verdict.mergeResult = `head drift: validated ${prHeadSha} but live head is ${liveHeadSha}; no merge`;
    return { verdict, exitCode: 1 };
  }

  const revalidated = deps.collect(args.passthrough);
  if (String(revalidated.prHeadSha ?? '') !== prHeadSha) {
    verdict.mergeResult = `head drift on re-validation: ${String(
      revalidated.prHeadSha ?? '',
    )} != ${prHeadSha}; no merge`;
    return { verdict, exitCode: 1 };
  }
  const revalidatedClaim = asRecord(revalidated.claim);
  if (revalidatedClaim.matchesExpectedClaim !== true) {
    verdict.mergeResult = `claim lost on re-validation (reason="${String(
      revalidatedClaim.reason ?? 'unknown',
    )}"); no merge`;
    return { verdict, exitCode: 1 };
  }
  const revalidatedBlockers = evaluateMergeGates(revalidated);
  if (revalidatedBlockers.length > 0) {
    verdict.blockers = revalidatedBlockers;
    verdict.ready = false;
    verdict.mergeResult =
      're-validation found new blockers immediately before merge; no merge';
    return { verdict, exitCode: 1 };
  }

  // Always a merge commit — never squash/rebase. Bind to the validated head.
  const mergeOutput = deps.mergePr(args.prNumber, prHeadSha, args.repoRef);
  verdict.merged = true;
  verdict.mergeResult = mergeOutput || 'merge command completed';
  return { verdict, exitCode: 0 };
}

// Excluded from the #1446 cli-args.mts wrapper: `passthrough` below
// collects every unrecognized flag (plus its value, when present) into an
// array forwarded verbatim to the collector, rather than rejecting it
// against a fixed declared spec. `util.parseArgs`'s `strict: true` rejects
// any option not named in its static spec, and `strict: false` would
// instead coerce every unrecognized flag to `true` -- neither matches this
// file's "collect and forward whatever the collector itself accepts"
// contract.
function parseArgs(argv: string[]): IddMergeExecuteArgs {
  const parsed: IddMergeExecuteArgs = {
    prNumber: null,
    passthrough: [],
    apply: false,
    repoRef: null,
  };
  // Captured locally so `repoRef` is set only when BOTH are present; these
  // are ALSO forwarded to the collector via passthrough (we do not stop
  // forwarding them — the collector still scopes its own gh/API calls).
  let owner = '';
  let repo = '';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    if (token === '--pr') {
      const value = argv[index + 1];
      parsed.prNumber = Number.parseInt(value ?? '', 10);
      parsed.passthrough.push(token, value ?? '');
      index += 1;
      continue;
    }
    if (token === '--owner' || token === '--repo') {
      const value = argv[index + 1];
      if (token === '--owner') {
        owner = value ?? '';
      } else {
        repo = value ?? '';
      }
      // Keep forwarding to the collector so it still validates this repo.
      parsed.passthrough.push(token, value ?? '');
      index += 1;
      continue;
    }
    // Every other flag (and its value, if it takes one) is forwarded
    // verbatim to the pre-merge-readiness collector so the two CLIs accept
    // an identical flag surface without re-declaring it here.
    if (token.startsWith('--')) {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        parsed.passthrough.push(token, value);
        index += 1;
      } else {
        parsed.passthrough.push(token);
      }
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  if (!Number.isInteger(parsed.prNumber) || (parsed.prNumber ?? 0) < 1) {
    parsed.prNumber = null;
  }

  // Fail closed on exactly one of `--owner` / `--repo`: the collector
  // (`pre-merge-readiness`) fills the missing half from the
  // current-directory repo, so a single flag would validate one repoRef
  // while the head re-fetch and merge run against the current-directory
  // repo — an unsafe split under `--apply`. Require both or neither.
  if ((owner === '') !== (repo === '')) {
    throw new Error(
      'idd-merge-execute: --owner and --repo must be provided together or not at all',
    );
  }
  // Both provided → scope to `<owner>/<repo>`. Neither → null, so the
  // collector, the head re-fetch, and the merge all default to the
  // current-directory repo (consistent).
  parsed.repoRef = owner && repo ? `${owner}/${repo}` : null;

  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/idd-merge-execute.mjs --pr <number> --claim-issue <number> [--claim-id <claim-id>] [--agent-id <agent-id>] [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--advisory-bot-logins <bot1,bot2>] [--idd-agent-logins <login1,login2>] [--now <ISO8601>] [--apply]

  Every flag except --apply is forwarded verbatim to the read-only
  pre-merge-readiness collector, so the full collector flag surface is
  accepted here — including --idd-agent-logins, --now, and the deprecated
  --expected-claim-id / --expected-agent-id aliases. --owner and --repo
  must be passed together or not at all.

  Default (no --apply): dry-run. Evaluates every F3 merge gate via the
  read-only pre-merge-readiness collector and prints { ready, blockers,
  mergeCommand } without merging. Exit 0 when ready, 1 otherwise.

  --apply: when ready, re-fetch the head SHA and re-validate the claim
  immediately before merging, then run a merge commit bound to the
  validated head. Fails closed (exit 1, no merge) on head drift or lost
  claim. Never squash/rebase merges. The merge is the only mutation.
`);
}

// CLI: print the verdict as JSON and exit with the gate/merge status.
if (import.meta.main) {
  const { verdict, exitCode } = runMergeExecute(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(exitCode);
}
