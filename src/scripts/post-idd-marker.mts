#!/usr/bin/env node
// idd-generated-from: src/scripts/post-idd-marker.mts
//
// The scripts/post-idd-marker.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Write-side companion to emit-marker (#1047). IDD operational markers are
// HTML-comment-first, so an agent must POST them as a JSON body — the
// `gh issue comment` / `gh api -f body=` paths silently reject HTML-only
// bodies. This helper renders the canonical body for each operational marker
// type (reusing the single-sourced protocol-helpers renderers so formats are
// not duplicated) and POSTs it via the reliable JSON path.
//
// It is a single-marker render+POST primitive with NO claim/state gating, by
// design (the emit-marker philosophy). The calling phase runs its
// claim-revalidation gate immediately before invoking `--apply`, exactly as the
// manual POST path it replaces already requires.

import { createHash } from 'node:crypto';
import {
  type AuthoringOwnerProvenanceComment,
  fetchProvenanceCommentsGraphql,
  inspectLastEditedAt,
  looksLikeOwnerMarker,
  sameIssueRef,
} from './authoring-owner-provenance.mts';
import { isOutdatedMinimized } from './authoring-set-members.mts';
import {
  collectCiWaitState,
  type RequiredCiHeadAgreement,
  requiredCiHeadAgreementFromSummary,
} from './ci-wait-state.mts';
import { requireFlag, stripLeadingArgumentSeparator } from './cli-args.mts';
import { invalidateDiscoverHints } from './discover-hint-cache.mts';
import { renderF4HeadProofBody } from './f4-head-proof.mts';
import {
  type F4HeadProofValues,
  runF4HeadProofGate,
} from './f4-head-proof-gate.mts';
import {
  createLiveF4HeadProofDeps,
  resolveCheckoutRepository,
} from './f4-head-proof-live.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  classifyHelperError,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadIddConfig } from './idd-config.mts';
import {
  DEFAULT_MARKER_PREFIX,
  isValidIsoTimestamp,
  normalizeMarkerPrefix,
  type ParsedAuthoringOwnerMarker,
  parseAuthoringOwnerComment,
  renderScopeOverrunRecordComment,
} from './marker-helpers.mts';
import {
  isTrustedAuthor,
  resolveTrustedActors,
  runMinimize,
} from './minimize-superseded-markers.mts';
import {
  compareIsoTimestamps,
  matchCanonicalAuthoringMarkerFamily,
  parseCopilotUnavailableComment,
  parseReviewAckComment,
  renderActivationNonceMarker,
  renderAdvisoryRerollMarker,
  renderAdvisoryWaitMarker,
  renderAdvisoryWaitRecoveryMarker,
  renderAuthoringOwnerMarker,
  renderAuthoringPublicationIntentMarker,
  renderClaimedByMarker,
  renderCopilotUnavailableMarker,
  renderHoldMarker,
  renderOutOfLoopMarker,
  renderReviewAckMarker,
  renderReviewBaselineMarker,
  renderReviewWatermarkMarker,
  renderUnclaimedByMarker,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import { collectReviewActivitySnapshot } from './review-activity-snapshot.mts';

/**
 * Marker types whose prior same-family comments this module automatically
 * hides (classifier `OUTDATED`) immediately after a fresh instance POSTs
 * successfully under `--apply` -- the hide-at-post-time exception
 * documented in `docs/idd-comment-minimization.md`'s "## Timing" section
 * (#2754). Unlike the other `wired` families there (claim chain,
 * review-watermark/baseline, advisory-wait), which are agent-followed
 * instruction steps, this pair's grouping keys are purely mechanical
 * (embedded HEAD SHA mismatch; same `claim:` value), so the hide step is
 * code-automated directly inside this CLI's own `--apply` path instead.
 */
export const HIDE_AT_POST_TIME_MARKER_TYPES = [
  'review-ack',
  'copilot-unavailable',
] as const;

export type HideAtPostTimeMarkerType =
  (typeof HIDE_AT_POST_TIME_MARKER_TYPES)[number];

export function isHideAtPostTimeMarkerType(
  type: string,
): type is HideAtPostTimeMarkerType {
  return (HIDE_AT_POST_TIME_MARKER_TYPES as readonly string[]).includes(type);
}

export const MARKER_TYPES = [
  'claim',
  'unclaim',
  'activation-nonce',
  'watermark',
  'baseline',
  'advisory',
  'advisory-recovery',
  'advisory-reroll',
  'review-ack',
  'copilot-unavailable',
  'out-of-loop',
  'idd-hold',
  'f4-head-proof',
  'scope-overrun',
  'authoring-owner',
  'authoring-publication-intent',
] as const;

/**
 * #2931: `authoring-owner` / `authoring-publication-intent` are this CLI's
 * own `--type` vocabulary only -- an entirely separate list from
 * `OPERATIONAL_MARKERS` (marker-helpers.mts), which drives F4's post-merge
 * cleanup sweep and the hide-at-post-time classification in
 * `MARKER_HIDE_POLICY`. contract.md deliberately keeps these two authoring
 * marker families out of `OPERATIONAL_MARKERS` (they are issue-authoring
 * Stage 1/Stage 2 lifecycle records, not per-cycle execution markers, and
 * have their own opportunistic + Stage 2 hide-on-supersede sweep owned by
 * the issue-authoring protocol itself -- see contract.md's "Hide superseded
 * owner/publication-intent markers"). Adding them here only teaches this
 * posting helper how to render+POST their byte-exact canonical body; it
 * must never also add them to `OPERATIONAL_MARKERS`,
 * `IDD_AGENT_DERIVED_MARKERS`, `MARKER_HIDE_POLICY`, or this file's own
 * {@link HIDE_AT_POST_TIME_MARKER_TYPES} -- doing so would fold them into
 * the operational F4/hide-at-post-time machinery neither contract.md nor
 * this issue asks for, and `hideSupersededPostTimeMarkers` below assumes
 * every type it handles carries a `head-sha` (or `claim-id`/`attempt`)
 * field neither authoring type has.
 */
export type MarkerType = (typeof MARKER_TYPES)[number];

/**
 * The marker `type`s that accept `--from-pr <n>`. `watermark` derives all
 * four snapshot fields from one in-process review-activity capture;
 * the advisory-family types (`advisory` / `advisory-recovery` /
 * `advisory-reroll`, added in #1889; `review-ack`, added in #2050) derive
 * only `--head-sha` via the lighter {@link headShaFromPr} single `gh pr
 * view` call, since those renderers accept no other snapshot-shaped field.
 */
export const FROM_PR_MARKER_TYPES = [
  'watermark',
  'advisory',
  'advisory-recovery',
  'advisory-reroll',
  'review-ack',
] as const;

export type FromPrMarkerType = (typeof FROM_PR_MARKER_TYPES)[number];

/**
 * The kebab-case `--flag` field names each marker `type` requires, keyed
 * the same way {@link buildMarkerBody}'s own switch reads `fields` --
 * consulted by the `import.meta.main` CLI entry point below to report a
 * missing required field BY NAME (via `requireFlag`, cli-args.mts) before
 * `buildMarkerBody` is ever called, instead of surfacing that renderer's
 * own aggregate "invalid ... marker payload" guard with no indication of
 * which flag was absent (#1722). `supersedes` (claim), `max-activity-at` /
 * `ci-completed-at` (watermark) are deliberately OMITTED: the underlying
 * renderers default an absent or empty value to the `none` sentinel, so
 * requiring them here would reject input the renderer itself accepts.
 * `advisory-recovery`'s optional `claim-id` / `attempt` pair is also
 * omitted for the same reason -- passing neither renders the legacy
 * 3-field form; the renderer's own "must both be provided together"
 * message already names that half-bound case precisely. This CLI-layer
 * check stays defense-in-depth-complementary to, never a replacement for,
 * `buildMarkerBody`'s own per-type validation -- a direct caller of
 * `buildMarkerBody` (bypassing this CLI) still gets that renderer's
 * aggregate guard.
 *
 * `authoring-owner` / `authoring-publication-intent` (#2931) use
 * `--marker-target` / `--marker-owner` rather than bare `--target` /
 * `--owner` for their own `target=` / `owner=` marker fields: this CLI
 * already reserves `--target` for the posting-destination kind
 * (`issue`/`pr`) and `--owner` for the GitHub repository owner used to
 * resolve which repo to call, and the contract's `target=` / `owner=`
 * fields are unrelated values that would otherwise silently collide with
 * those two structural flags. The two marker families give `target=` /
 * `anchor=` DIFFERENT shapes (contract.md): `authoring-owner`'s are
 * `<owner>/<repo>#<number>` issue references (the same issue the marker
 * is posted to, hashed for `body-sha256` below), while
 * `authoring-publication-intent`'s are OPAQUE per-set ids with no issue
 * reference at all -- only that family's separate `journal=` / `issue=`
 * fields use the `<owner>/<repo>#<number>` shape. `--marker-target` /
 * `--anchor` accept either shape verbatim as opaque strings for
 * `authoring-publication-intent` (no parsing or fetch is ever attempted
 * for that type); only `authoring-owner`'s `--marker-target` is parsed
 * via {@link parseIssueReference} and fetched.
 * `authoring-owner`'s `body-sha256` is deliberately OMITTED here (unlike
 * every other listed field): the `import.meta.main` CLI entry point below
 * derives it from a live fetch of `--marker-target`'s current body when
 * omitted, or independently verifies an explicitly supplied value against
 * that same fetch, before this list is ever consulted -- see that block's
 * own doc comment. `snapshot-sha256` stays required and always explicit,
 * unlike `body-sha256`: docs/idd-autonomy-contract.md DOES define a
 * precise algorithm for it -- the SHA-256 digest, over UTF-8, of the
 * whole authoring set's `<owner>/<repo>#<number>:<body-sha256>` lines
 * (one per target, each using that target's own currently-verified
 * `body-sha256`). Canonicalize each `<owner>` and `<repo>` component as
 * `NFC(Unicode-default-lowercase(NFC(component)))`, join them with `/`, and
 * serialize every line with that normalized identity. Sort first by the
 * identity's UTF-8 bytes in unsigned lexicographic order (byte by byte, with
 * shorter equal prefixes first), then by issue number in ascending order and
 * join with `\n` with no trailing newline -- but that algorithm's inputs are
 * the already-verified digest records from every OTHER target in the
 * authoring session's own durable hold, cross-target state a single
 * `--marker-target` CLI
 * invocation has no way to enumerate (unlike `body-sha256`, which is
 * always exactly the one named target's own live body, fully resolvable
 * from that one target alone). Guessing a source for it here would risk
 * manufacturing a wrong digest under a confidence-inspiring "computed
 * automatically" banner, the opposite of this issue's goal.
 */
const REQUIRED_FIELDS_BY_TYPE: Record<MarkerType, readonly string[]> = {
  claim: ['agent-id', 'claim-id', 'timestamp', 'branch'],
  unclaim: ['agent-id', 'claim-id', 'timestamp'],
  'activation-nonce': ['agent-id', 'claim-id', 'nonce', 'timestamp'],
  watermark: ['agent-id', 'claim-id', 'head-sha', 'total-item-count'],
  baseline: ['agent-id', 'claim-id', 'sha'],
  advisory: ['agent-id', 'head-sha', 'timestamp'],
  'advisory-recovery': ['agent-id', 'head-sha', 'timestamp'],
  'advisory-reroll': ['agent-id', 'head-sha', 'timestamp'],
  'review-ack': ['agent-id', 'head-sha', 'timestamp'],
  'copilot-unavailable': [
    'agent-id',
    'claim-id',
    'head-sha',
    'attempt',
    'timestamp',
  ],
  // kurone-kito/idd-skill#3328: `pr` and `reason` are deliberately
  // OMITTED here -- `pr` is CLI-injected from `--target pr <n>`'s own
  // positional number (never a separately typed flag, which could
  // otherwise disagree with the actual posting destination), and
  // `reason` is hardcoded `'bootstrap'` by the renderer (see
  // `buildMarkerBody`'s `'out-of-loop'` case and
  // {@link renderOutOfLoopMarker}'s own doc comment for why it is a
  // closed one-value enum), never user-supplied.
  'out-of-loop': ['agent-id', 'timestamp'],
  // kurone-kito/idd-skill#4310: same three fields as `unclaim`. The marker
  // records a worker's hold only; it carries no claim state of its own.
  'idd-hold': ['agent-id', 'claim-id', 'timestamp'],
  // kurone-kito/idd-skill#4368: the only flags the command takes. The seven
  // proof fields (`pr`, `branch`, `f2`, `branch-tip`, `merge`, `head`, and
  // the claim) are derived from live reads, never typed, so they are not
  // listed here; `worktree` is read by the gate and is not a body field.
  'f4-head-proof': ['agent-id', 'claim-id', 'worktree'],
  'scope-overrun': ['agent-id', 'effort', 'candidate-files'],
  'authoring-owner': [
    'marker-target',
    'anchor',
    'mode',
    'marker-owner',
    'set',
    'session',
    'snapshot-sha256',
    'supersedes',
  ],
  'authoring-publication-intent': [
    'marker-target',
    'anchor',
    'set',
    'session',
    'token',
    'journal',
    'issue',
    'actor',
    'state',
  ],
};

/**
 * Default `<marker-prefix>` for `authoring-owner` /
 * `authoring-publication-intent` when neither `--marker-prefix` nor
 * `.github/idd/config.json`'s `markerPrefix` supplies one -- the same
 * distributed default `authoring-owner-provenance.mts`'s own
 * `DEFAULT_MARKER_PREFIX` uses.
 */
const DEFAULT_AUTHORING_MARKER_PREFIX = 'idd-skill';

/** `--type` values that share the `--marker-prefix` default-resolution
 * step in the `import.meta.main` CLI entry point below (#2931). */
const AUTHORING_MARKER_TYPES = [
  'authoring-owner',
  'authoring-publication-intent',
] as const;

export const TARGET_KINDS = ['issue', 'pr'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** Raw `--flag value` field map, keyed by the CLI flag name (kebab-case). */
export type MarkerFields = Record<string, string>;

/** CLI output envelope for both dry-run and `--apply` modes. */
export interface PostIddMarkerResult {
  mode: 'dry-run' | 'apply';
  type: MarkerType;
  target: TargetKind;
  number: number;
  /** Present in dry-run: the byte-exact body that would be POSTed. */
  body?: string;
  /** Present in `--apply`: the created comment id. */
  commentId?: number;
  /** Present in `--apply`: the created comment URL. */
  url?: string;
  /**
   * #1833: present (non-empty) only for a `--from-pr` watermark whose fresh
   * snapshot already carries diagnostic evidence worth surfacing at post
   * time -- e.g. comments/threads with no disposition evidence at all
   * (`dispositionEvidence.missingRegularCommentCount` /
   * `.missingThreadCount`), which this watermark's `max-activity-at` /
   * `total-item-count` are about to fold in as if already reviewed.
   * #3482: omitted when `soleCauseAckOnlyPostDisposition` is exactly true
   * and no regular comment is still missing.
   * Diagnostic-only: never changes `mode`, `body`, or whether the marker
   * gets POSTed.
   * `--type f4-head-proof` (#4368) uses the same field for the one-line
   * causes behind its `reason` (a read the command swallowed, or the error
   * of a rejected or uncertain post); they explain the verdict and never
   * change it.
   */
  warnings?: string[];
  /**
   * Present only for `--operation-local`. The snapshot is the capture this
   * operation just collected. `watermarkFields` describe that same object.
   */
  operationLocal?: OperationLocalWatermarkView;
  /**
   * `--type f4-head-proof` only (#4368): the decision. `post` is a dry run
   * that would post; `proceed` means a proof is in place; `stop` and `hold`
   * end the run (exit 1).
   */
  verdict?: 'post' | 'proceed' | 'stop' | 'hold';
  /** `--type f4-head-proof` only: the reason code behind `verdict`; null for `post`. */
  reason?: string | null;
  /** `--type f4-head-proof` only: the proof values derived from the live reads. */
  proof?: F4HeadProofValues;
  /** `--type f4-head-proof` only: what to do next after a hold, stop, or dry run. */
  nextAction?: string;
}

/** Decision for one operation-local snapshot/watermark capture. */
export type OperationLocalDecision = 'publish' | 'defer' | 'refuse';

export type OperationLocalReasonCode =
  | 'publish'
  | 'required-checks'
  | 'present-run-failing'
  | 'expected-head'
  | 'new-head'
  | 'ci-completion'
  | 'ci-read'
  | 'prior-head'
  | 'same-head-activity'
  | 'base-ref';

/**
 * Stored watermark boundary from an earlier, separate operation. It bounds
 * activity only on the HEAD that watermark was recorded for, so the HEAD is
 * part of the boundary rather than something the caller has to remember.
 */
export interface OperationLocalPriorBoundary {
  headSha: string;
  totalItemCount: number;
  maxActivityUpdatedAt: string;
}

export interface OperationLocalWatermarkResult {
  snapshot: unknown;
  watermarkFields: MarkerFields;
  warnings: string[];
  decision: OperationLocalDecision;
  reasonCode: OperationLocalReasonCode;
  reason: string | null;
  /**
   * The underlying error of a `ci-read` refusal. The refusal still returns the
   * capture, but the CLI boundary needs the original error to classify it
   * (`transport` / `not-found`) the way a failed required-check read always
   * was, instead of reporting a generic `gate`.
   */
  cause?: unknown;
}

/** JSON view embedded in the CLI envelope. */
export interface OperationLocalWatermarkView {
  decision: OperationLocalDecision;
  reason: string | null;
  snapshot: unknown;
  watermarkFields: MarkerFields;
  warnings: string[];
}

/**
 * Build the canonical ready-to-post body for one operational marker type.
 * Pure and network-free: it dispatches to the single-sourced protocol-helpers
 * renderer for `type`, so the body stays byte-identical to what emit-marker and
 * the written marker formats produce. Throws on an unknown type or an invalid
 * field set (the renderer's own validation).
 */
export function buildMarkerBody(type: string, fields: MarkerFields): string {
  switch (type) {
    case 'claim':
      return renderClaimedByMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        supersedes: fields.supersedes,
        timestamp: fields.timestamp,
        branch: fields.branch,
      });
    case 'unclaim':
      return renderUnclaimedByMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        timestamp: fields.timestamp,
      });
    case 'activation-nonce':
      return renderActivationNonceMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        nonce: fields.nonce,
        timestamp: fields.timestamp,
      });
    case 'watermark':
      return renderReviewWatermarkMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        headSha: fields['head-sha'],
        maxActivityAt: fields['max-activity-at'],
        totalItemCount: fields['total-item-count'],
        ciCompletedAt: fields['ci-completed-at'],
      });
    case 'baseline':
      return renderReviewBaselineMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        sha: fields.sha,
      });
    case 'advisory':
      return renderAdvisoryWaitMarker({
        agentId: fields['agent-id'],
        headSha: fields['head-sha'],
        timestamp: fields.timestamp,
      });
    case 'advisory-recovery':
      // #1572: --claim-id / --attempt are OPTIONAL here so the shipped
      // AW3-R recovery flow's existing 3-field call keeps working
      // unchanged; passing both binds the marker for recovery-cycle
      // accounting (see renderAdvisoryWaitRecoveryMarker's own doc comment
      // for the fail-closed behavior on a half-bound pair).
      return renderAdvisoryWaitRecoveryMarker({
        agentId: fields['agent-id'],
        headSha: fields['head-sha'],
        timestamp: fields.timestamp,
        ...(fields['claim-id'] !== undefined
          ? { claimId: fields['claim-id'] }
          : {}),
        ...(fields.attempt !== undefined ? { attempt: fields.attempt } : {}),
      });
    case 'advisory-reroll':
      return renderAdvisoryRerollMarker({
        agentId: fields['agent-id'],
        headSha: fields['head-sha'],
        timestamp: fields.timestamp,
      });
    case 'review-ack':
      return renderReviewAckMarker({
        agentId: fields['agent-id'],
        headSha: fields['head-sha'],
        timestamp: fields.timestamp,
      });
    case 'copilot-unavailable':
      return renderCopilotUnavailableMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        headSha: fields['head-sha'],
        attempt: fields.attempt,
        timestamp: fields.timestamp,
      });
    case 'out-of-loop':
      // #3328: `fields.pr` is CLI-injected from `--target pr <n>`'s own
      // positional number (see the `import.meta.main` entry point below);
      // `reason` is always the literal `'bootstrap'` -- a direct caller of
      // this function bypassing the CLI must still supply both.
      return renderOutOfLoopMarker({
        agentId: fields['agent-id'],
        prNumber: fields.pr,
        reason: 'bootstrap',
        at: fields.timestamp,
      });
    case 'idd-hold':
      // #4310: the stamped hold marker a delegated worker posts on its
      // claimed issue (docs/idd-workflow.md, "Hold marker"). Informational:
      // posting it never starts, ends, or transfers a claim.
      return renderHoldMarker({
        agentId: fields['agent-id'],
        claimId: fields['claim-id'],
        timestamp: fields.timestamp,
      });
    case 'f4-head-proof':
      // #4368: the proof a claimed session posts on its issue before F4
      // step 3 (docs/idd-resume-detail.md, "F4 Head Proof"). The CLI path
      // never reaches this case: `--type f4-head-proof` is dispatched to
      // `runF4HeadProofCommand`, which derives every field except the agent
      // and claim IDs from live reads and renders through the same
      // `renderF4HeadProofBody`. This case serves programmatic callers and
      // the marker-type tests; the renderer validates each field and throws
      // on a value that could break the token.
      return renderF4HeadProofBody({
        pr: fields.pr,
        claim: fields['claim-id'],
        branch: fields.branch,
        f2: fields.f2,
        branchTip: fields['branch-tip'],
        merge: fields.merge,
        head: fields.head,
        agentId: fields['agent-id'],
        // #4442: the optional superseded comment ID, forwarded so that a
        // programmatic caller gets the same token as the CLI path.
        ...(fields.supersedes === undefined
          ? {}
          : { supersedes: fields.supersedes }),
      });
    case 'scope-overrun': {
      let candidateFiles: unknown;
      try {
        candidateFiles = JSON.parse(fields['candidate-files'] ?? '');
      } catch {
        throw new Error('--candidate-files must be a JSON array of paths');
      }
      return renderScopeOverrunRecordComment({
        markerPrefix: fields['marker-prefix'],
        agentId: fields['agent-id'],
        issueNumber: fields.issue,
        effort: fields.effort,
        candidateFiles,
        ...(fields['pull-request'] === undefined
          ? {}
          : { pullRequestNumber: fields['pull-request'] }),
        ...(fields.branch === undefined ? {} : { branch: fields.branch }),
        ...(fields['head-sha'] === undefined
          ? {}
          : { headSha: fields['head-sha'] }),
      });
    }
    case 'authoring-owner':
      // #2931: routes through the existing marker-helpers.mts renderer
      // unchanged (never a hand-formatted template), so the posted body
      // stays byte-exact canonical -- round-tripping through
      // matchCanonicalAuthoringMarkerFamily returns 'authoring-owner', not
      // null. `--marker-target` / `--marker-owner` map to the renderer's
      // `target` / `owner` fields (see REQUIRED_FIELDS_BY_TYPE's doc
      // comment for why they are not named `--target` / `--owner` here).
      // `body-sha256` arrives already resolved (auto-derived or verified)
      // by the CLI entry point below by the time this runs.
      return renderAuthoringOwnerMarker({
        markerPrefix: fields['marker-prefix'],
        target: fields['marker-target'],
        anchor: fields.anchor,
        mode: fields.mode,
        owner: fields['marker-owner'],
        set: fields.set,
        session: fields.session,
        bodySha256: fields['body-sha256'],
        snapshotSha256: fields['snapshot-sha256'],
        supersedes: fields.supersedes,
      });
    case 'authoring-publication-intent':
      // #2931: same byte-exact-canonical rationale as authoring-owner
      // above; this family has no digest field to derive or verify.
      // Unlike authoring-owner, `--marker-target` / `--anchor` here are
      // OPAQUE per-set ids (contract.md), not issue references -- passed
      // straight through as opaque strings, never parsed or fetched
      // against (only `journal` / `issue` carry an `<owner>/<repo>
      // #<number>` shape for this type).
      return renderAuthoringPublicationIntentMarker({
        markerPrefix: fields['marker-prefix'],
        target: fields['marker-target'],
        anchor: fields.anchor,
        set: fields.set,
        session: fields.session,
        token: fields.token,
        journal: fields.journal,
        issue: fields.issue,
        actor: fields.actor,
        state: fields.state,
      });
    default:
      throw new Error(
        `--type is required and must be one of: ${MARKER_TYPES.join(', ')}`,
      );
  }
}

/**
 * Map a `review-activity-snapshot` JSON object to the four snapshot-derived
 * `--type watermark` field flags, so `--from-pr` can fill them automatically
 * instead of the agent hand-copying a 40-char HEAD SHA and three timestamps.
 *
 * `ci-completed-at` is taken from `latestPassingCiCompletedAt` — the latest
 * *passing* (or treated-as-passed) CI completion — NOT `latestCiCompletedAt`.
 * That matches the E1 Step 2 `{latest-ci-completed-at}` definition and the
 * pre-merge-readiness currency diff, which compares the watermark CI field
 * against the live `latestPassingCiCompletedAt`; using the all-completed field
 * would post a value that differs from the hand-computed one and trips a false
 * F2 `ci-pass-drift`.
 *
 * The snapshot emits the `none` sentinel string (never `null`) for empty
 * timestamps; both are tolerated and forwarded as `none`. Throws (fail-closed)
 * when `headSha` / `totalItemCount` are absent or malformed so a broken
 * snapshot can never post a bogus watermark. ISO/count shape validation is left
 * to the single-sourced `renderReviewWatermarkMarker` reached via
 * `buildMarkerBody`.
 */
export function watermarkFieldsFromSnapshot(snapshot: unknown): MarkerFields {
  const snap = (snapshot ?? {}) as Record<string, unknown>;
  const headSha = snap.headSha;
  const totalItemCount = snap.totalItemCount;
  if (typeof headSha !== 'string' || headSha.trim() === '') {
    throw new Error('review-activity-snapshot is missing a usable headSha');
  }
  if (
    typeof totalItemCount !== 'number' ||
    !Number.isInteger(totalItemCount) ||
    totalItemCount < 0
  ) {
    throw new Error(
      'review-activity-snapshot is missing a usable totalItemCount',
    );
  }
  const isoOrNone = (value: unknown): string =>
    typeof value === 'string' && value.trim() !== '' ? value : 'none';
  return {
    'head-sha': headSha,
    'max-activity-at': isoOrNone(snap.maxActivityUpdatedAt),
    'total-item-count': String(totalItemCount),
    'ci-completed-at': isoOrNone(snap.latestPassingCiCompletedAt),
  };
}

/**
 * #1833: diagnostic-only warnings for a `--from-pr` watermark whose fresh
 * `review-activity-snapshot` already carries `dispositionEvidence` evidence
 * -- comments and/or threads with NO disposition reply at all, per the same
 * `summarizeDispositionEvidenceForGate` the F2 `missing-disposition-evidence`
 * gate uses. This is deliberately NOT `ackOnly.items`: that evidence is the
 * carve-out `diffReviewSnapshot` reads to treat post-disposition advisory-bot
 * courtesy acks as safe to fold into the watermark, so it is populated on
 * the routine, benign path (an ack after a correct disposition) and would
 * warn on exactly the cases that are fine. `dispositionEvidence`'s counters
 * are the opposite: genuinely undispositioned items, which the watermark is
 * about to silently mark "already reviewed" by folding their activity into
 * its `max-activity-at` / `total-item-count` fields. Surfacing that now, in
 * this command's own success output, lets the caller see it at post time
 * instead of discovering it only later via the readiness report's
 * `missing-disposition-evidence` route (or, if the item happens to look
 * ack-only-shaped, via `reviewCurrency.comparisonRoute`).
 *
 * #3482: stays silent when `soleCauseAckOnlyPostDisposition` is exactly
 * `true` and `missingRegularCommentCount` is 0. That is a resolved thread
 * whose only outstanding activity is a known courtesy ack, which the
 * pre-merge gate already treats as non-blocking. A missing or non-true
 * flag keeps today's warning, including a payload that sets the flag while
 * a regular comment is still missing.
 *
 * Returns `[]` when the snapshot carries no such evidence, including when
 * `dispositionEvidence` is absent or malformed (diagnostic-only: fails open,
 * never blocks or alters what gets POSTed).
 */
export function describeUnaddressedActivity(snapshot: unknown): string[] {
  const snap = (snapshot ?? {}) as {
    dispositionEvidence?: {
      missingRegularCommentCount?: unknown;
      missingThreadCount?: unknown;
      soleCauseAckOnlyPostDisposition?: unknown;
    } | null;
  };
  const missingComments = Number(
    snap.dispositionEvidence?.missingRegularCommentCount ?? 0,
  );
  const missingThreads = Number(
    snap.dispositionEvidence?.missingThreadCount ?? 0,
  );
  const commentCount =
    Number.isInteger(missingComments) && missingComments > 0
      ? missingComments
      : 0;
  const threadCount =
    Number.isInteger(missingThreads) && missingThreads > 0 ? missingThreads : 0;
  if (
    snap.dispositionEvidence?.soleCauseAckOnlyPostDisposition === true &&
    commentCount === 0
  ) {
    return [];
  }
  if (commentCount === 0 && threadCount === 0) {
    return [];
  }
  const parts: string[] = [];
  if (commentCount > 0) {
    parts.push(`${commentCount} comment${commentCount === 1 ? '' : 's'}`);
  }
  if (threadCount > 0) {
    parts.push(`${threadCount} thread${threadCount === 1 ? '' : 's'}`);
  }
  const itemTotal = commentCount + threadCount;
  const verb = itemTotal === 1 ? 'has' : 'have';
  const pronoun = itemTotal === 1 ? 'it' : 'them';
  // #4366: the warning names the refresh sequence rather than "before relying
  // on this watermark", which read as a stop. It stays diagnostic (it never
  // blocks the post). Ack-only replies are acceptable evidence: the watermark
  // refresh runs first, then F2's ack-only override is evaluated on that
  // refreshed snapshot. A plain comment is never ack-only, so the override
  // cannot clear one.
  const sentences = [
    `${parts.join(' and ')} ${verb} no disposition evidence as of this ` +
      `watermark, but its max-activity-at/total-item-count already cover ` +
      `${pronoun}.`,
    'On a standalone --from-pr post this warning is diagnostic and does not ' +
      'block the post.',
    'Ack-only replies to a disposition are acceptable evidence: when every ' +
      'remaining cause is one, re-run --from-pr to refresh the watermark ' +
      'first, then evaluate the ack-only override on that refreshed snapshot.',
  ];
  if (commentCount > 0) {
    sentences.push(
      'A plain comment with no disposition still needs its own disposition; ' +
        'the ack-only override does not cover it.',
    );
  }
  return [sentences.join(' ')];
}

/**
 * Findings a review carries only in its body, with no thread of their own
 * (for example CodeRabbit's "outside the diff" blocks), as the snapshot's
 * `embeddedFindings[].uncoveredCount` reports them (#3622). They advance the
 * capture's item count and latest activity like a comment does, but they
 * never show up in `dispositionEvidence`, so the boundary guard reads them
 * separately. A thread is the only thing that covers a finding, so the count
 * stays above zero after a plain-comment disposition; it is therefore not part
 * of the `warnings` a standalone `--from-pr` prints, only of a refusal's.
 */
function countUncoveredEmbeddedFindings(snapshot: unknown): number {
  const findings = (snapshot as { embeddedFindings?: unknown } | null)
    ?.embeddedFindings;
  if (!Array.isArray(findings)) return 0;
  let total = 0;
  for (const entry of findings) {
    const uncovered = Number(
      (entry as { uncoveredCount?: unknown } | null)?.uncoveredCount ?? 0,
    );
    if (Number.isInteger(uncovered) && uncovered > 0) total += uncovered;
  }
  return total;
}

function describeUncoveredEmbeddedFindings(snapshot: unknown): string[] {
  const count = countUncoveredEmbeddedFindings(snapshot);
  if (count === 0) return [];
  return [
    count === 1
      ? '1 review-body finding has no thread of its own, so the boundary ' +
        'guard cannot treat that review as handled.'
      : `${count} review-body findings have no thread of their own, so the ` +
        'boundary guard cannot treat those reviews as handled.',
  ];
}

function sameHeadActivityAdvanced(
  snapshot: unknown,
  prior: OperationLocalPriorBoundary,
): boolean {
  const snap = (snapshot ?? {}) as Record<string, unknown>;
  const count = snap.totalItemCount;
  if (typeof count === 'number' && count > prior.totalItemCount) {
    return true;
  }
  const max = snap.maxActivityUpdatedAt;
  if (typeof max !== 'string' || max.trim() === '' || max === 'none') {
    return false;
  }
  if (prior.maxActivityUpdatedAt === 'none') {
    return true;
  }
  return compareIsoTimestamps(max, prior.maxActivityUpdatedAt) > 0;
}

/** The most blocking present runs a deferral message names before "and N more". */
const MAX_NAMED_BLOCKING_RUNS = 5;

/**
 * Check names come from the PR's own workflows, so collapse any whitespace (a
 * newline would break the single-line stderr and JSON `reason`) and drop empty
 * names before they reach a message (#3670).
 */
function cleanBlockingRunNames(names: readonly string[]): string[] {
  const cleaned = names
    .map((name) => name.replace(/\s+/gu, ' ').trim())
    .filter((name) => name.length > 0);
  return [...new Set(cleaned)];
}

/** Name at most {@link MAX_NAMED_BLOCKING_RUNS} runs, then "and N more". */
function formatBlockingRunNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED_BLOCKING_RUNS);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/**
 * #4053: the required-CI/HEAD agreement the `--from-pr --type watermark` path
 * compares. Forwards `--global-only` into {@link collectCiWaitState}, which
 * resolves the global-only ignore list and reads the trusted base-ref
 * `ciGate.allowNoRequiredChecksInGlobalOnly` opt-in itself, since it already
 * owns the trusted ref, the head SHA, and the provider port. The port, config
 * loader, and activation resolver are injectable so tests drive this without
 * a live `gh` process.
 */
export function readWatermarkRequiredCiAgreement(input: {
  prNumber: number;
  owner: string;
  repo: string;
  globalOnly: boolean;
  createPort?: Parameters<typeof collectCiWaitState>[1];
  loadTrustedConfig?: Parameters<typeof collectCiWaitState>[2];
  resolveActivation?: Parameters<typeof collectCiWaitState>[3];
}): RequiredCiHeadAgreement {
  const argv = [
    '--pr',
    String(input.prNumber),
    '--owner',
    input.owner,
    '--repo',
    input.repo,
    ...(input.globalOnly ? ['--global-only'] : []),
  ];
  return requiredCiHeadAgreementFromSummary(
    collectCiWaitState(
      argv,
      input.createPort,
      input.loadTrustedConfig,
      input.resolveActivation,
    ),
  );
}

/**
 * Derive watermark fields from one fresh activity capture, then compare a
 * separate required-CI/HEAD agreement read. Does not accept a saved snapshot.
 * `collectRichActivity` runs once per call; a later operation must call again.
 * A thrown collector is an incomplete collection and does not become an empty
 * success snapshot. The agreement reader is not called in that case.
 */
export function runOperationLocalSnapshotWatermark(input: {
  prNumber: number;
  expectedHeadSha?: string;
  /**
   * #4803: the Step 1 base ref. When given (even empty, which refuses), the
   * publish-time required-CI agreement read must report this exact base ref.
   * Omitted means the guard is not applied.
   */
  expectedBaseRefName?: string;
  priorBoundary?: OperationLocalPriorBoundary | null;
  collectRichActivity: () => unknown;
  readRequiredCiAgreement: () => RequiredCiHeadAgreement;
}): OperationLocalWatermarkResult {
  let snapshot: unknown;
  try {
    snapshot = input.collectRichActivity();
  } catch (error) {
    throw new Error(
      `incomplete review-activity collection: ${(error as Error).message}`,
      { cause: error },
    );
  }
  let watermarkFields: MarkerFields;
  try {
    watermarkFields = watermarkFieldsFromSnapshot(snapshot);
  } catch (error) {
    throw new Error(
      `incomplete review-activity collection: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const warnings = describeUnaddressedActivity(snapshot);
  const liveHeadSha = watermarkFields['head-sha'];
  let agreement: RequiredCiHeadAgreement;
  try {
    agreement = input.readRequiredCiAgreement();
  } catch (error) {
    return {
      snapshot,
      watermarkFields,
      warnings,
      decision: 'refuse',
      reasonCode: 'ci-read',
      reason:
        `refusing to post watermark: could not read required-check state ` +
        `for PR ${input.prNumber}: ${(error as Error).message}`,
      cause: error,
    };
  }
  const expected = input.expectedHeadSha ?? '';
  if (expected && liveHeadSha.toLowerCase() !== expected.toLowerCase()) {
    return {
      snapshot,
      watermarkFields,
      warnings,
      decision: 'refuse',
      reasonCode: 'expected-head',
      reason:
        `refusing to post watermark: PR ${input.prNumber}'s live HEAD ` +
        `(${liveHeadSha}) no longer matches the Step 1 stored ` +
        `--expected-head-sha (${expected}); the branch moved between E1 ` +
        `Step 1 and Step 2. Re-run E1 from Step 1 against the new HEAD.`,
    };
  }
  const ciHead = agreement.headRefOid.trim();
  if (ciHead.toLowerCase() !== liveHeadSha.toLowerCase()) {
    return {
      snapshot,
      watermarkFields,
      warnings,
      decision: 'refuse',
      reasonCode: 'new-head',
      reason:
        `refusing to post watermark: PR ${input.prNumber}'s required-check ` +
        `read is for HEAD ${ciHead || '(empty)'}, which does not match the ` +
        `activity snapshot HEAD ${liveHeadSha}. Re-run --from-pr.`,
    };
  }
  if (input.expectedBaseRefName !== undefined) {
    const expectedBase = input.expectedBaseRefName;
    const liveBase = (agreement.baseRefName ?? '').trim();
    if (expectedBase === '' || liveBase !== expectedBase) {
      return {
        snapshot,
        watermarkFields,
        warnings,
        decision: 'refuse',
        reasonCode: 'base-ref',
        reason:
          `refusing to post watermark: PR ${input.prNumber}'s base ref is ` +
          `${liveBase || '(empty)'}, but Step 1 recorded ` +
          `${expectedBase || '(none)'}. The base branch moved since Step 1; ` +
          `re-run E1 from Step 1 against the current base.`,
      };
    }
  }
  if (
    input.priorBoundary &&
    input.priorBoundary.headSha.toLowerCase() !== liveHeadSha.toLowerCase()
  ) {
    return {
      snapshot,
      watermarkFields,
      warnings,
      decision: 'refuse',
      reasonCode: 'prior-head',
      reason:
        `refusing to post watermark: the stored prior boundary is for HEAD ` +
        `${input.priorBoundary.headSha}, but PR ${input.prNumber}'s live ` +
        `HEAD is ${liveHeadSha}. A boundary only bounds same-HEAD activity ` +
        `on the HEAD it was recorded for; drop --prior-* when no earlier ` +
        `watermark exists for this HEAD.`,
    };
  }
  if (
    input.priorBoundary &&
    (warnings.length > 0 || countUncoveredEmbeddedFindings(snapshot) > 0) &&
    sameHeadActivityAdvanced(snapshot, input.priorBoundary)
  ) {
    return {
      snapshot,
      watermarkFields,
      warnings: [...warnings, ...describeUncoveredEmbeddedFindings(snapshot)],
      decision: 'refuse',
      reasonCode: 'same-head-activity',
      reason:
        `refusing to post watermark: PR ${input.prNumber} has newly ` +
        `actionable same-HEAD activity beyond the stored watermark ` +
        `boundary. Route this snapshot to fresh triage; do not publish a ` +
        `watermark that marks those findings handled.`,
    };
  }
  if (!agreement.requiredChecksPassing) {
    if (agreement.noRequiredChecksConfigured) {
      // #3670: with no required check configured, the present runs decide CI,
      // so "required checks are not passing" names a cause that does not
      // exist. Say what actually holds the watermark back, and that E1 Step 2
      // treats it as a deferral (Step 2 deferred, E3 continues, an empty list
      // routes through E15/E14 and back to E1), not a deadlock.
      const blocking = cleanBlockingRunNames(agreement.blockingPresentRunNames);
      const deferral =
        `In E1 Step 2 this is a deferral, not a deadlock: continue to E3 ` +
        `(an empty list routes through E15/E14 and back to E1), then re-run ` +
        `--from-pr at E1 Step 2 once the present runs no longer block.`;
      const scope =
        `refusing to post watermark: PR ${input.prNumber} has no required ` +
        `check configured, so its present runs decide CI`;
      return {
        snapshot,
        watermarkFields,
        warnings,
        decision: 'defer',
        reasonCode:
          blocking.length > 0 ? 'present-run-failing' : 'required-checks',
        reason:
          blocking.length > 0
            ? `${scope}, and ${formatBlockingRunNames(blocking)} ` +
              `${blocking.length === 1 ? 'is' : 'are'} blocking. ${deferral}`
            : `${scope}, and they are not all passing yet. ${deferral}`,
      };
    }
    return {
      snapshot,
      watermarkFields,
      warnings,
      decision: 'defer',
      reasonCode: 'required-checks',
      reason:
        `refusing to post watermark: PR ${input.prNumber}'s required ` +
        `checks are not passing. Re-run --from-pr once they pass.`,
    };
  }
  const snapshotPassingCompletedAt = watermarkFields['ci-completed-at'];
  if (agreement.latestPassingCompletedAt !== snapshotPassingCompletedAt) {
    return {
      snapshot,
      watermarkFields,
      warnings,
      decision: 'refuse',
      reasonCode: 'ci-completion',
      reason:
        `refusing to post watermark: PR ${input.prNumber}'s live passing ` +
        `completion ${agreement.latestPassingCompletedAt} does not match ` +
        `the activity snapshot ci-completed-at ${snapshotPassingCompletedAt}. ` +
        `Re-run --from-pr.`,
    };
  }
  return {
    snapshot,
    watermarkFields,
    warnings,
    decision: 'publish',
    reasonCode: 'publish',
    reason: null,
  };
}

function operationLocalView(
  local: OperationLocalWatermarkResult,
): OperationLocalWatermarkView {
  return {
    decision: local.decision,
    reason: local.reason,
    snapshot: local.snapshot,
    watermarkFields: local.watermarkFields,
    warnings: local.warnings,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  type: string;
  target: string;
  number: number | null;
  /**
   * `--from-pr <n>`: derive `--head-sha` from PR <n>'s live current HEAD.
   * For `--type watermark`, also derives the three other snapshot fields
   * via the full `review-activity-snapshot` composition; for the
   * advisory-family types (#1889 / #2050), only `--head-sha` is derived. See
   * {@link FROM_PR_MARKER_TYPES}.
   */
  fromPr: number | null;
  /**
   * `--expected-head-sha <sha>`: `--from-pr --type watermark` only. The E1
   * Step 1 stored `{head-SHA}`. When set, fail closed (no post) if the
   * fresh `--from-pr` snapshot's live HEAD no longer matches it — the
   * branch moved between E1 Step 1 and this Step 2 call.
   */
  expectedHeadSha: string;
  /** `--operation-local`: return the capture and defer the post when CI is incomplete. */
  operationLocal: boolean;
  /**
   * `--global-only`: `--from-pr --type watermark` only (#4053). Forwarded to
   * the CI-wait read, which resolves the global-only profile so the
   * `ciGate.allowNoRequiredChecksInGlobalOnly` opt-in can pass.
   */
  globalOnly: boolean;
  priorHeadSha: string;
  /** #4803: the Step 1 base ref; required with --operation-local. */
  priorBaseRef: string;
  priorTotalItemCount: number | null;
  priorMaxActivityAt: string;
  apply: boolean;
  owner: string;
  repo: string;
  /** Forwarded to the `--from-pr` activity capture (snapshot input, not a field). */
  trustedMarkerLogins: string;
  /** Forwarded to the `--from-pr` activity capture (snapshot input, not a field). */
  advisoryBotLogins: string;
  /** The value flags the caller passed, even with an empty value, so a refusal
   * by presence sees `--owner ''`. */
  suppliedFlags?: string[];
  help: boolean;
  fields: MarkerFields;
}

/**
 * Parse a whole-token positive integer, failing closed on a suffixed typo
 * (`1047abc`), a non-numeric token, or a non-positive / unsafe magnitude — a
 * mis-parsed target number could POST a marker to the wrong issue/PR.
 */
function parsePositiveIntToken(token: string, label: string): number {
  const parsed = Number.parseInt(token, 10);
  if (!/^\d+$/.test(token) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}: ${token}`);
  }
  return parsed;
}

function parseNonNegativeIntToken(token: string, label: string): number {
  if (!/^\d+$/.test(token)) {
    throw new Error(`${label}: ${token}`);
  }
  const parsed = Number(token);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label}: ${token}`);
  }
  return parsed;
}

/** One `<owner>/<repo>#<number>` marker-target reference, parsed. */
export interface ParsedIssueReference {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parse the contract.md `<owner>/<repo>#<number>` shape (#2931). Used
 * ONLY for `authoring-owner`'s own `target=` field (its `<owner>/<repo>
 * #<number>` issue reference) -- NOT for `authoring-publication-intent`,
 * whose `target=` / `anchor=` are opaque per-set ids with no issue
 * reference at all (contract.md); this CLI never parses or fetches
 * against that family's `--marker-target` / `--anchor`. Returns `null` on
 * anything else -- no whitespace tolerance, no bare-number shorthand, no
 * `owner/repo` without a number -- so a malformed `--marker-target` fails
 * closed with a targeted error instead of this CLI's live-body fetch
 * below silently hitting the wrong repository or throwing an opaque `gh
 * api` error. This parser itself stays independent of this CLI's own
 * `--owner` / `--repo` / `<number>` posting-destination flags -- it only
 * validates SHAPE -- but the `import.meta.main` CLI entry point below DOES
 * enforce that `authoring-owner`'s `--marker-target` (and, separately,
 * `authoring-publication-intent`'s `--journal`) names the exact same issue
 * as the resolved posting destination (`isPostingDestination`,
 * kurone-kito/idd-skill#2931, Codex/Copilot review on PR #2937): a marker
 * whose `target=` differs from where it is actually posted is a
 * permanently invalid append-only comment on one issue with no ownership
 * evidence on the other.
 */
export function parseIssueReference(ref: string): ParsedIssueReference | null {
  const match = ref.trim().match(/^([^\s/#]+)\/([^\s/#]+)#([1-9]\d*)$/);
  if (!match) {
    return null;
  }
  const number = Number(match[3]);
  // #2931 (Copilot review on PR #2937): the regex has no upper bound on
  // digit count, so an absurdly long numeric suffix could overflow past
  // Number.MAX_SAFE_INTEGER. Real GitHub issue numbers never approach this,
  // but parsePositiveIntToken above already applies the same guard to the
  // CLI's own positional <number>, so apply it here too rather than leave
  // this one parser silently inconsistent.
  if (!Number.isSafeInteger(number)) {
    return null;
  }
  return { owner: match[1], repo: match[2], number };
}

/**
 * True when `ref` names the exact same GitHub issue/PR as the CLI's own
 * resolved posting destination (`owner` / `repo` / `number`). GitHub logins
 * and repository names are case-insensitive, so owner/repo compare
 * case-folded; the issue/PR number compares exactly.
 *
 * Used by the `import.meta.main` CLI entry point below to enforce that
 * `authoring-owner`'s `--marker-target` and `authoring-publication-intent`'s
 * `--journal` name the SAME issue the marker is actually about to be
 * POSTed to (kurone-kito/idd-skill#2931, Codex/Copilot review on PR #2937,
 * corroborated critical finding): without this check, an unvalidated
 * `--marker-target` / `--journal` could hash or reference one issue while
 * the append-only comment lands on a completely different one, permanently
 * corrupting both issues' authoring state -- precisely the incident class
 * #2931 exists to close. Deliberately NOT applied to `authoring-owner`'s
 * `--anchor`: contract.md's `anchor` field records the SET's anchor issue,
 * which legitimately differs from the posting destination for every
 * non-anchor member of a multi-target set ("the anchor's own marker uses
 * its target as the anchor, and every other marker in the set repeats the
 * same value") -- `--anchor` is format-validated only, never destination-
 * compared.
 */
function isPostingDestination(
  ref: ParsedIssueReference,
  owner: string,
  repo: string,
  number: number,
): boolean {
  return (
    ref.owner.toLowerCase() === owner.toLowerCase() &&
    ref.repo.toLowerCase() === repo.toLowerCase() &&
    ref.number === number
  );
}

/**
 * `authoring-owner` `--mode` values whose `body-sha256` must always be a
 * REAL live-body digest (docs/idd-autonomy-contract.md's "Portable
 * authoring-owner protocol" section) -- the `none` sentinel is invalid
 * for these five "target" modes.
 */
const AUTHORING_OWNER_REAL_BODY_DIGEST_MODES = new Set([
  'acquire',
  'resume',
  'bootstrap',
  'heartbeat',
  'release',
]);

/**
 * `authoring-owner` `--mode` values that are anchor-only and whose
 * `body-sha256` must always be the literal `none` sentinel -- never
 * omitted (which would trigger this file's live-fetch auto-derivation)
 * and never a real digest.
 */
const AUTHORING_OWNER_NONE_BODY_DIGEST_MODES = new Set([
  'release-guard',
  'release-complete',
]);

/**
 * Validate contract.md's `--mode` <-> digest-sentinel coupling for
 * `authoring-owner` (docs/idd-autonomy-contract.md's "Portable
 * authoring-owner protocol" section; kurone-kito/idd-skill#2931 C1
 * review finding). Enforced here -- not by the reused renderer, which
 * validates field SHAPE only (a non-empty token or a `none|<64-hex>`
 * pattern), never this cross-field coupling -- because owner comments
 * are APPEND-ONLY: a marker posted with the wrong sentinel for its own
 * `mode` is a permanent, uncorrectable defect once it lands, exactly the
 * class of incident this issue exists to close.
 *
 * - The five {@link AUTHORING_OWNER_REAL_BODY_DIGEST_MODES} always carry a
 *   REAL live-body `body-sha256`; the sentinel `none` is invalid for them.
 * - The two {@link AUTHORING_OWNER_NONE_BODY_DIGEST_MODES} always carry
 *   `body-sha256=none`; an omitted `--body-sha256` (which would otherwise
 *   trigger this file's live-fetch auto-derivation) or an explicit real
 *   digest are both invalid for them.
 * - Only `release-complete` carries a REAL `snapshot-sha256` (its
 *   "canonical set snapshot digest"); every other valid mode requires
 *   `snapshot-sha256=none`.
 *
 * Returns an error message describing the violated rule, or `null` when
 * `mode` is absent/unrecognized (left to `REQUIRED_FIELDS_BY_TYPE` /
 * the renderer's own mode-enum validation to report) or the fields are
 * coupling-consistent. Never itself validates `body-sha256` /
 * `snapshot-sha256`'s SHAPE (`none` vs. 64-hex) -- that stays the
 * renderer's job; this only checks the two sentinels agree with `mode`.
 */
export function validateAuthoringOwnerModeDigestCoupling(
  fields: MarkerFields,
): string | null {
  // #2931 (Codex review on PR #2937): trim the same way this file's own
  // CLI-level normalization step and marker-helpers.mts's
  // normalizeNonWhitespaceToken do, so a padded value like `--mode
  // ' acquire '` -- which the renderer trims and happily accepts as
  // canonical `mode=acquire` -- cannot silently bypass this Set-membership
  // check by matching nothing. Defensive here too (not just at the CLI
  // entry point) since this function is exported and directly unit-tested.
  const mode = fields.mode?.trim();
  const bodySha256 = fields['body-sha256']?.trim();
  const snapshotSha256 = fields['snapshot-sha256']?.trim();
  if (
    AUTHORING_OWNER_REAL_BODY_DIGEST_MODES.has(mode) &&
    bodySha256 === 'none'
  ) {
    return (
      `--mode ${mode} requires a real --body-sha256 (auto-derived from a ` +
      "live fetch, or an explicit digest) -- the anchor-only 'none' " +
      'sentinel is only valid for release-guard/release-complete ' +
      '(docs/idd-autonomy-contract.md)'
    );
  }
  if (
    AUTHORING_OWNER_NONE_BODY_DIGEST_MODES.has(mode) &&
    bodySha256 !== 'none'
  ) {
    return (
      `--mode ${mode} is anchor-only and requires --body-sha256 none ` +
      '(docs/idd-autonomy-contract.md) -- pass it explicitly; omitting ' +
      '--body-sha256 or passing a real digest is invalid for this mode'
    );
  }
  if (mode === 'release-complete') {
    if (snapshotSha256 === 'none') {
      return (
        '--mode release-complete requires a real --snapshot-sha256 (the ' +
        'canonical set snapshot digest), not none ' +
        '(docs/idd-autonomy-contract.md)'
      );
    }
    return null;
  }
  if (
    (AUTHORING_OWNER_REAL_BODY_DIGEST_MODES.has(mode) ||
      AUTHORING_OWNER_NONE_BODY_DIGEST_MODES.has(mode)) &&
    snapshotSha256 !== undefined &&
    snapshotSha256 !== 'none'
  ) {
    return (
      `--mode ${mode} requires --snapshot-sha256 none -- only ` +
      'release-complete carries a real canonical set snapshot digest ' +
      '(docs/idd-autonomy-contract.md)'
    );
  }
  return null;
}

/**
 * `authoring-owner` `--mode` values whose `--supersedes` must be the
 * literal `none` sentinel (contract.md: "supersedes=none for acquire and
 * bootstrap" -- there is no prior owner to supersede when a generation
 * opens fresh).
 */
const AUTHORING_OWNER_NONE_SUPERSEDES_MODES = new Set(['acquire', 'bootstrap']);

/**
 * `authoring-owner` `--mode` values that RETAIN the current owner token
 * rather than minting a new one, so their `--supersedes` must equal this
 * same marker's own `--marker-owner` exactly (contract.md: "For release,
 * retain the current owner token in owner and set supersedes to that same
 * current owner token"; the identical "retain ... set supersedes to that
 * owner token" wording also covers heartbeat, release-guard, and
 * release-complete).
 */
const AUTHORING_OWNER_SELF_SUPERSEDES_MODES = new Set([
  'release',
  'heartbeat',
  'release-guard',
  'release-complete',
]);

/**
 * Validate contract.md's `--mode` <-> `--supersedes` coupling for
 * `authoring-owner` (kurone-kito/idd-skill#2931, Codex review on PR #2937).
 * Distinct from {@link validateAuthoringOwnerModeDigestCoupling}'s
 * body-sha256/snapshot-sha256 coupling -- this checks the THIRD field
 * contract.md's mode table constrains. Enforced here for the same
 * append-only-comment reason that function documents: a marker posted with
 * the wrong `supersedes` for its own mode is a permanent, uncorrectable
 * defect once it lands.
 *
 * - {@link AUTHORING_OWNER_NONE_SUPERSEDES_MODES} (`acquire` / `bootstrap`)
 *   always carry `supersedes=none`.
 * - `resume` mints a brand-new `owner` token (contract.md: "For acquire,
 *   bootstrap, and resume, owner is a newly generated opaque per-target
 *   owner token"), so its `supersedes` must be a REAL prior-owner token
 *   that is NOT the same as this marker's own `--marker-owner` -- a resume
 *   marker whose `supersedes` equals its own `owner` could never be told
 *   apart from a marker that supersedes nothing.
 * - {@link AUTHORING_OWNER_SELF_SUPERSEDES_MODES} (`release` / `heartbeat` /
 *   `release-guard` / `release-complete`) all retain the current owner
 *   token, so their `supersedes` must equal `--marker-owner` exactly.
 *
 * Returns `null` when `mode`, `supersedes`, or `marker-owner` is
 * absent/unrecognized (left to `REQUIRED_FIELDS_BY_TYPE` / the renderer's
 * own validation to report by name) or the fields are already
 * coupling-consistent.
 */
export function validateAuthoringOwnerSupersedesModeCoupling(
  fields: MarkerFields,
): string | null {
  // #2931 (Codex review on PR #2937): trim for the same reason
  // validateAuthoringOwnerModeDigestCoupling does -- see that function's
  // own comment on this same pattern.
  const mode = fields.mode?.trim();
  const supersedes = fields.supersedes?.trim();
  const markerOwner = fields['marker-owner']?.trim();
  if (supersedes === undefined || markerOwner === undefined) {
    return null;
  }
  // #2931 (Codex review on PR #2937, round 7): contract.md's `owner=` is
  // ALWAYS "a newly generated [or retained] opaque per-target owner
  // token" -- never the `none` sentinel, for any mode. Checked once, for
  // every recognized mode, rather than per-branch below: the equality
  // check further down (`supersedes !== markerOwner`) would otherwise
  // trivially PASS a `--marker-owner none --supersedes none` combination
  // for release/heartbeat/release-guard/release-complete (contract.md
  // 1401-1404 explicitly forbids `supersedes=none` for release, but a
  // shared-sentinel equality check alone cannot tell "both real and
  // equal" from "both none" apart), leaving an append-only marker with
  // no real owner token.
  if (
    (AUTHORING_OWNER_NONE_SUPERSEDES_MODES.has(mode) ||
      mode === 'resume' ||
      AUTHORING_OWNER_SELF_SUPERSEDES_MODES.has(mode)) &&
    markerOwner === 'none'
  ) {
    return (
      '--marker-owner must be a real opaque per-target owner token, not ' +
      `the none sentinel -- invalid for --mode ${mode} ` +
      '(skills/issue-authoring/references/contract.md)'
    );
  }
  if (
    AUTHORING_OWNER_NONE_SUPERSEDES_MODES.has(mode) &&
    supersedes !== 'none'
  ) {
    return (
      `--mode ${mode} requires --supersedes none -- there is no prior ` +
      'owner to supersede when a generation opens fresh ' +
      '(skills/issue-authoring/references/contract.md)'
    );
  }
  if (mode === 'resume') {
    if (supersedes === 'none') {
      return (
        '--mode resume requires a real --supersedes (the prior owner ' +
        'token it replaces), not none ' +
        '(skills/issue-authoring/references/contract.md)'
      );
    }
    if (supersedes === markerOwner) {
      return (
        '--mode resume mints a NEW --marker-owner token, so --supersedes ' +
        '(the prior owner token it replaces) must differ from ' +
        '--marker-owner (skills/issue-authoring/references/contract.md)'
      );
    }
    return null;
  }
  if (
    AUTHORING_OWNER_SELF_SUPERSEDES_MODES.has(mode) &&
    supersedes !== markerOwner
  ) {
    return (
      `--mode ${mode} retains the current owner token, so --supersedes ` +
      'must equal --marker-owner exactly ' +
      '(skills/issue-authoring/references/contract.md)'
    );
  }
  return null;
}

/**
 * `authoring-publication-intent` `--state` values that require a REAL
 * `--issue` reference -- `none` is only ever valid at `state=pending`
 * (contract.md: "Append `state=pending; issue=none` before creation, then
 * append the returned identity while it remains `pending`, append `member`
 * only after the owner marker is verified"). Mirrors
 * `audit-authored-issue.mts`'s own `AUTHORING_PUBLICATION_INTENT_MEMBER_OR_LATER`
 * set exactly, since that file's replay logic already enforces this same
 * rule on read -- a record this CLI lets through with `issue=none` at one
 * of these three states is durable evidence replay will always reject
 * (kurone-kito/idd-skill#2931, Codex review on PR #2937).
 */
const AUTHORING_PUBLICATION_INTENT_MEMBER_OR_LATER = new Set([
  'member',
  'cleanup',
  'abandoned',
]);

/**
 * Validate contract.md's `--state` <-> `--issue` coupling for
 * `authoring-publication-intent` (kurone-kito/idd-skill#2931, Codex review
 * on PR #2937). Enforced here for the same append-only-comment reason
 * {@link validateAuthoringOwnerModeDigestCoupling} documents: a
 * `member`/`cleanup`/`abandoned` record posted with `issue=none` is a
 * permanent, uncorrectable defect that `audit-authored-issue.mts`'s replay
 * will always reject, even though this command would otherwise report
 * success.
 *
 * Returns `null` when `state` or `issue` is absent (left to
 * `REQUIRED_FIELDS_BY_TYPE` to report by name) or the fields are already
 * coupling-consistent (including every `state=pending` case, which may
 * freely carry `issue=none` OR a real reference).
 */
export function validateAuthoringPublicationIntentStateIssueCoupling(
  fields: MarkerFields,
): string | null {
  const state = fields.state?.trim();
  const issue = fields.issue?.trim();
  if (state === undefined || issue === undefined) {
    return null;
  }
  if (
    AUTHORING_PUBLICATION_INTENT_MEMBER_OR_LATER.has(state) &&
    issue.toLowerCase() === 'none'
  ) {
    return (
      `--state ${state} requires a real --issue reference -- issue=none ` +
      'is only valid at state=pending ' +
      '(skills/issue-authoring/references/contract.md)'
    );
  }
  return null;
}

/**
 * `authoring-owner` modes that open an owner generation. Only these count as
 * an opening marker of a target (#3910): the first valid acquisition,
 * bootstrap or resume marker wins within an open generation (contract.md).
 */
const AUTHORING_OWNER_OPENING_MODES = new Set([
  'acquire',
  'bootstrap',
  'resume',
]);

/**
 * `authoring-owner` continuation modes whose post must agree with an opening
 * marker of its target before it is sent (#3910), and whose set and anchor
 * must agree with the latest trusted owner marker of that target (#3899).
 * `acquire` and `bootstrap` use their separate anchor-generation preflight.
 */
const AUTHORING_OWNER_IDENTITY_CHECKED_MODES = new Set([
  'heartbeat',
  'release',
  'release-guard',
  'release-complete',
  'resume',
]);

/**
 * Appended to every identity refusal. A post made right after its opening
 * marker can read stale, so waiting out the settle delay and retrying tells a
 * lagging read apart from a real mismatch. The delay is
 * `claim.verifySettleDelay`, the one the authoring flows apply after a write
 * (docs/issue-authoring-skill.md).
 */
const AUTHORING_OWNER_IDENTITY_SETTLE_HINT =
  'A post made immediately after an opening marker can read stale: wait the settle delay (claim.verifySettleDelay, default PT5S) and retry before treating this as a real mismatch.';

/**
 * Appended to a refusal that names the latest trusted owner marker (#3899). A
 * marker posted in error stops counting once it is minimized as outdated, so
 * the check then compares with the marker before it.
 */
const AUTHORING_OWNER_LATEST_MARKER_HINT =
  'A marker posted in error can be minimized as outdated (docs/idd-comment-minimization.md); a minimized outdated marker is skipped by this check.';

/** One opening marker of a post's target, as the identity check selects it. */
export interface AuthoringOwnerOpeningMarker {
  id: number;
  parsed: ParsedAuthoringOwnerMarker;
}

/**
 * The latest trusted owner marker of a target (#3899): the last candidate in
 * (createdAt, id) order. `parsed` is `null` when the comment carries the owner
 * token but does not parse, so its set and anchor cannot be read.
 */
export interface AuthoringOwnerLatestMarker {
  comment: AuthoringOwnerProvenanceComment;
  parsed: ParsedAuthoringOwnerMarker | null;
  /**
   * True when this candidate's `createdAt` cannot be read as an instant. The
   * latest marker then cannot be determined, so the check refuses (#3899).
   */
  unreadableTime?: boolean;
  /**
   * True when this candidate parses but names another target. It is hosted on
   * this target, so the latest marker here cannot be trusted; the check refuses
   * when it is the latest (Codex P2 on #3899).
   */
  mistargeted?: boolean;
  /**
   * True when the read omitted this candidate's minimization state, or a
   * minimized candidate lacks its reason. It is not known to be outdated, so the
   * check refuses when it is the latest (Copilot on #3899).
   */
  unreadableMinimization?: boolean;
}

/**
 * The opening markers of `options.target` among `comments` (#3910). A comment
 * counts when it parses as an owner marker whose mode is acquire, bootstrap or
 * resume and whose `target=` names `options.target` (issue references compare
 * without regard to case). With `requireUnedited`, a comment whose body was
 * edited after posting, or whose edit state cannot be verified, does not count
 * (`inspectLastEditedAt`). With a non-empty `trustedLogins`, only its authors
 * count; an empty set applies no author filter. Minimized comments count: a
 * sweep hides superseded markers, and the history is still evidence. The
 * replay passes `requireUnedited: false`, because REST carries no edit state.
 */
export function selectAuthoringOwnerOpeningMarkers(
  comments: readonly AuthoringOwnerProvenanceComment[],
  options: {
    target: string;
    markerPrefix: string;
    trustedLogins: Set<string>;
    requireUnedited: boolean;
  },
): AuthoringOwnerOpeningMarker[] {
  const openers: AuthoringOwnerOpeningMarker[] = [];
  for (const comment of comments) {
    if (options.requireUnedited && inspectLastEditedAt(comment) !== null) {
      continue;
    }
    if (
      options.trustedLogins.size > 0 &&
      !isTrustedAuthor(comment.authorLogin, options.trustedLogins)
    ) {
      continue;
    }
    const parsed = parseAuthoringOwnerComment(
      comment.body,
      options.markerPrefix,
    );
    if (
      parsed === null ||
      !AUTHORING_OWNER_OPENING_MODES.has(parsed.mode) ||
      !sameIssueRef(parsed.target, options.target)
    ) {
      continue;
    }
    openers.push({ id: comment.id, parsed });
  }
  return openers;
}

/**
 * The latest trusted owner marker of `options.target` among `comments` (#3899).
 * A candidate is written by a trusted author (an empty set applies no author
 * filter, as in `selectAuthoringOwnerOpeningMarkers`), carries the owner token,
 * and is not minimized as outdated (`isOutdatedMinimized`, the rule the set
 * listing uses for superseded markers). A candidate that does not parse is kept,
 * because its target cannot be read and the check must then fail closed. A
 * parseable candidate that names another target is also kept, marked
 * `mistargeted`, because a trusted owner marker hosted on this target is never
 * skipped silently: when it is the latest, the check refuses. Any mode counts,
 * and the session is never compared.
 *
 * Two consequences follow from those rules. When every candidate is minimized
 * as outdated, the result is `null` and only the opening comparison applies.
 * A trusted comment that carries the owner token but does not parse blocks
 * every such post on its issue until it is minimized as outdated, even when
 * the token only appears in prose.
 */
export function selectLatestAuthoringOwnerMarker(
  comments: readonly AuthoringOwnerProvenanceComment[],
  options: {
    target: string;
    markerPrefix: string;
    trustedLogins: Set<string>;
  },
): AuthoringOwnerLatestMarker | null {
  let latest: AuthoringOwnerLatestMarker | null = null;
  for (const comment of comments) {
    if (
      options.trustedLogins.size > 0 &&
      !isTrustedAuthor(comment.authorLogin, options.trustedLogins)
    ) {
      continue;
    }
    // A read that omits the minimization state, or a minimized comment without
    // its reason, is not known to be outdated. It is kept and refuses the check
    // if it is the latest, rather than being treated as a visible marker.
    const unreadableMinimization =
      typeof comment.isMinimized !== 'boolean' ||
      (comment.isMinimized &&
        (typeof comment.minimizedReason !== 'string' ||
          comment.minimizedReason.trim() === ''));
    if (
      !looksLikeOwnerMarker(comment.body, options.markerPrefix) ||
      (!unreadableMinimization && isOutdatedMinimized(comment))
    ) {
      continue;
    }
    const parsed = parseAuthoringOwnerComment(
      comment.body,
      options.markerPrefix,
    );
    const mistargeted =
      parsed !== null && !sameIssueRef(parsed.target, options.target);
    // Order by the instant, not the string: an offset form such as +09:00 sorts
    // wrongly as a string, and the shared comparator orders only the canonical
    // Z form. A createdAt that is not a readable instant fails closed: it is
    // returned as the latest, and the check refuses on it.
    const time = Date.parse(comment.createdAt);
    if (!Number.isFinite(time)) {
      return { comment, parsed, unreadableTime: true };
    }
    const latestTime =
      latest === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(latest.comment.createdAt);
    if (
      latest === null ||
      time > latestTime ||
      (time === latestTime && comment.id > latest.comment.id)
    ) {
      latest = { comment, parsed, mistargeted, unreadableMinimization };
    }
  }
  return latest;
}

interface AuthoringOwnerIdentityDifference {
  field: string;
  posted: string;
  found: string;
}

/**
 * The fields on which `post` and one opening marker disagree (#3910). A resume
 * names the owner it supersedes, so its owner is compared with the post's
 * `--supersedes`; every other checked mode retains its owner. `session` is
 * never compared: the contract lets a release come from another session, as
 * the history of issue #3498 shows.
 */
function authoringOwnerIdentityDifferences(
  post: ParsedAuthoringOwnerMarker,
  opener: ParsedAuthoringOwnerMarker,
): AuthoringOwnerIdentityDifference[] {
  const postedOwner = post.mode === 'resume' ? post.supersedes : post.owner;
  const differences: AuthoringOwnerIdentityDifference[] = [];
  if (opener.set !== post.set) {
    differences.push({ field: 'set', posted: post.set, found: opener.set });
  }
  if (!sameIssueRef(opener.anchor, post.anchor)) {
    differences.push({
      field: 'anchor',
      posted: post.anchor,
      found: opener.anchor,
    });
  }
  if (opener.owner !== postedOwner) {
    differences.push({
      field: post.mode === 'resume' ? 'owner (--supersedes)' : 'owner',
      posted: postedOwner,
      found: opener.owner,
    });
  }
  return differences;
}

/**
 * Decide whether an `authoring-owner` post may be sent, given the opening
 * markers of its target (#3910). Returns `null` when one opening marker agrees
 * with the post on set, anchor and owner (resume: owner against `--supersedes`).
 * Otherwise returns the refusal, which names the closest opening marker by
 * comment id and each field that differs, with the value posted and the value
 * found. The closest marker has the fewest differing fields; a tie goes to the
 * earliest one, because the first valid opener wins its generation.
 *
 * When `latest` is given (#3899), an opening marker that agrees is not enough:
 * the set and anchor must also agree with the latest trusted owner marker of
 * the target. The opening comparison runs first and keeps its refusal text. A
 * latest marker that was edited or whose edit state is unknown, or that does
 * not parse, refuses; so does one whose set or anchor differs. Its owner and
 * session are not compared.
 */
export function validateAuthoringOwnerPostIdentity(
  post: ParsedAuthoringOwnerMarker,
  openers: readonly AuthoringOwnerOpeningMarker[],
  latest: AuthoringOwnerLatestMarker | null = null,
): string | null {
  const head = `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}`;
  let closest: {
    opener: AuthoringOwnerOpeningMarker;
    differences: AuthoringOwnerIdentityDifference[];
  } | null = null;
  for (const opener of openers) {
    const differences = authoringOwnerIdentityDifferences(post, opener.parsed);
    if (
      closest === null ||
      differences.length < closest.differences.length ||
      (differences.length === closest.differences.length &&
        opener.id < closest.opener.id)
    ) {
      closest = { opener, differences };
    }
  }
  if (closest === null) {
    return `${head}: no counted opening marker (acquire, bootstrap or resume) is recorded there. ${AUTHORING_OWNER_IDENTITY_SETTLE_HINT}`;
  }
  if (closest.differences.length === 0) {
    if (latest === null) {
      return null;
    }
    if (latest.unreadableTime) {
      return `${head}: a trusted owner marker on the target, comment #${latest.comment.id}, has a creation time that cannot be read, so the latest marker cannot be determined. ${AUTHORING_OWNER_LATEST_MARKER_HINT} ${AUTHORING_OWNER_IDENTITY_SETTLE_HINT}`;
    }
    const latestHead = `${head}: the latest trusted owner marker on the target is comment #${latest.comment.id}`;
    const unreadable = inspectLastEditedAt(latest.comment);
    if (unreadable !== null) {
      return `${latestHead}, which cannot be checked: ${unreadable}. ${AUTHORING_OWNER_LATEST_MARKER_HINT} ${AUTHORING_OWNER_IDENTITY_SETTLE_HINT}`;
    }
    if (latest.parsed === null) {
      return `${latestHead}, which does not parse as an authoring-owner marker, so its set and anchor cannot be checked. ${AUTHORING_OWNER_LATEST_MARKER_HINT} ${AUTHORING_OWNER_IDENTITY_SETTLE_HINT}`;
    }
    if (latest.unreadableMinimization) {
      return `${latestHead}, whose minimization state cannot be read completely, so it cannot be checked. ${AUTHORING_OWNER_LATEST_MARKER_HINT} ${AUTHORING_OWNER_IDENTITY_SETTLE_HINT}`;
    }
    if (latest.mistargeted) {
      return `${latestHead}, which names another target, so it cannot be the latest marker of this one. ${AUTHORING_OWNER_LATEST_MARKER_HINT} ${AUTHORING_OWNER_IDENTITY_SETTLE_HINT}`;
    }
    const latestDifferences: AuthoringOwnerIdentityDifference[] = [];
    if (latest.parsed.set !== post.set) {
      latestDifferences.push({
        field: 'set',
        posted: post.set,
        found: latest.parsed.set,
      });
    }
    if (!sameIssueRef(latest.parsed.anchor, post.anchor)) {
      latestDifferences.push({
        field: 'anchor',
        posted: post.anchor,
        found: latest.parsed.anchor,
      });
    }
    if (latestDifferences.length === 0) {
      return null;
    }
    const latestDetail = latestDifferences
      .map(
        (difference) =>
          `${difference.field}: posted ${difference.posted}, found ${difference.found}`,
      )
      .join('; ');
    return `${latestHead} (mode=${latest.parsed.mode}), which differs on ${latestDetail}. ${AUTHORING_OWNER_LATEST_MARKER_HINT} ${AUTHORING_OWNER_IDENTITY_SETTLE_HINT}`;
  }
  const detail = closest.differences
    .map(
      (difference) =>
        `${difference.field}: posted ${difference.posted}, found ${difference.found}`,
    )
    .join('; ');
  return `${head}: no opening marker agrees with it. The closest is comment #${closest.opener.id} (mode=${closest.opener.parsed.mode}), which differs on ${detail}. ${AUTHORING_OWNER_IDENTITY_SETTLE_HINT}`;
}

// Excluded from the #1446 cli-args.mts wrapper: `fields` below collects
// per-marker-type keys dynamically (each `--type` accepts a different
// field set) rather than a fixed declared spec. `util.parseArgs`'s
// `strict: true` rejects any option not named in its static spec, and
// `strict: false` would instead coerce every unrecognized flag to `true`
// -- neither matches this file's "accept whatever fields this marker type
// needs" contract.
export function parseArgs(rawArgv: string[]): CliArgs {
  // #1921/#2465: strip a pnpm-forwarded leading `--` the same way the
  // shared cli-args.mts wrapper does -- this parser is excluded from that
  // wrapper (see the comment above) so it must call the strip directly.
  const argv = stripLeadingArgumentSeparator(rawArgv);
  const args: CliArgs = {
    type: '',
    target: '',
    number: null,
    fromPr: null,
    expectedHeadSha: '',
    operationLocal: false,
    globalOnly: false,
    priorHeadSha: '',
    priorBaseRef: '',
    priorTotalItemCount: null,
    priorMaxActivityAt: '',
    apply: false,
    owner: '',
    repo: '',
    trustedMarkerLogins: '',
    advisoryBotLogins: '',
    suppliedFlags: [],
    help: false,
    fields: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--apply') {
      args.apply = true;
      continue;
    }
    if (token === '--operation-local') {
      args.operationLocal = true;
      continue;
    }
    if (token === '--global-only') {
      args.globalOnly = true;
      continue;
    }
    if (!token.startsWith('--')) {
      // The sole positional argument is the issue/PR number. Match the whole
      // token as a positive integer BEFORE converting: Number.parseInt would
      // silently accept a suffixed typo like `1047abc` / `1047-draft` as 1047
      // and, with --apply, post the marker to the wrong target. Fail closed.
      if (args.number !== null) {
        throw new Error(`unexpected positional argument: ${token}`);
      }
      args.number = parsePositiveIntToken(token, 'invalid issue/PR number');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for argument: ${token}`);
    }
    index += 1;
    if (token === '--type') {
      args.type = value;
    } else if (token === '--target') {
      args.target = value;
    } else if (token === '--from-pr') {
      args.fromPr = parsePositiveIntToken(value, 'invalid --from-pr number');
    } else if (token === '--expected-head-sha') {
      args.expectedHeadSha = value;
    } else if (token === '--prior-head-sha') {
      args.priorHeadSha = value;
    } else if (token === '--prior-base-ref') {
      args.priorBaseRef = value;
    } else if (token === '--prior-total-item-count') {
      args.priorTotalItemCount = parseNonNegativeIntToken(
        value,
        'invalid --prior-total-item-count',
      );
    } else if (token === '--prior-max-activity-at') {
      args.priorMaxActivityAt = value;
    } else if (token === '--owner') {
      args.suppliedFlags?.push(token);
      args.owner = value;
    } else if (token === '--repo') {
      args.suppliedFlags?.push(token);
      args.repo = value;
    } else if (token === '--trusted-marker-logins') {
      args.suppliedFlags?.push(token);
      args.trustedMarkerLogins = value;
    } else if (token === '--advisory-bot-logins') {
      args.suppliedFlags?.push(token);
      args.advisoryBotLogins = value;
    } else {
      // Any other --flag is a renderer field, stored under its kebab name.
      args.fields[token.slice(2)] = value;
    }
  }
  return args;
}

const USAGE = `usage: node scripts/post-idd-marker.mjs --type <type> --target <issue|pr> <number> [field flags...] [--apply]

Render the canonical HTML-comment-first body for an IDD operational marker
(advisory markers are plain-text per the AW3 protocol) and POST it via the
reliable JSON path. Default mode is dry-run, which prints a JSON envelope whose
\`body\` field is the marker; --apply POSTs it and prints the created comment
id/URL. This helper performs no claim/state gating — the calling phase must run
its claim-revalidation gate before --apply, as the manual POST path it replaces.
The one exception is --type f4-head-proof, which checks the claim itself (see
below).

  --type <type>        one of: ${MARKER_TYPES.join(', ')}
  --target <issue|pr>  the comment target kind (both use the issues comments API)
  <number>             issue or PR number (positional; required unless --from-pr)
  scope-overrun        issue only; requires --agent-id --effort
                       --candidate-files '<JSON array>'. Optional
                       --pull-request --branch --head-sha must be supplied
                       together to bind the record to a pushed PR head.
  --from-pr <n>        watermark: derive --head-sha / --max-activity-at /
                       --total-item-count / --ci-completed-at from one live
                       review-activity capture of PR <n>. The advisory-family
                       types (advisory / advisory-recovery / advisory-reroll,
                       #1889; review-ack, #2050): derive only --head-sha from
                       PR <n>'s live current head commit (a single
                       lightweight gh pr view call, not the full snapshot).
                       Either way the marker posts to PR <n>, so
                       --head-sha never needs hand-typing (always targets the
                       PR; an explicit non-pr --target is rejected). Not
                       network-free.
  --expected-head-sha <sha>  --from-pr --type watermark only: the E1 Step 1
                       stored {head-SHA}. Fails closed (posts nothing) if the
                       fresh snapshot's live HEAD no longer matches it, i.e.
                       the branch moved between E1 Step 1 and this Step 2
                       call.
  --global-only        --from-pr --type watermark only: resolve the global-only
                       profile in the CI read, so a zero-required-check run
                       can publish under the trusted
                       ciGate.allowNoRequiredChecksInGlobalOnly opt-in. Any
                       other path rejects the flag.
  --operation-local    --from-pr --type watermark only: also return the review
                       activity capture in the JSON envelope's operationLocal
                       field, and make a defer non-fatal: while required checks
                       are not passing (or, with none configured, the present
                       runs are not all passing), exit 0 and post nothing.
                       Every other refusal still exits 1 (HEAD or
                       CI-completion mismatch, unreadable check state, or the
                       --prior-* guard below, which is checked before the
                       defer). Read operationLocal.decision to tell the runs
                       apart, since --apply does not: publish posts the marker
                       (exit 0); defer exits 0 with "mode": "dry-run" and
                       posts nothing; refuse exits 1, posts nothing, and
                       prints the same envelope on stdout next to the reason
                       on stderr.
  --prior-base-ref <name>
                       --type watermark --from-pr only, and required there: the
                       PR base ref E1 Step 1 saw. Refuses (exit 1) when the
                       publish-time base ref differs.
  --prior-head-sha <sha>
  --prior-total-item-count <n>
  --prior-max-activity-at <iso|none>
                       --operation-local only, and only together: the head-SHA,
                       total-item-count and max-activity values E1 Step 1 saw
                       for the SAME HEAD. Refuses (exit 1) when that HEAD is
                       not the live HEAD, or when the capture still holds
                       undispositioned comments or threads, or findings in a
                       review body that has no thread for them, and its
                       activity has advanced past the boundary, so it routes
                       back to triage instead of being marked handled.
  --apply              POST the marker (default: dry-run prints it in a JSON envelope)
  --owner <owner>      repo owner (default: gh repo view)
  --repo <repo>        repo name (default: gh repo view)
  -h, --help           show this help

Per-type field flags (flags in [brackets] are optional; every other flag
listed is required for that type):
  claim              --agent-id --claim-id [--supersedes] --timestamp --branch
  unclaim            --agent-id --claim-id --timestamp
  activation-nonce   --agent-id --claim-id --nonce --timestamp
  watermark          --agent-id --claim-id --head-sha [--max-activity-at] --total-item-count [--ci-completed-at]
                     (or --agent-id --claim-id --from-pr <n> [--expected-head-sha <sha>])
  baseline           --agent-id --claim-id --sha
  advisory           --agent-id --head-sha --timestamp
                     (or --agent-id --from-pr <n> --timestamp)
  advisory-recovery  --agent-id --head-sha --timestamp [--claim-id --attempt]
                     (or --agent-id --from-pr <n> --timestamp [--claim-id --attempt])
  advisory-reroll    --agent-id --head-sha --timestamp
                     (or --agent-id --from-pr <n> --timestamp)
  review-ack         --agent-id --head-sha --timestamp
                     (or --agent-id --from-pr <n> --timestamp)
  copilot-unavailable --agent-id --claim-id --head-sha --attempt --timestamp
  out-of-loop        --agent-id --timestamp --target pr <n> (reason is always
                     bootstrap; pr: is derived from <n>)
  idd-hold           --agent-id --claim-id --timestamp --target issue <n>
                     (the hold marker; informational, it never changes who
                     owns the claim)
  f4-head-proof      --agent-id --claim-id --worktree <path> --target issue <n>
                     [--supersedes <comment-id>] (the F4 head proof; every
                     proof field is read live, see below)
  authoring-owner    --marker-target --anchor --mode --marker-owner --set
                     --session --snapshot-sha256 --supersedes [--body-sha256]
                     [--marker-prefix]
  authoring-publication-intent  --marker-target --anchor --set --session
                     --token --journal --issue --actor --state
                     [--marker-prefix]

authoring-owner / authoring-publication-intent (#2931) render the
issue-authoring skill's Stage 1/Stage 2 ownership markers
(skills/issue-authoring/references/contract.md) via the same reliable JSON
path as every other type above, so the posted body is byte-exact canonical
(matchCanonicalAuthoringMarkerFamily, marker-helpers.mts, returns the
family name, never null). authoring-owner is NOT network-free even in
dry-run (like --from-pr above): whenever a live fetch is needed for
--body-sha256 (every case except the explicit none sentinel), it runs
regardless of --apply, so a dry-run preview shows the exact value that
would actually post. A dry run of an authoring-owner heartbeat, release,
release-guard, release-complete or resume also reads the target's comment
log for the identity check (#3899). Acquire and bootstrap read the declared
anchor's paginated owner log before dry-run output or POST. A self-anchor or
child post may use only a fresh set and valid open-generation state. When an
anchor log shows prior child memberships, each former anchor's owner log is
also read recursively, with cycle and depth guards, and must show the matching
set/session release-complete after the child's final marker. That completion
closes the former membership even when the child's release marker is minimized
as outdated, so a fresh acquisition may use a new set after closure (observed
during the 2026-10-24 review on PR #4677, thread #4367878222). Any later
self-anchored generation must open after the matching completion. Across the
target-wide first-opener race, a self opener posted after a foreign child opener
but before its matching completion loses; ignore that losing self generation
and its continuations through the next self opener (observed during the
2026-10-24 review on PR #4677, thread #4367884510). Closed set IDs, an open or
releasing generation, or unreadable history that cannot be replayed
conclusively refuses the post. Foreign openers under different anchors also
share this target-wide order; a later opener before the current winner's exact
completion loses (preventive; no observed incident yet). A completed history
with a fresh set remains valid. Concurrent first openers resolve by comment
order.
--marker-target / --marker-owner map to these
markers' own \`target=\` / \`owner=\` fields -- named with a \`marker-\`
prefix, not bare --target / --owner, because this CLI already reserves
those two names for the posting-destination kind and the repo owner used
to resolve which repo to call. The two types give --marker-target /
--anchor DIFFERENT shapes (contract.md): authoring-owner's are
\`<owner>/<repo>#<number>\` issue references, while
authoring-publication-intent's are OPAQUE per-set ids with no issue
reference at all (only that type's separate --journal/--issue use the
\`<owner>/<repo>#<number>\` shape) -- pass either verbatim as opaque
strings; this CLI never parses or fetches against
authoring-publication-intent's --marker-target/--anchor.
--marker-target (authoring-owner) and --journal (authoring-publication-
intent) MUST name the exact same issue as the resolved posting
destination (--owner/--repo/<number>, or the current repository's \`gh
repo view\` when --owner/--repo are omitted) -- checked in dry-run too, not
just --apply. A mismatch is refused with a targeted error before any
fetch or POST: an unvalidated value here could otherwise hash or
reference one issue while the append-only comment lands on a completely
different one, permanently corrupting both issues' authoring state
(kurone-kito/idd-skill#2925/#2931). --anchor (authoring-owner) is
FORMAT-validated only and is deliberately NEVER required to equal the
posting destination in general -- contract.md's anchor records the SET's
anchor issue, which legitimately differs from --marker-target for a
non-anchor member of a multi-target set -- EXCEPT for --mode release-guard
/ release-complete specifically, which contract.md makes "valid only on
the set anchor": for those two modes only, --anchor MUST equal
--marker-target. authoring-publication-intent's non-'none' --issue is
FORMAT-validated only, with no destination-equality requirement at all
(it names the issue this publication intent is ABOUT, which need not be
the --journal issue this marker posts to).
--body-sha256 is OPTIONAL (authoring-owner only): when omitted,
this CLI fetches --marker-target's current live body via the same
JSON-parsed \`gh api\` path every other read in this file already uses (never
a shell-captured \`--jq\` scalar -- the exact root cause of
kurone-kito/idd-skill#2925's bad digest) and hashes it; when supplied
explicitly (other than the literal sentinel \`none\`, used for BOTH
anchor-only modes -- release-guard AND release-complete), it is
independently VERIFIED against that same fresh fetch and the post is
refused on a mismatch, never trusted as-is (an explicit empty string
\`--body-sha256 ''\` is treated as a real, mismatching value, not as
omitted). This CLI also rejects a --mode/--body-sha256/--snapshot-sha256/
--supersedes combination contract.md's mode table forbids
(docs/idd-autonomy-contract.md's "Portable authoring-owner protocol"
section) BEFORE any fetch: the five "target" modes (acquire, resume,
bootstrap, heartbeat, release) always need a real body-sha256 (never the
none sentinel); the two anchor-only modes (release-guard, release-complete)
always need body-sha256 none (never omitted or a real digest); only
release-complete carries a real snapshot-sha256 (every other mode needs
snapshot-sha256 none); and --supersedes must be \`none\` for
acquire/bootstrap, a REAL prior-owner token distinct from --marker-owner
for resume, and exactly --marker-owner for
release/heartbeat/release-guard/release-complete -- owner comments are
append-only, so a marker posted with the wrong sentinel/value for its own
mode is a permanent, uncorrectable defect once it lands. --mode itself
(and --marker-owner/--supersedes/--actor/--state/--issue) is trimmed
before any of these checks run, matching the renderers' own internal
trimming, so a padded value cannot bypass a coupling check while still
rendering as canonical.
On a dry run and with --apply, an authoring-owner heartbeat, release,
release-guard, release-complete or resume is refused, with exit 1 and
nothing posted, unless its set, anchor and owner (resume: its --supersedes)
agree with an opening marker (acquire, bootstrap or resume) already on
--marker-target (#3910), and its set and anchor agree with the latest
trusted owner marker on --marker-target (#3899). An opening marker counts
when it is unedited and, when trusted logins are configured, written by one
of them. The latest trusted owner marker is the last comment in (createdAt,
id) order that carries the owner token, in any mode, is written by a trusted
login when any are configured, and is not minimized as outdated. One that was
edited, whose edit state is unknown, or that does not parse refuses the post,
so a wrong marker that stays visible blocks later owner posts on its issue
until it is minimized as outdated. The session is not compared, so a release
from another session stays allowed
(#3498). The comments are read over GraphQL, once per check, and a failed
read refuses too. The contract's direct JSON post stays available where only
REST works, and it is not checked.
Acquire and bootstrap read a child target's paginated owner log first,
reconcile prior memberships, and refuse an open or unreconciled generation;
they then replay the declared anchor's complete owner log before dry-run
output or POST. A self-anchor reads its own log. These modes fail closed on
unreadable history, when the trusted marker actor list is empty, or when
recursive former-child reconciliation exceeds its shared budget of 32
former-anchor history reads; cycle and depth guards apply separately. A
former anchor must prove the matching set and original child acquisition
session, an actual release marker before release-complete, and completion
after the child's final marker and before the next self-anchored generation.
authoring-publication-intent's --issue may be \`none\` only at
--state pending (contract.md; mirrors audit-authored-issue.mts's own
replay rule) -- \`--state member/cleanup/abandoned\` always require a real
--issue reference. Its --actor is additionally VERIFIED against the
authenticated GitHub login at --apply time (never in dry-run, which has
no real POST author to compare against): contract.md requires "actor to
equal the API author" on every replay, so a mismatched --actor produces
a durable record replay will always reject. Unlike similar --actor
checks elsewhere in this repository (local-validation-evidence.mts /
external-check-waiver.mts / provider-outage-declaration.mts, which fail
OPEN when the authenticated login cannot be resolved), --apply here
FAILS CLOSED when it cannot be resolved: those other artifacts are
recoverable, while a publication-intent record replay rejects is
permanent append-only noise on an issue this helper cannot retract.
--snapshot-sha256 has no auto-derivation and stays required and explicit:
docs/idd-autonomy-contract.md DOES define a precise algorithm for it (a
SHA-256 digest over the whole authoring set's sorted
<owner>/<repo>#<number>:<body-sha256> lines), but that algorithm's inputs
are every OTHER target's already-verified digest from the authoring
session's own durable hold -- cross-target state this single
--marker-target invocation has no way to enumerate, unlike body-sha256,
which is always exactly the one named target's own live body.
--marker-prefix defaults to .github/idd/config.json's \`markerPrefix\`, or
'idd-skill' when that is also absent -- the same distributed default
authoring-owner-provenance.mts's own DEFAULT_MARKER_PREFIX uses. Per
contract.md's "Target marker prefix" section, an installed bundle must
resolve the TARGET repository's actual configured prefix and never guess;
this CLI's local-config fallback is a same-repo convenience for THIS
distributed source repository's own dogfooding, not a substitute for
passing --marker-prefix explicitly when --owner/--repo names a different
repository than the one --marker-prefix would be read from.
These two types are deliberately NOT OPERATIONAL_MARKERS
(marker-helpers.mts) and are never subject to this file's own --apply
hide-at-post-time step or the F4 post-merge cleanup driver -- see
MARKER_TYPES's own doc comment.

f4-head-proof (#4368) is the F4 head proof of docs/idd-resume-detail.md. It
reads the live state first, even without --apply: the stored activation
nonce, \`resume-claim-routing --assert\`, the claim lock of --worktree (which
must be a worktree this repository registers), the merged pull request of the
claim's branch, the local branch tip, the trusted markers of the issue, and
the review-watermark of the pull request. It posts only when the verdict table
says post, and prints the verdict, the reason, and the proof values as JSON.
The command takes no other field flag than the optional --supersedes
<comment-id> (#4442): the comment ID of a malformed trusted proof of this claim
that the corrected proof replaces. Any other comment is refused,
and an unknown ID holds. It refuses --owner, --repo,
--trusted-marker-logins, and --advisory-bot-logins (the repository is the one the current checkout's origin names, and the
trusted logins come from the viewer, the environment, and the trusted
configuration). Under --apply it reads the claim
and the lock again right before the POST. Exit 0 is proceed or post; exit 1 is
hold or stop. An uncertain write is read back exactly three times and never
posted again. --target pr is refused.

--claim-id / --attempt on advisory-recovery are OPTIONAL (#1572): passing
both binds the marker to the active claim and an attempt number for
recovery-cycle accounting (advisory-wait-state.mjs); passing neither renders
the legacy 3-field form the shipped AW3-R recovery flow already posts.
Passing only ONE of the two throws (half-bound, ambiguous) -- always pass
both together or neither. This pairing works unchanged together with
--from-pr.
copilot-unavailable is a brand-new terminal marker with no legacy form, so
all five fields are required.

--from-pr forwards optional --trusted-marker-logins / --advisory-bot-logins to
the activity capture (--type watermark only) so its counts match the manual
review-activity-snapshot path.
--expected-head-sha pins a --type watermark --from-pr to the Step 1 stored
HEAD and fails closed (no post) on drift instead of silently posting a newer
HEAD than Step 1 saw.

--apply --type review-ack / --type copilot-unavailable (#2754): after the
new marker POSTs successfully, this command also hides (classifier
OUTDATED, via minimize-superseded-markers.mjs) prior same-family comments
it supersedes -- a review-ack: whose embedded HEAD SHA differs from the one
just posted, or a copilot-unavailable: carrying the same claim: value and a
STRICTLY LOWER attempt: number (a same-or-higher attempt is left alone).
--trusted-marker-logins gates that hide step's trusted-author check too
(falls back to IDD_TRUSTED_MARKER_ACTORS / the config trustedMarkerActors
list, same ladder as minimize-superseded-markers.mjs). Best-effort: a
permission error or any other failure here is swallowed and never blocks
or retries the marker post that already succeeded.
`;

/**
 * POST the marker body as a JSON document (`{"body": …}`) read from stdin via
 * `gh api --input -`. The JSON path is mandatory because HTML-comment-first
 * bodies are silently dropped by `gh issue comment` / `gh api -f body=`.
 *
 * Both `--target issue` and `--target pr` POST to the same
 * `repos/{owner}/{repo}/issues/{number}/comments` endpoint (a PR is an issue
 * for the comments API); `target` is descriptive-only and never changes routing.
 */
function postMarker(
  owner: string,
  repo: string,
  number: number,
  body: string,
): { id: number; html_url: string } {
  const posted = createGithubProviderAdapter(owner, repo).postWorkItemComment(
    number,
    body,
  );
  return { id: posted.id, html_url: posted.htmlUrl };
}

/** The latest marker carried by one replayed anchor generation. */
export interface AnchorOwnerLatestMarker {
  id: number;
  mode: string;
  owner: string;
  session: string;
  createdAt: string;
  bodySha256: string;
  outdated: boolean;
}

/** An open generation, including whether its release has started. */
export interface AnchorOwnerGeneration {
  owner: string;
  set: string;
  session: string;
  /** Sessions that have continued this generation through acquire or resume. */
  lineageSessions: readonly string[];
  releasing: boolean;
  /** The accepted release marker; a release-guard alone is not closure proof. */
  releaseMarker: AnchorOwnerLatestMarker | null;
  /** Acquire/bootstrap and resume markers in this winning generation lineage. */
  lineageOpeningIds: readonly number[];
  latest: AnchorOwnerLatestMarker;
}

/** A verified generation that ended with its trusted release-complete marker. */
export interface ClosedAnchorOwnerGeneration {
  owner: string;
  set: string;
  session: string;
  /** Sessions that have continued this generation through acquire or resume. */
  lineageSessions: readonly string[];
  /** Acquire/bootstrap and resume markers in this winning generation lineage. */
  lineageOpeningIds: readonly number[];
  releaseComplete: AnchorOwnerLatestMarker;
}

interface VerifiedSupersedingOpening {
  id: number;
  createdAt: string;
}

interface AnchorOwnerReplayState {
  open: AnchorOwnerGeneration | null;
  closedSets: ReadonlySet<string>;
  closedGenerations: readonly ClosedAnchorOwnerGeneration[];
  losers: ReadonlySet<string>;
}

export type AnchorOwnerReplayResult =
  | {
      generation: AnchorOwnerGeneration | null;
      closedSets: ReadonlySet<string>;
      closedGenerations: readonly ClosedAnchorOwnerGeneration[];
    }
  | { problem: string };

function ownerMarkerReplayFieldProblem(
  parsed: ParsedAuthoringOwnerMarker,
): string | null {
  const fields = {
    mode: parsed.mode,
    'marker-owner': parsed.owner,
    'body-sha256': parsed.bodySha256,
    'snapshot-sha256': parsed.snapshotSha256,
    supersedes: parsed.supersedes,
  };
  return (
    validateAuthoringOwnerModeDigestCoupling(fields) ??
    validateAuthoringOwnerSupersedesModeCoupling(fields)
  );
}

function advanceAnchorOwnerGeneration(
  state: AnchorOwnerReplayState,
  parsed: ParsedAuthoringOwnerMarker,
  latest: AnchorOwnerLatestMarker,
): AnchorOwnerReplayState | { problem: string } {
  const { open, closedSets, closedGenerations, losers } = state;
  const malformed = ownerMarkerReplayFieldProblem(parsed);
  if (malformed !== null) {
    return {
      problem: `owner marker ${latest.id} (mode=${parsed.mode}) is malformed: ${malformed}`,
    };
  }
  if (losers.has(parsed.owner)) {
    return state;
  }
  if (parsed.mode === 'resume' && losers.has(parsed.supersedes)) {
    return { ...state, losers: new Set([...losers, parsed.owner]) };
  }
  const mismatch = (): { problem: string } => ({
    problem: `owner marker ${latest.id} (mode=${parsed.mode}) does not match the open generation`,
  });
  switch (parsed.mode) {
    case 'acquire':
    case 'bootstrap':
      if (open !== null) {
        if (parsed.owner === open.owner) {
          return {
            problem: `owner marker ${latest.id} (mode=${parsed.mode}) opens the generation of its own owner a second time`,
          };
        }
        return {
          open,
          closedSets,
          closedGenerations,
          losers: new Set([...losers, parsed.owner]),
        };
      }
      if (closedSets.has(parsed.set)) {
        return {
          problem: `owner marker ${latest.id} (mode=${parsed.mode}) reuses set ${parsed.set}, which a release-complete marker already closed`,
        };
      }
      return {
        open: {
          owner: parsed.owner,
          set: parsed.set,
          session: parsed.session,
          lineageSessions: [parsed.session],
          releasing: false,
          releaseMarker: null,
          lineageOpeningIds: [latest.id],
          latest,
        },
        closedSets,
        closedGenerations,
        losers,
      };
    case 'resume':
      if (
        open === null ||
        parsed.set !== open.set ||
        parsed.supersedes !== open.owner
      ) {
        return mismatch();
      }
      return {
        open: {
          owner: parsed.owner,
          set: open.set,
          session: parsed.session,
          lineageSessions: [
            ...new Set([...open.lineageSessions, parsed.session]),
          ],
          releasing: open.releasing,
          releaseMarker: open.releaseMarker,
          lineageOpeningIds: [...open.lineageOpeningIds, latest.id],
          latest,
        },
        closedSets,
        closedGenerations,
        losers,
      };
    case 'heartbeat':
    case 'release':
    case 'release-guard':
    case 'release-complete':
      if (
        open === null ||
        parsed.set !== open.set ||
        parsed.owner !== open.owner
      ) {
        return mismatch();
      }
      if (
        (parsed.mode === 'release-guard' ||
          parsed.mode === 'release-complete') &&
        parsed.session !== open.session
      ) {
        return {
          problem: `owner marker ${latest.id} (mode=${parsed.mode}) does not retain the session of the open generation`,
        };
      }
      if (parsed.mode === 'release-complete') {
        if (!open.releasing || open.releaseMarker === null) {
          return {
            problem: `owner marker ${latest.id} (mode=release-complete) closes a generation with no accepted release marker in progress`,
          };
        }
        return {
          open: null,
          closedSets: new Set([...closedSets, open.set]),
          closedGenerations: [
            ...closedGenerations,
            {
              owner: open.owner,
              set: open.set,
              session: open.session,
              lineageSessions: open.lineageSessions,
              lineageOpeningIds: open.lineageOpeningIds,
              releaseComplete: latest,
            },
          ],
          losers: new Set(),
        };
      }
      return {
        open: {
          owner: open.owner,
          set: open.set,
          session: open.session,
          lineageSessions: open.lineageSessions,
          releasing: open.releasing || parsed.mode !== 'heartbeat',
          releaseMarker:
            parsed.mode === 'release' ? latest : open.releaseMarker,
          lineageOpeningIds: open.lineageOpeningIds,
          latest,
        },
        closedSets,
        closedGenerations,
        losers,
      };
    default:
      return {
        problem: `owner marker ${latest.id} has the unknown mode ${parsed.mode}`,
      };
  }
}

/**
 * Replay owner markers from an anchor's full comment log. A non-empty trusted
 * actor list filters authors; an empty list fails closed because no marker
 * author can be established as trusted. A valid empty or completed log returns
 * `generation: null` and its closed set IDs plus closure identities; an open
 * generation retains its `releasing` state. Malformed or incomplete evidence
 * fails closed. The first valid opener in comment order wins a concurrent
 * acquisition race.
 */
export function resolveAnchorOwnerGeneration(input: {
  comments: readonly AuthoringOwnerProvenanceComment[];
  anchorRef: string;
  markerPrefix: string;
  trusted: readonly string[];
  /** Prefix replays recover state before a foreign opener; later evidence is not present yet. */
  prefixOnly?: boolean;
  /** Verified foreign memberships may supersede an outdated historical closure. */
  supersedingOpenings?: readonly VerifiedSupersedingOpening[];
}): AnchorOwnerReplayResult {
  const trustedSet = new Set(
    input.trusted.map((login) => login.trim().toLowerCase()).filter(Boolean),
  );
  if (trustedSet.size === 0) {
    return {
      problem:
        'trusted marker actor set is empty, so owner history cannot be verified',
    };
  }
  const shaped: { comment: AuthoringOwnerProvenanceComment; time: number }[] =
    [];
  for (const comment of input.comments) {
    if (
      !trustedSet.has(comment.authorLogin.trim().toLowerCase()) ||
      !looksLikeOwnerMarker(comment.body, input.markerPrefix)
    ) {
      continue;
    }
    const edited = inspectLastEditedAt(comment);
    if (edited !== null) {
      return { problem: edited };
    }
    if (
      typeof comment.isMinimized !== 'boolean' ||
      (comment.isMinimized &&
        (typeof comment.minimizedReason !== 'string' ||
          comment.minimizedReason.trim() === ''))
    ) {
      return {
        problem: `owner marker ${comment.id} has no readable minimization state`,
      };
    }
    const time = Date.parse(comment.createdAt);
    if (!Number.isFinite(time)) {
      return {
        problem: `owner marker ${comment.id} has a creation time that cannot be read`,
      };
    }
    shaped.push({ comment, time });
  }
  shaped.sort((a, b) => a.time - b.time || a.comment.id - b.comment.id);

  let state: AnchorOwnerReplayState = {
    open: null,
    closedSets: new Set(),
    closedGenerations: [],
    losers: new Set(),
  };
  for (const { comment } of shaped) {
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (parsed === null) {
      return { problem: `owner marker ${comment.id} does not parse` };
    }
    if (
      !sameIssueRef(parsed.target, input.anchorRef) ||
      !sameIssueRef(parsed.anchor, input.anchorRef)
    ) {
      return {
        problem: `owner marker ${comment.id} names target ${parsed.target} and anchor ${parsed.anchor}, not the anchor ${input.anchorRef} itself`,
      };
    }
    const next = advanceAnchorOwnerGeneration(state, parsed, {
      id: comment.id,
      mode: parsed.mode,
      owner: parsed.owner,
      session: parsed.session,
      createdAt: comment.createdAt,
      bodySha256: parsed.bodySha256,
      outdated: isOutdatedMinimized(comment),
    });
    if ('problem' in next) {
      return next;
    }
    state = next;
  }
  if (input.prefixOnly === true) {
    return {
      generation: state.open,
      closedSets: state.closedSets,
      closedGenerations: state.closedGenerations,
    };
  }
  const verifiedOpeningIds = new Set([
    ...state.closedGenerations.flatMap(
      (generation) => generation.lineageOpeningIds,
    ),
    ...(state.open?.lineageOpeningIds ?? []),
  ]);
  for (const closed of state.closedGenerations) {
    if (!closed.releaseComplete.outdated) {
      continue;
    }
    const completion = shaped.find(
      ({ comment }) => comment.id === closed.releaseComplete.id,
    )?.comment;
    const supersededBySelfGeneration =
      completion !== undefined &&
      shaped.some(
        ({ comment }) =>
          verifiedOpeningIds.has(comment.id) &&
          commentPrecedes(completion, comment),
      );
    const supersededByForeignMembership =
      completion !== undefined &&
      (input.supersedingOpenings ?? []).some((opening) =>
        commentPrecedes(completion, opening),
      );
    const superseded =
      supersededBySelfGeneration || supersededByForeignMembership;
    if (!superseded) {
      return {
        problem: `owner marker ${closed.releaseComplete.id} (mode=release-complete) is minimized as outdated, so it cannot close the generation`,
      };
    }
  }
  if (state.open?.latest.outdated) {
    return {
      problem: `the latest owner marker of ${input.anchorRef}, comment ${state.open.latest.id}, is minimized as outdated, so it cannot prove an open generation`,
    };
  }
  return {
    generation: state.open,
    closedSets: state.closedSets,
    closedGenerations: state.closedGenerations,
  };
}

interface FormerChildMembership {
  anchorRef: string;
  set: string;
  comments: AuthoringOwnerProvenanceComment[];
  startIndex: number;
  openingCommentId: number;
  targetWideLosingOwners: Set<string>;
  targetWideResumeSuccessors: ReadonlyMap<string, readonly string[]>;
  expandedTargetWideLosingOwners: Set<string>;
}

function recordFormerChildTargetWideLosingOwner(
  membership: FormerChildMembership,
  owner: string,
): void {
  const pending = [owner];
  while (pending.length > 0) {
    const nextOwner = pending.pop();
    if (
      nextOwner === undefined ||
      membership.expandedTargetWideLosingOwners.has(nextOwner)
    ) {
      continue;
    }
    membership.expandedTargetWideLosingOwners.add(nextOwner);
    membership.targetWideLosingOwners.add(nextOwner);
    pending.push(
      ...(membership.targetWideResumeSuccessors.get(nextOwner) ?? []),
    );
  }
}

/**
 * Replay one former child's markers for an anchor/set pair. A completed child
 * membership must have its own trusted `release` in progress; a subsequent
 * heartbeat can preserve that state while the child label is removed. Only
 * the former anchor's matching `release-complete` can prove that the set then
 * closed.
 */
function resolveFormerChildMembership(input: {
  membership: FormerChildMembership;
  targetRef: string;
  markerPrefix: string;
  trusted: readonly string[];
}):
  | {
      generation: AnchorOwnerGeneration;
      releaseMarker: AnchorOwnerLatestMarker;
    }
  | { problem: string } {
  const trustedSet = new Set(
    input.trusted.map((login) => login.trim().toLowerCase()).filter(Boolean),
  );
  if (trustedSet.size === 0) {
    return {
      problem:
        'trusted marker actor set is empty, so former child history cannot be verified',
    };
  }
  const shaped: {
    comment: AuthoringOwnerProvenanceComment;
    parsed: ParsedAuthoringOwnerMarker;
    time: number;
  }[] = [];
  for (
    let commentIndex = input.membership.startIndex;
    commentIndex < input.membership.comments.length;
    commentIndex += 1
  ) {
    const comment = input.membership.comments[commentIndex];
    if (comment === undefined) {
      return { problem: 'former child marker index cannot be read' };
    }
    if (
      !trustedSet.has(comment.authorLogin.trim().toLowerCase()) ||
      !looksLikeOwnerMarker(comment.body, input.markerPrefix)
    ) {
      continue;
    }
    const edited = inspectLastEditedAt(comment);
    if (edited !== null) {
      return { problem: edited };
    }
    if (
      typeof comment.isMinimized !== 'boolean' ||
      (comment.isMinimized &&
        (typeof comment.minimizedReason !== 'string' ||
          comment.minimizedReason.trim() === ''))
    ) {
      return {
        problem: `owner marker ${comment.id} has no readable minimization state`,
      };
    }
    const time = Date.parse(comment.createdAt);
    if (!Number.isFinite(time)) {
      return {
        problem: `owner marker ${comment.id} has a creation time that cannot be read`,
      };
    }
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (parsed === null) {
      return { problem: `owner marker ${comment.id} does not parse` };
    }
    if (
      parsed.mode === 'resume' &&
      input.membership.targetWideLosingOwners.has(parsed.supersedes)
    ) {
      recordFormerChildTargetWideLosingOwner(input.membership, parsed.owner);
    }
    if (input.membership.targetWideLosingOwners.has(parsed.owner)) {
      if (comment.id === input.membership.openingCommentId) {
        return {
          problem: `former child opener ${comment.id} reuses the owner of an earlier target-wide loser`,
        };
      }
      continue;
    }
    if (
      !sameIssueRef(parsed.target, input.targetRef) ||
      !sameIssueRef(parsed.anchor, input.membership.anchorRef) ||
      parsed.set !== input.membership.set
    ) {
      return {
        problem: `owner marker ${comment.id} does not match former child membership ${input.membership.anchorRef}/${input.membership.set}`,
      };
    }
    if (parsed.mode === 'release-guard' || parsed.mode === 'release-complete') {
      return {
        problem: `owner marker ${comment.id} (mode=${parsed.mode}) is anchor-only and cannot close a child membership`,
      };
    }
    shaped.push({ comment, parsed, time });
  }
  shaped.sort((a, b) => a.time - b.time || a.comment.id - b.comment.id);

  let state: AnchorOwnerReplayState = {
    open: null,
    closedSets: new Set(),
    closedGenerations: [],
    losers: new Set(),
  };
  let releaseMarker: AnchorOwnerLatestMarker | null = null;
  for (const { comment, parsed } of shaped) {
    const latest: AnchorOwnerLatestMarker = {
      id: comment.id,
      mode: parsed.mode,
      owner: parsed.owner,
      session: parsed.session,
      createdAt: comment.createdAt,
      bodySha256: parsed.bodySha256,
      outdated: isOutdatedMinimized(comment),
    };
    const next = advanceAnchorOwnerGeneration(state, parsed, {
      ...latest,
    });
    if ('problem' in next) {
      return next;
    }
    state = next;
    if (parsed.mode === 'release' && state.open?.latest.id === latest.id) {
      releaseMarker = latest;
    }
  }
  if (state.open === null || !state.open.releasing || releaseMarker === null) {
    return {
      problem: `former child membership ${input.membership.anchorRef}/${input.membership.set} has no trusted release marker in progress`,
    };
  }
  return { generation: state.open, releaseMarker };
}

const MAX_FORMER_CHILD_RECONCILIATION_DEPTH = 32;
const MAX_FORMER_CHILD_RECONCILIATION_READS = 32;

interface FormerChildReconciliationReadBudget {
  formerAnchorReads: number;
}

type FormerChildReconciliationResult =
  | {
      comments: AuthoringOwnerProvenanceComment[];
      closedSets: ReadonlySet<string>;
      supersedingOpenings: readonly VerifiedSupersedingOpening[];
    }
  | { problem: string };

interface FormerAnchorSelfOpening {
  id: number;
  createdAt: string;
  owner: string;
  set: string;
  session: string;
}

function commentPrecedes(
  left: { createdAt: string; id: number },
  right: { createdAt: string; id: number },
): boolean {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  return leftTime < rightTime || (leftTime === rightTime && left.id < right.id);
}

/**
 * An issue can become its own set anchor after being a completed child.
 * Reconcile each old child membership against the exact former anchor/set/
 * session completion, then arbitrate all self and foreign generations in the
 * target-wide comment order before replaying the target's owner history.
 * Losing self generations are removed with their continuations. Any later
 * self-generation must open after the matching completion.
 * Former anchors are reconciled recursively with shared read, cycle and depth
 * guards. An empty trusted actor list cannot establish marker provenance.
 * The exact former-anchor release-complete closes the old membership even
 * when the child release is minimized as outdated, allowing a fresh
 * acquisition with a new set. Any later self-generation must open after that
 * completion. Incomplete history fails closed.
 */
function reconcileFormerChildMembershipsInternal(
  input: {
    comments: readonly AuthoringOwnerProvenanceComment[];
    historyTargetRef: string;
    markerPrefix: string;
    trusted: readonly string[];
  },
  ancestry: readonly string[],
  readBudget: FormerChildReconciliationReadBudget,
): FormerChildReconciliationResult {
  const trustedSet = new Set(
    input.trusted.map((login) => login.trim().toLowerCase()).filter(Boolean),
  );
  if (trustedSet.size === 0) {
    return {
      problem:
        'trusted marker actor set is empty, so former-child history cannot be verified',
    };
  }
  const target = parseIssueReference(input.historyTargetRef);
  if (target === null) {
    return {
      problem: `history target ${input.historyTargetRef} is not a readable issue reference`,
    };
  }
  const targetKey = `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;
  if (ancestry.includes(targetKey)) {
    return {
      problem: `former-anchor reconciliation cycle detected at ${input.historyTargetRef}`,
    };
  }
  if (ancestry.length >= MAX_FORMER_CHILD_RECONCILIATION_DEPTH) {
    return {
      problem: `former-anchor reconciliation exceeded the maximum depth of ${MAX_FORMER_CHILD_RECONCILIATION_DEPTH}`,
    };
  }
  const nextAncestry = [...ancestry, targetKey];

  const foreignEvents: {
    key: string;
    anchorRef: string;
    set: string;
    comment: AuthoringOwnerProvenanceComment;
    parsed: ParsedAuthoringOwnerMarker;
  }[] = [];
  const foreignCommentIds = new Set<number>();
  const selfAnchorOpenings: FormerAnchorSelfOpening[] = [];
  const selfAnchorComments: AuthoringOwnerProvenanceComment[] = [];
  for (const comment of input.comments) {
    if (
      !trustedSet.has(comment.authorLogin.trim().toLowerCase()) ||
      !looksLikeOwnerMarker(comment.body, input.markerPrefix)
    ) {
      continue;
    }
    const edited = inspectLastEditedAt(comment);
    if (edited !== null) {
      return { problem: edited };
    }
    if (
      typeof comment.isMinimized !== 'boolean' ||
      (comment.isMinimized &&
        (typeof comment.minimizedReason !== 'string' ||
          comment.minimizedReason.trim() === ''))
    ) {
      return {
        problem: `owner marker ${comment.id} has no readable minimization state`,
      };
    }
    if (!Number.isFinite(Date.parse(comment.createdAt))) {
      return {
        problem: `owner marker ${comment.id} has a creation time that cannot be read`,
      };
    }
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (parsed === null) {
      return { problem: `owner marker ${comment.id} does not parse` };
    }
    if (!sameIssueRef(parsed.target, input.historyTargetRef)) {
      return {
        problem: `owner marker ${comment.id} names target ${parsed.target}, not ${input.historyTargetRef}`,
      };
    }
    if (sameIssueRef(parsed.anchor, input.historyTargetRef)) {
      selfAnchorComments.push(comment);
      if (parsed.mode === 'acquire' || parsed.mode === 'bootstrap') {
        selfAnchorOpenings.push({
          id: comment.id,
          createdAt: comment.createdAt,
          owner: parsed.owner,
          set: parsed.set,
          session: parsed.session,
        });
      }
      continue;
    }
    if (parseIssueReference(parsed.anchor) === null) {
      return {
        problem: `owner marker ${comment.id} names an unreadable former anchor ${parsed.anchor}`,
      };
    }
    const key = `${parsed.anchor.toLowerCase()}\u0000${parsed.set}`;
    foreignEvents.push({
      key,
      anchorRef: parsed.anchor,
      set: parsed.set,
      comment,
      parsed,
    });
    foreignCommentIds.add(comment.id);
  }

  if (foreignEvents.length === 0) {
    return {
      comments: [...input.comments],
      closedSets: new Set(),
      supersedingOpenings: [],
    };
  }

  foreignEvents.sort((left, right) =>
    commentPrecedes(left.comment, right.comment)
      ? -1
      : commentPrecedes(right.comment, left.comment)
        ? 1
        : 0,
  );
  const foreignEventsByMembership = new Map<
    string,
    (typeof foreignEvents)[number][]
  >();
  for (const event of foreignEvents) {
    const events = foreignEventsByMembership.get(event.key) ?? [];
    events.push(event);
    foreignEventsByMembership.set(event.key, events);
  }
  const foreignMembershipCandidates: {
    membership: FormerChildMembership;
    opening: AuthoringOwnerProvenanceComment;
    openingOwner: string;
  }[] = [];
  for (const events of foreignEventsByMembership.values()) {
    const openerIndices = events.flatMap((event, index) =>
      event.parsed.mode === 'acquire' || event.parsed.mode === 'bootstrap'
        ? [index]
        : [],
    );
    if (openerIndices.length === 0) {
      const first = events[0];
      if (first === undefined) {
        return {
          problem: 'former child membership has no readable owner markers',
        };
      }
      return {
        problem: `former child membership ${first.anchorRef}/${first.set} has no acquisition marker to open a membership generation`,
      };
    }
    const membershipComments = events.map((event) => event.comment);
    const targetWideLosingOwners = new Set<string>();
    const targetWideResumeSuccessors = new Map<string, string[]>();
    for (const event of events) {
      if (event.parsed.mode !== 'resume') {
        continue;
      }
      const successors =
        targetWideResumeSuccessors.get(event.parsed.supersedes) ?? [];
      successors.push(event.parsed.owner);
      targetWideResumeSuccessors.set(event.parsed.supersedes, successors);
    }
    const expandedTargetWideLosingOwners = new Set<string>();
    for (let index = 0; index < openerIndices.length; index += 1) {
      const openerIndex = openerIndices[index];
      const first = events[0];
      const opener =
        openerIndex === undefined ? undefined : events[openerIndex];
      if (first === undefined || opener === undefined) {
        return {
          problem: 'former child acquisition segment cannot be read',
        };
      }
      foreignMembershipCandidates.push({
        membership: {
          anchorRef: first.anchorRef,
          set: first.set,
          // Candidates share one event array and carry an offset. The child
          // replay filters competing local openers, while shared losing
          // context filters continuations of target-wide losers.
          comments: membershipComments,
          startIndex: index === 0 ? 0 : openerIndex,
          openingCommentId: opener.comment.id,
          targetWideLosingOwners,
          targetWideResumeSuccessors,
          expandedTargetWideLosingOwners,
        },
        opening: opener.comment,
        openingOwner: opener.parsed.owner,
      });
    }
  }

  const anchorReplays = new Map<string, AnchorOwnerReplayResult>();
  const closedSets = new Set<string>();
  const losingSelfAnchorCommentIds = new Set<number>();
  const orderedSelfAnchorComments = [...selfAnchorComments].sort(
    (left, right) =>
      commentPrecedes(left, right) ? -1 : commentPrecedes(right, left) ? 1 : 0,
  );
  const selfAnchorOwnerKey = (set: string, owner: string): string =>
    `${set}\u0000${owner}`;
  const selfAnchorOwnerKeys = new Map<number, string>();
  for (const comment of orderedSelfAnchorComments) {
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (parsed !== null) {
      selfAnchorOwnerKeys.set(
        comment.id,
        selfAnchorOwnerKey(parsed.set, parsed.owner),
      );
    }
  }
  const losingSelfAnchorOwners = new Set<string>();
  const verifiedSupersedingOpenings: VerifiedSupersedingOpening[] = [];
  type VerifiedForeignMembership = {
    membership: FormerChildMembership;
    opening: AuthoringOwnerProvenanceComment;
    completion: AnchorOwnerLatestMarker;
  };

  const verifyForeignMembership = (
    candidate: (typeof foreignMembershipCandidates)[number],
  ): VerifiedForeignMembership | { problem: string } => {
    const { membership } = candidate;
    const childReplay = resolveFormerChildMembership({
      membership,
      targetRef: input.historyTargetRef,
      markerPrefix: input.markerPrefix,
      trusted: input.trusted,
    });
    if ('problem' in childReplay) {
      return {
        problem: `former child membership ${membership.anchorRef}/${membership.set} cannot be replayed: ${childReplay.problem}`,
      };
    }

    const anchorKey = membership.anchorRef.toLowerCase();
    let cachedAnchorReplay = anchorReplays.get(anchorKey);
    if (cachedAnchorReplay === undefined) {
      const anchor = parseIssueReference(membership.anchorRef);
      if (anchor === null) {
        return {
          problem: `former child membership names an unreadable anchor ${membership.anchorRef}`,
        };
      }
      let anchorComments: AuthoringOwnerProvenanceComment[];
      if (
        readBudget.formerAnchorReads >= MAX_FORMER_CHILD_RECONCILIATION_READS
      ) {
        return {
          problem: `former-anchor reconciliation exceeded the maximum of ${MAX_FORMER_CHILD_RECONCILIATION_READS} former-anchor history reads`,
        };
      }
      readBudget.formerAnchorReads += 1;
      try {
        anchorComments = fetchProvenanceCommentsGraphql(
          anchor.owner,
          anchor.repo,
          anchor.number,
        );
      } catch (error) {
        return {
          problem: `former anchor ${membership.anchorRef} owner history cannot be read: ${(error as Error).message}`,
        };
      }
      const anchorReconciliation = reconcileFormerChildMembershipsInternal(
        {
          comments: anchorComments,
          historyTargetRef: membership.anchorRef,
          markerPrefix: input.markerPrefix,
          trusted: input.trusted,
        },
        nextAncestry,
        readBudget,
      );
      if ('problem' in anchorReconciliation) {
        return {
          problem: `former anchor ${membership.anchorRef} history cannot be reconciled: ${anchorReconciliation.problem}`,
        };
      }
      const anchorReplay = resolveAnchorOwnerGeneration({
        comments: anchorReconciliation.comments,
        anchorRef: membership.anchorRef,
        markerPrefix: input.markerPrefix,
        trusted: input.trusted,
        supersedingOpenings: anchorReconciliation.supersedingOpenings,
      });
      if ('problem' in anchorReplay) {
        return {
          problem: `former anchor ${membership.anchorRef} owner history cannot be replayed: ${anchorReplay.problem}`,
        };
      }
      const reusedFormerChildSet = [...anchorReconciliation.closedSets].find(
        (set) =>
          anchorReplay.closedSets.has(set) ||
          anchorReplay.generation?.set === set,
      );
      if (reusedFormerChildSet !== undefined) {
        return {
          problem: `former anchor ${membership.anchorRef} reuses set ${reusedFormerChildSet}, already closed by a verified former-child membership`,
        };
      }
      // Keep every verified closed set from this anchor's recursively
      // reconciled history unavailable to the target being promoted too.
      for (const set of anchorReconciliation.closedSets) {
        closedSets.add(set);
      }
      for (const set of anchorReplay.closedSets) {
        closedSets.add(set);
      }
      cachedAnchorReplay = anchorReplay;
      anchorReplays.set(anchorKey, cachedAnchorReplay);
    }
    const anchorReplay = cachedAnchorReplay;
    if ('problem' in anchorReplay) {
      return {
        problem: `former anchor ${membership.anchorRef} owner history cannot be replayed: ${anchorReplay.problem}`,
      };
    }

    const childLatestAt = Date.parse(childReplay.generation.latest.createdAt);
    const childLatest = membership.comments.find(
      (comment) => comment.id === childReplay.generation.latest.id,
    );
    const childOpening = membership.comments
      .filter((comment) =>
        childReplay.generation.lineageOpeningIds.includes(comment.id),
      )
      .map((comment) => ({
        comment,
        parsed: parseAuthoringOwnerComment(comment.body, input.markerPrefix),
      }))
      .filter(
        (
          item,
        ): item is {
          comment: AuthoringOwnerProvenanceComment;
          parsed: ParsedAuthoringOwnerMarker;
        } =>
          item.parsed !== null &&
          (item.parsed.mode === 'acquire' || item.parsed.mode === 'bootstrap'),
      )
      .sort((left, right) =>
        commentPrecedes(left.comment, right.comment)
          ? -1
          : commentPrecedes(right.comment, left.comment)
            ? 1
            : 0,
      )[0];
    if (childLatest === undefined || childOpening === undefined) {
      return {
        problem: `former child membership ${membership.anchorRef}/${membership.set} has no readable winning acquisition or latest marker`,
      };
    }
    if (childOpening.comment.id !== candidate.opening.id) {
      return {
        problem: `former child membership ${membership.anchorRef}/${membership.set} does not replay from its acquisition at comment ${candidate.opening.id}`,
      };
    }
    const completion = anchorReplay.closedGenerations.find((closed) => {
      const completionAt = Date.parse(closed.releaseComplete.createdAt);
      return (
        closed.set === membership.set &&
        closed.lineageSessions.includes(childOpening.parsed.session) &&
        (completionAt > childLatestAt ||
          (completionAt === childLatestAt &&
            closed.releaseComplete.id > childReplay.generation.latest.id))
      );
    });
    if (completion === undefined) {
      return {
        problem: `former child membership ${membership.anchorRef}/${membership.set}/${childReplay.generation.session} has no matching trusted release-complete from the former anchor's current owner`,
      };
    }
    const verified: VerifiedForeignMembership = {
      membership,
      opening: childOpening.comment,
      completion: completion.releaseComplete,
    };
    const postCompletionChildOpener = membership.comments.find(
      (comment, commentIndex) => {
        if (
          commentIndex < membership.startIndex ||
          !commentPrecedes(verified.completion, comment)
        ) {
          return false;
        }
        const parsed = parseAuthoringOwnerComment(
          comment.body,
          input.markerPrefix,
        );
        return parsed?.mode === 'acquire' || parsed?.mode === 'bootstrap';
      },
    );
    if (postCompletionChildOpener !== undefined) {
      return {
        problem: `former child membership ${membership.anchorRef}/${membership.set} reopens after its matching release-complete at comment ${postCompletionChildOpener.id}`,
      };
    }
    return verified;
  };

  // Candidate self histories are replayed after prior target-wide losers have
  // been removed. All foreign openings are supplied provisionally so an
  // outdated self release-complete can be interpreted. Foreign candidates
  // are verified only after target-wide ordering says they can win.
  const provisionalForeignOpenings = foreignMembershipCandidates.map(
    ({ opening }) => ({ id: opening.id, createdAt: opening.createdAt }),
  );
  const resolveSelfGenerationAtOpening = (
    opening: AuthoringOwnerProvenanceComment,
  ): { completion: AnchorOwnerLatestMarker | null } | { problem: string } => {
    const replay = resolveAnchorOwnerGeneration({
      comments: selfAnchorComments.filter((comment) => {
        if (losingSelfAnchorCommentIds.has(comment.id)) {
          return false;
        }
        const ownerKey = selfAnchorOwnerKeys.get(comment.id);
        return ownerKey === undefined || !losingSelfAnchorOwners.has(ownerKey);
      }),
      anchorRef: input.historyTargetRef,
      markerPrefix: input.markerPrefix,
      trusted: input.trusted,
      supersedingOpenings: provisionalForeignOpenings,
    });
    if ('problem' in replay) {
      return {
        problem: `self-anchored owner history before opener ${opening.id} cannot be replayed: ${replay.problem}`,
      };
    }
    const generations = [
      ...replay.closedGenerations,
      ...(replay.generation === null ? [] : [replay.generation]),
    ];
    const generation = generations.find((candidate) =>
      candidate.lineageOpeningIds.includes(opening.id),
    );
    if (generation === undefined) {
      return {
        problem: `self-anchored opener ${opening.id} does not replay as a winning generation after target-wide losers are removed`,
      };
    }
    return {
      completion:
        'releaseComplete' in generation ? generation.releaseComplete : null,
    };
  };

  const selfAnchorResumeSuccessors = new Map<string, string[]>();
  for (const comment of orderedSelfAnchorComments) {
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (parsed?.mode !== 'resume') {
      continue;
    }
    const priorOwner = selfAnchorOwnerKey(parsed.set, parsed.supersedes);
    const successorOwner = selfAnchorOwnerKey(parsed.set, parsed.owner);
    const successors = selfAnchorResumeSuccessors.get(priorOwner) ?? [];
    successors.push(successorOwner);
    selfAnchorResumeSuccessors.set(priorOwner, successors);
  }
  const recordLosingSelfAnchorOwner = (set: string, owner: string): void => {
    const pending = [selfAnchorOwnerKey(set, owner)];
    while (pending.length > 0) {
      const nextOwner = pending.pop();
      if (nextOwner === undefined || losingSelfAnchorOwners.has(nextOwner)) {
        continue;
      }
      losingSelfAnchorOwners.add(nextOwner);
      pending.push(...(selfAnchorResumeSuccessors.get(nextOwner) ?? []));
    }
  };
  type TargetWideGeneration = {
    kind: 'self' | 'foreign';
    opening: AuthoringOwnerProvenanceComment;
    completion: AnchorOwnerLatestMarker | null;
    foreignCandidate?: (typeof foreignMembershipCandidates)[number];
  };
  const targetWideGenerations: TargetWideGeneration[] = [];
  for (const selfOpening of selfAnchorOpenings) {
    const opening = selfAnchorComments.find(
      (comment) => comment.id === selfOpening.id,
    );
    if (opening === undefined) {
      return {
        problem: `self-anchored opening ${selfOpening.id} cannot be found in the target owner history`,
      };
    }
    targetWideGenerations.push({
      kind: 'self',
      opening,
      completion: null,
    });
  }
  for (const foreignCandidate of foreignMembershipCandidates) {
    targetWideGenerations.push({
      kind: 'foreign',
      opening: foreignCandidate.opening,
      completion: null,
      foreignCandidate,
    });
  }
  targetWideGenerations.sort((left, right) =>
    commentPrecedes(left.opening, right.opening)
      ? -1
      : commentPrecedes(right.opening, left.opening)
        ? 1
        : 0,
  );

  let targetWideWinner: TargetWideGeneration | undefined;
  for (const generation of targetWideGenerations) {
    if (
      targetWideWinner !== undefined &&
      (targetWideWinner.completion === null ||
        !commentPrecedes(targetWideWinner.completion, generation.opening))
    ) {
      if (generation.kind === 'self') {
        const losingSelfOpening = selfAnchorOpenings.find(
          (opening) => opening.id === generation.opening.id,
        );
        if (losingSelfOpening === undefined) {
          return {
            problem: `losing self-anchored opening ${generation.opening.id} cannot be found in the target owner history`,
          };
        }
        recordLosingSelfAnchorOwner(
          losingSelfOpening.set,
          losingSelfOpening.owner,
        );
      } else {
        const losingCandidate = generation.foreignCandidate;
        if (losingCandidate === undefined) {
          return {
            problem: `losing foreign opening ${generation.opening.id} has no former-child membership candidate`,
          };
        }
        recordFormerChildTargetWideLosingOwner(
          losingCandidate.membership,
          losingCandidate.openingOwner,
        );
      }
      continue;
    }
    if (generation.kind === 'self') {
      const selfGeneration = resolveSelfGenerationAtOpening(generation.opening);
      if ('problem' in selfGeneration) {
        return selfGeneration;
      }
      targetWideWinner = {
        ...generation,
        completion: selfGeneration.completion,
      };
      continue;
    }

    const candidate = generation.foreignCandidate;
    if (candidate === undefined) {
      return {
        problem: `foreign generation opening ${generation.opening.id} has no former-child membership candidate`,
      };
    }
    const verified = verifyForeignMembership(candidate);
    if ('problem' in verified) {
      return verified;
    }
    closedSets.add(verified.membership.set);
    verifiedSupersedingOpenings.push({
      id: verified.opening.id,
      createdAt: verified.opening.createdAt,
    });
    targetWideWinner = {
      kind: 'foreign',
      opening: verified.opening,
      completion: verified.completion,
      foreignCandidate: candidate,
    };
  }

  for (const comment of orderedSelfAnchorComments) {
    const parsed = parseAuthoringOwnerComment(comment.body, input.markerPrefix);
    if (
      parsed !== null &&
      losingSelfAnchorOwners.has(selfAnchorOwnerKey(parsed.set, parsed.owner))
    ) {
      losingSelfAnchorCommentIds.add(comment.id);
    }
  }

  const reconciledComments = input.comments.filter(
    (comment) =>
      !foreignCommentIds.has(comment.id) &&
      !losingSelfAnchorCommentIds.has(comment.id),
  );
  const selfReplay = resolveAnchorOwnerGeneration({
    comments: reconciledComments,
    anchorRef: input.historyTargetRef,
    markerPrefix: input.markerPrefix,
    trusted: input.trusted,
    supersedingOpenings: verifiedSupersedingOpenings,
  });
  if ('problem' in selfReplay) {
    return {
      problem: `self-anchored owner history cannot be replayed after former-child reconciliation: ${selfReplay.problem}`,
    };
  }
  const reusedFormerChildSet = [...closedSets].find(
    (set) =>
      selfReplay.closedSets.has(set) || selfReplay.generation?.set === set,
  );
  if (reusedFormerChildSet !== undefined) {
    return {
      problem: `self-anchored owner history reuses set ${reusedFormerChildSet}, already closed by a verified former-child membership`,
    };
  }
  return {
    comments: reconciledComments,
    closedSets,
    supersedingOpenings: verifiedSupersedingOpenings,
  };
}

export function reconcileFormerChildMemberships(input: {
  comments: readonly AuthoringOwnerProvenanceComment[];
  historyTargetRef: string;
  markerPrefix: string;
  trusted: readonly string[];
}): FormerChildReconciliationResult {
  return reconcileFormerChildMembershipsWithBudget(input, {
    formerAnchorReads: 0,
  });
}

function reconcileFormerChildMembershipsWithBudget(
  input: {
    comments: readonly AuthoringOwnerProvenanceComment[];
    historyTargetRef: string;
    markerPrefix: string;
    trusted: readonly string[];
  },
  readBudget: FormerChildReconciliationReadBudget,
): FormerChildReconciliationResult {
  return reconcileFormerChildMembershipsInternal(input, [], readBudget);
}

/**
 * The owner-state preflight for `authoring-owner` posts, run before both dry
 * run output and `--apply`. Continuation modes check the target's opening and
 * latest trusted markers. Acquire and bootstrap replay a child target's
 * current and former membership history before replaying the declared
 * anchor's complete owner log, allowing only a fresh self-anchored generation
 * or a child that joins the matching open set. Nothing is sent when a read or
 * gate fails.
 */
function checkAuthoringOwnerPostIdentity(input: {
  body: string;
  markerPrefix: string;
  markerTarget: ParsedIssueReference | null;
  trustedMarkerLoginsFlag: string;
}): Exclude<HelperCliResult, number> | null {
  const { markerTarget } = input;
  if (markerTarget === null) {
    const message = '--marker-target is required for --type authoring-owner';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  const post = parseAuthoringOwnerComment(input.body, input.markerPrefix);
  if (post === null) {
    const message =
      'refusing to post authoring-owner marker: the rendered body does not re-parse for the identity check';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'internal', message };
  }
  const acquisitionMode = post.mode === 'acquire' || post.mode === 'bootstrap';
  const formerChildReadBudget: FormerChildReconciliationReadBudget = {
    formerAnchorReads: 0,
  };
  if (
    !acquisitionMode &&
    !AUTHORING_OWNER_IDENTITY_CHECKED_MODES.has(post.mode)
  ) {
    return null;
  }
  const anchorTarget = acquisitionMode
    ? parseIssueReference(post.anchor)
    : markerTarget;
  if (anchorTarget === null) {
    const message = acquisitionMode
      ? `refusing to post authoring-owner marker (mode=${post.mode}): --anchor ${post.anchor} is not a readable issue reference`
      : '--marker-target is required for --type authoring-owner';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'gate', message };
  }
  const { actors } = resolveTrustedActors({
    flagValue: input.trustedMarkerLoginsFlag,
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config: loadIddConfig(),
  });
  if (acquisitionMode && actors.length === 0) {
    const message =
      `refusing to post authoring-owner marker (mode=${post.mode}): ` +
      'trusted marker actor list is empty, so owner history cannot be verified';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'gate', message };
  }
  if (acquisitionMode && !sameIssueRef(post.target, post.anchor)) {
    const target = parseIssueReference(post.target);
    if (target === null) {
      const message =
        `refusing to post authoring-owner marker (mode=${post.mode}): ` +
        `target ${post.target} is not a readable issue reference`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'gate', message };
    }
    let targetComments: AuthoringOwnerProvenanceComment[];
    try {
      targetComments = fetchProvenanceCommentsGraphql(
        target.owner,
        target.repo,
        target.number,
      );
    } catch (error) {
      const readRef = `${target.owner}/${target.repo}#${target.number}`;
      const message =
        `refusing to post authoring-owner marker (mode=${post.mode}): ` +
        `the owner history of child target ${readRef} could not be read, ` +
        `so its prior membership cannot be checked: ${(error as Error).message}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, ...classifyHelperError(error), message };
    }
    const targetReconciliation = reconcileFormerChildMembershipsWithBudget(
      {
        comments: targetComments,
        historyTargetRef: post.target,
        markerPrefix: input.markerPrefix,
        trusted: actors,
      },
      formerChildReadBudget,
    );
    if ('problem' in targetReconciliation) {
      const message =
        `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: ` +
        `the target's prior owner history cannot be reconciled: ${targetReconciliation.problem}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'gate', message };
    }
    const targetReplay = resolveAnchorOwnerGeneration({
      comments: targetReconciliation.comments,
      anchorRef: post.target,
      markerPrefix: input.markerPrefix,
      trusted: actors,
      supersedingOpenings: targetReconciliation.supersedingOpenings,
    });
    let targetRefusal: string | null = null;
    if ('problem' in targetReplay) {
      targetRefusal =
        `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: ` +
        `the target's own owner history cannot be replayed: ${targetReplay.problem}`;
    } else if (
      targetReconciliation.closedSets.has(post.set) ||
      targetReplay.closedSets.has(post.set)
    ) {
      targetRefusal =
        `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: ` +
        `set ${post.set} was already closed in the target's verified owner history`;
    } else if (targetReplay.generation !== null) {
      targetRefusal =
        `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: ` +
        `the target already has open set ${targetReplay.generation.set}` +
        `${targetReplay.generation.releasing ? ' with release in progress' : ''}`;
    }
    if (targetRefusal !== null) {
      process.stderr.write(`${targetRefusal}\n`);
      return { exitCode: 1, kind: 'gate', message: targetRefusal };
    }
  }
  let comments: AuthoringOwnerProvenanceComment[];
  try {
    comments = fetchProvenanceCommentsGraphql(
      anchorTarget.owner,
      anchorTarget.repo,
      anchorTarget.number,
    );
  } catch (error) {
    const readRef = `${anchorTarget.owner}/${anchorTarget.repo}#${anchorTarget.number}`;
    const purpose = acquisitionMode
      ? 'the anchor owner history cannot be checked'
      : 'its opening markers cannot be checked';
    const message = `refusing to post authoring-owner marker (mode=${post.mode}): the comments of ${readRef} could not be read, so ${purpose}: ${(error as Error).message}`;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, ...classifyHelperError(error), message };
  }
  const trustedLogins = new Set(actors);
  if (acquisitionMode) {
    const reconciliation = reconcileFormerChildMembershipsWithBudget(
      {
        comments,
        historyTargetRef: post.anchor,
        markerPrefix: input.markerPrefix,
        trusted: actors,
      },
      formerChildReadBudget,
    );
    if ('problem' in reconciliation) {
      const refusal = `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: former child membership history cannot be reconciled: ${reconciliation.problem}`;
      process.stderr.write(`${refusal}\n`);
      return { exitCode: 1, kind: 'gate', message: refusal };
    }
    const replay = resolveAnchorOwnerGeneration({
      comments: reconciliation.comments,
      anchorRef: post.anchor,
      markerPrefix: input.markerPrefix,
      trusted: actors,
      supersedingOpenings: reconciliation.supersedingOpenings,
    });
    let refusal: string | null = null;
    if ('problem' in replay) {
      refusal = `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: the owner history of anchor ${post.anchor} cannot be replayed: ${replay.problem}`;
    } else if (
      replay.closedSets.has(post.set) ||
      reconciliation.closedSets.has(post.set)
    ) {
      refusal = `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: set ${post.set} was already closed by a trusted release-complete marker in the verified history of anchor ${post.anchor}`;
    } else if (sameIssueRef(post.target, post.anchor)) {
      if (replay.generation !== null) {
        refusal = `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: anchor ${post.anchor} already has open set ${replay.generation.set}${replay.generation.releasing ? ' with release in progress' : ''}`;
      }
    } else if (replay.generation === null) {
      refusal = `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: anchor ${post.anchor} has no open owner generation to join`;
    } else if (replay.generation.releasing) {
      refusal = `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: set ${replay.generation.set} of anchor ${post.anchor} is being released`;
    } else if (
      replay.generation.set !== post.set ||
      replay.generation.session !== post.session
    ) {
      refusal = `refusing to post authoring-owner marker (mode=${post.mode}) on ${post.target}: requested set/session ${post.set}/${post.session} does not match anchor ${post.anchor}'s open generation ${replay.generation.set}/${replay.generation.session}`;
    }
    if (refusal === null) {
      return null;
    }
    process.stderr.write(`${refusal}\n`);
    return { exitCode: 1, kind: 'gate', message: refusal };
  }
  const refusal = validateAuthoringOwnerPostIdentity(
    post,
    selectAuthoringOwnerOpeningMarkers(comments, {
      target: post.target,
      markerPrefix: input.markerPrefix,
      trustedLogins,
      requireUnedited: true,
    }),
    selectLatestAuthoringOwnerMarker(comments, {
      target: post.target,
      markerPrefix: input.markerPrefix,
      trustedLogins,
    }),
  );
  if (refusal === null) {
    return null;
  }
  process.stderr.write(`${refusal}\n`);
  return { exitCode: 1, kind: 'gate', message: refusal };
}

/**
 * Fetch PR `<n>`'s current head commit SHA via a single lightweight `gh pr
 * view` call -- the `--from-pr` derivation path for the advisory-family
 * marker types (#1889: `advisory` / `advisory-recovery` / `advisory-reroll`;
 * #2050: `review-ack`), which need only `--head-sha`, unlike `watermark`'s
 * `--from-pr`, which collects one in-process review-activity snapshot.
 * This is deliberately network-lighter
 * than that snapshot: no CI checks, review threads, or comment pagination,
 * just the one `headRefOid` field.
 *
 * Throws (fail-closed) when `headRefOid` comes back empty or missing, so a
 * malformed `gh pr view` response can never post a marker with a blank
 * `head-sha` -- mirrors {@link watermarkFieldsFromSnapshot}'s guard on the
 * watermark path.
 */
function headShaFromPr(prNumber: number, owner: string, repo: string): string {
  const headSha = createGithubProviderAdapter(
    owner,
    repo,
  ).getChangeRequestHeadSha(prNumber);
  // Validate the shape here (not just non-empty): a non-SHA value (e.g. the
  // literal text "null" if `gh` ever printed that instead of a real SHA)
  // would otherwise pass this check and only fail later inside
  // buildMarkerBody's renderer with a generic "invalid ... marker payload"
  // message that does not name the actual cause. Fail closed here instead
  // with a targeted error (Copilot review, #1889/#1891).
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error(
      `PR ${prNumber} has no usable headRefOid (expected a 40-hex-character SHA, got: ${headSha || '(empty)'})`,
    );
  }
  return headSha;
}

// ---------------------------------------------------------------------------
// F4 head proof (#4368)
// ---------------------------------------------------------------------------

/** The field flags `--type f4-head-proof` takes; every other proof value is read live. */
const F4_HEAD_PROOF_FLAGS: readonly string[] =
  REQUIRED_FIELDS_BY_TYPE['f4-head-proof'];

/**
 * The optional field flag `--type f4-head-proof` takes (#4442): the comment ID
 * of the malformed proof that a corrected proof replaces.
 */
const F4_HEAD_PROOF_OPTIONAL_FLAGS: readonly string[] = ['supersedes'];

/**
 * Run `--type f4-head-proof`: the live reads, the verdict, and (under
 * `--apply`, on a `post` verdict) the POST and its read-back all happen in
 * `runF4HeadProofGate`. This wrapper checks the flags, passes the live
 * dependencies, prints the JSON envelope, and maps the verdict to the exit
 * status (0 for proceed and post, 1 for hold and stop). A renderer or read
 * error exits non-zero with nothing posted. `createDeps` is the seam a test
 * replaces with fake callbacks; production uses the live wiring.
 */
export function runF4HeadProofCommand(
  args: CliArgs,
  number: number,
  createDeps: typeof createLiveF4HeadProofDeps = createLiveF4HeadProofDeps,
): HelperCliResult {
  const unexpected = Object.keys(args.fields).filter(
    (flag) =>
      !F4_HEAD_PROOF_FLAGS.includes(flag) &&
      !F4_HEAD_PROOF_OPTIONAL_FLAGS.includes(flag),
  );
  // The repository is the current checkout's: the worktree must be registered
  // there, so a flag that names another repository could only mismatch it.
  // Neither list can widen what the command trusts or reads either: the
  // trusted logins come from the environment and the trusted configuration.
  const supplied = args.suppliedFlags ?? [];
  if (
    args.owner !== '' ||
    args.repo !== '' ||
    supplied.includes('--owner') ||
    supplied.includes('--repo')
  ) {
    const message =
      '--type f4-head-proof does not take --owner or --repo: the repository is the current checkout, and --worktree must be registered there';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  for (const [flag, value] of [
    ['--trusted-marker-logins', args.trustedMarkerLogins],
    ['--advisory-bot-logins', args.advisoryBotLogins],
  ] as const) {
    if (value !== '' || supplied.includes(flag)) {
      const message = `--type f4-head-proof does not take ${flag}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
  }
  if (unexpected.length > 0) {
    const message = `--type f4-head-proof takes only --target, --claim-id, --agent-id and --worktree, plus --supersedes for a corrected proof (every proof value is read live); do not pass: ${unexpected
      .map((flag) => `--${flag}`)
      .join(', ')}`;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  const supersedesText: string | undefined = args.fields.supersedes;
  let supersedes: number | undefined;
  if (supersedesText !== undefined) {
    const value = Number(supersedesText);
    if (!/^[1-9][0-9]*$/.test(supersedesText) || !Number.isSafeInteger(value)) {
      const message =
        '--supersedes takes a positive decimal comment ID, with no sign and no leading zero';
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    supersedes = value;
  }
  try {
    for (const field of F4_HEAD_PROOF_FLAGS) {
      requireFlag(args.fields[field], `--${field}`);
    }
    const outcome = runF4HeadProofGate(
      {
        issueNumber: number,
        claimId: args.fields['claim-id'],
        agentId: args.fields['agent-id'],
        worktree: args.fields.worktree,
        apply: args.apply,
        ...(supersedes === undefined ? {} : { supersedes }),
      },
      createDeps({ resolveRepo: resolveCheckoutRepository }),
    );
    if (outcome.kind === 'refused') {
      process.stderr.write(`${outcome.message}\n`);
      return { exitCode: 1, kind: 'usage', message: outcome.message };
    }
    const envelope: PostIddMarkerResult = outcome.output;
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    if (outcome.exitCode === 0) {
      return 0;
    }
    const { verdict, reason, nextAction } = outcome.output;
    const message =
      `f4-head-proof: ${verdict} (${reason}). ${nextAction ?? ''}`.trim();
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'gate', message };
  } catch (error) {
    const message = (error as Error).message;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, ...classifyHelperError(error), message };
  }
}

// ---------------------------------------------------------------------------
// Hide-at-post-time (#2754): review-ack / copilot-unavailable
// ---------------------------------------------------------------------------

/** One comment shaped for the candidate scan below -- REST `id` (read by the
 * caller's own `comment.id < postedCommentId` ordering filter, never by the
 * finder functions themselves), the GraphQL `nodeId` `minimizeComment`
 * needs, and `body` to parse. Narrowed from {@link ProviderComment} (which
 * carries `nodeId` as an OPTIONAL field, #2754) down to the four fields
 * this module actually reads -- `findSupersededReviewAckSubjects` /
 * `findSupersededCopilotUnavailableSubjects` themselves only read `nodeId`
 * and `body`; `authorLogin` is read by `hideSupersededPostTimeMarkers`
 * itself, to confirm the just-posted marker's OWN author is trusted before
 * scanning for anything to hide (#2754, chatgpt-codex-connector review on
 * PR #2788). */
export interface MarkerCandidateComment {
  id: number;
  nodeId: string;
  body: string;
  authorLogin: string;
}

/**
 * List every comment on `number` (issue or PR -- same comments endpoint),
 * shaped for the hide-at-post-time candidate scan. Routed through
 * {@link createGithubProviderAdapter} (`listWorkItemComments`), like every
 * other read in this migrated file (#2266) -- `post-idd-marker.mts` must
 * never construct a `gh` call of its own
 * (lint-source-boundaries' PROVIDER-PORT-MIGRATED rule). A comment missing a
 * `nodeId` (defensive: the real adapter always populates it from REST's
 * `node_id`) normalizes to `''`, which the finder functions below already
 * skip.
 */
function listMarkerCandidateComments(
  owner: string,
  repo: string,
  number: number,
  timeoutMs?: number,
): MarkerCandidateComment[] {
  return createGithubProviderAdapter(owner, repo)
    .listWorkItemComments(
      number,
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    )
    .map((comment) => ({
      id: comment.id,
      nodeId: comment.nodeId ?? '',
      body: comment.body,
      authorLogin: comment.authorLogin ?? '',
    }));
}

/**
 * Find prior `review-ack:` comments (among `comments`, already excluding the
 * marker just posted) whose embedded HEAD SHA differs from `newHeadSha` --
 * the candidates a fresh `review-ack` post should minimize as `OUTDATED`,
 * mirroring the shipped `advisory-wait` AW3-H rule. Never returns a
 * candidate matching `newHeadSha` (current-HEAD protection) or an
 * unparseable / non-`review-ack:` comment.
 */
export function findSupersededReviewAckSubjects(
  comments: readonly MarkerCandidateComment[],
  newHeadSha: string,
): string[] {
  const target = newHeadSha.trim().toLowerCase();
  const subjects: string[] = [];
  for (const comment of comments) {
    if (!comment.nodeId) {
      continue;
    }
    const parsed = parseReviewAckComment(comment.body, 'none');
    if (!parsed || parsed.headSha === target) {
      continue;
    }
    subjects.push(comment.nodeId);
  }
  return subjects;
}

/**
 * Find prior `copilot-unavailable:` comments (among `comments`, already
 * excluding the marker just posted) carrying the SAME `claim:` value as
 * `newClaimId` -- the candidates a fresh `copilot-unavailable` post should
 * minimize as `OUTDATED`, mirroring the shipped watermark/claim-chain
 * supersession rule. Never returns a candidate whose `claim:` value differs
 * (foreign-claim protection) or an unparseable / non-`copilot-unavailable:`
 * comment.
 */
export function findSupersededCopilotUnavailableSubjects(
  comments: readonly MarkerCandidateComment[],
  newClaimId: string,
  newAttempt: number,
): string[] {
  // Trim before comparing (caught by Copilot review on PR #2788):
  // renderCopilotUnavailableMarker normalizes claimId via
  // normalizeNonWhitespaceToken() (trim + reject internal whitespace)
  // before posting, so by the time this runs -- strictly after that POST
  // already succeeded -- newClaimId can only ever carry leading/trailing
  // whitespace relative to what was actually posted (internal whitespace
  // would have failed that render-time validation and never reached
  // here). Comparing the untrimmed CLI flag value against parsed.claimId
  // (already whitespace-free, matched via `\S+`) would otherwise never
  // match a same-claim prior comment when the caller passed the flag with
  // surrounding whitespace, silently leaving it un-hidden.
  const target = newClaimId.trim();
  const subjects: string[] = [];
  for (const comment of comments) {
    if (!comment.nodeId) {
      continue;
    }
    const parsed = parseCopilotUnavailableComment(comment.body, 'none');
    if (!parsed || parsed.claimId !== target) {
      continue;
    }
    // Only a STRICTLY LOWER attempt number is ever superseded (caught by
    // chatgpt-codex-connector review on PR #2788, round 5): claim:
    // equality alone says nothing about which attempt is actually more
    // advanced. Two same-claim sessions racing on the SAME HEAD (no HEAD
    // drift needed -- the live-HEAD gate above cannot catch this) can
    // still POST out of attempt order -- e.g. attempt 2 lands with a
    // LOWER REST id while a stalled attempt 1 lands with the next one --
    // and an attempt-blind filter would let that delayed, regressive
    // attempt 1 hide the more advanced attempt 2, leaving the regressive
    // marker as the only one expanded. A same-attempt candidate (a bare
    // retry of this exact attempt number, e.g. re-POSTing after a failed
    // hide step) is deliberately left alone rather than guessing whether
    // it is a true duplicate: current-attempt protection, the same
    // conservative "when ambiguous, never hide" policy the live-HEAD gate
    // above already applies to a same-embedded-HEAD review-ack.
    if (!(parsed.attempt < newAttempt)) {
      continue;
    }
    subjects.push(comment.nodeId);
  }
  return subjects;
}

/**
 * Overall time budget (#2754, chatgpt-codex-connector review on PR #2788,
 * three rounds) for the ENTIRE {@link hideSupersededPostTimeMarkers} step,
 * from its own first line to its return -- not just `runMinimize`'s
 * mutation pass. Round 2 gave `runMinimize` an internal `deadlineMs`, but
 * that clock only started at ITS OWN entry, leaving every network call
 * BEFORE it (the `review-ack` live-HEAD re-check, and the comments listing
 * every type makes) outside the budget entirely -- the comments listing
 * alone defaults to `DEFAULT_GH_PAGINATED_TIMEOUT_MS` (120s, gh-exec.mts)
 * when not told otherwise, already larger than this whole step's intended
 * budget. `hideSupersededPostTimeMarkers` now starts its own clock first
 * and re-checks the REMAINING budget before each of its three network
 * stages (the optional HEAD re-check, the comments listing, and the
 * `runMinimize` pass), passing that remainder as each stage's own timeout
 * (or `deadlineMs`, for `runMinimize`) instead of a fixed constant, and
 * bailing out (never with a `0`/no-op timeout, which `gh-exec.mts` and
 * `execFileSync` both read as "unbounded") the instant the remainder is
 * non-positive. The true worst case for the one stage already in flight
 * when the budget runs out is that stage's own default timeout beyond
 * `HIDE_STEP_DEADLINE_MS` (up to `DEFAULT_GH_TIMEOUT_MS` for the HEAD
 * re-check, `DEFAULT_GH_PAGINATED_TIMEOUT_MS` for the comments listing, or
 * `GH_TIMEOUT_MS` for `runMinimize`'s own in-flight candidate -- see that
 * function's `deadlineMs` doc comment) -- but no stage can ever START once
 * the budget is already spent.
 */
const HIDE_STEP_DEADLINE_MS = 45_000;

/**
 * Best-effort hide-at-post-time step for {@link HIDE_AT_POST_TIME_MARKER_TYPES}
 * (#2754). Runs only after `postedCommentId`'s own POST already succeeded
 * (the caller invokes this strictly afterward, never before or interleaved),
 * scans the target's OTHER comments for same-family markers superseded by
 * the one just posted, and reuses `minimize-superseded-markers.mts`'s
 * `runMinimize` for the actual mutation -- the same trusted-author gate,
 * already-`isMinimized` skip, and `viewerCanMinimize` check that helper
 * already implements, so this call site adds no new mutation logic of its
 * own. Every failure (an unreadable comment list, a `gh` permission error, a
 * malformed GraphQL response, anything else) is swallowed here: this step
 * must never retry-loop or throw back into the caller, since the marker it
 * is hiding *for* has already posted successfully by the time this runs.
 *
 * Candidates are restricted to comments **older** than `postedCommentId`
 * (`comment.id < postedCommentId`, REST issue-comment ids are assigned
 * sequentially at creation) rather than merely excluding an exact id match
 * (caught by chatgpt-codex-connector review on PR #2788): the comments scan
 * runs after this marker's own POST, so a concurrent session's marker
 * created in that window can already appear in the listing with a HIGHER
 * id. An inequality-only filter would treat that genuinely newer marker as
 * "prior" and hide it as `OUTDATED` -- exactly backwards, since it is this
 * call's own marker that is older by comparison. The `<` restriction
 * excludes it structurally, independent of what its embedded HEAD SHA or
 * `claim:` value happens to be.
 *
 * For BOTH types, this also re-reads the target PR's LIVE head SHA and, when
 * it no longer matches `fields['head-sha']`, SELF-MINIMIZES the marker this
 * call itself just posted instead of scanning for prior candidates (caught
 * by chatgpt-codex-connector review on PR #2788, three rounds -- rounds 3-4
 * bailed out entirely here; round 5 found that abandoning the just-posted
 * marker left it expanded forever with no later invocation guaranteed to
 * sweep it, mirroring the self-minimize sibling #2755 shipped for
 * `idd-local-validation-evidence:` after the same finding there): `review-
 * ack`'s usual `--from-pr` reads HEAD once before composing and POSTing the
 * marker body, so on a slow POST the branch can advance and a concurrent
 * session can already have posted a genuine, current-HEAD acknowledgement by
 * the time this step runs. The `id <` restriction above only orders
 * candidates by creation time -- it cannot tell a stale marker from a fresh
 * one once both are "prior" by id, so scanning for prior candidates while
 * stale could minimize that valid newer acknowledgement while leaving this
 * call's own, now-superseded one visible: destroying the correct evidence
 * instead of the stale evidence. `copilot-unavailable` never derives
 * `--head-sha` from `--from-pr` (its supersession key, `claim-id`, always
 * comes from an explicit CLI flag), but that only rules out THIS caller's
 * own embedded value going stale between observation and POST -- it does
 * nothing about a genuinely different, concurrent same-claim poster (e.g. a
 * stalled pre-handoff session finally completing its retry against a claim a
 * handoff already moved on from): `findSupersededCopilotUnavailableSubjects`
 * matches purely on `claim:` equality, with no HEAD comparison of its own,
 * so a STALE same-claim post could still treat an earlier, CURRENT-HEAD
 * same-claim post as "superseded" purely by virtue of posting later (round 2
 * review, initially missed: the check below was `review-ack`-only until
 * round 4). Applying the same live-HEAD gate to both types closes that gap
 * without needing a HEAD-aware rewrite of the claim-based finder itself: a
 * poster who is observably stale relative to current HEAD never scans for
 * OTHER candidates, regardless of which family it belongs to -- it only ever
 * minimizes its own just-posted comment. The trust gate below (on
 * `postedComment` itself) still applies either way, so an untrusted post
 * never triggers even its own self-minimize. A failed re-read (not a PR,
 * `gh` error, anything else) falls through to the outer catch below and
 * skips the whole pass, same as any other best-effort failure.
 *
 * This step ALSO requires `postedCommentId`'s own author to be in the same
 * `trustedSet` `runMinimize` already gates candidates on (caught by
 * chatgpt-codex-connector review on PR #2788): `post-idd-marker.mjs`
 * performs no author gating of its own -- anyone with `gh` credentials can
 * invoke `--apply` -- so downstream trust-filtered consumers already
 * ignore an untrusted marker as if it never existed. Without this check,
 * that untrusted post's mere presence would still drive this scan, and an
 * older TRUSTED candidate sharing its supersession key (a same-claim
 * `copilot-unavailable`, or a same-HEAD `review-ack`) would still get
 * minimized purely because ITS OWN author is trusted -- collapsing the one
 * copy of the marker downstream consumers actually rely on, leaving only
 * the ignored untrusted replacement expanded. Bails out (no scan, no
 * mutation) when `postedCommentId`'s own comment cannot be re-read at all,
 * fail-closed the same way an unreadable comment list already fails
 * closed elsewhere in this function.
 */
export function hideSupersededPostTimeMarkers(
  type: HideAtPostTimeMarkerType,
  fields: MarkerFields,
  owner: string,
  repo: string,
  number: number,
  postedCommentId: number,
  trustedMarkerLoginsFlag: string,
  deadlineMs: number,
): void {
  // Clock starts here, before ANY network call this step makes (#2754,
  // chatgpt-codex-connector review round 3 on PR #2788) -- round 2's
  // deadlineMs only bounded runMinimize's OWN pass, timed from ITS entry,
  // which left every read before that call (the review-ack live-HEAD
  // re-check, and the comments listing every type makes) outside the
  // budget entirely. The comments listing in particular defaults to
  // `DEFAULT_GH_PAGINATED_TIMEOUT_MS` (120s, gh-exec.mts) when not told
  // otherwise -- alone larger than this whole step's intended budget.
  const startedAt = Date.now();
  const remaining = (): number => deadlineMs - (Date.now() - startedAt);
  try {
    // #2754, chatgpt-codex-connector review round 5 on PR #2788: a stale
    // live-HEAD no longer means "abandon this step entirely" -- it means
    // "the marker this call just posted is ITSELF the superseded one".
    // `stale` is recorded (no early return) so the trust gate below still
    // runs on the shared `postedComment` read either way, and the subject
    // set further down switches to self-minimizing that one comment
    // instead of scanning for prior candidates. Sibling #2755 shipped this
    // exact self-minimize behavior for `idd-local-validation-evidence:`
    // after Codex found the same gap there first.
    let stale = false;
    {
      const r = remaining();
      // Never pass `timeout: 0` to a `gh` call below -- gh-exec.mts (like
      // Node's own `execFileSync`) treats that as "no timeout", the exact
      // opposite of "budget already exhausted". Bailing out here instead
      // is what makes a non-positive remainder safe.
      if (r <= 0) {
        return;
      }
      const liveHeadSha = createGithubProviderAdapter(
        owner,
        repo,
      ).getChangeRequestHeadSha(number, { timeoutMs: r });
      stale =
        liveHeadSha.trim().toLowerCase() !==
        fields['head-sha'].trim().toLowerCase();
    }
    const { actors } = resolveTrustedActors({
      flagValue: trustedMarkerLoginsFlag,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
      config: loadIddConfig(),
    });
    const trustedSet = new Set(actors);
    const commentsListR = remaining();
    if (commentsListR <= 0) {
      return;
    }
    const allComments = listMarkerCandidateComments(
      owner,
      repo,
      number,
      commentsListR,
    );
    const postedComment = allComments.find(
      (comment) => comment.id === postedCommentId,
    );
    if (
      !postedComment ||
      !isTrustedAuthor(postedComment.authorLogin, trustedSet)
    ) {
      // The marker this call just posted is itself untrusted (or its own
      // record could not be re-read) -- never let an untrusted post drive
      // this step to minimize an older, TRUSTED candidate, or to
      // self-minimize on ITS OWN say-so when stale. Downstream
      // trust-filtered consumers already ignore an untrusted marker as if
      // it never existed; letting it collapse the trusted terminal marker
      // it claims to supersede would erase the only copy those consumers
      // actually rely on (#2754, chatgpt-codex-connector review on PR
      // #2788).
      return;
    }
    const subjectIds = stale
      ? postedComment.nodeId
        ? [postedComment.nodeId]
        : []
      : (() => {
          const comments = allComments.filter(
            (comment) => comment.id < postedCommentId,
          );
          return type === 'review-ack'
            ? findSupersededReviewAckSubjects(comments, fields['head-sha'])
            : findSupersededCopilotUnavailableSubjects(
                comments,
                fields['claim-id'],
                Number(fields.attempt),
              );
        })();
    if (subjectIds.length === 0) {
      return;
    }
    const mutationPassR = remaining();
    if (mutationPassR <= 0) {
      return;
    }
    runMinimize({
      subjectIds,
      classifier: 'OUTDATED',
      trustedSet,
      apply: true,
      allowUntrusted: false,
      deadlineMs: mutationPassR,
    });
  } catch {
    // Best-effort only (#2754) -- never block or retry-loop the marker post
    // that already succeeded above.
  }
}

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('post-idd-marker', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}

function main(): HelperCliResult {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = (error as Error).message;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  // #1833: populated only by the `--from-pr` snapshot-derivation branch
  // below; carried into both the dry-run and `--apply` result envelopes.
  let warnings: string[] = [];
  let operationLocalEnvelope: OperationLocalWatermarkView | null = null;

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!MARKER_TYPES.includes(args.type as MarkerType)) {
    const message = `--type is required and must be one of: ${MARKER_TYPES.join(', ')}`;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  // --expected-head-sha only guards the --from-pr --type watermark
  // derivation below; in manual mode the caller already supplies --head-sha
  // directly, so there is nothing to compare it against. It has no meaning
  // for the advisory-family --from-pr types (#1889 / #2050): they have no
  // E1 Step 1/Step 2 pinning concept, so reject the combination the same way
  // rather than silently ignoring it.
  if (args.expectedHeadSha && args.fromPr === null) {
    const message = '--expected-head-sha is only valid together with --from-pr';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  if (
    args.expectedHeadSha &&
    args.fromPr !== null &&
    args.type !== 'watermark'
  ) {
    const message =
      '--expected-head-sha is only valid together with --from-pr --type watermark';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  // #4053: --global-only only changes the --from-pr --type watermark CI read.
  // Elsewhere it would be silently ignored, so reject it like --expected-head-sha.
  if (args.globalOnly && (args.fromPr === null || args.type !== 'watermark')) {
    const message =
      '--global-only is only valid together with --from-pr --type watermark';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  if (
    args.operationLocal &&
    (args.type !== 'watermark' || args.fromPr === null)
  ) {
    const message =
      '--operation-local is only valid with --type watermark --from-pr';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  const priorFlagsPresent = [
    args.priorHeadSha !== '',
    args.priorTotalItemCount !== null,
    args.priorMaxActivityAt !== '',
  ];
  const hasAnyPrior = priorFlagsPresent.some(Boolean);
  if (hasAnyPrior && !priorFlagsPresent.every(Boolean)) {
    const message =
      '--prior-head-sha, --prior-total-item-count and --prior-max-activity-at must be passed together';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  if (
    args.priorBaseRef !== '' &&
    (args.type !== 'watermark' || args.fromPr === null)
  ) {
    const message =
      '--prior-base-ref is only valid with --type watermark --from-pr';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  if (hasAnyPrior && !args.operationLocal) {
    const message =
      '--prior-head-sha, --prior-total-item-count and --prior-max-activity-at are only valid with --operation-local';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  if (
    hasAnyPrior &&
    args.priorMaxActivityAt !== 'none' &&
    !isValidIsoTimestamp(args.priorMaxActivityAt)
  ) {
    // Same predicate compareIsoTimestamps uses, so a value is accepted only
    // if it orders as an instant; anything else would read as a confusing
    // "newly actionable activity" refusal instead of a bad argument.
    const message =
      '--prior-max-activity-at must be none or a canonical UTC timestamp such as 2026-06-25T10:30:00Z';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }

  // `--from-pr <n>` derivation mode: default the post target to PR <n>,
  // reject the manually-supplied derived field(s) as ambiguous, then derive
  // those fields from a live PR <n> read before the shared render +
  // dry-run/apply path below. owner/repo are resolved here because the
  // derivation needs them and the dry-run branch returns before the
  // apply-path resolution.
  //
  // `--type watermark` derives all four snapshot fields via the full
  // review-activity-snapshot composition (unchanged since #1134). The
  // advisory-family types (#1889: `advisory` / `advisory-recovery` /
  // `advisory-reroll`; #2050: `review-ack`) derive only `--head-sha`, via
  // the lighter single-`gh pr view`-call `headShaFromPr` -- those renderers
  // accept no other snapshot-shaped field, so composing the full snapshot
  // for them would be needless extra network work.
  if (args.fromPr !== null) {
    if (!FROM_PR_MARKER_TYPES.includes(args.type as FromPrMarkerType)) {
      const message = `--from-pr is only valid for --type ${FROM_PR_MARKER_TYPES.join(', ')}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    const isWatermark = args.type === 'watermark';
    // --from-pr always posts the marker to PR <n>. `--target` is
    // descriptive-only (issue/pr both POST to the same /issues/<n>/comments
    // endpoint), but an `issue`-targeted PR-derived marker is incoherent, so
    // fail closed on an explicit non-pr target rather than recording it.
    if (args.target && args.target !== 'pr') {
      const message = `--from-pr always targets the PR; remove --target ${args.target}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    args.target = 'pr';
    if (args.number === null) {
      args.number = args.fromPr;
    } else if (args.number !== args.fromPr) {
      const message =
        'in --from-pr mode the positional number must be omitted or equal --from-pr';
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    const derivedFlags = isWatermark
      ? ['head-sha', 'max-activity-at', 'total-item-count', 'ci-completed-at']
      : ['head-sha'];
    const conflicting = derivedFlags.filter((flag) => flag in args.fields);
    if (conflicting.length > 0) {
      const message = `--from-pr derives ${derivedFlags.join(' / ')} from the live ${isWatermark ? 'snapshot' : 'PR'}; do not also pass: ${conflicting
        .map((flag) => `--${flag}`)
        .join(', ')}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    // Resolve owner/repo inside the try: in --from-pr mode they are read
    // eagerly (the derivation needs them and the dry-run branch returns
    // before the apply-path resolution), so a `gh` failure here is part of
    // "derive from PR" and should report cleanly, not throw a raw stack.
    try {
      const currentRepo =
        args.owner && args.repo ? null : resolveCurrentGithubRepository();
      args.owner = args.owner || currentRepo?.owner || '';
      args.repo = args.repo || currentRepo?.repo || '';
      if (isWatermark) {
        if (args.priorBaseRef === '') {
          const message =
            '--type watermark --from-pr requires --prior-base-ref <Step 1 base ref>: the publish-time base ref is compared with it';
          process.stderr.write(`${message}\n`);
          return { exitCode: 1, kind: 'usage', message };
        }
        const local = runOperationLocalSnapshotWatermark({
          prNumber: args.fromPr,
          expectedHeadSha: args.expectedHeadSha || undefined,
          expectedBaseRefName: args.priorBaseRef,
          priorBoundary:
            args.priorTotalItemCount === null
              ? null
              : {
                  headSha: args.priorHeadSha,
                  totalItemCount: args.priorTotalItemCount,
                  maxActivityUpdatedAt: args.priorMaxActivityAt,
                },
          collectRichActivity: () =>
            collectReviewActivitySnapshot({
              prNumber: args.fromPr ?? 0,
              owner: args.owner,
              repo: args.repo,
              trustedMarkerLoginsFlag: args.trustedMarkerLogins,
              advisoryBotLoginsFlag: args.advisoryBotLogins,
              envTrustedMarkerActors: process.env.IDD_TRUSTED_MARKER_ACTORS,
              envAdvisoryBotLogins: process.env.IDD_ADVISORY_BOT_LOGINS,
              port: createGithubProviderAdapter(args.owner, args.repo),
            }),
          readRequiredCiAgreement: () =>
            readWatermarkRequiredCiAgreement({
              prNumber: args.fromPr ?? 0,
              owner: args.owner,
              repo: args.repo,
              globalOnly: args.globalOnly,
            }),
        });
        if (local.decision !== 'publish') {
          const message = local.reason ?? 'refusing to post watermark';
          if (args.operationLocal && local.decision === 'defer') {
            const deferred: PostIddMarkerResult = {
              mode: 'dry-run',
              type: 'watermark',
              target: 'pr',
              number: args.number ?? args.fromPr,
              operationLocal: operationLocalView(local),
              ...(local.warnings.length > 0
                ? { warnings: local.warnings }
                : {}),
            };
            process.stdout.write(`${JSON.stringify(deferred, null, 2)}\n`);
            return 0;
          }
          process.stderr.write(`${message}\n`);
          if (args.operationLocal) {
            const refused: PostIddMarkerResult = {
              mode: 'dry-run',
              type: 'watermark',
              target: 'pr',
              number: args.number ?? args.fromPr,
              operationLocal: operationLocalView(local),
              ...(local.warnings.length > 0
                ? { warnings: local.warnings }
                : {}),
            };
            process.stdout.write(`${JSON.stringify(refused, null, 2)}\n`);
          }
          // A `ci-read` refusal wraps a failed required-check read: classify
          // the original error as before instead of collapsing it to `gate`.
          const classified =
            local.cause === undefined
              ? { kind: 'gate' as const }
              : classifyHelperError(local.cause);
          return { exitCode: 1, ...classified, message };
        }
        Object.assign(args.fields, local.watermarkFields);
        warnings = local.warnings;
        if (args.operationLocal) {
          operationLocalEnvelope = operationLocalView(local);
        }
      } else {
        args.fields['head-sha'] = headShaFromPr(
          args.fromPr,
          args.owner,
          args.repo,
        );
      }
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause ?? error;
      const message = `failed to derive ${isWatermark ? 'watermark fields' : 'head-sha'} from PR ${args.fromPr}: ${(error as Error).message}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, ...classifyHelperError(cause), message };
    }
  }

  if (!TARGET_KINDS.includes(args.target as TargetKind)) {
    const message = `--target is required and must be one of: ${TARGET_KINDS.join(', ')}`;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  if (args.number === null) {
    const message = 'a positional issue/PR <number> is required';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }

  // #3328: the marker is only ever valid on the PR it names, so `pr:` is
  // derived from `--target pr <n>`'s own positional number rather than a
  // separately typed `--pr` flag, which could otherwise disagree with the
  // actual posting destination.
  if (args.type === 'out-of-loop') {
    if (args.target !== 'pr') {
      const message = '--type out-of-loop requires --target pr';
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    args.fields.pr = String(args.number);
  }

  // #4674: the scope snapshot is an issue record. Its marker prefix comes
  // from repository configuration, and its issue number is derived from the
  // actual posting destination so the record cannot name a different issue.
  if (args.type === 'scope-overrun') {
    if (args.target !== 'issue') {
      const message = '--type scope-overrun requires --target issue';
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    args.fields.issue = String(args.number);
    const suppliedPrefix = args.fields['marker-prefix'];
    if (Boolean(args.owner) !== Boolean(args.repo)) {
      const message =
        '--owner and --repo must be provided together for scope-overrun';
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    if (args.owner && args.repo) {
      const targetPrefix =
        typeof suppliedPrefix === 'string' && suppliedPrefix.trim()
          ? normalizeMarkerPrefix(suppliedPrefix)
          : '';
      if (!targetPrefix) {
        const message =
          'scope-overrun with --owner/--repo requires an explicit non-empty --marker-prefix for the target repository';
        process.stderr.write(`${message}\n`);
        return { exitCode: 1, kind: 'usage', message };
      }
      args.fields['marker-prefix'] = targetPrefix;
    } else {
      const configuredPrefix = normalizeMarkerPrefix(
        loadIddConfig()?.markerPrefix ?? DEFAULT_MARKER_PREFIX,
      );
      if (
        suppliedPrefix !== undefined &&
        normalizeMarkerPrefix(suppliedPrefix) !== configuredPrefix
      ) {
        const message =
          '--marker-prefix for scope-overrun must match configured markerPrefix';
        process.stderr.write(`${message}\n`);
        return { exitCode: 1, kind: 'usage', message };
      }
      args.fields['marker-prefix'] = configuredPrefix;
    }
    const pullRequestFields = ['pull-request', 'branch', 'head-sha'].filter(
      (field) => args.fields[field] !== undefined,
    );
    if (pullRequestFields.length !== 0 && pullRequestFields.length !== 3) {
      const message =
        '--pull-request, --branch, and --head-sha must be provided together';
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
  }

  // #4310: the hold marker is read from the claimed issue's comments (the
  // orchestrator's held-worker renewal rule, docs/idd-workflow.md), so one
  // posted on a PR would be silently missed and the held claim would go stale
  // unrenewed. Refuse it before anything is posted.
  if (args.type === 'idd-hold' && args.target !== 'issue') {
    const message = '--type idd-hold requires --target issue';
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }

  // #4368: the head proof is an issue comment too (F4 step 7 reads it from the
  // claimed issue), and a refusal here costs nothing. Everything else about
  // this type, including the live reads, runs in the dedicated command.
  if (args.type === 'f4-head-proof') {
    if (args.target !== 'issue') {
      const message = '--type f4-head-proof requires --target issue';
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    return runF4HeadProofCommand(args, args.number);
  }

  // #2931: --marker-prefix defaults the same way
  // authoring-owner-provenance.mts's own normalizeMarkerPrefix does -- an
  // explicit --marker-prefix wins, otherwise .github/idd/config.json's
  // markerPrefix, otherwise the distributed 'idd-skill' default. Both
  // authoring types share this resolution; only authoring-owner also
  // derives/verifies body-sha256 below.
  if (
    (AUTHORING_MARKER_TYPES as readonly string[]).includes(args.type) &&
    !args.fields['marker-prefix']
  ) {
    const configured = loadIddConfig()?.markerPrefix;
    args.fields['marker-prefix'] =
      typeof configured === 'string' && configured.trim()
        ? configured.trim()
        : DEFAULT_AUTHORING_MARKER_PREFIX;
  }

  // #2931 (Codex review on PR #2937): normalize every authoring-type field
  // this file's own cross-field coupling checks compare, the same way
  // marker-helpers.mts's normalizeNonWhitespaceToken does (trim) -- BEFORE
  // any of those checks run. Both renderers already trim internally, so a
  // padded value like `--mode ' acquire '` still renders as canonical
  // `mode=acquire` regardless of what this file does; without this step,
  // this file's own Set-membership/equality comparisons see the UNTRIMMED
  // string, match nothing, and silently skip every coupling check below
  // while the renderer still emits the canonical (and cross-field-invalid)
  // marker -- a full bypass of every guard this issue added. Mutates
  // args.fields in place so the checks below AND the final buildMarkerBody
  // call see the identical, already-trimmed value; harmless for the final
  // rendered body either way, since the renderer would trim these same
  // fields itself.
  //
  // `body-sha256` / `snapshot-sha256` (CodeRabbit review on PR #2937,
  // round 5) belong on this same list: validateAuthoringOwnerModeDigestCoupling
  // already trims them internally, but the CLI entry point's own
  // `args.fields['body-sha256'] !== 'none'` sentinel check further below
  // compared the UNTRIMMED value -- a padded `--body-sha256 ' none '`
  // would pass the (trimmed) coupling check yet still trigger this file's
  // live-fetch derive/verify path, which then fails with a confusing
  // digest-mismatch error for what was actually a valid anchor-only
  // invocation.
  //
  // `marker-prefix` (Copilot review on PR #2937, round 7) belongs here
  // too: an explicitly padded `--marker-prefix ' custom-prefix '` is
  // trimmed by both renderers internally, so the rendered body embeds the
  // trimmed prefix, but the terminal round-trip assertion further below
  // was passing the UNTRIMMED prefix to matchCanonicalAuthoringMarkerFamily
  // -- which searches for a marker literally containing that padded
  // prefix and finds none, so the CLI refused a body the renderer had
  // already produced canonically. Not a safety gap (the round-trip
  // assertion still fails CLOSED either way, never posting the
  // mismatched-prefix body), but a needless false rejection this
  // normalization also fixes.
  if ((AUTHORING_MARKER_TYPES as readonly string[]).includes(args.type)) {
    for (const field of [
      'mode',
      'marker-owner',
      'supersedes',
      'actor',
      'state',
      'issue',
      'body-sha256',
      'snapshot-sha256',
      'marker-prefix',
    ]) {
      if (typeof args.fields[field] === 'string') {
        args.fields[field] = args.fields[field].trim();
      }
    }
  }

  // #2931: authoring-owner's --marker-target / --anchor are genuine issue
  // references (unlike authoring-publication-intent's opaque target=/
  // anchor=, see REQUIRED_FIELDS_BY_TYPE's doc comment), so their
  // <owner>/<repo>#<number> shape is validated unconditionally here --
  // BEFORE the REQUIRED_FIELDS_BY_TYPE loop below, so a missing/malformed
  // value reports its own targeted error instead of the renderer's generic
  // "invalid ... marker payload" -- regardless of whether a live fetch
  // ends up happening. Splitting this from the fetch/verify block below
  // keeps validation behavior for --marker-target consistent (always
  // format-checked) rather than depending on --body-sha256's value (a
  // malformed --marker-target with --body-sha256 none previously slipped
  // through unvalidated, since the sentinel skipped the whole block that
  // used to contain this check too).
  //
  // `markerTargetRef` is hoisted to this outer scope because it is reused
  // twice further down: the destination-equality check (this marker's own
  // `target=` must name the SAME issue this CLI is about to post to --
  // Codex/Copilot review on PR #2937, a critical corroborated finding) and
  // the body-sha256 derive/verify block, which no longer needs to re-parse
  // the same value. `--anchor`, unlike `--marker-target`, is validated for
  // FORMAT only, never destination equality -- see isPostingDestination's
  // own doc comment for why (the set anchor legitimately differs from the
  // posting destination for a non-anchor member of a multi-target set).
  let markerTargetRef: ParsedIssueReference | null = null;
  if (args.type === 'authoring-owner') {
    const markerTarget = args.fields['marker-target'];
    if (markerTarget) {
      markerTargetRef = parseIssueReference(markerTarget);
      if (!markerTargetRef) {
        const message = `invalid --marker-target value (expected <owner>/<repo>#<number>): ${markerTarget}`;
        process.stderr.write(`${message}\n`);
        return { exitCode: 1, kind: 'usage', message };
      }
    }
    const anchor = args.fields.anchor;
    let anchorRef: ParsedIssueReference | null = null;
    if (anchor) {
      anchorRef = parseIssueReference(anchor);
      if (!anchorRef) {
        const message = `invalid --anchor value (expected <owner>/<repo>#<number>): ${anchor}`;
        process.stderr.write(`${message}\n`);
        return { exitCode: 1, kind: 'usage', message };
      }
    }
    // #2931 (C1 review finding): reject a --mode/--body-sha256/
    // --snapshot-sha256 combination contract.md's mode table forbids
    // BEFORE the fetch/verify step below -- see
    // validateAuthoringOwnerModeDigestCoupling's own doc comment for why
    // this matters (owner comments are append-only, so a wrong sentinel
    // for the mode is a permanent defect once posted).
    const couplingError = validateAuthoringOwnerModeDigestCoupling(args.fields);
    if (couplingError) {
      process.stderr.write(`${couplingError}\n`);
      return { exitCode: 1, kind: 'usage', message: couplingError };
    }
    // #2931 (Codex review on PR #2937): the same append-only-comment
    // reasoning applies to --supersedes -- contract.md's mode table also
    // constrains it (acquire/bootstrap: none; resume: a real prior-owner
    // token distinct from --marker-owner; release/heartbeat/
    // release-guard/release-complete: exactly --marker-owner).
    const supersedesError = validateAuthoringOwnerSupersedesModeCoupling(
      args.fields,
    );
    if (supersedesError) {
      process.stderr.write(`${supersedesError}\n`);
      return { exitCode: 1, kind: 'usage', message: supersedesError };
    }
    // #2931 (Codex review on PR #2937): release-guard / release-complete
    // are "valid only on the set anchor" (contract.md), and "the anchor's
    // own marker uses its target as the anchor" -- so for these two modes
    // specifically, --marker-target and --anchor must name the SAME issue.
    // Without this check, e.g. `--marker-target o/r#2 --anchor o/r#1`
    // passes both fields' own format checks and both coupling validators
    // above, yet posts a release-guard/release-complete record to issue 2
    // that issue 1 (the actual set anchor) never sees -- a permanently
    // invalid append-only marker.
    if (
      AUTHORING_OWNER_NONE_BODY_DIGEST_MODES.has(args.fields.mode) &&
      markerTargetRef &&
      anchorRef &&
      !isPostingDestination(
        anchorRef,
        markerTargetRef.owner,
        markerTargetRef.repo,
        markerTargetRef.number,
      )
    ) {
      const message = `--mode ${args.fields.mode} is valid only on the set anchor, so --anchor ${anchor} must name the same issue as --marker-target ${markerTarget}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
  }

  // #2931 (Codex/Copilot review on PR #2937): authoring-publication-intent's
  // --journal and non-'none' --issue carry the same <owner>/<repo>#<number>
  // shape as authoring-owner's --marker-target (contract.md), even though
  // this type's own --marker-target/--anchor stay opaque (see
  // REQUIRED_FIELDS_BY_TYPE's doc comment). `journalRef` is hoisted for
  // reuse by the destination-equality check below; `--issue` is format-
  // checked only -- contract.md gives it no destination-equality
  // requirement of its own (it names the issue this publication intent is
  // ABOUT, which need not be the journal issue this marker posts to).
  let journalRef: ParsedIssueReference | null = null;
  if (args.type === 'authoring-publication-intent') {
    const journal = args.fields.journal;
    if (journal) {
      journalRef = parseIssueReference(journal);
      if (!journalRef) {
        const message = `invalid --journal value (expected <owner>/<repo>#<number>): ${journal}`;
        process.stderr.write(`${message}\n`);
        return { exitCode: 1, kind: 'usage', message };
      }
    }
    const issue = args.fields.issue;
    if (issue && issue !== 'none' && !parseIssueReference(issue)) {
      const message = `invalid --issue value (expected <owner>/<repo>#<number> or none): ${issue}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
    // #2931 (Codex review on PR #2937): issue=none is only ever valid at
    // state=pending (contract.md; mirrored by audit-authored-issue.mts's
    // replay logic) -- a member/cleanup/abandoned record posted with
    // issue=none reports success here but is durable evidence replay will
    // always reject.
    const stateIssueError =
      validateAuthoringPublicationIntentStateIssueCoupling(args.fields);
    if (stateIssueError) {
      process.stderr.write(`${stateIssueError}\n`);
      return { exitCode: 1, kind: 'usage', message: stateIssueError };
    }
  }

  // #2931 (Codex/Copilot review on PR #2937, critical): resolve the actual
  // posting destination for both authoring types EARLY -- BEFORE dry-run
  // returns below -- so the destination-equality check right after this
  // block runs in dry-run too, WHEN the destination is knowable without a
  // network call. `authoringDestinationKnowable` is deliberately false for
  // a PLAIN dry-run (no --apply) with --owner/--repo both omitted: eagerly
  // resolving via `gh repo view` in that case would break this file's own
  // documented offline dry-run guarantee
  // (docs/harness-orchestrated-execution-investigation.md's "Live state
  // required?" table; Copilot review on PR #2937, round 7 -- a real
  // regression this eager resolution introduced, since every other
  // marker type's plain dry-run has always stayed network-free). The
  // destination-equality check for that specific case simply does not run
  // until --apply actually needs the destination -- exactly how every
  // OTHER marker type's dry-run already behaved before this issue. Stored
  // back into args.owner/args.repo so the later --apply resolution
  // further below (`args.owner && args.repo ? null :
  // resolveCurrentGithubRepository()`) sees them already populated and
  // skips a duplicate `gh repo view` call.
  const authoringDestinationKnowable =
    (AUTHORING_MARKER_TYPES as readonly string[]).includes(args.type) &&
    (args.apply || Boolean(args.owner && args.repo));
  if (authoringDestinationKnowable && !(args.owner && args.repo)) {
    try {
      const currentRepo = resolveCurrentGithubRepository();
      args.owner = args.owner || currentRepo?.owner || '';
      args.repo = args.repo || currentRepo?.repo || '';
    } catch (error) {
      const message = `failed to resolve the current repository for --type ${args.type} (pass --owner/--repo explicitly): ${(error as Error).message}`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, ...classifyHelperError(error), message };
    }
  }

  // #2931 (Codex/Copilot review on PR #2937, critical, independently
  // corroborated by both reviewers): --marker-target (authoring-owner) /
  // --journal (authoring-publication-intent) must name the SAME issue this
  // CLI is actually about to POST to. Root incident: without this check, a
  // caller could hash/reference one issue while the append-only comment
  // lands on a completely different one, permanently corrupting both
  // issues' authoring state -- exactly the class of defect #2931 exists to
  // close. `--target`'s issue/pr kind is deliberately NOT part of this
  // comparison (descriptive-only everywhere else in this file; both kinds
  // POST to the same /issues/<n>/comments endpoint). Gated on
  // `authoringDestinationKnowable` -- see that constant's own comment --
  // so a plain dry-run with no --owner/--repo defers this check to
  // --apply instead of forcing a `gh repo view` call it would otherwise
  // never need.
  if (
    authoringDestinationKnowable &&
    markerTargetRef &&
    !isPostingDestination(markerTargetRef, args.owner, args.repo, args.number)
  ) {
    const message = `--marker-target ${args.fields['marker-target']} does not match the posting destination ${args.owner}/${args.repo}#${args.number}`;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }
  if (
    authoringDestinationKnowable &&
    journalRef &&
    !isPostingDestination(journalRef, args.owner, args.repo, args.number)
  ) {
    const message = `--journal ${args.fields.journal} does not match the posting destination ${args.owner}/${args.repo}#${args.number}`;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }

  // #2931 (Codex review on PR #2937): contract.md requires "actor to equal
  // the API author" on every replay of an authoring-publication-intent
  // record, so a --actor that does not match the identity actually making
  // this POST produces a record replay will always reject even though this
  // command reports success. Checked only at --apply (dry-run has no real
  // POST author to compare against).
  //
  // Unlike the identical --actor/viewerLogin pattern already used by
  // local-validation-evidence.mts / external-check-waiver.mts /
  // provider-outage-declaration.mts -- all of which fail OPEN (skip the
  // comparison) when the authenticated login cannot be resolved -- this
  // one FAILS CLOSED instead (Codex + Copilot review on PR #2937, round
  // 4, independently corroborated): those other artifacts are correctable
  // or non-authoritative, while a publication-intent record is a
  // PERMANENT append-only comment whose replay will reject it forever if
  // --actor turns out wrong, and this helper cannot retract or edit it
  // after the fact. A transient `gh api user` failure (expired
  // credential, rate limit, installation-token quirk) must block the
  // POST, not silently let an unverified --actor through.
  if (args.type === 'authoring-publication-intent' && args.apply) {
    const { viewerLogin, viewerLoginUnavailable } = createGithubProviderAdapter(
      args.owner,
      args.repo,
    ).resolveViewerLoginSafe();
    const actor = args.fields.actor;
    if (actor && viewerLoginUnavailable) {
      const message =
        'cannot verify --actor: the authenticated GitHub login could not be resolved (gh api user failed or returned empty); refusing to post an unverified actor into a permanent append-only record -- fix gh auth and retry';
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'transport', message };
    }
    if (
      actor &&
      viewerLogin &&
      actor.toLowerCase() !== viewerLogin.toLowerCase()
    ) {
      const message = `--actor ${actor} does not match the authenticated user ${viewerLogin} actually making this POST`;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, kind: 'usage', message };
    }
  }

  // #2931: derive or verify authoring-owner's body-sha256 from a live,
  // JSON-parsed read of --marker-target's current body -- the exact fix
  // for kurone-kito/idd-skill#2925's root cause (a hand-computed
  // body-sha256 that silently included a shell-redirect-appended trailing
  // newline `gh api --jq` emits on stdout but that is not part of the
  // real body field). Runs BEFORE the REQUIRED_FIELDS_BY_TYPE loop below
  // so a missing --marker-target reports its own targeted error instead
  // of the renderer's generic "invalid ... marker payload", and before
  // any POST so a fetch failure or digest mismatch blocks the post
  // entirely (fail closed). --marker-target's FORMAT (and now its
  // destination equality) is already validated above regardless of
  // body-sha256, so this block only needs to handle "missing"
  // (`markerTargetRef` null falls through to requireFlag below) -- a
  // malformed or destination-mismatched value already exited above.
  //
  // Design choice (kurone-kito/idd-skill#2931's open question 2): an
  // explicitly supplied --body-sha256 is INDEPENDENTLY VERIFIED against
  // this fresh fetch rather than trusted as-is, mirroring this
  // repository's own discover-viability-gate / claim-approval-gate
  // precedent of verifying a caller-supplied value over trusting it -- a
  // stale or hand-miscomputed explicit value is exactly as dangerous as an
  // omitted one, and this marker type exists specifically to close that
  // class of bug. The literal sentinel `none` is exempt from both
  // derivation and verification: it is not a digest of anything
  // (docs/idd-autonomy-contract.md: BOTH anchor-only modes,
  // release-guard and release-complete, use body-sha256=none -- enforced
  // above by validateAuthoringOwnerModeDigestCoupling, which already
  // guarantees `none` here only ever occurs for one of those two modes),
  // so hashing a live body against it would always -- and incorrectly --
  // report a mismatch.
  if (
    args.type === 'authoring-owner' &&
    args.fields['body-sha256'] !== 'none'
  ) {
    try {
      if (!markerTargetRef) {
        throw markCliUsageError(
          new Error('--marker-target is required for --type authoring-owner'),
        );
      }
      const item = createGithubProviderAdapter(
        markerTargetRef.owner,
        markerTargetRef.repo,
      ).getWorkItem(markerTargetRef.number);
      if (!item) {
        throw new Error(
          `--marker-target ${args.fields['marker-target']} was not found`,
        );
      }
      const computedBodySha256 = createHash('sha256')
        .update(item.body, 'utf8')
        .digest('hex');
      const explicitBodySha256 = args.fields['body-sha256'];
      // #2931 (Copilot review on PR #2937): `explicitBodySha256 &&` treated
      // an explicitly supplied EMPTY --body-sha256 '' the same as omitted
      // (both falsy), silently overwriting it with the computed digest
      // instead of failing closed on the malformed input -- distinguish
      // omission from an empty value with `!== undefined`.
      if (
        explicitBodySha256 !== undefined &&
        explicitBodySha256 !== computedBodySha256
      ) {
        throw markCliUsageError(
          new Error(
            `refusing to post authoring-owner marker: --body-sha256 ${explicitBodySha256} does not match the freshly computed digest ${computedBodySha256} of --marker-target ${args.fields['marker-target']}'s live body`,
          ),
        );
      }
      args.fields['body-sha256'] = computedBodySha256;
    } catch (error) {
      const message = (error as Error).message;
      process.stderr.write(`${message}\n`);
      return { exitCode: 1, ...classifyHelperError(error), message };
    }
  }

  let body: string;
  try {
    // #1722: report a missing required field BY NAME before buildMarkerBody
    // (and the renderer it dispatches to) ever sees the payload -- runs
    // AFTER --from-pr derivation above, so a watermark's --head-sha /
    // --total-item-count are already populated by the time this checks
    // them in that mode. See REQUIRED_FIELDS_BY_TYPE's own doc comment for
    // which fields are deliberately excluded (renderer-defaulted or
    // half-bound-optional).
    for (const field of REQUIRED_FIELDS_BY_TYPE[args.type as MarkerType]) {
      requireFlag(args.fields[field], `--${field}`);
    }
    body = buildMarkerBody(args.type, args.fields);
  } catch (error) {
    const message = (error as Error).message;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, ...classifyHelperError(error), message };
  }

  // #2931 (Codex review on PR #2937, round 6): a terminal, structural
  // guard against the #2900/#2926/#2927 incident class -- ANY authoring
  // field value that breaks the marker's own `key=value; key=value; ...`
  // grammar (a literal `;`, for instance, in an opaque --set/--session/
  // --token/--marker-target/--anchor value) can still pass every
  // per-field check above (none of them scan for grammar-breaking
  // characters) yet produce a body that fails to round-trip through
  // matchCanonicalAuthoringMarkerFamily -- exactly the historical
  // non-canonical-body defect this issue exists to close, just reached
  // through a different field than #2925's body-sha256. Rather than
  // enumerate and re-validate every individual field against the marker
  // grammar (an incremental patch this file would need to repeat for
  // every current and future authoring field), assert the STRUCTURAL
  // invariant directly: the body this command is about to post must
  // parse back out, byte-exact, as the type it claims to be. Pure and
  // network-free itself, so it runs in dry-run too -- but it is NOT the
  // first network-touching thing this command may have already done
  // (Copilot review on PR #2937, round 7): authoring-owner's own
  // body-sha256 derive/verify fetch, and the destination-equality
  // resolution above (when knowable, see authoringDestinationKnowable),
  // both run earlier and are unaffected by a grammar-breaking field this
  // assertion alone would refuse. This guard's real guarantee is
  // narrower and still worth stating precisely: a body that fails this
  // check is refused before the POST and before the dry-run envelope
  // ever prints it, not that no earlier step in this command could have
  // already made a network call.
  if (
    (args.type === 'authoring-owner' ||
      args.type === 'authoring-publication-intent') &&
    matchCanonicalAuthoringMarkerFamily(body, args.fields['marker-prefix']) !==
      args.type
  ) {
    const message = `refusing to post: the rendered ${args.type} body does not round-trip through matchCanonicalAuthoringMarkerFamily as canonical -- one or more field values (for example a literal ';', a newline, or an HTML comment terminator) would break the marker's own field-delimiter grammar, leaving a posted record that replay and the hide-on-supersede sweep could never recognize`;
    process.stderr.write(`${message}\n`);
    return { exitCode: 1, kind: 'usage', message };
  }

  const number = args.number;
  // #3910, #3899, #4669: owner-state checks run before the dry-run return too,
  // so dry-run and --apply refuse on the same target/anchor history.
  if (args.type === 'authoring-owner') {
    const identityRefusal = checkAuthoringOwnerPostIdentity({
      body,
      markerPrefix: args.fields['marker-prefix'],
      markerTarget: markerTargetRef,
      trustedMarkerLoginsFlag: args.trustedMarkerLogins,
    });
    if (identityRefusal !== null) {
      return identityRefusal;
    }
  }
  if (!args.apply) {
    const result: PostIddMarkerResult = {
      mode: 'dry-run',
      type: args.type as MarkerType,
      target: args.target as TargetKind,
      number,
      body,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(operationLocalEnvelope
        ? { operationLocal: operationLocalEnvelope }
        : {}),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const applyCurrentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || applyCurrentRepo?.owner || '';
  const repo = args.repo || applyCurrentRepo?.repo || '';

  const posted = postMarker(owner, repo, number, body);
  if (args.type === 'claim' || args.type === 'unclaim') {
    // A claim or unclaim changes what a cached Discover hint may list, so
    // drop the hints (best effort; #3588). Other marker types leave claim
    // state alone and must not flush the shared cache.
    // The pair the marker actually posted to, and the explicit arguments
    // (or `origin`) that Discover keys its hints on.
    invalidateDiscoverHints([
      { owner, repo },
      { owner: args.owner, repo: args.repo },
    ]);
  }
  if (isHideAtPostTimeMarkerType(args.type)) {
    hideSupersededPostTimeMarkers(
      args.type,
      args.fields,
      owner,
      repo,
      number,
      posted.id,
      args.trustedMarkerLogins,
      HIDE_STEP_DEADLINE_MS,
    );
  }
  const result: PostIddMarkerResult = {
    mode: 'apply',
    type: args.type as MarkerType,
    target: args.target as TargetKind,
    number,
    commentId: posted.id,
    url: posted.html_url,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(operationLocalEnvelope
      ? { operationLocal: operationLocalEnvelope }
      : {}),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
