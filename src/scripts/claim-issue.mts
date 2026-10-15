#!/usr/bin/env node
// idd-generated-from: src/scripts/claim-issue.mts
//
// The scripts/claim-issue.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Dry run of the five A5 pre-checks in
// `.github/instructions/idd-claim.instructions.md` (issue-author approval,
// assignee, claim state, open pull requests, branch collision), run in that
// order and stopped at the first check that is not eligible. Without `--apply`
// it makes no write: no marker, no worktree, no lock file, no git change. It
// calls existing code rather than re-implementing it: it spawns
// `claim-approval-gate` and `resume-claim-routing --fresh-claim-gate` as child
// processes, reuses `fetchOpenLinkedPrReferences` and the D3.5 body matcher of
// `findIssueRelatedOpenPrs`, takes the branch from `computeBranchName`, and
// scans local worktrees with `inspectLocalWorktreeBranchPrefix`.
//
// With `--apply` (issue 4373), a run whose pre-checks all pass runs the
// fresh-claim order of `idd-claim.instructions.md`: B1 step 1 and the worktree
// (under the clone-scoped lock), then the claim marker, the activation nonce,
// `claim-lock --acquire`, and the final assert, with the authoring-label hold
// check before and after the claim. It stops at the first failed step and
// deletes nothing. Once the worktree exists, a failure keeps the worktree, the
// branch, and the worktree-local claim lock, and the report says what to run
// next (`lost-claim-cleanup`).
//
// Fail-closed contract: a pre-check helper or `gh` call that fails or returns
// malformed output never reads as eligible. It is `precheck-unavailable` with
// the written path as the next action (A5(a) has its own reason,
// `approval-unproven`, and the local worktree scan has
// `local-worktree-unreadable`). Only a failure before any check starts (the
// repository resolution and the read of the issue's title and assignees) is a
// `transport` error rather than a report.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { computeBranchName } from './branch-name.mts';
import { resolveBundleRoot } from './bundle-root.mts';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mts';
import {
  acquireCloneLock,
  type CloneLockHandle,
  releaseCloneLock,
} from './clone-lock.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  DEFAULT_POLICY_CONFIG_PATH,
  readRepositoryPolicyFile,
} from './idd-config.mts';
import {
  inspectLocalWorktreeBranchPrefix,
  type LocalWorktreeInspection,
  type LocalWorktreeRecord,
  parseLocalWorktreeList,
  sanitizedGitEnvironment,
} from './local-worktree-occupancy.mts';
import {
  inspectDevelopmentBranch,
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveEffectiveDevelopmentBranch,
} from './policy-helpers.mts';
import {
  fetchOpenLinkedPrReferences,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type {
  ProviderChangeRequestSummary,
  ProviderPort,
} from './provider-port.mts';
import { markerPostSentNothing } from './publish-authoring-hold.mts';
import { findIssueRelatedOpenPrs } from './resume-route-selection.mts';

const CLAIM_ISSUE_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--agent-id': { type: 'string' },
  '--project-status': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

/** Longest a child helper may run before the call counts as failed. */
const CHILD_TIMEOUT_MS = 120_000;
/** Longest a git command may run; a fetch on a slow network needs more. */
const GIT_TIMEOUT_MS = 300_000;
const CHILD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** The project-status values `--project-status` accepts (A5(b)). */
const PROJECT_STATUS_VALUES: readonly string[] = ['not-in-use', 'not-started'];

/**
 * A single token for the agent id: no whitespace, and neither comment delimiter,
 * which the marker grammar (`normalizeNonWhitespaceToken`) refuses to render.
 */
const AGENT_ID_PATTERN = /^(?!.*(?:<!--|-->))\S+$/;

/** Next actions of the write half that the report repeats. */
const PRIMARY_RETRY_NEXT =
  'Bring the primary checkout to the default branch by hand (B1 step 1 in idd-work.instructions.md), then rerun this helper. This helper removed nothing.';
const CLEANUP_NEXT =
  'Run the B1 cleanup of idd-work.instructions.md by hand: remove the prunable worktree entry, or delete the leftover branch if its commits are confirmed unneeded. Then rerun this helper. This helper removed nothing.';
const PATH_NEXT =
  'Inspect the path by hand. This helper never removes it: move or clean it, then rerun this helper.';

const FRESH_CLAIM_VERDICTS: readonly string[] = [
  'claimable',
  'already-claimed',
  'stale-reclaimable',
];

/**
 * What the fresh-claim gate pairs with each routing state it can emit: the
 * verdict and the routing action. Anything else is a malformed response.
 */
const ROUTING_PAIRS: Readonly<
  Record<string, { verdict: string; action: string }>
> = {
  unclaimed: { verdict: 'claimable', action: 're_claim' },
  stale: { verdict: 'stale-reclaimable', action: 'takeover' },
  non_inheritable: { verdict: 'already-claimed', action: 'stop' },
  disputed: { verdict: 'already-claimed', action: 'stop' },
  local_worktree_occupied: { verdict: 'already-claimed', action: 'stop' },
};

/** The reasons `claim-approval-gate` pairs with `approved: false`. */
const REFUSED_REASONS: readonly string[] = [
  'approval-missing',
  'approval-ambiguous',
  'approval-comment-stale',
  'freshness-undetermined',
];

/** The reasons `claim-approval-gate` pairs with `approved: true`. */
const APPROVED_REASONS: readonly string[] = [
  'author-self-authorized',
  'ready-label-present',
  'ready-comment-fresh',
  'gate-disabled',
];

/** The check that must pass for each approved reason (`null`: none). */
const APPROVED_REASON_CHECKS: Readonly<Record<string, string | null>> = {
  'author-self-authorized': 'author_self_authorized',
  'ready-label-present': 'ready_label_present',
  'ready-comment-fresh': 'ready_comment_fresh',
  'gate-disabled': null,
};

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('claim-issue', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}

/** The stop reasons a report can carry. */
export type ClaimStopReason =
  | 'approval-unproven'
  | 'approval-missing'
  | 'assigned'
  | 'already-claimed'
  | 'stale-takeover-out-of-scope'
  | 'open-pr'
  | 'precheck-unavailable'
  | 'local-worktree-occupied'
  | 'local-worktree-unreadable'
  | 'branch-collision'
  | 'primary-not-ready'
  | 'development-branch-unresolved'
  | 'b1-cleanup-needed'
  | 'path-occupied'
  | 'worktree-add-failed'
  | 'tokens-record-failed'
  | 'hold-active'
  | 'claim-post-failed'
  | 'recovery-hold'
  | 'nonce-post-failed'
  | 'lock-acquire-failed'
  | 'claim-not-verified'
  | 'released-after-hold';

/** One A5 pre-check in the report. */
export interface ClaimStep {
  id: string;
  status: 'passed' | 'failed' | 'not-run';
  reason: ClaimStopReason | null;
  nextAction: string | null;
  detail: string | null;
}

/** The JSON report printed on stdout. */
export interface ClaimIssueReport {
  issue: number;
  eligible: boolean;
  /** The stop reason, or `null` when every check passed. */
  reason: ClaimStopReason | null;
  /** The canonical `issue/<number>-<slug>` branch, from `computeBranchName`. */
  branch: string;
  /** Always `false`: the project status part of A5(b) is not checked. */
  projectStatusChecked: false;
  steps: ClaimStep[];
  /** Only for `already-claimed`: the gate CLI's top-level `reason`. */
  gateReason?: string;
  /** Only for `already-claimed`: the gate's `winning_claim_id`, or `null`. */
  winningClaimId?: string | null;
}

/** A finished child process or `gh` call. `status` is `null` on no exit code. */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Per-call options: the environment a child process runs with. */
export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * The one process seam: every `gh` call, `git` command, and child helper goes
 * through it. The optional `options` carry the child's environment.
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: CommandOptions,
) => CommandResult;

/** The clone-scoped mutex (`clone-lock.mts`), as the write half uses it. */
export interface CloneLockPort {
  acquire: (repoPath: string, agentId: string) => CloneLockHandle;
  release: (handle: CloneLockHandle) => void;
}

/** The outside world one run reads. Tests inject all of it. */
export interface ClaimIssueDeps {
  run: CommandRunner;
  resolveRepository: () => { owner: string; repo: string };
  createPort: (owner: string, repo: string) => ProviderPort;
  inspectLocalWorktrees: (issueNumber: number) => LocalWorktreeInspection;
  /** The path of a sibling helper script, such as `claim-approval-gate.mjs`. */
  childScript: (name: string) => string;
  /** The write half only: the clone-scoped lock around B1 step 1 and the worktree add. */
  cloneLock: CloneLockPort;
  /** The write half only: a synchronous wait for `claim.verifySettleDelay`. */
  sleepMs: (ms: number) => void;
  /** The write half only: the clock for the marker timestamps. */
  now: () => Date;
  /** The write half only: a fresh opaque claim id. */
  mintClaimId: () => string;
  /** The write half only: a fresh activation nonce (32 hex characters). */
  mintNonce: () => string;
}

/** What one run produced: a report, or a failure before any check started. */
export type ClaimPrecheckOutcome =
  | { kind: 'report'; report: ClaimIssueReport }
  | { kind: 'transport'; message: string };

type CheckOutcome =
  | { ok: true; detail: string }
  | {
      ok: false;
      reason: ClaimStopReason;
      nextAction: string;
      detail: string;
      gateReason?: string;
      winningClaimId?: string | null;
    };

interface IssueRead {
  title: string;
  assignees: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeStatus(result: CommandResult): string {
  return result.status === null
    ? 'no exit status (timeout, signal, or spawn failure)'
    : `exit code ${result.status}`;
}

function pass(detail: string): CheckOutcome {
  return { ok: true, detail };
}

function stop(
  reason: ClaimStopReason,
  nextAction: string,
  detail: string,
  extra: { gateReason?: string; winningClaimId?: string | null } = {},
): CheckOutcome {
  return { ok: false, reason, nextAction, detail, ...extra };
}

function writtenPath(label: string): string {
  return `Use the written path of check ${label} in idd-claim.instructions.md.`;
}

function unavailable(label: string, detail: string): CheckOutcome {
  return stop('precheck-unavailable', writtenPath(label), detail);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The default process seam: `gh` through gh-exec, children through spawnSync. */
export function createDefaultRunner(): CommandRunner {
  return (file, args, options) => {
    if (file === 'gh') {
      try {
        return {
          status: 0,
          stdout: ghText([...args], GH_TEXT_LOOP_TIMEOUT_OPTIONS),
          stderr: '',
        };
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        return {
          status: typeof status === 'number' && status !== 0 ? status : 1,
          stdout: '',
          stderr: errorMessage(error),
        };
      }
    }
    // git runs without the GIT_* overrides a hook may have exported, so `-C`
    // names the path it is given; a child helper keeps the caller's environment
    // unless the caller asks for a specific one (the error envelope request).
    const isGit = file === 'git';
    const result = spawnSync(file, [...args], {
      encoding: 'utf8',
      maxBuffer: CHILD_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: isGit ? GIT_TIMEOUT_MS : CHILD_TIMEOUT_MS,
      ...(options?.env !== undefined
        ? { env: options.env }
        : isGit
          ? { env: sanitizedGitEnvironment() }
          : {}),
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

/** Block synchronously for `ms` milliseconds (the settle delay). */
function sleepSync(ms: number): void {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

/** The real dependencies: gh, the sibling scripts, and the current clone. */
export function createDefaultDeps(): ClaimIssueDeps {
  return {
    run: createDefaultRunner(),
    resolveRepository: resolveCurrentGithubRepository,
    createPort: (owner, repo) => createGithubProviderAdapter(owner, repo),
    inspectLocalWorktrees: (issueNumber) =>
      inspectLocalWorktreeBranchPrefix(issueNumber),
    childScript: (name) =>
      join(resolveBundleRoot(import.meta.dirname), 'scripts', name),
    cloneLock: {
      acquire: (repoPath, agentId) => acquireCloneLock(repoPath, agentId),
      release: (handle) => releaseCloneLock(handle),
    },
    sleepMs: sleepSync,
    now: () => new Date(),
    mintClaimId: () => randomUUID(),
    mintNonce: () => randomBytes(16).toString('hex'),
  };
}

/** Read the title and assignees with one `gh issue view`; `null` when malformed. */
function parseIssueRead(stdout: string): IssueRead | null {
  const parsed = parseJsonObject(stdout);
  if (
    parsed === null ||
    typeof parsed.title !== 'string' ||
    parsed.title.trim() === ''
  ) {
    return null;
  }
  if (!Array.isArray(parsed.assignees)) {
    return null;
  }
  const assignees: string[] = [];
  for (const assignee of parsed.assignees) {
    if (
      !isRecord(assignee) ||
      typeof assignee.login !== 'string' ||
      assignee.login === ''
    ) {
      return null;
    }
    assignees.push(assignee.login);
  }
  return { title: parsed.title, assignees };
}

/** True when a child helper's `issue` block names the issue it was asked about. */
function describesIssue(value: unknown, issueNumber: number): boolean {
  return isRecord(value) && value.number === issueNumber;
}

/** A non-empty list of checks, each with a string `id`, `name`, and `result`. */
function isCheckList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (check: unknown) =>
        isRecord(check) &&
        typeof check.id === 'string' &&
        check.id !== '' &&
        typeof check.name === 'string' &&
        check.name.trim() !== '' &&
        (check.result === 'pass' || check.result === 'fail'),
    )
  );
}

/**
 * True when the approval evidence agrees with itself the way the gate emits
 * it: `gateEnabled` is false only for the `gate-disabled` approval, the
 * `policy.skipIssueAuthorApprovalGate` flag and the `gate_enabled` check say
 * the same, and an approved reason has its own check passing. Call it only after the shape checks above passed.
 */
function approvalEvidenceAgrees(evidence: Record<string, unknown>): boolean {
  const checks = evidence.checks as Record<string, unknown>[];
  const resultOf = (id: string): unknown =>
    checks.find((check) => check.id === id)?.result;
  const gateEnabled = evidence.gateEnabled === true;
  if (gateEnabled !== (evidence.reason !== 'gate-disabled')) {
    return false;
  }
  const policy = evidence.policy as Record<string, unknown>;
  if (policy.skipIssueAuthorApprovalGate !== !gateEnabled) {
    return false;
  }
  if (resultOf('gate_enabled') !== (gateEnabled ? 'pass' : 'fail')) {
    return false;
  }
  if (evidence.approved !== true) {
    return gateEnabled;
  }
  const reasonCheck = APPROVED_REASON_CHECKS[String(evidence.reason)];
  return reasonCheck === null || resultOf(reasonCheck) === 'pass';
}

/** A5(a): the issue-author approval gate, through `claim-approval-gate`. */
function checkApproval(
  issueNumber: number,
  deps: ClaimIssueDeps,
): CheckOutcome {
  const unproven = (detail: string): CheckOutcome =>
    stop(
      'approval-unproven',
      'Apply the written A5(a) path in idd-claim.instructions.md by hand; if it cannot prove safe approval, treat approval as missing.',
      detail,
    );
  const result = deps.run(process.execPath, [
    deps.childScript('claim-approval-gate.mjs'),
    '--issue',
    String(issueNumber),
  ]);
  if (result.status !== 0) {
    return unproven(`claim-approval-gate ended with ${describeStatus(result)}`);
  }
  const evidence = parseJsonObject(result.stdout);
  if (evidence === null) {
    return unproven('claim-approval-gate printed invalid JSON');
  }
  const policy = evidence.policy;
  if (
    !describesIssue(evidence.issue, issueNumber) ||
    typeof evidence.approved !== 'boolean' ||
    typeof evidence.reason !== 'string' ||
    evidence.reason.trim() === '' ||
    !(evidence.approved === true ? APPROVED_REASONS : REFUSED_REASONS).includes(
      evidence.reason,
    ) ||
    typeof evidence.gateEnabled !== 'boolean' ||
    !isRecord(policy) ||
    typeof policy.maintainerApprovalActorPolicy !== 'string' ||
    policy.maintainerApprovalActorPolicy.trim() === '' ||
    !isRecord(policy.approvalSignals) ||
    typeof policy.approvalSignals.readyLabelName !== 'string' ||
    policy.approvalSignals.readyLabelName.trim() === '' ||
    typeof policy.approvalSignals.labelFreshnessMode !== 'string' ||
    policy.approvalSignals.labelFreshnessMode.trim() === '' ||
    !isCheckList(evidence.checks)
  ) {
    return unproven('claim-approval-gate printed incomplete evidence');
  }
  if (!approvalEvidenceAgrees(evidence)) {
    return unproven('claim-approval-gate printed contradictory evidence');
  }
  if (!evidence.approved) {
    return stop(
      'approval-missing',
      'Do not claim. For a Discover run return to Discover with the same selection mode; for an explicit target stop without claiming (A5(a)).',
      `claim-approval-gate reports approval missing (${evidence.reason})`,
    );
  }
  return pass(`approved (${evidence.reason})`);
}

/** A5(b): no assignee. The project status is not checked. */
function checkAssignee(issue: IssueRead): CheckOutcome {
  if (issue.assignees.length > 0) {
    return stop(
      'assigned',
      'Do not claim: the issue already has an assignee (A5(b)).',
      `assigned to ${issue.assignees.join(', ')}`,
    );
  }
  return pass('no assignee (the project status is not checked)');
}

/** What `resume-claim-routing --fresh-claim-gate` printed, once it is read and checked. */
type FreshGateReading =
  | {
      ok: true;
      verdict: string;
      reason: string;
      winningClaimId: string | null;
    }
  | { ok: false; detail: string };

/**
 * Run `resume-claim-routing --fresh-claim-gate` (with `extra` arguments, such
 * as `--own-worktree <path>` for the gate after the worktree exists) and read
 * its verdict. A malformed or inconsistent answer is `ok: false`, never a
 * verdict, so no caller can read it as claimable.
 */
function readFreshClaimGate(
  issueNumber: number,
  extra: readonly string[],
  deps: ClaimIssueDeps,
): FreshGateReading {
  const result = deps.run(process.execPath, [
    deps.childScript('resume-claim-routing.mjs'),
    '--issue',
    String(issueNumber),
    '--fresh-claim-gate',
    ...extra,
  ]);
  if (result.status !== 0) {
    return {
      ok: false,
      detail: `resume-claim-routing ended with ${describeStatus(result)}`,
    };
  }
  const routing = parseJsonObject(result.stdout);
  const gate = routing === null ? null : routing.fresh_claim_gate;
  if (
    routing === null ||
    !describesIssue(routing.issue, issueNumber) ||
    !isRecord(gate) ||
    typeof gate.verdict !== 'string' ||
    !FRESH_CLAIM_VERDICTS.includes(gate.verdict)
  ) {
    return {
      ok: false,
      detail: 'resume-claim-routing printed no valid fresh_claim_gate verdict',
    };
  }
  // Every verdict carries a top-level reason and a winning_claim_id (null when
  // there is no winner), so a truncated response cannot pass as claimable.
  const winningClaimId = gate.winning_claim_id;
  if (
    typeof routing.reason !== 'string' ||
    routing.reason.trim() === '' ||
    !Object.hasOwn(gate, 'winning_claim_id') ||
    (winningClaimId !== null &&
      (typeof winningClaimId !== 'string' || winningClaimId === ''))
  ) {
    return {
      ok: false,
      detail:
        'resume-claim-routing printed a verdict without a reason or winning_claim_id',
    };
  }
  // The verdict, the routing state and the routing action must be one of the
  // pairs the gate emits; an unclaimed issue also has no winning claim.
  const pair =
    typeof routing.state === 'string' &&
    Object.hasOwn(ROUTING_PAIRS, routing.state)
      ? ROUTING_PAIRS[routing.state]
      : undefined;
  if (
    pair === undefined ||
    pair.verdict !== gate.verdict ||
    pair.action !== routing.action ||
    (gate.verdict === 'claimable' && winningClaimId !== null)
  ) {
    return {
      ok: false,
      detail:
        'resume-claim-routing printed a verdict, state, action, or winner it never pairs together',
    };
  }
  return {
    ok: true,
    verdict: gate.verdict,
    reason: routing.reason,
    winningClaimId: winningClaimId === null ? null : (winningClaimId as string),
  };
}

/** A5(c): the fresh-claim gate of `resume-claim-routing`. */
function checkClaimState(
  issueNumber: number,
  deps: ClaimIssueDeps,
): CheckOutcome {
  const reading = readFreshClaimGate(issueNumber, [], deps);
  if (!reading.ok) {
    return unavailable('A5(c)', reading.detail);
  }
  if (reading.verdict === 'claimable') {
    return pass('claimable');
  }
  if (reading.verdict === 'stale-reclaimable') {
    return stop(
      'stale-takeover-out-of-scope',
      'This helper checks a fresh claim only. Follow the stale-claim takeover path in idd-claim.instructions.md (A5(c)) by hand.',
      'the active claim is stale and reclaimable; takeover is out of scope',
    );
  }
  return stop(
    'already-claimed',
    'Do not claim: apply the already-claimed routing in idd-claim.instructions.md (A5(c)).',
    `the fresh-claim gate returned already-claimed (${reading.reason})`,
    { gateReason: reading.reason, winningClaimId: reading.winningClaimId },
  );
}

/**
 * Throw unless every open pull request row is usable: a malformed row could
 * hide the very pull request that closes the issue, so the scan must fail
 * rather than silently skip it. The GitHub adapter turns a missing body into
 * the empty string, so an empty body stays valid.
 */
function requireWellFormedRows(rows: unknown): ProviderChangeRequestSummary[] {
  if (!Array.isArray(rows)) {
    throw new Error('the open pull request list is not an array');
  }
  for (const row of rows as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row.number !== 'number' ||
      !Number.isSafeInteger(row.number) ||
      row.number <= 0 ||
      typeof row.title !== 'string' ||
      typeof row.body !== 'string' ||
      typeof row.url !== 'string'
    ) {
      throw new Error('the open pull request list holds a malformed row');
    }
  }
  return rows as ProviderChangeRequestSummary[];
}

/** The port with `listOpenChangeRequests` checked row by row. */
function withWellFormedOpenRows(port: ProviderPort): ProviderPort {
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === 'listOpenChangeRequests') {
        return () => requireWellFormedRows(target.listOpenChangeRequests());
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * A5(d): open pull requests that close or reference the issue. Both signals
 * always run (no short-circuit). A pull request found by either wins, whatever
 * the lookup state; a failed lookup that found nothing is unavailable.
 */
function checkOpenPullRequests(
  issueNumber: number,
  repository: { owner: string; repo: string },
  deps: ClaimIssueDeps,
): CheckOutcome {
  const port = withWellFormedOpenRows(
    deps.createPort(repository.owner, repository.repo),
  );
  const found = new Set<string>();
  let lookupFailed = false;
  try {
    const linked = fetchOpenLinkedPrReferences(
      port,
      issueNumber,
      `${repository.owner}/${repository.repo}`,
    );
    for (const reference of linked.references) {
      found.add(reference);
    }
    lookupFailed ||= linked.lookupFailed;
  } catch {
    lookupFailed = true;
  }
  try {
    for (const pr of findIssueRelatedOpenPrs({ port, issueNumber })) {
      found.add(String(pr.number));
    }
  } catch {
    lookupFailed = true;
  }
  if (found.size > 0) {
    const numbers = [...found]
      .sort((left, right) => Number(left) - Number(right))
      .map((reference) => `#${reference}`);
    return stop(
      'open-pr',
      'Do not claim: apply the written A5(d) rule in idd-claim.instructions.md.',
      `open pull request ${numbers.join(', ')} closes or references this issue${
        lookupFailed ? ' (the lookup was also incomplete)' : ''
      }`,
    );
  }
  if (lookupFailed) {
    return unavailable(
      'A5(d)',
      'the open pull request lookup failed and found nothing',
    );
  }
  return pass('no open pull request closes or references this issue');
}

/**
 * Read the pages of a paginated matching-refs response, one compact JSON array
 * per line. `null` when there is no page at all (even an empty result prints
 * `[]`), a page is not an array, or an entry has no `refs/heads/` ref string.
 */
function parseMatchingRefs(stdout: string): string[] | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return null;
  }
  const refs: string[] = [];
  for (const line of lines) {
    let page: unknown;
    try {
      page = JSON.parse(line);
    } catch {
      return null;
    }
    if (!Array.isArray(page)) {
      return null;
    }
    for (const entry of page as unknown[]) {
      if (
        !isRecord(entry) ||
        typeof entry.ref !== 'string' ||
        !entry.ref.startsWith('refs/heads/') ||
        entry.ref.length === 'refs/heads/'.length
      ) {
        return null;
      }
      refs.push(entry.ref);
    }
  }
  return refs;
}

/** `: a, b` for a non-empty list of path strings, else nothing. */
function describePaths(paths: unknown): string {
  return Array.isArray(paths) && paths.length > 0
    ? `: ${paths.map(String).join(', ')}`
    : '';
}

/** A5(e): the local worktree scan, then the scoped remote branch scan. */
function checkBranchCollision(
  issueNumber: number,
  repository: { owner: string; repo: string },
  deps: ClaimIssueDeps,
): CheckOutcome {
  const prefix = `issue/${issueNumber}-`;
  let local: LocalWorktreeInspection;
  try {
    local = deps.inspectLocalWorktrees(issueNumber);
  } catch (error) {
    local = { status: 'unreadable', paths: [], reason: errorMessage(error) };
  }
  const collisionPath =
    'Follow the A5(e) collision action tree in idd-claim.instructions.md.';
  if (local.status === 'occupied') {
    return stop(
      'local-worktree-occupied',
      collisionPath,
      `a local worktree holds ${prefix}*${describePaths(local.paths)}`,
    );
  }
  // Anything that is not a proven absence fails closed, so a malformed
  // inspector result cannot reach the remote scan as "absent".
  if (
    local.status !== 'absent' ||
    !Array.isArray(local.paths) ||
    local.paths.length > 0 ||
    local.reason !== null
  ) {
    return stop(
      'local-worktree-unreadable',
      collisionPath,
      `a local worktree could not be ruled out${
        typeof local.reason === 'string' && local.reason
          ? ` (${local.reason})`
          : ''
      }${describePaths(local.paths)}`,
    );
  }
  // `tojson` prints each page as one compact JSON line, so the scan reads the
  // structured response instead of trusting a projection that prints nothing
  // for a malformed body.
  const remote = deps.run('gh', [
    'api',
    `repos/${repository.owner}/${repository.repo}/git/matching-refs/heads/${prefix}`,
    '--paginate',
    '--jq',
    'tojson',
  ]);
  if (remote.status !== 0) {
    return unavailable(
      'A5(e)',
      `the remote branch scan ended with ${describeStatus(remote)}`,
    );
  }
  const refs = parseMatchingRefs(remote.stdout);
  if (refs === null) {
    return unavailable(
      'A5(e)',
      'the remote branch scan printed a malformed matching-refs response',
    );
  }
  const collisions = refs
    .filter((ref) => ref.startsWith(`refs/heads/${prefix}`))
    .map((ref) => ref.slice('refs/heads/'.length));
  if (collisions.length > 0) {
    return stop(
      'branch-collision',
      `Post the A5(e) hold note from idd-claim.instructions.md and stop for operator review; this helper does not post it.`,
      `remote branch ${collisions.join(', ')} already exists`,
    );
  }
  return pass(`no local worktree or remote branch matches ${prefix}*`);
}

/**
 * Run the five A5 pre-checks for one issue, read-only. Resolves the repository
 * and reads the issue's title and assignees first; a failure there is a
 * `transport` outcome. Then it runs A5(a) to A5(e) in order, stops at the first
 * check that is not eligible, and marks the rest `not-run`.
 */
export function runClaimPrechecks(
  issueNumber: number,
  deps: ClaimIssueDeps,
): ClaimPrecheckOutcome {
  let repository: { owner: string; repo: string };
  try {
    repository = deps.resolveRepository();
  } catch (error) {
    return {
      kind: 'transport',
      message: `could not resolve the repository: ${errorMessage(error)}`,
    };
  }
  let issue: IssueRead | null = null;
  let readFailure = '';
  try {
    const read = deps.run('gh', [
      'issue',
      'view',
      String(issueNumber),
      '--json',
      'title,assignees',
    ]);
    if (read.status !== 0) {
      readFailure = `gh issue view ended with ${describeStatus(read)}`;
    } else {
      issue = parseIssueRead(read.stdout);
      if (issue === null) {
        readFailure = 'gh issue view printed no valid title and assignees';
      }
    }
  } catch (error) {
    readFailure = errorMessage(error);
  }
  if (issue === null) {
    return {
      kind: 'transport',
      message: `could not read issue ${issueNumber}: ${readFailure}`,
    };
  }
  const readIssue = issue;
  const branch = computeBranchName(issueNumber, readIssue.title);

  const checks: {
    id: string;
    label: string;
    /** The reason a throw inside the check maps to. */
    onThrow: ClaimStopReason;
    run: () => CheckOutcome;
  }[] = [
    {
      id: 'a5a-approval',
      label: 'A5(a)',
      onThrow: 'approval-unproven',
      run: () => checkApproval(issueNumber, deps),
    },
    {
      id: 'a5b-assignee',
      label: 'A5(b)',
      onThrow: 'precheck-unavailable',
      run: () => checkAssignee(readIssue),
    },
    {
      id: 'a5c-claim-state',
      label: 'A5(c)',
      onThrow: 'precheck-unavailable',
      run: () => checkClaimState(issueNumber, deps),
    },
    {
      id: 'a5d-open-pr',
      label: 'A5(d)',
      onThrow: 'precheck-unavailable',
      run: () => checkOpenPullRequests(issueNumber, repository, deps),
    },
    {
      id: 'a5e-branch-collision',
      label: 'A5(e)',
      onThrow: 'precheck-unavailable',
      run: () => checkBranchCollision(issueNumber, repository, deps),
    },
  ];

  const steps: ClaimStep[] = [];
  let report: Pick<
    ClaimIssueReport,
    'reason' | 'gateReason' | 'winningClaimId'
  > = { reason: null };
  let stopped = false;
  for (const check of checks) {
    if (stopped) {
      steps.push({
        id: check.id,
        status: 'not-run',
        reason: null,
        nextAction: null,
        detail: null,
      });
      continue;
    }
    let outcome: CheckOutcome;
    try {
      outcome = check.run();
    } catch (error) {
      outcome = stop(
        check.onThrow,
        check.onThrow === 'approval-unproven'
          ? 'Apply the written A5(a) path in idd-claim.instructions.md by hand; if it cannot prove safe approval, treat approval as missing.'
          : writtenPath(check.label),
        `the check threw: ${errorMessage(error)}`,
      );
    }
    if (outcome.ok) {
      steps.push({
        id: check.id,
        status: 'passed',
        reason: null,
        nextAction: null,
        detail: outcome.detail,
      });
      continue;
    }
    stopped = true;
    steps.push({
      id: check.id,
      status: 'failed',
      reason: outcome.reason,
      nextAction: outcome.nextAction,
      detail: outcome.detail,
    });
    report = {
      reason: outcome.reason,
      ...(outcome.gateReason === undefined
        ? {}
        : {
            gateReason: outcome.gateReason,
            winningClaimId: outcome.winningClaimId ?? null,
          }),
    };
  }
  return {
    kind: 'report',
    report: {
      issue: issueNumber,
      eligible: !stopped,
      reason: report.reason,
      branch,
      projectStatusChecked: false,
      steps,
      ...(report.gateReason === undefined
        ? {}
        : {
            gateReason: report.gateReason,
            winningClaimId: report.winningClaimId ?? null,
          }),
    },
  };
}

// ---------------------------------------------------------------------------
// --apply: the fresh-claim order of idd-claim.instructions.md (issue 4373).
// The steps run in the documented order and stop at the first failure. Nothing
// is deleted: once the worktree exists, a failure keeps it, its branch, and its
// worktree-local claim lock, and the report names the next action.
// ---------------------------------------------------------------------------

/** The project status the caller attests for A5(b); the helper cannot read it. */
export type ClaimProjectStatus = 'not-in-use' | 'not-started';

/** What `--apply` takes from the caller. */
export interface ClaimApplyInput {
  agentId: string;
  projectStatus: ClaimProjectStatus;
}

/** The claim identity a run minted. Present once the worktree exists. */
export interface ClaimApplyIdentity {
  agentId: string;
  claimId: string;
  nonce: string;
  branch: string;
  worktree: string;
}

/** The `--apply` report: the pre-check report plus the write half's fields. */
export interface ClaimApplyReport extends ClaimIssueReport {
  mode: 'apply';
  projectStatus: ClaimProjectStatus;
  /** Only the authoring label is read; the owner-marker log replay is not done. */
  holdCheck: 'label';
  /** `true` once the claim marker is on the issue, `false` when nothing was sent, `'unknown'` otherwise. */
  claimPosted: boolean | 'unknown';
  lostClaimCleanupRequired: boolean;
  /** What the caller does next; `null` once the claim is verified. */
  nextAction: string | null;
  claim: ClaimApplyIdentity | null;
}

/** One failed step: the stop reason, what to do next, and the cleanup flag. */
interface ApplyFailure {
  reason: ClaimStopReason;
  nextAction: string;
  detail: string;
  /** Overrides the default, which is `true` once the worktree exists. */
  lost?: boolean;
  gateReason?: string;
  winningClaimId?: string | null;
}

type ApplyOutcome =
  | { ok: true; detail: string }
  | { ok: false; failure: ApplyFailure };

/** Everything one apply run carries from step to step. */
interface ApplyState {
  issue: number;
  repository: { owner: string; repo: string };
  deps: ClaimIssueDeps;
  input: ClaimApplyInput;
  branch: string;
  steps: ClaimStep[];
  /** The primary checkout: the main worktree of the clone. */
  primary: string;
  /** The computed worktree path, `<primary-parent>/<repo>.<normalized-branch>`. */
  path: string;
  defaultBranch: string;
  developmentBranch: string;
  config: unknown;
  settleMs: number;
  authoringLabel: string;
  trustedActors: string[];
  worktreeCreated: boolean;
  identity: ClaimApplyIdentity | null;
  claimPosted: boolean | 'unknown';
}

/** The authoring-label read: clear, held, or not readable (never read as clear). */
type HoldReading =
  | { kind: 'clear' }
  | { kind: 'held' }
  | { kind: 'unavailable'; detail: string };

/** The next action once a claim may be held by this session (lost-claim cleanup). */
function lostClaimNext(claimId: string): string {
  return `Run lost-claim-cleanup (idd-claim.instructions.md) for claim ${claimId}. If it stops with this claim still active, post unclaimed-by for it (never for an activation-nonce mismatch) and run lost-claim-cleanup again.`;
}

function applyFail(
  reason: ClaimStopReason,
  nextAction: string,
  detail: string,
  extra: Partial<ApplyFailure> = {},
): ApplyOutcome {
  return { ok: false, failure: { reason, nextAction, detail, ...extra } };
}

function applyPass(detail: string): ApplyOutcome {
  return { ok: true, detail };
}

/** Record one step's outcome in the report. Returns its failure, or `null`. */
function step(
  state: ApplyState,
  id: string,
  outcome: ApplyOutcome,
): ApplyFailure | null {
  if (outcome.ok) {
    state.steps.push({
      id,
      status: 'passed',
      reason: null,
      nextAction: null,
      detail: outcome.detail,
    });
    return null;
  }
  const { failure } = outcome;
  state.steps.push({
    id,
    status: 'failed',
    reason: failure.reason,
    nextAction: failure.nextAction,
    detail: failure.detail,
  });
  return failure;
}

function timestampOf(state: ApplyState): string {
  // Second precision, as the claim grammar prints it (`...T..:..:..Z`).
  return state.deps
    .now()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Run `post-idd-marker --apply` with the error envelope requested. */
function postMarker(state: ApplyState, args: readonly string[]): CommandResult {
  return state.deps.run(
    process.execPath,
    [
      state.deps.childScript('post-idd-marker.mjs'),
      ...args,
      '--owner',
      state.repository.owner,
      '--repo',
      state.repository.repo,
      '--apply',
    ],
    { env: { ...process.env, IDD_HELPER_ERROR_ENVELOPE: '1' } },
  );
}

/** Parse a `gh issue view --json labels` answer; `null` when malformed. */
function parseLabelNames(stdout: string): string[] | null {
  const parsed = parseJsonObject(stdout);
  if (parsed === null || !Array.isArray(parsed.labels)) {
    return null;
  }
  const names: string[] = [];
  for (const label of parsed.labels as unknown[]) {
    if (
      !isRecord(label) ||
      typeof label.name !== 'string' ||
      label.name === ''
    ) {
      return null;
    }
    names.push(label.name);
  }
  return names;
}

/** The authoring hold: the authoring label only (holdCheck: label). */
function readHold(state: ApplyState): HoldReading {
  const read = state.deps.run('gh', [
    'issue',
    'view',
    String(state.issue),
    '--json',
    'labels',
  ]);
  if (read.status !== 0) {
    return {
      kind: 'unavailable',
      detail: `gh issue view ended with ${describeStatus(read)}`,
    };
  }
  const labels = parseLabelNames(read.stdout);
  if (labels === null) {
    return {
      kind: 'unavailable',
      detail: 'gh issue view printed no valid labels',
    };
  }
  return labels.includes(state.authoringLabel)
    ? { kind: 'held' }
    : { kind: 'clear' };
}

/** The comments of the issue, every page; `null` when any page is malformed. */
function parseCommentPages(
  stdout: string,
): { login: string; body: string }[] | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return null;
  }
  const comments: { login: string; body: string }[] = [];
  for (const line of lines) {
    let page: unknown;
    try {
      page = JSON.parse(line);
    } catch {
      return null;
    }
    if (!Array.isArray(page)) {
      return null;
    }
    for (const entry of page as unknown[]) {
      if (
        !isRecord(entry) ||
        typeof entry.login !== 'string' ||
        typeof entry.body !== 'string'
      ) {
        return null;
      }
      comments.push({ login: entry.login, body: entry.body });
    }
  }
  return comments;
}

/**
 * Whether a trusted comment starts with `prefix` (the marker token, which must
 * be the first bytes of the body). `unknown` when the read itself fails, so a
 * caller can never take an unreadable issue for an absent marker.
 */
function findMarker(
  state: ApplyState,
  prefix: string,
): 'present' | 'absent' | 'unknown' {
  const { owner, repo } = state.repository;
  const read = state.deps.run('gh', [
    'api',
    `repos/${owner}/${repo}/issues/${state.issue}/comments`,
    '--paginate',
    '--jq',
    '[.[] | {login: .user.login, body: .body}] | tojson',
  ]);
  if (read.status !== 0) {
    return 'unknown';
  }
  const comments = parseCommentPages(read.stdout);
  if (comments === null) {
    return 'unknown';
  }
  return comments.some(
    (comment) =>
      state.trustedActors.includes(comment.login.toLowerCase()) &&
      comment.body.startsWith(prefix),
  )
    ? 'present'
    : 'absent';
}

/** The primary checkout: the main worktree, the first record of the listing. */
function readPrimaryRoot(state: ApplyState): ApplyOutcome {
  const list = state.deps.run('git', ['worktree', 'list', '--porcelain', '-z']);
  if (list.status !== 0) {
    return applyFail(
      'primary-not-ready',
      PRIMARY_RETRY_NEXT,
      `git worktree list ended with ${describeStatus(list)}`,
    );
  }
  let records: LocalWorktreeRecord[];
  try {
    records = parseLocalWorktreeList(list.stdout);
  } catch (error) {
    return applyFail(
      'primary-not-ready',
      PRIMARY_RETRY_NEXT,
      `git worktree list is malformed: ${errorMessage(error)}`,
    );
  }
  const main = records[0];
  if (main === undefined || main.path === '' || main.bare) {
    return applyFail(
      'primary-not-ready',
      PRIMARY_RETRY_NEXT,
      'git worktree list names no primary checkout',
    );
  }
  state.primary = main.path;
  return applyPass(`primary checkout ${main.path}`);
}

/**
 * The policy, read from the primary checkout (not the working directory), with
 * the settle delay, the authoring label, and the trusted marker actors. A
 * missing file is no policy; a malformed one fails closed.
 */
function readPolicy(state: ApplyState): ApplyOutcome {
  const path = join(state.primary, DEFAULT_POLICY_CONFIG_PATH);
  let config: unknown = null;
  try {
    config = existsSync(path) ? readRepositoryPolicyFile(path).config : null;
    normalizePolicyConfig(config);
  } catch (error) {
    return applyFail(
      'precheck-unavailable',
      'Read .github/idd/config.json by hand, fix it, then rerun this helper. Nothing was created.',
      `the policy could not be read: ${errorMessage(error)}`,
    );
  }
  const normalized = normalizePolicyConfig(config);
  const trusted = resolveTrustedMarkerActors({
    config: isRecord(config)
      ? { trustedMarkerActors: config.trustedMarkerActors }
      : null,
  }).actors;
  if (trusted.length === 0) {
    return applyFail(
      'precheck-unavailable',
      'Set trustedMarkerActors in .github/idd/config.json, then rerun this helper. Nothing was created.',
      'no trusted marker actor is configured',
    );
  }
  state.config = config;
  state.settleMs =
    parseIsoDurationToMs(normalized.claim.verifySettleDelay) ?? 0;
  state.authoringLabel = normalized.issueAuthoring.authoringLabelName;
  state.trustedActors = trusted;
  return applyPass(`policy read from ${path}`);
}

/** The default branch from GitHub, validated the way a development branch is. */
function readDefaultBranch(state: ApplyState): ApplyOutcome {
  const read = state.deps.run('gh', [
    'repo',
    'view',
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ]);
  if (read.status !== 0) {
    return applyFail(
      'primary-not-ready',
      PRIMARY_RETRY_NEXT,
      `gh repo view ended with ${describeStatus(read)}`,
    );
  }
  const name = read.stdout.trim();
  if (
    inspectDevelopmentBranch({ developmentBranch: name }).status !==
    'configured'
  ) {
    return applyFail(
      'primary-not-ready',
      PRIMARY_RETRY_NEXT,
      `the default branch name is unusable (${JSON.stringify(name)})`,
    );
  }
  state.defaultBranch = name;
  return applyPass(`default branch ${name}`);
}

/** The development branch the worktree is based on (fail closed). */
function resolveDevelopment(state: ApplyState): ApplyOutcome {
  const target = resolveEffectiveDevelopmentBranch(
    state.config,
    state.defaultBranch,
  );
  if (
    (target.status === 'configured' || target.status === 'default') &&
    target.branch !== undefined
  ) {
    state.developmentBranch = target.branch;
    return applyPass(`development branch ${target.branch} (${target.status})`);
  }
  return applyFail(
    'development-branch-unresolved',
    'Fix developmentBranch in .github/idd/config.json, or the default branch on origin, then rerun this helper. Nothing was created.',
    target.status === 'invalid'
      ? (target.reason ?? 'developmentBranch is invalid')
      : 'no developmentBranch is configured and the default branch is unavailable',
  );
}

/** B1 step 1: the primary is on the default branch, has no unpushed commits, and is fast-forwarded. */
function fastForwardPrimary(state: ApplyState): ApplyOutcome {
  const base = state.defaultBranch;
  const notReady = (detail: string): ApplyOutcome =>
    applyFail('primary-not-ready', PRIMARY_RETRY_NEXT, detail);
  const head = state.deps.run('git', [
    '-C',
    state.primary,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);
  if (head.status !== 0) {
    return notReady(
      `git rev-parse --abbrev-ref HEAD ended with ${describeStatus(head)}`,
    );
  }
  if (head.stdout.trim() !== base) {
    return notReady(
      `primary-not-on-default-branch (HEAD is ${head.stdout.trim() || 'empty'}, not ${base})`,
    );
  }
  const fetch = state.deps.run('git', ['-C', state.primary, 'fetch', 'origin']);
  if (fetch.status !== 0) {
    return notReady(`git fetch origin ended with ${describeStatus(fetch)}`);
  }
  const ahead = state.deps.run('git', [
    '-C',
    state.primary,
    'log',
    `origin/${base}..${base}`,
    '--oneline',
  ]);
  if (ahead.status !== 0) {
    return notReady(
      `git log origin/${base}..${base} ended with ${describeStatus(ahead)}`,
    );
  }
  if (ahead.stdout.trim() !== '') {
    return notReady(`unpushed-commits (${base} is ahead of origin/${base})`);
  }
  // autoStash off: a sibling session's uncommitted edit must never be stashed.
  const forward = state.deps.run('git', [
    '-C',
    state.primary,
    '-c',
    'merge.autoStash=false',
    'merge',
    '--ff-only',
    `origin/${base}`,
  ]);
  if (forward.status !== 0) {
    return notReady(
      `git merge --ff-only origin/${base} ended with ${describeStatus(forward)}`,
    );
  }
  return applyPass(`${base} is on origin/${base} (fast-forwarded)`);
}

/** B1 steps 2 and 3, read-only: a prunable entry or a leftover branch stops the run. */
function checkLeftovers(state: ApplyState): ApplyOutcome {
  const list = state.deps.run('git', [
    '-C',
    state.primary,
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]);
  if (list.status !== 0) {
    return applyFail(
      'primary-not-ready',
      PRIMARY_RETRY_NEXT,
      `git worktree list ended with ${describeStatus(list)}`,
    );
  }
  let records: LocalWorktreeRecord[];
  try {
    records = parseLocalWorktreeList(list.stdout);
  } catch (error) {
    return applyFail(
      'primary-not-ready',
      PRIMARY_RETRY_NEXT,
      `git worktree list is malformed: ${errorMessage(error)}`,
    );
  }
  const ref = `refs/heads/${state.branch}`;
  const prunable = records.find(
    (record) =>
      record.prunable &&
      (record.branchRef === ref || record.path === state.path),
  );
  if (prunable !== undefined) {
    return applyFail(
      'b1-cleanup-needed',
      CLEANUP_NEXT,
      `a prunable worktree entry is in the way: ${prunable.path}`,
    );
  }
  const refs = state.deps.run('git', [
    '-C',
    state.primary,
    'for-each-ref',
    '--format=%(refname)',
    ref,
  ]);
  if (refs.status !== 0) {
    return applyFail(
      'primary-not-ready',
      PRIMARY_RETRY_NEXT,
      `git for-each-ref ended with ${describeStatus(refs)}`,
    );
  }
  if (refs.stdout.split(/\r?\n/).some((line) => line.trim() === ref)) {
    return applyFail(
      'b1-cleanup-needed',
      CLEANUP_NEXT,
      `a leftover local branch ${state.branch} exists`,
    );
  }
  return applyPass(`no prunable entry and no leftover ${state.branch}`);
}

/** Whether a path exists, as a link included. `unknown` when it cannot be read. */
function entryState(path: string): 'absent' | 'present' | 'unknown' {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'absent'
      : 'unknown';
  }
}

/**
 * Why the computed worktree path cannot be used, or `null` when it is free. It
 * must be a direct child of the primary's parent, that parent must not be a
 * link, and nothing (a file, a directory, or a link) may already sit at it. The
 * helper never removes what it finds there.
 */
export function worktreePathProblem(
  primary: string,
  path: string,
): string | null {
  const parent = dirname(primary);
  if (dirname(path) !== parent || path === primary) {
    return `${path} is not a direct child of ${parent}`;
  }
  try {
    if (lstatSync(parent).isSymbolicLink()) {
      return `the parent ${parent} is a link`;
    }
  } catch (error) {
    return `the parent ${parent} could not be inspected: ${errorMessage(error)}`;
  }
  const entry = entryState(path);
  if (entry === 'unknown') {
    return `${path} could not be inspected`;
  }
  if (entry === 'present') {
    return `${path} already exists (a file, directory, or link)`;
  }
  return null;
}

function checkPathFree(state: ApplyState): ApplyOutcome {
  const problem = worktreePathProblem(state.primary, state.path);
  return problem === null
    ? applyPass(`${state.path} is free`)
    : applyFail('path-occupied', PATH_NEXT, problem);
}

/**
 * The fresh-claim row of B1 step 2: `git worktree add --no-track` from the
 * development branch. Mints the claim id and the nonce first, so the identity
 * exists for every later step. A failure removes nothing.
 */
function addWorktree(state: ApplyState): ApplyOutcome {
  const claimId = state.deps.mintClaimId();
  const nonce = state.deps.mintNonce();
  const add = state.deps.run('git', [
    '-C',
    state.primary,
    'worktree',
    'add',
    '--no-track',
    state.path,
    '-b',
    state.branch,
    `origin/${state.developmentBranch}`,
  ]);
  if (add.status !== 0) {
    return applyFail(
      'worktree-add-failed',
      'Inspect the path and the branch by hand, then rerun this helper. This helper removed nothing.',
      `git worktree add ended with ${describeStatus(add)}; the path ${
        entryState(state.path) === 'present' ? 'now exists' : 'does not exist'
      }`,
    );
  }
  state.worktreeCreated = true;
  state.identity = {
    agentId: state.input.agentId,
    claimId,
    nonce,
    branch: state.branch,
    worktree: state.path,
  };
  return applyPass(`worktree ${state.path} on ${state.branch}`);
}

/**
 * B1 step 1 and the worktree, under one hold of the clone-scoped lock. The
 * lock covers the fetch, the fast-forward, and `git worktree add`, and is
 * released before the claim steps, because `claim-lock --acquire` takes the
 * same mutex itself. The policy is read after the fast-forward, because the
 * fast-forward can replace `.github/idd/config.json` in the primary checkout.
 */
function runUnderCloneLock(state: ApplyState): ApplyFailure | null {
  let handle: CloneLockHandle;
  try {
    handle = state.deps.cloneLock.acquire(state.primary, state.input.agentId);
  } catch (error) {
    return step(
      state,
      'clone-lock',
      applyFail(
        'primary-not-ready',
        PRIMARY_RETRY_NEXT,
        `the clone lock was not acquired: ${errorMessage(error)}`,
      ),
    );
  }
  let failure: ApplyFailure | null = null;
  try {
    failure =
      step(state, 'primary-ready', fastForwardPrimary(state)) ??
      step(state, 'policy', readPolicy(state)) ??
      step(state, 'development-branch', resolveDevelopment(state)) ??
      step(state, 'b1-leftovers', checkLeftovers(state)) ??
      step(state, 'worktree-path', checkPathFree(state)) ??
      step(state, 'worktree-add', addWorktree(state));
  } finally {
    try {
      state.deps.cloneLock.release(handle);
    } catch (error) {
      failure ??= step(
        state,
        'clone-lock-release',
        applyFail(
          'primary-not-ready',
          'Inspect the clone lock file named in the detail by hand; remove it only when no other process holds it, then rerun this helper.',
          `the clone lock was not released: ${errorMessage(error)}`,
        ),
      );
    }
  }
  return failure;
}

/** `claim-lock --record-tokens`: the generated tokens, in the worktree's own copy. */
function recordTokens(state: ApplyState): ApplyOutcome {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const record = state.deps.run(process.execPath, [
    state.deps.childScript('claim-lock.mjs'),
    '--record-tokens',
    '--worktree',
    identity.worktree,
    '--agent-id',
    identity.agentId,
    '--claim-id',
    identity.claimId,
    '--nonce',
    identity.nonce,
  ]);
  if (record.status !== 0) {
    return applyFail(
      'tokens-record-failed',
      lostClaimNext(identity.claimId),
      `claim-lock --record-tokens ended with ${describeStatus(record)}`,
    );
  }
  return applyPass('generated tokens recorded in the worktree');
}

/** A5(c) again, with `--own-worktree`, so the new worktree does not read as an occupant. */
function checkOwnWorktreeGate(state: ApplyState): ApplyOutcome {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const reading = readFreshClaimGate(
    state.issue,
    ['--own-worktree', identity.worktree],
    state.deps,
  );
  if (!reading.ok) {
    return applyFail(
      'precheck-unavailable',
      lostClaimNext(identity.claimId),
      `the own-worktree gate: ${reading.detail}`,
    );
  }
  if (reading.verdict === 'claimable') {
    return applyPass('the own-worktree gate says claimable');
  }
  const reason: ClaimStopReason =
    reading.verdict === 'stale-reclaimable'
      ? 'stale-takeover-out-of-scope'
      : 'already-claimed';
  return applyFail(
    reason,
    lostClaimNext(identity.claimId),
    `the own-worktree gate returned ${reading.verdict} (${reading.reason})`,
    {
      gateReason: reading.reason,
      winningClaimId: reading.winningClaimId,
    },
  );
}

/**
 * A5(a) again, immediately before the claim marker (idd-claim.instructions.md
 * re-evaluates the approval immediately before claiming). An approval that was
 * revoked while B1 ran stops the run here, before anything is posted.
 */
function recheckApproval(state: ApplyState): ApplyOutcome {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const outcome = checkApproval(state.issue, state.deps);
  if (outcome.ok) {
    return applyPass(`A5(a) again: ${outcome.detail}`);
  }
  return applyFail(
    outcome.reason,
    lostClaimNext(identity.claimId),
    `A5(a) again, before the claim: ${outcome.detail}`,
  );
}

/** The first hold check, before the claim marker: a hold or an unreadable label stops the run. */
function checkHoldBeforeClaim(state: ApplyState): ApplyOutcome {
  const identity = state.identity;
  const next =
    identity === null
      ? 'Inspect the state by hand.'
      : lostClaimNext(identity.claimId);
  const hold = readHold(state);
  if (hold.kind === 'unavailable') {
    return applyFail(
      'precheck-unavailable',
      next,
      `the authoring hold read failed: ${hold.detail}`,
    );
  }
  if (hold.kind === 'held') {
    return applyFail(
      'hold-active',
      next,
      `the ${state.authoringLabel} label is on the issue`,
    );
  }
  return applyPass(`no ${state.authoringLabel} label (holdCheck: label)`);
}

/**
 * The claim marker. A failed write is `claimPosted: false` only when nothing
 * was sent; otherwise the comments are read, and the claim is never posted twice.
 */
function postClaim(state: ApplyState): ApplyOutcome {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const args = [
    '--type',
    'claim',
    '--target',
    'issue',
    String(state.issue),
    '--agent-id',
    identity.agentId,
    '--claim-id',
    identity.claimId,
    '--supersedes',
    'none',
    '--timestamp',
    timestampOf(state),
    '--branch',
    identity.branch,
  ];
  state.claimPosted = 'unknown';
  const posted = postMarker(state, args);
  if (posted.status === 0) {
    state.claimPosted = true;
    return applyPass(`claim marker posted for ${identity.claimId}`);
  }
  if (markerPostSentNothing(posted.stderr)) {
    state.claimPosted = false;
    return applyFail(
      'claim-post-failed',
      lostClaimNext(identity.claimId),
      `post-idd-marker sent nothing (${describeStatus(posted)})`,
    );
  }
  // The write may have landed: read the comments before anything else.
  state.deps.sleepMs(state.settleMs);
  const landed = findMarker(
    state,
    `<!-- claimed-by: ${identity.agentId} ${identity.claimId} `,
  );
  if (landed === 'present') {
    state.claimPosted = true;
    return applyPass(
      'the claim marker is on the issue after a write that did not report success',
    );
  }
  state.claimPosted = 'unknown';
  return applyFail(
    'recovery-hold',
    `Re-read the issue comments after claim.verifySettleDelay. If the claim marker for claim ${identity.claimId} has landed, continue by hand from the activation nonce (fresh-claim order, step 3). If it has not, run lost-claim-cleanup. The claim is never posted twice.`,
    `post-idd-marker ended with ${describeStatus(posted)}, and the claim marker is ${
      landed === 'absent' ? 'absent' : 'unreadable'
    }`,
    { lost: false },
  );
}

/** The activation nonce: one retry after the settle delay if the first write is not on the issue. */
function postNonce(state: ApplyState): ApplyOutcome {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const prefix = `<!-- activation-nonce: ${identity.agentId} ${identity.claimId} ${identity.nonce} `;
  const args = [
    '--type',
    'activation-nonce',
    '--target',
    'issue',
    String(state.issue),
    '--agent-id',
    identity.agentId,
    '--claim-id',
    identity.claimId,
    '--nonce',
    identity.nonce,
    '--timestamp',
    timestampOf(state),
  ];
  if (postMarker(state, args).status === 0) {
    return applyPass('activation nonce posted');
  }
  if (findMarker(state, prefix) === 'present') {
    return applyPass(
      'the activation nonce is on the issue after a write that did not report success',
    );
  }
  state.deps.sleepMs(state.settleMs);
  const retry = postMarker(state, args);
  if (retry.status === 0) {
    return applyPass('activation nonce posted on the retry');
  }
  if (findMarker(state, prefix) === 'present') {
    return applyPass('activation nonce is on the issue after the retry');
  }
  return applyFail(
    'nonce-post-failed',
    lostClaimNext(identity.claimId),
    `the activation nonce is absent after one retry (${describeStatus(retry)})`,
  );
}

/** `claim-lock --acquire` on the linked worktree (it takes the clone mutex itself). */
function acquireLock(state: ApplyState): ApplyOutcome {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const acquire = state.deps.run(process.execPath, [
    state.deps.childScript('claim-lock.mjs'),
    '--acquire',
    '--worktree',
    identity.worktree,
    '--agent-id',
    identity.agentId,
    '--claim-id',
    identity.claimId,
  ]);
  if (acquire.status !== 0) {
    return applyFail(
      'lock-acquire-failed',
      lostClaimNext(identity.claimId),
      `claim-lock --acquire ended with ${describeStatus(acquire)}`,
    );
  }
  return applyPass('worktree-local claim lock acquired');
}

/** The final assert, after the settle delay. Only `already_owned` with `keep` verifies the claim. */
function assertClaim(state: ApplyState): ApplyOutcome {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  state.deps.sleepMs(state.settleMs);
  const assert = state.deps.run(process.execPath, [
    state.deps.childScript('resume-claim-routing.mjs'),
    '--issue',
    String(state.issue),
    '--assert',
    '--claim-id',
    identity.claimId,
    '--nonce',
    identity.nonce,
    '--worktree',
    identity.worktree,
  ]);
  const verdict = assert.status === 0 ? parseJsonObject(assert.stdout) : null;
  if (
    verdict !== null &&
    verdict.state === 'already_owned' &&
    verdict.action === 'keep'
  ) {
    return applyPass('the final assert says already_owned / keep');
  }
  const reason =
    verdict !== null && typeof verdict.reason === 'string'
      ? verdict.reason
      : 'unreadable';
  const next =
    reason === 'activation-nonce-mismatch'
      ? `Never release this claim: the activation nonce winner is another session's, so do not post unclaimed-by. Run lost-claim-cleanup (idd-claim.instructions.md) for claim ${identity.claimId}.`
      : lostClaimNext(identity.claimId);
  return applyFail(
    'claim-not-verified',
    next,
    `resume-claim-routing --assert ended with ${describeStatus(assert)}: state ${
      verdict !== null && typeof verdict.state === 'string'
        ? verdict.state
        : 'unreadable'
    }, action ${
      verdict !== null && typeof verdict.action === 'string'
        ? verdict.action
        : 'unreadable'
    }, reason ${reason}`,
  );
}

/**
 * Claim verification step 5: a second label read. A hold (or an unreadable
 * label) contests the verified claim, so this run posts `unclaimed-by` for it
 * and verifies the post on the issue.
 */
function recheckHoldAfterVerify(state: ApplyState): ApplyOutcome {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const hold = readHold(state);
  if (hold.kind === 'clear') {
    return applyPass(
      `no ${state.authoringLabel} label after the verify (holdCheck: label)`,
    );
  }
  const cause =
    hold.kind === 'held'
      ? `the ${state.authoringLabel} label appeared`
      : `the label read failed (${hold.detail})`;
  postMarker(state, [
    '--type',
    'unclaim',
    '--target',
    'issue',
    String(state.issue),
    '--agent-id',
    identity.agentId,
    '--claim-id',
    identity.claimId,
    '--timestamp',
    timestampOf(state),
  ]);
  state.deps.sleepMs(state.settleMs);
  if (
    findMarker(
      state,
      `<!-- unclaimed-by: ${identity.agentId} ${identity.claimId} `,
    ) === 'present'
  ) {
    return applyFail(
      'released-after-hold',
      `Run lost-claim-cleanup (idd-claim.instructions.md) for claim ${identity.claimId}; the claim is already released.`,
      `${cause}; unclaimed-by for ${identity.claimId} was posted and verified`,
    );
  }
  return applyFail(
    'recovery-hold',
    `Post unclaimed-by for claim ${identity.claimId} by hand (post-idd-marker --type unclaim), verify it on the issue, then run lost-claim-cleanup.`,
    `${cause}; the release of ${identity.claimId} could not be verified`,
  );
}

/** Steps after the worktree lock is released: the claim, the nonce, the lock, the assert, and the second hold check. */
function runClaimWrites(state: ApplyState): ApplyFailure | null {
  return (
    step(state, 'record-tokens', recordTokens(state)) ??
    step(state, 'own-worktree-gate', checkOwnWorktreeGate(state)) ??
    step(state, 'hold-check', checkHoldBeforeClaim(state)) ??
    step(state, 'approval-recheck', recheckApproval(state)) ??
    step(state, 'claim-post', postClaim(state)) ??
    step(state, 'nonce-post', postNonce(state)) ??
    step(state, 'lock-acquire', acquireLock(state)) ??
    step(state, 'assert', assertClaim(state)) ??
    step(state, 'hold-recheck', recheckHoldAfterVerify(state))
  );
}

/**
 * The primary checkout and the default branch are read before the lock (the
 * default branch is what the fast-forward targets). The policy and the
 * development branch are read under the lock, after the fast-forward. Then
 * the locked worktree group, and the claim writes.
 */
function runFreshClaimOrder(state: ApplyState): ApplyFailure | null {
  const primary = step(state, 'primary-root', readPrimaryRoot(state));
  if (primary !== null) {
    return primary;
  }
  const defaultBranch = step(state, 'default-branch', readDefaultBranch(state));
  if (defaultBranch !== null) {
    return defaultBranch;
  }
  // The path is `<primary-parent>/<repo>.<normalized-branch>` (REPO_NAME is the repo part of the slug).
  state.path = join(
    dirname(state.primary),
    `${state.repository.repo}.${state.branch.replace(/\//g, '-')}`,
  );
  return runUnderCloneLock(state) ?? runClaimWrites(state);
}

function buildApplyReport(
  state: ApplyState,
  failure: ApplyFailure | null,
): ClaimApplyReport {
  return {
    issue: state.issue,
    eligible: failure === null,
    reason: failure === null ? null : failure.reason,
    branch: state.branch,
    projectStatusChecked: false,
    steps: state.steps,
    ...(failure?.gateReason === undefined
      ? {}
      : {
          gateReason: failure.gateReason,
          winningClaimId: failure.winningClaimId ?? null,
        }),
    mode: 'apply',
    projectStatus: state.input.projectStatus,
    holdCheck: 'label',
    claimPosted: state.claimPosted,
    lostClaimCleanupRequired:
      failure === null ? false : (failure.lost ?? state.worktreeCreated),
    nextAction:
      failure === null
        ? `Continue B1 from Step 3 (install dependencies) in ${state.path} (idd-claim.instructions.md, fresh-claim order step 6).`
        : failure.nextAction,
    claim: state.identity,
  };
}

/**
 * `--apply` for a run whose pre-checks all passed: the fresh-claim order of
 * idd-claim.instructions.md. Returns the report; it never throws. An
 * unexpected throw is a `precheck-unavailable` stop, with the cleanup flag set
 * once a worktree exists.
 */
export function runClaimApply(
  issueNumber: number,
  precheck: ClaimIssueReport,
  repository: { owner: string; repo: string },
  input: ClaimApplyInput,
  deps: ClaimIssueDeps,
): ClaimApplyReport {
  const state: ApplyState = {
    issue: issueNumber,
    repository,
    deps,
    input,
    branch: precheck.branch,
    steps: [...precheck.steps],
    primary: '',
    path: '',
    defaultBranch: '',
    developmentBranch: '',
    config: null,
    settleMs: 0,
    authoringLabel: '',
    trustedActors: [],
    worktreeCreated: false,
    identity: null,
    claimPosted: false,
  };
  let failure: ApplyFailure | null;
  try {
    failure = runFreshClaimOrder(state);
  } catch (error) {
    failure = {
      reason: 'precheck-unavailable',
      nextAction:
        state.identity === null
          ? 'Inspect the primary checkout and the worktree path by hand, then rerun this helper.'
          : lostClaimNext(state.identity.claimId),
      detail: `the apply run threw: ${errorMessage(error)}`,
    };
  }
  return buildApplyReport(state, failure);
}

/** The `--apply` report for a run whose pre-checks did not all pass: nothing written. */
export function precheckApplyReport(
  precheck: ClaimIssueReport,
  input: ClaimApplyInput,
): ClaimApplyReport {
  const failed = precheck.steps.find((entry) => entry.status === 'failed');
  return {
    ...precheck,
    mode: 'apply',
    projectStatus: input.projectStatus,
    holdCheck: 'label',
    claimPosted: false,
    lostClaimCleanupRequired: false,
    nextAction: failed?.nextAction ?? null,
    claim: null,
  };
}

/** Where a run writes. Tests capture it. */
export interface ClaimIssueIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function usage(message: string, io: ClaimIssueIo): HelperCliResult {
  io.stderr(`claim-issue: ${message}\n`);
  return { exitCode: 2, kind: 'usage', message };
}

/**
 * The whole command: parse `argv`, run the pre-checks, print the report.
 * Exit 0 means eligible. An ineligible result exits 1 as a `gate` outcome. A
 * failure before any check starts is `transport` (exit 1). An argument error is
 * `usage` (exit 2) and prints nothing on stdout.
 */
export function runClaimIssue(
  argv: readonly string[],
  deps: ClaimIssueDeps,
  io: ClaimIssueIo,
): HelperCliResult {
  let issueNumber: number | null;
  let apply = false;
  let agentId: string | undefined;
  let projectStatus: string | undefined;
  try {
    const { values, help } = parseCliArgs(argv, CLAIM_ISSUE_FLAG_SPEC);
    if (help) {
      io.stdout(helpText());
      return 0;
    }
    issueNumber = parseCanonicalIntegerOrNull(
      values.issue as string | undefined,
    );
    apply = values.apply === true;
    agentId = values['agent-id'] as string | undefined;
    projectStatus = values['project-status'] as string | undefined;
  } catch (error) {
    return usage(errorMessage(error), io);
  }
  if (issueNumber === null) {
    return usage('--issue is required and must be a positive integer', io);
  }
  if (agentId !== undefined && !AGENT_ID_PATTERN.test(agentId)) {
    return usage(
      '--agent-id must be one token with no whitespace and no <!-- or -->',
      io,
    );
  }
  if (
    projectStatus !== undefined &&
    !PROJECT_STATUS_VALUES.includes(projectStatus)
  ) {
    return usage('--project-status must be not-in-use or not-started', io);
  }
  let applyInput: ClaimApplyInput | null = null;
  if (apply) {
    const missing = [
      agentId === undefined ? '--agent-id' : null,
      projectStatus === undefined ? '--project-status' : null,
    ].filter((flag): flag is string => flag !== null);
    if (missing.length > 0) {
      return usage(`--apply requires ${missing.join(' and ')}`, io);
    }
    applyInput = {
      agentId: agentId as string,
      projectStatus: projectStatus as ClaimProjectStatus,
    };
  }
  const outcome = runClaimPrechecks(issueNumber, deps);
  if (outcome.kind === 'transport') {
    io.stderr(`claim-issue: ${outcome.message}\n`);
    return { exitCode: 1, kind: 'transport', message: outcome.message };
  }
  const { report } = outcome;
  if (applyInput === null) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    if (report.eligible) {
      return 0;
    }
    const failed = report.steps.find((step) => step.status === 'failed');
    const message = `issue ${issueNumber} is not eligible to claim: ${report.reason}${
      failed?.detail ? ` (${failed.detail})` : ''
    }`;
    io.stderr(`claim-issue: ${message}\n`);
    return { exitCode: 1, kind: 'gate', message };
  }
  let repository: { owner: string; repo: string };
  try {
    repository = deps.resolveRepository();
  } catch (error) {
    const message = `could not resolve the repository: ${errorMessage(error)}`;
    io.stderr(`claim-issue: ${message}\n`);
    return { exitCode: 1, kind: 'transport', message };
  }
  const applied = report.eligible
    ? runClaimApply(issueNumber, report, repository, applyInput, deps)
    : precheckApplyReport(report, applyInput);
  io.stdout(`${JSON.stringify(applied, null, 2)}\n`);
  if (applied.eligible) {
    return 0;
  }
  const failed = applied.steps.find((step) => step.status === 'failed');
  const message = `issue ${issueNumber} was not claimed: ${applied.reason}${
    failed?.detail ? ` (${failed.detail})` : ''
  }`;
  io.stderr(`claim-issue: ${message}\n`);
  return { exitCode: 1, kind: 'gate', message };
}

function runCli(): HelperCliResult {
  return runClaimIssue(process.argv.slice(2), createDefaultDeps(), {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}

function helpText(): string {
  return `Usage:
  node scripts/claim-issue.mjs --issue <number>
  node scripts/claim-issue.mjs --issue <number> --apply --agent-id <id> --project-status <not-in-use|not-started>

Dry run of the five A5 pre-checks of idd-claim.instructions.md for one issue.
Without --apply it makes no write: no marker, no worktree, no lock file, no
git change. --agent-id and --project-status are checked but not used without
--apply.

Checks, in order, stopping at the first one that is not eligible (later
checks are reported as not-run):

  A5(a)  issue-author approval, through claim-approval-gate
  A5(b)  the issue has no assignee (the project status is not checked)
  A5(c)  claim state, through the fresh-claim gate of resume-claim-routing
  A5(d)  no open pull request closes or references the issue (linked
         issues, and closing keywords in pull request bodies)
  A5(e)  no local worktree or remote branch on issue/<number>-*

A failed helper or gh call never reads as eligible: it is reported as
precheck-unavailable (approval-unproven for A5(a), local-worktree-unreadable
for the local scan) with the written path as the next action.

With --apply, when every pre-check passes, the helper runs the fresh-claim
order of idd-claim.instructions.md: B1 step 1 and the worktree (under the
clone-scoped lock), the generated tokens, the own-worktree gate, the
authoring-label hold check, the claim marker, the activation nonce,
the worktree-local claim lock, the final assert, and a second hold check. It mints the
claim id and the nonce itself. --agent-id is the agent id the claim is made
under. --project-status is your statement of the project status part of A5(b),
which the helper cannot read. Both are required with --apply. The hold check
reads the authoring label only; the owner-marker log replay is not done
(holdCheck is "label"). Stale-claim takeover is out of scope and stops the run.

The helper deletes nothing. Once the worktree exists, a failure keeps the
worktree, its branch, and the worktree-local claim lock; the report's
nextAction says what to run next (lost-claim-cleanup).

Output: one JSON report on stdout with issue, eligible, reason, branch,
projectStatusChecked (always false) and steps. With --apply it also has mode,
projectStatus, holdCheck, claimPosted (true, false, or "unknown"),
lostClaimCleanupRequired, nextAction, and claim (agentId, claimId, nonce,
branch, worktree) once the worktree exists. Exit 0 means eligible, or with
--apply that the claim is verified. An ineligible or stopped result exits 1
(gate). A failure to resolve the repository or to read the issue's title and
assignees exits 1 (transport) before any check runs. An argument error exits 2
(usage), including --apply without --agent-id or --project-status.
`;
}
