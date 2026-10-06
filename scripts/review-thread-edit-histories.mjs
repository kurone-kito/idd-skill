// idd-generated-from: src/scripts/review-thread-edit-histories.mts
//
// The scripts/review-thread-edit-histories.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import {
  attachReviewThreadCommentEditHistories,
  normalizeTrustedMarkerLogins,
  selectAdvisoryThreadCommentIdsEditedAfterDisposition,
} from './protocol-helpers.mjs';
/**
 * #3269, shared with the review-activity snapshot (#3655): the bounded second
 * pass that lets a cosmetic in-place edit of an advisory-bot thread comment
 * (e.g. CodeRabbit rewriting its own root comment when it replies to a
 * disposition) be dated by content activity instead of `updatedAt`. The
 * merge-gate collector, the snapshot collector, and F4
 * `audit-pr-cleanup.mts` (#3791) all call this, so those checks report
 * the same disposition result for the same pull request.
 *
 * It selects only advisory-bot comments edited after their thread's latest
 * disposition (`selectAdvisoryThreadCommentIdsEditedAfterDisposition`), makes
 * exactly one batched `getReviewThreadCommentUserContentEdits` call when there
 * is at least one candidate and none otherwise, and attaches the histories.
 * `dispositionAuthorLogins` MUST be the union of the logins the caller later
 * hands `summarizeDispositionEvidenceForGate` (its `iddAgentLogins` and
 * `trustedMarkerLogins`), or selection and freshness evaluation could
 * disagree about which comment anchors "the disposition". A failed fetch
 * degrades to no enrichment (every affected comment keeps `updatedAt`
 * dating) rather than failing the caller's whole collection. Returns
 * `threads` itself, by the same reference, when nothing was attached.
 */
export function enrichThreadsWithBotEditHistories(port, threads, options) {
  const dispositionAuthors = new Set(
    normalizeTrustedMarkerLogins([...options.dispositionAuthorLogins]),
  );
  const candidateIds = selectAdvisoryThreadCommentIdsEditedAfterDisposition(
    threads,
    {
      isDispositionAuthor: (login) => dispositionAuthors.has(login),
      advisoryBotLogins: options.advisoryBotLogins
        ? [...options.advisoryBotLogins]
        : null,
    },
  );
  if (candidateIds.length === 0) return threads;
  let histories = [];
  try {
    histories = port.getReviewThreadCommentUserContentEdits(candidateIds);
  } catch {
    // Fail closed to no enrichment: see
    // `resolveThreadCommentRevisionDatingOutcome`'s "unverifiable" outcome
    // for an absent or incomplete history (protocol-helpers.mts).
    return threads;
  }
  // `attachReviewThreadCommentEditHistories` is typed over the wider
  // structural `ThreadLike`, but it only adds `userContentEdits` to an
  // unchanged comment or returns a thread verbatim, so it never narrows `T`.
  return attachReviewThreadCommentEditHistories(threads, histories);
}
