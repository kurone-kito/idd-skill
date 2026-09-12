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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { requireFlag, stripLeadingArgumentSeparator } from './cli-args.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  isTrustedAuthor,
  resolveTrustedActors,
  runMinimize,
} from './minimize-superseded-markers.mjs';
import {
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
  renderReviewAckMarker,
  renderReviewBaselineMarker,
  renderReviewWatermarkMarker,
  renderUnclaimedByMarker,
} from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';
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
];
export function isHideAtPostTimeMarkerType(type) {
  return HIDE_AT_POST_TIME_MARKER_TYPES.includes(type);
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
  'authoring-owner',
  'authoring-publication-intent',
];
/**
 * The marker `type`s that accept `--from-pr <n>`. `watermark` derives all
 * four snapshot fields via the full {@link runReviewActivitySnapshot}
 * composition; the advisory-family types (`advisory` / `advisory-recovery` /
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
];
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
 * `body-sha256`), sorted by ascending issue number and joined by a single
 * `\n` with no trailing newline -- but that algorithm's inputs are every
 * OTHER target's already-verified digest from the authoring session's own
 * durable hold, cross-target state a single `--marker-target` CLI
 * invocation has no way to enumerate (unlike `body-sha256`, which is
 * always exactly the one named target's own live body, fully resolvable
 * from that one target alone). Guessing a source for it here would risk
 * manufacturing a wrong digest under a confidence-inspiring "computed
 * automatically" banner, the opposite of this issue's goal.
 */
const REQUIRED_FIELDS_BY_TYPE = {
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
];
export const TARGET_KINDS = ['issue', 'pr'];
/**
 * Build the canonical ready-to-post body for one operational marker type.
 * Pure and network-free: it dispatches to the single-sourced protocol-helpers
 * renderer for `type`, so the body stays byte-identical to what emit-marker and
 * the written marker formats produce. Throws on an unknown type or an invalid
 * field set (the renderer's own validation).
 */
export function buildMarkerBody(type, fields) {
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
export function watermarkFieldsFromSnapshot(snapshot) {
  const snap = snapshot ?? {};
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
  const isoOrNone = (value) =>
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
 * Returns `[]` when the snapshot carries no such evidence, including when
 * `dispositionEvidence` is absent or malformed (diagnostic-only: fails open,
 * never blocks or alters what gets POSTed).
 */
export function describeUnaddressedActivity(snapshot) {
  const snap = snapshot ?? {};
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
  if (commentCount === 0 && threadCount === 0) {
    return [];
  }
  const parts = [];
  if (commentCount > 0) {
    parts.push(`${commentCount} comment${commentCount === 1 ? '' : 's'}`);
  }
  if (threadCount > 0) {
    parts.push(`${threadCount} thread${threadCount === 1 ? '' : 's'}`);
  }
  const itemTotal = commentCount + threadCount;
  const verb = itemTotal === 1 ? 'has' : 'have';
  const pronoun = itemTotal === 1 ? 'it' : 'them';
  return [
    `${parts.join(' and ')} ${verb} no disposition evidence as of this ` +
      `watermark, but its max-activity-at/total-item-count already cover ` +
      `${pronoun} -- dispose ${pronoun} (or re-run --from-pr after doing ` +
      'so) before relying on this watermark.',
  ];
}
/**
 * Parse a whole-token positive integer, failing closed on a suffixed typo
 * (`1047abc`), a non-numeric token, or a non-positive / unsafe magnitude — a
 * mis-parsed target number could POST a marker to the wrong issue/PR.
 */
function parsePositiveIntToken(token, label) {
  const parsed = Number.parseInt(token, 10);
  if (!/^\d+$/.test(token) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}: ${token}`);
  }
  return parsed;
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
 * api` error. Deliberately independent of this CLI's own `--owner` /
 * `--repo` / `<number>` posting-destination flags: `authoring-owner`'s
 * `--marker-target` names which issue's live body the marker's
 * `body-sha256` digest describes, which in every observed usage is the
 * same issue this marker is posted to, but this parser (and the fetch it
 * feeds) does not assume or enforce that equality.
 */
export function parseIssueReference(ref) {
  const match = ref.trim().match(/^([^\s/#]+)\/([^\s/#]+)#([1-9]\d*)$/);
  if (!match) {
    return null;
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
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
export function validateAuthoringOwnerModeDigestCoupling(fields) {
  const mode = fields.mode;
  const bodySha256 = fields['body-sha256'];
  const snapshotSha256 = fields['snapshot-sha256'];
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
// Excluded from the #1446 cli-args.mts wrapper: `fields` below collects
// per-marker-type keys dynamically (each `--type` accepts a different
// field set) rather than a fixed declared spec. `util.parseArgs`'s
// `strict: true` rejects any option not named in its static spec, and
// `strict: false` would instead coerce every unrecognized flag to `true`
// -- neither matches this file's "accept whatever fields this marker type
// needs" contract.
export function parseArgs(rawArgv) {
  // #1921/#2465: strip a pnpm-forwarded leading `--` the same way the
  // shared cli-args.mts wrapper does -- this parser is excluded from that
  // wrapper (see the comment above) so it must call the strip directly.
  const argv = stripLeadingArgumentSeparator(rawArgv);
  const args = {
    type: '',
    target: '',
    number: null,
    fromPr: null,
    expectedHeadSha: '',
    apply: false,
    owner: '',
    repo: '',
    trustedMarkerLogins: '',
    advisoryBotLogins: '',
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
    } else if (token === '--owner') {
      args.owner = value;
    } else if (token === '--repo') {
      args.repo = value;
    } else if (token === '--trusted-marker-logins') {
      args.trustedMarkerLogins = value;
    } else if (token === '--advisory-bot-logins') {
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

  --type <type>        one of: ${MARKER_TYPES.join(', ')}
  --target <issue|pr>  the comment target kind (both use the issues comments API)
  <number>             issue or PR number (positional; required unless --from-pr)
  --from-pr <n>        watermark: derive --head-sha / --max-activity-at /
                       --total-item-count / --ci-completed-at from the live
                       review-activity-snapshot of PR <n>. The advisory-family
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
would actually post. --marker-target / --marker-owner map to these
markers' own \`target=\` / \`owner=\` fields -- named with a \`marker-\`
prefix, not bare --target / --owner, because this CLI already reserves
those two names for the posting-destination kind and the repo owner used
to resolve which repo to call. The two types give --marker-target /
--anchor DIFFERENT shapes (contract.md): authoring-owner's are
\`<owner>/<repo>#<number>\` issue references (in every observed usage, the
same issue this marker is posted to -- independent of the posting
--owner/--repo/<number> flags, though never enforced equal to them), while
authoring-publication-intent's are OPAQUE per-set ids with no issue
reference at all (only that type's separate --journal/--issue use the
\`<owner>/<repo>#<number>\` shape) -- pass either verbatim as opaque
strings; this CLI never parses or fetches against
authoring-publication-intent's --marker-target/--anchor.
--body-sha256 is OPTIONAL (authoring-owner only): when omitted,
this CLI fetches --marker-target's current live body via the same
JSON-parsed \`gh api\` path every other read in this file already uses (never
a shell-captured \`--jq\` scalar -- the exact root cause of
kurone-kito/idd-skill#2925's bad digest) and hashes it; when supplied
explicitly (other than the literal sentinel \`none\`, used for BOTH
anchor-only modes -- release-guard AND release-complete), it is
independently VERIFIED against that same fresh fetch and the post is
refused on a mismatch, never trusted as-is. This CLI also rejects a
--mode/--body-sha256/--snapshot-sha256 combination contract.md's mode
table forbids (docs/idd-autonomy-contract.md's "Portable authoring-owner
protocol" section) BEFORE any fetch: the five "target" modes (acquire,
resume, bootstrap, heartbeat, release) always need a real body-sha256
(never the none sentinel); the two anchor-only modes (release-guard,
release-complete) always need body-sha256 none (never omitted or a real
digest); and only release-complete carries a real snapshot-sha256 (every
other mode needs snapshot-sha256 none) -- owner comments are append-only,
so a marker posted with the wrong sentinel for its own mode is a
permanent, uncorrectable defect once it lands.
--snapshot-sha256 has no auto-derivation and stays required and explicit:
docs/idd-autonomy-contract.md DOES define a precise algorithm for it (a
SHA-256 digest over the whole authoring set's sorted
<owner>/<repo>#<number>:<body-sha256> lines), but that algorithm's inputs
are every OTHER target's already-verified digest from the authoring
session's own durable hold -- cross-target state this single
--marker-target invocation has no way to enumerate, unlike body-sha256,
which is always exactly the one named target's own live body.
--marker-prefix defaults to .github/idd/config.json's \`markerPrefix\`, or
'idd-skill' when that is also absent. These two types are deliberately NOT
OPERATIONAL_MARKERS (marker-helpers.mts) and are never subject to this
file's own --apply hide-at-post-time step or the F4 post-merge cleanup
driver -- see MARKER_TYPES's own doc comment.

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
the snapshot child (--type watermark only) so its counts match the manual
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
function postMarker(owner, repo, number, body) {
  const posted = createGithubProviderAdapter(owner, repo).postWorkItemComment(
    number,
    body,
  );
  return { id: posted.id, html_url: posted.htmlUrl };
}
/**
 * Fetch PR `<n>`'s current head commit SHA via a single lightweight `gh pr
 * view` call -- the `--from-pr` derivation path for the advisory-family
 * marker types (#1889: `advisory` / `advisory-recovery` / `advisory-reroll`;
 * #2050: `review-ack`), which need only `--head-sha`, unlike `watermark`'s
 * `--from-pr`, which composes the full four-field snapshot via
 * {@link runReviewActivitySnapshot}. This is deliberately network-lighter
 * than that snapshot: no CI checks, review threads, or comment pagination,
 * just the one `headRefOid` field.
 *
 * Throws (fail-closed) when `headRefOid` comes back empty or missing, so a
 * malformed `gh pr view` response can never post a marker with a blank
 * `head-sha` -- mirrors {@link watermarkFieldsFromSnapshot}'s guard on the
 * watermark path.
 */
function headShaFromPr(prNumber, owner, repo) {
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
/**
 * Run the sibling read-only `review-activity-snapshot.mjs` for a PR and return
 * its parsed JSON. This is the `--from-pr` half of the "compose the two existing
 * helpers" path; the snapshot stays the single source of the activity/CI metrics
 * and this write-side helper only renders+posts the watermark over them.
 *
 * The sibling is resolved relative to this module (both generated artifacts live
 * in `scripts/`), so it works from any cwd. `--owner` / `--repo` are forwarded
 * to avoid an extra `gh repo view` in the child, and the optional marker-actor
 * lists are forwarded so the child's `totalItemCount` / `maxActivityUpdatedAt`
 * filtering matches the manual `review-activity-snapshot` invocation.
 */
function runReviewActivitySnapshot(
  prNumber,
  owner,
  repo,
  trustedMarkerLogins,
  advisoryBotLogins,
) {
  const script = resolve(import.meta.dirname, 'review-activity-snapshot.mjs');
  const snapshotArgs = [
    script,
    '--pr',
    String(prNumber),
    '--owner',
    owner,
    '--repo',
    repo,
  ];
  if (trustedMarkerLogins) {
    snapshotArgs.push('--trusted-marker-logins', trustedMarkerLogins);
  }
  if (advisoryBotLogins) {
    snapshotArgs.push('--advisory-bot-logins', advisoryBotLogins);
  }
  const out = execFileSync(process.execPath, snapshotArgs, {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}
/**
 * List every comment on `number` (issue or PR -- same comments endpoint),
 * shaped for the hide-at-post-time candidate scan. Routed through
 * {@link createGithubProviderAdapter} (`listWorkItemComments`), like every
 * other read in this migrated file (#2266) -- `post-idd-marker.mts` must
 * never construct a `gh` call of its own
 * (`tests/provider-port-migration-guard.test.mts`). A comment missing a
 * `nodeId` (defensive: the real adapter always populates it from REST's
 * `node_id`) normalizes to `''`, which the finder functions below already
 * skip.
 */
function listMarkerCandidateComments(owner, repo, number, timeoutMs) {
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
export function findSupersededReviewAckSubjects(comments, newHeadSha) {
  const target = newHeadSha.trim().toLowerCase();
  const subjects = [];
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
  comments,
  newClaimId,
  newAttempt,
) {
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
  const subjects = [];
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
  type,
  fields,
  owner,
  repo,
  number,
  postedCommentId,
  trustedMarkerLoginsFlag,
  deadlineMs,
) {
  // Clock starts here, before ANY network call this step makes (#2754,
  // chatgpt-codex-connector review round 3 on PR #2788) -- round 2's
  // deadlineMs only bounded runMinimize's OWN pass, timed from ITS entry,
  // which left every read before that call (the review-ack live-HEAD
  // re-check, and the comments listing every type makes) outside the
  // budget entirely. The comments listing in particular defaults to
  // `DEFAULT_GH_PAGINATED_TIMEOUT_MS` (120s, gh-exec.mts) when not told
  // otherwise -- alone larger than this whole step's intended budget.
  const startedAt = Date.now();
  const remaining = () => deadlineMs - (Date.now() - startedAt);
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
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
    throw error;
  }
  // #1833: populated only by the `--from-pr` snapshot-derivation branch
  // below; carried into both the dry-run and `--apply` result envelopes.
  let warnings = [];
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!MARKER_TYPES.includes(args.type)) {
    process.stderr.write(
      `--type is required and must be one of: ${MARKER_TYPES.join(', ')}\n`,
    );
    process.exit(1);
  }
  // --expected-head-sha only guards the --from-pr --type watermark
  // derivation below; in manual mode the caller already supplies --head-sha
  // directly, so there is nothing to compare it against. It has no meaning
  // for the advisory-family --from-pr types (#1889 / #2050): they have no
  // E1 Step 1/Step 2 pinning concept, so reject the combination the same way
  // rather than silently ignoring it.
  if (args.expectedHeadSha && args.fromPr === null) {
    process.stderr.write(
      '--expected-head-sha is only valid together with --from-pr\n',
    );
    process.exit(1);
  }
  if (
    args.expectedHeadSha &&
    args.fromPr !== null &&
    args.type !== 'watermark'
  ) {
    process.stderr.write(
      '--expected-head-sha is only valid together with --from-pr --type watermark\n',
    );
    process.exit(1);
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
    if (!FROM_PR_MARKER_TYPES.includes(args.type)) {
      process.stderr.write(
        `--from-pr is only valid for --type ${FROM_PR_MARKER_TYPES.join(', ')}\n`,
      );
      process.exit(1);
    }
    const isWatermark = args.type === 'watermark';
    // --from-pr always posts the marker to PR <n>. `--target` is
    // descriptive-only (issue/pr both POST to the same /issues/<n>/comments
    // endpoint), but an `issue`-targeted PR-derived marker is incoherent, so
    // fail closed on an explicit non-pr target rather than recording it.
    if (args.target && args.target !== 'pr') {
      process.stderr.write(
        `--from-pr always targets the PR; remove --target ${args.target}\n`,
      );
      process.exit(1);
    }
    args.target = 'pr';
    if (args.number === null) {
      args.number = args.fromPr;
    } else if (args.number !== args.fromPr) {
      process.stderr.write(
        'in --from-pr mode the positional number must be omitted or equal --from-pr\n',
      );
      process.exit(1);
    }
    const derivedFlags = isWatermark
      ? ['head-sha', 'max-activity-at', 'total-item-count', 'ci-completed-at']
      : ['head-sha'];
    const conflicting = derivedFlags.filter((flag) => flag in args.fields);
    if (conflicting.length > 0) {
      process.stderr.write(
        `--from-pr derives ${derivedFlags.join(' / ')} from the live ${isWatermark ? 'snapshot' : 'PR'}; do not also pass: ${conflicting
          .map((flag) => `--${flag}`)
          .join(', ')}\n`,
      );
      process.exit(1);
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
        const snapshot = runReviewActivitySnapshot(
          args.fromPr,
          args.owner,
          args.repo,
          args.trustedMarkerLogins,
          args.advisoryBotLogins,
        );
        Object.assign(args.fields, watermarkFieldsFromSnapshot(snapshot));
        warnings = describeUnaddressedActivity(snapshot);
      } else {
        args.fields['head-sha'] = headShaFromPr(
          args.fromPr,
          args.owner,
          args.repo,
        );
      }
    } catch (error) {
      process.stderr.write(
        `failed to derive ${isWatermark ? 'watermark fields' : 'head-sha'} from PR ${args.fromPr}: ${error.message}\n`,
      );
      process.exit(1);
    }
    // Fail closed (this repository's fail-closed default) when the branch
    // moved between E1 Step 1 (which stored {head-SHA} and must not re-read
    // HEAD through Step 3) and this Step 2 call: posting a watermark keyed to
    // a HEAD newer than the one E1 Step 1 actually snapshotted would silently
    // violate that single-stored-value invariant. Refuse to post; the caller
    // reruns E1 from Step 1 against the moved branch instead. Watermark-only:
    // --expected-head-sha is rejected above for the advisory --from-pr types,
    // so this never fires for them.
    const liveHeadSha = args.fields['head-sha'];
    if (
      isWatermark &&
      args.expectedHeadSha &&
      liveHeadSha.toLowerCase() !== args.expectedHeadSha.toLowerCase()
    ) {
      process.stderr.write(
        `refusing to post watermark: PR ${args.fromPr}'s live HEAD (${liveHeadSha}) no longer matches the Step 1 stored --expected-head-sha (${args.expectedHeadSha}); the branch moved between E1 Step 1 and Step 2. Re-run E1 from Step 1 against the new HEAD.\n`,
      );
      process.exit(1);
    }
  }
  if (!TARGET_KINDS.includes(args.target)) {
    process.stderr.write(
      `--target is required and must be one of: ${TARGET_KINDS.join(', ')}\n`,
    );
    process.exit(1);
  }
  if (args.number === null) {
    process.stderr.write('a positional issue/PR <number> is required\n');
    process.exit(1);
  }
  // #2931: --marker-prefix defaults the same way
  // authoring-owner-provenance.mts's own normalizeMarkerPrefix does -- an
  // explicit --marker-prefix wins, otherwise .github/idd/config.json's
  // markerPrefix, otherwise the distributed 'idd-skill' default. Both
  // authoring types share this resolution; only authoring-owner also
  // derives/verifies body-sha256 below.
  if (
    AUTHORING_MARKER_TYPES.includes(args.type) &&
    !args.fields['marker-prefix']
  ) {
    const configured = loadIddConfig()?.markerPrefix;
    args.fields['marker-prefix'] =
      typeof configured === 'string' && configured.trim()
        ? configured.trim()
        : DEFAULT_AUTHORING_MARKER_PREFIX;
  }
  // #2931: authoring-owner's --marker-target is a genuine issue reference
  // (unlike authoring-publication-intent's opaque target=, see
  // REQUIRED_FIELDS_BY_TYPE's doc comment), so its <owner>/<repo>#<number>
  // shape is validated unconditionally here -- BEFORE the
  // REQUIRED_FIELDS_BY_TYPE loop below, so a missing/malformed value
  // reports its own targeted error instead of the renderer's generic
  // "invalid ... marker payload" -- regardless of whether a live fetch
  // ends up happening. Splitting this from the fetch/verify block below
  // keeps validation behavior for --marker-target consistent (always
  // format-checked) rather than depending on --body-sha256's value (a
  // malformed --marker-target with --body-sha256 none previously slipped
  // through unvalidated, since the sentinel skipped the whole block that
  // used to contain this check too).
  if (args.type === 'authoring-owner') {
    const markerTarget = args.fields['marker-target'];
    if (markerTarget && !parseIssueReference(markerTarget)) {
      process.stderr.write(
        `invalid --marker-target value (expected <owner>/<repo>#<number>): ${markerTarget}\n`,
      );
      process.exit(1);
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
      process.exit(1);
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
  // entirely (fail closed). --marker-target's FORMAT is already validated
  // above regardless of body-sha256, so `parseIssueReference` here only
  // needs to handle "missing" (falls through to requireFlag below) --
  // a malformed value already exited above.
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
      const markerTarget = args.fields['marker-target'];
      if (!markerTarget) {
        throw new Error(
          '--marker-target is required for --type authoring-owner',
        );
      }
      // Format already validated above; a malformed value would have
      // exited before this line is ever reached.
      const ref = parseIssueReference(markerTarget);
      const item = createGithubProviderAdapter(ref.owner, ref.repo).getWorkItem(
        ref.number,
      );
      if (!item) {
        throw new Error(`--marker-target ${markerTarget} was not found`);
      }
      const computedBodySha256 = createHash('sha256')
        .update(item.body, 'utf8')
        .digest('hex');
      const explicitBodySha256 = args.fields['body-sha256'];
      if (explicitBodySha256 && explicitBodySha256 !== computedBodySha256) {
        throw new Error(
          `refusing to post authoring-owner marker: --body-sha256 ${explicitBodySha256} does not match the freshly computed digest ${computedBodySha256} of --marker-target ${markerTarget}'s live body`,
        );
      }
      args.fields['body-sha256'] = computedBodySha256;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  }
  let body;
  try {
    // #1722: report a missing required field BY NAME before buildMarkerBody
    // (and the renderer it dispatches to) ever sees the payload -- runs
    // AFTER --from-pr derivation above, so a watermark's --head-sha /
    // --total-item-count are already populated by the time this checks
    // them in that mode. See REQUIRED_FIELDS_BY_TYPE's own doc comment for
    // which fields are deliberately excluded (renderer-defaulted or
    // half-bound-optional).
    for (const field of REQUIRED_FIELDS_BY_TYPE[args.type]) {
      requireFlag(args.fields[field], `--${field}`);
    }
    body = buildMarkerBody(args.type, args.fields);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
    throw error;
  }
  const number = args.number;
  if (!args.apply) {
    const result = {
      mode: 'dry-run',
      type: args.type,
      target: args.target,
      number,
      body,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  }
  const applyCurrentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || applyCurrentRepo?.owner || '';
  const repo = args.repo || applyCurrentRepo?.repo || '';
  const posted = postMarker(owner, repo, number, body);
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
  const result = {
    mode: 'apply',
    type: args.type,
    target: args.target,
    number,
    commentId: posted.id,
    url: posted.html_url,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}
