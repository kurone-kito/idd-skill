#!/usr/bin/env node
// idd-generated-from: src/scripts/branch-conflict-state.mts
//
// The scripts/branch-conflict-state.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync, spawnSync } from 'node:child_process';

import { parseCliArgs } from './cli-args.mts';
import { ghText, resolveGhOwnerRepo } from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadTrustedIddConfig } from './idd-config.mts';
import {
  isCompletedCiTimestamp,
  selectLatestCheckInstance,
  summarizeBranchCurrency,
} from './protocol-helpers.mts';
import { createGithubProviderAdapter } from './provider-adapter-github.mts';

interface PrData {
  headRefOid?: unknown;
  baseRefOid?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
}

/**
 * Every `branchState` that `deriveBranchState` returns. The schema enum also
 * names `force-push-exception`, which this classifier never returns.
 */
export const DERIVED_BRANCH_STATES = [
  'clean',
  'behind-no-conflict',
  'content-conflict',
  'dirty',
  'computing',
  'unknown',
] as const;

/**
 * Every `syncRecommendation` that `deriveBranchState` returns. The schema enum
 * also names `policy-required-update` and `force-push-exception`, which this
 * classifier never returns.
 */
export const DERIVED_SYNC_RECOMMENDATIONS = [
  'none',
  'merge-base',
  'recheck',
  'hold-unknown',
] as const;

export interface BranchStateDerivation {
  branchState: (typeof DERIVED_BRANCH_STATES)[number];
  syncRecommendation: (typeof DERIVED_SYNC_RECOMMENDATIONS)[number];
  conflictFiles: string[];
  mergeableSource: string;
  baseAdvancedSinceMergeBase: boolean;
}

/**
 * JSON state document printed by this CLI: the branch conflict and
 * synchronization classification for one PR head
 * (schemas/branch-conflict-state.schema.json).
 */
export interface BranchConflictResult {
  protocolVersion: string;
  prNumber: number;
  prHeadSha: string;
  prBaseSha: string;
  published: boolean;
  mergeable: string | null;
  mergeStateStatus: string | null;
  branchState: string;
  syncRecommendation: string;
  baseAdvancedSinceMergeBase: boolean;
  callSiteRouting: CallSiteRouting;
  readOnly: boolean;
  worktreeUnchanged: boolean;
  diagnostics: {
    mergeableSource: string;
    conflictFiles: string[];
    notes: string[];
  };
}

/**
 * Next step each E/F call site takes for the classified branch state, so the
 * routing table lives here once instead of in three phase files. Values are
 * named by the phase file's own action, not by the prose around it.
 */
export interface CallSiteRouting {
  /** E-phase branch-sync check in idd-review-triage.instructions.md. */
  eBranchSync: 'proceed-to-f1' | 'sync-path' | 'retry' | 'hold';
  /** E11 in idd-review-fix.instructions.md (merge only on content-conflict). */
  e11: 'skip-merge' | 'merge-development-branch';
  /** F1 in idd-pre-merge.instructions.md. */
  f1: 'proceed-to-f2' | 'return-to-e-phase-branch-sync' | 'retry' | 'hold';
}

/**
 * One non-passing check run on the PR head, collected at F1 time for the
 * UNSTABLE routing decision. `state` is the lowercased conclusion of a
 * completed run (`action_required`, `failure`, ...), or `pending` while the
 * run has not completed. `required` is GitHub's own `isRequired` answer.
 *
 * #4309: a check suite that has no check run is not in the rollup at all, so
 * it is listed here too. Its `name` is the app slug (plus the workflow name
 * for a workflow suite), `suiteStatus` is its own lowercased status, or its
 * conclusion once completed, and `required` follows the base branch's
 * source-pinned required checks (see {@link markSuiteRequirement}) because
 * a suite has no `isRequired` of its own.
 */
export interface NonPassingRun {
  name: string;
  state: string;
  required: boolean;
  suiteStatus?: string;
}

/**
 * Map a classified branch state to each call site's next step.
 *
 * `clean` proceeds with `mergeStateStatus` CLEAN, which is F1's own
 * definition. UNSTABLE (#4209) also proceeds, but only when every non-passing
 * head run or run-less check suite (#4309) is non-required and still waiting
 * (`action_required` or `pending`); an empty list holds. A BLOCKED or other
 * non-CLEAN status holds, as F1's "any other state" line requires.
 * `requiresUpToDateHead` is always a boolean: an unreadable policy resolves
 * to `true` (see resolveRequiresUpToDateHead).
 */
export function resolveCallSiteRouting(
  branchState: string,
  mergeStateStatus: unknown,
  requiresUpToDateHead: boolean,
  nonPassingRuns: readonly NonPassingRun[],
): CallSiteRouting {
  if (branchState === 'clean') {
    const status = String(mergeStateStatus ?? '').toUpperCase();
    const proceeds =
      status === 'CLEAN' ||
      (status === 'UNSTABLE' && nonPassingRunsAllowProceed(nonPassingRuns));
    return proceeds
      ? { eBranchSync: 'proceed-to-f1', e11: 'skip-merge', f1: 'proceed-to-f2' }
      : { eBranchSync: 'hold', e11: 'skip-merge', f1: 'hold' };
  }
  if (branchState === 'behind-no-conflict') {
    return requiresUpToDateHead
      ? {
          eBranchSync: 'sync-path',
          e11: 'skip-merge',
          f1: 'return-to-e-phase-branch-sync',
        }
      : {
          eBranchSync: 'proceed-to-f1',
          e11: 'skip-merge',
          f1: 'proceed-to-f2',
        };
  }
  if (branchState === 'content-conflict') {
    return {
      eBranchSync: 'sync-path',
      e11: 'merge-development-branch',
      f1: 'return-to-e-phase-branch-sync',
    };
  }
  if (branchState === 'computing') {
    return { eBranchSync: 'retry', e11: 'skip-merge', f1: 'retry' };
  }
  return { eBranchSync: 'hold', e11: 'skip-merge', f1: 'hold' };
}

/** Non-required waiting states an UNSTABLE clean branch may proceed past. */
const UNSTABLE_PROCEED_STATES: ReadonlySet<string> = new Set([
  'action_required',
  'pending',
]);

/**
 * `CheckRun` statuses that have not completed yet (the GraphQL
 * `CheckStatusState` values other than `COMPLETED`). Any other status is
 * unrecognized and holds.
 */
const CHECK_RUN_WAITING_STATES: ReadonlySet<string> = new Set([
  'QUEUED',
  'IN_PROGRESS',
  'PENDING',
  'REQUESTED',
  'WAITING',
]);

/**
 * `StatusContext` states the shared CI vocabulary treats as still pending
 * (`CI_STATUS_CONTEXT_PENDING_STATES`), so they count as waiting.
 */
const STATUS_CONTEXT_PENDING_STATES: ReadonlySet<string> = new Set([
  'PENDING',
  'EXPECTED',
  'REQUESTED',
]);

/**
 * Completed-run conclusions this parser recognizes: the passing set, plus the
 * failure-side conclusions GitHub reports. Any other conclusion is unknown.
 */
const CHECK_RUN_KNOWN_CONCLUSIONS: ReadonlySet<string> = new Set([
  'SUCCESS',
  'NEUTRAL',
  'SKIPPED',
  'NOT_APPLICABLE',
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);

/** Conclusions and states that count as passing, so they are not listed. */
const PASSING_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  'SUCCESS',
  'NEUTRAL',
  'SKIPPED',
  'NOT_APPLICABLE',
]);

/**
 * #4209: every non-passing head run must be non-required and waiting, and
 * #4309 holds a run-less check suite to the same rule. An empty list never
 * proceeds, so an UNSTABLE branch with no visible reason still holds.
 */
export function nonPassingRunsAllowProceed(
  runs: readonly NonPassingRun[],
): boolean {
  return runs.length > 0 && !runs.some(runBlocksUnstableProceed);
}

/** True when this entry alone keeps an UNSTABLE branch at the F1 hold. */
function runBlocksUnstableProceed(run: NonPassingRun): boolean {
  return run.required || !UNSTABLE_PROCEED_STATES.has(run.state);
}

/** Label one list entry for a note; a suite names its own status. */
function describeNonPassingRun(run: NonPassingRun): string {
  const state = run.suiteStatus ? `${run.suiteStatus} suite` : run.state;
  return `${run.name} (${state}, ${run.required ? 'required' : 'non-required'})`;
}

/**
 * #4309: the hold note for one entry that blocks the proceed path. It names
 * the entry (a suite by its app slug), why it holds, and what resumes F1.
 */
export function describeUnstableHold(run: NonPassingRun): string {
  const cause = run.required
    ? 'it is required and has not passed'
    : 'it is non-required but neither pending nor action_required';
  return `UNSTABLE hold: ${describeNonPassingRun(run)} holds F1 because ${cause}; resumes when it passes, or a maintainer clears the hold.`;
}

/**
 * Keep only the non-passing entries of a `statusCheckRollup` page. A
 * `CheckRun` that has not completed is `pending`. A `StatusContext` in
 * `PENDING` is `pending`. A missing `isRequired` and an unrecognized node
 * both fail closed (`required: true`, or an `unknown` state that never
 * proceeds).
 */
export function parseNonPassingRuns(
  nodes: readonly unknown[],
): NonPassingRun[] {
  const runs: NonPassingRun[] = [];
  for (const node of nodes) {
    const entry = (node ?? {}) as Record<string, unknown>;
    // Only an explicit `false` marks a run non-required; null or absent fails
    // closed to required.
    const required = entry.isRequired !== false;
    if (entry.__typename === 'CheckRun') {
      const status = String(entry.status ?? '').toUpperCase();
      const conclusion = String(entry.conclusion ?? '').toUpperCase();
      const name = String(entry.name ?? '');
      if (status === 'COMPLETED') {
        if (!PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
          runs.push({
            name,
            state: conclusion ? conclusion.toLowerCase() : 'unknown',
            required,
          });
        }
      } else if (CHECK_RUN_WAITING_STATES.has(status)) {
        runs.push({ name, state: 'pending', required });
      } else {
        // An unrecognized status is not evidence of a waiting run, so it holds
        // rather than counting as pending.
        runs.push({ name, state: 'unknown', required });
      }
    } else if (entry.__typename === 'StatusContext') {
      const state = String(entry.state ?? '').toUpperCase();
      const name = String(entry.context ?? '');
      if (state !== 'SUCCESS') {
        runs.push({
          name,
          state: STATUS_CONTEXT_PENDING_STATES.has(state)
            ? 'pending'
            : state.toLowerCase() || 'unknown',
          required,
        });
      }
    } else {
      runs.push({ name: '', state: 'unknown', required: true });
    }
  }
  return runs;
}

/**
 * #4209: turn the GraphQL `repository.object` payload for the head commit
 * into the non-passing run list. Fails closed to an empty list (which holds)
 * on a missing commit, a SHA that is not the pinned head, a missing rollup,
 * or a rollup with more contexts than the one page this reads.
 */
export function parseHeadRollup(
  object: unknown,
  headSha: string,
): { runs: NonPassingRun[]; notes: string[] } {
  const failClosed = (reason: string) => ({
    runs: [] as NonPassingRun[],
    notes: [
      `UNSTABLE non-passing run list unavailable (${reason}); holding at F1.`,
    ],
  });
  const commit = (object ?? null) as {
    oid?: unknown;
    statusCheckRollup?: {
      contexts?: {
        totalCount?: unknown;
        nodes?: unknown[] | null;
      } | null;
    } | null;
  } | null;
  if (!commit || typeof commit.oid !== 'string') {
    return failClosed('head commit not found');
  }
  if (commit.oid.toLowerCase() !== headSha.toLowerCase()) {
    return failClosed('head commit does not match the pinned head SHA');
  }
  const contexts = commit.statusCheckRollup?.contexts;
  if (!contexts || !Array.isArray(contexts.nodes)) {
    return failClosed('no status check rollup');
  }
  // The count must be a real integer that equals the page read. A missing,
  // NaN, or smaller count is inconsistent evidence; a larger one means the
  // rollup spans more than the single page this reads.
  const total = contexts.totalCount;
  const pageLength = contexts.nodes.length;
  if (typeof total !== 'number' || !Number.isInteger(total)) {
    return failClosed('rollup count is missing');
  }
  if (total > pageLength) {
    return failClosed('rollup has more contexts than one page');
  }
  if (total !== pageLength) {
    return failClosed('rollup count does not match its page');
  }
  return {
    runs: parseNonPassingRuns(latestInstancePerName(contexts.nodes)),
    notes: [],
  };
}

/**
 * The producer of a check run: its GitHub App, and the Actions workflow when
 * one made it. Runs that share a display name but come from different
 * producers are not reruns of each other, so the grouping key keeps them
 * apart. Only the producer's own identity is used here, not its name.
 */
function checkRunProducerKey(entry: Record<string, unknown>): string {
  const suite = (entry.checkSuite ?? {}) as {
    app?: { databaseId?: unknown; slug?: unknown } | null;
    workflowRun?: {
      workflow?: { databaseId?: unknown; name?: unknown } | null;
    } | null;
  };
  const app = suite.app?.databaseId ?? suite.app?.slug ?? '';
  const workflow =
    suite.workflowRun?.workflow?.databaseId ??
    suite.workflowRun?.workflow?.name ??
    '';
  return `${String(app)}|${String(workflow)}`;
}

/**
 * Keep only the latest instance of each check run, per name and producer. A
 * rerun can leave an earlier instance in the rollup beside the current one,
 * and the required-check gate governs by the latest instance, so a stale
 * failure must not hold a current waiting run.
 *
 * Only a check run whose producer is identified (its App or its workflow) is
 * ever merged with a same-named run. GraphQL gives a status context no
 * producer identity, and a check run without one cannot be attributed, so
 * each of those is kept and judged on its own. A stale entry from either
 * then holds, which fails closed. Within a merged group, an entry whose order
 * cannot be proven keeps every instance of that group. The tie-break is the
 * shared `selectLatestCheckInstance`, the same reducer the required-check gate
 * uses.
 */
function latestInstancePerName(nodes: readonly unknown[]): unknown[] {
  const groups = new Map<
    string,
    {
      node: unknown;
      state: string;
      completedAt: string | null;
      orderable: boolean;
    }[]
  >();
  nodes.forEach((node, index) => {
    const entry = (node ?? {}) as Record<string, unknown>;
    const isCheckRun = entry.__typename === 'CheckRun';
    const name = String(isCheckRun ? entry.name : '');
    const producer = isCheckRun ? checkRunProducerKey(entry) : '|';
    const mergeable = name !== '' && producer !== '|';
    const key = mergeable
      ? `CheckRun:${name}:${producer}`
      : `unmerged:${index}`;
    const completed = String(entry.status ?? '').toUpperCase() === 'COMPLETED';
    const state = isCheckRun
      ? completed
        ? String(entry.conclusion ?? '').toUpperCase()
        : String(entry.status ?? '').toUpperCase()
      : String(entry.state ?? '').toUpperCase();
    const completedAt =
      isCheckRun && completed ? String(entry.completedAt ?? '') || null : null;
    // A live check run that has not completed is the newest instance by
    // definition, and a completed one needs a valid timestamp to be ordered.
    // An unrecognized status or conclusion is never ordered: it parses as
    // unknown and holds, so it must not be allowed to hide another instance.
    const recognized = isCheckRun
      ? completed
        ? CHECK_RUN_KNOWN_CONCLUSIONS.has(
            String(entry.conclusion ?? '').toUpperCase(),
          )
        : CHECK_RUN_WAITING_STATES.has(String(entry.status ?? '').toUpperCase())
      : true;
    const orderable =
      recognized &&
      ((isCheckRun && !completed) || isCompletedCiTimestamp(completedAt));
    const group = groups.get(key) ?? [];
    group.push({ node, state, completedAt, orderable });
    groups.set(key, group);
  });
  const latest: unknown[] = [];
  for (const group of groups.values()) {
    if (group.length > 1 && group.some((member) => !member.orderable)) {
      // An entry whose order cannot be proven must not hide another instance,
      // so keep every instance of that name and let each one be judged.
      for (const member of group) latest.push(member.node);
    } else {
      latest.push(selectLatestCheckInstance(group).node);
    }
  }
  return latest;
}
/**
 * #4309: one check suite that has no check run and is not passing. Such a
 * suite is absent from the status check rollup, so a queued external app
 * (netlify, sentry, ...) that never posted a run leaves GitHub at UNSTABLE
 * with nothing in the run list. `appId` is the suite's GitHub App id, or
 * `null` when the payload does not carry one.
 */
export interface SuiteCandidate {
  name: string;
  state: string;
  suiteStatus: string;
  appId: number | null;
}

interface ParsedSuite {
  name: string;
  appId: number | null;
  /** The producer grouping key, or `null` when the suite cannot be attributed. */
  producer: string | null;
  /** True for an Actions workflow suite, which carries a `workflowRun`. */
  workflow: boolean;
  status: string;
  conclusion: string;
  createdAt: string;
  runCount: number;
}

/** Read one `checkSuites` node, or `null` when its run count is unreadable. */
function parseSuiteNode(node: unknown): ParsedSuite | null {
  const entry = (node ?? {}) as {
    status?: unknown;
    conclusion?: unknown;
    createdAt?: unknown;
    app?: { databaseId?: unknown; slug?: unknown } | null;
    workflowRun?: {
      workflow?: { databaseId?: unknown; name?: unknown } | null;
    } | null;
    checkRuns?: { totalCount?: unknown } | null;
  };
  const runCount = entry.checkRuns?.totalCount;
  if (typeof runCount !== 'number' || !Number.isInteger(runCount)) {
    return null;
  }
  const appId =
    typeof entry.app?.databaseId === 'number' &&
    Number.isInteger(entry.app.databaseId)
      ? entry.app.databaseId
      : null;
  const slug = String(entry.app?.slug ?? '');
  const workflow = entry.workflowRun?.workflow;
  const workflowName = String(workflow?.name ?? '');
  const workflowKey = String(workflow?.databaseId ?? workflowName);
  return {
    name: `${slug || (appId === null ? 'unknown-app' : `app-${appId}`)}${
      workflowName ? `/${workflowName}` : ''
    }`,
    appId,
    // A suite with no App identity is never merged with another one.
    producer:
      appId === null && slug === '' ? null : `${appId ?? slug}|${workflowKey}`,
    workflow: Boolean(entry.workflowRun),
    status: String(entry.status ?? '').toUpperCase(),
    conclusion: String(entry.conclusion ?? '').toUpperCase(),
    createdAt: String(entry.createdAt ?? ''),
    runCount,
  };
}

/**
 * Keep only the newest suite of each producer (its App, and the Actions
 * workflow when one made it), the same latest-instance rule the run list
 * applies by name. A cancelled or stale suite that a later suite of the same
 * producer supersedes must not hold a branch whose current suite passes. A
 * group whose order cannot be proven keeps every member, and members that
 * share the newest timestamp all stay, since neither is provably older.
 */
function latestSuitePerProducer(suites: readonly ParsedSuite[]): ParsedSuite[] {
  const groups = new Map<string, ParsedSuite[]>();
  suites.forEach((suite, index) => {
    const key = suite.producer ?? `unattributed:${index}`;
    const group = groups.get(key) ?? [];
    group.push(suite);
    groups.set(key, group);
  });
  const kept = new Set<ParsedSuite>();
  for (const group of groups.values()) {
    const ordered =
      group.length > 1 &&
      group.every((suite) => isCompletedCiTimestamp(suite.createdAt));
    const newest = ordered
      ? Math.max(...group.map((suite) => Date.parse(suite.createdAt)))
      : null;
    for (const suite of group) {
      if (newest === null || Date.parse(suite.createdAt) === newest) {
        kept.add(suite);
      }
    }
  }
  // The page order is kept so the notes read the same as GitHub lists them.
  return suites.filter((suite) => kept.has(suite));
}

/**
 * #4309: list the head's non-passing check suites that have no check run.
 * A suite with at least one run is judged through that run in the rollup, so
 * it is never listed twice. A completed suite lists its conclusion (a
 * cancelled Actions workflow suite is not listed, see below; an external
 * app's cancelled suite is), a waiting one lists `pending`, and any other
 * status lists `unknown`, which never proceeds. Fails closed (no suites plus a note, so the branch holds)
 * on a missing page, an inconsistent count, a page shorter than the head's
 * suites, or an unreadable run count.
 */
export function parseHeadSuites(object: unknown): {
  suites: SuiteCandidate[];
  notes: string[];
} {
  const failClosed = (reason: string) => ({
    suites: [] as SuiteCandidate[],
    notes: [
      `UNSTABLE check suite list unavailable (${reason}); holding at F1.`,
    ],
  });
  const page = (
    object as {
      checkSuites?: { totalCount?: unknown; nodes?: unknown[] | null } | null;
    } | null
  )?.checkSuites;
  if (!page || !Array.isArray(page.nodes)) {
    return failClosed('no check suites');
  }
  const total = page.totalCount;
  if (typeof total !== 'number' || !Number.isInteger(total)) {
    return failClosed('suite count is missing');
  }
  if (total > page.nodes.length) {
    return failClosed('head has more check suites than one page');
  }
  if (total !== page.nodes.length) {
    return failClosed('suite count does not match its page');
  }
  const parsed: ParsedSuite[] = [];
  for (const node of page.nodes) {
    const suite = parseSuiteNode(node);
    if (!suite) {
      return failClosed('a suite run count is missing');
    }
    parsed.push(suite);
  }
  const suites: SuiteCandidate[] = [];
  for (const suite of latestSuitePerProducer(parsed)) {
    if (suite.runCount > 0) continue;
    const { name, appId } = suite;
    if (suite.status === 'COMPLETED') {
      if (PASSING_CHECK_CONCLUSIONS.has(suite.conclusion)) continue;
      // A run-less cancelled Actions workflow suite is concurrency control,
      // not a check result: no check is left to read or rerun. Observed
      // 2026-10-15 on merged heads such as 504f50f7 and e85436a9, where the
      // comment-refresh workflow's newest suites were cancelled with no run.
      // An external app's cancelled suite carries no such proof and stays
      // listed, so it holds (pull request 4323 review).
      if (suite.conclusion === 'CANCELLED' && suite.workflow) continue;
      const conclusion = suite.conclusion.toLowerCase();
      suites.push({
        name,
        state: conclusion || 'unknown',
        suiteStatus: conclusion || 'completed',
        appId,
      });
    } else if (CHECK_RUN_WAITING_STATES.has(suite.status)) {
      suites.push({
        name,
        state: 'pending',
        suiteStatus: suite.status.toLowerCase(),
        appId,
      });
    } else {
      // An unrecognized status is not evidence of a waiting suite.
      suites.push({
        name,
        state: 'unknown',
        suiteStatus: suite.status.toLowerCase() || 'unknown',
        appId,
      });
    }
  }
  return { suites, notes: [] };
}

/**
 * #4309: a check suite has no `isRequired`, so its requirement comes from the
 * base branch's policy. A suite is required when a required check is
 * source-pinned to its App. Unlike a run's missing `isRequired`, a suite with
 * no pin is not required: a required check that has not reported makes GitHub
 * say BLOCKED, never UNSTABLE, so an unpinned suite cannot be what an
 * UNSTABLE head still waits on. `pinnedAppIds` is `null` when the policy is
 * unreadable, which marks every suite required (fail closed).
 */
export function markSuiteRequirement(
  suites: readonly SuiteCandidate[],
  pinnedAppIds: ReadonlySet<number> | null,
): NonPassingRun[] {
  return suites.map(({ name, state, suiteStatus, appId }) => ({
    name,
    state,
    suiteStatus,
    required:
      pinnedAppIds === null || appId === null || pinnedAppIds.has(appId),
  }));
}

/**
 * The keys under which a rules `parameters` object or a classic
 * `required_status_checks` object lists required checks, the same set the
 * shared required-check reader accepts.
 */
const REQUIRED_CHECK_LIST_KEYS = [
  'required_status_checks',
  'required_checks',
  'checks',
  'contexts',
] as const;

/** A JSON object: an array, `null`, and a primitive are not records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Append every entry of the check lists in one parameters object. Returns
 * `false` when the object or one of its lists has a shape this read cannot
 * trust, so the caller can treat the policy as unresolvable. An array is not
 * an object here: `parameters: []` must not read as an empty policy.
 */
function appendRequiredCheckEntries(
  parameters: unknown,
  entries: unknown[],
): boolean {
  if (parameters === null || parameters === undefined) return true;
  if (!isRecord(parameters)) return false;
  for (const key of REQUIRED_CHECK_LIST_KEYS) {
    const list = parameters[key];
    if (list === null || list === undefined) continue;
    if (!Array.isArray(list)) return false;
    entries.push(...list);
  }
  return true;
}

/**
 * Collect the GitHub App ids that a required status check is pinned to, from
 * the rules and classic protection payloads. Returns `null` (unresolvable)
 * when a payload or check list is malformed, when a pin cannot be turned into
 * an App id, or when a `workflows` rule requires Actions workflows that no
 * pin names.
 */
export function collectPinnedRequiredAppIds(
  rules: unknown,
  protection: unknown,
): Set<number> | null {
  if (rules !== null && rules !== undefined && !Array.isArray(rules)) {
    return null;
  }
  const entries: unknown[] = [];
  for (const rule of (rules ?? []) as unknown[]) {
    if (!isRecord(rule)) return null;
    if (rule.type === 'workflows') return null;
    if (
      rule.type === 'required_status_checks' &&
      !appendRequiredCheckEntries(rule.parameters, entries)
    ) {
      return null;
    }
  }
  if (protection !== null && protection !== undefined) {
    if (!isRecord(protection)) return null;
    if (
      !appendRequiredCheckEntries(protection.required_status_checks, entries)
    ) {
      return null;
    }
  }
  const appIds = new Set<number>();
  for (const entry of entries) {
    // A bare string is a legacy context name, which pins no App.
    if (typeof entry === 'string' || entry === null || entry === undefined) {
      continue;
    }
    if (!isRecord(entry)) return null;
    // Both id fields count on their own, as in the shared required-check
    // reader: a pin is any positive id or a truthy `source`.
    let resolved = false;
    for (const raw of [entry.integration_id, entry.app_id]) {
      if (raw === null || raw === undefined) continue;
      // Only a number or a decimal-integer string is an id. Coercing a
      // boolean, an empty string, or an array would read a malformed pin as
      // "any source".
      const appId =
        typeof raw === 'number' ||
        (typeof raw === 'string' && /^-?\d+$/.test(raw))
          ? Number(raw)
          : Number.NaN;
      if (!Number.isInteger(appId)) return null;
      // A zero or negative id means "any source", so it pins nothing alone.
      if (appId > 0) {
        appIds.add(appId);
        resolved = true;
      }
    }
    // A pin by `source` with no positive App id carries nothing this read
    // could match, even when a zero or negative id sits beside it.
    if (entry.source && !resolved) return null;
  }
  return appIds;
}

/**
 * Read the pinned required App ids for the base branch through the same
 * policy reads and 404 rule as {@link resolveRequiresUpToDateHead}: a 404 is
 * unreadable unless `ciGate.trustEmptyProtectionReads` is set at the base
 * ref, and any thrown read is unreadable. Unreadable resolves to `null`.
 */
export function resolvePinnedRequiredAppIds(
  owner: string,
  repo: string,
  baseRef: string,
  port: Pick<
    ReturnType<typeof createGithubProviderAdapter>,
    'listBranchRules' | 'getBranchProtection'
  > = createGithubProviderAdapter(owner, repo),
  trustEmptyReads: boolean = readTrustEmptyProtectionReads(
    owner,
    repo,
    baseRef,
  ),
): Set<number> | null {
  try {
    const rulesRead = port.listBranchRules(owner, repo, baseRef);
    const protectionRead = port.getBranchProtection(owner, repo, baseRef);
    if (
      (rulesRead.outcome === 'not-found' ||
        protectionRead.outcome === 'not-found') &&
      !trustEmptyReads
    ) {
      return null;
    }
    return collectPinnedRequiredAppIds(
      rulesRead.outcome === 'ok' ? rulesRead.value : [],
      protectionRead.outcome === 'ok' ? protectionRead.value : {},
    );
  } catch {
    return null;
  }
}

/**
 * #4309: turn the head commit payload into the full non-passing list, the
 * rollup's runs plus its run-less check suites. `readPinnedAppIds` is called
 * only when a suite is listed, so a head with no such suite costs no policy
 * read. A failed rollup or suite read returns no runs and its note, which
 * holds.
 */
export function parseHeadNonPassing(
  object: unknown,
  headSha: string,
  readPinnedAppIds: () => Set<number> | null,
): { runs: NonPassingRun[]; notes: string[] } {
  const rollup = parseHeadRollup(object, headSha);
  if (rollup.notes.length > 0) return rollup;
  const { suites, notes } = parseHeadSuites(object);
  if (notes.length > 0) return { runs: [], notes };
  if (suites.length === 0) return rollup;
  const pinnedAppIds = readPinnedAppIds();
  return {
    runs: [...rollup.runs, ...markSuiteRequirement(suites, pinnedAppIds)],
    notes:
      pinnedAppIds === null
        ? [
            'UNSTABLE check suite requirement unavailable (required-check policy unreadable); treating every listed suite as required.',
          ]
        : [],
  };
}

const HEAD_ROLLUP_QUERY = `query($owner: String!, $repo: String!, $oid: GitObjectID!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    object(oid: $oid) {
      __typename
      ... on Commit {
        oid
        statusCheckRollup {
          contexts(first: 100) {
            totalCount
            nodes {
              __typename
              ... on CheckRun {
                name status conclusion completedAt
                isRequired(pullRequestNumber: $number)
                checkSuite { app { databaseId slug } workflowRun { workflow { databaseId name } } }
              }
              ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
            }
          }
        }
        checkSuites(first: 100) {
          totalCount
          nodes {
            status conclusion createdAt
            app { databaseId slug }
            workflowRun { workflow { databaseId name } }
            checkRuns(first: 1) { totalCount }
          }
        }
      }
    }
  }
}`;

/**
 * Read the head commit's check rollup and check suites live, pinned to
 * `headSha`, and return its non-passing runs and run-less suites. Any read or
 * parse failure yields an empty list plus a note, so the UNSTABLE branch
 * holds rather than guessing.
 */
function fetchNonPassingRuns(
  owner: string,
  repo: string,
  baseRef: string,
  prNumber: unknown,
  headSha: string,
): { runs: NonPassingRun[]; notes: string[] } {
  let raw: string;
  try {
    raw = ghText([
      'api',
      'graphql',
      '-f',
      `query=${HEAD_ROLLUP_QUERY}`,
      // -f keeps owner, repo, and oid as raw strings. -F would type an
      // all-digit value as an integer, which GraphQL rejects.
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      '-f',
      `oid=${headSha}`,
      '-F',
      `number=${Number(prNumber)}`,
    ]);
  } catch (error) {
    return {
      runs: [],
      notes: [
        `UNSTABLE non-passing run list unavailable (gh api graphql failed: ${
          error instanceof Error ? error.message : String(error)
        }); holding at F1.`,
      ],
    };
  }
  let object: unknown;
  try {
    const parsed = JSON.parse(raw) as {
      data?: { repository?: { object?: unknown } | null };
      errors?: unknown[];
    };
    if (parsed.errors?.length) {
      return {
        runs: [],
        notes: [
          'UNSTABLE non-passing run list unavailable (GraphQL errors); holding at F1.',
        ],
      };
    }
    object = parsed.data?.repository?.object ?? null;
  } catch {
    return {
      runs: [],
      notes: [
        'UNSTABLE non-passing run list unavailable (unparseable response); holding at F1.',
      ],
    };
  }
  return parseHeadNonPassing(object, headSha, () =>
    resolvePinnedRequiredAppIds(owner, repo, baseRef),
  );
}

/**
 * Read `ciGate.trustEmptyProtectionReads` through the same trusted-ref loader
 * pre-merge-readiness uses (`loadTrustedIddConfig`): the policy at the PR's
 * base ref, with the user-global layers when the file is absent. The PR's
 * own working tree is never used, since a PR could set the opt-in itself and
 * turn a masked 404 into a readable empty policy. Any failure to read the
 * policy keeps the opt-in unset (fail closed).
 */
export function readTrustEmptyProtectionReads(
  owner: string,
  repo: string,
  baseRef: string,
  fetchEncodedConfig?: (owner: string, repo: string, ref: string) => string,
  probeLegacyPolicy?: (owner: string, repo: string, ref: string) => void,
  options: { userGlobalFallback?: boolean } = {},
): boolean {
  try {
    const config = loadTrustedIddConfig(
      owner,
      repo,
      baseRef,
      fetchEncodedConfig,
      probeLegacyPolicy,
      options,
    );
    const policy = config as {
      ciGate?: { trustEmptyProtectionReads?: unknown };
    } | null;
    return policy?.ciGate?.trustEmptyProtectionReads === true;
  } catch {
    return false;
  }
}

/**
 * Resolve whether the PR's base branch requires an up-to-date head, reusing
 * `summarizeBranchCurrency` with the same 404 rule as pre-merge-readiness: a
 * 404 is unreadable unless `ciGate.trustEmptyProtectionReads` is set at the
 * base ref. Any other failure (403, 500, transport) resolves to `true`. That
 * is stricter than pre-merge, which rethrows, and it is safe here because this
 * helper is read-only and `true` only routes to the sync path.
 */
export function resolveRequiresUpToDateHead(
  owner: string,
  repo: string,
  baseRef: string,
  port: Pick<
    ReturnType<typeof createGithubProviderAdapter>,
    'listBranchRules' | 'getBranchProtection'
  > = createGithubProviderAdapter(owner, repo),
  trustEmptyReads: boolean = readTrustEmptyProtectionReads(
    owner,
    repo,
    baseRef,
  ),
): boolean {
  try {
    const rulesRead = port.listBranchRules(owner, repo, baseRef);
    const protectionRead = port.getBranchProtection(owner, repo, baseRef);
    const protectionReadsUnreadable =
      (rulesRead.outcome === 'not-found' ||
        protectionRead.outcome === 'not-found') &&
      !trustEmptyReads;
    return summarizeBranchCurrency(
      (rulesRead.outcome === 'ok' ? rulesRead.value : []) as Parameters<
        typeof summarizeBranchCurrency
      >[0],
      (protectionRead.outcome === 'ok'
        ? protectionRead.value
        : {}) as Parameters<typeof summarizeBranchCurrency>[1],
      { protectionReadsUnreadable },
    ).requiresUpToDateHead;
  } catch {
    return true;
  }
}

interface ClassifyOptions {
  owner?: string;
  repo?: string;
  _testPrData?: PrData;
  _testRequiresUpToDateHead?: boolean;
  _testNonPassingRuns?: NonPassingRun[];
  _skipGitProbe?: boolean;
}

/** One-line advisory attached to `notes` alongside a `true` result. */
const BASE_ADVANCED_BLIND_SPOT_NOTE =
  'Base has advanced since the merge-base for this branch ' +
  '(baseAdvancedSinceMergeBase); a textually clean/mergeable verdict is ' +
  'conflict-freeness only, not whole-tree CI-invariant freedom (e.g. ' +
  'line-count budgets, generated-file drift, lockfile consistency) against ' +
  'the current base tip, and a pull_request-triggered CI result may be ' +
  'pinned to a merge-ref computed at an earlier trigger time. Consider ' +
  're-validating against current base before relying on a pre-existing ' +
  'green check.';

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant.
const BRANCH_CONFLICT_STATE_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

/**
 * Bounded fetch-depth escalation steps tried by {@link computeMergeBase}'s
 * retry loop, in order. The first step (`--depth=1`) matches the
 * pre-existing single-shallow-fetch behavior byte-for-byte, so a checkout
 * that already resolves after one shallow fetch performs exactly the same
 * single extra fetch call as before this retry loop existed (#1519's "no
 * regression for the common case" requirement). Each later step widens
 * local history via `git fetch --deepen=<n>` -- relative to the current
 * shallow boundary, so repeated calls compose instead of re-fetching the
 * same fixed `--depth=N` -- instead of retrying forever. Three total
 * attempts mirrors the bounded-retry shape F1's `computing` re-poll budget
 * already uses elsewhere in this codebase (`idd-pre-merge.instructions.md`).
 *
 * Exported so tests can fetch with these exact args against a hermetic
 * local fixture remote (see `tests/branch-conflict-state.test.mts`'s
 * shallow-checkout fixture) instead of a hand-copied duplicate that could
 * silently drift from what `tryFetchBase` actually runs in production.
 *
 * Declared here, above the CLI entry block below, rather than next to
 * {@link computeMergeBase} that actually uses it: the entry block's
 * top-level `await` parks module evaluation there on the CLI path, so a
 * module-level `const` declared textually after it would still be in its
 * temporal dead zone the first time a helper reads it (see
 * `tests/cli-entry-smoke.test.mts`'s module-eval-order guard, #1447).
 */
export const MERGE_BASE_FETCH_STEPS: readonly (readonly string[])[] = [
  ['--depth=1'],
  ['--deepen=20'],
  ['--deepen=200'],
];

/**
 * Timeout (ms) for a single `tryFetchBase`/`tryFetchHead` history fetch
 * (#2989 review, Codex round 1). Deliberately **not** `gh-exec.mts`'s
 * `DEFAULT_GH_TIMEOUT_MS` (30s): that constant sizes a single `gh` API
 * request, but a `git fetch` here can transfer real commit/tree/blob
 * history -- a large repository, a slow GHES instance, or the deepest
 * `MERGE_BASE_FETCH_STEPS` step (`--deepen=200`) can plausibly exceed
 * 30s on a healthy connection. A too-short timeout would abort a
 * healthy transfer, making `tryFetchBase`/`tryFetchHead` return `false`
 * and `computeBaseAdvanced` report an unresolved merge base as
 * `baseAdvancedSinceMergeBase: false` -- silently losing the
 * fresh-CI-required advisory note for a `CLEAN` PR whose base has
 * genuinely advanced. Matches `gh-exec.mts`'s own
 * `DEFAULT_GH_PAGINATED_TIMEOUT_MS` precedent of a deliberately
 * generous, still-bounded multiplier for a larger-transfer case,
 * scaled here for a git object-transfer bound rather than a paginated
 * API response.
 */
const FETCH_TIMEOUT_MS = 120_000;

/**
 * Overall wall-clock budget (ms) for {@link computeMergeBase}'s whole
 * retry sequence (#2989 review, Codex round 3). A first fix (Copilot
 * round 2) tracked a single deadline of exactly `FETCH_TIMEOUT_MS` for
 * the whole call, bounding the pre-fix ~12-minute worst case (six
 * independent `FETCH_TIMEOUT_MS` timeouts, three
 * {@link MERGE_BASE_FETCH_STEPS} steps times two fetches each) -- but
 * that shared deadline could then let two genuinely healthy,
 * individually-slow transfers (a large base-ref fetch and a large
 * head-ref fetch on the same call) starve each other of remaining
 * time, since together they could plausibly need close to
 * `FETCH_TIMEOUT_MS` each. Doubling the overall budget while still
 * capping each individual attempt at `FETCH_TIMEOUT_MS` (see
 * {@link resolveFetchAttemptTimeoutMs}) lets both fetches in the
 * common two-fetch case draw a full transfer budget, while still
 * bounding the entire six-attempt worst case to this value (~4
 * minutes) instead of the pre-fix ~12 minutes.
 */
const OVERALL_FETCH_BUDGET_MS = 2 * FETCH_TIMEOUT_MS;

/**
 * Minimum remaining budget (ms) required to still attempt a fetch within
 * {@link computeMergeBase}'s overall deadline. Below this floor, the
 * retry loop treats history as not fetchable for that attempt rather
 * than spawning a `git fetch` doomed to time out almost immediately.
 */
const MIN_FETCH_ATTEMPT_MS = 5_000;

/**
 * Decides whether {@link computeMergeBase}'s retry loop should still
 * attempt a fetch given `deadline` (an absolute `Date.now()`-scale
 * timestamp) and the current time, and if so, the per-attempt timeout
 * to use (#2989 review, Copilot round 3: this arithmetic is extracted
 * into its own pure, exported function specifically so it can be
 * unit-tested directly -- the real `git fetch` call sites it feeds
 * stay deliberately untested at their own call site, per this file's
 * existing hermetic-test convention, so a regression in this
 * budget/skip logic itself would otherwise never be exercised by the
 * test suite).
 *
 * Returns `null` when the remaining budget is below
 * {@link MIN_FETCH_ATTEMPT_MS} (skip this attempt); otherwise returns
 * the timeout to pass to the fetch, capped at {@link FETCH_TIMEOUT_MS}
 * so no single attempt can claim more than its own fair share of
 * {@link OVERALL_FETCH_BUDGET_MS} even when most of it is still
 * unspent.
 */
export function resolveFetchAttemptTimeoutMs(
  deadline: number,
  now: number,
): number | null {
  const remainingMs = deadline - now;
  if (remainingMs < MIN_FETCH_ATTEMPT_MS) return null;
  return Math.min(FETCH_TIMEOUT_MS, remainingMs);
}

if (import.meta.main) {
  // #3344: the disabled path calls main() through .then so an uncaught
  // rejection keeps the pre-migration crash text. This body was inline
  // top-level await, so the extracted main adds one frame -- the same
  // residual #3342 documented for discover-readiness-check.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('branch-conflict-state', main);
  } else {
    main().then(applyHelperCliOutcomeWhenDisabled, (error) => {
      throw error;
    });
  }
}

async function main(): Promise<HelperCliResult> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw markCliUsageError(
      new Error('missing required --pr <number> argument'),
    );
  }

  const { owner, repo } = resolveGhOwnerRepo({
    owner: args.owner,
    repo: args.repo,
  });

  const result = await classifyBranchConflictState(args.prNumber, {
    owner,
    repo,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

export async function classifyBranchConflictState(
  prNumber: unknown,
  options: ClassifyOptions = {},
): Promise<BranchConflictResult> {
  const {
    owner,
    repo,
    _testPrData,
    _testRequiresUpToDateHead,
    _testNonPassingRuns,
    _skipGitProbe,
  } = options;
  const notes: string[] = [];

  const prData: PrData = _testPrData ?? fetchPrData(owner, repo, prNumber);
  const prHeadSha = String(prData.headRefOid ?? '');
  const prBaseSha = String(prData.baseRefOid ?? '');
  const prHeadRef = String(prData.headRefName ?? '');
  const prBaseRef = String(prData.baseRefName ?? '');
  const mergeable = prData.mergeable ?? null;
  const mergeStateStatus = prData.mergeStateStatus ?? null;
  const published = Boolean(prHeadSha);

  if (!prHeadSha || !prBaseSha) {
    return {
      protocolVersion: '1',
      prNumber: Number(prNumber),
      prHeadSha: prHeadSha || '',
      prBaseSha: prBaseSha || '',
      published,
      mergeable: null,
      mergeStateStatus: null,
      branchState: 'unknown',
      syncRecommendation: 'hold-unknown',
      baseAdvancedSinceMergeBase: false,
      callSiteRouting: resolveCallSiteRouting('unknown', null, true, []),
      readOnly: true,
      worktreeUnchanged: true,
      diagnostics: {
        mergeableSource: 'none',
        conflictFiles: [],
        notes: [
          'PR head or base SHA unavailable; cannot classify branch state.',
        ],
      },
    };
  }

  const {
    branchState,
    syncRecommendation,
    conflictFiles,
    mergeableSource,
    baseAdvancedSinceMergeBase,
  } = deriveBranchState({
    prHeadSha,
    prBaseSha,
    prHeadRef,
    prBaseRef,
    prNumber,
    mergeable,
    mergeStateStatus,
    notes,
    owner,
    repo,
    skipGitProbe: Boolean(_skipGitProbe),
  });

  // Test cases inject the policy value, or fall back to fail-closed `true`
  // when they inject PR data; only the live path reads the base branch policy.
  // Only `behind-no-conflict` routes on this input, so the policy reads run
  // only for that state.
  const requiresUpToDateHead =
    _testRequiresUpToDateHead ??
    (branchState !== 'behind-no-conflict'
      ? false
      : _testPrData
        ? true
        : resolveRequiresUpToDateHead(
            String(owner ?? ''),
            String(repo ?? ''),
            prBaseRef,
          ));

  // #4209: an UNSTABLE clean branch proceeds only past non-required, waiting
  // head runs, so the run list is read live, pinned to prHeadSha, for that
  // state alone. Injected PR data stays offline; with no injected list it
  // holds on an empty list.
  const unstableClean =
    branchState === 'clean' &&
    String(mergeStateStatus ?? '').toUpperCase() === 'UNSTABLE';
  let nonPassingRuns: NonPassingRun[] = [];
  if (unstableClean) {
    let fetchFailed = false;
    if (_testNonPassingRuns) {
      nonPassingRuns = _testNonPassingRuns;
    } else if (!_testPrData) {
      const fetched = fetchNonPassingRuns(
        String(owner ?? ''),
        String(repo ?? ''),
        prBaseRef,
        prNumber,
        prHeadSha,
      );
      nonPassingRuns = fetched.runs;
      fetchFailed = fetched.notes.length > 0;
      notes.push(...fetched.notes);
    }
    if (nonPassingRuns.length === 0 && !fetchFailed) {
      notes.push(
        'UNSTABLE clean head: no non-passing head run is visible; holding at F1.',
      );
    }
    if (nonPassingRuns.length > 0) {
      notes.push(
        `UNSTABLE clean head: non-passing runs ${nonPassingRuns
          .map(describeNonPassingRun)
          .join('; ')}.`,
      );
      notes.push(
        ...nonPassingRuns
          .filter(runBlocksUnstableProceed)
          .map(describeUnstableHold),
      );
    }
  }

  return {
    protocolVersion: '1',
    prNumber: Number(prNumber),
    prHeadSha,
    prBaseSha,
    published,
    mergeable: normalizeNullable(mergeable),
    mergeStateStatus: normalizeNullable(mergeStateStatus),
    branchState,
    syncRecommendation,
    baseAdvancedSinceMergeBase,
    callSiteRouting: resolveCallSiteRouting(
      branchState,
      mergeStateStatus,
      requiresUpToDateHead,
      nonPassingRuns,
    ),
    readOnly: true,
    worktreeUnchanged: true,
    diagnostics: {
      mergeableSource,
      conflictFiles,
      notes,
    },
  };
}

function deriveBranchState({
  prHeadSha,
  prBaseSha,
  prBaseRef,
  prNumber,
  mergeable,
  mergeStateStatus,
  notes,
  owner,
  repo,
  skipGitProbe,
}: {
  prHeadSha: string;
  prBaseSha: string;
  prHeadRef?: string;
  prBaseRef: string;
  prNumber: unknown;
  mergeable: unknown;
  mergeStateStatus: unknown;
  notes: string[];
  owner: string | undefined;
  repo: string | undefined;
  skipGitProbe: boolean;
}): BranchStateDerivation {
  const mergeableNorm = String(mergeable ?? '').toUpperCase();
  const mergeStateNorm = String(mergeStateStatus ?? '').toUpperCase();

  if (mergeableNorm === 'CONFLICTING') {
    const probeResult = skipGitProbe
      ? []
      : probeConflictFilesReadOnly(
          prHeadSha,
          prBaseSha,
          prBaseRef,
          prNumber,
          owner,
          repo,
          notes,
        );
    return {
      branchState: 'content-conflict',
      syncRecommendation: 'hold-unknown',
      conflictFiles: probeResult ?? [],
      mergeableSource: 'github-mergeable',
      // A real textual conflict already forces a hold; whether base also
      // advanced past the merge-base is not an independently useful signal
      // here, so this is not computed for this branch.
      baseAdvancedSinceMergeBase: false,
    };
  }

  if (mergeStateNorm === 'DIRTY') {
    return {
      branchState: 'dirty',
      syncRecommendation: 'hold-unknown',
      conflictFiles: [],
      mergeableSource: 'github-merge-state',
      baseAdvancedSinceMergeBase: false,
    };
  }

  if (mergeableNorm === 'MERGEABLE' && mergeStateNorm === 'CLEAN') {
    const baseAdvancedSinceMergeBase = computeBaseAdvanced(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      prNumber,
      owner,
      repo,
      notes,
      skipGitProbe,
    );
    if (baseAdvancedSinceMergeBase) {
      notes.push(BASE_ADVANCED_BLIND_SPOT_NOTE);
    }
    return {
      branchState: 'clean',
      syncRecommendation: 'none',
      conflictFiles: [],
      mergeableSource: 'github-mergeable',
      baseAdvancedSinceMergeBase,
    };
  }

  if (mergeStateNorm === 'BEHIND') {
    // GitHub's BEHIND state is definitional: the base has already advanced
    // past this branch's merge-base (that is what "behind" means), so this
    // is known for free without an extra git probe, for every return below.
    const baseAdvancedSinceMergeBase = true;
    if (skipGitProbe) {
      return {
        branchState: 'behind-no-conflict',
        syncRecommendation: 'merge-base',
        conflictFiles: [],
        mergeableSource: 'github-merge-state',
        baseAdvancedSinceMergeBase,
      };
    }
    const probeResult = probeConflictFilesReadOnly(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      prNumber,
      owner,
      repo,
      notes,
    );
    if (probeResult === null) {
      return {
        branchState: 'unknown',
        syncRecommendation: 'hold-unknown',
        conflictFiles: [],
        mergeableSource: 'git-merge-tree',
        baseAdvancedSinceMergeBase,
      };
    }
    if (probeResult.length > 0) {
      return {
        branchState: 'content-conflict',
        syncRecommendation: 'hold-unknown',
        conflictFiles: probeResult,
        mergeableSource: 'git-merge-tree',
        baseAdvancedSinceMergeBase,
      };
    }
    return {
      branchState: 'behind-no-conflict',
      syncRecommendation: 'merge-base',
      conflictFiles: [],
      mergeableSource: 'git-merge-tree',
      baseAdvancedSinceMergeBase,
    };
  }

  if (mergeableNorm === 'MERGEABLE') {
    const baseAdvancedSinceMergeBase = computeBaseAdvanced(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      prNumber,
      owner,
      repo,
      notes,
      skipGitProbe,
    );
    if (baseAdvancedSinceMergeBase) {
      notes.push(BASE_ADVANCED_BLIND_SPOT_NOTE);
    }
    return {
      branchState: 'clean',
      syncRecommendation: 'none',
      conflictFiles: [],
      mergeableSource: 'github-mergeable',
      baseAdvancedSinceMergeBase,
    };
  }

  if (mergeableNorm === 'UNKNOWN' || !mergeableNorm) {
    notes.push(
      `Mergeable status is ${mergeable ?? 'null'}; GitHub computes mergeability asynchronously, so this is most likely still computing. Re-poll before treating it as terminal.`,
    );
    return {
      branchState: 'computing',
      syncRecommendation: 'recheck',
      conflictFiles: [],
      mergeableSource: 'none',
      baseAdvancedSinceMergeBase: false,
    };
  }

  notes.push(
    `Unrecognized mergeable=${mergeable} / mergeStateStatus=${mergeStateStatus}.`,
  );
  return {
    branchState: 'unknown',
    syncRecommendation: 'hold-unknown',
    conflictFiles: [],
    mergeableSource: 'none',
    baseAdvancedSinceMergeBase: false,
  };
}

/**
 * Bounded merge-base resolution retry used by {@link computeMergeBase}: call
 * `lookupMergeBase()`, and on an empty result, call `widenHistory(stepIndex)`
 * before each subsequent lookup -- stopping as soon as a merge-base
 * resolves, `widenHistory` reports it could not widen history (e.g. no
 * fetchable base ref, or the fetch itself failed, so a deeper attempt would
 * not plausibly help either), or `stepCount` attempts are exhausted.
 *
 * Exported so the retry-loop and attempt-cap shape itself stays directly
 * unit-testable (both the deepened-success and still-undetermined paths)
 * independent of `tryFetchBase`'s own remote-URL assembly and real `git
 * fetch` call, which stay deliberately untested at their call site (see
 * `tryFetchBase`'s doc comment) -- matching this file's existing
 * hermetic-test convention of never letting a test reach a live network
 * fetch.
 */
export function resolveMergeBaseWithRetry(
  lookupMergeBase: () => string,
  widenHistory: (stepIndex: number) => boolean,
  stepCount: number,
): string | null {
  let mergeBase = lookupMergeBase();
  for (let step = 0; !mergeBase && step < stepCount; step += 1) {
    if (!widenHistory(step)) break;
    mergeBase = lookupMergeBase();
  }
  return mergeBase || null;
}

/**
 * Read-only local `git merge-base` lookup, falling back to a bounded,
 * progressively deeper fetch of the base ref **and** the PR head ref when
 * the merge-base is not yet resolvable locally. Two genuinely different
 * shallow-history gaps can block `git merge-base` here, and #1535 added the
 * second one alongside #1519's original base-ref fix:
 *
 * - The base commit is missing (e.g. an agent worktree that has not fetched
 *   recent base history) -- {@link tryFetchBase} handles this, unchanged
 *   since #1519.
 * - The PR **head**'s own ancestry is missing (e.g. a shallow CI checkout of
 *   just the PR head, or a fork PR whose head commits were never fetched at
 *   all) -- {@link tryFetchHead} handles this by fetching/deepening
 *   `refs/pull/<prNumber>/head` from the same base-repository remote
 *   {@link tryFetchBase} already targets. GitHub mirrors every PR head onto
 *   the base repository under that ref (confirmed empirically against real
 *   GitHub-hosted repos, including a genuine fork PR, for #1535 -- see the
 *   PR description), so no separate fork remote URL is needed even when the
 *   head lives in a fork: `classifyBranchConflictState`'s existing
 *   `owner`/`repo` (the base repository) plus `prNumber` are sufficient.
 *
 * Each retry step attempts **both** fetches at the same escalating
 * depth/deepen args and widens history if **either** succeeds, so a
 * structural block on one side (e.g. a missing `prBaseRef`) does not stop
 * the other side's retries, and the loop only gives up early when neither
 * side can plausibly help.
 *
 * Returns `null` when the merge-base still cannot be resolved after
 * exhausting {@link MERGE_BASE_FETCH_STEPS}; callers decide how to report
 * that indeterminate outcome, since "conflict probe" and "base-advancement"
 * callers need different diagnostics wording for the same underlying null.
 */
function computeMergeBase(
  prHeadSha: string,
  prBaseSha: string,
  prBaseRef: string,
  prNumber: unknown,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
): string | null {
  const deadline = Date.now() + OVERALL_FETCH_BUDGET_MS;
  return resolveMergeBaseWithRetry(
    () => gitText(['merge-base', prHeadSha, prBaseSha]),
    (step) => {
      const fetchArgs = MERGE_BASE_FETCH_STEPS[step];

      let baseFetched = false;
      const baseTimeoutMs = resolveFetchAttemptTimeoutMs(deadline, Date.now());
      if (baseTimeoutMs !== null) {
        baseFetched = tryFetchBase(
          prBaseRef,
          owner,
          repo,
          notes,
          fetchArgs,
          baseTimeoutMs,
        );
      } else {
        notes.push(
          'Merge-base fetch budget exhausted; skipping base-ref fetch.',
        );
      }

      let headFetched = false;
      const headTimeoutMs = resolveFetchAttemptTimeoutMs(deadline, Date.now());
      if (headTimeoutMs !== null) {
        headFetched = tryFetchHead(
          prNumber,
          owner,
          repo,
          notes,
          fetchArgs,
          headTimeoutMs,
        );
      } else {
        notes.push(
          'Merge-base fetch budget exhausted; skipping head-ref fetch.',
        );
      }

      return baseFetched || headFetched;
    },
    MERGE_BASE_FETCH_STEPS.length,
  );
}

/**
 * True when the base ref has moved past this PR's merge-base, independent of
 * `syncRecommendation` -- the blind spot this field exists to close. Returns
 * `false` both when base genuinely has not advanced and when the merge-base
 * could not be resolved at all; the latter, indeterminate case is
 * distinguished only via a `notes` entry, never silently reported as a
 * confirmed "no" (see the `computeMergeBase` doc comment above).
 */
function computeBaseAdvanced(
  prHeadSha: string,
  prBaseSha: string,
  prBaseRef: string,
  prNumber: unknown,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
  skipGitProbe: boolean,
): boolean {
  if (skipGitProbe) return false;
  try {
    const mergeBase = computeMergeBase(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      prNumber,
      owner,
      repo,
      notes,
    );
    if (!mergeBase) {
      notes.push(
        'merge-base not found; base-advancement since merge-base is undetermined (reported as false).',
      );
      return false;
    }
    return mergeBase !== prBaseSha;
  } catch {
    notes.push(
      'git merge-base unavailable; base-advancement since merge-base is undetermined (reported as false).',
    );
    return false;
  }
}

function probeConflictFilesReadOnly(
  prHeadSha: string,
  prBaseSha: string,
  prBaseRef: string,
  prNumber: unknown,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
): string[] | null {
  try {
    const mergeBase = computeMergeBase(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      prNumber,
      owner,
      repo,
      notes,
    );
    if (!mergeBase) {
      notes.push(
        'merge-base not found; cannot prove conflict-free; holding unknown.',
      );
      return null;
    }
    const result = spawnSync(
      'git',
      ['merge-tree', `--merge-base=${mergeBase}`, prHeadSha, prBaseSha],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (result.status !== 0 && result.status !== 1) {
      notes.push(
        `git merge-tree exited with status ${result.status}; cannot probe conflicts.`,
      );
      return null;
    }
    const conflictFiles = parseConflictFiles(result.stdout ?? '');
    if (result.status === 1 && conflictFiles.length === 0) {
      notes.push(
        'git merge-tree exited 1 but no conflict files were parsed; treating as unknown.',
      );
      return null;
    }
    return conflictFiles;
  } catch {
    notes.push(
      'git merge-tree unavailable; falling back to GitHub mergeability signal only.',
    );
    return null;
  }
}

/** Injectable evidence reader for {@link resolveFetchOrigin}, so host
 * resolution stays unit-testable without shelling out to git or mutating
 * `process.env`. Mirrors the `OnboardEvidenceReaders` convention in
 * `idd-onboard.mts`. */
export interface FetchHostReaders {
  /** Returns the local checkout's `origin` remote URL, or `''` when
   * unavailable. Defaults to `git remote get-url origin`. */
  readOriginUrl?: () => string;
}

/** Default `origin` URL reader: `git remote get-url origin` in the current
 * working directory (this file's other git probes are likewise un-scoped
 * to a `-C <dir>`, since they always run from inside the target checkout).
 * `gitText` already swallows any git failure and returns `''`. */
function readOriginRemoteUrl(): string {
  return gitText(['remote', 'get-url', 'origin']);
}

/**
 * The scheme + host (plus `:port` when meaningful) to use for the
 * `tryFetchBase` fallback fetch URL. `tryFetchBase` always performs an
 * anonymous, credential-helper-backed fetch (never SSH), so `scheme` is
 * only ever `http` or `https` — including when the source signal was the
 * scp-like SSH shorthand, which carries no scheme of its own.
 */
export interface FetchOrigin {
  scheme: 'http' | 'https';
  host: string;
}

/**
 * Parse the scheme and host (hostname, plus `:port` when meaningful) from
 * a git remote URL. Supports the `http://` / `https://` URL-scheme forms
 * (parseable by the WHATWG URL parser) and the scp-like SSH shorthand
 * (`[user@]host:path`, which has no `://` scheme and is not
 * `URL`-parseable; per git's own URL syntax the `user@` prefix is
 * optional, e.g. a bare `ghes.example.com:owner/repo.git` is valid).
 *
 * The returned `scheme` always matches an `http://` or `https://` origin's
 * own scheme — an `http://`-only GHES instance (no TLS, e.g. behind a
 * private network boundary) must stay `http`, since silently upgrading to
 * `https` on the same port would target a port that is not serving TLS
 * and the fetch would fail; that origin's port is preserved too, since it
 * is directly reusable here.
 *
 * An `ssh://` URL-scheme origin (or any other non-`http(s)` scheme)
 * deliberately returns `null` rather than reusing its hostname: an SSH
 * hostname is sometimes an alias with no HTTPS service of its own —
 * GitHub's own documented `ssh.github.com` (used for SSH-over-443
 * firewall traversal) accepts SSH, not HTTPS, on that hostname, and a
 * local `~/.ssh/config` `Host` alias may not resolve via DNS at all.
 * Guessing wrong here would regress a previously-working `github.com`
 * fallback into a broken fetch, so this signal is treated as unusable
 * rather than guessed at. The scp-like shorthand keeps reusing its host,
 * since that syntax has no port field of its own and is therefore not
 * used for GitHub's SSH-over-443 workaround in practice — the same
 * hostname is the overwhelmingly common real-world case for a GHES
 * remote's SSH and HTTPS endpoints.
 *
 * Returns `null` for empty, unparseable, or host-less input (e.g. a
 * `file://` URL, whose `hostname` is `''`) so callers fall back to
 * another signal. The host is lowercased for consistent comparison —
 * DNS/HTTP hosts are case-insensitive.
 */
export function parseGitFetchOrigin(url: string): FetchOrigin | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.includes('://')) {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname) return null;
      if (parsed.protocol === 'http:') {
        return { scheme: 'http', host: parsed.host.toLowerCase() };
      }
      if (parsed.protocol === 'https:') {
        return { scheme: 'https', host: parsed.host.toLowerCase() };
      }
      // ssh:// (or any other scheme): no reusable host -- see the doc
      // comment above.
      return null;
    } catch {
      return null;
    }
  }
  // scp-like shorthand: [user@]host:path (no scheme, so URL() can't parse
  // it). A single-character "host" is excluded rather than requiring
  // `user@`: git's own scp-like syntax makes the username optional (a
  // real GHES remote can validly omit it), but no real git host is a
  // single letter, so this is almost always a Windows drive-letter path
  // (`C:\Users\...`, `C:repo.git`) rather than a real host.
  //
  // A bracketed IPv6 literal host (`[2001:db8::1]`) is matched before the
  // generic host pattern: IPv6 literals contain colons of their own, so
  // the generic `[^:/\s]+` alternative would otherwise stop at the first
  // one and capture only a truncated fragment (e.g. `[2001`).
  const scpMatch = trimmed.match(/^(?:[^@\s]+@)?(\[[^\]\s]+\]|[^:/\s]+):/);
  const host = scpMatch?.[1];
  return host && host.length > 1
    ? { scheme: 'https', host: host.toLowerCase() }
    : null;
}

/**
 * Resolve the scheme + host to use for the read-only base-ref fetch
 * fallback in {@link tryFetchBase}, instead of hardcoding
 * `https://github.com` (#1454) — a GitHub Enterprise Server (GHES)
 * checkout must fetch from its own host, or the fallback silently targets
 * an unrelated github.com repo of the same owner/repo name (or just
 * fails outright). Preference order:
 *
 * 1. The `GH_HOST` environment variable — the same override `gh` itself
 *    honors — when set and non-blank. `GH_HOST` never carries a scheme,
 *    so this always resolves to `https` (the same assumption `gh` itself
 *    makes for its own HTTPS operations).
 * 2. The scheme and host parsed from the local checkout's `origin`
 *    remote URL. This assumes the fetch-worthy remote is named `origin`,
 *    the conventional default for a single-remote checkout; an unusual
 *    multi-remote checkout that names its GHES remote something else
 *    falls through to (3).
 * 3. `https://github.com`, the pre-existing default, when neither signal
 *    resolves.
 */
export function resolveFetchOrigin(
  env: NodeJS.ProcessEnv = process.env,
  readers: FetchHostReaders = {},
): FetchOrigin {
  const ghHost = env.GH_HOST?.trim();
  // Lowercased for consistency with the origin-derived path below (DNS/HTTP
  // hosts are case-insensitive either way, so this does not change fetch
  // behavior -- only comparison/display consistency).
  if (ghHost) return { scheme: 'https', host: ghHost.toLowerCase() };
  const readOriginUrl = readers.readOriginUrl ?? readOriginRemoteUrl;
  return (
    parseGitFetchOrigin(readOriginUrl()) ?? {
      scheme: 'https',
      host: 'github.com',
    }
  );
}

/**
 * Attempt one fetch of the base ref at the given depth/deepen args, for
 * {@link computeMergeBase}'s bounded retry loop (via {@link
 * resolveMergeBaseWithRetry}). Returns `true` when the `git fetch` call
 * itself succeeded, so the caller's retry loop knows a deeper next step
 * could plausibly still help; returns `false` when preconditions
 * (`prBaseRef`, `owner`, `repo`) are missing, or when the fetch itself
 * failed (network, auth, unknown ref, etc.) -- in either case a further
 * attempt against the same unreachable/absent target would not change the
 * outcome, so the caller should stop immediately rather than repeat the
 * same failure (and its `notes` entry) across every remaining step.
 *
 * `timeoutMs` is the caller's remaining budget toward
 * {@link computeMergeBase}'s overall deadline (#2989 review, Copilot
 * round 2), not always the full {@link FETCH_TIMEOUT_MS} -- see
 * `MIN_FETCH_ATTEMPT_MS`'s doc comment for why an overall deadline
 * exists.
 *
 * The fetch `env` deliberately does **not** set `GIT_ASKPASS: ''`
 * (#2989 review, Codex round 4, reversing a CodeRabbit round-4
 * suggestion that was briefly applied and then reverted): unlike
 * `GIT_TERMINAL_PROMPT`/`GCM_INTERACTIVE`, which only disable
 * *interactive* prompting paths with no legitimate noninteractive use
 * case, `GIT_ASKPASS` is itself a credential *provider* Git may
 * consult before falling back to a terminal prompt -- some checkouts
 * point it at a genuinely noninteractive script (a CI-style token
 * emitter). Clearing it would silently break that legitimate
 * credential source's real, working fetches, not just interactive
 * ones. Any askpass helper that *is* interactive stays bounded by
 * `timeoutMs` regardless, same as every other stall this function
 * already tolerates.
 */
function tryFetchBase(
  prBaseRef: string,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
  fetchArgs: readonly string[],
  timeoutMs: number,
): boolean {
  if (!prBaseRef) return false;
  if (!owner || !repo) {
    notes.push(
      'Skipped base-ref fetch fallback: owner/repo not provided; merge-base probe may be incomplete.',
    );
    return false;
  }
  try {
    // resolveFetchOrigin()'s own branching (GH_HOST / origin-remote /
    // default) is unit-tested directly; this URL-assembly line and the
    // real `git fetch` below stay deliberately untested at this call
    // site, matching this file's existing test-suite convention of never
    // letting a test reach a live network fetch (see the "unresolvable
    // merge-base" test's `baseRefName: ''` short-circuit).
    const { scheme, host } = resolveFetchOrigin();
    const remote = `${scheme}://${host}/${owner}/${repo}.git`;
    execFileSync(
      'git',
      ['fetch', '--no-tags', ...fetchArgs, remote, prBaseRef],
      {
        stdio: 'ignore',
        encoding: 'utf8',
        timeout: timeoutMs,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
      },
    );
    return true;
  } catch {
    notes.push(
      `Could not fetch base ref ${prBaseRef} (git fetch ${fetchArgs.join(' ')}); merge-base probe may be incomplete.`,
    );
    return false;
  }
}

/**
 * Attempt one fetch of the PR **head** side at the given depth/deepen args,
 * for {@link computeMergeBase}'s bounded retry loop (via {@link
 * resolveMergeBaseWithRetry}) -- the #1535 sibling of {@link tryFetchBase}.
 *
 * Fetches `refs/pull/<prNumber>/head` from the same base-repository remote
 * `tryFetchBase` already targets, rather than the PR's own `headRefName` or
 * a fork's own remote URL. GitHub creates and keeps this ref updated on the
 * **base** repository for every pull request -- including from a fork, and
 * even when the fork remote has since been renamed, made private, or
 * deleted -- so it is fetchable with the exact same remote URL, the exact
 * same (anonymous, credential-helper-backed) auth, and the exact same
 * escalating depth/deepen args as the base-ref fetch, with no separate
 * fork-remote resolution required. Confirmed empirically for #1535 against
 * real GitHub-hosted repos (both a same-repository PR and a genuine
 * cross-repository/fork PR): `git ls-remote <repo> refs/pull/<n>/head`
 * matches `gh pr view --json headRefOid` exactly, and fetching that ref
 * (progressively deepened, mirroring {@link MERGE_BASE_FETCH_STEPS}) lets a
 * shallow clone that never had the PR head's ancestry at all resolve
 * `git merge-base` against it -- see the PR description for the full
 * experiment. Because this always fetches a normally-advertised ref (never
 * a bare, unadvertised SHA), it needs no server-side
 * `uploadpack.allow*SHA1InWant` support either.
 *
 * Returns `true` when the `git fetch` call itself succeeded, so the
 * caller's retry loop knows a deeper next step could plausibly still help;
 * returns `false` when preconditions (`prNumber`, `owner`, `repo`) are
 * missing or malformed, or when the fetch itself failed (network, auth,
 * unknown ref, etc.) -- in either case a further attempt against the same
 * unreachable/absent target would not change the outcome.
 *
 * `timeoutMs` is the caller's remaining budget toward
 * {@link computeMergeBase}'s overall deadline -- see `tryFetchBase`'s
 * own doc comment and `MIN_FETCH_ATTEMPT_MS` for why.
 */
function tryFetchHead(
  prNumber: unknown,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
  fetchArgs: readonly string[],
  timeoutMs: number,
): boolean {
  // Mirrors parseArgs's own canonical-positive-integer check: a malformed or
  // missing PR number is a structural skip, not an error -- callers that
  // never had a resolvable PR number (e.g. this file's own hermetic tests)
  // must not reach the real `git fetch` below.
  const prNumberText = String(prNumber ?? '');
  if (!/^[1-9]\d*$/.test(prNumberText)) return false;
  if (!owner || !repo) {
    notes.push(
      'Skipped head-ref fetch fallback: owner/repo not provided; merge-base probe may be incomplete.',
    );
    return false;
  }
  const headRef = `refs/pull/${prNumberText}/head`;
  try {
    // Deliberately untested at this call site -- see tryFetchBase's own
    // doc comment for why (this file's hermetic-test convention never lets
    // a test reach a live network fetch); the retry-loop shape this feeds
    // is covered directly via resolveMergeBaseWithRetry against a real
    // local shallow-clone fixture instead (see
    // tests/branch-conflict-state.test.mts's head-side-shallow test).
    const { scheme, host } = resolveFetchOrigin();
    const remote = `${scheme}://${host}/${owner}/${repo}.git`;
    execFileSync('git', ['fetch', '--no-tags', ...fetchArgs, remote, headRef], {
      stdio: 'ignore',
      encoding: 'utf8',
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
    });
    return true;
  } catch {
    notes.push(
      `Could not fetch head ref ${headRef} (git fetch ${fetchArgs.join(' ')}); merge-base probe may be incomplete.`,
    );
    return false;
  }
}

export function parseConflictFiles(mergeTreeOutput: string): string[] {
  const files = new Set<string>();
  for (const line of mergeTreeOutput.split('\n')) {
    // "CONFLICT (content): Merge conflict in path/to/file"
    // "CONFLICT (add/add): Merge conflict in path/to/file"
    // Any conflict type whose message ends with "Merge conflict in <path>"
    const mergeConflictMatch = line.match(
      /^CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(.+?)\s*$/i,
    );
    if (mergeConflictMatch) {
      files.add(mergeConflictMatch[1].trim());
      continue;
    }
    // "CONFLICT (modify/delete): <path> deleted in ... and modified in ..."
    // "CONFLICT (rename/delete): <old> renamed to <new> in ..."
    // "CONFLICT (rename/rename): <path> renamed to <a> in X and to <b> in Y"
    // First token after "TYPE): " is the conflicted original path
    const firstTokenMatch = line.match(
      /^CONFLICT\s+\([^)]+\):\s+(.+?)\s+(?:deleted|renamed|added|modified)\s+/i,
    );
    if (firstTokenMatch) {
      files.add(firstTokenMatch[1].trim());
    }
  }
  return [...files];
}

function fetchPrData(
  owner: string | undefined,
  repo: string | undefined,
  prNumber: unknown,
): PrData {
  const raw = ghText([
    'pr',
    'view',
    String(prNumber),
    '-R',
    `${owner}/${repo}`,
    '--json',
    'number,headRefOid,baseRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,headRepository',
    '--jq',
    '.',
  ]);
  try {
    return JSON.parse(raw) as PrData;
  } catch {
    throw new Error(`Failed to parse PR data for PR #${prNumber}`);
  }
}

function normalizeNullable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === '' || s === 'null' || s === 'undefined' ? null : s;
}

function gitText(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

export function parseArgs(argv: string[]): {
  help: boolean;
  prNumber: string | null;
  owner: string | null;
  repo: string | null;
} {
  const { values, help } = parseCliArgs(argv, BRANCH_CONFLICT_STATE_FLAG_SPEC);
  // --pr stays a canonical-positive-integer STRING (not a parsed number):
  // the caller passes it straight through to classifyBranchConflictState /
  // gh invocations as text, and tests/branch-conflict-state.test.mts
  // asserts this exact string-typed contract. Kept as a manual regex check
  // (not the canonical-integer helper) so the return type stays a string.
  const rawPr = values.pr as string | undefined;
  let prNumber: string | null = null;
  if (rawPr !== undefined) {
    if (!/^[1-9]\d*$/.test(rawPr)) {
      throw new Error(`invalid --pr value: ${rawPr}`);
    }
    prNumber = rawPr;
  }
  return {
    help,
    prNumber,
    owner: (values.owner as string | undefined) ?? null,
    repo: (values.repo as string | undefined) ?? null,
  };
}

function printUsage(): void {
  process.stdout.write(
    `Usage:\n  node scripts/branch-conflict-state.mjs --pr <number> [--owner <owner>] [--repo <repo>]\n`,
  );
}
