#!/usr/bin/env node
// idd-generated-from: src/scripts/rerun-advisory-convergence.mts
//
// The scripts/rerun-advisory-convergence.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Read-only rerun-plan helper for stuck `idd-advisory-convergence` rollups
// (#1431). Automates the manual recovery documented in
// `idd-ci.instructions.md` §Rerun mechanics (#1381, extended by #1424): a
// PR HEAD can accumulate several `idd-advisory-convergence` check-run
// instances (the check fires on pull_request + pull_request_review +
// pull_request_review_comment, and `cancel-in-progress` cancels most of
// them), and the required-check rollup can stay pinned to a stale
// non-passing instance even after the real verdict converges. This helper
// fetches every check-run instance for the current HEAD via the commit
// check-runs API (not the recent-runs list, which can page the target run
// out of view -- see the module-level `fetchCheckRunsForRef` doc comment),
// classifies each instance, and prints the exact sequential `gh run rerun`
// recovery plan. It never calls `gh run rerun` (or any other mutating
// command) itself; a mutating `--apply` mode is a deliberate follow-up
// (out of scope here).
//
// Classification (five states -- the issue's three named buckets, `pass` /
// `rerun-eligible` / `bot-gated-skip`, are a subset here; `pending` and
// `unresolved` are additional fail-safe states so a live run is never
// force-classified into either "skip forever" or "safe to rerun", and an
// unresolvable run identity is reported instead of silently guessed or
// silently dropped):
//   - `pass`: conclusion is success/neutral/skipped -- no action needed.
//   - `pending`: still queued/in_progress (no conclusion yet) -- reported,
//     excluded from the plan (rerunning a live run cancels it, not helps).
//   - `bot-gated-skip`: conclusion is `action_required`, OR the underlying
//     workflow run's actor/triggering_actor is a bot (`type === "Bot"` is
//     the primary signal; a configured advisory-bot login is a defensive
//     fallback) -- rerunning re-enters `action_required` per #1424, so this
//     needs a non-bot trigger or maintainer approval, never a rerun.
//   - `unresolved`: the run id could not be parsed from the check-run's
//     URL, or the per-run lookup itself failed -- reported for manual
//     inspection, never silently dropped and never placed in the plan
//     (fail-closed: an instance this helper cannot positively verify as
//     safe is never recommended for rerun).
//   - `rerun-eligible`: non-pass, terminal, non-bot, resolved -- goes into
//     the ordered rerun plan.
//
// Reuse map (no duplicated identity/config logic):
//   - `resolveAdvisoryPrimaryBotLogin`, `isCopilotReviewerLogin`,
//     `resolveAdvisoryBotLogins`, `advisoryBotIdentityToken` -- the same
//     bot-identity configuration and matching (including the `[bot]`-suffix
//     normalization) every advisory-wait/-convergence helper already uses.
//   - `normalizeCiWaitPolicy` -- the same ciWait.rerunPolicy resolution
//     `idd-ci.instructions.md` §Rerun mechanics makes this helper's own
//     recovery recommendations subject to.
//   - `resolveCiRerunDecision` -- the same rerun-once-budget decision
//     (policy string AND per-run rerun-attempt count) CI-wait itself
//     applies, reused per instance here (via each instance's own
//     `runAttempt`) rather than re-derived, so this helper can never
//     recommend a rerun CI-wait's own budget would already refuse
//     (ci-wait-policy.mts).
//   - `deriveGhHttpStatus` -- discriminates a confirmed 404 (genuinely no
//     remote config) from any other unreadable state, so a cross-repo
//     config fetch fails closed instead of guessing (gh-http-status.mts).
//   - `ghText`, `isCliExecution` -- shared `gh` execution + CLI-entry-point
//     guard (gh-exec.mts).
//   - `parsePaginatedGhNdjson` -- shared NDJSON pagination parser
//     (protocol-helpers.mts), reused directly here rather than through
//     `ghApiJson`'s `paginate` mode: that mode hardcodes `--jq '.[]'` for a
//     bare top-level array, but the commit check-runs endpoint's shape is
//     `{ total_count, check_runs: [...] }`, so this file's own
//     `fetchCheckRunsForRef` passes `--jq '.check_runs[]'` instead.
//
// This helper never mutates GitHub state: it only reads check-run/run data
// and prints a diagnosis plus a plan of commands for a human (or a future
// --apply follow-up) to execute.

import { parseArgs as nodeParseArgs } from 'node:util';

import {
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  resolveAdvisoryPrimaryBotLogin,
} from './advisory-wait-policy.mts';
import {
  normalizeCiWaitPolicy,
  resolveCiRerunDecision,
} from './ci-wait-policy.mts';
import {
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghText,
  isCliExecution,
} from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import type { IddConfig } from './idd-config.mts';
import { isValidIsoTimestamp } from './marker-helpers.mts';
import {
  advisoryBotIdentityToken,
  isCopilotReviewerLogin,
  parsePaginatedGhNdjson,
  resolveAdvisoryBotLogins,
} from './protocol-helpers.mts';

/** The check name this helper diagnoses. Matches
 * `ADVISORY_CONVERGENCE_CHECK_SELECTOR` in advisory-convergence.mts;
 * duplicated as a literal here (not imported) to keep this read-only
 * helper's dependency surface limited to what it actually needs --
 * advisory-convergence.mts pulls in the full claim/waiver/disposition
 * machinery this helper has no use for. */
export const RERUN_PLAN_CHECK_NAME = 'idd-advisory-convergence';

/** Check-run `conclusion` values treated as pass-equivalent, matching
 * `idd-ci.instructions.md`'s normalized required-check states. */
const PASS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** Check-run `status` values meaning "has not concluded yet". Only
 * consulted when `conclusion` is absent -- a completed run always reports
 * a conclusion, so this set is only reached pre-completion. */
const PENDING_STATUSES = new Set([
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending',
]);

/** Workflow-run trigger events this helper trusts to reliably refresh the
 * PR's required-check rollup on rerun, matching the events
 * `idd-advisory-convergence` itself subscribes to (its own header comment,
 * mirrored in `idd-ci.instructions.md` §Rerun mechanics): `pull_request`,
 * `pull_request_review`, `pull_request_review_comment`. A run triggered by
 * any other event -- most notably `workflow_dispatch` -- has no
 * `pull_request` context of its own and is documented as NOT reliably
 * associated with the PR's HEAD SHA, so rerunning it would not dependably
 * clear a stuck rollup even though the run itself is otherwise a plain,
 * non-bot failure. */
const PULL_REQUEST_FAMILY_EVENTS = new Set([
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
]);

/** One classification this helper can assign to a check-run instance. See
 * the module header for the full definition of each state. */
export type RerunPlanClassification =
  | 'pass'
  | 'pending'
  | 'bot-gated-skip'
  | 'unresolved'
  | 'rerun-eligible';

/**
 * One check-run instance, already normalized and (when resolvable) already
 * enriched with its underlying workflow run's identity fields. This is what
 * the pure {@link computeRerunPlan} consumes -- fetching and enrichment
 * happen in {@link collectFromGitHub}, so tests inject this shape directly
 * with no `gh` call, mirroring `advisory-convergence.mts`'s
 * `AdvisoryConvergenceInputs` DI pattern.
 */
export interface RerunPlanRawInstance {
  checkRunId: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Parsed workflow run id from the check-run's URL, or `null` when it
   * could not be parsed. A `null` here always fails closed to
   * `unresolved` -- see {@link classifyInstance}. */
  runId: string | null;
  /** `true` when `runId` resolved but the per-run `gh api` lookup itself
   * failed (network/permission/transient). Distinct from `runId` being
   * unparseable; both fail closed to `unresolved` but are reported with a
   * different reason. */
  runLookupFailed: boolean;
  runEvent: string | null;
  actorLogin: string | null;
  actorType: string | null;
  triggeringActorLogin: string | null;
  triggeringActorType: string | null;
  /** The workflow run's `run_attempt` (1 for the original run; 2, 3, ...
   * after a rerun -- `gh run rerun <id>` increments this on the SAME
   * `runId` rather than minting a new one). `null` when unresolved (same
   * conditions as `runEvent`). Used to derive how many reruns have
   * already happened for this run, so the resolved `ciWait.rerunPolicy`'s
   * rerun-once budget (not just its policy string) can be honored per
   * instance. */
  runAttempt: number | null;
}

/** {@link RerunPlanRawInstance} plus the assigned classification and a
 * human-readable reason. */
export interface RerunPlanClassifiedInstance extends RerunPlanRawInstance {
  classification: RerunPlanClassification;
  reason: string;
}

/**
 * {@link RerunPlanClassifiedInstance} plus the resolved rerun-budget
 * verdict. A distinct type (rather than a field on
 * {@link RerunPlanClassifiedInstance} itself) because the verdict cannot be
 * known per-instance in isolation: it depends on the fully classified set
 * (recovery-refresh candidacy needs to know whether ANY instance is
 * `bot-gated-skip`) and on whether `plan` already has entries from other
 * instances. This is what {@link RerunAdvisoryConvergencePlan.instances}
 * actually reports.
 */
export interface RerunPlanFinalizedInstance
  extends RerunPlanClassifiedInstance {
  /** `true` when this instance was excluded from `plan` (or
   * `recoveryRefreshPlan`) specifically because its own `runAttempt`
   * already exhausted the resolved `ciWait.rerunPolicy`'s rerun-once
   * budget ({@link resolveCiRerunDecision}, ci-wait-policy.mts) -- as
   * opposed to being excluded for any other reason (a non-rerun-target
   * classification, or a `"hold"` policy withholding everything). Lets a
   * caller see WHY an otherwise `rerun-eligible` (or recovery-refresh
   * candidate) instance is absent from its plan without re-deriving the
   * budget decision itself. Always `false` for every other instance. */
  rerunBudgetHeld: boolean;
}

/** One entry in the ordered, deduplicated-by-run-id rerun plan. */
export interface RerunPlanCommand {
  runId: string;
  command: string;
  /** Every check-run id that contributed to this run id (normally one,
   * but a repository could name more than one job identically). */
  checkRunIds: string[];
  /** Earliest known `startedAt` among the contributing check-run
   * instances, or `''` if none is known. Drives the ordering; kept in the
   * output for transparency. */
  startedAt: string;
}

/** Full JSON document printed by this CLI. */
export interface RerunAdvisoryConvergencePlan {
  protocolVersion: '1';
  prNumber: number;
  prHeadSha: string;
  checkName: string;
  now: string;
  instances: RerunPlanFinalizedInstance[];
  counts: {
    pass: number;
    pending: number;
    botGatedSkip: number;
    unresolved: number;
    rerunEligible: number;
    /** How many instances (across `rerun-eligible` classifications and
     * recovery-refresh candidates alike) were excluded from their
     * respective plan specifically due to rerun-budget exhaustion --
     * already counted within `rerunEligible` (or within `pass`, for a
     * refresh candidate); this is the quick-scan aggregate of the same
     * signal as each instance's own
     * {@link RerunPlanFinalizedInstance.rerunBudgetHeld} flag. */
    rerunBudgetHeld: number;
    total: number;
  };
  plan: RerunPlanCommand[];
  /** Fixed guidance describing how to execute `plan`, matching
   * `idd-ci.instructions.md` §Rerun mechanics: sequential, one at a time,
   * waiting for each to finish. Repeated verbatim in the output so a
   * caller does not need to re-derive it from prose elsewhere. */
  planCaveat: string;
  /**
   * Populated only when `plan` is empty AND at least one instance is
   * `bot-gated-skip` AND at least one already-passing, non-bot,
   * pull_request-family instance exists for the same SHA. Rerunning that
   * ALREADY-PASSING instance is the documented recovery
   * (`idd-ci.instructions.md` §Rerun mechanics) for a required-check
   * rollup pinned to a stale bot-gated `action_required` entry -- the
   * rerun does not need to change that instance's own outcome; it only
   * needs to trigger a fresh non-bot-triggered evaluation that replaces
   * the pinned bot-gated state (#1434 review, Codex P1). Empty whenever
   * `plan` already has entries: a genuine rerun-eligible instance already
   * triggers the same non-bot refresh, so no redundant rerun of an
   * already-passing instance is suggested on top of it.
   */
  recoveryRefreshPlan: RerunPlanCommand[];
  /** Guidance for `recoveryRefreshPlan`, printed only when it is
   * non-empty. */
  recoveryRefreshCaveat: string;
  /** The resolved `ciWait.rerunPolicy` this plan honored (`"rerun-once"`
   * or `"hold"`), matching the same policy `idd-ci.instructions.md`
   * §Rerun mechanics already makes the advisory-convergence recovery
   * subject to -- this helper must not recommend a rerun a repository has
   * explicitly opted out of via a `"hold"` policy (#1434 review, Codex
   * P1). */
  rerunPolicy: string;
  /** Non-empty whenever at least one instance that would otherwise have
   * been included was withheld from `plan` or `recoveryRefreshPlan`, for
   * either of two distinct reasons: the resolved `ciWait.rerunPolicy` is `"hold"`
   * (withholds every instance), or the policy is `"rerun-once"` and an
   * instance's own `runAttempt` already exhausted its one-rerun budget
   * (withholds only that instance -- see
   * {@link RerunPlanFinalizedInstance.rerunBudgetHeld} for the
   * per-instance signal). Explains why an array is empty, or smaller than
   * `counts.rerunEligible` would suggest, instead of silently omitting
   * commands with no explanation. */
  rerunPolicyHoldNotice: string;
}

const PLAN_CAVEAT =
  'Rerun the rerun-eligible instances ONE AT A TIME, in the order listed below, waiting for each `gh run rerun` to finish before starting the next -- rerunning several concurrently makes them cancel each other via the shared concurrency group.';

const RECOVERY_REFRESH_CAVEAT =
  'No rerun-eligible instance exists, but at least one check-run is bot-gated-skip and at least one already-PASSING non-bot pull_request-family instance exists for this SHA. Per idd-ci.instructions.md Rerun mechanics, rerunning that already-passing instance (not the bot-gated one) is the documented way to force a fresh non-bot-triggered evaluation and clear a required-check rollup pinned to the stale bot-gated state -- the instance itself does not need to change its outcome.';

/** Pure inputs to {@link computeRerunPlan} (already fetched; this function
 * performs no I/O). */
export interface RerunPlanInput {
  prNumber: number;
  prHeadSha: string;
  checkName?: string;
  /** Repository the generated `gh run rerun` plan commands should target
   * via `-R owner/repo`, so the plan is safe to run from outside the
   * source checkout (e.g. after inspecting a PR with `--owner`/`--repo`).
   * Empty/omitted omits the `-R` flag from generated commands. */
  owner?: string;
  repo?: string;
  instances: RerunPlanRawInstance[];
}

/** Pure options accepted by {@link computeRerunPlan}. */
export interface RerunPlanOptions {
  now: string;
  primaryBotLogin?: string;
  advisoryBotLogins?: unknown[] | null;
  /** Resolved `ciWait.rerunPolicy` (`"rerun-once"` or `"hold"`; any other
   * value normalizes to the documented `"rerun-once"` default, matching
   * `normalizeCiWaitPolicy`'s own fail-safe). `"hold"` suppresses both
   * `plan` and `recoveryRefreshPlan` -- see
   * {@link RerunAdvisoryConvergencePlan.rerunPolicy}. */
  rerunPolicy?: string;
}

/**
 * Compute the deterministic rerun-plan verdict from already-fetched and
 * already-enriched check-run instances. Pure (no I/O), so it is directly
 * unit-testable with fixtures -- mirrors
 * `computeAdvisoryConvergenceVerdict` (advisory-convergence.mts).
 */
export function computeRerunPlan(
  input: RerunPlanInput,
  options: RerunPlanOptions,
): RerunAdvisoryConvergencePlan {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  // Lowercased before validating, so a mixed-/upper-case 40-hex SHA is
  // accepted (normalized), matching advisory-convergence.mts's own rule.
  const prHeadSha = String(input.prHeadSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
    throw new Error('prHeadSha must be a 40-character hexadecimal commit SHA');
  }
  const checkName =
    String(input.checkName ?? '').trim() || RERUN_PLAN_CHECK_NAME;
  const owner = String(input.owner ?? '').trim();
  const repo = String(input.repo ?? '').trim();
  const primaryBotLogin =
    String(options.primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const advisoryBotLogins = normalizeLoginList(options.advisoryBotLogins ?? []);
  const classifyOptions = { primaryBotLogin, advisoryBotLogins };

  const instances = (input.instances ?? []).map((instance) =>
    classifyInstance(instance, classifyOptions),
  );

  // idd-ci.instructions.md §Rerun mechanics makes the advisory-convergence
  // recovery explicitly subject to the resolved ciWait.rerunPolicy: a
  // `"hold"` policy means a repository has deliberately opted out of
  // automatic reruns (withholds every instance), and even under the
  // default `"rerun-once"` policy, an instance whose own `runAttempt`
  // shows a rerun already happened has already used its one-rerun budget
  // (withholds only that instance). Both flow through the SAME
  // {@link resolveCiRerunDecision} (ci-wait-policy.mts) CI-wait itself
  // applies, reused per instance here rather than re-derived, so this
  // helper's recovery recommendations can never drift out of sync with
  // the budget CI-wait already enforces. `runAttempt` counts every rerun
  // of the underlying workflow run regardless of trigger (a manual UI
  // rerun, another session's `gh run rerun`, or this helper's own
  // previously-followed plan) -- treating any prior attempt as already
  // having consumed the budget is intentional: a rollup still stuck after
  // one rerun warrants a human look, not another automated rerun (#1434
  // review, Codex P1).
  const rerunPolicy =
    String(options.rerunPolicy ?? '').trim() === 'hold' ? 'hold' : 'rerun-once';

  const eligibleInstances = instances.filter(
    (instance) => instance.classification === 'rerun-eligible',
  );
  const eligibleDecisions = new Map(
    eligibleInstances.map(
      (instance) =>
        [
          instance.checkRunId,
          resolveInstanceRerunDecision(instance, rerunPolicy),
        ] as const,
    ),
  );
  const plan = buildOrderedPlan(
    eligibleInstances.filter(
      (instance) =>
        eligibleDecisions.get(instance.checkRunId)?.action === 'rerun',
    ),
    owner,
    repo,
  );

  const recoveryRefreshCandidates = selectRecoveryRefreshCandidates(
    instances,
    classifyOptions,
  );
  // Gated on `eligibleInstances.length === 0` -- NOT `plan.length === 0`
  // (this file's own prior bug, CodeRabbit review, #1434): those two are
  // NOT equivalent. `plan` can be empty either because no instance was
  // ever rerun-eligible, OR because a genuine rerun-eligible instance
  // existed but its budget was exhausted/unconfirmed. Gating on
  // `plan.length === 0` alone let a budget-held instance silently fall
  // through to recovery-refresh, which would then recommend rerunning a
  // DIFFERENT, already-passing instance instead -- circumventing the
  // "one rerun, then a human reviews it" boundary the budget hold exists
  // to enforce. `eligibleInstances.length === 0` only takes this path
  // when there was never a real rerun-eligible instance to begin with
  // (the scenario recoveryRefreshPlan's own doc comment describes:
  // bot-gated-only, nothing else to trigger a fresh evaluation).
  const refreshDecisions =
    eligibleInstances.length === 0
      ? new Map(
          recoveryRefreshCandidates.map(
            (instance) =>
              [
                instance.checkRunId,
                resolveInstanceRerunDecision(instance, rerunPolicy),
              ] as const,
          ),
        )
      : new Map<string, ReturnType<typeof resolveCiRerunDecision>>();
  const recoveryRefreshPlan =
    eligibleInstances.length === 0
      ? buildOrderedPlan(
          recoveryRefreshCandidates.filter(
            (instance) =>
              refreshDecisions.get(instance.checkRunId)?.action === 'rerun',
          ),
          owner,
          repo,
        )
      : [];

  const heldEligibleCount = [...eligibleDecisions.values()].filter(
    (decision) => decision.action === 'hold',
  ).length;
  const heldRefreshCount = [...refreshDecisions.values()].filter(
    (decision) => decision.action === 'hold',
  ).length;
  const totalHeldCount = heldEligibleCount + heldRefreshCount;
  // Per-instance reasons a non-"hold" policy still withheld an instance:
  // a confirmed-exhausted budget ('rerun-budget-exhausted') and one that
  // could not be confirmed at all ('run-attempt-unknown', CodeRabbit
  // review, #1434) are reported distinctly below rather than conflated,
  // so the notice never claims a budget is "already used" when it was
  // actually just never confirmed.
  const allHeldReasons = new Set(
    [...eligibleDecisions.values(), ...refreshDecisions.values()]
      .filter((decision) => decision.action === 'hold')
      .map((decision) => decision.reason),
  );
  const rerunPolicyHoldNotice =
    totalHeldCount === 0
      ? ''
      : rerunPolicy === 'hold'
        ? `ciWait.rerunPolicy is "hold": ${describeHeldCounts(heldEligibleCount, heldRefreshCount)} found, but auto-rerun is disallowed by this repository's policy -- a maintainer must manually decide (see idd-ci.instructions.md §Rerun mechanics).`
        : `ciWait.rerunPolicy is "rerun-once" and ${describeRerunOnceHoldReasons(allHeldReasons)}: ${describeHeldCounts(heldEligibleCount, heldRefreshCount)} withheld from the plan -- a maintainer must manually decide (see idd-ci.instructions.md §Rerun mechanics).`;

  const budgetHeldCheckRunIds = new Set(
    [...eligibleDecisions.entries(), ...refreshDecisions.entries()]
      .filter(
        ([, decision]) =>
          decision.reason === 'rerun-budget-exhausted' ||
          decision.reason === 'run-attempt-unknown',
      )
      .map(([checkRunId]) => checkRunId),
  );
  const finalInstances = instances.map((instance) => ({
    ...instance,
    rerunBudgetHeld: budgetHeldCheckRunIds.has(instance.checkRunId),
  }));

  const counts = {
    pass: 0,
    pending: 0,
    botGatedSkip: 0,
    unresolved: 0,
    rerunEligible: 0,
    rerunBudgetHeld: budgetHeldCheckRunIds.size,
    total: instances.length,
  };
  for (const instance of instances) {
    if (instance.classification === 'pass') counts.pass += 1;
    else if (instance.classification === 'pending') counts.pending += 1;
    else if (instance.classification === 'bot-gated-skip')
      counts.botGatedSkip += 1;
    else if (instance.classification === 'unresolved') counts.unresolved += 1;
    else counts.rerunEligible += 1;
  }

  return {
    protocolVersion: '1',
    prNumber: Number(input.prNumber),
    prHeadSha,
    checkName,
    now,
    instances: finalInstances,
    counts,
    plan,
    planCaveat: PLAN_CAVEAT,
    recoveryRefreshPlan,
    recoveryRefreshCaveat:
      recoveryRefreshPlan.length > 0 ? RECOVERY_REFRESH_CAVEAT : '',
    rerunPolicy,
    rerunPolicyHoldNotice,
  };
}

/**
 * Resolve whether `instance` may still be rerun under `rerunPolicy`, given
 * its own `runAttempt`. Reuses {@link resolveCiRerunDecision}
 * (ci-wait-policy.mts) -- the same rerun-once-budget decision
 * `idd-ci.instructions.md` §Rerun mechanics documents CI-wait itself
 * applying -- rather than re-deriving the budget rule here, so this
 * helper's recovery recommendations can never drift out of sync with the
 * policy CI-wait already enforces.
 *
 * Fails closed when `runAttempt` is `null` under a non-`"hold"` policy
 * (an unresolved or not-yet-enriched instance): this previously defaulted
 * the missing value to `1` (treating it as "never rerun", the single
 * MOST PERMISSIVE interpretation) and silently derived `rerunCount: 0`
 * from that guess, rather than withholding an instance whose budget this
 * helper cannot actually confirm (CodeRabbit review, #1434). Reported
 * with its own distinct `reason: 'run-attempt-unknown'` (not conflated
 * with a confirmed-exhausted budget's `'rerun-budget-exhausted'`), so the
 * operator-facing notice can still tell "known, already used" apart from
 * "unconfirmed" -- but both withhold the instance the same way. Under a
 * `"hold"` policy this distinction is moot (every instance is withheld
 * regardless of its own attempt count, and `resolveCiRerunDecision`
 * already reports the correct shared `'policy-hold'` reason for it), so
 * the null-`runAttempt` short-circuit only applies to the non-`"hold"`
 * path where `rerunCount` would otherwise actually be read.
 */
function resolveInstanceRerunDecision(
  instance: RerunPlanRawInstance,
  rerunPolicy: string,
): ReturnType<typeof resolveCiRerunDecision> {
  if (instance.runAttempt === null && rerunPolicy !== 'hold') {
    return {
      action: 'hold',
      reason: 'run-attempt-unknown',
      rerunPolicy,
      rerunCount: 0,
    };
  }
  const rerunCount = Math.max(0, (instance.runAttempt ?? 0) - 1);
  return resolveCiRerunDecision({ rerunPolicy, rerunCount });
}

/** Render "N rerun-eligible instance(s)" and/or "N recovery-refresh
 * candidate(s)" for {@link RerunAdvisoryConvergencePlan.rerunPolicyHoldNotice},
 * omitting either half when its own count is zero. */
function describeHeldCounts(
  eligibleCount: number,
  refreshCount: number,
): string {
  const parts: string[] = [];
  if (eligibleCount > 0)
    parts.push(`${eligibleCount} rerun-eligible instance(s)`);
  if (refreshCount > 0) {
    parts.push(`${refreshCount} recovery-refresh candidate(s)`);
  }
  return parts.join(' and ');
}

/**
 * Render the reason clause for a `"rerun-once"` policy's
 * {@link RerunAdvisoryConvergencePlan.rerunPolicyHoldNotice}, distinguishing
 * a confirmed-exhausted budget from one that could not be confirmed (CodeRabbit
 * review, #1434) -- joined when a single run produces both reasons across
 * different instances, so the notice never overstates certainty ("the
 * budget is already used") for an instance that was actually withheld
 * because its `run_attempt` could not be confirmed at all.
 */
function describeRerunOnceHoldReasons(reasons: ReadonlySet<string>): string {
  const parts: string[] = [];
  if (reasons.has('rerun-budget-exhausted')) {
    parts.push('the one-rerun budget is already used (run_attempt > 1)');
  }
  if (reasons.has('run-attempt-unknown')) {
    parts.push("one or more instances' own run_attempt could not be confirmed");
  }
  // Every "hold" decision under a non-"hold" policy carries one of the
  // two reasons above (resolveCiRerunDecision / resolveInstanceRerunDecision
  // have no third hold reason on that path) -- this fallback is
  // defensive, not a reachable case today.
  return parts.length > 0
    ? parts.join(', and ')
    : 'the one-rerun budget is already used (run_attempt > 1)';
}

/**
 * Select already-passing, non-bot, pull_request-family instances eligible
 * to serve as the recovery-refresh target when no genuine rerun-eligible
 * instance exists but a bot-gated-skip instance does -- see
 * {@link RerunAdvisoryConvergencePlan.recoveryRefreshPlan}. Reuses the
 * exact same bot-detection logic ({@link isBotTriggered}) classification
 * already applies, so a "passing" instance is never suggested for rerun
 * if it was itself bot-triggered (rerunning it would not help either).
 */
function selectRecoveryRefreshCandidates(
  instances: RerunPlanClassifiedInstance[],
  options: { primaryBotLogin: string; advisoryBotLogins: string[] },
): RerunPlanClassifiedInstance[] {
  const hasBotGatedSkip = instances.some(
    (instance) => instance.classification === 'bot-gated-skip',
  );
  if (!hasBotGatedSkip) return [];

  return instances.filter((instance) => {
    if (instance.classification !== 'pass') return false;
    if (instance.runId === null || instance.runLookupFailed) return false;
    const runEvent = String(instance.runEvent ?? '')
      .trim()
      .toLowerCase();
    if (!PULL_REQUEST_FAMILY_EVENTS.has(runEvent)) return false;
    return !isBotTriggered(instance, options);
  });
}

function normalizeLoginList(logins: unknown[]): string[] {
  return logins
    .map((login) =>
      String(login ?? '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

/**
 * Classify one check-run instance. Evaluated as a strict, ordered decision
 * list -- see the module header for the rationale behind each state and
 * why `pending`/`unresolved` exist beyond the issue's three named buckets.
 */
function classifyInstance(
  instance: RerunPlanRawInstance,
  options: { primaryBotLogin: string; advisoryBotLogins: string[] },
): RerunPlanClassifiedInstance {
  const status = String(instance.status ?? '')
    .trim()
    .toLowerCase();
  const conclusion = instance.conclusion
    ? String(instance.conclusion).trim().toLowerCase()
    : null;

  // 1. Pass-equivalent -- no action needed.
  if (conclusion && PASS_CONCLUSIONS.has(conclusion)) {
    return {
      ...instance,
      classification: 'pass',
      reason: `conclusion "${conclusion}" is pass-equivalent`,
    };
  }

  // 2. Still running -- rerunning a live run cancels it, never helps.
  if (!conclusion && PENDING_STATUSES.has(status)) {
    return {
      ...instance,
      classification: 'pending',
      reason: `status "${status}" has not concluded yet; rerunning a live run would cancel it instead of recovering it`,
    };
  }

  // 3. Bot-gated: action_required conclusion, or a bot-triggered actor.
  // Either signal alone is sufficient (matches the issue's literal
  // "bot-triggered / action_required" acceptance wording).
  const botTriggered = isBotTriggered(instance, options);
  if (conclusion === 'action_required' || botTriggered) {
    const actorDescription =
      instance.triggeringActorLogin ?? instance.actorLogin ?? 'unknown actor';
    const reason =
      conclusion === 'action_required' && botTriggered
        ? `conclusion is "action_required" and the triggering actor (${actorDescription}) is a bot; rerunning re-enters action_required (#1424) -- needs a non-bot trigger or maintainer approval`
        : conclusion === 'action_required'
          ? 'conclusion is "action_required"; rerunning without a non-bot trigger or maintainer approval re-enters action_required (#1424)'
          : `triggering actor (${actorDescription}) is a bot; rerunning re-enters action_required (#1424) -- needs a non-bot trigger or maintainer approval`;
    return { ...instance, classification: 'bot-gated-skip', reason };
  }

  // 4. Fail closed on an unresolvable run identity -- never guess.
  if (instance.runId === null) {
    return {
      ...instance,
      classification: 'unresolved',
      reason:
        "could not parse a workflow run id from this check-run's URL; inspect manually",
    };
  }
  if (instance.runLookupFailed) {
    return {
      ...instance,
      classification: 'unresolved',
      reason:
        'the underlying workflow run could not be fetched (network/permission/transient failure); inspect manually',
    };
  }

  // 5. Fail closed on a completed run with no conclusion (malformed/
  // unexpected payload) -- never assume it is safe to rerun.
  if (!conclusion) {
    return {
      ...instance,
      classification: 'unresolved',
      reason: `status "${status}" reported no conclusion; inspect manually`,
    };
  }

  // 6. Fail closed on a non-pull_request-family trigger event (most
  // commonly workflow_dispatch): rerunning it is not documented as a
  // reliable way to refresh the PR's required-check rollup, so never
  // recommend it -- see idd-ci.instructions.md Rerun mechanics.
  const runEvent = String(instance.runEvent ?? '')
    .trim()
    .toLowerCase();
  if (!PULL_REQUEST_FAMILY_EVENTS.has(runEvent)) {
    return {
      ...instance,
      classification: 'unresolved',
      reason: runEvent
        ? `triggering event "${runEvent}" is not pull_request-family (pull_request / pull_request_review / pull_request_review_comment); rerunning it is not a reliable way to refresh the PR's required-check rollup -- inspect manually`
        : 'triggering event is unknown; inspect manually rather than assuming it is safe to rerun',
    };
  }

  // 7. Non-pass, terminal, non-bot, resolved, pull_request-family --
  // safe to rerun.
  return {
    ...instance,
    classification: 'rerun-eligible',
    reason: `conclusion "${conclusion}" is non-passing, non-bot, and resolved (event "${runEvent}"); safe to rerun`,
  };
}

/**
 * `true` when the check-run instance's underlying workflow run was
 * triggered by a bot actor. `type === "Bot"` (checked on both `actor` and
 * `triggering_actor`) is the primary signal -- GitHub sets this
 * consistently for App/bot accounts regardless of login spelling. A
 * configured-login match (`isCopilotReviewerLogin` for the primary
 * advisory bot, or membership in the resolved `advisoryBotLogins` list)
 * is a defensive fallback for a payload that omits `type`.
 *
 * The `advisoryBotLogins` fallback, and the `primaryBotLogin` comparison
 * below it, both compare via {@link advisoryBotIdentityToken} (the same
 * normalization the shared advisory-notice matcher already uses) rather
 * than a raw, un-normalized comparison: a repository can configure a bare
 * login (`my-bot`) while the Actions payload reports the GitHub-appended
 * `[bot]`-suffixed form (`my-bot[bot]`), or vice versa. An un-normalized
 * comparison would miss that match and let a bot-triggered run fall
 * through as rerun-eligible (#1434 review, Codex P2).
 *
 * `isCopilotReviewerLogin` itself only normalizes this way for the
 * *default* Copilot login (a `copilot`/`copilot-pull-request-reviewer*`
 * prefix match); once a repository configures a non-default
 * `primaryBotLogin`, it falls back to an exact `normalized === configured`
 * comparison with no `[bot]`-suffix handling -- the same gap the
 * `advisoryBotLogins` fallback already closed for its own set, just on
 * the separate `primaryBotLogin` path (#1434 review, Codex P2, second
 * occurrence). Re-normalizing `primaryBotLogin` here (rather than
 * changing the shared `isCopilotReviewerLogin` itself, which many other
 * callers rely on for its existing exact-match contract) closes it
 * locally without widening that shared function's behavior.
 */
function isBotTriggered(
  instance: RerunPlanRawInstance,
  options: { primaryBotLogin: string; advisoryBotLogins: string[] },
): boolean {
  if (instance.actorType === 'Bot' || instance.triggeringActorType === 'Bot') {
    return true;
  }
  const actorLogin = String(instance.actorLogin ?? '')
    .trim()
    .toLowerCase();
  const triggeringLogin = String(instance.triggeringActorLogin ?? '')
    .trim()
    .toLowerCase();
  if (
    (actorLogin &&
      isCopilotReviewerLogin(actorLogin, options.primaryBotLogin)) ||
    (triggeringLogin &&
      isCopilotReviewerLogin(triggeringLogin, options.primaryBotLogin))
  ) {
    return true;
  }
  const actorToken = advisoryBotIdentityToken(actorLogin);
  const triggeringToken = advisoryBotIdentityToken(triggeringLogin);
  const primaryBotToken = advisoryBotIdentityToken(options.primaryBotLogin);
  if (
    primaryBotToken &&
    ((Boolean(actorToken) && actorToken === primaryBotToken) ||
      (Boolean(triggeringToken) && triggeringToken === primaryBotToken))
  ) {
    return true;
  }
  const configuredBotTokens = new Set(
    options.advisoryBotLogins.map((login) => advisoryBotIdentityToken(login)),
  );
  return (
    (Boolean(actorToken) && configuredBotTokens.has(actorToken)) ||
    (Boolean(triggeringToken) && configuredBotTokens.has(triggeringToken))
  );
}

/**
 * Build the ordered, deduplicated-by-run-id rerun plan from an already-
 * filtered candidate list (the caller decides which classification(s)
 * qualify -- `rerun-eligible` for the normal plan,
 * {@link selectRecoveryRefreshCandidates}'s output for the recovery-refresh
 * plan). A `gh run rerun <id>` targets a workflow run, not a check-run
 * entry, so two check-run instances that resolved to the same run id
 * collapse into a single plan entry. Ordered by earliest known `startedAt`
 * (empty/unknown sorts first, as the more cautious default), then numeric
 * run id, so the output is deterministic across runs with the same input.
 *
 * `owner`/`repo` are embedded as `-R owner/repo` on each generated command
 * (when both are non-empty) so the plan is safe to run from outside the
 * checkout this helper itself was invoked from -- `gh run rerun <id>` alone
 * resolves its target repository from the caller's cwd/`GH_REPO`, not from
 * whatever `--owner`/`--repo` this helper was given.
 */
function buildOrderedPlan(
  candidates: RerunPlanClassifiedInstance[],
  owner: string,
  repo: string,
): RerunPlanCommand[] {
  const repoFlag = owner && repo ? ` -R ${owner}/${repo}` : '';
  const byRunId = new Map<string, RerunPlanClassifiedInstance[]>();
  for (const instance of candidates) {
    // Both candidate sources already guarantee a resolved, non-null runId
    // (rerun-eligible via classifyInstance step 4; recovery-refresh via
    // selectRecoveryRefreshCandidates's own filter), but guard defensively
    // rather than trusting that invariant silently.
    const runId = String(instance.runId ?? '').trim();
    if (!runId) continue;
    const list = byRunId.get(runId) ?? [];
    list.push(instance);
    byRunId.set(runId, list);
  }

  const entries: RerunPlanCommand[] = [...byRunId.entries()].map(
    ([runId, items]) => {
      const startedAts = items
        .map((item) => item.startedAt)
        .filter((value): value is string => Boolean(value))
        .sort();
      return {
        runId,
        command: `gh run rerun ${runId}${repoFlag}`,
        // Sorted (not insertion order, which merely reflects the source
        // API/candidate iteration order and is not guaranteed stable) so
        // the emitted JSON is deterministic for the same logical plan
        // (#1434 review, Copilot).
        checkRunIds: [...new Set(items.map((item) => item.checkRunId))].sort(),
        startedAt: startedAts[0] ?? '',
      };
    },
  );

  entries.sort((left, right) => {
    if (left.startedAt !== right.startedAt) {
      return left.startedAt < right.startedAt ? -1 : 1;
    }
    const leftId = Number(left.runId);
    const rightId = Number(right.runId);
    if (
      Number.isFinite(leftId) &&
      Number.isFinite(rightId) &&
      leftId !== rightId
    ) {
      return leftId - rightId;
    }
    return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
  });

  return entries;
}

/**
 * Parse a workflow run id out of a GitHub Actions check-run `html_url` (or
 * `details_url`) such as
 * `https://github.com/{owner}/{repo}/actions/runs/<run-id>/job/<job-id>` --
 * the same URL shape `idd-ci.instructions.md`'s Rerun mechanics already
 * document extracting a run id from. Returns `null` (fails closed) rather
 * than guessing when the URL does not match.
 *
 * The run id may be followed by `/` (a job segment), `?` (GitHub appends
 * query strings such as `?check_suite_focus=true` to some check-run
 * permalinks), or end-of-string -- a run id immediately followed by `?`
 * was previously misclassified `unresolved` (#1434 review, Copilot).
 */
export function parseRunIdFromUrl(url: string): string | null {
  const match = /\/actions\/runs\/(\d+)(?:[/?]|$)/.exec(String(url ?? ''));
  return match ? match[1] : null;
}

/** Parsed CLI arguments. */
interface RerunPlanArgs {
  prNumber: number | null;
  owner: string;
  repo: string;
  now: string;
  help: boolean;
}

/**
 * Rewrite a `--pr VALUE` pair into the single token `--pr=VALUE` whenever
 * `VALUE` starts with a single dash (not `--`) -- `node:util`'s own
 * `parseArgs` (`strict: true`) throws `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`
 * ("... argument is ambiguous") for a bare `--pr -5`, since a
 * single-dash-prefixed value could plausibly be another short option
 * instead. Left uncaught, this crashed the CLI with a raw, uncaught Node
 * stack trace instead of this file's own documented `--pr` contract ("an
 * invalid --pr resolves to null (fails closed at the caller)") --
 * verified empirically (`--pr -5` threw before this fix; a negative PR
 * number is never valid, but the failure mode should be the same clean
 * `prNumber: null` every other malformed `--pr` value already gets, not
 * an uncaught crash) (self-discovered while evaluating #1446's shared
 * `cli-args.mts` wrapper, which solves this same class of gap generically
 * -- adopting it here is out of scope for #1431; this is the narrow,
 * `--pr`-only equivalent). Only `--pr` needs this: none of this file's
 * other flags (`--owner`, `--repo`, `--now`) can realistically take a
 * dash-prefixed value, and `--help`/`-h` is boolean (no value to
 * disambiguate).
 */
function disambiguateSingleDashPrValue(argv: readonly string[]): string[] {
  const rewritten: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    const isAmbiguousValue =
      typeof next === 'string' &&
      next.startsWith('-') &&
      !next.startsWith('--');
    if (token === '--pr' && isAmbiguousValue) {
      rewritten.push(`--pr=${next}`);
      index += 1;
      continue;
    }
    rewritten.push(token);
  }
  return rewritten;
}

/**
 * Mechanical CLI-argument parsing is delegated to `node:util`'s own
 * stable (since Node 20; this repo's engines floor is `^22.22.2 || >=24`)
 * `parseArgs`, per a maintainer's review suggestion on PR #1434: it
 * already rejects a missing value, a value that looks like another
 * option (long `--foo` or short `-h` alike -- the hand-rolled
 * `requireFlagValue` this replaced only checked for `--`, so `--owner -h`
 * silently consumed `-h` as the owner instead of erroring), and an
 * unknown option, each with Node's own stable `ERR_PARSE_ARGS_*` error
 * codes. `allowPositionals: false` closes one more gap `strict: true`
 * alone does not: `strict` governs unknown *options*, not leftover
 * positional (non-option) tokens, so an invocation like
 * `--pr 1431 extra` would otherwise silently accept `extra` instead of
 * failing fast -- risky for a recovery/rerun helper where a typo should
 * error, not run against unintended, silently-ignored input (#1434
 * review, Copilot). This function's own job narrows to the
 * domain-specific validation `parseArgs` cannot express declaratively:
 * the `--pr` value must be all digits (not just numeric-prefixed), and
 * `--owner`/`--repo` must be given together or not at all.
 */
export function parseArgs(argv: string[]): RerunPlanArgs {
  const { values } = nodeParseArgs({
    args: disambiguateSingleDashPrValue(argv),
    options: {
      pr: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      now: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    return { prNumber: null, owner: '', repo: '', now: '', help: true };
  }

  const owner = String(values.owner ?? '').trim();
  const repo = String(values.repo ?? '').trim();
  // A caller inspecting a different repository must fully specify it --
  // mixing a user-supplied owner with a `gh repo view`-derived repo (or
  // vice versa) would query a mismatched, unintended repository
  // (#1434 review, Copilot).
  if (Boolean(owner) !== Boolean(repo)) {
    throw new Error('provide both --owner and --repo, or neither');
  }

  // Number.parseInt parses only a leading numeric prefix ("1431abc" ->
  // 1431), which would silently run this recovery helper -- and whatever
  // `gh run rerun` plan it prints -- against the wrong PR on a typo.
  // Require the entire value to be digits before parsing (#1434 review,
  // Codex P2).
  const rawPr = String(values.pr ?? '').trim();
  const parsedPr = /^\d+$/.test(rawPr)
    ? Number.parseInt(rawPr, 10)
    : Number.NaN;

  return {
    prNumber: Number.isInteger(parsedPr) && parsedPr >= 1 ? parsedPr : null,
    owner,
    repo,
    now: String(values.now ?? '').trim(),
    help: false,
  };
}

/**
 * Describe outstanding `pending` / `bot-gated-skip` / `unresolved`
 * instance counts, or `''` when none exist. Extracted from
 * {@link describeNoActionState} so the CLI can surface these states
 * independently of whether a rerun plan, recovery-refresh plan, or hold
 * notice ALSO exists for a different instance in the same run --
 * previously these were only ever shown when NONE of those three
 * existed, silently hiding e.g. 2 still-pending instances whenever the
 * output happened to also have a rerun plan for a different instance
 * (CodeRabbit review, #1434).
 */
export function describeOutstandingStates(
  plan: RerunAdvisoryConvergencePlan,
): string {
  const notes: string[] = [];
  if (plan.counts.pending > 0) {
    notes.push(
      `${plan.counts.pending} instance(s) are still running -- wait for them to complete, then re-run this diagnosis`,
    );
  }
  if (plan.counts.botGatedSkip > 0) {
    notes.push(
      `${plan.counts.botGatedSkip} instance(s) are bot-gated -- they need a non-bot trigger or maintainer approval (see idd-ci.instructions.md §Rerun mechanics), not a rerun`,
    );
  }
  if (plan.counts.unresolved > 0) {
    notes.push(
      `${plan.counts.unresolved} instance(s) could not be resolved -- inspect each instance's "reason" above manually`,
    );
  }
  return notes.join('; ');
}

/**
 * Describe the terminal state when there is truly nothing to report:
 * no rerun plan, no recovery-refresh plan, no hold notice, AND no
 * outstanding `pending` / `unresolved` / `bot-gated-skip` instance (see
 * {@link describeOutstandingStates}, which the CLI now also consults
 * independently of this function). "Nothing to do" would be accurate
 * only when every instance is `pass` (or there are no instances at all)
 * -- `pending`, `unresolved`, and `bot-gated-skip` all still require an
 * operator action (waiting, manual inspection, approval, or a non-bot
 * trigger, per each instance's own `reason`), so presenting them as
 * no-action risked leaving a genuinely stuck required check unresolved
 * (#1434 review, Codex P2).
 */
export function describeNoActionState(
  plan: RerunAdvisoryConvergencePlan,
): string {
  if (plan.counts.total === 0) {
    return `No "${plan.checkName}" check-run instances found for this HEAD; nothing to do.`;
  }
  const notes = describeOutstandingStates(plan);
  if (!notes) {
    return 'Every instance is pass-equivalent; nothing to do.';
  }
  return `No rerun-eligible instance and no recovery-refresh option, but this is not a clean "nothing to do": ${notes}.`;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/rerun-advisory-convergence.mjs --pr <number> [--owner <owner> --repo <repo>] [--now <ISO8601>] [--help]

Read-only: fetches every "${RERUN_PLAN_CHECK_NAME}" check-run instance for
the PR's current HEAD SHA (commit check-runs API, paged -- not the
recent-runs list, which can page the target run out of view), classifies
each as pass / pending / bot-gated-skip / unresolved / rerun-eligible, and
prints the ordered sequential "gh run rerun <id>" recovery plan for the
rerun-eligible instances (each command includes "-R <owner>/<repo>" when
the repository is known, so the plan is safe to run outside this
checkout). Never calls "gh run rerun" (or any other mutating command)
itself.

--owner and --repo must be given together (to inspect a PR outside the
current checkout) or omitted together (to auto-detect the current
checkout's own repository) -- providing only one is rejected.

Honors the inspected repository's configured ciWait.rerunPolicy: when
it is "hold", both the rerun plan and the recovery-refresh plan stay
empty (with a notice explaining why) instead of recommending reruns a
repository has deliberately opted out of.

On a normal (non-help) run, stdout carries ONLY the JSON plan document
(safe to pipe into "jq" or similar); the human-readable recovery-plan
summary is printed to stderr. (This --help text itself is the one
exception: it is plain usage text on stdout, not JSON.)
`);
}

/** Dependencies injected by tests; production defaults perform real I/O. */
export interface RerunPlanDeps {
  collect: (args: RerunPlanArgs) => {
    input: RerunPlanInput;
    options: RerunPlanOptions;
  };
}

const defaultDeps: RerunPlanDeps = { collect: collectFromGitHub };

/**
 * Parse argv, collect evidence (via `deps.collect`, real `gh` calls by
 * default), and compute the plan. Mirrors `runAdvisoryConvergence`'s DI
 * pattern (advisory-convergence.mts) so tests can substitute a fake
 * `collect` instead of shelling out to `gh`.
 */
export function runRerunAdvisoryConvergence(
  argv: string[],
  deps: RerunPlanDeps = defaultDeps,
): { plan: RerunAdvisoryConvergencePlan | null; help: boolean } {
  const args = parseArgs(argv);
  if (args.help) {
    return { plan: null, help: true };
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }

  const { input, options } = deps.collect(args);
  const plan = computeRerunPlan(input, options);
  return { plan, help: false };
}

// --- Production I/O: fetch check-run/run evidence via `gh` --------------

/** Check-run entry fields consumed from
 * `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`. */
interface RawCheckRunPayload {
  id?: number | string | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/** Actor reference embedded in a workflow-run payload. */
interface RunActorPayload {
  login?: string | null;
  type?: string | null;
}

/** Run fields consumed from
 * `GET /repos/{owner}/{repo}/actions/runs/{run_id}`. */
interface RawWorkflowRunPayload {
  event?: string | null;
  actor?: RunActorPayload | null;
  triggering_actor?: RunActorPayload | null;
  /** 1 for the original run; increments on the SAME run id after `gh run
   * rerun` -- see {@link RerunPlanRawInstance.runAttempt}. */
  run_attempt?: number | null;
}

/**
 * Fetch every check-run instance named `checkName` for `ref` via the
 * commit check-runs API, paginated.
 *
 * Deliberately NOT the recent-runs / workflow-runs list
 * (`GET /repos/{owner}/{repo}/actions/runs?head_sha=...`): that list is
 * ordered across every workflow in the repository, so a specific run for
 * a busy SHA can sit many pages deep -- exactly the "paged out of the
 * recent-runs window" problem the issue calls out. This endpoint is
 * scoped to the single commit and check name instead, via the documented
 * `check_name` query parameter.
 *
 * `--method GET` is required alongside the `-f check_name=...` field:
 * `gh api` defaults to POST as soon as any `-f`/`-F` value is present
 * (its own `--help` text: "The default HTTP request method is GET
 * normally and POST if any parameters were added"), and this endpoint
 * only accepts GET -- an unqualified `-f` here silently sends a POST that
 * 404s, confirmed against the live API while fixing #1431. `--method GET`
 * is what makes `-f` append to the query string instead.
 *
 * `-f filter=all` is required alongside `check_name`: this endpoint's own
 * `filter` query parameter defaults to `latest`, which -- per GitHub's own
 * documented behavior, confirmed empirically against this repo's actual
 * PR history during review -- collapses same-named check runs down to
 * only the most-recently-completed instance, silently dropping exactly
 * the older non-passing instance this helper exists to recover. Without
 * `filter=all`, `instances` can (and did, in the reproduction above) omit
 * real check-run instances even though `--paginate` runs correctly.
 *
 * Not built on {@link ghApiJson}'s own `paginate` option: that option
 * hardcodes `--jq '.[]'`, which assumes a bare top-level array, but this
 * endpoint's shape is `{ total_count, check_runs: [...] }` -- so this
 * function passes `--jq '.check_runs[]'` directly and reuses the same
 * {@link parsePaginatedGhNdjson} parser `ghApiJson` uses internally.
 */
export function buildCheckRunsForRefArgs(
  owner: string,
  repo: string,
  ref: string,
  checkName: string,
): string[] {
  const path = `repos/${owner}/${repo}/commits/${ref}/check-runs`;
  return [
    'api',
    path,
    '--method',
    'GET',
    '-f',
    `check_name=${checkName}`,
    '-f',
    'filter=all',
    '--paginate',
    '--jq',
    '.check_runs[]',
  ];
}

/**
 * Resolve the URL used to extract a check-run's workflow-run id, preferring
 * `details_url` over `html_url`. For a GitHub-Actions-created check run
 * (which `idd-advisory-convergence` always is) the two are typically
 * identical, but the Checks API's own field semantics make `html_url` the
 * one more likely to diverge to a non-Actions permalink (e.g. a
 * `/checks/<check_run_id>`-shaped URL) -- `details_url` is documented as
 * "the full details of the check" and is the one this repo's own
 * `idd-ci.instructions.md` Rerun mechanics already document extracting a
 * run id from. Preferring it first costs nothing when the two agree and
 * avoids a spurious `unresolved` classification when they do not.
 */
export function resolveCheckRunUrl(run: RawCheckRunPayload): string {
  return String(run.details_url ?? run.html_url ?? '');
}

function fetchCheckRunsForRef(
  owner: string,
  repo: string,
  ref: string,
  checkName: string,
): RawCheckRunPayload[] {
  // GH_TEXT_LOOP_TIMEOUT_OPTIONS (stdin ignored, 30s timeout) here too --
  // sibling gap to the per-run lookup loop's own fix above. Not the FIRST
  // `gh` call this helper makes overall (collectFromGitHub's own
  // `repo view` / `pr view` calls run before this one) but the first
  // potentially long-running one: `--paginate` can mean several HTTP
  // round-trips within the one `execFileSync` invocation on a busy PR's
  // check-run history, so a stalled or unexpectedly-interactive `gh`
  // (rate limiting, network stall, an auth re-prompt) here would hang
  // this read-only helper before it ever reaches the fail-closed
  // classification logic below, let alone the per-run loop's own timeout
  // (#1434 review, Copilot).
  const raw = ghText(
    buildCheckRunsForRefArgs(owner, repo, ref, checkName),
    GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  );
  return parsePaginatedGhNdjson(raw) as RawCheckRunPayload[];
}

/**
 * Fetch and parse `.github/idd/config.json` for `owner/repo` **at `ref`**
 * via the Contents API. Used unconditionally -- both a same-repo and a
 * true cross-repository invocation -- rather than a local `readFileSync`
 * fallback for the same-repo case (`loadIddConfig`, idd-config.mts).
 *
 * `ref` must be the repository's TRUSTED default branch (see
 * {@link resolveDefaultBranch}), never `prHeadSha` and never a local
 * working-tree read: the `idd-advisory-convergence` workflow this helper
 * diagnoses deliberately checks out the DEFAULT branch, not the PR head,
 * for both its verdict script and `.github/idd/config.json` --
 * `idd-advisory-convergence.yml`'s own header comment documents this
 * exact "trusted-code checkout" posture, precisely so a PR cannot edit
 * its own bot-identity config to disguise a bot-triggered run as
 * non-bot, or loosen `ciWait.rerunPolicy` to grant itself a rerun the
 * repository's real policy forbids. This helper must resolve the SAME
 * trusted config the workflow itself used to produce the check-run
 * verdicts being diagnosed, or its classification and rerun
 * recommendations can disagree with (and be gamed relative to) what
 * actually governed those runs (#1434 review, Codex P2, second
 * occurrence -- reverts this file's own prior "always prHeadSha" fix,
 * which solved the "unpinned ref" bug but pinned the wrong ref).
 *
 * `--method GET` is required alongside the `-f ref=...` field, for the
 * same reason `buildCheckRunsForRefArgs` above needs it: `gh api` defaults
 * to POST as soon as any `-f` value is present, and the Contents API only
 * accepts GET -- an unqualified `-f ref=...` here would 404 on every call
 * (confirmed empirically), which this function's own catch block would
 * silently treat as "config genuinely absent, use defaults" instead of
 * surfacing the real problem.
 *
 * Returns `null` -- falls back to documented defaults, same as a missing
 * local file -- **only** on a confirmed 404 (`ref` genuinely has no
 * config committed, the same "absent" state `loadIddConfig` treats as
 * "use defaults" locally). Any other failure -- a permission error, a
 * transient Contents API failure, or malformed content -- means this
 * helper cannot confirm whether `ref` configures a non-default bot
 * identity, so silently substituting defaults could misclassify a
 * bot-triggered run there as rerun-eligible. Per this repo's own
 * fail-closed default (`idd-overview-core.instructions.md`), that
 * ambiguity throws instead of guessing, rejecting the diagnosis outright
 * rather than proceeding on unconfirmed bot identity (#1434 review, Codex
 * P2).
 */
export function buildIddConfigContentsArgs(
  owner: string,
  repo: string,
  ref: string,
): string[] {
  return [
    'api',
    `repos/${owner}/${repo}/contents/.github/idd/config.json`,
    '--method',
    'GET',
    '-f',
    `ref=${ref}`,
    '--jq',
    '.content',
  ];
}

function loadRemoteIddConfig(
  owner: string,
  repo: string,
  ref: string,
): IddConfig | null {
  try {
    const encoded = ghText(
      buildIddConfigContentsArgs(owner, repo, ref),
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
    const decoded = Buffer.from(encoded.replace(/\n/g, ''), 'base64').toString(
      'utf8',
    );
    return JSON.parse(decoded) as IddConfig;
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot confirm .github/idd/config.json for ${owner}/${repo}@${ref}: bot-identity resolution for this diagnosis requires this file to be readable or genuinely absent (404) at this ref, not merely unreadable -- ${message}`,
    );
  }
}

/**
 * Resolve `owner/repo`'s default branch via the Repository API -- the
 * `ref` {@link loadRemoteIddConfig} must read `.github/idd/config.json`
 * from (see its own doc comment for why). Never hardcoded to `main`:
 * both this source repository's own `idd-advisory-convergence.yml` and
 * the `idd-template/` copy distributed to adopters document their
 * checkout's `ref: main` as standing in for "your own default branch
 * name if it differs" -- a portable, reusable helper must resolve this
 * dynamically per target repository rather than assume the source
 * repository's own convention. No `-f` value is present, so `gh api`
 * defaults to GET here without needing `--method GET` (confirmed
 * empirically; the POST-default only triggers once a `-f`/`-F` value is
 * added, unlike the other `gh api` calls in this file).
 */
function resolveDefaultBranch(owner: string, repo: string): string {
  return ghText(
    ['api', `repos/${owner}/${repo}`, '--jq', '.default_branch'],
    GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  );
}

function collectFromGitHub(args: RerunPlanArgs): {
  input: RerunPlanInput;
  options: RerunPlanOptions;
} {
  // A true cross-repository invocation only when the caller explicitly
  // named both --owner and --repo (parseArgs already rejects naming only
  // one) -- the common case (neither given) auto-detects the local
  // checkout's own repo below. `isCrossRepo` no longer changes which
  // config source this function reads from (both paths fetch
  // .github/idd/config.json from owner/repo's trusted default branch via
  // resolveDefaultBranch + loadRemoteIddConfig below) -- it still gates
  // the IDD_ADVISORY_BOT_LOGINS env-var scoping further down, since that
  // env var describes the *caller's own local context*, not either
  // config source (#1434 review, Copilot: this comment previously
  // claimed the same-repo path "must keep reading its own local config",
  // which stopped being true once config resolution moved off local disk
  // entirely).
  const isCrossRepo = Boolean(args.owner) && Boolean(args.repo);
  // GH_TEXT_LOOP_TIMEOUT_OPTIONS on every `gh` call in this function,
  // including these first three (owner/repo/PR-head resolution) -- same
  // hang hazard as fetchCheckRunsForRef and the per-run lookup loop below:
  // a stalled or unexpectedly-interactive `gh` here would hang this
  // read-only helper before it resolves even the basic identity of what
  // it is diagnosing (#1434 review, Copilot).
  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repoRef = `${owner}/${repo}`;

  const prHeadSha = ghText(
    [
      'pr',
      'view',
      String(args.prNumber),
      '-R',
      repoRef,
      '--json',
      'headRefOid',
      '--jq',
      '.headRefOid',
    ],
    GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ).toLowerCase();

  const rawCheckRuns = fetchCheckRunsForRef(
    owner,
    repo,
    prHeadSha,
    RERUN_PLAN_CHECK_NAME,
  );

  // Resolve each unique run id exactly once (a direct by-ID GET, never a
  // list scan -- see fetchCheckRunsForRef's doc comment for why lists are
  // avoided here).
  const runIdsToResolve = [
    ...new Set(
      rawCheckRuns
        .map((run) => parseRunIdFromUrl(resolveCheckRunUrl(run)))
        .filter((id): id is string => id !== null),
    ),
  ];

  const runMetaById = new Map<
    string,
    {
      event: string | null;
      actorLogin: string | null;
      actorType: string | null;
      triggeringActorLogin: string | null;
      triggeringActorType: string | null;
      runAttempt: number | null;
    } | null // null means the per-run lookup itself failed
  >();
  // GH_TEXT_LOOP_TIMEOUT_OPTIONS (stdin ignored, 30s timeout), not a bare
  // `ghApiJson` call: this loop can run once per distinct run id on a busy
  // PR, and `ghApiJson` execs `gh` with no stdio override and no timeout,
  // so a single stalled or unexpectedly-interactive `gh` invocation (rate
  // limiting, network stall, an auth re-prompt) would hang this read-only
  // helper indefinitely instead of failing closed into the existing
  // per-run `catch` below -- the same tight-loop hazard every other
  // high-volume `gh api` loop in this repo already guards against with
  // this shared options constant (#1434 review, Copilot).
  for (const runId of runIdsToResolve) {
    try {
      const runPayload = JSON.parse(
        ghText(
          ['api', `repos/${owner}/${repo}/actions/runs/${runId}`],
          GH_TEXT_LOOP_TIMEOUT_OPTIONS,
        ),
      ) as RawWorkflowRunPayload;
      runMetaById.set(runId, {
        event: runPayload.event ? String(runPayload.event) : null,
        actorLogin: runPayload.actor?.login ?? null,
        actorType: runPayload.actor?.type ?? null,
        triggeringActorLogin: runPayload.triggering_actor?.login ?? null,
        triggeringActorType: runPayload.triggering_actor?.type ?? null,
        runAttempt:
          typeof runPayload.run_attempt === 'number' &&
          Number.isInteger(runPayload.run_attempt)
            ? runPayload.run_attempt
            : null,
      });
    } catch {
      runMetaById.set(runId, null);
    }
  }

  const instances: RerunPlanRawInstance[] = rawCheckRuns.map((run) => {
    const url = resolveCheckRunUrl(run);
    const runId = parseRunIdFromUrl(url);
    const meta = runId !== null ? runMetaById.get(runId) : undefined;
    return {
      checkRunId: String(run.id ?? ''),
      status: String(run.status ?? ''),
      conclusion: run.conclusion ? String(run.conclusion) : null,
      htmlUrl: url,
      startedAt: run.started_at ? String(run.started_at) : null,
      completedAt: run.completed_at ? String(run.completed_at) : null,
      runId,
      runLookupFailed: runId !== null && meta === null,
      runEvent: meta?.event ?? null,
      actorLogin: meta?.actorLogin ?? null,
      actorType: meta?.actorType ?? null,
      triggeringActorLogin: meta?.triggeringActorLogin ?? null,
      triggeringActorType: meta?.triggeringActorType ?? null,
      runAttempt: meta?.runAttempt ?? null,
    };
  });

  // Fetched from owner/repo's TRUSTED DEFAULT BRANCH, unconditionally --
  // same-repo and cross-repo alike -- never the PR head and never a local
  // `loadIddConfig()` read: the idd-advisory-convergence workflow whose
  // check-runs this helper diagnoses deliberately checks out the default
  // branch (never the PR head) for both its verdict script and this
  // config, so this is the config that actually governed the runs being
  // diagnosed. Reading the PR-head config instead (this file's own prior
  // fix) would let a PR redefine its own bot identity or loosen
  // `ciWait.rerunPolicy` to influence its own classification/rerun
  // recommendation -- see buildIddConfigContentsArgs's doc comment for
  // the full rationale (#1434 review, Codex P2, second occurrence).
  const configRef = resolveDefaultBranch(owner, repo);
  const rawConfig = loadRemoteIddConfig(owner, repo, configRef);
  const primaryBotLogin = resolveAdvisoryPrimaryBotLogin(rawConfig);
  // The caller's local IDD_ADVISORY_BOT_LOGINS env var describes the
  // *local* checkout's own advisory bots. resolveAdvisoryBotLogins gives
  // an env value priority over `config`, so passing it unconditionally
  // would let a local-context env var silently override the *target*
  // repository's own configured bot logins during a true cross-repo
  // diagnosis -- undermining the config-binding fix above. Omit it for a
  // cross-repo invocation so resolution falls through to the target
  // repo's own config (#1434 review, Codex P2).
  const { logins: advisoryBotLogins } = resolveAdvisoryBotLogins({
    envValue: isCrossRepo ? '' : process.env.IDD_ADVISORY_BOT_LOGINS,
    config: rawConfig,
  });
  // Same config source as the bot-identity fields above -- the trusted
  // default-branch ciWait.rerunPolicy, never a stale local read, the PR's
  // own (possibly loosened) policy, or (for a cross-repo invocation) the
  // caller's own repo's policy.
  const { rerunPolicy } = normalizeCiWaitPolicy(
    (rawConfig as { ciWait?: unknown } | null)?.ciWait,
  );

  return {
    input: {
      prNumber: Number(args.prNumber),
      prHeadSha,
      checkName: RERUN_PLAN_CHECK_NAME,
      owner,
      repo,
      instances,
    },
    options: {
      now: args.now || new Date().toISOString().replace('.000Z', 'Z'),
      primaryBotLogin,
      advisoryBotLogins,
      rerunPolicy,
    },
  };
}

// CLI: emit the plan as JSON plus a human-readable ordered command list.
// Guarded behind isCliExecution(import.meta.url) (shared, see gh-exec.mts)
// so importing this module (for unit tests) never parses process.argv,
// prints usage, or makes a `gh` call.
if (isCliExecution(import.meta.url)) {
  const { plan, help } = runRerunAdvisoryConvergence(process.argv.slice(2));
  if (help) {
    printHelp();
  } else if (plan) {
    // stdout carries ONLY the JSON document -- nothing else -- so the
    // overall stdout stream stays valid, machine-parseable JSON (e.g.
    // safely pipeable into `jq`). The human-readable recovery-plan
    // summary below is real, useful output, but it belongs on stderr:
    // mixing it into stdout after the JSON previously broke piping
    // despite the stream *starting* with a well-formed document
    // (#1434 review, Copilot).
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (plan.plan.length > 0) {
      process.stderr.write(
        '\nSequential recovery plan (run one at a time; wait for each to finish before the next):\n',
      );
      plan.plan.forEach((entry, index) => {
        process.stderr.write(`  ${index + 1}. ${entry.command}\n`);
      });
      process.stderr.write(`\n${plan.planCaveat}\n`);
    } else if (plan.recoveryRefreshPlan.length > 0) {
      process.stderr.write(
        '\nNo rerun-eligible instances, but a recovery-refresh option is available:\n',
      );
      plan.recoveryRefreshPlan.forEach((entry, index) => {
        process.stderr.write(`  ${index + 1}. ${entry.command}\n`);
      });
      process.stderr.write(`\n${plan.recoveryRefreshCaveat}\n`);
    } else if (plan.rerunPolicyHoldNotice) {
      process.stderr.write(`\n${plan.rerunPolicyHoldNotice}\n`);
    }
    // Independent of whichever branch above did (or did not) fire:
    // outstanding pending / bot-gated / unresolved instances are reported
    // unconditionally whenever they exist, rather than only when NONE of
    // the three branches above already had something to say -- those
    // branches are about a DIFFERENT instance's rerun/refresh/hold
    // outcome, and previously hid a genuinely-still-outstanding instance
    // (e.g. 2 pending check-runs) any time a rerun plan also existed for
    // a separate instance in the same run (CodeRabbit review, #1434).
    const outstanding = describeOutstandingStates(plan);
    if (outstanding) {
      process.stderr.write(`\n${outstanding}\n`);
    } else if (
      plan.plan.length === 0 &&
      plan.recoveryRefreshPlan.length === 0 &&
      !plan.rerunPolicyHoldNotice
    ) {
      // Genuinely nothing to report at all.
      process.stderr.write(`\n${describeNoActionState(plan)}\n`);
    }
  }
  // Set exitCode and let the process end naturally instead of calling
  // process.exit(0) directly: an explicit exit() can terminate the process
  // before a large stdout write finishes flushing through a pipe (a
  // well-established Node.js footgun, confirmed empirically during
  // review), silently truncating the emitted JSON or recovery plan.
  process.exitCode = 0;
}
