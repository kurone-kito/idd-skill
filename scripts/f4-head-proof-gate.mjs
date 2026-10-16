// idd-generated-from: src/scripts/f4-head-proof-gate.mts
//
// The scripts/f4-head-proof-gate.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// The flow behind `post-idd-marker --type f4-head-proof` (#4368): read the
// live state, decide with the verdict table (f4-head-proof-verdict.mts),
// post the proof only on a `post` verdict, read the result back, and report
// the verdict and the proof values. Every live read and the POST are
// callbacks in {@link F4HeadProofGateDeps}, so the whole flow runs without
// `gh`, `git`, or a claim lock. The production wiring lives in
// f4-head-proof-live.mts.
import {
  parseF4HeadProofBody,
  renderF4HeadProofBody,
} from './f4-head-proof.mjs';
import {
  classifyReread,
  decideAfterPost,
  decideBeforePost,
} from './f4-head-proof-verdict.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import { findOwnLoadControlRefusal } from './github-api-refusal.mjs';
import { parseClaimComment } from './marker-helpers.mjs';
import {
  classifyCommentEditState,
  isTrustEvidenceComment,
  resolveLatestReviewWatermark,
} from './protocol-helpers.mjs';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const NOTHING_SENT_STATUSES = new Set([401, 404, 422]);
const REREAD_COUNT = 3;
const REREAD_DELAY_MS = 1000;
const UNREADABLE_PR = {
  merged: false,
  readable: false,
  mergeCommitSha: null,
  headSha: null,
  mergeParentHeadSha: null,
};
/** The next action of a `stop` on `claim-or-lock`: a rerun cannot help. */
const STOP_NEXT_ACTION =
  'Do not post and do not continue F4. This session does not hold the claim or its lock; end quietly.';
const NEXT_ACTION = {
  'claim-or-lock':
    'Do not post. Check the claim, the activation nonce record, and the claim lock of this worktree, then rerun.',
  'pr-state':
    'Do not post. The merged pull request could not be read or does not agree with itself; read it again, then rerun.',
  'ref-read':
    'Do not post. The branch name or the local branch ref could not be read; fix the cause, then rerun.',
  'marker-read-failed':
    'Do not post. The comments of the issue could not be read; fix the cause, then rerun.',
  'branch-absent':
    'Do not post. The local branch is gone and no reusable proof exists, so the branch tip cannot be proven.',
  'conflicting-marker':
    'Do not post. A trusted proof for this claim conflicts with the live state or is malformed; reconcile by reading the issue comments.',
  'watermark-unauthenticated':
    'Do not post. No trusted, unedited review-watermark of this claim could be found on the pull request.',
  'claim-activation-unknown':
    'Do not post. The first trusted claimed-by marker of this claim and branch could not be found.',
  'posted-disagreed':
    'Do not post again. The comment read back does not match what was posted, or could not be read; reconcile by reading the issue comments.',
  'reread-failed':
    'Do not post again. A re-read of the issue comments failed; reconcile by reading the comments.',
  'reread-conflict':
    'Do not post again. The re-reads disagree or found a conflicting proof; reconcile by reading the issue comments.',
  'post-unconfirmed':
    'Do not post again. Three re-reads found no proof; reconcile by reading the issue comments before any further action.',
  'post-rejected':
    'Nothing was posted. Fix the cause of the rejection, then rerun the command.',
  'supersede-refused':
    'Nothing was posted. The named comment is a well-formed or edited proof, and only a malformed proof can be superseded; read the issue comments, then rerun without --supersedes.',
  'supersede-target-unknown':
    'Nothing was posted. No trusted proof of this claim with that comment ID is malformed; check the comment ID, then rerun.',
};
function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA_PATTERN.test(value);
}
function normalizeLogin(login) {
  return String(login ?? '')
    .trim()
    .toLowerCase();
}
/** The first line of an error message, bounded, for a one-line diagnostic. */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? '').slice(0, 300);
}
/**
 * Whether a failed POST proves that the comment was not sent: the request was
 * refused before dispatch by this host's load control (the thrown error is
 * the refusal itself, not a wrapper around one), or GitHub answered 401, 404,
 * or 422. Every other error, including the adapter's not-verified,
 * body-mismatch, and malformed-response errors, is an uncertain write.
 */
export function provesNothingSent(error) {
  if (findOwnLoadControlRefusal(error) !== undefined) {
    return true;
  }
  const status = deriveGhHttpStatus(error);
  return status !== null && NOTHING_SENT_STATUSES.has(status);
}
/**
 * The trusted same-claim `idd-f4-head-proof` entries in `comments`, in comment
 * order, each with the ID of the comment it came from, as the verdict table
 * reads them. An untrusted author's marker is ignored, never a conflict. A
 * trusted marker for another claim is ignored. A trusted marker that does not
 * parse (and does not name another claim), or that was edited, is
 * `unparseable`, which is never reusable.
 */
export function collectTrustedMarkers(comments, claimId, trustedLogins) {
  const entries = [];
  for (const comment of comments) {
    const parsed = parseF4HeadProofBody(comment.body);
    if (
      parsed.kind === 'none' ||
      !trustedLogins.has(normalizeLogin(comment.authorLogin))
    ) {
      continue;
    }
    if (parsed.kind === 'malformed') {
      if (parsed.claimId === null || parsed.claimId === claimId) {
        entries.push({
          commentId: comment.id,
          entry: { unparseable: true },
          supersedable: parsed.claimId === claimId,
          supersedes: null,
        });
      }
      continue;
    }
    if (parsed.proof.claimId !== claimId) {
      continue;
    }
    if (classifyCommentEditState(comment) !== 'unedited') {
      entries.push({
        commentId: comment.id,
        entry: { unparseable: true },
        supersedable: false,
        supersedes: null,
      });
      continue;
    }
    entries.push({
      commentId: comment.id,
      entry: {
        claimId: parsed.proof.claimId,
        prNumber: parsed.proof.prNumber,
        branch: parsed.proof.branch,
        merge: parsed.proof.merge,
        head: parsed.proof.head,
        f2: parsed.proof.f2,
        branchTip: parsed.proof.branchTip,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      },
      supersedable: false,
      supersedes: parsed.proof.supersedes ?? null,
    });
  }
  return entries;
}
/**
 * Set aside each malformed proof of this claim that a well-formed, unedited,
 * trusted proof of this claim names by comment ID (#4442). The superseding
 * proof is kept and judged by the verdict table on its own, so a superseding
 * proof that is not reusable, or that conflicts with another proof, still
 * holds F4. Returns the markers the verdict table reads and, for each set-aside
 * comment, the comment that names it, in comment order.
 */
function applySupersession(entries) {
  const supersedable = new Set(
    entries.filter((entry) => entry.supersedable).map((e) => e.commentId),
  );
  const supersededBy = new Map();
  for (const entry of entries) {
    if (
      entry.supersedes === null ||
      !supersedable.has(entry.supersedes) ||
      supersededBy.has(entry.supersedes)
    ) {
      continue;
    }
    supersededBy.set(entry.supersedes, entry.commentId);
  }
  return {
    markers: entries
      .filter((entry) => !supersededBy.has(entry.commentId))
      .map((entry) => entry.entry),
    supersededBy,
  };
}
/**
 * The reason a `--supersedes` request is refused, or `null` when the request
 * may go on. A target that is absent, or that is not a malformed proof of this
 * claim, is refused whatever the other proofs say. A malformed target that is
 * already set aside needs no write, so it is not refused. Another trusted
 * proof of this claim that remains blocks the write.
 */
function supersedeRefusal(supersedes, entries, supersededBy) {
  const target = entries.find((entry) => entry.commentId === supersedes);
  if (target === undefined) {
    return {
      reason: 'supersede-target-unknown',
      note: `no trusted proof of this claim has comment ID ${supersedes}, so nothing was superseded`,
    };
  }
  if (!target.supersedable) {
    return {
      reason: 'supersede-refused',
      note: `comment ${supersedes} is a well-formed or edited proof of this claim; only a malformed proof is superseded, so nothing was posted`,
    };
  }
  if (supersededBy.has(supersedes)) {
    return null;
  }
  const others = entries.filter(
    (entry) =>
      entry.commentId !== supersedes && !supersededBy.has(entry.commentId),
  );
  if (others.length > 0) {
    return {
      reason: 'conflicting-marker',
      note: `other trusted proofs of this claim remain (comment IDs ${others
        .map((entry) => entry.commentId)
        .join(', ')}), so the superseding proof was not posted`,
    };
  }
  return null;
}
/**
 * The GitHub `created_at` of the first trusted, unedited `claimed-by` marker
 * for this claim ID and branch (the activation, not a later heartbeat), or
 * `null` when there is none.
 */
export function findClaimActivationTime(
  comments,
  claimId,
  branch,
  trustedLogins,
) {
  let earliest = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const comment of comments) {
    if (
      !isTrustEvidenceComment(comment, (login) =>
        trustedLogins.has(normalizeLogin(login)),
      )
    ) {
      continue;
    }
    const claim = parseClaimComment(comment.body, comment.createdAt);
    if (
      claim === null ||
      claim.claimId !== claimId ||
      claim.branch !== branch
    ) {
      continue;
    }
    const ms = Date.parse(comment.createdAt);
    if (!Number.isNaN(ms) && ms < earliestMs) {
      earliestMs = ms;
      earliest = comment.createdAt;
    }
  }
  return earliest;
}
function lookupMergedPullRequest(deps, branch, notes) {
  try {
    const merged = deps
      .listPullRequests(branch)
      .filter((candidate) => candidate.merged);
    if (merged.length !== 1) {
      notes.push(
        `${merged.length} merged pull requests have ${branch} as their head branch; exactly one is required`,
      );
      return null;
    }
    return merged[0].number;
  } catch (error) {
    notes.push(`pull request lookup failed: ${describeError(error)}`);
    return null;
  }
}
/**
 * The live pull request, as the verdict table reads it. A merge commit with
 * two parents has its head as the second parent; one parent (a squash or
 * rebase merge) leaves the check to the PR's own head, as the F4 Head Proof
 * procedure says; any other count is unreadable. The commit endpoint is read
 * only after the PR state and both SHAs pass.
 */
function readLivePr(deps, prNumber, notes) {
  try {
    const pr = deps.readPullRequest(prNumber);
    const merged = pr.state === 'closed' && pr.merged === true;
    if (!merged || !isFullSha(pr.mergeCommitSha) || !isFullSha(pr.headSha)) {
      return {
        merged,
        readable: true,
        mergeCommitSha: isFullSha(pr.mergeCommitSha) ? pr.mergeCommitSha : null,
        headSha: isFullSha(pr.headSha) ? pr.headSha : null,
        mergeParentHeadSha: null,
      };
    }
    const commit = deps.readCommit(pr.mergeCommitSha);
    const parents = commit.parents;
    if (
      commit.sha !== pr.mergeCommitSha ||
      (parents.length !== 1 && parents.length !== 2) ||
      !parents.every(isFullSha)
    ) {
      notes.push(
        `the merge commit ${pr.mergeCommitSha} is not readable as one with one or two full-SHA parents`,
      );
      return UNREADABLE_PR;
    }
    return {
      merged: true,
      readable: true,
      mergeCommitSha: pr.mergeCommitSha,
      headSha: pr.headSha,
      mergeParentHeadSha: parents.length === 2 ? (parents[1] ?? null) : null,
    };
  } catch (error) {
    notes.push(`pull request ${prNumber} read failed: ${describeError(error)}`);
    return UNREADABLE_PR;
  }
}
function readLocalRefSafely(deps, worktree, branch, notes) {
  try {
    const ref = deps.readLocalRef(worktree, branch);
    if (ref.state === 'present' && !isFullSha(ref.tip)) {
      notes.push('the local branch ref did not resolve to a full SHA');
      return { state: 'error', tip: null };
    }
    if (ref.state === 'error') {
      notes.push('the local branch ref could not be read');
    }
    return ref;
  } catch (error) {
    notes.push(`local branch ref read failed: ${describeError(error)}`);
    return { state: 'error', tip: null };
  }
}
function readIssueMarkers(deps, issueNumber, claimId) {
  const comments = deps.listIssueComments(issueNumber);
  const trusted = new Set(
    deps.resolveTrustedLogins(comments).map(normalizeLogin),
  );
  return {
    comments,
    trusted,
    entries: collectTrustedMarkers(comments, claimId, trusted),
  };
}
/** The review-watermark head (`f2`) of this claim, or `null` when none authenticates. */
function readWatermarkHead(deps, prNumber, claimId, notes) {
  try {
    const comments = deps.listPullRequestComments(prNumber);
    const trusted = new Set(
      deps.resolveTrustedLogins(comments).map(normalizeLogin),
    );
    const watermark = resolveLatestReviewWatermark([...comments], {
      expectedClaimId: claimId,
      isTrustedAuthor: (login) => trusted.has(normalizeLogin(login)),
    });
    return watermark !== null && isFullSha(watermark.headSha)
      ? watermark.headSha
      : null;
  } catch (error) {
    notes.push(
      `the comments of pull request ${prNumber} could not be read: ${describeError(error)}`,
    );
    return null;
  }
}
function describeOutcome(
  input,
  verdict,
  reason,
  proof,
  extra = {},
  notes = [],
) {
  const nextAction =
    extra.nextAction ??
    (verdict === 'stop'
      ? STOP_NEXT_ACTION
      : reason === null
        ? undefined
        : NEXT_ACTION[reason]);
  const output = {
    mode: input.apply ? 'apply' : 'dry-run',
    type: 'f4-head-proof',
    target: 'issue',
    number: input.issueNumber,
    verdict,
    reason,
    proof,
    ...extra,
    ...(nextAction === undefined ? {} : { nextAction }),
    ...(notes.length === 0 ? {} : { warnings: [...notes] }),
  };
  return {
    kind: 'verdict',
    exitCode: verdict === 'proceed' || verdict === 'post' ? 0 : 1,
    output,
  };
}
function emptyProof(claimId) {
  return {
    pr: null,
    claim: claimId,
    branch: null,
    f2: null,
    branchTip: null,
    merge: null,
    head: null,
  };
}
function refusedClaim(input, notes) {
  return describeOutcome(
    input,
    'hold',
    'claim-or-lock',
    emptyProof(input.claimId),
    {},
    notes,
  );
}
/**
 * One reading of the claim: `resume-claim-routing --assert` and the claim
 * lock of the worktree. `refused` is a reading that could not be obtained (a
 * throw, an unreadable check, or a malformed lock), with the cause added to
 * `notes`. Otherwise `claimOk` is true only when the check says the claim is
 * this session's and the lock carries this claim ID. The flow reads it once
 * up front and once more right before the POST.
 */
function readClaim(input, deps, nonce, notes) {
  let assertion;
  try {
    assertion = deps.assertClaim({
      issueNumber: input.issueNumber,
      claimId: input.claimId,
      nonce,
      worktree: input.worktree,
    });
  } catch (error) {
    assertion = { status: 'unreadable', detail: describeError(error) };
  }
  if (assertion.status === 'unreadable') {
    notes.push(`the claim check could not be read: ${assertion.detail}`);
    return { kind: 'refused' };
  }
  let lock;
  try {
    lock = deps.checkLock(input.worktree);
  } catch (error) {
    notes.push(`the claim lock read failed: ${describeError(error)}`);
    return { kind: 'refused' };
  }
  if (lock.malformed === true) {
    notes.push('the claim lock is malformed');
    return { kind: 'refused' };
  }
  return {
    kind: 'read',
    claimOk:
      assertion.status === 'owned' &&
      lock.present &&
      lock.holder?.claimId === input.claimId,
    branch: assertion.status === 'owned' ? assertion.branch : '',
  };
}
/**
 * Run the F4 head-proof flow. Returns `refused` for a usage-level refusal
 * (an unregistered `--worktree`, or a repository the checkout's origin does
 * not name); otherwise `verdict` with the exit code and
 * the JSON to print. Throws when the renderer rejects a derived value, with
 * nothing posted.
 */
export function runF4HeadProofGate(input, deps) {
  // The claim ID and agent ID are the two rendered values that come from
  // flags. Fail on a bad one before any read, with the renderer's own error.
  const placeholder = '0'.repeat(40);
  renderF4HeadProofBody({
    pr: '1',
    claim: input.claimId,
    branch: 'issue/1-placeholder',
    f2: placeholder,
    branchTip: placeholder,
    merge: placeholder,
    head: placeholder,
    agentId: input.agentId,
  });
  const registered = deps.isRegisteredWorktree(input.worktree);
  if (registered !== true) {
    return {
      kind: 'refused',
      message:
        registered === null
          ? 'the registered worktrees of this repository could not be read (git worktree list --porcelain failed)'
          : `--worktree ${input.worktree} is not a worktree that git worktree list --porcelain registers for this repository`,
    };
  }
  const repositoryError = deps.checkoutRepositoryError();
  if (repositoryError !== null) {
    return { kind: 'refused', message: repositoryError };
  }
  const notes = [];
  // The nonce comes from the stored activation record. A read that throws, or
  // is absent, malformed, or has no nonce, is a refusal, not a negative claim
  // result.
  let nonce = '';
  try {
    const tokens = deps.readTokens(input.worktree, input.claimId);
    nonce =
      tokens.status === 'present' ? (tokens.record.nonce ?? '').trim() : '';
    if (nonce === '') {
      notes.push(
        tokens.status === 'present'
          ? 'the stored activation record has no nonce'
          : `the stored activation record is ${tokens.status}`,
      );
    }
  } catch (error) {
    notes.push(`the activation record read failed: ${describeError(error)}`);
  }
  if (nonce === '') {
    return refusedClaim(input, notes);
  }
  const claim = readClaim(input, deps, nonce, notes);
  if (claim.kind === 'refused') {
    return refusedClaim(input, notes);
  }
  const { claimOk, branch } = claim;
  let markersRead = true;
  let entries = [];
  let claimActivatedAt = null;
  if (claimOk) {
    try {
      const issue = readIssueMarkers(deps, input.issueNumber, input.claimId);
      entries = issue.entries;
      claimActivatedAt = findClaimActivationTime(
        issue.comments,
        input.claimId,
        branch,
        issue.trusted,
      );
    } catch (error) {
      markersRead = false;
      notes.push(
        `the comments of issue ${input.issueNumber} could not be read: ${describeError(error)}`,
      );
    }
  }
  const superseding = applySupersession(entries);
  for (const [malformedId, supersederId] of superseding.supersededBy) {
    notes.push(
      `reported: malformed f4 head-proof comment ${malformedId} is set aside by superseding proof comment ${supersederId}; the superseding proof is judged on its own`,
    );
  }
  let refNameValid = false;
  if (claimOk) {
    try {
      refNameValid = deps.isValidRefName(branch);
    } catch (error) {
      notes.push(`the branch name check failed: ${describeError(error)}`);
    }
  }
  const localRef =
    claimOk && refNameValid
      ? readLocalRefSafely(deps, input.worktree, branch, notes)
      : { state: 'error', tip: null };
  const prNumber = claimOk
    ? lookupMergedPullRequest(deps, branch, notes)
    : null;
  const livePr =
    prNumber === null ? UNREADABLE_PR : readLivePr(deps, prNumber, notes);
  const f2 =
    prNumber === null
      ? null
      : readWatermarkHead(deps, prNumber, input.claimId, notes);
  const proofInput = {
    claimId: input.claimId,
    prNumber: prNumber ?? 0,
    branch,
    claimOk,
    livePr,
    refNameValid,
    localRef,
    claimActivatedAt,
    markers: superseding.markers,
    markersRead,
    watermarkAuthenticated: f2 !== null,
  };
  const proof = {
    pr: prNumber,
    claim: input.claimId,
    branch: branch === '' ? null : branch,
    f2,
    branchTip: localRef.state === 'present' ? localRef.tip : null,
    merge: livePr.mergeCommitSha,
    head: livePr.headSha,
  };
  let before = decideBeforePost(proofInput);
  const supersedes = input.supersedes;
  if (
    supersedes !== undefined &&
    (before.disposition === 'proceed' ||
      before.disposition === 'post' ||
      before.reason === 'conflicting-marker')
  ) {
    const refusal = supersedeRefusal(
      supersedes,
      entries,
      superseding.supersededBy,
    );
    if (refusal !== null) {
      return describeOutcome(input, 'hold', refusal.reason, proof, {}, [
        ...notes,
        refusal.note,
      ]);
    }
    if (
      before.disposition !== 'proceed' &&
      !superseding.supersededBy.has(supersedes)
    ) {
      // The target is the only proof left to set aside, so the post is judged
      // with no marker in the way: the watermark and the activation remain.
      before = decideBeforePost({ ...proofInput, markers: [] });
    }
  }
  if (before.disposition === 'proceed') {
    return describeOutcome(
      input,
      'proceed',
      before.reason,
      reusableProof(proofInput, proof),
      {},
      notes,
    );
  }
  if (before.disposition !== 'post') {
    return describeOutcome(
      input,
      before.disposition,
      before.reason,
      proof,
      {},
      notes,
    );
  }
  // A `post` verdict means the live PR, the local ref, the watermark, and the
  // claim activation are all known. The renderer validates every value again
  // and throws before anything is posted.
  const body = renderF4HeadProofBody({
    pr: String(prNumber),
    claim: input.claimId,
    branch,
    f2: f2 ?? '',
    branchTip: localRef.tip ?? '',
    merge: livePr.mergeCommitSha ?? '',
    head: livePr.headSha ?? '',
    agentId: input.agentId,
    ...(supersedes === undefined ? {} : { supersedes: String(supersedes) }),
  });
  if (!input.apply) {
    return describeOutcome(
      input,
      'post',
      null,
      proof,
      { body, nextAction: 'Rerun with --apply to post this proof.' },
      notes,
    );
  }
  const postedIdentity = identityOfPost(proofInput, claimActivatedAt, proof);
  // The claim was read before a series of live reads. Read it again at the
  // write boundary, so a claim released or a lock replaced meanwhile stops
  // the post instead of leaving a proof from a session that no longer owns
  // the claim.
  const final = readClaim(input, deps, nonce, notes);
  if (final.kind === 'refused') {
    return refusedClaim(input, notes);
  }
  if (!final.claimOk || final.branch !== branch) {
    const stopped = decideBeforePost({ ...proofInput, claimOk: false });
    notes.push('the claim or its lock changed before the post');
    return describeOutcome(
      input,
      stopped.disposition,
      stopped.reason,
      emptyProof(input.claimId),
      {},
      notes,
    );
  }
  let posted;
  try {
    posted = deps.postComment(input.issueNumber, body);
  } catch (error) {
    if (provesNothingSent(error)) {
      notes.push(`the post was rejected: ${describeError(error)}`);
      return describeOutcome(input, 'hold', 'post-rejected', proof, {}, notes);
    }
    notes.push(
      `the post failed, so it may have landed: ${describeError(error)}`,
    );
    const rereads = [];
    for (let attempt = 0; attempt < REREAD_COUNT; attempt += 1) {
      if (attempt > 0) {
        deps.sleep(REREAD_DELAY_MS);
      }
      rereads.push(readBack(deps, input, proofInput, notes));
    }
    const result = { writeOk: false, postedIdentity, rereads };
    return describeAfterPost(input, decideAfterPost(result), proof, notes);
  }
  const result = {
    writeOk: true,
    postedIdentity,
    refetch: readBack(deps, input, proofInput, notes),
  };
  return describeAfterPost(
    input,
    decideAfterPost(result),
    proof,
    notes,
    posted,
  );
}
function describeAfterPost(input, verdict, proof, notes, posted) {
  return describeOutcome(
    input,
    verdict.disposition,
    verdict.reason,
    proof,
    posted === undefined ? {} : { commentId: posted.id, url: posted.htmlUrl },
    notes,
  );
}
/** One post-write read of the issue's trusted same-claim markers. */
function readBack(deps, input, proofInput, notes) {
  try {
    const { entries } = readIssueMarkers(
      deps,
      input.issueNumber,
      input.claimId,
    );
    return classifyReread(applySupersession(entries).markers, proofInput);
  } catch (error) {
    notes.push(
      `a re-read of the issue comments failed: ${describeError(error)}`,
    );
    return classifyReread(null, proofInput);
  }
}
/**
 * The identity of the marker this command posts: derived with
 * `classifyReread`, never by hand. Both timestamps are the claim activation
 * time, which satisfies the timestamp rule; they are not part of identity.
 */
function identityOfPost(proofInput, claimActivatedAt, proof) {
  const posted = {
    claimId: proofInput.claimId,
    prNumber: proofInput.prNumber,
    branch: proofInput.branch,
    merge: proof.merge ?? '',
    head: proof.head ?? '',
    f2: proof.f2 ?? '',
    branchTip: proof.branchTip ?? '',
    createdAt: claimActivatedAt ?? '',
    updatedAt: claimActivatedAt ?? '',
  };
  const { identity } = classifyReread([posted], proofInput);
  if (identity === null) {
    throw new Error(
      'f4-head-proof: the marker about to be posted does not pass the verdict table, so nothing is posted',
    );
  }
  return identity;
}
/** The proof values of the reusable marker a `proceed` verdict rests on. */
function reusableProof(proofInput, fallback) {
  const marker = proofInput.markers.find((entry) => !('unparseable' in entry));
  if (marker === undefined) {
    return fallback;
  }
  return {
    pr: marker.prNumber,
    claim: marker.claimId,
    branch: marker.branch,
    f2: marker.f2,
    branchTip: marker.branchTip,
    merge: marker.merge,
    head: marker.head,
  };
}
