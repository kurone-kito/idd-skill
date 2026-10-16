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
// repository resolution and the read of the issue's title, assignees, and
// state) is a `transport` error rather than a report.
//
// The `issue-state` guard runs right after that read and before the first A5
// check. A closed issue (a `state` other than `OPEN`) is refused as
// `issue-closed` with one failed `issue-state` step, and the A5 checks are then
// `not-run`. An `OPEN` issue adds no step, so its report is unchanged.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { computeBranchName } from './branch-name.mjs';
import { resolveBundleRoot } from './bundle-root.mjs';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mjs';
import { acquireCloneLock, releaseCloneLock } from './clone-lock.mjs';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadLayeredLocalPolicy } from './idd-config.mjs';
import {
  inspectLocalWorktreeBranchPrefix,
  parseLocalWorktreeList,
  sanitizedGitEnvironment,
} from './local-worktree-occupancy.mjs';
import {
  inspectDevelopmentBranch,
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveEffectiveDevelopmentBranch,
} from './policy-helpers.mjs';
import {
  fetchOpenLinkedPrReferences,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  fetchLastEditedAtByNodeId,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';
import { markerPostSentNothing } from './publish-authoring-hold.mjs';
import { findIssueRelatedOpenPrs } from './resume-route-selection.mjs';

const CLAIM_ISSUE_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--agent-id': { type: 'string' },
  '--project-status': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
/** Longest a child helper may run before the call counts as failed. */
const CHILD_TIMEOUT_MS = 120_000;
/** Longest a git command may run; a fetch on a slow network needs more. */
const GIT_TIMEOUT_MS = 300_000;
const CHILD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** The project-status values `--project-status` accepts (A5(b)). */
const PROJECT_STATUS_VALUES = ['not-in-use', 'not-started'];
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
/** The timestamp shape the marker grammar prints (second precision, UTC). */
const MARKER_TIMESTAMP = '(?<ts>\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)';
/**
 * What may follow a marker token and nothing more: the one italic IDD note line,
 * or nothing. Anything else after the token makes the comment not a marker
 * (the grammar anchors the whole body).
 */
const MARKER_NOTE_SUFFIX = '(?:\\r?\\n\\r?\\n_[^\\n]*\\bIDD\\b[^\\n]*_)?\\s*$';
/** The next action when the issue is not OPEN (the issue-state guard). */
const CLOSED_NEXT =
  'The issue is closed, so it cannot be claimed. Do not claim it. If a maintainer reopens it, rerun this helper; otherwise choose an open issue. This helper created nothing.';
/** The next action when the policy or the viewer cannot be read (nothing claimed yet). */
const POLICY_NEXT =
  'Fix the policy (the repository config or the user-global policy) or restore access to the viewer login, then rerun this helper. This helper created no worktree or branch.';
const FRESH_CLAIM_VERDICTS = [
  'claimable',
  'already-claimed',
  'stale-reclaimable',
];
/**
 * What the fresh-claim gate pairs with each routing state it can emit: the
 * verdict and the routing action. Anything else is a malformed response.
 */
const ROUTING_PAIRS = {
  unclaimed: { verdict: 'claimable', action: 're_claim' },
  stale: { verdict: 'stale-reclaimable', action: 'takeover' },
  non_inheritable: { verdict: 'already-claimed', action: 'stop' },
  disputed: { verdict: 'already-claimed', action: 'stop' },
  local_worktree_occupied: { verdict: 'already-claimed', action: 'stop' },
};
/** The reasons `claim-approval-gate` pairs with `approved: false`. */
const REFUSED_REASONS = [
  'approval-missing',
  'approval-ambiguous',
  'approval-comment-stale',
  'freshness-undetermined',
];
/** The reasons `claim-approval-gate` pairs with `approved: true`. */
const APPROVED_REASONS = [
  'author-self-authorized',
  'ready-label-present',
  'ready-comment-fresh',
  'gate-disabled',
];
/** The check that must pass for each approved reason (`null`: none). */
const APPROVED_REASON_CHECKS = {
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
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function describeStatus(result) {
  return result.status === null
    ? 'no exit status (timeout, signal, or spawn failure)'
    : `exit code ${result.status}`;
}
function pass(detail) {
  return { ok: true, detail };
}
function stop(reason, nextAction, detail, extra = {}) {
  return { ok: false, reason, nextAction, detail, ...extra };
}
function writtenPath(label) {
  return `Use the written path of check ${label} in idd-claim.instructions.md.`;
}
function unavailable(label, detail) {
  return stop('precheck-unavailable', writtenPath(label), detail);
}
function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** The default process seam: `gh` through gh-exec, children through spawnSync. */
export function createDefaultRunner() {
  return (file, args, options) => {
    if (file === 'gh') {
      try {
        return {
          status: 0,
          stdout: ghText([...args], GH_TEXT_LOOP_TIMEOUT_OPTIONS),
          stderr: '',
        };
      } catch (error) {
        const status = error.status;
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
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
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
function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}
/** The real dependencies: gh, the sibling scripts, and the current clone. */
export function createDefaultDeps() {
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
/**
 * Read the title, assignees, and state with one `gh issue view`; `null` when
 * malformed. A state other than `OPEN` or `CLOSED` is malformed too.
 */
function parseIssueRead(stdout) {
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
  const assignees = [];
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
  const state = parsed.state;
  if (state !== 'OPEN' && state !== 'CLOSED') {
    return null;
  }
  return { title: parsed.title, assignees, state };
}
/** True when a child helper's `issue` block names the issue it was asked about. */
function describesIssue(value, issueNumber) {
  return isRecord(value) && value.number === issueNumber;
}
/** A non-empty list of checks, each with a string `id`, `name`, and `result`. */
function isCheckList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (check) =>
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
function approvalEvidenceAgrees(evidence) {
  const checks = evidence.checks;
  const resultOf = (id) => checks.find((check) => check.id === id)?.result;
  const gateEnabled = evidence.gateEnabled === true;
  if (gateEnabled !== (evidence.reason !== 'gate-disabled')) {
    return false;
  }
  const policy = evidence.policy;
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
function checkApproval(issueNumber, deps, cwd) {
  const unproven = (detail) =>
    stop(
      'approval-unproven',
      'Apply the written A5(a) path in idd-claim.instructions.md by hand; if it cannot prove safe approval, treat approval as missing.',
      detail,
    );
  // The gate reads the policy of its working directory, so the write half runs
  // it from the primary checkout, after the fast-forward has refreshed it.
  const result = deps.run(
    process.execPath,
    [
      deps.childScript('claim-approval-gate.mjs'),
      '--issue',
      String(issueNumber),
    ],
    cwd === undefined ? undefined : { cwd },
  );
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
function checkAssignee(issue) {
  if (issue.assignees.length > 0) {
    return stop(
      'assigned',
      'Do not claim: the issue already has an assignee (A5(b)).',
      `assigned to ${issue.assignees.join(', ')}`,
    );
  }
  return pass('no assignee (the project status is not checked)');
}
/**
 * Run `resume-claim-routing --fresh-claim-gate` (with `extra` arguments, such
 * as `--own-worktree <path>` for the gate after the worktree exists) and read
 * its verdict. A malformed or inconsistent answer is `ok: false`, never a
 * verdict, so no caller can read it as claimable.
 */
function readFreshClaimGate(issueNumber, extra, deps, cwd) {
  const result = deps.run(
    process.execPath,
    [
      deps.childScript('resume-claim-routing.mjs'),
      '--issue',
      String(issueNumber),
      '--fresh-claim-gate',
      ...extra,
    ],
    cwd === undefined ? undefined : { cwd },
  );
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
    winningClaimId: winningClaimId === null ? null : winningClaimId,
  };
}
/** A5(c): the fresh-claim gate of `resume-claim-routing`. */
function checkClaimState(issueNumber, deps) {
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
function requireWellFormedRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('the open pull request list is not an array');
  }
  for (const row of rows) {
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
  return rows;
}
/** The port with `listOpenChangeRequests` checked row by row. */
function withWellFormedOpenRows(port) {
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
function checkOpenPullRequests(issueNumber, repository, deps) {
  const port = withWellFormedOpenRows(
    deps.createPort(repository.owner, repository.repo),
  );
  const found = new Set();
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
      `open pull request ${numbers.join(', ')} closes or references this issue${lookupFailed ? ' (the lookup was also incomplete)' : ''}`,
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
function parseMatchingRefs(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return null;
  }
  const refs = [];
  for (const line of lines) {
    let page;
    try {
      page = JSON.parse(line);
    } catch {
      return null;
    }
    if (!Array.isArray(page)) {
      return null;
    }
    for (const entry of page) {
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
function describePaths(paths) {
  return Array.isArray(paths) && paths.length > 0
    ? `: ${paths.map(String).join(', ')}`
    : '';
}
/** A5(e): the local worktree scan, then the scoped remote branch scan. */
function checkBranchCollision(issueNumber, repository, deps) {
  const prefix = `issue/${issueNumber}-`;
  let local;
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
 * Run the issue-state guard and the five A5 pre-checks for one issue, read-only.
 * Resolves the repository and reads the issue's title, assignees, and state
 * first; a failure there is a `transport` outcome. A closed issue is refused
 * next as `issue-closed`, with one failed `issue-state` step and the A5 checks
 * `not-run`. Otherwise it runs A5(a) to A5(e) in order, stops at the first
 * check that is not eligible, and marks the rest `not-run`.
 */
export function runClaimPrechecks(issueNumber, deps) {
  let repository;
  try {
    repository = deps.resolveRepository();
  } catch (error) {
    return {
      kind: 'transport',
      message: `could not resolve the repository: ${errorMessage(error)}`,
    };
  }
  let issue = null;
  let readFailure = '';
  try {
    const read = deps.run('gh', [
      'issue',
      'view',
      String(issueNumber),
      '--json',
      'title,assignees,state',
    ]);
    if (read.status !== 0) {
      readFailure = `gh issue view ended with ${describeStatus(read)}`;
    } else {
      issue = parseIssueRead(read.stdout);
      if (issue === null) {
        readFailure =
          'gh issue view printed no valid title, assignees, and state';
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
  const checks = [
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
  const steps = [];
  let report = { reason: null };
  let stopped = false;
  // The issue-state guard runs before the first A5 check. It adds its own step
  // only when it refuses, so an OPEN issue keeps the A5 steps as they were.
  if (readIssue.state !== 'OPEN') {
    steps.push({
      id: 'issue-state',
      status: 'failed',
      reason: 'issue-closed',
      nextAction: CLOSED_NEXT,
      detail: `the issue state is ${readIssue.state}, not OPEN`,
    });
    stopped = true;
    report = { reason: 'issue-closed' };
  }
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
    let outcome;
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
    repository,
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
/** The next action once a claim may be held by this session (lost-claim cleanup). */
function lostClaimNext(claimId) {
  return `Run lost-claim-cleanup (idd-claim.instructions.md) for claim ${claimId}. If it stops with this claim still active, post unclaimed-by for it (never for an activation-nonce mismatch) and run lost-claim-cleanup again.`;
}
function applyFail(reason, nextAction, detail, extra = {}) {
  return { ok: false, failure: { reason, nextAction, detail, ...extra } };
}
function applyPass(detail) {
  return { ok: true, detail };
}
/** Record one step's outcome in the report. Returns its failure, or `null`. */
function step(state, id, outcome) {
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
function timestampOf(state) {
  // Second precision, as the claim grammar prints it (`...T..:..:..Z`).
  return state.deps
    .now()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}
/** Run `post-idd-marker --apply` with the error envelope requested. */
function postMarker(state, args) {
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
    {
      cwd: state.primary,
      env: { ...process.env, IDD_HELPER_ERROR_ENVELOPE: '1' },
    },
  );
}
/** Parse a `gh issue view --json labels` answer; `null` when malformed. */
function parseLabelNames(stdout) {
  const parsed = parseJsonObject(stdout);
  if (parsed === null || !Array.isArray(parsed.labels)) {
    return null;
  }
  const names = [];
  for (const label of parsed.labels) {
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
function readHold(state) {
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
  // GitHub label names are case-insensitive, so the comparison is too (the same
  // rule as publish-authoring-hold's hasLabel).
  return labels.some(
    (name) => name.toLowerCase() === state.authoringLabel.toLowerCase(),
  )
    ? { kind: 'held' }
    : { kind: 'clear' };
}
/** The comments of the issue, every page; `null` when any page is malformed. */
function parseCommentPages(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return null;
  }
  const comments = [];
  for (const line of lines) {
    let page;
    try {
      page = JSON.parse(line);
    } catch {
      return null;
    }
    if (!Array.isArray(page)) {
      return null;
    }
    for (const entry of page) {
      if (
        !isRecord(entry) ||
        typeof entry.login !== 'string' ||
        typeof entry.body !== 'string' ||
        typeof entry.nodeId !== 'string' ||
        entry.nodeId === ''
      ) {
        return null;
      }
      comments.push({
        login: entry.login,
        body: entry.body,
        nodeId: entry.nodeId,
      });
    }
  }
  return comments;
}
/** Escape text for use inside a regular expression. */
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * A timestamp that is a real UTC instant in the marker grammar's own form. The
 * round trip through Date rejects a shape that names no such time, such as a
 * month of 99 or a February 30.
 */
function isRealTimestamp(text) {
  const date = new Date(text);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().replace(/\.000Z$/, 'Z') === text
  );
}
/**
 * Whether a trusted comment carries the complete marker token `pattern` at the
 * first byte of its body. A comment that only starts with the same words but
 * whose token is malformed is not a marker. `unknown` when the read itself
 * fails, so a caller can never take an unreadable issue for an absent marker.
 *
 * The claim-family edit-state contract (docs/idd-helper-scripts.md) covers
 * every direct reader: a marker is authority only with an explicit GraphQL
 * `lastEditedAt: null`. REST rows carry no edit state, so the matching trusted
 * comments are resolved through GraphQL here. An edited marker is ignored, and
 * an edit state that cannot be resolved is `unknown`, never an unedited marker.
 */
function findMarker(state, pattern) {
  const { owner, repo } = state.repository;
  const read = state.deps.run('gh', [
    'api',
    `repos/${owner}/${repo}/issues/${state.issue}/comments`,
    '--paginate',
    '--jq',
    '[.[] | {login: .user.login, body: .body, nodeId: .node_id}] | tojson',
  ]);
  if (read.status !== 0) {
    return 'unknown';
  }
  const comments = parseCommentPages(read.stdout);
  if (comments === null) {
    return 'unknown';
  }
  const candidates = comments.filter((comment) => {
    if (!state.trustedActors.includes(comment.login.toLowerCase())) {
      return false;
    }
    const match = pattern.exec(comment.body);
    if (match === null) {
      return false;
    }
    // The timestamp must be a real instant, not only the grammar's digit shape.
    const stamp = match.groups?.ts;
    return stamp === undefined || isRealTimestamp(stamp);
  });
  if (candidates.length === 0) {
    return 'absent';
  }
  let editStates;
  try {
    editStates = fetchLastEditedAtByNodeId(
      ghTextThroughRunner(state),
      candidates.map((comment) => comment.nodeId),
    );
  } catch {
    return 'unknown';
  }
  let unedited = false;
  for (const candidate of candidates) {
    if (!editStates.has(candidate.nodeId)) {
      return 'unknown';
    }
    if (editStates.get(candidate.nodeId) === null) {
      unedited = true;
    }
  }
  return unedited ? 'present' : 'absent';
}
/**
 * The `gh` text reader that `fetchLastEditedAtByNodeId` takes, run through this
 * helper's own runner, so that every call is one the runner sees.
 */
function ghTextThroughRunner(state) {
  return (args) => {
    const result = state.deps.run('gh', args);
    if (result.status !== 0) {
      throw new Error(
        `gh ${args.slice(0, 2).join(' ')} ended with ${describeStatus(result)}`,
      );
    }
    return result.stdout;
  };
}
/** The primary checkout: the main worktree, the first record of the listing. */
function readPrimaryRoot(state) {
  const list = state.deps.run('git', ['worktree', 'list', '--porcelain', '-z']);
  if (list.status !== 0) {
    return applyFail(
      'primary-not-ready',
      PRIMARY_RETRY_NEXT,
      `git worktree list ended with ${describeStatus(list)}`,
    );
  }
  let records;
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
  // git prints forward slashes on Windows; resolve to the platform's own form so
  // the direct-child check compares like with like.
  state.primary = resolve(main.path);
  return applyPass(`primary checkout ${main.path}`);
}
/**
 * The layered effective policy of the primary checkout, read after the
 * fast-forward: the loader resume-claim-routing uses, run with the primary as
 * its directory so that the user-global and the repository layers both apply.
 * The trusted marker actors are the configured list (through the env and
 * config ladder) plus this session's own login, which posts every marker this
 * run writes.
 */
function readPolicy(state) {
  let config;
  try {
    const loaded = loadLayeredLocalPolicy({ cwd: state.primary });
    if (loaded.local.diagnostic !== undefined) {
      return applyFail(
        'precheck-unavailable',
        POLICY_NEXT,
        `the policy could not be read: ${loaded.local.diagnostic}`,
      );
    }
    config = loaded.config;
    normalizePolicyConfig(config);
  } catch (error) {
    return applyFail(
      'precheck-unavailable',
      POLICY_NEXT,
      `the policy could not be read: ${errorMessage(error)}`,
    );
  }
  const viewer = readViewerLogin(state);
  if (viewer === null) {
    return applyFail(
      'precheck-unavailable',
      POLICY_NEXT,
      'the viewer login could not be read, so this run cannot recognize the markers it posts',
    );
  }
  const normalized = normalizePolicyConfig(config);
  const configured = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config: isRecord(config)
      ? { trustedMarkerActors: config.trustedMarkerActors }
      : null,
  }).actors;
  state.config = config;
  state.settleMs =
    parseIsoDurationToMs(normalized.claim.verifySettleDelay) ?? 0;
  state.authoringLabel = normalized.issueAuthoring.authoringLabelName;
  state.trustedActors = [...new Set([...configured, viewer.toLowerCase()])];
  return applyPass(`effective policy of ${state.primary}; viewer ${viewer}`);
}
/** The login of the account this session writes as; `null` when it cannot be read. */
function readViewerLogin(state) {
  const read = state.deps.run('gh', ['api', 'user', '--jq', '.login']);
  const login = read.stdout.trim();
  return read.status === 0 && login !== '' && !/\s/.test(login) ? login : null;
}
/** The default branch from GitHub, validated the way a development branch is. */
function readDefaultBranch(state) {
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
function resolveDevelopment(state) {
  const target = resolveEffectiveDevelopmentBranch(
    state.config,
    state.defaultBranch,
  );
  if (
    (target.status === 'configured' || target.status === 'default') &&
    target.branch !== undefined
  ) {
    // The branch must exist on origin itself. A plain fetch keeps the remote-
    // tracking ref of a branch deleted remotely, so the local ref proves nothing.
    const live = state.deps.run('git', [
      '-C',
      state.primary,
      'ls-remote',
      '--heads',
      'origin',
      target.branch,
    ]);
    const listed = live.stdout
      .split(/\r?\n/)
      .some((line) => line.trim().endsWith(`\trefs/heads/${target.branch}`));
    if (live.status !== 0 || !listed) {
      return applyFail(
        'development-branch-unresolved',
        'Create the development branch on origin, or fix developmentBranch in .github/idd/config.json, then rerun this helper. Nothing was created.',
        live.status !== 0
          ? `git ls-remote ended with ${describeStatus(live)}`
          : `origin has no branch ${target.branch}`,
      );
    }
    // A plain fetch only refreshes the refs the clone's refspec maps, so the
    // development branch is fetched into its own remote-tracking ref explicitly.
    // The worktree is based on that ref, so it must hold the live tip.
    const refresh = state.deps.run('git', [
      '-C',
      state.primary,
      'fetch',
      'origin',
      `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`,
    ]);
    if (refresh.status !== 0) {
      return applyFail(
        'development-branch-unresolved',
        'Fetch the development branch from origin by hand, or fix developmentBranch in .github/idd/config.json, then rerun this helper. Nothing was created.',
        `git fetch of origin/${target.branch} ended with ${describeStatus(refresh)}`,
      );
    }
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
function fastForwardPrimary(state) {
  const base = state.defaultBranch;
  const notReady = (detail) =>
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
  // A plain fetch refreshes only the refs the clone's refspec maps. The default
  // branch is fetched into its own tracking ref, so the ahead check, the
  // fast-forward, and the policy read see its live tip.
  const tip = state.deps.run('git', [
    '-C',
    state.primary,
    'fetch',
    'origin',
    `+refs/heads/${base}:refs/remotes/origin/${base}`,
  ]);
  if (tip.status !== 0) {
    return notReady(
      `git fetch of origin/${base} ended with ${describeStatus(tip)}`,
    );
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
function checkLeftovers(state) {
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
  let records;
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
function entryState(path) {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    return error.code === 'ENOENT' ? 'absent' : 'unknown';
  }
}
/**
 * Why the computed worktree path cannot be used, or `null` when it is free. It
 * must be a direct child of the primary's parent, that parent must not be a
 * link, and nothing (a file, a directory, or a link) may already sit at it. The
 * helper never removes what it finds there.
 */
export function worktreePathProblem(primary, path) {
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
function checkPathFree(state) {
  const problem = worktreePathProblem(state.primary, state.path);
  return problem === null
    ? applyPass(`${state.path} is free`)
    : applyFail('path-occupied', PATH_NEXT, problem);
}
/** Whether the claim's branch exists after a failed add: the report's own words. */
function branchLeftBehind(state) {
  const ref = `refs/heads/${state.branch}`;
  const refs = state.deps.run('git', [
    '-C',
    state.primary,
    'for-each-ref',
    '--format=%(refname)',
    ref,
  ]);
  if (refs.status !== 0) {
    return 'could not be read';
  }
  return refs.stdout.split(/\r?\n/).some((line) => line.trim() === ref)
    ? 'exists'
    : 'does not exist';
}
/**
 * The fresh-claim row of B1 step 2: `git worktree add --no-track` from the
 * development branch. Mints the claim id and the nonce first, so the identity
 * exists for every later step. A failure removes nothing.
 */
function addWorktree(state) {
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
      // A failed add is not atomic: it can leave the path, the worktree entry,
      // or the branch behind. The report names each of them, so the next step
      // inspects the real state.
      `git worktree add ended with ${describeStatus(add)}; the path ${entryState(state.path) === 'present' ? 'now exists' : 'does not exist'}, and the branch ${branchLeftBehind(state)}`,
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
function runUnderCloneLock(state) {
  let handle;
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
  let failure = null;
  try {
    failure =
      step(state, 'primary-ready', fastForwardPrimary(state)) ??
      step(state, 'policy', readPolicy(state)) ??
      step(state, 'development-branch', resolveDevelopment(state)) ??
      step(state, 'b1-leftovers', checkLeftovers(state)) ??
      step(state, 'local-rescan', rescanLocalWorktrees(state)) ??
      step(state, 'remote-rescan', rescanRemoteBranches(state)) ??
      step(state, 'worktree-path', checkPathFree(state)) ??
      step(state, 'worktree-add', addWorktree(state));
  } finally {
    try {
      state.deps.cloneLock.release(handle);
    } catch (error) {
      // A lock left behind blocks every later run, so this failure is the one
      // the report names; an earlier stop is kept as context.
      const earlier =
        failure === null
          ? ''
          : `; the earlier stop was ${failure.reason} (${failure.detail})`;
      failure = step(
        state,
        'clone-lock-release',
        applyFail(
          'primary-not-ready',
          'Inspect the clone lock file named in the detail by hand; remove it only when no other process holds it, then rerun this helper.',
          `the clone lock was not released: ${errorMessage(error)}${earlier}`,
        ),
      );
    }
  }
  return failure;
}
/**
 * The scoped local-worktree scan of A5(e), run again under the lock before any
 * worktree exists. A worktree that another session created since the pre-check
 * is an occupant, whatever its slug, so the same rule as the pre-check applies.
 */
function rescanLocalWorktrees(state) {
  const nextAction =
    'Follow the A5(e) collision action tree in idd-claim.instructions.md by hand; this helper created nothing.';
  let local;
  try {
    local = state.deps.inspectLocalWorktrees(state.issue);
  } catch (error) {
    local = { status: 'unreadable', paths: [], reason: errorMessage(error) };
  }
  if (local.status === 'occupied') {
    return applyFail(
      'local-worktree-occupied',
      nextAction,
      `a local worktree holds issue/${state.issue}-*${describePaths(local.paths)} after the pre-check`,
    );
  }
  if (
    local.status !== 'absent' ||
    !Array.isArray(local.paths) ||
    local.paths.length > 0 ||
    local.reason !== null
  ) {
    return applyFail(
      'local-worktree-unreadable',
      nextAction,
      'a local worktree could not be ruled out after the pre-check',
    );
  }
  return applyPass(
    `no local worktree matches issue/${state.issue}-* after the fetch`,
  );
}
/**
 * The scoped remote-branch scan of A5(e), run again under the lock after the
 * fetch and before any worktree exists: a branch that another clone pushed
 * since the pre-check is a collision, not a branch to build on.
 */
function rescanRemoteBranches(state) {
  const { owner, repo } = state.repository;
  const prefix = `issue/${state.issue}-`;
  const remote = state.deps.run('gh', [
    'api',
    `repos/${owner}/${repo}/git/matching-refs/heads/${prefix}`,
    '--paginate',
    '--jq',
    'tojson',
  ]);
  if (remote.status !== 0) {
    return applyFail(
      'precheck-unavailable',
      'Re-run the A5(e) remote branch scan by hand (idd-claim.instructions.md), then rerun this helper. Nothing was created.',
      `the remote branch rescan ended with ${describeStatus(remote)}`,
    );
  }
  const refs = parseMatchingRefs(remote.stdout);
  if (refs === null) {
    return applyFail(
      'precheck-unavailable',
      'Re-run the A5(e) remote branch scan by hand (idd-claim.instructions.md), then rerun this helper. Nothing was created.',
      'the remote branch rescan printed a malformed matching-refs response',
    );
  }
  const collisions = refs
    .filter((ref) => ref.startsWith(`refs/heads/${prefix}`))
    .map((ref) => ref.slice('refs/heads/'.length));
  if (collisions.length > 0) {
    return applyFail(
      'branch-collision',
      'Post the A5(e) hold note from idd-claim.instructions.md and stop for operator review; this helper does not post it.',
      `remote branch ${collisions.join(', ')} appeared after the pre-check`,
    );
  }
  return applyPass(`no remote branch matches ${prefix}* after the fetch`);
}
/**
 * `claim-lock --record-tokens`: the generated tokens, in the worktree's own
 * copy. The call before the claim carries no nonce (fresh-claim order, step 2
 * of idd-claim.instructions.md). The nonce-bearing calls come right before the
 * activation-nonce marker posts, and again at the acquire point. The child runs
 * with the worktree as its cwd, because claim-lock asks each caller to resolve
 * this evidence from its own cwd (the scope of the ownership proof).
 */
function recordTokens(state, withNonce) {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const record = state.deps.run(
    process.execPath,
    [
      state.deps.childScript('claim-lock.mjs'),
      '--record-tokens',
      '--worktree',
      identity.worktree,
      '--agent-id',
      identity.agentId,
      '--claim-id',
      identity.claimId,
      ...(withNonce ? ['--nonce', identity.nonce] : []),
    ],
    { cwd: identity.worktree },
  );
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
function checkOwnWorktreeGate(state) {
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
    state.primary,
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
  const reason =
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
function recheckApproval(state) {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const outcome = checkApproval(state.issue, state.deps, state.primary);
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
function checkHoldBeforeClaim(state) {
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
function postClaim(state) {
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
    new RegExp(
      `^<!-- claimed-by: ${escapeForRegExp(identity.agentId)} ${escapeForRegExp(identity.claimId)} supersedes: none ${MARKER_TIMESTAMP} branch: ${escapeForRegExp(identity.branch)} -->${MARKER_NOTE_SUFFIX}`,
    ),
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
    `post-idd-marker ended with ${describeStatus(posted)}, and the claim marker is ${landed === 'absent' ? 'absent' : 'unreadable'}`,
    { lost: false },
  );
}
/** The activation nonce: one retry after the settle delay if the first write is not on the issue. */
function postNonce(state) {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const prefix = new RegExp(
    `^<!-- activation-nonce: ${escapeForRegExp(identity.agentId)} ${escapeForRegExp(identity.claimId)} ${escapeForRegExp(identity.nonce)} ${MARKER_TIMESTAMP} -->${MARKER_NOTE_SUFFIX}`,
  );
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
  // A retry is allowed only when the comments prove the marker absent. An
  // unreadable comment list is `unknown`, which stops here: a second write could
  // duplicate a marker that already landed.
  const unreadable = (detail) =>
    applyFail(
      'recovery-hold',
      `Re-read the issue comments after claim.verifySettleDelay. If the activation nonce ${identity.nonce} for claim ${identity.claimId} is on the issue, continue by hand from the assert; if it is not, run lost-claim-cleanup. This helper did not retry the nonce write.`,
      detail,
      { lost: false },
    );
  if (postMarker(state, args).status === 0) {
    return applyPass('activation nonce posted');
  }
  // The write may have landed without being visible yet: wait the settle delay
  // before the first read, as the claim path does, so that "absent" means
  // something before a retry.
  state.deps.sleepMs(state.settleMs);
  const first = findMarker(state, prefix);
  if (first === 'present') {
    return applyPass(
      'the activation nonce is on the issue after a write that did not report success',
    );
  }
  if (first === 'unknown') {
    return unreadable(
      'the nonce write did not report success and the comments cannot be read, so absence is not proven',
    );
  }
  // Absence was proven just above: retry at once, so no other write can land
  // between that read and this retry.
  const retry = postMarker(state, args);
  if (retry.status === 0) {
    return applyPass('activation nonce posted on the retry');
  }
  // An ambiguous retry may become visible after a moment: settle before the read.
  state.deps.sleepMs(state.settleMs);
  const second = findMarker(state, prefix);
  if (second === 'present') {
    return applyPass('activation nonce is on the issue after the retry');
  }
  if (second === 'unknown') {
    return unreadable(
      'the retry did not report success and the comments cannot be read, so absence is not proven',
    );
  }
  return applyFail(
    'nonce-post-failed',
    lostClaimNext(identity.claimId),
    `the activation nonce is absent after one retry (${describeStatus(retry)})`,
  );
}
/**
 * `claim-lock --acquire` on the linked worktree (it takes the clone mutex
 * itself), then the generated-tokens record read back. Acquire alone is not
 * ownership evidence: the record must read back as this claim's own, present
 * and well-formed, as idd-claim.instructions.md requires. The same check runs
 * again before any release; `reason` and `next` say how that stop is reported.
 */
function acquireWithTokens(state, reason, next) {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const acquire = state.deps.run(
    process.execPath,
    [
      state.deps.childScript('claim-lock.mjs'),
      '--acquire',
      '--worktree',
      identity.worktree,
      '--agent-id',
      identity.agentId,
      '--claim-id',
      identity.claimId,
    ],
    { cwd: identity.worktree },
  );
  if (acquire.status !== 0) {
    return applyFail(
      reason,
      next,
      `claim-lock --acquire ended with ${describeStatus(acquire)}`,
    );
  }
  const tokens = state.deps.run(
    process.execPath,
    [
      state.deps.childScript('claim-lock.mjs'),
      '--read-tokens',
      '--worktree',
      identity.worktree,
      '--claim-id',
      identity.claimId,
    ],
    { cwd: identity.worktree },
  );
  const record = parseJsonObject(tokens.stdout);
  if (
    tokens.status !== 0 ||
    record === null ||
    record.present !== true ||
    record.malformed === true
  ) {
    return applyFail(
      reason,
      next,
      `the generated-tokens record does not read back as present for ${identity.claimId}`,
    );
  }
  return applyPass(
    'worktree-local claim lock acquired; generated tokens read back',
  );
}
/** The claim's own acquire, before the final assert. */
function acquireLock(state) {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  return acquireWithTokens(
    state,
    'lock-acquire-failed',
    lostClaimNext(identity.claimId),
  );
}
/** The final assert, after the settle delay. Only `already_owned` with `keep` verifies the claim. */
function assertClaim(state) {
  state.deps.sleepMs(state.settleMs);
  return checkFinalAssert(state);
}
/**
 * `resume-claim-routing --assert` for this claim, without the settle wait. Only
 * `already_owned` with `keep` verifies the claim; the verdict is read on every
 * exit. Used after the settle delay, and again before any release.
 */
function checkFinalAssert(state) {
  const identity = state.identity;
  if (identity === null) {
    return applyFail(
      'precheck-unavailable',
      'Inspect the state by hand, then rerun this helper.',
      'no worktree identity exists',
    );
  }
  const assert = state.deps.run(
    process.execPath,
    [
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
    ],
    { cwd: state.primary },
  );
  // The helper prints its verdict on every exit; the status only says whether
  // the claim is verified, so the JSON is read either way.
  const verdict = parseJsonObject(assert.stdout);
  if (
    assert.status === 0 &&
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
function recheckHoldAfterVerify(state) {
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
  // Before any release is posted, this session checks the claim again: the
  // worktree lock is acquired and its tokens read back, and the claim is
  // asserted, the way idd-claim.instructions.md asks before each later
  // pre-mutation step. Any stop posts nothing.
  const holdStop =
    'Do not post unclaimed-by: this session no longer verifies the claim. Run lost-claim-cleanup (idd-claim.instructions.md) by hand; it keeps everything when another claim holds the lock.';
  const relock = acquireWithTokens(state, 'recovery-hold', holdStop);
  if (!relock.ok) {
    return applyFail(
      'recovery-hold',
      holdStop,
      `${cause}; ${relock.failure.detail}`,
    );
  }
  const reassert = checkFinalAssert(state);
  if (!reassert.ok) {
    return applyFail(
      'recovery-hold',
      holdStop,
      `${cause}; before the release the claim did not verify again: ${reassert.failure.detail}`,
    );
  }
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
      new RegExp(
        `^<!-- unclaimed-by: ${escapeForRegExp(identity.agentId)} ${escapeForRegExp(identity.claimId)} ${MARKER_TIMESTAMP} -->${MARKER_NOTE_SUFFIX}`,
      ),
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
function runClaimWrites(state) {
  return (
    // idd-claim.instructions.md, fresh-claim order, step 2: the record before the
    // claim carries no nonce, because the nonce is minted for the claim itself.
    step(state, 'record-tokens', recordTokens(state, false)) ??
    // The approval first, then the hold: the label read is the last gate before
    // the claim marker (idd-claim.instructions.md, "Immediately before claim POST").
    step(state, 'approval-recheck', recheckApproval(state)) ??
    // The claim-state gate and the label read come last, so that the fresh
    // marker fetch and the hold read are the nearest reads before the claim.
    step(state, 'own-worktree-gate', checkOwnWorktreeGate(state)) ??
    step(state, 'hold-check', checkHoldBeforeClaim(state)) ??
    step(state, 'claim-post', postClaim(state)) ??
    // The nonce-bearing record comes right before its marker posts (the
    // record contract in claim-lock.mts: "again with the nonce right before the
    // activation-nonce marker posts").
    step(state, 'nonce-record', recordTokens(state, true)) ??
    step(state, 'nonce-post', postNonce(state)) ??
    // idd-claim.instructions.md (worktree-local lock file): the tokens are
    // recorded again, with the nonce, at the acquire point, before the acquire.
    step(state, 'lock-record', recordTokens(state, true)) ??
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
function runFreshClaimOrder(state) {
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
function buildApplyReport(state, failure) {
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
export function runClaimApply(issueNumber, precheck, repository, input, deps) {
  const state = {
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
  let failure;
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
export function precheckApplyReport(precheck, input) {
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
function usage(message, io) {
  io.stderr(`claim-issue: ${message}\n`);
  return { exitCode: 2, kind: 'usage', message };
}
/**
 * The whole command: parse `argv`, run the pre-checks, print the report.
 * Exit 0 means eligible. An ineligible result exits 1 as a `gate` outcome. A
 * failure before any check starts is `transport` (exit 1). An argument error is
 * `usage` (exit 2) and prints nothing on stdout.
 */
export function runClaimIssue(argv, deps, io) {
  let issueNumber;
  let apply = false;
  let agentId;
  let projectStatus;
  try {
    const { values, help } = parseCliArgs(argv, CLAIM_ISSUE_FLAG_SPEC);
    if (help) {
      io.stdout(helpText());
      return 0;
    }
    issueNumber = parseCanonicalIntegerOrNull(values.issue);
    apply = values.apply === true;
    agentId = values['agent-id'];
    projectStatus = values['project-status'];
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
  let applyInput = null;
  if (apply) {
    const missing = [
      agentId === undefined ? '--agent-id' : null,
      projectStatus === undefined ? '--project-status' : null,
    ].filter((flag) => flag !== null);
    if (missing.length > 0) {
      return usage(`--apply requires ${missing.join(' and ')}`, io);
    }
    applyInput = {
      agentId: agentId,
      projectStatus: projectStatus,
    };
    // gh honors GH_REPO and would name another repository than the clone whose
    // worktree this run creates, so the write half refuses to run with it set.
    if (process.env.GH_REPO) {
      return usage(
        '--apply refuses to run with GH_REPO set, because gh would name a repository other than this clone; unset GH_REPO',
        io,
      );
    }
  }
  const outcome = runClaimPrechecks(issueNumber, deps);
  if (outcome.kind === 'transport') {
    io.stderr(`claim-issue: ${outcome.message}\n`);
    return { exitCode: 1, kind: 'transport', message: outcome.message };
  }
  const { report, repository } = outcome;
  if (applyInput === null) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    if (report.eligible) {
      return 0;
    }
    const failed = report.steps.find((step) => step.status === 'failed');
    const message = `issue ${issueNumber} is not eligible to claim: ${report.reason}${failed?.detail ? ` (${failed.detail})` : ''}`;
    io.stderr(`claim-issue: ${message}\n`);
    return { exitCode: 1, kind: 'gate', message };
  }
  const applied = report.eligible
    ? runClaimApply(issueNumber, report, repository, applyInput, deps)
    : precheckApplyReport(report, applyInput);
  io.stdout(`${JSON.stringify(applied, null, 2)}\n`);
  if (applied.eligible) {
    return 0;
  }
  // The last failed step is the one the report names: a failed release comes
  // after the stop that preceded it.
  const failed = applied.steps
    .filter((step) => step.status === 'failed')
    .at(-1);
  const message = `issue ${issueNumber} was not claimed: ${applied.reason}${failed?.detail ? ` (${failed.detail})` : ''}`;
  io.stderr(`claim-issue: ${message}\n`);
  return { exitCode: 1, kind: 'gate', message };
}
function runCli() {
  return runClaimIssue(process.argv.slice(2), createDefaultDeps(), {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}
function helpText() {
  return `Usage:
  node scripts/claim-issue.mjs --issue <number>
  node scripts/claim-issue.mjs --issue <number> --apply --agent-id <id> --project-status <not-in-use|not-started>

Dry run of the five A5 pre-checks of idd-claim.instructions.md for one issue.
Without --apply it makes no write: no marker, no worktree, no lock file, no
git change. --agent-id and --project-status are checked but not used without
--apply.

Before the checks, the issue-state guard reads the issue's state. A closed
issue stops the run as issue-closed (the issue-state step), and no A5 check
runs. An OPEN issue adds no step.

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
(gate). A failure to resolve the repository or to read the issue's title,
assignees, and state exits 1 (transport) before any check runs. An argument
error exits 2 (usage), including --apply without --agent-id or --project-status.
`;
}
