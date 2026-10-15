#!/usr/bin/env node
// idd-generated-from: src/scripts/claim-issue.mts
//
// The scripts/claim-issue.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Read-only dry run of the five A5 pre-checks in
// `.github/instructions/idd-claim.instructions.md` (issue-author approval,
// assignee, claim state, open pull requests, branch collision), run in that
// order and stopped at the first check that is not eligible. It makes no
// write: no marker, no worktree, no lock file, no git change. It calls
// existing code rather than re-implementing it: it spawns `claim-approval-gate`
// and `resume-claim-routing --fresh-claim-gate` as child processes, reuses
// `fetchOpenLinkedPrReferences` and the D3.5 body matcher of
// `findIssueRelatedOpenPrs`, takes the branch from `computeBranchName`, and
// scans local worktrees with `inspectLocalWorktreeBranchPrefix`. The write half
// of the claim is a separate change (issue 4373).
//
// Fail-closed contract: a pre-check helper or `gh` call that fails or returns
// malformed output never reads as eligible. It is `precheck-unavailable` with
// the written path as the next action (A5(a) has its own reason,
// `approval-unproven`, and the local worktree scan has
// `local-worktree-unreadable`). Only a failure before any check starts (the
// repository resolution and the read of the issue's title and assignees) is a
// `transport` error rather than a report.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { computeBranchName } from './branch-name.mts';
import { resolveBundleRoot } from './bundle-root.mts';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  inspectLocalWorktreeBranchPrefix,
  type LocalWorktreeInspection,
} from './local-worktree-occupancy.mts';
import { fetchOpenLinkedPrReferences } from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type {
  ProviderChangeRequestSummary,
  ProviderPort,
} from './provider-port.mts';
import { findIssueRelatedOpenPrs } from './resume-route-selection.mts';

const CLAIM_ISSUE_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

/** Longest a child helper may run before the call counts as failed. */
const CHILD_TIMEOUT_MS = 120_000;
const CHILD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const FRESH_CLAIM_VERDICTS: readonly string[] = [
  'claimable',
  'already-claimed',
  'stale-reclaimable',
];

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
  | 'branch-collision';

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

/** The one process seam: every `gh` call and both child helpers go through it. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
) => CommandResult;

/** The outside world one run reads. Tests inject all of it. */
export interface ClaimIssueDeps {
  run: CommandRunner;
  resolveRepository: () => { owner: string; repo: string };
  createPort: (owner: string, repo: string) => ProviderPort;
  inspectLocalWorktrees: (issueNumber: number) => LocalWorktreeInspection;
  /** The path of a sibling helper script, such as `claim-approval-gate.mjs`. */
  childScript: (name: string) => string;
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
  return (file, args) => {
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
    const result = spawnSync(file, [...args], {
      encoding: 'utf8',
      maxBuffer: CHILD_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
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
  };
}

/** Read the title and assignees with one `gh issue view`; `null` when malformed. */
function parseIssueRead(stdout: string): IssueRead | null {
  const parsed = parseJsonObject(stdout);
  if (parsed === null || typeof parsed.title !== 'string') {
    return null;
  }
  if (!Array.isArray(parsed.assignees)) {
    return null;
  }
  const assignees: string[] = [];
  for (const assignee of parsed.assignees) {
    if (!isRecord(assignee) || typeof assignee.login !== 'string') {
      return null;
    }
    assignees.push(assignee.login);
  }
  return { title: parsed.title, assignees };
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
    typeof evidence.approved !== 'boolean' ||
    typeof evidence.reason !== 'string' ||
    evidence.reason === '' ||
    typeof evidence.gateEnabled !== 'boolean' ||
    !isRecord(policy) ||
    typeof policy.maintainerApprovalActorPolicy !== 'string' ||
    !isRecord(policy.approvalSignals) ||
    typeof policy.approvalSignals.readyLabelName !== 'string' ||
    typeof policy.approvalSignals.labelFreshnessMode !== 'string' ||
    !Array.isArray(evidence.checks) ||
    evidence.checks.length === 0
  ) {
    return unproven('claim-approval-gate printed incomplete evidence');
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

/** A5(c): the fresh-claim gate of `resume-claim-routing`. */
function checkClaimState(
  issueNumber: number,
  deps: ClaimIssueDeps,
): CheckOutcome {
  const label = 'A5(c)';
  const result = deps.run(process.execPath, [
    deps.childScript('resume-claim-routing.mjs'),
    '--issue',
    String(issueNumber),
    '--fresh-claim-gate',
  ]);
  if (result.status !== 0) {
    return unavailable(
      label,
      `resume-claim-routing ended with ${describeStatus(result)}`,
    );
  }
  const routing = parseJsonObject(result.stdout);
  const gate = routing === null ? null : routing.fresh_claim_gate;
  if (
    routing === null ||
    !isRecord(gate) ||
    typeof gate.verdict !== 'string' ||
    !FRESH_CLAIM_VERDICTS.includes(gate.verdict)
  ) {
    return unavailable(
      label,
      'resume-claim-routing printed no valid fresh_claim_gate verdict',
    );
  }
  // Every verdict carries a top-level reason and a winning_claim_id (null when
  // there is no winner), so a truncated response cannot pass as claimable.
  const winningClaimId = gate.winning_claim_id;
  if (
    typeof routing.reason !== 'string' ||
    routing.reason === '' ||
    !Object.hasOwn(gate, 'winning_claim_id') ||
    (winningClaimId !== null && typeof winningClaimId !== 'string')
  ) {
    return unavailable(
      label,
      'resume-claim-routing printed a verdict without a reason or winning_claim_id',
    );
  }
  // The gate maps the routing state one to one onto these two verdicts.
  if (gate.verdict === 'claimable') {
    return routing.state === 'unclaimed'
      ? pass('claimable')
      : unavailable(
          label,
          'resume-claim-routing printed claimable for a state other than unclaimed',
        );
  }
  if (gate.verdict === 'stale-reclaimable') {
    if (routing.state !== 'stale') {
      return unavailable(
        label,
        'resume-claim-routing printed stale-reclaimable for a state other than stale',
      );
    }
    return stop(
      'stale-takeover-out-of-scope',
      'This helper checks a fresh claim only. Follow the stale-claim takeover path in idd-claim.instructions.md (A5(c)) by hand.',
      'the active claim is stale and reclaimable; takeover is out of scope',
    );
  }
  return stop(
    'already-claimed',
    'Do not claim: apply the already-claimed routing in idd-claim.instructions.md (A5(c)).',
    `the fresh-claim gate returned already-claimed (${routing.reason})`,
    { gateReason: routing.reason, winningClaimId },
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
        !entry.ref.startsWith('refs/heads/')
      ) {
        return null;
      }
      refs.push(entry.ref);
    }
  }
  return refs;
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
      `a local worktree holds ${prefix}*: ${local.paths.join(', ')}`,
    );
  }
  // Anything that is not a proven absence fails closed, so a malformed
  // inspector result cannot reach the remote scan as "absent".
  if (local.status !== 'absent') {
    return stop(
      'local-worktree-unreadable',
      collisionPath,
      `a local worktree could not be ruled out${
        local.reason ? ` (${local.reason})` : ''
      }${local.paths.length > 0 ? `: ${local.paths.join(', ')}` : ''}`,
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
  try {
    const { values, help } = parseCliArgs(argv, CLAIM_ISSUE_FLAG_SPEC);
    if (help) {
      io.stdout(helpText());
      return 0;
    }
    issueNumber = parseCanonicalIntegerOrNull(
      values.issue as string | undefined,
    );
  } catch (error) {
    return usage(errorMessage(error), io);
  }
  if (issueNumber === null) {
    return usage('--issue is required and must be a positive integer', io);
  }
  const outcome = runClaimPrechecks(issueNumber, deps);
  if (outcome.kind === 'transport') {
    io.stderr(`claim-issue: ${outcome.message}\n`);
    return { exitCode: 1, kind: 'transport', message: outcome.message };
  }
  const { report } = outcome;
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

Dry run of the five A5 pre-checks of idd-claim.instructions.md for one issue.
It makes no write: no marker, no worktree, no lock file, no git change. The
write half of the claim is a separate change, so any other flag is a usage
error.

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

Output: one JSON report on stdout with issue, eligible, reason, branch,
projectStatusChecked (always false) and steps. Exit 0 means eligible. An
ineligible result exits 1 (gate). A failure to resolve the repository or to
read the issue's title and assignees exits 1 (transport) before any check
runs. An argument error exits 2 (usage).
`;
}
