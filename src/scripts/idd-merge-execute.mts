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
import { ghErrorText } from './gh-http-status.mts';
import { type IddConfig, loadIddConfig } from './idd-config.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';
import { collectPreMergeReadiness } from './pre-merge-readiness.mts';
import { computePreMergeReadinessBlockers } from './protocol-helpers.mts';

/**
 * GitHub's exact `gh pr merge` failure text for the solo-CODEOWNER
 * self-approval deadlock (#1494): a configured pull-request-only (or wider)
 * ruleset bypass actor does not, by itself, make the plain merge command
 * succeed -- GitHub still rejects it and suggests `--admin`. Matched
 * case-insensitively against the caught error's stderr/stdout/message so a
 * harmless wording variation (capitalization) does not silently miss the
 * one error class this fallback exists for. Any OTHER merge failure (a
 * real conflict, a CI regression surfaced late, etc.) never matches and
 * always falls through to the unconditional hold-and-report path.
 */
const BASE_BRANCH_POLICY_MERGE_FAILURE_RE =
  /base branch policy prohibits the merge/i;

/** `reviewerStates.codeownerSelfApproval.reason` values that mean "review
 * requirements are unmet ONLY because of an actor-scoped ruleset bypass",
 * as opposed to `codeowner-approval-satisfied` (real approval already
 * happened) or `non-author-codeowner-available` (a distinct human/bot
 * codeowner exists and could review -- never eligible for this fallback).
 */
const SOLO_CODEOWNER_BYPASS_REASONS = new Set([
  'pull-request-bypass-available',
  'ruleset-bypass-available',
]);

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
  /**
   * #1521: true only when the plain merge command failed with the
   * self-CODEOWNER "base branch policy prohibits the merge" error and this
   * run retried with `--admin` (successfully or not). `false` on every
   * other path, including a successful plain merge and a merge failure not
   * eligible for the fallback.
   */
  adminFallbackUsed: boolean;
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
 * #1521: the ONLY safe trigger for the solo-CODEOWNER `--admin` merge
 * fallback. Deliberately narrower than "the required-reviews gate is not a
 * blocker" (`codeownerSelfApproval.status === 'clear'` alone): that status
 * also covers `non-author-codeowner-available` (a distinct, real codeowner
 * exists) and can be reached via the bypass-detected branch even when such
 * a non-author codeowner's review is genuinely still outstanding --
 * `summarizeCodeownerSelfApproval` (protocol-helpers.mts) resolves the
 * bypass branch before it ever checks for a non-author owner. This
 * function instead requires the additive `prAuthorIsSoleEligibleCodeowner`
 * topology fact (no team codeowners, no email codeowners, and every
 * eligible direct-user codeowner equals the PR author), so a genuinely
 * outstanding review from any other owner registers as its own unmet
 * condition and never gets folded into this fallback. See the #1521
 * multi-CODEOWNER validation tests in tests/pre-merge-readiness.test.mts
 * and tests/idd-merge-execute.test.mts.
 */
export function isEligibleForSoloCodeownerAdminFallback(
  reviewerStates: Record<string, unknown>,
): boolean {
  const selfApproval = asRecord(reviewerStates.codeownerSelfApproval);
  return (
    String(selfApproval.status ?? '') === 'clear' &&
    SOLO_CODEOWNER_BYPASS_REASONS.has(String(selfApproval.reason ?? '')) &&
    selfApproval.prAuthorIsSoleEligibleCodeowner === true
  );
}

/**
 * A generic "base branch policy prohibits the merge" error can also cover
 * merge-queue, deployment, or other branch-policy blockers that the
 * readiness report does not model. Require GitHub's live merge state to be
 * settled and mergeable before an administrator retry; unknown or blocked
 * state must never be bypassed by `--admin`.
 */
export function isSafeSoloCodeownerAdminMergeState(
  mergeState: Record<string, unknown>,
  branchCurrency: Record<string, unknown> = {},
): boolean {
  const mergeable = String(mergeState.mergeable ?? '');
  const mergeStateStatus = String(mergeState.mergeStateStatus ?? '');
  return (
    mergeable === 'MERGEABLE' &&
    (mergeStateStatus === 'CLEAN' ||
      (mergeStateStatus === 'BEHIND' &&
        branchCurrency.requiresUpToDateHead === false))
  );
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
  /** Fetch the live GitHub mergeability state before an admin retry. */
  fetchMergeState: (
    prNumber: number,
    repoRef: string | null,
  ) => Record<string, unknown>;
  /**
   * Execute the bound merge commit and return gh's stdout, scoped to
   * `repoRef` (`<owner>/<repo>`) when set, else the current-directory repo.
   */
  mergePr: (
    prNumber: number,
    headSha: string,
    repoRef: string | null,
  ) => string;
  /**
   * #1521: retry the bound merge commit with repository-admin privileges
   * (`--admin`). Called ONLY after `mergePr` fails with the specific
   * self-CODEOWNER "base branch policy prohibits the merge" error AND
   * {@link isEligibleForSoloCodeownerAdminFallback} holds AND the
   * repository has not opted into `hold-and-report`. Same scoping as
   * `mergePr`.
   */
  mergePrAdmin: (
    prNumber: number,
    headSha: string,
    repoRef: string | null,
  ) => string;
  /**
   * Resolve the repository-local `mergeGate.soloCodeownerAdminFallback`
   * policy (`.github/idd/config.json`). Distributed default
   * `'auto-admin-retry'`; `'hold-and-report'` opts into the pre-#1521
   * unconditional hold behavior instead.
   */
  resolveSoloCodeownerAdminFallbackMode: (
    prNumber: number,
    repoRef: string | null,
    headSha: string,
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
  fetchMergeState: (prNumber, repoRef) =>
    JSON.parse(
      ghText(
        scopedGhArgs(repoRef, [
          'pr',
          'view',
          String(prNumber),
          '--json',
          'mergeable,mergeStateStatus',
          '--jq',
          '.',
        ]),
      ),
    ) as Record<string, unknown>,
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
  mergePrAdmin: (prNumber, headSha, repoRef) =>
    ghText(
      scopedGhArgs(repoRef, [
        'pr',
        'merge',
        String(prNumber),
        '--merge',
        '--match-head-commit',
        headSha,
        '--admin',
      ]),
    ),
  resolveSoloCodeownerAdminFallbackMode: (prNumber, repoRef, headSha) => {
    let config: IddConfig | null;
    if (!repoRef) {
      config = loadIddConfig();
    } else {
      const encodedConfig = ghText(
        scopedGhArgs(repoRef, [
          'api',
          `repos/${repoRef}/contents/.github/idd/config.json`,
          '--field',
          `ref=${headSha}`,
          '--jq',
          '.content',
        ]),
      );
      if (!encodedConfig) {
        throw new Error(
          `target repository policy is empty for PR #${prNumber} at ${headSha}`,
        );
      }
      config = JSON.parse(
        Buffer.from(encodedConfig, 'base64').toString('utf8'),
      ) as IddConfig;
    }
    if (repoRef && config === null) {
      throw new Error(
        `target repository policy is unreadable for PR #${prNumber} at ${headSha}`,
      );
    }
    return normalizePolicyConfig(config).mergeGate.soloCodeownerAdminFallback;
  },
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
    adminFallbackUsed: false,
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
  const revalidation = revalidateImmediatelyBeforeMerge(
    deps,
    args.prNumber,
    args.repoRef,
    args.passthrough,
    prHeadSha,
  );
  if (!revalidation.ok) {
    if (revalidation.blockers) {
      verdict.blockers = revalidation.blockers;
      verdict.ready = false;
    }
    verdict.mergeResult = revalidation.failure;
    return { verdict, exitCode: 1 };
  }
  const revalidated = revalidation.report;

  // Always a merge commit — never squash/rebase. Bind to the validated head.
  try {
    const mergeOutput = deps.mergePr(args.prNumber, prHeadSha, args.repoRef);
    verdict.merged = true;
    verdict.mergeResult = mergeOutput || 'merge command completed';
    return { verdict, exitCode: 0 };
  } catch (mergeError) {
    // #1521: the plain merge command failed. Every path below stays
    // fail-closed by default (hold-and-report, unchanged from pre-#1521
    // behavior); the ONLY escalation is the narrow solo-CODEOWNER `--admin`
    // retry, gated on ALL of: the exact GitHub error text, the repository
    // not having opted into `hold-and-report`, and
    // `isEligibleForSoloCodeownerAdminFallback` against the FRESHLY
    // re-validated `revalidated` report collected immediately above (not
    // the earlier, possibly-stale `report`) — the same "immediately before
    // merging" freshness this file already applies to the head SHA and
    // claim checks.
    const mergeErrorText = ghErrorText(mergeError);
    const revalidatedReviewerStates = asRecord(revalidated.reviewerStates);
    // Ordered cheapest-first so a merge failure unrelated to the
    // solo-CODEOWNER deadlock (a real conflict, a late CI regression, an
    // unrelated ruleset rejection) never pays for the I/O-bound
    // `resolveSoloCodeownerAdminFallbackMode` config read: both the regex
    // test and the eligibility check are pure/in-memory and short-circuit
    // `&&` before that call ever runs.
    const eligibleByMergeEvidence =
      BASE_BRANCH_POLICY_MERGE_FAILURE_RE.test(mergeErrorText) &&
      isEligibleForSoloCodeownerAdminFallback(revalidatedReviewerStates);

    if (!eligibleByMergeEvidence) {
      verdict.mergeResult = `merge command failed: ${
        mergeErrorText || 'unknown error'
      }`;
      return { verdict, exitCode: 1 };
    }

    let fallbackMode: string;
    try {
      fallbackMode = deps.resolveSoloCodeownerAdminFallbackMode(
        args.prNumber,
        args.repoRef,
        prHeadSha,
      );
    } catch (policyError) {
      verdict.mergeResult = `admin-fallback aborted: target repository policy unreadable: ${
        ghErrorText(policyError) || 'unknown error'
      }; no merge`;
      return { verdict, exitCode: 1 };
    }
    if (fallbackMode === 'hold-and-report') {
      verdict.mergeResult = `merge command failed: ${
        mergeErrorText || 'unknown error'
      }`;
      return { verdict, exitCode: 1 };
    }

    // #1521 (Codex review on PR #1537): re-validate a SECOND time,
    // immediately before the --admin call, rather than trusting the
    // `revalidated` snapshot collected above. Real time has passed since
    // then — at minimum the failed plain-merge round trip — during which
    // a required check could flip red, a review could be dismissed, or
    // another blocker could appear. `--admin` bypasses the ENTIRE
    // ruleset, not just the CODEOWNER rule, so retrying on a stale
    // snapshot could silently merge a PR that is no longer green. Also
    // re-confirm the solo-CODEOWNER eligibility fact itself (not only the
    // general gate), since a non-author codeowner's review could have
    // arrived in the interim.
    const adminRevalidation = revalidateImmediatelyBeforeMerge(
      deps,
      args.prNumber,
      args.repoRef,
      args.passthrough,
      prHeadSha,
    );
    if (!adminRevalidation.ok) {
      if (adminRevalidation.blockers) {
        verdict.blockers = adminRevalidation.blockers;
        verdict.ready = false;
      }
      verdict.mergeResult = `admin-fallback aborted: ${adminRevalidation.failure}`;
      return { verdict, exitCode: 1 };
    }
    const adminReviewerStates = asRecord(
      adminRevalidation.report.reviewerStates,
    );
    if (!isEligibleForSoloCodeownerAdminFallback(adminReviewerStates)) {
      verdict.mergeResult =
        'admin-fallback aborted: solo-CODEOWNER eligibility no longer holds on re-validation; no merge';
      return { verdict, exitCode: 1 };
    }

    let mergeState: Record<string, unknown>;
    try {
      mergeState = deps.fetchMergeState(args.prNumber, args.repoRef);
    } catch (mergeStateError) {
      verdict.mergeResult = `admin-fallback aborted: live merge state unreadable: ${
        ghErrorText(mergeStateError) || 'unknown error'
      }`;
      return { verdict, exitCode: 1 };
    }
    if (
      !isSafeSoloCodeownerAdminMergeState(
        mergeState,
        asRecord(adminRevalidation.report.branchCurrency),
      )
    ) {
      verdict.mergeResult =
        'admin-fallback aborted: live merge state is not settled and mergeable; no merge';
      return { verdict, exitCode: 1 };
    }

    verdict.adminFallbackUsed = true;
    try {
      const adminMergeOutput = deps.mergePrAdmin(
        args.prNumber,
        prHeadSha,
        args.repoRef,
      );
      verdict.merged = true;
      // Keep mergeCommand in sync with the command that actually mutated
      // the PR: an audit/log consumer reading this field alone (without
      // also checking adminFallbackUsed) must not see the plain,
      // non-`--admin` command after an admin-fallback merge succeeded.
      verdict.mergeCommand = `${verdict.mergeCommand} --admin`;
      verdict.mergeResult = `admin-fallback (#1521 solo-CODEOWNER deadlock): ${
        adminMergeOutput || 'merge command completed'
      }`;
      return { verdict, exitCode: 0 };
    } catch (adminMergeError) {
      verdict.mergeResult = `admin-fallback merge also failed: ${
        ghErrorText(adminMergeError) || 'unknown error'
      }`;
      return { verdict, exitCode: 1 };
    }
  }
}

/**
 * Fetch the live head SHA and a fresh readiness report, then validate
 * head-match, claim-match, and zero blockers — the fail-closed check
 * this file applies "immediately before merging". Factored out (#1521,
 * Codex review) so the SAME check can run a second time immediately
 * before the `--admin` retry, not just once before the plain merge
 * attempt: real time passes between the two (at minimum the failed
 * plain merge's own round trip), and `--admin` bypasses the entire
 * ruleset, so it must never act on a stale snapshot.
 */
function revalidateImmediatelyBeforeMerge(
  deps: MergeExecuteDeps,
  prNumber: number,
  repoRef: string | null,
  passthrough: string[],
  prHeadSha: string,
):
  | { ok: true; report: Record<string, unknown> }
  | { ok: false; failure: string; blockers?: MergeBlocker[] } {
  let liveHeadSha: string;
  try {
    liveHeadSha = deps.fetchHeadSha(prNumber, repoRef);
  } catch (error) {
    return {
      ok: false,
      failure: `head re-validation failed: ${
        ghErrorText(error) || 'unknown error'
      }; no merge`,
    };
  }
  if (liveHeadSha !== prHeadSha) {
    return {
      ok: false,
      failure: `head drift: validated ${prHeadSha} but live head is ${liveHeadSha}; no merge`,
    };
  }

  let report: Record<string, unknown>;
  try {
    report = deps.collect(passthrough);
  } catch (error) {
    return {
      ok: false,
      failure: `readiness re-validation failed: ${
        ghErrorText(error) || 'unknown error'
      }; no merge`,
    };
  }
  if (String(report.prHeadSha ?? '') !== prHeadSha) {
    return {
      ok: false,
      failure: `head drift on re-validation: ${String(
        report.prHeadSha ?? '',
      )} != ${prHeadSha}; no merge`,
    };
  }
  const claim = asRecord(report.claim);
  if (claim.matchesExpectedClaim !== true) {
    return {
      ok: false,
      failure: `claim lost on re-validation (reason="${String(
        claim.reason ?? 'unknown',
      )}"); no merge`,
    };
  }
  const blockers = evaluateMergeGates(report);
  if (blockers.length > 0) {
    return {
      ok: false,
      failure:
        're-validation found new blockers immediately before merge; no merge',
      blockers,
    };
  }
  return { ok: true, report };
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

  #1521 solo-CODEOWNER --admin fallback: if the plain merge command fails
  with GitHub's "base branch policy prohibits the merge" error, and the
  repository has not set mergeGate.soloCodeownerAdminFallback to
  "hold-and-report" in .github/idd/config.json, this retries ONCE with
  --admin -- but ONLY when reviewerStates.codeownerSelfApproval proves the
  PR author is the sole eligible codeowner (status "clear", a bypass-actor
  reason, and prAuthorIsSoleEligibleCodeowner true). A genuinely
  outstanding review from any other codeowner never triggers this retry.
  The retry also requires a second immediate head/claim/readiness
  re-validation and a live MERGEABLE state; a BEHIND state is accepted only
  when the fresh branch-currency evidence says an up-to-date head is not
  required. Unreadable or unsafe live state aborts the retry.
  The verdict's adminFallbackUsed field records whether this path fired.
`);
}

// CLI: print the verdict as JSON and exit with the gate/merge status.
if (import.meta.main) {
  const { verdict, exitCode } = runMergeExecute(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(exitCode);
}
