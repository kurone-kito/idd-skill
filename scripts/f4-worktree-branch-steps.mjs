// idd-generated-from: src/scripts/f4-worktree-branch-steps.mts
//
// The scripts/f4-worktree-branch-steps.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// F4 steps 4 to 6 (idd-merge.instructions.md), gated on the F4 head proof
// (docs/idd-resume-detail.md#f4-head-proof). The flow runs in this order:
// the no-follow path check, a claim check, the proof dry run, step 4 (the
// primary fast-forward), step 5 (preserve a lone ignored node_modules/ tree
// in a private per-user state destination, then remove the worktree and local
// branch), a second claim check, and step
// 6 (the remote branch). Each hold has a reason code and a next action. The
// flow never passes `--force`, never posts a proof, and writes only through
// the injected deps.
//
// This module performs no I/O. Every git call, filesystem probe, spawned
// helper, `gh` read, clone lock, and remote deletion arrives through
// {@link F4WorktreeBranchDeps}, so the flow runs against fakes in tests. The
// production wiring lives in f4-worktree-branch-cleanup.mts.
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { parseLocalWorktreeList } from './local-worktree-occupancy.mjs';

const PLAN_ORDER = [
  'path-check',
  'claim-check (before-step-4)',
  'proof-check',
  'step-4',
  'step-5',
  'claim-check (before-step-6)',
  'step-6',
];
/** The step each PLAN_ORDER entry belongs to, index for index. */
const PLAN_STEP_NAMES = [
  'path-check',
  'claim-check',
  'proof-check',
  'step-4',
  'step-5',
  'claim-check',
  'step-6',
];
const DECIDE_BEFORE_POST_HOLDS = [
  'claim-or-lock',
  'pr-state',
  'ref-read',
  'marker-read-failed',
  'branch-absent',
  'conflicting-marker',
  'watermark-unauthenticated',
  'claim-activation-unknown',
];
const FULL_SHA = /^[0-9a-f]{40}$/;
/**
 * The next action for each hold code the flow owns. The remote-delete codes
 * are not listed: their next action is the detail that delete-remote-branch
 * itself reports, as its own documentation directs.
 */
export const NEXT_ACTIONS = {
  'claim-lost':
    'Stop. The claim is not this session, or it could not be confirmed. Take no further mutation and report the handoff. Do not unclaim.',
  'owner-evidence-required':
    'Stop. The claim ID matches, but the independent owner evidence (the claim lock, the generated tokens, and the branch) does not. Restore the claimed worktree lock, or the operator decides.',
  'claim-or-lock':
    'Stop. The claim or its worktree lock is not this session. Take no further mutation and report the handoff.',
  'pr-state':
    'Do not post. The merged pull request could not be read or does not agree with itself. Read it again, then rerun this helper.',
  'ref-read':
    'Do not post. The local branch ref could not be read. Check the repository state, then rerun.',
  'marker-read-failed':
    'Do not post. The trusted markers of the issue could not be read. Rerun once the read succeeds.',
  'branch-absent':
    'The local branch ref is absent, and no trusted proof can stand without it. The operator checks the branch. Do not recreate it or guess its tip, and report.',
  'conflicting-marker':
    'Hold. A trusted proof for this claim conflicts with the live state or with another proof. The operator reviews the markers on the claimed issue. Do not post another proof.',
  'watermark-unauthenticated':
    'Hold. The review watermark for this claim cannot be authenticated. Rerun F4 step 2 after the review snapshot is recorded again.',
  'claim-activation-unknown':
    'Hold. The activation time of this claim cannot be read. The operator checks the claim record on the issue.',
  'proof-missing':
    'No trusted proof exists yet. If cleanup had candidates, rerun F4 step 3, whose gate posts the proof. Otherwise run the profile-selected post-idd-marker --type f4-head-proof command (see docs/idd-helper-scripts.md) with --target issue <issue-number>, --claim-id <claim-id>, --agent-id <agent-id>, and --worktree <issue-worktree-path> as a dry run, then add --apply on a post verdict, and rerun this helper.',
  'proof-unreadable':
    'Hold. The output of the marker dry run could not be read as a verdict. Rerun the dry run and inspect its stderr. Do not proceed.',
  'proof-worktree-missing':
    'Hold. The claimed worktree is no longer registered, so the proof dry run cannot read the proof. This run removed nothing. If step 5 already removed the worktree, the operator completes step 6 by hand with delete-remote-branch and the expected SHA when delete_branch_on_merge is false, and the session continues from step 7 after the operator confirms. Otherwise restore the worktree registration and rerun the removal helper.',
  'symlink-path':
    'Hold. A path in the worktree or above it is a symlink, or a tracked entry resolves outside the worktree. Nothing ran in that path. The operator inspects the symlink, then fixes or removes it.',
  'fetch-failed':
    'Hold. git fetch origin failed, and nothing changed. Check the network and the remote, then rerun.',
  'lock-busy':
    'Hold. Another session holds the clone-scoped lock. Rerun after it is released.',
  'base-ref-unreadable':
    'Hold. The base branch of the pull request could not be read as a valid branch name. Rerun. If it persists, the operator checks the pull request.',
  'primary-worktree-dirty':
    'Hold. Local changes in the primary worktree block the fast-forward. The operator cleans those paths (never stash or discard them), then reruns steps 4 to 6.',
  'primary-ignored-overwrite':
    'Hold. An ignored file in the primary worktree would be overwritten by the fast-forward. The operator moves that file outside the repository, then reruns steps 4 to 6.',
  'development-branch-in-use':
    'Hold. The development branch is checked out in another worktree, which the path in the detail names. Do not touch that worktree. The operator frees the branch, then reruns.',
  'development-branch-diverged':
    'Hold. The development branch cannot fast-forward to origin. Do not reset or rebase. The operator reconciles it.',
  'primary-update-failed':
    'Hold. The primary worktree update failed for a reason this helper does not classify. Nothing was removed. The operator inspects the primary worktree. Do not reset or stash.',
  'inconsistent-worktree-state':
    'Hold. The worktree path, its git registration, and the claim branch disagree, or git could not read them. Nothing was removed. The operator checks git worktree list and the claim.',
  'dirty-worktree':
    'Hold. The worktree holds untracked, modified, or ignored files. Nothing was removed. The helper moves only a lone ignored node_modules/ directory; when the detail says it did not move node_modules/, the F4 session preserves that directory by hand too. Preserve all other content outside the worktree, including reproducible configured-command output, then rerun.',
  'submodule-worktree':
    'Hold. The worktree holds a populated submodule. Nothing was removed. The F4 session preserves that content outside the worktree by hand. The operator then runs git -C <issue-worktree-path> submodule deinit --all with the worktree still registered, and the helper is rerun.',
  'branch-tip-mismatch':
    'Hold. The local branch tip does not equal the proof branch tip, or the ref is missing while its worktree exists. Nothing was removed. The operator checks the branch state.',
  'local-branch-unmerged-commits':
    'Hold. git branch -d refused, and the local tip is not the proof head. The operator comments on the issue and makes a fresh claim check before any forced deletion; keep any node_modules/ destination named in the detail.',
  'worktree-remove-refused':
    'Failed. git worktree remove refused after the checks passed, so the worktree may be partly changed. The operator inspects it and keeps any node_modules/ destination named in the detail. A rerun reads the proof again and posts nothing.',
  'delete-setting-unreadable':
    'Hold at step 6. delete_branch_on_merge could not be read as a boolean, and nothing remote was deleted. In a dry run nothing has changed, so rerun it once the setting is readable. In an applied run, steps 4 and 5 have already run. The operator first confirms by hand that delete_branch_on_merge is false: when it is true, step 6 is skipped, because GitHub deletes the branch on merge. Only when it is false does the operator complete step 6 by hand with delete-remote-branch and the expected SHA, and the session continues from step 7 after the operator confirms. Do not rerun an applied run.',
  'remote-delete-unreadable':
    'Hold at step 6. The output of the remote branch helper could not be read, and nothing remote was deleted. In a dry run nothing has changed, so rerun it. In an applied run, steps 4 and 5 have already run. The operator first confirms by hand that delete_branch_on_merge is false: when it is true, step 6 is skipped, because GitHub deletes the branch on merge. Only when it is false does the operator complete step 6 by hand with delete-remote-branch and the expected SHA, after reading its output, and the session continues from step 7 after the operator confirms. Do not rerun an applied run.',
};
/** True when `target` is `root` or lies inside it, with no `..` escape. */
export function isWithinRoot(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}
/** Every ancestor of `target` from the filesystem root down to `target`. */
export function ancestorChain(target) {
  const chain = [];
  let current = resolve(target);
  for (;;) {
    chain.unshift(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return chain;
}
/**
 * Parse the output of `git ls-files -z`, one NUL-terminated path per entry.
 * Empty fields are dropped.
 */
export function parseNulList(output) {
  return output.split('\0').filter((entry) => entry.length > 0);
}
/**
 * Classify the output of `resume-claim-routing --assert`. Only an
 * `already_owned` verdict with the `claim-id-match` reason, for this claim
 * and this agent, proceeds. `owner_evidence_required` is its own code. Any
 * other state, and any output that does not parse, is `claim-lost`.
 */
export function classifyClaimAssert(raw, claimId, agentId) {
  let parsed;
  try {
    parsed = JSON.parse(raw.stdout);
  } catch {
    return { ok: false, code: 'claim-lost' };
  }
  const routing = parsed;
  if (routing.state === 'owner_evidence_required') {
    return { ok: false, code: 'owner-evidence-required' };
  }
  const active = routing.active_claim;
  if (
    raw.exitCode === 0 &&
    routing.state === 'already_owned' &&
    routing.action === 'keep' &&
    routing.reason === 'claim-id-match' &&
    routing.claim_id_checked === claimId &&
    active?.claim_id === claimId &&
    active?.agent_id === agentId &&
    typeof active?.branch === 'string'
  ) {
    return { ok: true, branch: active.branch };
  }
  return { ok: false, code: 'claim-lost' };
}
/**
 * Classify the marker command's dry-run envelope. `proceed` must carry the
 * full proof values for this claim and reason `reusable`. `post` means no
 * proof exists yet. `hold` and `stop` keep their own reason code when it is
 * one the dry run can return. Anything else is unreadable.
 */
export function classifyProofEnvelope(raw, claimId) {
  const firstStderrLine = (raw.stderr ?? '').trim().split('\n')[0] || null;
  // The dry run refuses an unregistered worktree on stderr, with no stdout.
  if (
    raw.stdout.trim() === '' &&
    /registers for this repository/u.test(raw.stderr ?? '')
  ) {
    return {
      ok: false,
      code: 'proof-worktree-missing',
      detail: firstStderrLine,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.stdout);
  } catch {
    return { ok: false, code: 'proof-unreadable', detail: firstStderrLine };
  }
  const envelope = parsed;
  if (envelope.verdict === 'post') {
    return { ok: false, code: 'proof-missing' };
  }
  if (envelope.verdict === 'proceed') {
    // The marker contract exits 0 for proceed. Any other status is untrusted.
    if (raw.exitCode !== 0) {
      return { ok: false, code: 'proof-unreadable', detail: firstStderrLine };
    }
    const proof = envelope.proof;
    if (
      envelope.reason !== 'reusable' ||
      typeof proof?.pr !== 'number' ||
      proof.claim !== claimId ||
      typeof proof.branch !== 'string' ||
      typeof proof.branchTip !== 'string' ||
      typeof proof.merge !== 'string' ||
      typeof proof.head !== 'string' ||
      !FULL_SHA.test(proof.branchTip) ||
      !FULL_SHA.test(proof.merge) ||
      !FULL_SHA.test(proof.head)
    ) {
      return { ok: false, code: 'proof-unreadable' };
    }
    return {
      ok: true,
      values: {
        pr: proof.pr,
        claim: proof.claim,
        branch: proof.branch,
        branchTip: proof.branchTip,
        merge: proof.merge,
        head: proof.head,
      },
    };
  }
  if (
    (envelope.verdict === 'hold' || envelope.verdict === 'stop') &&
    typeof envelope.reason === 'string' &&
    DECIDE_BEFORE_POST_HOLDS.includes(envelope.reason)
  ) {
    return {
      ok: false,
      code: envelope.reason,
    };
  }
  return { ok: false, code: 'proof-unreadable' };
}
/** Classify a refused `git merge --ff-only` or `git switch` by its output. */
export function classifyPrimaryRefusal(text) {
  if (text.includes('Not possible to fast-forward')) {
    return { code: 'development-branch-diverged' };
  }
  if (text.includes('Your local changes to the following files')) {
    return { code: 'primary-worktree-dirty' };
  }
  return null;
}
/** The paths git names after an untracked-overwrite refusal. */
export function parseOverwrittenPaths(text) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) =>
    line.includes('untracked working tree files would be overwritten'),
  );
  if (start < 0) {
    return [];
  }
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) {
      break;
    }
    const path = line.slice(1).trim();
    if (path.length > 0) {
      paths.push(path);
    }
  }
  return paths;
}
function stepRecord(step, status, extras = {}) {
  return {
    step,
    phase: extras.phase ?? null,
    status,
    reason: extras.reason ?? null,
    nextAction: extras.nextAction ?? null,
    detail: extras.detail ?? null,
  };
}
/** The next action for a hold, from the catalog or the remote helper. */
function nextActionFor(hold) {
  if (hold.code in NEXT_ACTIONS) {
    return NEXT_ACTIONS[hold.code];
  }
  return (
    hold.detail ??
    'Hold. Follow the delete-remote-branch documentation for this action.'
  );
}
/**
 * Run F4 steps 4 to 6 in order, stopping at the first hold or failure. An
 * exception from a dependency is not thrown: it becomes a failed report that
 * names the step it interrupted and the steps not yet run.
 */
export function runF4WorktreeBranchSteps(input, deps) {
  const steps = [];
  try {
    return runPlan(input, deps, steps);
  } catch (error) {
    const completed = Math.max(-1, ...steps.map(planIndexOf));
    const failing = Math.min(completed + 1, PLAN_STEP_NAMES.length - 1);
    const failedStep = PLAN_STEP_NAMES[failing];
    const detail = error instanceof Error ? error.message : String(error);
    steps.push(
      stepRecord(failedStep, 'failed', {
        reason: 'failed',
        nextAction:
          'Failed. Inspect the state named in the detail. Nothing else ran, and a rerun reads the proof again and posts nothing.',
        detail,
      }),
    );
    return {
      protocolVersion: '1',
      issueNumber: input.issueNumber,
      mode: input.apply ? 'apply' : 'dry-run',
      status: 'failed',
      steps,
      reason: 'failed',
      nextAction: detail,
      failedStep,
      notRunSteps: PLAN_ORDER.slice(failing + 1),
    };
  }
}
/** The plan index that a completed step record stands for. */
function planIndexOf(entry) {
  switch (entry.step) {
    case 'path-check':
      return 0;
    case 'claim-check':
      return entry.phase === 'before-step-6' ? 5 : 1;
    case 'proof-check':
      return 2;
    case 'step-4':
      return 3;
    case 'step-5':
      return 4;
    case 'step-6':
      return 6;
  }
}
/**
 * Run F4 steps 4 to 6 in order, stopping at the first hold or failure. In a
 * dry run (`apply` false) the proof check, the step 5 inspection, and the
 * step 6 dry run run, and nothing mutates: step 4 and the removals report
 * `would-run`.
 */
function runPlan(input, deps, steps) {
  const mode = input.apply ? 'apply' : 'dry-run';
  const primary = input.primaryRoot;
  const worktree = resolve(input.worktree);
  const finish = (status, failedAt, stop) => {
    const failedIndex = failedAt?.index ?? -1;
    return {
      protocolVersion: '1',
      issueNumber: input.issueNumber,
      mode,
      status,
      steps,
      reason: stop?.reason ?? null,
      nextAction: stop?.nextAction ?? null,
      failedStep: status === 'failed' ? (failedAt?.step ?? null) : null,
      notRunSteps:
        status === 'complete' || status === 'dry-run'
          ? []
          : PLAN_ORDER.slice(failedIndex + 1),
    };
  };
  const holdAt = (index, step, phase, hold) => {
    const action = nextActionFor(hold);
    steps.push(
      stepRecord(step, 'held', {
        phase,
        reason: hold.code,
        nextAction: action,
        detail: hold.detail,
      }),
    );
    return finish(
      'hold',
      { index, step },
      {
        reason: hold.code,
        nextAction: action,
      },
    );
  };
  const failAt = (index, step, phase, error) => {
    const code = error.code ?? null;
    const nextAction =
      code !== null
        ? NEXT_ACTIONS[code]
        : 'Failed. Inspect the state named in the detail. Nothing else ran, and a rerun reads the proof again and posts nothing.';
    steps.push(
      stepRecord(step, 'failed', {
        phase,
        reason: code ?? 'failed',
        nextAction,
        detail: error.detail,
      }),
    );
    return finish(
      'failed',
      { index, step },
      {
        reason: code ?? 'failed',
        nextAction: code !== null ? nextAction : error.detail,
      },
    );
  };
  // 0. No-follow check of the worktree path and each ancestor. Nothing else
  // touches the path before this passes.
  if (worktree === resolve(primary)) {
    return holdAt(0, 'path-check', null, {
      code: 'inconsistent-worktree-state',
      detail:
        'the worktree path is the primary worktree; the primary is never removed',
    });
  }
  const pathLinks = ancestorChain(worktree).find(
    (path) => deps.lstat(path) === 'symlink',
  );
  if (pathLinks !== undefined) {
    return holdAt(0, 'path-check', null, {
      code: 'symlink-path',
      detail: `a symlink at ${pathLinks} is on the worktree path`,
    });
  }
  steps.push(stepRecord('path-check', 'passed'));
  // 1. Claim check before step 4.
  const claimPre = classifyClaimAssert(
    deps.assertClaim(worktree),
    input.claimId,
    input.agentId,
  );
  if (!claimPre.ok) {
    return holdAt(1, 'claim-check', 'before-step-4', {
      code: claimPre.code,
      detail: null,
    });
  }
  steps.push(stepRecord('claim-check', 'passed', { phase: 'before-step-4' }));
  const branch = claimPre.branch;
  const branchRef = `refs/heads/${branch}`;
  if (deps.git(['check-ref-format', branchRef], primary).status !== 0) {
    return holdAt(1, 'claim-check', 'before-step-4', {
      code: 'inconsistent-worktree-state',
      detail: `the claim branch ${branch} is not a valid branch name`,
    });
  }
  // 2. The proof dry run. The helper never passes `--apply` to it.
  const proofCheck = classifyProofEnvelope(deps.proofDryRun(), input.claimId);
  if (!proofCheck.ok) {
    return holdAt(2, 'proof-check', null, {
      code: proofCheck.code,
      detail: proofCheck.detail ?? null,
    });
  }
  const proof = proofCheck.values;
  if (proof.branch !== branch) {
    return holdAt(2, 'proof-check', null, {
      code: 'conflicting-marker',
      detail: `the proof names branch ${proof.branch}, but the claim names ${branch}`,
    });
  }
  steps.push(stepRecord('proof-check', 'passed', { reason: 'reusable' }));
  // 3. Steps 4 and 5 run under the clone-scoped lock in apply mode. A dry
  // run reads the same state without taking the lock.
  const runSteps45 = () => {
    return runStep4And5(
      input,
      deps,
      primary,
      worktree,
      branch,
      branchRef,
      proof,
      steps,
      input.apply,
    );
  };
  let outcome;
  if (input.apply) {
    const locked = deps.withCloneLock(runSteps45);
    if (!locked.acquired) {
      return holdAt(3, 'step-4', null, {
        code: 'lock-busy',
        detail: 'the clone-scoped lock is held by another session',
      });
    }
    outcome = locked.value;
  } else {
    outcome = runSteps45();
  }
  if (outcome.error !== null) {
    return failAt(
      outcome.at === 'step-4' ? 3 : 4,
      outcome.at,
      null,
      outcome.error,
    );
  }
  if (outcome.hold !== null) {
    return holdAt(
      outcome.at === 'step-4' ? 3 : 4,
      outcome.at,
      null,
      outcome.hold,
    );
  }
  // 4. Claim check before step 6.
  const claimPost = classifyClaimAssert(
    deps.assertClaim(worktree),
    input.claimId,
    input.agentId,
  );
  if (!claimPost.ok) {
    return holdAt(5, 'claim-check', 'before-step-6', {
      code: claimPost.code,
      detail: null,
    });
  }
  steps.push(stepRecord('claim-check', 'passed', { phase: 'before-step-6' }));
  // 5. Step 6: the remote branch.
  return runStep6(input, deps, proof, branch, steps, finish, holdAt, failAt);
}
/**
 * Steps 4 and 5. In a dry run, step 4 reports `would-run` and step 5 runs the
 * read-only inspection; in apply mode both mutate. Returns the hold or error
 * that stopped the run, or no hold when both steps finish.
 */
function runStep4And5(
  input,
  deps,
  primary,
  worktree,
  branch,
  branchRef,
  proof,
  steps,
  apply,
) {
  // Step 4, primary fast-forward.
  if (!apply) {
    const target = readDevelopmentTarget(deps, primary, proof.pr);
    if (target.base === null) {
      return { hold: target.hold, error: null, at: 'step-4' };
    }
    steps.push(
      stepRecord('step-4', 'would-run', {
        detail: `fetch, then fast-forward ${target.base} from origin`,
      }),
    );
  } else {
    // The claim may have changed while the lock was waited for, so it is
    // checked again under the lock, before the first mutation.
    const claimLocked = classifyClaimAssert(
      deps.assertClaim(worktree),
      input.claimId,
      input.agentId,
    );
    if (!claimLocked.ok) {
      return {
        hold: {
          code: claimLocked.code,
          detail: 'lost while waiting for the clone lock',
        },
        error: null,
        at: 'step-4',
      };
    }
    const step4 = runPrimaryFastForward(deps, primary, proof.pr);
    if (step4.hold !== null || step4.error !== null) {
      return { ...step4, at: 'step-4' };
    }
    steps.push(stepRecord('step-4', 'done'));
  }
  // Step 5, inspection then removal.
  const inspected = inspectWorktree(
    deps,
    input.issueNumber,
    primary,
    worktree,
    branchRef,
    proof,
  );
  if (inspected.hold !== null) {
    return { hold: inspected.hold, error: null, at: 'step-5' };
  }
  if (!apply) {
    steps.push(
      stepRecord('step-5', 'would-run', {
        detail: inspected.worktreePresent
          ? inspected.preserveNodeModules === null
            ? 'the worktree and branch would be removed'
            : `node_modules/ would move to ${inspected.preserveNodeModules.destination}; the worktree and branch would be removed`
          : 'the worktree is already absent; only the branch would be removed',
      }),
    );
    return { hold: null, error: null, at: 'step-5' };
  }
  // Apply: pre-removal claim check, optional preservation, then removal.
  const claimRemoval = classifyClaimAssert(
    deps.assertClaim(worktree),
    input.claimId,
    input.agentId,
  );
  if (!claimRemoval.ok) {
    return {
      hold: { code: claimRemoval.code, detail: 'before removal' },
      error: null,
      at: 'step-5',
    };
  }
  let preservedDestination = null;
  if (inspected.preserveNodeModules !== null) {
    const moved = moveNodeModules(
      deps,
      primary,
      worktree,
      inspected.preserveNodeModules.destination,
      inspected.preserveNodeModules.sourceIdentity,
    );
    if (moved.hold !== null || moved.result === null) {
      return {
        hold: { code: 'dirty-worktree', detail: moved.hold },
        error: null,
        at: 'step-5',
      };
    }
    preservedDestination = moved.result.destination;
    const postMoveStatus = deps.git(
      [
        '-C',
        worktree,
        'status',
        '--porcelain',
        '--ignored',
        '--untracked-files=normal',
      ],
      primary,
    );
    if (postMoveStatus.status !== 0) {
      return {
        hold: {
          code: 'inconsistent-worktree-state',
          detail: `node_modules/ was preserved at ${preservedDestination}, but git status failed: ${postMoveStatus.stderr.trim()}`,
        },
        error: null,
        at: 'step-5',
      };
    }
    if (postMoveStatus.stdout.length > 0) {
      return {
        hold: {
          code: 'dirty-worktree',
          detail: `node_modules/ was preserved at ${preservedDestination}, but the worktree still has status output`,
        },
        error: null,
        at: 'step-5',
      };
    }
  }
  if (inspected.worktreePresent) {
    // The final network-backed ownership assertion runs before this scan.
    // Keep the ignored-inclusive status check immediately before removal so
    // newly appearing user content is held rather than discarded.
    const claimBeforeFinalStatus = classifyClaimAssert(
      deps.assertClaim(worktree),
      input.claimId,
      input.agentId,
    );
    if (!claimBeforeFinalStatus.ok) {
      return {
        hold: {
          code: claimBeforeFinalStatus.code,
          detail:
            preservedDestination === null
              ? 'before the final worktree status check and removal'
              : `after preserving node_modules/ at ${preservedDestination}`,
        },
        error: null,
        at: 'step-5',
      };
    }
    const finalStatus = deps.git(
      [
        '-C',
        worktree,
        'status',
        '--porcelain',
        '--ignored',
        '--untracked-files=normal',
      ],
      primary,
    );
    if (finalStatus.status !== 0) {
      return {
        hold: {
          code: 'inconsistent-worktree-state',
          detail: `the final worktree status check failed after the claim assertion${preservedDestination === null ? '' : `; node_modules/ was preserved at ${preservedDestination}`}: ${finalStatus.stderr.trim()}`,
        },
        error: null,
        at: 'step-5',
      };
    }
    if (finalStatus.stdout.length > 0) {
      return {
        hold: {
          code: 'dirty-worktree',
          detail: `the worktree still has status output after the final claim assertion; the helper did not move newly appearing content${preservedDestination === null ? '' : `; node_modules/ was preserved at ${preservedDestination}`}`,
        },
        error: null,
        at: 'step-5',
      };
    }
    const removed = deps.git(['worktree', 'remove', worktree], primary);
    if (removed.status !== 0) {
      return {
        hold: null,
        error: {
          kind: 'failed',
          code: 'worktree-remove-refused',
          detail: `git worktree remove refused: ${removed.stderr.trim()}${preservedDestination === null ? '' : `; node_modules/ was preserved at ${preservedDestination}`}`,
        },
        at: 'step-5',
      };
    }
  }
  if (inspected.branchPresent) {
    const deleted = deps.git(['branch', '-d', '--', branch], primary);
    if (deleted.status !== 0) {
      const tip = readBranchTip(deps, primary, branchRef);
      if (tip !== proof.head) {
        return {
          hold: {
            code: 'local-branch-unmerged-commits',
            detail: `git branch -d refused, and the tip ${tip ?? 'unknown'} is not the proof head ${proof.head}${preservedDestination === null ? '' : `; node_modules/ was preserved at ${preservedDestination}`}`,
          },
          error: null,
          at: 'step-5',
        };
      }
      steps.push(
        stepRecord('step-5', 'done', {
          detail: `git branch -d kept the branch, whose tip equals the proof head. Comment on the issue before any git branch -D, as merge doc F4 step 5 asks${preservedDestination === null ? '' : `; node_modules/ was preserved at ${preservedDestination}`}`,
        }),
      );
      return { hold: null, error: null, at: 'step-5' };
    }
  }
  steps.push(
    stepRecord('step-5', 'done', {
      detail:
        preservedDestination === null
          ? null
          : `node_modules/ was preserved at ${preservedDestination}`,
    }),
  );
  return { hold: null, error: null, at: 'step-5' };
}
function readBranchTip(deps, primary, branchRef) {
  const result = deps.git(
    ['rev-parse', '--verify', '--quiet', branchRef],
    primary,
  );
  if (result.status !== 0) {
    return null;
  }
  const tip = result.stdout.trim();
  return FULL_SHA.test(tip) ? tip : null;
}
/**
 * The development branch, from the pull request base ref, and the holder
 * check. Both are read-only. A branch another worktree has checked out holds,
 * so the switch never reaches it.
 */
function readDevelopmentTarget(deps, primary, pr) {
  const base = deps.prBaseRef(pr);
  if (
    base === null ||
    base.startsWith('-') ||
    deps.git(['check-ref-format', `refs/heads/${base}`], primary).status !== 0
  ) {
    return { base: null, hold: { code: 'base-ref-unreadable', detail: null } };
  }
  const listing = deps.git(['worktree', 'list', '--porcelain', '-z'], primary);
  let records;
  try {
    if (listing.status !== 0) {
      throw new Error('git worktree list failed');
    }
    records = parseLocalWorktreeList(listing.stdout);
  } catch {
    return {
      base: null,
      hold: {
        code: 'inconsistent-worktree-state',
        detail: 'git worktree list could not be read',
      },
    };
  }
  const primaryReal = deps.realpath(primary) ?? resolve(primary);
  const holder = records.find(
    (record) =>
      record.branchRef === `refs/heads/${base}` &&
      (deps.realpath(record.path) ?? resolve(record.path)) !== primaryReal,
  );
  if (holder !== undefined) {
    return {
      base: null,
      hold: {
        code: 'development-branch-in-use',
        detail: `${base} is checked out at ${holder.path}`,
      },
    };
  }
  return { base, hold: null };
}
/** Step 4: fetch, switch to the development branch, fast-forward. */
function runPrimaryFastForward(deps, primary, pr) {
  const fetched = deps.git(['fetch', 'origin'], primary);
  if (fetched.status !== 0) {
    return {
      hold: { code: 'fetch-failed', detail: fetched.stderr.trim() || null },
      error: null,
    };
  }
  const target = readDevelopmentTarget(deps, primary, pr);
  if (target.base === null) {
    return { hold: target.hold, error: null };
  }
  const base = target.base;
  const probe = deps.git(
    ['show-ref', '--verify', '--quiet', `refs/heads/${base}`],
    primary,
  );
  // show-ref exits 1 for an absent ref. Any other failure is unreadable, and it
  // must not read as absent, or the switch would create the branch.
  if (probe.status !== 0 && probe.status !== 1) {
    return {
      hold: {
        code: 'primary-update-failed',
        detail: `the development branch ref could not be read: ${probe.stderr.trim()}`,
      },
      error: null,
    };
  }
  const hasLocal = probe.status === 0;
  const switched = deps.git(
    hasLocal
      ? ['switch', '--no-overwrite-ignore', base]
      : [
          'switch',
          '--no-overwrite-ignore',
          '-c',
          base,
          '--track',
          `origin/${base}`,
        ],
    primary,
  );
  if (switched.status !== 0) {
    return refusalHold(deps, primary, switched);
  }
  const merged = deps.git(
    [
      '-c',
      'merge.autoStash=false',
      'merge',
      '--ff-only',
      '--no-overwrite-ignore',
      `origin/${base}`,
    ],
    primary,
  );
  if (merged.status !== 0) {
    return refusalHold(deps, primary, merged);
  }
  return { hold: null, error: null };
}
/** Map a refused switch or merge to its hold code, fail closed. */
function refusalHold(deps, primary, result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (text.includes('already used by worktree')) {
    return {
      hold: { code: 'development-branch-in-use', detail: text.trim() },
      error: null,
    };
  }
  const refusal = classifyPrimaryRefusal(text);
  if (refusal !== null) {
    return { hold: { code: refusal.code, detail: text.trim() }, error: null };
  }
  if (
    text.includes('would be overwritten by merge') ||
    text.includes('would be overwritten by checkout')
  ) {
    const paths = parseOverwrittenPaths(text);
    const allIgnored =
      paths.length > 0 &&
      paths.every((path) => {
        const check = deps.git(['check-ignore', '-q', '--', path], primary);
        return check.status === 0;
      });
    return {
      hold: {
        code: allIgnored
          ? 'primary-ignored-overwrite'
          : 'primary-worktree-dirty',
        detail: text.trim(),
      },
      error: null,
    };
  }
  return {
    hold: { code: 'primary-update-failed', detail: text.trim() },
    error: null,
  };
}
/**
 * Step 5's read-only checks, in order: the registration, the branch tip, the
 * worktree status, the populated submodules, and each tracked path. A hold
 * here removes nothing.
 */
function inspectWorktree(
  deps,
  issueNumber,
  primary,
  worktree,
  branchRef,
  proof,
) {
  const none = (code, detail) => ({
    hold: { code, detail },
    worktreePresent: false,
    branchPresent: false,
    preserveNodeModules: null,
  });
  const listing = deps.git(['worktree', 'list', '--porcelain', '-z'], primary);
  let records;
  try {
    if (listing.status !== 0) {
      throw new Error('git worktree list failed');
    }
    records = parseLocalWorktreeList(listing.stdout);
  } catch {
    return none(
      'inconsistent-worktree-state',
      'git worktree list could not be read',
    );
  }
  const target = deps.realpath(worktree) ?? resolve(worktree);
  const record = records.find(
    (entry) => (deps.realpath(entry.path) ?? resolve(entry.path)) === target,
  );
  const present = deps.lstat(worktree) !== 'absent';
  if (!present && record === undefined) {
    // Both absent: skip the removal and check only the branch.
    const tip = readBranchTip(deps, primary, branchRef);
    const ref = deps.git(
      ['show-ref', '--verify', '--quiet', branchRef],
      primary,
    );
    if (ref.status !== 0 && ref.status !== 1) {
      return none(
        'inconsistent-worktree-state',
        `the branch ref could not be read: ${ref.stderr.trim()}`,
      );
    }
    const exists = ref.status === 0;
    if (exists && tip !== proof.branchTip) {
      return none(
        'branch-tip-mismatch',
        `local tip ${tip ?? 'unknown'} differs from the proof`,
      );
    }
    return {
      hold: null,
      worktreePresent: false,
      branchPresent: exists,
      preserveNodeModules: null,
    };
  }
  if (!present || record === undefined || record.prunable) {
    return none(
      'inconsistent-worktree-state',
      present
        ? 'the path exists but git does not register it'
        : 'git registers the path, but it is missing',
    );
  }
  if (record.branchRef !== branchRef) {
    return none(
      'inconsistent-worktree-state',
      `the worktree is on ${record.branchRef ?? 'a detached HEAD'}, not ${branchRef}`,
    );
  }
  if (record.locked) {
    return none(
      'inconsistent-worktree-state',
      'the worktree is locked; inspect the preservation recovery state and unlock it manually before rerunning cleanup',
    );
  }
  const tip = readBranchTip(deps, primary, branchRef);
  if (tip === null) {
    return none(
      'branch-tip-mismatch',
      `${branchRef} is missing while its worktree exists`,
    );
  }
  if (tip !== proof.branchTip) {
    return none(
      'branch-tip-mismatch',
      `local tip ${tip} differs from the proof ${proof.branchTip}`,
    );
  }
  const status = deps.git(
    [
      '-C',
      worktree,
      'status',
      '--porcelain',
      '--ignored',
      '--untracked-files=normal',
    ],
    primary,
  );
  if (status.status !== 0) {
    return none(
      'inconsistent-worktree-state',
      `git status failed: ${status.stderr.trim()}`,
    );
  }
  const statusBody = status.stdout.endsWith('\n')
    ? status.stdout.slice(0, -1)
    : status.stdout;
  const loneIgnoredNodeModules = statusBody === '!! node_modules/';
  if (statusBody.length > 0 && !loneIgnoredNodeModules) {
    return none('dirty-worktree', null);
  }
  let preserveNodeModules = null;
  let sourceIdentity = null;
  if (loneIgnoredNodeModules) {
    const nodeModules = join(worktree, 'node_modules');
    let registeredInsideNodeModules;
    try {
      if (deps.lstat(nodeModules) !== 'directory') {
        return none(
          'dirty-worktree',
          'the helper did not move node_modules/: the path is not a real directory',
        );
      }
      sourceIdentity = deps.directoryIdentity(nodeModules);
      if (sourceIdentity === null) {
        return none(
          'dirty-worktree',
          'the helper did not move node_modules/: its directory identity could not be verified',
        );
      }
      registeredInsideNodeModules = records.find((entry) =>
        isWithinRoot(
          deps.realpath(nodeModules) ?? resolve(nodeModules),
          deps.realpath(entry.path) ?? resolve(entry.path),
        ),
      );
    } catch (error) {
      return none(
        'dirty-worktree',
        `the helper did not move node_modules/: it could not inspect the directory or worktree paths: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (registeredInsideNodeModules !== undefined) {
      return none(
        'dirty-worktree',
        `the helper did not move node_modules/: registered worktree ${registeredInsideNodeModules.path} lies at or inside it`,
      );
    }
  }
  const submodules = deps.git(
    ['-C', worktree, 'submodule', 'status', '--recursive'],
    primary,
  );
  if (submodules.status !== 0) {
    return none(
      'inconsistent-worktree-state',
      `git submodule status failed: ${submodules.stderr.trim()}`,
    );
  }
  if (
    submodules.stdout
      .split('\n')
      .some((line) => line.length > 0 && !line.startsWith('-'))
  ) {
    return none('submodule-worktree', null);
  }
  // git status cannot vouch for an entry marked skip-worktree or
  // assume-unchanged, so any tag other than a plain cached entry holds.
  const tagged = deps.git(['-C', worktree, 'ls-files', '-v'], primary);
  if (tagged.status !== 0) {
    return none(
      'inconsistent-worktree-state',
      `git ls-files -v failed: ${tagged.stderr.trim()}`,
    );
  }
  if (
    tagged.stdout
      .split('\n')
      .some((line) => line.length > 0 && !line.startsWith('H '))
  ) {
    return none(
      'dirty-worktree',
      'a tracked entry is marked skip-worktree or assume-unchanged',
    );
  }
  const tracked = deps.git(['-C', worktree, 'ls-files', '-z'], primary);
  if (tracked.status !== 0) {
    return none(
      'inconsistent-worktree-state',
      `git ls-files failed: ${tracked.stderr.trim()}`,
    );
  }
  const linked = findLinkedEntry(deps, worktree, parseNulList(tracked.stdout));
  if (linked !== null) {
    return none('symlink-path', linked);
  }
  if (loneIgnoredNodeModules) {
    if (sourceIdentity === null) {
      return none(
        'dirty-worktree',
        'the helper did not move node_modules/: its directory identity could not be verified',
      );
    }
    try {
      if (
        deps.inspectDirectoryPrivacy(join(worktree, 'node_modules')) ===
        'unsafe'
      ) {
        return none(
          'dirty-worktree',
          'the helper did not move node_modules/: its ownership or privacy could not be verified',
        );
      }
    } catch {
      return none(
        'dirty-worktree',
        'the helper did not move node_modules/: its ownership or privacy could not be verified',
      );
    }
    const destination = preserveDestination(
      deps,
      issueNumber,
      primary,
      records,
    );
    if (destination.hold !== null) {
      return none('dirty-worktree', destination.hold);
    }
    preserveNodeModules = {
      destination: destination.destination,
      sourceIdentity,
    };
  }
  return {
    hold: null,
    worktreePresent: true,
    branchPresent: true,
    preserveNodeModules,
  };
}
/** Read-only destination validation shared by dry-run and apply. */
function preserveDestination(deps, issueNumber, primary, records) {
  try {
    return inspectPreserveDestination(deps, issueNumber, primary, records);
  } catch (error) {
    return {
      destination: '',
      hold: `the helper did not move node_modules/: destination check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
function inspectPreserveDestination(deps, issueNumber, primary, records) {
  const refuse = (detail) => ({ destination: '', hold: detail });
  if (!isAbsolute(deps.stateRoot)) {
    return refuse(
      'the helper did not move node_modules/: the state root is not absolute',
    );
  }
  const stateKind = deps.lstat(deps.stateRoot);
  if (stateKind === 'absent') {
    return refuse(
      'the helper did not move node_modules/: the state root does not exist',
    );
  }
  if (stateKind !== 'directory' && stateKind !== 'symlink') {
    return refuse(
      'the helper did not move node_modules/: the state root is not a directory',
    );
  }
  const stateRootReal = deps.realpath(deps.stateRoot);
  if (stateRootReal === null) {
    return refuse(
      'the helper did not move node_modules/: the state root cannot be resolved',
    );
  }
  const resolvedStateRoot = resolve(stateRootReal);
  if (parse(resolvedStateRoot).root === resolvedStateRoot) {
    return refuse(
      'the helper did not move node_modules/: the state root resolves to a filesystem root',
    );
  }
  if (deps.inspectDirectoryPrivacy(deps.stateRoot) === 'unsafe') {
    return refuse(
      'the helper did not move node_modules/: the state root is not owned and private',
    );
  }
  const iddDirectory = join(deps.stateRoot, 'idd-skill');
  const preserveDirectory = join(iddDirectory, 'f4-preserved');
  for (const [path, kind] of [
    [iddDirectory, deps.lstat(iddDirectory)],
    [preserveDirectory, deps.lstat(preserveDirectory)],
  ]) {
    if (kind === 'symlink') {
      return refuse(
        `the helper did not move node_modules/: destination component ${path} is a symlink`,
      );
    }
    if (kind !== 'absent' && kind !== 'directory') {
      return refuse(
        `the helper did not move node_modules/: destination component ${path} is not a directory`,
      );
    }
    if (
      kind === 'directory' &&
      deps.inspectDirectoryPrivacy(path) === 'unsafe'
    ) {
      return refuse(
        `the helper did not move node_modules/: destination component ${path} is not owned and private`,
      );
    }
  }
  let timestamp;
  try {
    timestamp = deps
      .now()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return refuse(
      'the helper did not move node_modules/: the UTC destination timestamp is invalid',
    );
  }
  const destination = join(preserveDirectory, `${issueNumber}-${timestamp}`);
  if (deps.lstat(destination) !== 'absent') {
    return refuse(
      `the helper did not move node_modules/: destination already exists at ${destination}`,
    );
  }
  const deepestExisting = [
    preserveDirectory,
    iddDirectory,
    deps.stateRoot,
  ].find((path) => deps.lstat(path) !== 'absent');
  if (deepestExisting === undefined) {
    return refuse(
      'the helper did not move node_modules/: no existing destination parent was found',
    );
  }
  const destinationBase = deps.realpath(deepestExisting);
  if (destinationBase === null) {
    return refuse(
      `the helper did not move node_modules/: destination parent ${deepestExisting} cannot be resolved`,
    );
  }
  const commonDirectoryResult = deps.git(
    ['rev-parse', '--git-common-dir'],
    primary,
  );
  const commonDirectoryOutput = commonDirectoryResult.stdout.trim();
  if (
    commonDirectoryResult.status !== 0 ||
    commonDirectoryOutput.length === 0
  ) {
    return refuse(
      'the helper did not move node_modules/: Git common directory cannot be resolved',
    );
  }
  const commonDirectoryPath = isAbsolute(commonDirectoryOutput)
    ? commonDirectoryOutput
    : resolve(primary, commonDirectoryOutput);
  const commonDirectory = deps.realpath(commonDirectoryPath);
  if (commonDirectory === null) {
    return refuse(
      'the helper did not move node_modules/: Git common directory cannot be resolved',
    );
  }
  const protectedRoots = [
    { path: primary, label: 'worktree' },
    { path: commonDirectory, label: 'Git common directory' },
    ...records.map((record) => ({ path: record.path, label: 'worktree' })),
  ];
  for (const protectedRoot of protectedRoots) {
    const protectedReal =
      deps.realpath(protectedRoot.path) ?? resolve(protectedRoot.path);
    if (isWithinRoot(protectedReal, destinationBase)) {
      return refuse(
        `the helper did not move node_modules/: destination ${destination} is inside protected ${protectedRoot.label} ${protectedRoot.path}`,
      );
    }
  }
  return { destination, hold: null };
}
/**
 * Create private parents, stage the source inside its worktree, and verify
 * its identity before moving it into per-user state. A raced replacement is
 * restored to the original path when that path remains free.
 */
function moveNodeModules(
  deps,
  primary,
  worktree,
  destination,
  expectedIdentity,
) {
  const source = join(worktree, 'node_modules');
  let temporaryId;
  try {
    temporaryId = deps.temporaryId();
  } catch (error) {
    return {
      result: null,
      hold: `the helper did not move node_modules/: could not create a staging name: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!/^[a-zA-Z0-9-]+$/.test(temporaryId)) {
    return {
      result: null,
      hold: 'the helper did not move node_modules/: the staging name is invalid',
    };
  }
  const staging = join(worktree, `.idd-f4-node_modules-${temporaryId}`);
  const preserveDirectory = dirname(destination);
  const iddDirectory = dirname(preserveDirectory);
  for (const path of [deps.stateRoot, iddDirectory, preserveDirectory]) {
    let kind;
    try {
      kind = deps.lstat(path);
    } catch (error) {
      return {
        result: null,
        hold: `the helper did not move node_modules/: could not inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (
      kind === 'directory' ||
      (path === deps.stateRoot && kind === 'symlink')
    ) {
      try {
        deps.ensurePrivateDirectory(path);
      } catch (error) {
        return {
          result: null,
          hold: `the helper did not move node_modules/: could not secure ${path}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      continue;
    }
    if (kind !== 'absent') {
      return {
        result: null,
        hold: `the helper did not move node_modules/: destination component ${path} is not a real directory`,
      };
    }
    try {
      deps.mkdir(path, 0o700);
    } catch (error) {
      return {
        result: null,
        hold: `the helper did not move node_modules/: could not create ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let createdKind;
    try {
      createdKind = deps.lstat(path);
    } catch (error) {
      return {
        result: null,
        hold: `the helper did not move node_modules/: could not verify created destination component ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (createdKind !== 'directory') {
      return {
        result: null,
        hold: `the helper did not move node_modules/: created destination component ${path} is not a real directory`,
      };
    }
    try {
      deps.ensurePrivateDirectory(path);
    } catch (error) {
      return {
        result: null,
        hold: `the helper did not move node_modules/: could not secure ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  let destinationKind;
  try {
    destinationKind = deps.lstat(destination);
  } catch (error) {
    return {
      result: null,
      hold: `the helper did not move node_modules/: could not inspect destination ${destination}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (destinationKind !== 'absent') {
    return {
      result: null,
      hold: `the helper did not move node_modules/: destination already exists at ${destination}`,
    };
  }
  let stagingKind;
  try {
    stagingKind = deps.lstat(staging);
  } catch (error) {
    return {
      result: null,
      hold: `the helper did not move node_modules/: could not inspect staging path ${staging}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (stagingKind !== 'absent') {
    return {
      result: null,
      hold: `the helper did not move node_modules/: staging path already exists at ${staging}`,
    };
  }
  if (deps.lstat(source) !== 'directory') {
    return {
      result: null,
      hold: 'the helper did not move node_modules/: the source path is no longer a real directory',
    };
  }
  if (deps.directoryIdentity(source) !== expectedIdentity) {
    return {
      result: null,
      hold: 'the helper did not move node_modules/: the source directory changed after inspection',
    };
  }
  try {
    if (deps.inspectDirectoryPrivacy(source) === 'unsafe') {
      return {
        result: null,
        hold: 'the helper did not move node_modules/: its ownership or privacy could not be verified',
      };
    }
  } catch {
    return {
      result: null,
      hold: 'the helper did not move node_modules/: its ownership or privacy could not be verified',
    };
  }
  // Recheck immediately before the path-based rename. The staged object is
  // checked again after rename, so a replacement in this final window is
  // returned to node_modules instead of entering the state directory.
  if (
    deps.lstat(source) !== 'directory' ||
    deps.directoryIdentity(source) !== expectedIdentity
  ) {
    return {
      result: null,
      hold: 'the helper did not move node_modules/: the source directory changed before the move',
    };
  }
  try {
    deps.rename(source, staging);
  } catch (error) {
    return {
      result: null,
      hold: `the helper did not move node_modules/: staging rename failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let stagedIdentity;
  try {
    stagedIdentity =
      deps.lstat(staging) === 'directory'
        ? deps.directoryIdentity(staging)
        : null;
  } catch {
    stagedIdentity = null;
  }
  if (stagedIdentity !== expectedIdentity) {
    return {
      result: null,
      hold: restoreNodeModulesAfterRace(
        deps,
        staging,
        source,
        expectedIdentity,
        `the staged source identity changed; expected ${expectedIdentity}, observed ${stagedIdentity ?? 'unavailable'}`,
      ),
    };
  }
  try {
    if (deps.inspectDirectoryPrivacy(staging) === 'unsafe') {
      return {
        result: null,
        hold: restoreNodeModulesAfterRace(
          deps,
          staging,
          source,
          expectedIdentity,
          'the staged source ownership or privacy could not be verified',
        ),
      };
    }
    deps.ensurePrivateDirectory(staging);
  } catch (error) {
    return {
      result: null,
      hold: restoreNodeModulesAfterRace(
        deps,
        staging,
        source,
        expectedIdentity,
        `the staged source could not be secured: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  try {
    if (
      deps.lstat(staging) !== 'directory' ||
      deps.directoryIdentity(staging) !== expectedIdentity ||
      deps.lstat(source) !== 'absent'
    ) {
      return {
        result: null,
        hold: restoreNodeModulesAfterRace(
          deps,
          staging,
          source,
          expectedIdentity,
          'the staged source identity or original path changed before preservation',
        ),
      };
    }
    deps.rename(staging, destination);
  } catch (error) {
    return {
      result: null,
      hold: restoreNodeModulesAfterRace(
        deps,
        staging,
        source,
        expectedIdentity,
        `rename to ${destination} failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  try {
    if (
      deps.lstat(destination) !== 'directory' ||
      deps.directoryIdentity(destination) !== expectedIdentity
    ) {
      return {
        result: null,
        hold: restoreNodeModulesAfterRace(
          deps,
          destination,
          source,
          expectedIdentity,
          'the preserved source identity changed during the final move',
        ),
      };
    }
    deps.ensurePrivateDirectory(destination);
  } catch (error) {
    const hold = restoreOrLockNodeModulesAfterRace(
      deps,
      primary,
      worktree,
      destination,
      source,
      expectedIdentity,
      `the preserved directory could not be secured: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      result: null,
      hold,
    };
  }
  return {
    result: { destination },
    hold: null,
  };
}
/** Restore a raced or refused object without overwriting a new source path. */
function restoreNodeModulesAfterRace(
  deps,
  movedPath,
  source,
  expectedIdentity,
  reason,
) {
  try {
    const movedKind = deps.lstat(movedPath);
    if (movedKind === 'absent') {
      return `the helper did not move node_modules/: ${reason}; the staged path is absent and no automatic recovery was possible`;
    }
    if (movedKind !== 'directory') {
      return `the helper did not move node_modules/: ${reason}; ${movedPath} was retained because it is not a real directory`;
    }
    const movedIdentity = deps.directoryIdentity(movedPath);
    if (movedIdentity !== expectedIdentity) {
      return `the helper did not move node_modules/: ${reason}; ${movedPath} was retained because its directory identity did not match the expected source`;
    }
    if (deps.lstat(source) !== 'absent') {
      return `the helper did not move node_modules/: ${reason}; ${movedPath} was retained because ${source} is occupied`;
    }
    deps.rename(movedPath, source);
    return `the helper did not move node_modules/: ${reason}; the moved object was restored to ${source}`;
  } catch (error) {
    return `the helper did not move node_modules/: ${reason}; automatic restoration failed and the object remains at ${movedPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
/** Restore a refused move, or persist a hold if restoration cannot be verified. */
function restoreOrLockNodeModulesAfterRace(
  deps,
  primary,
  worktree,
  movedPath,
  source,
  expectedIdentity,
  reason,
) {
  const restoration = restoreNodeModulesAfterRace(
    deps,
    movedPath,
    source,
    expectedIdentity,
    reason,
  );
  try {
    if (
      deps.lstat(source) === 'directory' &&
      deps.directoryIdentity(source) === expectedIdentity &&
      deps.lstat(movedPath) === 'absent'
    ) {
      return restoration;
    }
  } catch {
    // An unverified restore keeps the worktree locked below.
  }
  let lock;
  try {
    lock = deps.git(
      [
        'worktree',
        'lock',
        '--reason',
        `F4 node_modules recovery required for issue ${worktree}`,
        worktree,
      ],
      primary,
    );
  } catch (error) {
    return `${restoration}; the helper could not persist a worktree lock: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (lock.status === 0) {
    return `${restoration}; the worktree was locked to prevent a later cleanup from removing the recovery state`;
  }
  return `${restoration}; the helper could not persist a worktree lock: ${lock.stderr.trim()}`;
}
/**
 * The first tracked entry whose path, or any ancestor inside the worktree,
 * is a symlink, or whose symlink target resolves outside the worktree. Null
 * when every entry is clean.
 */
function findLinkedEntry(deps, worktree, entries) {
  const root = resolve(worktree);
  const kinds = new Map();
  const kindOf = (path) => {
    const cached = kinds.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const kind = deps.lstat(path);
    kinds.set(path, kind);
    return kind;
  };
  for (const entry of entries) {
    const full = resolve(root, entry);
    if (!isWithinRoot(root, full)) {
      return `${entry} resolves outside the worktree`;
    }
    // Strict ancestors only: the entry itself may be a symlink whose target
    // stays inside the worktree, which the second loop allows.
    const parts = ancestorChain(dirname(full)).filter(
      (path) => isWithinRoot(root, path) && path !== root,
    );
    for (const part of parts) {
      if (kindOf(part) === 'symlink') {
        return `${entry} runs through the symlink ${part}`;
      }
    }
  }
  // Judge each symlink by the real path it resolves to, so a chain of links
  // that climbs out of the worktree is caught, not only a direct target.
  const rootReal = deps.realpath(root) ?? root;
  for (const entry of entries) {
    const full = resolve(root, entry);
    if (kindOf(full) === 'symlink') {
      const real = deps.realpath(full);
      if (real === null || !isWithinRoot(rootReal, real)) {
        return `${entry} is a symlink that resolves outside the worktree, or does not resolve`;
      }
    }
  }
  return null;
}
/** Step 6: the remote branch, once the local branch is settled. */
function runStep6(input, deps, proof, branch, steps, finish, holdAt, failAt) {
  const autoDelete = deps.deleteBranchOnMerge();
  if (autoDelete === null) {
    return holdAt(6, 'step-6', null, {
      code: 'delete-setting-unreadable',
      detail: null,
    });
  }
  if (autoDelete) {
    steps.push(
      stepRecord('step-6', 'skipped', {
        detail: 'GitHub deletes the branch on merge',
      }),
    );
    return finish(input.apply ? 'complete' : 'dry-run', null, null);
  }
  const dry = deps.remoteDelete('dry-run', branch, proof.head);
  if (dry === null) {
    return holdAt(6, 'step-6', null, {
      code: 'remote-delete-unreadable',
      detail: null,
    });
  }
  if (dry.action === 'already-absent') {
    steps.push(
      stepRecord('step-6', 'done', {
        detail: 'the remote branch is already absent',
      }),
    );
    return finish(input.apply ? 'complete' : 'dry-run', null, null);
  }
  if (dry.action !== 'would-delete') {
    return holdAt(6, 'step-6', null, {
      code: dry.action,
      detail: dry.detail,
    });
  }
  if (!input.apply) {
    steps.push(stepRecord('step-6', 'would-run', { detail: dry.detail }));
    return finish('dry-run', null, null);
  }
  let applied;
  try {
    applied = deps.remoteDelete('apply', branch, proof.head);
  } catch (error) {
    return failAt(6, 'step-6', null, {
      kind: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (applied === null) {
    return holdAt(6, 'step-6', null, {
      code: 'remote-delete-unreadable',
      detail: null,
    });
  }
  if (applied.action === 'deleted' || applied.action === 'already-absent') {
    steps.push(stepRecord('step-6', 'done', { detail: applied.action }));
    return finish('complete', null, null);
  }
  return holdAt(6, 'step-6', null, {
    code: applied.action,
    detail: applied.detail,
  });
}
