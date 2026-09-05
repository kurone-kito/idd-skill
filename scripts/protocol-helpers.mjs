// idd-generated-from: src/scripts/protocol-helpers.mts
//
// The scripts/protocol-helpers.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { Buffer } from 'node:buffer';
import {
  buildAdvisoryConvergenceWaiverPrecondition,
  buildSecondaryQuietWindowStatus,
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  normalizeAdvisoryWaitRuntimeOptions,
} from './advisory-wait-policy.mjs';

// Re-exported so callers that already import advisory-bot-identity helpers
// from this façade (merged-pr-feedback-sweep.mts,
// disposition-non-review-notices.mts) can get the shared default-logins list
// from the same module instead of reaching into advisory-wait-policy.mts
// directly.
export { DEFAULT_ADVISORY_BOT_LOGINS } from './advisory-wait-policy.mjs';
// Façade re-export (wave 1 of the protocol-helpers split; see #1209): every
// marker render/parse primitive now lives in the marker-helpers module.
// Re-exporting it here keeps every existing call site importing from
// protocol-helpers unchanged. The named imports below are this module's own
// internal uses of those moved names; see marker-helpers for the layering
// rule (it must never import back from this file).
export * from './marker-helpers.mjs';

import { loadIddConfig } from './idd-config.mjs';
import {
  detectMalformedOperationalMarker,
  findActivationNonceWinner,
  IDD_AGENT_DERIVED_MARKERS,
  isIddOriginatedReply,
  isValidIsoTimestamp,
  operationalMarkerPrefix,
  operationalMarkerPrefixByStart,
  parseClaimComment,
  parseExternalCheckWaiverComment,
  parseForcedHandoffComment,
  parseReleaseComment,
  parseReviewWatermarkComment,
} from './marker-helpers.mjs';
import {
  getReviewEscalationChangesRequestedPolicy,
  parseIsoDurationToMs,
} from './policy-helpers.mjs';
export const LIVE_STATUS_DIGEST_MARKER = '<!-- idd-live-status: current -->';
const REVIEW_BOT_LOGINS = new Set([
  'coderabbitai',
  'coderabbitai[bot]',
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
]);
const UNSAFE_TEXT_RULES = [
  {
    pattern: /\*\*Awaiting maintainer decision\*\*/i,
    reason: 'contains an awaiting-maintainer-decision marker',
  },
  {
    pattern: /\bactive hold\b/i,
    reason: 'contains active hold context',
  },
  {
    pattern:
      /\bfailed[- ]ci\b|\bfailing ci\b|\bci failure\b|\bci failed\b|\bfailed checks?\b/i,
    reason: 'contains failed-CI context',
  },
];
const AMD_MARKER_PATTERN = /^\*\*Awaiting maintainer decision\*\*/i;
export function parsePaginatedGhNdjson(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const value = JSON.parse(line);
      return Array.isArray(value) ? value : [value];
    });
}
/** Check-run states treated as pass-equivalent for the CI required-check
 * gate: a check in one of these states is never eligible for waiver
 * coverage (already passing, or intentionally not run) and never counts as
 * a genuinely non-passing cause. Hoisted to module scope (#2021) so both
 * {@link summarizeRequiredChecks} and {@link computePreMergeReadinessBlockers}
 * share one definition instead of two independently-maintained copies. */
const CHECK_PASS_EQUIVALENT_STATES = new Set([
  'SUCCESS',
  'SKIPPED',
  'NEUTRAL',
  'NOT_APPLICABLE',
]);
function matchCheckSelectorLocal(name, selector, matchMode) {
  const n = String(name ?? '').trim();
  const s = String(selector ?? '').trim();
  if (!n || !s) return false;
  // An explicit matchMode wins; otherwise infer glob from a `*` in the
  // selector (the legacy behavior every existing two-argument caller relies
  // on, e.g. waiver-selector vs check-name coverage matching).
  const useGlob =
    matchMode === undefined ? s.includes('*') : matchMode === 'glob';
  if (useGlob) {
    const source = s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${source}$`).test(n);
  }
  return n === s;
}
/**
 * True when a concrete check `name` matches any configured waivable selector,
 * honoring each selector's own `matchMode`. Used to gate whether a present
 * check sits on the policy's waivable surface.
 */
function isCheckNameConfiguredWaivable(name, waivableSelectors) {
  return waivableSelectors.some((sel) =>
    matchCheckSelectorLocal(
      name,
      sel?.selector,
      sel?.matchMode === 'glob' ? 'glob' : 'exact',
    ),
  );
}
/**
 * True when a waiver's `checkSelector` can name a check that the policy
 * declared waivable. Unlike a concrete check name, a waiver selector may
 * itself be a glob, so this tests both directions: the waiver selector
 * against each configured pattern, and each configured selector against the
 * waiver pattern (glob inferred from `*`). Either direction means the two
 * selectors can resolve to a common check — e.g. a glob waiver `Code*`
 * overlaps an exact waivable `CodeRabbit`. This mirrors the creation-path
 * gate in `planExternalCheckWaiver`, which validates glob waivers against the
 * actual matched checks, so a legitimately created waiver is not wrongly
 * bucketed as `notConfigured` at consumption.
 */
function waiverSelectorOverlapsConfiguredWaivable(
  waiverSelector,
  waivableSelectors,
) {
  return waivableSelectors.some(
    (sel) =>
      matchCheckSelectorLocal(
        waiverSelector,
        sel?.selector,
        sel?.matchMode === 'glob' ? 'glob' : 'exact',
      ) || matchCheckSelectorLocal(sel?.selector, waiverSelector),
  );
}
export function summarizeExternalCheckWaivers(
  comments,
  {
    prHeadSha = '',
    activeClaimId = '',
    activeClaimSupersedes = '',
    trustedMarkerLogins = [],
    now = '',
    waivableSelectors = null,
    maxValidity = '',
    mode = '',
  } = {},
) {
  const trustedSet = new Set(normalizeTrustedMarkerLogins(trustedMarkerLogins));
  const nowMs = isValidIsoTimestamp(now) ? new Date(now).getTime() : Date.now();
  const headShaLower = String(prHeadSha).toLowerCase();
  const activeClaimLower = String(activeClaimId);
  const maxValidityMs = parseIsoDurationToMs(maxValidity);
  const valid = [];
  const expired = [];
  const wrongHead = [];
  const wrongClaim = [];
  const unauthorized = [];
  const malformed = [];
  const notConfigured = [];
  const modeDisabled = [];
  // An empty `mode` leaves this gate off (legacy/unit-caller default); a
  // non-empty value must equal `maintainer-authorized` exactly, mirroring
  // `advisory-convergence.mts`'s own guard.
  const modeGateOpen = mode === '' || mode === 'maintainer-authorized';
  for (const comment of comments ?? []) {
    const body = String(comment?.body ?? '');
    // Prefilter on a marker-start, case-insensitive match aligned with
    // parseExternalCheckWaiverComment's anchor — a case-sensitive substring
    // skipped odd-cased markers and misclassified prose mentions as malformed.
    if (!/^<!--\s*idd-external-check-waiver:/i.test(body)) continue;
    const authorLogin = String(
      comment?.author?.login ?? comment?.user?.login ?? '',
    )
      .trim()
      .toLowerCase();
    const createdAt = String(comment?.created_at ?? comment?.createdAt ?? '');
    const parsed = parseExternalCheckWaiverComment(body, createdAt);
    if (!parsed) {
      malformed.push({ authorLogin, bodyPreview: body.slice(0, 120) });
      continue;
    }
    if (!trustedSet.has(authorLogin)) {
      unauthorized.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }
    // Fail closed on an empty head SHA: an unbound waiver must never ride
    // along when the gate cannot prove it targets the current PR HEAD.
    if (!headShaLower || parsed.headSha !== headShaLower) {
      wrongHead.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        waiverHeadSha: parsed.headSha,
      });
      continue;
    }
    // Fail closed on an empty active claim: when no claim resolves at the gate
    // (`activeClaimLower === ''`), a waiver cannot be bound to an owner and is
    // rejected rather than passing unbound. #1905's one narrow exception: the
    // case-insensitive literal sentinel `none` in the marker's claimId field
    // explicitly declares "this is a claimless waiver" -- it satisfies the
    // claim-binding check ONLY when the gate independently confirms no claim
    // resolves (`!activeClaimLower`). A non-empty `activeClaimLower` always
    // requires an exact `claimId` match; `none` is never accepted there, so
    // the sentinel can never route around a genuine claim mismatch. Every
    // other combination is unchanged: a non-`none` claimId on an unclaimed PR
    // still falls into `wrongClaim` -- the exact regression #1077 fixed.
    //
    // #2080: one-hop takeover exception. A waiver bound to claim A remains
    // valid after an in-policy takeover installs claim B whose
    // `supersedes` field is A -- the waiver authorizes the PR, not the
    // current session. The predecessor value is accepted only when it is
    // non-empty and is NOT a case-insensitive `none` sentinel: a freshly
    // claimed PR carries `supersedes: 'none'`, and treating that as a
    // bindable predecessor would make every claimless waiver validate on
    // every fresh claim (reopening #1077/#1905). A two-hop-old claim id
    // (neither B nor B.supersedes) stays rejected; walking a full lineage
    // is out of scope.
    const claimIdIsNoneSentinel = parsed.claimId.toLowerCase() === 'none';
    const predecessorClaimId = String(activeClaimSupersedes ?? '').trim();
    const predecessorIsBindable =
      predecessorClaimId !== '' && predecessorClaimId.toLowerCase() !== 'none';
    const claimBindingSatisfied = activeClaimLower
      ? parsed.claimId === activeClaimLower ||
        (predecessorIsBindable && parsed.claimId === predecessorClaimId)
      : claimIdIsNoneSentinel;
    if (!claimBindingSatisfied) {
      wrongClaim.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        waiverClaimId: parsed.claimId,
      });
      continue;
    }
    const expiresMs = new Date(parsed.expiresAt).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      expired.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }
    // Re-enforce the configured maxValidity window at consume time. Authoring
    // already clamps `expiresAt - createdAt` (planExternalCheckWaiver's
    // withinMaxValidity), but a hand-edited or policy-drifted marker can still
    // carry an over-long window, so the shared merge gate re-checks it and
    // fails closed when the creation timestamp is unknown (`createdAt: 'none'`).
    if (typeof maxValidityMs === 'number' && Number.isFinite(maxValidityMs)) {
      const createdMs = new Date(parsed.createdAt).getTime();
      if (
        !Number.isFinite(createdMs) ||
        expiresMs - createdMs > maxValidityMs
      ) {
        expired.push({
          authorLogin,
          checkSelector: parsed.checkSelector,
          expiresAt: parsed.expiresAt,
        });
        continue;
      }
    }
    // When the policy declares its waivable surface, a valid waiver still only
    // counts when its selector can name a configured-waivable check; otherwise
    // it is reported but never folds a check in. The overlap test treats the
    // waiver selector as a possible glob so a `Code*` waiver still matches an
    // exact `CodeRabbit` surface. A null/undefined list disables the gate
    // (legacy callers), an empty list waives nothing.
    if (
      Array.isArray(waivableSelectors) &&
      !waiverSelectorOverlapsConfiguredWaivable(
        parsed.checkSelector,
        waivableSelectors,
      )
    ) {
      notConfigured.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }
    // #2046: `mode` gates the whole waiver mechanism, independent of the
    // `waivable` selector list -- an otherwise-valid, correctly-configured
    // waiver must never count while the policy's
    // `ciGate.externalCheckWaivers.mode` is not `maintainer-authorized`
    // (schema default: `disabled`), matching `advisory-convergence.mts`'s
    // own required check, which never even evaluates waiver evidence
    // outside that mode.
    if (!modeGateOpen) {
      modeDisabled.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }
    valid.push({
      authorLogin,
      checkSelector: parsed.checkSelector,
      reason: parsed.reason,
      expiresAt: parsed.expiresAt,
      createdAt: parsed.createdAt,
    });
  }
  return {
    valid,
    expired,
    wrongHead,
    wrongClaim,
    unauthorized,
    malformed,
    notConfigured,
    modeDisabled,
  };
}
export function findLiveStatusDigestComments(comments) {
  return comments.filter((comment) => {
    return firstLine(comment.body ?? '') === LIVE_STATUS_DIGEST_MARKER;
  });
}
export function renderLiveStatusDigest(fields) {
  const normalized = normalizeLiveStatusDigestFields(fields);
  return `${LIVE_STATUS_DIGEST_MARKER}

| Field | Value |
| --- | --- |
| Phase | ${escapeMarkdownTableCell(normalized.phase)} |
| Claim | ${escapeMarkdownTableCell(normalized.claim)} |
| Branch | ${escapeMarkdownTableCell(normalized.branch)} |
| Last checked | ${escapeMarkdownTableCell(normalized.lastChecked)} |
| Open blockers | ${escapeMarkdownTableCell(normalized.openBlockers)} |
| Next action | ${escapeMarkdownTableCell(normalized.nextAction)} |
| Authoritative by | ${escapeMarkdownTableCell(normalized.authoritativeBy)} |
`;
}
export function planLiveStatusDigestUpsert(comments, fields) {
  const matches = findLiveStatusDigestComments(comments);
  const nextBody = renderLiveStatusDigest(fields);
  if (matches.length > 1) {
    return {
      action: 'duplicate',
      canApply: false,
      body: null,
      duplicates: matches.map((comment) => ({
        id: comment.id ?? null,
        url: comment.html_url ?? comment.url ?? null,
        createdAt: comment.created_at ?? comment.createdAt ?? null,
        updatedAt: comment.updated_at ?? comment.updatedAt ?? null,
      })),
      repairPath: [
        'Multiple current live status digest comments were found.',
        'Do not delete or minimize any audit history during unattended execution.',
        'Use trusted markers and GitHub state for workflow decisions until a maintainer selects one current digest and converts stale duplicate markers to non-current digest text.',
      ].join(' '),
    };
  }
  if (matches.length === 0) {
    return {
      action: 'create',
      canApply: true,
      body: nextBody,
      duplicates: [],
    };
  }
  const [current] = matches;
  if (sameDigestBody(current.body ?? '', nextBody)) {
    return {
      action: 'noop',
      canApply: true,
      body: nextBody,
      commentId: current.id ?? null,
      url: current.html_url ?? current.url ?? null,
      duplicates: [],
    };
  }
  return {
    action: 'update',
    canApply: true,
    body: nextBody,
    commentId: current.id ?? null,
    url: current.html_url ?? current.url ?? null,
    duplicates: [],
  };
}
/**
 * Orchestrate the apply-time live-status-digest upsert: re-fetch and
 * re-plan against the latest comments, then revalidate the active claim
 * immediately before the create/update mutation, so a claim release or
 * takeover that lands during the replan's network fetch is caught before
 * the write. The side-effecting I/O is injected so the ordering invariant
 * — replan, then claim check, then mutation, and no write when the claim
 * check throws — is unit-testable apart from the live `gh` calls.
 */
export function applyDigestUpsert(io) {
  const planned = io.refetchAndPlan();
  if (planned.action === 'duplicate') {
    return { planned, outcome: 'duplicate' };
  }
  if (!io.skipClaimCheck) {
    io.assertClaim();
  }
  if (planned.action === 'create') {
    const created = io.createComment(planned.body);
    return {
      planned,
      outcome: 'created',
      commentId: created.id ?? null,
      url: created.html_url ?? created.url ?? null,
    };
  }
  if (planned.action === 'update') {
    if (planned.commentId === undefined || planned.commentId === null) {
      throw new Error(
        'cannot update digest because the current comment id is missing',
      );
    }
    const updated = io.updateComment(planned.commentId, planned.body);
    return {
      planned,
      outcome: 'updated',
      commentId: updated.id ?? planned.commentId,
      url: updated.html_url ?? updated.url ?? planned.url ?? null,
    };
  }
  return { planned, outcome: 'noop' };
}
export function unsafeTextReason(body) {
  for (const rule of UNSAFE_TEXT_RULES) {
    if (rule.pattern.test(body)) {
      return rule.reason;
    }
  }
  return null;
}
// #2473: Copilot's PR-level review object reports a `[bot]`-suffixed slug
// login (`copilot-pull-request-reviewer[bot]`), but its inline
// review-comment replies report a bare, capitalized display-name login
// (`Copilot`, normalized here to `copilot`) with no suffix. The former
// prefix check (`normalized.startsWith('copilot-pull-request-reviewer')`)
// never matched that bare form, so a caller filtering comments by
// `isKnownReviewBot` silently treated a genuine Copilot reply as unknown.
// Delegating to `isCopilotReviewerLogin` (the #1686 exact-set matcher,
// already reused by the advisory-wait pending-coverage path) recognizes
// all three genuine login forms via `EXACT_COPILOT_REVIEWER_LOGINS`,
// including the bare `copilot` form, and narrows the old unbounded prefix
// match to that exact set -- closing the #1686 lookalike-username gap
// here too as a side effect of reuse, not a separately-designed change.
export function isKnownReviewBot(login) {
  const normalized = login.toLowerCase();
  // `isCopilotReviewerLogin` also trims `login`, unlike the plain
  // `.toLowerCase()` above -- a benign widening (a GitHub API `login` field
  // never carries surrounding whitespace) rather than a deliberate choice.
  return REVIEW_BOT_LOGINS.has(normalized) || isCopilotReviewerLogin(login);
}
export function isCodeRabbitLogin(login) {
  const normalized = login.toLowerCase();
  return normalized === 'coderabbitai' || normalized === 'coderabbitai[bot]';
}
// The exact CodeRabbit summary-walkthrough marker. CodeRabbit prefixes its
// auto-generated review summary with this HTML comment (distinct from the
// `rate limited by coderabbit.ai` notice marker). Single-sourced here so the
// comment-minimization classifier (`classifyRegularBotComment`) and the
// disposition-evidence summary predicate (`isReviewSummaryComment`) recognize
// byte-for-byte the same marker and cannot drift.
export const CODERABBIT_SUMMARY_MARKER =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';
// #2161: CodeRabbit nests this inner marker inside a comment that also
// starts with `CODERABBIT_SUMMARY_MARKER` when no review content exists
// (billing failure, or a repository below the star-count manual-trigger
// gate) -- the outer wrapper is byte-for-byte identical to a genuine
// summary walkthrough, so this inner marker is the only signal
// distinguishing the two. Single-sourced here so `isAdvisoryNonReviewNotice`
// and `isReviewSummaryComment` agree on the same marker and cannot drift.
export const CODERABBIT_SKIP_REVIEW_MARKER =
  '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->';
// Case-insensitive, matching CodeRabbit's own outer-marker patterns
// elsewhere in this file (see the rate-limit marker above) -- a
// case-sensitive `includes()` check here previously let
// `isReviewSummaryComment` and `isAdvisoryNonReviewNotice` disagree on a
// casing-only marker variation (kurone-kito/idd-skill#2161 review).
// Single-sourced so both predicates share the exact same test.
const CODERABBIT_SKIP_REVIEW_MARKER_RE = new RegExp(
  escapeRegExp(CODERABBIT_SKIP_REVIEW_MARKER),
  'i',
);
// The exact marker CodeRabbit appends to a reply it generates on an
// existing review thread (distinct from `CODERABBIT_SUMMARY_MARKER`,
// which opens a fresh review-summary walkthrough). Single-sourced here
// (#2641 review) so `classifyRegularBotComment`'s stale review-trigger
// check and `CODERABBIT_ACK_OPENING_RE`'s marker-first tolerance
// recognize byte-for-byte the same marker and cannot drift.
export const CODERABBIT_AUTO_GENERATED_REPLY_MARKER =
  '<!-- This is an auto-generated reply by CodeRabbit -->';
// Matches the two section headings this older CodeRabbit format nests
// per-file findings under (kurone-kito/idd-skill#2197, kurone-kito/idd-skill#2559): a review whose finding has no
// threaded comment of its own. A newer-format review ("Actionable comments
// posted: N", individually threaded) never emits either heading, so this
// gate alone already satisfies the "newer format stays unaffected"
// acceptance criterion.
const CODERABBIT_EMBEDDED_SECTION_HEADING_RE =
  /<summary>(?:🧹 Nitpick comments|⚠️ Outside diff range comments) \(\d+\)<\/summary>/g;
// A per-file grouping inside one of the sections above: `<summary>{file}
// (N)</summary>`. Accepts an extensionless, separator-less filename (e.g.
// `Dockerfile`, `Makefile`, `LICENSE`) -- an earlier version required a
// `.` extension or `/` separator to avoid matching an unrelated
// `<summary>` heading that also carries a parenthesized count, e.g. the
// review's own "📒 Files selected for processing (N)" section, but that
// also dropped every finding for a real extensionless file (Copilot
// review, PR #2563). The real defense against that unrelated heading is
// {@link CODERABBIT_EMBEDDED_SECTION_END_RE} bounding the section's own
// span below, not this pattern.
const CODERABBIT_EMBEDDED_FILE_HEADING_RE =
  /<summary>([^<]+?) \(\d+\)<\/summary>/g;
// Marks the natural end of a Nitpick/Outside-diff section's own content in
// every review body sampled for #2197/#2559: CodeRabbit always follows the
// per-file findings with this footer before any unrelated section (e.g.
// "ℹ️ Review info" > "📒 Files selected for processing"). Bounding the
// section span here -- not just at the next same-kind section heading --
// keeps the relaxed file-heading pattern above from matching a later,
// unrelated `<summary>{text} (N)</summary>` several sections down (Copilot
// review, PR #2563).
const CODERABBIT_EMBEDDED_SECTION_END_RE =
  /<summary>🤖 Prompt for all review comments with AI agents<\/summary>/;
// One finding's header line inside a file grouping: a backtick-quoted line
// or line range, a colon, then 1-3 pipe-separated italic metadata segments
// (category, severity, effort -- CodeRabbit does not document this shape
// itself; it is inferred from every review body sampled for #2197/#2559).
// Deliberately confined to same-line whitespace (`[ \t]`, never `\s`, which
// includes newlines) in both the per-segment content and the separator
// between segments: an earlier `\s`-based version could absorb an entirely
// separate later `_italic_` phrase from the finding's own prose into this
// same metadata capture once a blank line intervened, corrupting the
// severity/title boundary (Copilot review, PR #2563).
const CODERABBIT_EMBEDDED_FINDING_HEADER_RE =
  /`(\d+(?:-\d+)?)`:[ \t]*((?:_[^_\n]*_[ \t]*\|?[ \t]*)+)/g;
// No `\b` before/after the word: each segment is markdown-italic-wrapped
// (`_..._`), and `_` is itself a `\w` character, so a trailing `\b` would
// never match immediately before the closing underscore.
const CODERABBIT_SEVERITY_WORD_RE = /(Trivial|Minor|Major|Critical)/i;
/** Bold title line (`**...**`) directly introducing a finding's prose. */
const CODERABBIT_EMBEDDED_FINDING_TITLE_RE = /\*\*(.+?)\*\*/;
/**
 * Extract each finding embedded in a CodeRabbit review body's older
 * "🧹 Nitpick comments" / "⚠️ Outside diff range comments" collapsible
 * format (#2197, #2559) -- a specific, file/line-cited finding that this
 * format never gives its own threaded review comment, unlike CodeRabbit's
 * newer per-comment format. Returns `[]` when `body` carries neither
 * section heading (including every newer-format review) or is not a
 * string.
 *
 * Best-effort, not a full HTML/Markdown parser: scoped to one section at a
 * time by heading-to-next-heading text slicing, then one file grouping at a
 * time the same way, then one finding header line at a time within that
 * slice. A finding whose bold title cannot be found before the next
 * boundary still contributes an entry with `description: ''` rather than
 * being silently dropped -- an uncovered finding this parser cannot
 * describe is still an uncovered finding.
 */
export function extractCodeRabbitEmbeddedFindings(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return [];
  }
  const sectionHeadings = [
    ...body.matchAll(CODERABBIT_EMBEDDED_SECTION_HEADING_RE),
  ];
  if (sectionHeadings.length === 0) {
    return [];
  }
  const findings = [];
  for (let i = 0; i < sectionHeadings.length; i += 1) {
    const start = sectionHeadings[i].index + sectionHeadings[i][0].length;
    const nextSectionStart = sectionHeadings[i + 1]?.index ?? body.length;
    const footerMatch = body
      .slice(start, nextSectionStart)
      .match(CODERABBIT_EMBEDDED_SECTION_END_RE);
    const end =
      footerMatch?.index !== undefined
        ? start + footerMatch.index
        : nextSectionStart;
    findings.push(
      ...extractCodeRabbitEmbeddedFindingsFromSection(body.slice(start, end)),
    );
  }
  return findings;
}
function extractCodeRabbitEmbeddedFindingsFromSection(section) {
  const fileHeadings = [
    ...section.matchAll(CODERABBIT_EMBEDDED_FILE_HEADING_RE),
  ];
  const findings = [];
  for (let i = 0; i < fileHeadings.length; i += 1) {
    const file = fileHeadings[i][1].trim();
    const start = fileHeadings[i].index + fileHeadings[i][0].length;
    const end = fileHeadings[i + 1]?.index ?? section.length;
    const zone = section.slice(start, end);
    // Collected up front (not iterated via a live matchAll) so each
    // finding's own title search below can be bounded by the NEXT
    // finding's header position -- searching the zone's unbounded
    // remainder let a finding with no bold title of its own "steal" a
    // later finding's title instead of reporting an empty description
    // (Copilot review, PR #2563).
    const headers = [...zone.matchAll(CODERABBIT_EMBEDDED_FINDING_HEADER_RE)];
    for (let j = 0; j < headers.length; j += 1) {
      const header = headers[j];
      const lineRange = header[1];
      const severityMatch = header[2].match(CODERABBIT_SEVERITY_WORD_RE);
      const contentStart = header.index + header[0].length;
      const contentEnd = headers[j + 1]?.index ?? zone.length;
      const findingContent = zone.slice(contentStart, contentEnd);
      const titleMatch = findingContent.match(
        CODERABBIT_EMBEDDED_FINDING_TITLE_RE,
      );
      findings.push({
        file,
        lineRange,
        severity: severityMatch ? severityMatch[0] : null,
        description: titleMatch ? titleMatch[1].trim() : '',
      });
    }
  }
  return findings;
}
/**
 * Compare {@link extractCodeRabbitEmbeddedFindings}'s count for `body`
 * against `threadedCommentCount` -- the number of `coderabbitai[bot]`
 * threaded review comments already present for this review/PR -- so a
 * caller gets the uncovered-finding gap (#2559) without re-deriving the
 * comparison. Never negative: a review whose threaded comments already
 * meet or exceed its embedded-finding count reports `0`.
 */
export function countUncoveredCodeRabbitEmbeddedFindings(
  body,
  threadedCommentCount,
) {
  const embeddedFindingCount = extractCodeRabbitEmbeddedFindings(body).length;
  return Math.max(0, embeddedFindingCount - threadedCommentCount);
}
export function classifyRegularBotComment(
  comment,
  comments,
  threads,
  options = {},
) {
  const author = comment.author?.login ?? '';
  if (!isCodeRabbitLogin(author)) {
    return null;
  }
  if (hasUnresolvedKnownBotThreads(threads)) {
    return null;
  }
  const body = (comment.body ?? '').trimStart();
  if (body.startsWith(CODERABBIT_SUMMARY_MARKER)) {
    if (/No actionable comments were generated/i.test(body)) {
      return {
        classifier: 'RESOLVED',
        reason: 'CodeRabbit completed summary reported no actionable comments',
      };
    }
    if (
      hasExplicitDispositionAfter(comment, comments, {
        isDispositionAuthor: options.isDispositionAuthor,
      }) ||
      hasCompletedBotThreadDispositions(threads, isCodeRabbitLogin, {
        isDispositionAuthor: options.isDispositionAuthor,
      })
    ) {
      return {
        classifier: 'RESOLVED',
        reason:
          'CodeRabbit completed summary has matched IDD disposition evidence',
      };
    }
    return null;
  }
  if (body.startsWith(CODERABBIT_AUTO_GENERATED_REPLY_MARKER)) {
    if (
      /\b(Review triggered|Sure! I'll review|I'll review)\b/i.test(body) &&
      hasExplicitDispositionAfter(comment, comments, {
        isDispositionAuthor: options.isDispositionAuthor,
      })
    ) {
      return {
        classifier: 'OUTDATED',
        reason:
          'stale CodeRabbit review-trigger acknowledgement after completed review',
      };
    }
  }
  return null;
}
export function indexLatestGatingReviewsByAuthor(reviews) {
  const index = new Map();
  for (const review of reviews) {
    const state = String(review.state ?? '');
    if (state === 'COMMENTED' || state === 'PENDING') {
      continue;
    }
    const author = review.author?.login?.toLowerCase();
    if (!author) {
      continue;
    }
    const effectiveSubmittedAt = normalizeGatingReviewTimestamp(review, state);
    if (!effectiveSubmittedAt) {
      continue;
    }
    const current = index.get(author);
    const currentTime = current
      ? Date.parse(current.submittedAt ?? current.submitted_at ?? '')
      : Number.NEGATIVE_INFINITY;
    const reviewTime = Date.parse(effectiveSubmittedAt);
    if (!current || reviewTime >= currentTime) {
      index.set(author, {
        ...review,
        submittedAt: effectiveSubmittedAt,
        submitted_at: effectiveSubmittedAt,
      });
    }
  }
  return index;
}
export function indexThreadsByReview(threads, options = {}) {
  const index = new Map();
  for (const thread of threads) {
    const reviewIds = new Set(
      (thread.comments?.nodes ?? [])
        .map((comment) => comment.pullRequestReview?.id)
        .filter(Boolean),
    );
    for (const reviewId of reviewIds) {
      const current = index.get(reviewId) ?? {
        total: 0,
        unresolved: 0,
        missingDisposition: 0,
        incomplete: false,
        threadIds: [],
      };
      current.total += 1;
      if (!thread.isResolved) {
        current.unresolved += 1;
      }
      if (
        !hasFreshDisposition(thread, {
          isDispositionAuthor: options.isDispositionAuthor,
        }) &&
        !classifyThreadAckOnlyPostDisposition(thread, {
          iddAgentLogins: options.iddAgentLogins,
          advisoryBotLogins: options.advisoryBotLogins,
          prAuthorLogin: options.prAuthorLogin,
        }).ackOnlyPostDisposition
      ) {
        current.missingDisposition += 1;
      }
      if (thread.comments?.pageInfo?.hasNextPage) {
        current.incomplete = true;
      }
      current.threadIds.push(thread.id);
      index.set(reviewId, current);
    }
  }
  return index;
}
export function routeRejectedChangesRequestedReview(input) {
  const escalationPolicy = getReviewEscalationChangesRequestedPolicy(
    input?.policyConfig ?? {},
  );
  const firstEscalationWindowMs = escalationPolicy.escalateAfterMs;
  const postEscalationWindowMs = escalationPolicy.releaseAfterEscalationMs;
  const totalWindowLabel = formatDurationLabel(
    firstEscalationWindowMs + postEscalationWindowMs,
  );
  const firstWindowLabel = formatDurationLabel(firstEscalationWindowMs);
  const reviewState = String(input.reviewState ?? '');
  if (reviewState !== 'CHANGES_REQUESTED') {
    return {
      route: 'proceed',
      reason: 'changes-requested state already cleared',
    };
  }
  const reviewerDisposition = String(input.reviewerDisposition ?? 'none');
  if (reviewerDisposition === 'disagreed') {
    return {
      route: 'return-to-e1',
      reason:
        'reviewer disagreed with the rejection and the feedback must return to triage',
    };
  }
  if (reviewerDisposition === 'agreed-state-cleared') {
    return {
      route: 'hold-await-state-clear',
      reason:
        'reviewer agreement alone does not clear a changes-requested state',
    };
  }
  if (reviewerDisposition === 'agreed-state-unchanged') {
    return {
      route: 'hold-await-state-clear',
      reason:
        'reviewer agreement alone does not clear a changes-requested state',
    };
  }
  const maintainerDisposition = String(input.maintainerDisposition ?? 'none');
  if (maintainerDisposition === 'agreed-state-unchanged') {
    return {
      route: 'hold-await-state-clear',
      reason:
        'maintainer agreement does not clear the original changes-requested state',
    };
  }
  const elapsedMs =
    Date.parse(input.now ?? '') -
    Date.parse(input.rejectionCommentCreatedAt ?? '');
  if (!Number.isFinite(elapsedMs)) {
    return {
      route: 'hold-for-evidence',
      reason:
        'elapsed time cannot be computed for the rejected changes-requested review',
    };
  }
  if (elapsedMs < firstEscalationWindowMs) {
    return {
      route: 'hold-before-escalation',
      reason: `still within the first ${firstWindowLabel} after the rejection reply`,
    };
  }
  const escalationElapsedMs =
    Date.parse(input.now ?? '') -
    Date.parse(input.escalationCommentCreatedAt ?? '');
  if (!Number.isFinite(escalationElapsedMs)) {
    return {
      route: 'escalate-maintainer',
      reason: `the changes-requested review is still blocking after ${firstWindowLabel} with no reviewer response`,
    };
  }
  if (escalationElapsedMs < postEscalationWindowMs) {
    return {
      route: 'hold-after-escalation',
      reason: `still within ${formatDurationLabel(postEscalationWindowMs)} of the maintainer escalation comment`,
    };
  }
  return {
    route: 'label-and-release',
    reason: `the changes-requested review is still blocking after ${totalWindowLabel} with no escalation response`,
  };
}
function formatDurationLabel(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '0 minutes';
  }
  if (milliseconds % (60 * 60 * 1000) === 0) {
    const hours = milliseconds / (60 * 60 * 1000);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (milliseconds % (60 * 1000) === 0) {
    const minutes = milliseconds / (60 * 1000);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = milliseconds / 1000;
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}
export function diffReviewSnapshot(snapshot, live) {
  if (String(live.headSha ?? '') !== String(snapshot.headSha ?? '')) {
    return { route: 'return-to-e1', reason: 'head-changed' };
  }
  const snapshotMax = normalizeComparableTimestamp(
    snapshot.maxActivityUpdatedAt,
  );
  const liveMax = normalizeComparableTimestamp(live.maxActivityUpdatedAt);
  const snapshotCount = Number(snapshot.totalItemCount ?? 0);
  const liveCount = Number(live.totalItemCount ?? 0);
  // Structural ack-only carve-out (#858): when the only activity newer
  // than the snapshot is post-disposition advisory-bot acknowledgement
  // evidence, fall back to the effective values instead of re-opening.
  // Absent evidence keeps the legacy behavior unchanged (fail-closed).
  const ackItems = Array.isArray(live.ackOnly?.items) ? live.ackOnly.items : [];
  const ackEvidencePresent =
    live.ackOnly?.dispositionsPresent === true && ackItems.length > 0;
  const effectiveMax = normalizeComparableTimestamp(
    live.effective?.maxActivityUpdatedAt ?? 'none',
  );
  let ackOnlyApplied = false;
  if (snapshotMax === 'none' && liveCount > 0) {
    return { route: 'return-to-e1', reason: 'snapshot-was-empty-now-nonempty' };
  }
  if (
    typeof snapshotMax === 'number' &&
    liveCount > 0 &&
    (liveMax === null || liveMax === 'none')
  ) {
    return { route: 'return-to-e1', reason: 'missing-live-activity-evidence' };
  }
  if (
    typeof snapshotMax === 'number' &&
    typeof liveMax === 'number' &&
    liveMax > snapshotMax
  ) {
    const effectiveCurrent =
      ackEvidencePresent &&
      typeof live.effective === 'object' &&
      live.effective !== null &&
      (effectiveMax === 'none' ||
        (typeof effectiveMax === 'number' && effectiveMax <= snapshotMax));
    if (!effectiveCurrent) {
      return { route: 'return-to-e1', reason: 'newer-activity' };
    }
    ackOnlyApplied = true;
  }
  if (liveCount > snapshotCount) {
    // Only ack comments newer than the snapshot max may explain count
    // growth; older acks were already inside the snapshot's count.
    const ackNewerCount = ackItems.filter(
      (item) =>
        item.kind === 'comment' &&
        isValidIsoTimestamp(item.activityAt) &&
        typeof snapshotMax === 'number' &&
        compareIsoTimestamps(item.activityAt, snapshot.maxActivityUpdatedAt) >
          0,
    ).length;
    if (!(ackEvidencePresent && liveCount - ackNewerCount <= snapshotCount)) {
      return { route: 'return-to-e1', reason: 'same-timestamp-count-growth' };
    }
    ackOnlyApplied = true;
  }
  const snapshotCi = normalizeComparableTimestamp(
    snapshot.latestPassingCiCompletedAt ?? snapshot.latestCiCompletedAt,
  );
  const liveCi = normalizeComparableTimestamp(
    live.latestPassingCiCompletedAt ?? live.latestCiCompletedAt,
  );
  if (snapshotCi === null || liveCi === null) {
    return { route: 'return-to-e1', reason: 'missing-ci-evidence' };
  }
  if (snapshotCi !== liveCi) {
    return { route: 'return-to-e1', reason: 'ci-pass-drift' };
  }
  return {
    route: 'proceed',
    reason: ackOnlyApplied ? 'ack-only-post-disposition' : 'snapshot-current',
  };
}
export function classifyReviewThreadForGate(thread, options = {}) {
  if (thread.isResolved) {
    return { classification: 'resolved' };
  }
  if (thread.comments?.pageInfo?.hasNextPage) {
    return { classification: 'actionable-blocking' };
  }
  const comments = thread.comments?.nodes ?? [];
  const latestComment = comments.at(-1) ?? null;
  const latestCommentAt = normalizeComparableTimestamp(
    latestComment?.createdAt,
  );
  const latestAuthor = String(latestComment?.author?.login ?? '').toLowerCase();
  const iddAgentLogins = new Set(
    (options.iddAgentLogins ?? [])
      .map((login) => String(login ?? '').toLowerCase())
      .filter(Boolean),
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '').toLowerCase();
  const latestIsIddAgent = iddAgentLogins.has(latestAuthor);
  const latestIsPrAuthor =
    Boolean(prAuthorLogin) && latestAuthor === prAuthorLogin;
  let latestAmdIndex = -1;
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    const authorLogin = String(comment.author?.login ?? '').toLowerCase();
    if (
      iddAgentLogins.has(authorLogin) &&
      AMD_MARKER_PATTERN.test(String(comment.body ?? '').trimStart())
    ) {
      latestAmdIndex = index;
    }
  }
  const reviewerReopenedAt = normalizeComparableTimestamp(
    inferReviewerReopenedAt(thread),
  );
  const reopenedAfterLatestComment =
    typeof reviewerReopenedAt === 'number' &&
    (typeof latestCommentAt !== 'number' ||
      reviewerReopenedAt > latestCommentAt);
  const amdAwaitsMaintainer =
    latestAmdIndex >= 0 &&
    !reopenedAfterLatestComment &&
    !comments.slice(latestAmdIndex + 1).some((comment) => {
      const authorLogin = String(comment.author?.login ?? '').toLowerCase();
      return !iddAgentLogins.has(authorLogin) && authorLogin !== prAuthorLogin;
    });
  if (amdAwaitsMaintainer) {
    return { classification: 'amd-blocking' };
  }
  if (!(latestIsIddAgent || latestIsPrAuthor)) {
    return { classification: 'actionable-blocking' };
  }
  if (reopenedAfterLatestComment) {
    return { classification: 'actionable-blocking' };
  }
  if (options.requiresConversationResolution) {
    if (latestIsIddAgent) {
      return { classification: 'conversation-resolve-agent' };
    }
    return { classification: 'conversation-resolve-author' };
  }
  return { classification: 'awaiting-reviewer' };
}
// Pre-merge gate invariant (review threads -> `threads.actionableCount`):
// MERGE-BLOCKING. `computePreMergeReadinessBlockers` fails closed unless
// `actionableCount === 0`. An IDD agent's (or the PR author's) latest thread
// comment classifies `awaiting-reviewer`, which does NOT add to
// `actionableCount`, so a recognition error here can fail OPEN: globally
// promoting a non-agent into `iddAgentLogins` makes that actor's genuine
// unresolved feedback classify `awaiting-reviewer` and stop blocking (when
// conversation resolution is not required; otherwise it stays a blocking
// `conversation-resolve-*`). This gate classifies each thread by its own
// latest-author identity (IDD agent / PR author), not by disposition
// recognition; never globally promote a non-agent into `iddAgentLogins`. See
// the consolidated invariants above `summarizeDispositionEvidenceForGate`
// (#1182 / PR #1184).
export function summarizeReviewThreadsForGate(threads, options = {}) {
  const summary = {
    actionableCount: 0,
    awaitingReviewerCount: 0,
    amdBlockingCount: 0,
    conversationResolveAgentCount: 0,
    conversationResolveAuthorCount: 0,
    classifications: [],
  };
  for (const thread of threads) {
    const result = classifyReviewThreadForGate(thread, options);
    if (result.classification === 'resolved') {
      continue;
    }
    summary.classifications.push({
      id: thread.id,
      classification: result.classification,
    });
    if (result.classification === 'actionable-blocking') {
      summary.actionableCount += 1;
      continue;
    }
    if (result.classification === 'amd-blocking') {
      summary.amdBlockingCount += 1;
      summary.actionableCount += 1;
      continue;
    }
    if (result.classification === 'awaiting-reviewer') {
      summary.awaitingReviewerCount += 1;
      continue;
    }
    if (result.classification === 'conversation-resolve-agent') {
      summary.actionableCount += 1;
      summary.conversationResolveAgentCount += 1;
      continue;
    }
    if (result.classification === 'conversation-resolve-author') {
      summary.actionableCount += 1;
      summary.conversationResolveAuthorCount += 1;
    }
  }
  return summary;
}
function inferReviewerReopenedAt(thread) {
  const explicit = String(thread.reviewerReopenedAt ?? '');
  if (isValidIsoTimestamp(explicit)) {
    return explicit;
  }
  return '';
}
export function hasFreshDisposition(thread, options = {}) {
  // IMPORTANT: The default disposition-author predicate rejects known bots but accepts any human.
  // For F2/F3 merge-gate contexts (E7 disposition evidence), callers MUST pass
  // options.isDispositionAuthor with an IDD-scoped predicate (e.g., via summarizeDispositionEvidenceForGate).
  // Callers that require IDD-only dispositions (e.g., audit-pr-cleanup) should pass:
  //   { isDispositionAuthor: (login) => iddAgentLogins.has(login) }
  // This design trades stricter default behavior for backward compatibility with utility functions.
  // `isIddOriginatedBody` (#2139) additionally accepts a stamped disposition
  // regardless of author login: the #2135 review-reply stamp is utterance
  // identity, so a stamped `**Accepted**` still clears an advisory thread
  // even when the same trusted account also posts unmarked human prose.
  const dispositionAuthorPredicate =
    typeof options.isDispositionAuthor === 'function'
      ? options.isDispositionAuthor
      : (login) => !isKnownReviewBot(login);
  const originatedBodyPredicate =
    typeof options.isIddOriginatedBody === 'function'
      ? options.isIddOriginatedBody
      : null;
  const comments = thread.comments?.nodes ?? [];
  // A resolved thread may be terminally dispositioned with the documented
  // `**Rejection confirmed by maintainer**` marker instead of a fresh
  // `**Rejected**` re-post; recognize it as a disposition ONLY when the thread
  // is resolved (an unresolved thread still needs an explicit disposition).
  const threadResolved = Boolean(thread.isResolved);
  const isDisposition = (comment) =>
    isDispositionComment(comment) ||
    (threadResolved && isRejectionConfirmedDisposition(comment));
  const isIddDisposition = (comment) => {
    if (!isDisposition(comment)) {
      return false;
    }
    const authorLogin = String(comment.author?.login ?? '')
      .trim()
      .toLowerCase();
    if (dispositionAuthorPredicate(authorLogin)) {
      return true;
    }
    return Boolean(originatedBodyPredicate?.(String(comment.body ?? '')));
  };
  const latestFeedbackAt = maxIsoTimestamp(
    comments
      .filter((comment) => !isIddDisposition(comment))
      .map((comment) => effectiveThreadCommentActivityAt(comment))
      .filter(isValidIsoTimestamp),
  );
  return comments.some((comment) => {
    if (!isIddDisposition(comment)) {
      return false;
    }
    const dispositionActivityAt = effectiveThreadCommentActivityAt(comment);
    if (!isValidIsoTimestamp(dispositionActivityAt)) {
      return false;
    }
    return (
      !latestFeedbackAt ||
      compareIsoTimestamps(dispositionActivityAt, latestFeedbackAt) > 0
    );
  });
}
// A disposition marker may carry a single interior punctuation char `[.!:]`
// immediately before the closing `**` — `**Accepted.**` (natural English
// "Accepted. Fixed in…"), `**Accepted:**`, `**Accepted!**`, and the `Rejected`
// equivalents — so a reply that punctuates the marker is still recognized. The
// tolerance is bounded to that one char before `**`, so an interior-text body
// like `**Accepted by reviewer, but…**` is NOT matched (fail-closed: a false
// positive is a false merge). Start-anchored (`^`), so the marker must be the
// first bytes of the body each caller passes: `isDispositionComment` uses
// `trimEnd()` only, so leading whitespace is NOT stripped (preserving the
// marker-first-bytes contract), while the notice / summary predicates below
// `trimStart()` first.
const DISPOSITION_ACCEPTED_PREFIX_RE = /^\*\*Accepted[.!:]?\*\*/;
const DISPOSITION_REJECTED_PREFIX_RE = /^\*\*Rejected[.!:]?\*\*/;
// #2249: loose "close but not exact" detector for `missingRegularComments[].hint`
// (`MALFORMED_DISPOSITION_PREFIX_HINT`) -- deliberately laxer than the two
// exact-match regexes above, matching only the four literal prefixes a
// near-miss reply typically starts with: bare `Accepted`/`Rejected`
// (no bold markdown) or `**Accepted`/`**Rejected` (bold markdown present
// but the marker still fails `isDispositionComment`, e.g. interior text
// before the closing `**`). The leading `**` is optional but must be
// exactly zero or two chars (not one, e.g. `*Accepted`), and the
// trailing `\b` stops a longer word like `Acceptedness` from matching --
// Copilot review on PR #2383 caught both gaps in an earlier draft.
// Always paired with `!isDispositionComment` at each call site so an
// already-valid disposition never matches.
const MALFORMED_DISPOSITION_PREFIX_RE = /^(?:\*\*)?(?:Accepted|Rejected)\b/;
export function isDispositionComment(comment) {
  const body = (comment.body ?? '').trimEnd();
  return (
    DISPOSITION_ACCEPTED_PREFIX_RE.test(body) ||
    DISPOSITION_REJECTED_PREFIX_RE.test(body)
  );
}
// Terminal AMD-rejection marker. When a maintainer agrees with a rejection the
// agent replies `**Rejection confirmed by maintainer** — {summary}` and resolves
// the thread, with no separate `**Rejected**` re-post (per
// idd-review-triage.instructions.md). Mirrors the regex in
// review-disposition-verify so the F2/F3 gate recognizes the same marker.
const REJECTION_CONFIRMED_BY_MAINTAINER_RE =
  /^\*\*Rejection confirmed by maintainer\*\*\s+—/;
export function isRejectionConfirmedDisposition(comment) {
  return REJECTION_CONFIRMED_BY_MAINTAINER_RE.test(
    (comment.body ?? '').trimStart(),
  );
}
export function isIddDispositionComment(comment) {
  const author = comment.author?.login ?? '';
  return isDispositionComment(comment) && !isKnownReviewBot(author);
}
// #1018 non-review-notice carry-forward classifiers.
//
// An advisory **non-review notice** — an advisory bot reporting it did not
// review the current HEAD (rate-limit / usage-quota exhaustion / review-limit) —
// carries no review result and is always dispositioned `**Rejected** — {bot} did
// not review HEAD …` per the E6 non-review-notice rule. The gate uses the two
// tight, fail-closed predicates below to let such a disposition carry forward
// across HEAD changes (see `summarizeDispositionEvidenceForGate`), so a Codex
// `updatedAt` bump or a re-posted CodeRabbit rate-limit summary does not re-flag
// `missing-disposition-evidence` for a notice the agent already rejected.
//
// Both intentionally **under-match**: an unrecognized notice merely keeps the
// existing per-push re-disposition churn (safe), while a false positive could
// carry a stale disposition onto a real review (a false merge). Only
// machine-generated, bot-specific signals match, and the notice predicate is
// evaluated solely on advisory-bot-authored comments at the gate, so a human
// reviewer comment is never reclassified as a notice.
const ADVISORY_NON_REVIEW_NOTICE_PATTERNS = [
  // CodeRabbit rate-limit notice: the machine-generated marker (distinct from
  // the `summarize by coderabbit.ai` review marker) and its warning heading.
  /<!--\s*This is an auto-generated comment:\s*rate limited by coderabbit\.ai\s*-->/i,
  /^[>\s]*#{1,6}\s*Review limit reached\b/im,
  // #2161: CodeRabbit skip-review notice, nested inside the same outer
  // `summarize by coderabbit.ai` wrapper as a genuine walkthrough (see
  // CODERABBIT_SKIP_REVIEW_MARKER above) -- carries no review content even
  // though the outer wrapper alone cannot tell it apart from a real summary.
  CODERABBIT_SKIP_REVIEW_MARKER_RE,
];
// #2641: CodeRabbit's own courtesy-acknowledgment reply shape, mirroring
// the notice patterns above (real observed structure, not an invented
// template). Derived from this repository's own merged-PR review-thread
// history: 18/18 sampled CodeRabbit replies that followed an existing
// disposition on a resolved thread were confirmation-only (agreeing with
// or withdrawing the finding, never a new substantive concern), and all 18
// shared both structural signals below (a false positive here could carry
// a stale disposition onto a real review -- a false merge, so this
// deliberately under-matches like the notice patterns above).
//
// Opening: an `` `@{login}` `` mention immediately followed by a
// confirmation/dismissal verb -- the consistent lead-in across every
// sampled reply (e.g. "`@kurone-kito`, confirmed. ...",
// "`@kurone-kito` Thanks for the fix. ...", "`@kurone-kito`, agreed. ...").
// An optional leading `CODERABBIT_AUTO_GENERATED_REPLY_MARKER` is tolerated
// before the mention (Copilot review, #2649): CodeRabbit's other marker-led
// reply form (`classifyRegularBotComment`'s stale review-trigger check
// above) places the marker first, so a courtesy ack using the same
// ordering must not be missed just because `^` otherwise anchors on the
// mention.
const CODERABBIT_ACK_OPENING_RE = new RegExp(
  `^(?:${escapeRegExp(CODERABBIT_AUTO_GENERATED_REPLY_MARKER)}\\s*)?` +
    '`@[\\w.-]+`[,:]?\\s+(?:thanks?(?:\\s+you)?|confirmed|agreed)\\b',
  'i',
);
// Closure (Codex review, PR #2649, round 3): matching the opening plus ANY
// CodeRabbit-generated text -- an auto-generated-reply marker, a skip
// marker, even the bare 🐇 emoji -- is not enough. All of those mark "this
// reply came from CodeRabbit," not "CodeRabbit is done with this finding":
// the bare auto-generated-reply marker alone also appears on 19/48 of
// CodeRabbit's *initial* (non-ack) findings in the same sample. An
// enumerated blocklist of "new concern" phrasing (tried and reverted here)
// is a losing battle -- natural language has unbounded ways to raise a
// concern, as two rounds of adversarial review examples demonstrated.
//
// What IS a reliable signal: CodeRabbit only attempts (or reports failing)
// to mark the review thread itself resolved when it considers the finding
// closed. It never does this on a reply that raises a new concern. This is
// CodeRabbit's own resolution DECISION, not a fingerprint of its output
// format -- exactly the "complete known acknowledgment template" the
// original issue asked for, not a fragment of one. Matches either of the
// two closure forms observed across all 18 sampled trailing acks: "✅
// Review thread resolved." (the thread-resolve API call succeeded) or its
// "I couldn't resolve this review thread on the repository platform..."
// fallback trailer (the same API call failed, so CodeRabbit reports the
// attempt instead).
const CODERABBIT_ACK_CLOSURE_RE =
  /✅\s*Review thread resolved\.|I couldn't resolve this review thread on the repository platform/i;
// Explicit `isCodeRabbitLogin` author check (Copilot review, #2649,
// round 4): the closure phrase is CodeRabbit's own resolution decision in
// practice, but it is still literal text a differently-configured
// advisory bot could in principle also emit. The caller
// (`classifyThreadAckOnlyPostDisposition`) already restricts to
// `isConfiguredAdvisoryBotLogin` (any configured advisory bot, not just
// CodeRabbit), so this check is the cheap, defense-in-depth narrowing
// down to CodeRabbit specifically, on top of (not instead of) the
// content-based signals below. #2641's own research found
// `chatgpt-codex-connector` posted zero post-disposition trailing replies
// across this repository's sampled merged-PR history -- with no observed
// template to derive, it now fails closed both by construction (no
// observed shape) and by this explicit author gate.
//
// Residual risk, stated rather than papered over: CodeRabbit itself
// emitting a closure signal on a reply that is NOT actually a pure
// acknowledgment (a CodeRabbit-side defect) would still misclassify here.
// This helper matches CodeRabbit's own stated decision; it cannot second-
// guess a wrong decision CodeRabbit reports about itself.
function isKnownAdvisoryAckTemplate(comment) {
  const authorLogin = String(comment.author?.login ?? '');
  const body = String(comment.body ?? '');
  return (
    !!authorLogin &&
    isCodeRabbitLogin(authorLogin) &&
    !!body &&
    CODERABBIT_ACK_OPENING_RE.test(body) &&
    CODERABBIT_ACK_CLOSURE_RE.test(body)
  );
}
// Codex usage / quota exhaustion for code reviews. Token-anchored on all
// three of "Codex usage limit(s)", a reach/exceed/hit-family verb, and "for
// code reviews", each tolerant of interposed wording drift, in the two known
// real orderings (#1312: the two prior exact-phrase regexes broke when
// Codex's wording interposed "have been" between "usage limits" and
// "reached"). Requiring "for code reviews" too (not just the verb) keeps the
// match narrow: a bare "Codex usage limits exceeded" mention with no "for
// code reviews" nearby must not match.
const CODEX_USAGE_LIMIT_TOKEN_PATTERN =
  /\b(?:reach|exceed|hit)\w*[\s\S]{0,40}?\bCodex usage limits?\b[\s\S]{0,40}?\bfor code reviews\b|\bCodex usage limits?\b[\s\S]{0,40}?\b(?:reach|exceed|hit)\w*[\s\S]{0,40}?\bfor code reviews\b/i;
// #1326: the token pattern above, by itself, is a structural false positive —
// a genuine review comment that discusses "Codex", a reach/exceed/hit verb,
// and "for code reviews" in ordinary prose (a live risk specifically on PRs
// that touch this detector, as #1319's own review demonstrated) matches it
// too. Tightening the interposed-word gap cannot separate the two cases: the
// words sit just as close together in a real sentence as in the generated
// notice, and no gap bound keeps both known real wordings matching while
// rejecting the false positive (verified empirically while fixing #1326).
//
// Instead, gate the token match on the notice's known SHAPE: a genuine
// Codex/CodeRabbit quota notice is short and is effectively the *entire*
// comment — nothing of substance precedes or follows it (the current wording
// adds one recognizable generated trailer sentence). A genuine review embeds
// the phrase mid-document, with a narrative lead-in, trailing prose, or both.
// Three structural checks apply together, only once the token pattern above
// already matched:
//
// 1. Whole-comment length ≤ CODEX_NOTICE_MAX_LENGTH — defends against a long
//    structured review whose *last* sentence happens to coincidentally
//    match (the longest known real wording — current wording plus its
//    two-sentence trailer, see below — is 199 characters).
// 2. Text before the matched span ≤ CODEX_NOTICE_MAX_PREFIX_LENGTH once
//    trimmed — defends against a narrative lead-in preceding an otherwise
//    bare match (known real prefixes are 0 and 9 characters).
// 3. Text after the matched span is empty/punctuation-only, or matches the
//    tolerant (bounded-gap, token-anchored — not exact-phrase, so a future
//    trailer reword does not reintroduce the #1312 brittleness) generated
//    trailer-continuation pattern below.
//
// This does not achieve perfect semantic disambiguation (a sufficiently
// short human sentence with a trivial lead-in and nothing trailing is
// inherently indistinguishable from the real notice without exact-phrase
// matching, which the #1312 fix deliberately avoids), but it substantially
// narrows the matching surface in the safe direction the block comment above
// already documents: under-match is safe, over-match risks a false merge.
// Anchored to the *entire* trimmed remainder (start `^` through end `$`,
// not a bare substring `.test()`), so "known trailer, then more unrelated
// prose" is still correctly rejected — a substring-only match would let
// extra content after the trailer hide behind a recognized prefix.
//
// Every connector in this pattern (lead-in, inter-sentence, and trailing)
// is bounded to punctuation/whitespace plus, where needed, one specific
// known word — never an arbitrary-content character budget. An earlier
// version of this fix allowed an arbitrary `[\s\S]{0,20}?` lead-in before
// the core trailer tokens (reasoning that the real wording's ". Please "
// connector needed *some* tolerance), but a bounded *character count* still
// admits arbitrary *words* within that budget — a critique pass on this PR
// found that narrative content like "We should " fits the same budget and
// would still reach the trailer tokens. `CODEX_NOTICE_TRAILER_LEAD_IN`
// closes that class by allowing only punctuation/whitespace and the
// literal word "Please" (the only lead-in word in any known real wording),
// so no other word can occupy that position regardless of length.
//
// The live wording observed on this very PR's own Codex review (#1326)
// appends a SECOND administrative sentence after the one #1312 quoted
// ("Credits must be used to enable repository wide code reviews."), so the
// accepted closing shape is two sentences, each independently
// token-anchored and gap-tolerant (not exact-phrase — the same #1312
// wording-drift tolerance applies within each sentence), with the second
// sentence optional so the shorter single-sentence wording still matches.
// SENTENCE_2 anchors the distinctive multi-word phrases "credits must be
// used" and "enable" (not the single generic words "credits" / "repository"
// / "reviews" alone) — matching the same specificity SENTENCE_1 already
// uses, so a comment that merely reuses those individual words near
// SENTENCE_1's exact bot phrasing cannot piggyback a false accept (a gap
// found and closed during this PR's own review-fix rounds).
//
// #1877: a THIRD, structurally distinct wording observed live on PR #1876
// replaces the admin/credits sentence entirely with a dashboard pointer
// ("You can see your limits in the [Codex usage dashboard](url).") — it is
// an alternative closing sentence, not a continuation appended after
// SENTENCE_1/SENTENCE_2, so it is a separate alternation branch
// (SENTENCE_3) rather than a third optional suffix on the admin/credits
// shape. SENTENCE_3 anchors the distinctive multi-word phrase "you can see
// your limits" plus "Codex usage dashboard", with the same bounded,
// gap-tolerant, non-exact-phrase approach as SENTENCE_1/SENTENCE_2. The
// trailing markdown-link close `](url)` is matched structurally (bracket,
// parens, non-`)` URL body) rather than an arbitrary-content character
// budget, and is optional so a future plain-text rendering (no markdown
// link) still matches.
const CODEX_NOTICE_TRAILER_LEAD_IN =
  '[.!,;:\\s]{0,3}(?:\\bPlease\\b[.!,;:\\s]{0,3})?';
const CODEX_NOTICE_TRAILER_SENTENCE_1 =
  '\\bcheck with the admins\\b[\\s\\S]{0,60}?\\bincrease the limits\\b[\\s\\S]{0,60}?\\badding credits\\b';
const CODEX_NOTICE_TRAILER_SENTENCE_2 =
  '\\bcredits must be used\\b[\\s\\S]{0,40}?\\benable\\b[\\s\\S]{0,40}?\\brepository\\b[\\s\\S]{0,40}?\\b(?:code )?reviews?\\b';
const CODEX_NOTICE_TRAILER_SENTENCE_3 =
  '\\byou can see your limits\\b[\\s\\S]{0,60}?\\bCodex usage dashboard\\b(?:\\]\\([^)]*\\))?';
const CODEX_NOTICE_TRAILER_CONTINUATION_PATTERN = new RegExp(
  `^${CODEX_NOTICE_TRAILER_LEAD_IN}(?:${CODEX_NOTICE_TRAILER_SENTENCE_1}(?:[.!,;:\\s]{0,5}${CODEX_NOTICE_TRAILER_SENTENCE_2})?|${CODEX_NOTICE_TRAILER_SENTENCE_3})[.!,;:\\s]*$`,
  'i',
);
const CODEX_NOTICE_MAX_LENGTH = 220;
const CODEX_NOTICE_MAX_PREFIX_LENGTH = 20;
// Anchored to the *entire* trimmed remainder (not a starts-with check), so
// trailing prose that happens to begin with a comma or period is still
// correctly rejected.
const CODEX_NOTICE_SUFFIX_PUNCTUATION_ONLY_RE = /^[.!,;:]*$/;
function isCodexUsageLimitNotice(text) {
  if (!text.trim() || text.trim().length > CODEX_NOTICE_MAX_LENGTH) {
    return false;
  }
  const match = CODEX_USAGE_LIMIT_TOKEN_PATTERN.exec(text);
  if (!match) {
    return false;
  }
  const prefix = text.slice(0, match.index).trim();
  if (prefix.length > CODEX_NOTICE_MAX_PREFIX_LENGTH) {
    return false;
  }
  const remainder = text.slice(match.index + match[0].length).trim();
  return (
    remainder === '' ||
    CODEX_NOTICE_SUFFIX_PUNCTUATION_ONLY_RE.test(remainder) ||
    CODEX_NOTICE_TRAILER_CONTINUATION_PATTERN.test(remainder)
  );
}
export function isAdvisoryNonReviewNotice(body) {
  const text = String(body ?? '');
  if (!text) {
    return false;
  }
  return (
    ADVISORY_NON_REVIEW_NOTICE_PATTERNS.some((pattern) => pattern.test(text)) ||
    isCodexUsageLimitNotice(text)
  );
}
// A trusted IDD disposition of a non-review notice: the canonical
// `**Rejected** — {bot} did not review HEAD {sha} ({reason}); this is not a
// completed review` reply. Requires the `**Rejected**` prefix (via
// `DISPOSITION_REJECTED_PREFIX_RE`, so the bounded trailing-punctuation variants
// like `**Rejected.**` also count; a notice is always rejected, never accepted)
// and the `did not review HEAD` phrase that names the notice, so an ordinary
// rejection of reviewer feedback is excluded.
export function isNonReviewNoticeDisposition(comment) {
  const body = (comment.body ?? '').trimStart();
  return (
    DISPOSITION_REJECTED_PREFIX_RE.test(body) &&
    /\bdid not review HEAD\b/i.test(body)
  );
}
// #1833 diagnostic-only hint text: single-sourced so
// `summarizeDispositionEvidenceForGate`'s `missingRegularComments[].hint`
// names the exact phrase `isNonReviewNoticeDisposition` requires, instead of
// forcing an agent to source-dive this file to discover it. Never consumed by
// any routing decision -- see the `hint` field's own doc comment on
// `DispositionEvidenceSummary`.
export const NON_REVIEW_NOTICE_DISPOSITION_HINT =
  'disposition reply is missing the required non-review-notice phrase: it ' +
  'must start with "**Rejected**" and match /\\bdid not review HEAD\\b/i -- ' +
  'canonical form: "**Rejected** — {bot} did not review HEAD {sha} ' +
  '({reason}); this is not a completed review"';
// #2249 diagnostic-only hint text, single-sourced like
// `NON_REVIEW_NOTICE_DISPOSITION_HINT` above: names the exact literal
// prefix `isDispositionComment` requires, for the far more common
// plain-text mistake -- a reply written as `Accepted — ...` or
// `Rejected — ...` with no bold markdown at all, so it never satisfies
// `isDispositionComment` even though it is clearly an attempted
// disposition. Never consumed by any routing decision -- see the `hint`
// field's own doc comment on `DispositionEvidenceSummary`.
export const MALFORMED_DISPOSITION_PREFIX_HINT =
  'disposition reply is missing the required literal prefix: it must ' +
  'start with exactly "**Accepted**" or "**Rejected**" (bold markdown, ' +
  'optionally followed by one of . ! : before the closing **) -- a plain ' +
  '"Accepted" / "Rejected" without the bold markdown is not recognized';
// #2491 diagnostic-only hint text, single-sourced like the two hints above:
// unlike those (a MIS-PHRASED disposition attempt), this fires when a
// correctly-phrased disposition already exists but the bot later live-edited
// the SAME comment id in place into a non-review notice, bumping its
// `updatedAt` past the disposition's own timestamp -- so the disposition no
// longer postdates the comment and the comment re-appears as missing with no
// indication a reply was ever posted. Never consumed by any routing decision
// -- see the `hint` field's own doc comment on `DispositionEvidenceSummary`.
export const EDITED_AFTER_DISPOSITION_HINT =
  'comment may have already been dispositioned before the bot live-edited ' +
  'this same comment id into a non-review notice -- if so, that disposition ' +
  'now predates the edit and no longer counts; post a fresh disposition ' +
  'reply in the non-review-notice shape';
// #1122 CodeRabbit summary-walkthrough auto-disposition classifiers.
//
// The CodeRabbit summary walkthrough is a regular comment whose body starts with
// `CODERABBIT_SUMMARY_MARKER`. Unlike a non-review notice it IS a completed
// review, so it is dispositioned `**Accepted**` (never `**Rejected**`). The gate
// scores it through its general updatedAt-aware 1:1 pairing, and CodeRabbit edits
// the summary on each re-review, so the disposition-non-review-notices helper
// re-dispositions the CURRENT summary per HEAD rather than carrying an old
// acceptance forward (a stale carry-forward could mask a finding folded into a
// later summary body — the "a false positive is a false merge" hazard).
// True when a regular comment is a CodeRabbit summary walkthrough. Detection is
// start-anchored on the exact single-sourced marker (after trimming leading
// whitespace) so a comment that merely quotes the marker in prose is not matched.
// #2161: a comment that also nests CODERABBIT_SKIP_REVIEW_MARKER carries no
// review content despite starting with the summary marker, so it is excluded
// here too -- never a summary walkthrough, always a non-review notice (see
// isAdvisoryNonReviewNotice / ADVISORY_NON_REVIEW_NOTICE_PATTERNS).
export function isReviewSummaryComment(body) {
  const text = String(body ?? '').trimStart();
  return (
    text.startsWith(CODERABBIT_SUMMARY_MARKER) &&
    !CODERABBIT_SKIP_REVIEW_MARKER_RE.test(text)
  );
}
// A trusted IDD disposition of a CodeRabbit summary walkthrough: the canonical
// `**Accepted** — {bot} summary walkthrough …` reply the helper posts. Requires
// the `**Accepted**` prefix (via `DISPOSITION_ACCEPTED_PREFIX_RE`, so the bounded
// trailing-punctuation variants like `**Accepted.**` also count; a summary is a
// completed review, so it is accepted, never rejected) AND the
// `summary walkthrough` phrase, so an ordinary acceptance of reviewer feedback is
// excluded. Tightly matched to `buildSummaryDispositionBody` so a loose
// acceptance can never be miscredited (which would under-post and strand the
// gate).
export function isReviewSummaryDisposition(comment) {
  const body = (comment.body ?? '').trimStart();
  return (
    DISPOSITION_ACCEPTED_PREFIX_RE.test(body) &&
    /\bsummary walkthrough\b/i.test(body)
  );
}
// The stable identity token of an advisory bot, used to attribute a non-review
// notice disposition to the bot it rejected. The `[bot]` suffix GitHub appends
// is dropped so the token matches whether a login is stored as `coderabbitai`
// or `coderabbitai[bot]`.
export function advisoryBotIdentityToken(login) {
  return String(login ?? '')
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, '');
}
// Captures the span where a bot login structurally appears in each canonical
// disposition template `dispositionNamesAdvisoryBot` recognizes -- between the
// marker (tolerating the same single interior-punctuation variant as
// `DISPOSITION_REJECTED_PREFIX_RE` / `DISPOSITION_ACCEPTED_PREFIX_RE`) and the
// phrase that names the template. Non-greedy so a body with the phrase
// appearing once still captures the shortest, correct span. The `^` anchor
// applies after the caller's `trimStart()` below, so it tolerates leading
// whitespace the same way `isNonReviewNoticeDisposition` /
// `isReviewSummaryDisposition` already do -- not the stricter, untrimmed
// marker-first-bytes contract `isDispositionComment` enforces -- so this
// never matches a marker quoted mid-prose, but a leading blank line or space
// before the marker does not defeat it either.
const REJECTED_NOTICE_LOGIN_SPAN_RE =
  /^\*\*Rejected[.!:]?\*\*\s+—\s+([\s\S]*?)\s+did not review HEAD\b/i;
const ACCEPTED_SUMMARY_LOGIN_SPAN_RE =
  /^\*\*Accepted[.!:]?\*\*\s+—\s+([\s\S]*?)\s+summary walkthrough\b/i;
// True when a non-review-notice or summary-walkthrough disposition body names
// the given advisory bot's GitHub login, so the gate can attribute a
// carry-forward to exactly one bot even when several advisory bots are
// configured. Matches only within the anchored span where a canonical
// template places the bot login -- never a whole-body substring search --
// so a bot whose identity token equals a word from the template's own fixed
// text (e.g. "review", "head", or the #1482 "issuecomment" suffix) cannot
// falsely match a disposition naming a different bot. A body naming several
// bots in one span (a disposition that improperly covers more than one
// notice) still matches each of them, matching the existing 1:1 consumption
// contract at the call sites. Fail-closed: an empty token, or a disposition
// body that does not structurally match either canonical template, names no
// bot.
export function dispositionNamesAdvisoryBot(
  dispositionBody,
  noticeAuthorLogin,
) {
  const token = advisoryBotIdentityToken(noticeAuthorLogin);
  if (!token) {
    return false;
  }
  const body = String(dispositionBody ?? '').trimStart();
  const span =
    REJECTED_NOTICE_LOGIN_SPAN_RE.exec(body)?.[1] ??
    ACCEPTED_SUMMARY_LOGIN_SPAN_RE.exec(body)?.[1];
  if (span === undefined) {
    return false;
  }
  return span.toLowerCase().includes(token);
}
// #2544/#2547: classifies the configured secondary advisory bot's current
// standing for the CURRENT HEAD into exactly one of three outcomes --
// still pending, definitively declined, or genuinely settled -- so
// `buildSecondaryQuietWindowStatus` can give each its own wait treatment
// (full window / zero-wait / short settled buffer respectively) instead of
// #2544's original two-way `settled: boolean` collapsing "no evidence yet"
// and "the bot already, conclusively, declined this exact commit" into the
// same slow path.
//
// - `settled: true` -- the LATEST matching comment for this HEAD is a
//   genuine (non-notice) comment: #2335's "might still be mid-review"
//   concern no longer applies, only the narrower "second/later finding"
//   risk `buildSecondaryQuietWindowStatus`'s settled-buffer branch still
//   protects against.
// - `declined: true` -- the LATEST matching comment for this HEAD is a
//   rate-limit / skip-review notice (`isAdvisoryNonReviewNotice`). #2547's
//   live investigation (`gh api .../commits/{sha}/statuses` across several
//   PRs' head commits, corroborated by hours of subsequent silence on the
//   oldest sampled PR) found every sampled rate-limit decline reaches its
//   terminal commit-status entry within ~6-16 seconds of being queued and
//   is never observed to change afterward, even 15+ hours later -- so a
//   notice for the CURRENT HEAD is itself sufficient, corroborating
//   commit-status data is not required to treat it as definitive. (An
//   implementer's judgment call the issue explicitly left open: a notice
//   with no separately-fetched corroborating commit status still reports
//   `declined: true` here, not the ambiguous/pending case.)
// - Neither `settled` nor `declined` -- still pending: no comment from the
//   bot at or after `headCommittedAt` at all, or an unparseable
//   `headCommittedAt`/unconfigured `secondaryBotLogin`. #2335's original
//   full-window protection is unchanged for this case.
//
// Only the single latest matching comment is examined -- a notice posted
// BEFORE a later genuine comment (rate-limited, then recovered) reports
// `settled: true`, not `declined`, while a notice posted AFTER the latest
// genuine comment reports `declined: true` as a fresh, terminal decline
// for this HEAD -- not "might still produce another review" -- purely as
// a side effect of always picking the latest.
//
// Deliberately reuses `comments` only, not `reviews`: this file's existing
// notice-vs-genuine classification for the secondary bot
// (`isAdvisoryNonReviewNotice`, `isReviewSummaryComment`,
// `classifyRegularBotComment`) already operates purely on top-level PR
// comments -- `ReviewLike` carries no `body` field in this codebase's
// model, so a PR review object can never carry the marker text this needs.
//
// Falls back to `user.login`/`created_at`/`updated_at` alongside
// `author.login`/`createdAt`/`updatedAt`, matching every other
// `CommentLike` reader in this file (Copilot review, #2546): a caller that
// ever passes REST-raw comments straight through, without the CLI layer's
// own `normalizeComment` pass, must not silently fail-closed here just
// because it used the other field-name form.
export function computeSecondaryAdvisoryReviewSettlement(
  comments,
  { secondaryBotLogin, headCommittedAt },
) {
  const token = advisoryBotIdentityToken(secondaryBotLogin);
  const headAt = String(headCommittedAt ?? '');
  if (!token || !isValidIsoTimestamp(headAt)) {
    return { settled: false, settledAt: null, declined: false };
  }
  const matches = comments
    .filter(
      (comment) =>
        advisoryBotIdentityToken(
          comment.author?.login ?? comment.user?.login ?? '',
        ) === token,
    )
    .map((comment) => ({
      body: comment.body ?? '',
      at: effectiveRegularCommentActivityAt({
        updatedAt: comment.updatedAt ?? comment.updated_at,
        createdAt: String(comment.createdAt ?? comment.created_at ?? ''),
      }),
    }))
    .filter(
      (entry) =>
        isValidIsoTimestamp(entry.at) &&
        compareIsoTimestamps(entry.at, headAt) >= 0,
    )
    .sort((left, right) => compareIsoTimestamps(left.at, right.at));
  const latest = matches[matches.length - 1];
  if (!latest) {
    return { settled: false, settledAt: null, declined: false };
  }
  if (isAdvisoryNonReviewNotice(latest.body)) {
    return { settled: false, settledAt: null, declined: true };
  }
  return { settled: true, settledAt: latest.at, declined: false };
}
// #1182 Match trusted machine advisory dispositions to the advisory-bot stickies
// they address, so a disposition posted by a trusted-marker actor who is NOT a
// resolved IDD agent (e.g. a second trusted session) is honored without being
// promoted into a global IDD-agent identity. Matching is strict on FOUR axes:
//   - bot: the disposition body must name the sticky author's bot login
//     (`dispositionNamesAdvisoryBot`);
//   - type: a `**Rejected** — {bot} did not review HEAD …` notice disposition
//     clears only a non-review-notice sticky, and an `**Accepted** — {bot}
//     summary walkthrough …` disposition clears only a CodeRabbit summary
//     sticky — the notice/summary paths are disjoint in the helper that posts
//     them, so a notice rejection must never hide a summary that still needs its
//     own acceptance (or vice versa);
//   - count: consumed 1:1, so one disposition cannot clear several stickies.
//   - recency (summary only): a CodeRabbit summary walkthrough IS a completed
//     review that CodeRabbit edits on each re-review (bumping the sticky's
//     `activityAt`), so a summary disposition clears a summary sticky only when
//     the disposition is strictly NEWER than the sticky — a stale `**Accepted**`
//     can never clear a summary edited after it (the #1122 "a false positive is
//     a false merge" hazard). Non-review notices intentionally skip this: a
//     notice disposition carries forward across HEAD changes while the bot still
//     has not reviewed (the #1018 carry-forward), so it need not post-date a
//     re-posted notice.
// IDD-agent-authored dispositions are excluded here — they are already scored by
// the caller's own disposition pool / watermark — which also prevents a
// viewer-authored (agent AND trusted) disposition from being double-counted. A
// trusted disposition matched here is bound to its advisory item and NEVER flows
// into any generic disposition pool, so an absent or already-resolved sticky
// leaves the disposition unused: it can never clear an unrelated human comment.
// Returns the set of `sortedIndex` values of the stickies that are dispositioned.
function matchTrustedAdvisoryStickyDispositions(
  comments,
  advisoryBotLogins,
  trustedMarkerLogins,
  iddAgentLogins,
) {
  const dispositionedStickyIndexes = new Set();
  const trustedDispositions = comments.filter(
    (comment) =>
      trustedMarkerLogins.has(comment.authorLogin) &&
      !iddAgentLogins.has(comment.authorLogin),
  );
  const byActivityThenIndex = (left, right) => {
    const leftTime = Date.parse(left.activityAt);
    const rightTime = Date.parse(right.activityAt);
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.sortedIndex - right.sortedIndex;
  };
  const kinds = [
    {
      isSticky: (body) => isAdvisoryNonReviewNotice(body),
      isDisposition: (body) => isNonReviewNoticeDisposition({ body }),
      requireNewerDisposition: false,
    },
    {
      isSticky: (body) => isReviewSummaryComment(body),
      isDisposition: (body) => isReviewSummaryDisposition({ body }),
      requireNewerDisposition: true,
    },
  ];
  for (const kind of kinds) {
    const stickiesByBot = new Map();
    for (const comment of comments) {
      if (
        !isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) ||
        !kind.isSticky(comment.body)
      ) {
        continue;
      }
      const list = stickiesByBot.get(comment.authorLogin) ?? [];
      list.push(comment);
      stickiesByBot.set(comment.authorLogin, list);
    }
    // Sort bot logins for deterministic iteration order only. Consumption is
    // tracked per bot login (`consumedDispositionIndexes` below, reset on
    // each iteration of this loop) rather than shared across bots: a single
    // disposition naming several configured bots (`dispositionNamesAdvisoryBot`
    // matches each one it names) must be able to clear one sticky per bot it
    // names, not just the first bot processed. #2475 -- a shared,
    // loop-wide consumption set previously let only the alphabetically-first
    // named bot's sticky be credited, stranding the others.
    for (const botLogin of [...stickiesByBot.keys()].sort()) {
      const consumedDispositionIndexes = new Set();
      const stickies = [...(stickiesByBot.get(botLogin) ?? [])].sort(
        byActivityThenIndex,
      );
      const candidates = trustedDispositions
        .filter(
          (disposition) =>
            kind.isDisposition(disposition.body) &&
            dispositionNamesAdvisoryBot(disposition.body, botLogin),
        )
        .sort(byActivityThenIndex);
      // Greedy oldest-first pairing: match each sticky to the earliest unconsumed
      // matching disposition (that is strictly newer, when the kind requires it),
      // so one disposition never clears several stickies and — for summaries — a
      // disposition only clears a sticky it post-dates.
      for (const sticky of stickies) {
        const match = candidates.find(
          (disposition) =>
            !consumedDispositionIndexes.has(disposition.sortedIndex) &&
            (!kind.requireNewerDisposition ||
              compareIsoTimestamps(disposition.activityAt, sticky.activityAt) >
                0),
        );
        if (match) {
          dispositionedStickyIndexes.add(sticky.sortedIndex);
          consumedDispositionIndexes.add(match.sortedIndex);
        }
      }
    }
  }
  return dispositionedStickyIndexes;
}
/**
 * Parse a check's `completedAt` into epoch milliseconds, or `null` when it
 * is missing, not a valid ISO 8601 timestamp, or the `0001-01-01T00:00:00Z`
 * zero-value sentinel some GitHub API surfaces (e.g. `gh pr checks`) report
 * for a check that has not actually completed — see `isCompletedCiTimestamp`,
 * this file's existing convention for the same sentinel. A still-running
 * instance's `completedAt` reads as one of these three "not completed"
 * shapes until it finishes.
 */
function parseCompletedAt(value) {
  const timestamp = String(value ?? '');
  return isCompletedCiTimestamp(timestamp) ? Date.parse(timestamp) : null;
}
/**
 * Failure-family *conclusion* states that must win a same-instant
 * tie-break and classify as a genuine `classifyCiChecks` failure (#1688).
 * Deliberately excludes `CANCELLED`: a cancelled run reached no real
 * verdict at all (unlike these six, which are all concrete failure
 * conclusions), so it keeps its own separate, lower tie-break rank in
 * `ciStateTieRank` below and stays out of `classifyCiChecks`'s `failed`
 * bucket — see that function and `ci-wait-state.mts`'s `FAILURE_STATES`
 * (which is deliberately *derived from* this set plus `CANCELLED`, not
 * independently maintained, so the two files cannot silently drift apart
 * again the way #1504's local-only fix did).
 *
 * `ERROR` is StatusContext-only (a CheckRun conclusion never reports it);
 * included here so a caller that feeds a raw, un-translated commit-status
 * state directly into `classifyCiChecks` or `ciStateTieRank` still gets
 * failure-family treatment, matching `normalizeStatusCheckRollupEntry`'s
 * translation of StatusContext `error` to the literal `'FAILURE'` for the
 * one call path that already normalizes it upstream.
 */
export const CI_FAILURE_CONCLUSION_STATES = new Set([
  'FAILURE',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
  'ERROR',
]);
/**
 * Tie-break precedence for two check-run instances that complete at the
 * same (or an equally unusable) instant. Every `CI_FAILURE_CONCLUSION_STATES`
 * member always wins (rank 0): a same-instant tie must never hide a real
 * failure behind ordering happenstance (the exact regression
 * `classifyCiChecks`'s unconditional "any FAILURE anywhere" rule existed
 * to prevent, and not a case a rerun can plausibly land in — GitHub
 * `completedAt` has only second resolution, and a rerun must trigger,
 * queue, and execute before it can complete, which practically never
 * lands in the exact same recorded second as the run it supersedes).
 * Pre-#1688, only the literal `'FAILURE'` string won this way; `TIMED_OUT`,
 * `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`, and `ERROR` fell into the
 * generic rank-1 bucket below and could lose a tie to `SUCCESS` by
 * lexicographic happenstance (#1688's reproduction: `SUCCESS` vs
 * `TIMED_OUT`, `'SUCCESS' < 'TIMED_OUT'`). `CANCELLED` always loses (rank
 * 2): a cancelled run reached no real verdict, so it defers to any
 * conclusion that did. Every other state — including pending states,
 * which practically never reach this tie path since they have no
 * completed timestamp to tie on — shares the middle rank (1).
 */
function ciStateTieRank(state) {
  if (state === 'CANCELLED') return 2;
  if (CI_FAILURE_CONCLUSION_STATES.has(state)) return 0;
  return 1;
}
/**
 * True when `candidate` should replace `current` as the representative
 * instance for one check name. A still-incomplete instance (per
 * `parseCompletedAt`) always wins over an already-completed one:
 * completion can only happen after creation, so a live rerun can never be
 * older than the finished run it supersedes — this mirrors GitHub's own
 * latest-per-context semantics, under which an in-progress required check
 * leaves the branch not-clean rather than falling back to a stale
 * completed verdict. Once both sides have completed, the most recently
 * completed one wins.
 *
 * A tie (equal completedAt, or both sides missing/unparseable) never
 * resolves by input order — two independent runs can genuinely complete
 * within the same recorded second. It resolves by `ciStateTieRank`
 * instead; a residual tie within the same rank (e.g. `SUCCESS` vs.
 * `NEUTRAL`, both rank 1) falls back to comparing the state strings
 * themselves, which depends only on the two values being compared, never
 * on which one the caller happened to list first — so the whole
 * selection is fully deterministic regardless of input order.
 */
function isNewerCheckInstance(candidate, current) {
  const candidateAt = parseCompletedAt(candidate.completedAt);
  const currentAt = parseCompletedAt(current.completedAt);
  if (candidateAt !== null && currentAt !== null && candidateAt !== currentAt) {
    return candidateAt > currentAt;
  }
  if ((candidateAt !== null) !== (currentAt !== null)) {
    // Exactly one side has a usable timestamp. The side still missing one
    // is never older than a completed side — a live rerun cannot have
    // started before the finished run it supersedes — so the incomplete
    // side always wins here.
    return candidateAt === null;
  }
  const candidateRank = ciStateTieRank(candidate.state);
  const currentRank = ciStateTieRank(current.state);
  if (candidateRank !== currentRank) {
    return candidateRank < currentRank;
  }
  return candidate.state !== current.state && candidate.state < current.state;
}
/**
 * Reduce a group of check-run instances that share one grouping key
 * (typically a check name) to the single instance that represents the
 * current truth for that key. See `isNewerCheckInstance` for the
 * selection rule. Exported so other same-name dedup call sites (e.g.
 * `ci-wait-state.mts`'s `buildCiWaitStateSummary`, #1478) can reuse this
 * tie-break instead of maintaining an independent copy. `group` is
 * always non-empty in every current caller (each group comes from
 * bucketing a non-empty input list by key), so the seedless `reduce`
 * below never hits its empty-array throw path.
 */
export function selectLatestCheckInstance(group) {
  return group.reduce((latest, candidate) =>
    isNewerCheckInstance(candidate, latest) ? candidate : latest,
  );
}
/**
 * Reduce a check-run list to a single representative instance per
 * `(name, type, workflowName)` group, matching GitHub's own
 * required-status-check semantics: only the latest run for a given
 * producer governs, so a stale instance (e.g. a cancelled or failed run
 * superseded by a later successful rerun) can never outvote the current,
 * authoritative one from the *same* producer.
 *
 * A missing or empty `name` carries no identity to dedupe against, so
 * each such entry gets its own singleton group instead of collapsing
 * every unnamed check together — otherwise an unrelated unnamed failure
 * could be discarded in favor of an unrelated unnamed success that
 * merely happens to also lack a name.
 *
 * `type` (e.g. `'check-run'` vs. `'status-context'`) and `workflowName`
 * are an optional producer-identity discriminator (#1483): two entries
 * that share a `name` but differ on either one are never assumed to be
 * reruns of each other (e.g. a check-run and a legacy commit-status, or
 * two check-runs from different Actions workflows, that happen to share
 * a display name both survive instead of one discarding the other). When
 * `type`/`workflowName` are absent on every entry sharing a `name` (the
 * pre-#1483 data shape, still produced by hand-built fixtures and any
 * caller that predates the discriminator), there is no conflicting
 * signal to split on, so the group dedupes by `name` alone exactly as
 * #1471 established -- this keeps every pre-#1483 caller and test
 * behavior-identical.
 *
 * Residual known limitation: two genuinely independent producers that
 * share both a `name` and a `type` and both lack a `workflowName` (e.g.
 * two different non-Actions GitHub Apps that each post a check-run
 * directly, rather than through a workflow) remain indistinguishable
 * here and will still be grouped together. Closing that fully needs a
 * stronger producer identity (e.g. the owning GitHub App) than
 * `gh`/GraphQL's `statusCheckRollup` exposes today; `ci-wait-state.mts`'s
 * own `(checkName, workflowName)` key has the identical accepted gap.
 */
/**
 * Group check-run instances by the same `(name, type, workflowName)`
 * producer-identity key `selectLatestCheckPerName` reduces to one
 * representative -- shared here so a caller that needs to inspect the
 * DISCARDED siblings, not just the survivor (see
 * {@link findDiscardedNonPassingSiblings}), can never drift out of sync
 * with that grouping.
 */
function groupChecksByProducer(checks) {
  // A Map already iterates in first-insertion order, so grouping into one
  // is enough to preserve stable output order with no separate order array
  // (see the same pattern in `findDuplicateBasenames` in audit-docs.mts).
  const groups = new Map();
  let unnamedCount = 0;
  for (const check of checks) {
    if (!check.name) {
      groups.set(`\0unnamed:${unnamedCount++}`, [check]);
      continue;
    }
    const type = check.type ? String(check.type).trim() : '';
    const workflowName = check.workflowName
      ? String(check.workflowName).trim()
      : '';
    const key = `${String(check.name)}\0${type}\0${workflowName}`;
    const group = groups.get(key);
    if (group) {
      group.push(check);
    } else {
      groups.set(key, [check]);
    }
  }
  return groups;
}
function selectLatestCheckPerName(checks) {
  return [...groupChecksByProducer(checks).values()].map((group) =>
    selectLatestCheckInstance(group),
  );
}
/** Check-run states {@link findDiscardedNonPassingSiblings} treats as
 * "genuinely non-passing": every `CI_FAILURE_CONCLUSION_STATES` member plus
 * `CANCELLED` (deliberately excluded from that set itself -- see its own
 * doc comment -- but still evidence-worthy here: a discarded `CANCELLED`
 * sibling is exactly the #1745 finding, a stale/gated instance masked by a
 * same-name `SUCCESS`). Pending states are excluded on purpose: a discarded
 * still-running sibling in favor of an already-completed one is ordinary,
 * expected dedup behavior, not a discrepancy worth flagging. */
const GENUINELY_NON_PASSING_STATES = new Set([
  ...CI_FAILURE_CONCLUSION_STATES,
  'CANCELLED',
]);
/**
 * Detect same-producer `(name, type, workflowName)` groups whose
 * dedup-selected "latest" instance (`selectLatestCheckInstance`) is
 * pass-equivalent (SUCCESS/SKIPPED/NEUTRAL/NOT_APPLICABLE) while a
 * DISCARDED sibling in that same group is genuinely non-passing (see
 * {@link GENUINELY_NON_PASSING_STATES}) -- the live discrepancy PR #1741
 * exhibited (#1745): `classifyCiChecks` reported `success` for a commit
 * whose GitHub `statusCheckRollup.state` was `FAILURE`, because a
 * `CANCELLED` bot-triggered `idd-advisory-convergence` instance existed
 * alongside the `SUCCESS` instance this dedup selected as "latest".
 * Confirming the exact internal GitHub selection is not possible after the
 * fact (see #1745's evidence-durability note), so this reports the
 * discarded-sibling FACT itself -- a same-name non-passing instance existed
 * and was NOT counted -- rather than asserting why GitHub's own rollup
 * disagreed. Pure and read-only: never changes which instance
 * `selectLatestCheckPerName` selects, only reports when a discarded sibling
 * makes that selection's "success" verdict less certain than it looks.
 */
function findDiscardedNonPassingSiblings(checks) {
  const divergences = [];
  for (const group of groupChecksByProducer(checks).values()) {
    if (group.length < 2) continue;
    const selected = selectLatestCheckInstance(group);
    if (
      !['SUCCESS', 'SKIPPED', 'NEUTRAL', 'NOT_APPLICABLE'].includes(
        selected.state,
      )
    ) {
      continue;
    }
    for (const sibling of group) {
      if (sibling === selected) continue;
      if (!GENUINELY_NON_PASSING_STATES.has(sibling.state)) continue;
      divergences.push({
        name: String(selected.name ?? ''),
        type: selected.type ? String(selected.type) : '',
        workflowName: selected.workflowName
          ? String(selected.workflowName)
          : '',
        selectedState: selected.state,
        selectedCompletedAt: selected.completedAt ?? null,
        discardedState: sibling.state,
        discardedCompletedAt: sibling.completedAt ?? null,
      });
    }
  }
  return divergences;
}
export function classifyCiChecks(checks) {
  const normalized = checks.map((check) => ({
    name: check.name,
    state: String(check.state ?? '').toUpperCase(),
    completedAt: check.completedAt ?? null,
    type: check.type ?? null,
    workflowName: check.workflowName ?? null,
  }));
  // GitHub can report several check-run instances that share the same
  // check `name` (a manual or automatic re-run leaves the earlier instance
  // in the fetched list alongside the new one). Reduce to one instance per
  // name before classifying pass/fail/pending, so a stale instance never
  // outvotes the current one for the same name (see #1471).
  const deduped = selectLatestCheckPerName(normalized);
  // #1745: computed unconditionally (not just for the 'success' path) so
  // every returned shape below carries the same field -- a discarded
  // non-passing sibling is evidence worth surfacing even when the overall
  // status already reads 'failed'/'pending' for an unrelated check name.
  const discardedNonPassingInstances =
    findDiscardedNonPassingSiblings(normalized);
  // #1688: widened from a literal 'FAILURE' match to every
  // CI_FAILURE_CONCLUSION_STATES member, so a TIMED_OUT/ACTION_REQUIRED/
  // STARTUP_FAILURE/STALE/ERROR conclusion classifies as a genuine failure
  // here too, matching ci-wait-state.mts's own bucketing for the same
  // conclusion states instead of silently falling through to 'unknown'.
  // CANCELLED is deliberately not included -- see CI_FAILURE_CONCLUSION_STATES.
  const failed = deduped.filter((check) =>
    CI_FAILURE_CONCLUSION_STATES.has(check.state),
  );
  if (failed.length > 0) {
    return { status: 'failed', failed, discardedNonPassingInstances };
  }
  const pending = deduped.filter((check) => {
    return (
      check.state === 'QUEUED' ||
      check.state === 'IN_PROGRESS' ||
      check.state === 'WAITING'
    );
  });
  if (pending.length > 0) {
    return { status: 'pending', pending, discardedNonPassingInstances };
  }
  const passing = deduped.filter((check) => {
    return ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'NOT_APPLICABLE'].includes(
      check.state,
    );
  });
  return {
    status: passing.length === deduped.length ? 'success' : 'unknown',
    passing,
    unknown: deduped.filter((check) => !passing.includes(check)),
    discardedNonPassingInstances,
  };
}
/**
 * #1686: the exact, closed set of logins recognized for the *default*
 * Copilot primary advisory bot -- the human-facing `copilot` slash-command
 * actor plus the two known GitHub-App review-bot login forms. Previously
 * matched via `normalized.startsWith('copilot-pull-request-reviewer')`,
 * which a *registrable* GitHub username lookalike (for example
 * `copilot-pull-request-reviewer1`) could also satisfy on a public
 * repository: any account can submit a PR review, so a lookalike login
 * could post an empty review of the current HEAD and masquerade as the
 * real bot's convergence signal (Clause 1 of `advisory-convergence.mts`'s
 * verdict: `matchesHead: true, itemCount: 0`). An exact set closes that
 * gap without narrowing the two genuine login forms GitHub actually uses.
 */
const EXACT_COPILOT_REVIEWER_LOGINS = new Set([
  'copilot',
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]',
]);
/**
 * Match a review/reviewer login against the configured primary advisory bot.
 *
 * `primaryBotLogin` defaults to Copilot so existing callers stay behavior-
 * preserving. For the Copilot default, the login must be an exact member of
 * {@link EXACT_COPILOT_REVIEWER_LOGINS} (#1686 -- previously a broader
 * `copilot-pull-request-reviewer*` prefix match; see that constant's doc
 * comment for why it was narrowed). A non-Copilot configured login is
 * matched by exact normalized (trimmed, lower-cased) equality, since an
 * arbitrary bot login has no analogous prefix family.
 */
export function isCopilotReviewerLogin(
  login,
  primaryBotLogin = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
) {
  const normalized = String(login ?? '')
    .trim()
    .toLowerCase();
  const configured =
    String(primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  if (configured === DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN) {
    return EXACT_COPILOT_REVIEWER_LOGINS.has(normalized);
  }
  return normalized === configured;
}
export function findLastCopilotReviewCommit(
  reviews,
  primaryBotLogin = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
) {
  const latest = reviews
    .filter((review) =>
      isCopilotReviewerLogin(
        review.user?.login ?? review.author?.login ?? '',
        primaryBotLogin,
      ),
    )
    .map((review) => ({
      submittedAt: review.submitted_at ?? review.submittedAt ?? '',
      commitId: review.commit_id ?? review.commitId ?? '',
    }))
    .sort((left, right) =>
      compareIsoTimestamps(left.submittedAt, right.submittedAt),
    )
    .at(-1);
  return latest?.commitId ?? '';
}
export function isCopilotPending(
  requestedReviewers,
  primaryBotLogin = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
) {
  return requestedReviewers.some((reviewer) => {
    if (typeof reviewer === 'string') {
      return isCopilotReviewerLogin(reviewer, primaryBotLogin);
    }
    return isCopilotReviewerLogin(
      reviewer?.login ?? reviewer?.user?.login ?? '',
      primaryBotLogin,
    );
  });
}
export function computeCopilotPendingCoversHead(
  timelineEvents,
  prHeadSha,
  primaryBotLogin = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
) {
  let headIndex = -1;
  let requestIndex = -1;
  timelineEvents.forEach((event, index) => {
    const eventName = String(event?.event ?? '');
    if (eventName === 'committed') {
      const sha = String(event?.sha ?? event?.commit_id ?? '');
      if (sha === prHeadSha) {
        headIndex = index;
      }
      return;
    }
    if (eventName === 'review_requested') {
      const reviewerLogin = event?.requested_reviewer?.login ?? '';
      if (isCopilotReviewerLogin(reviewerLogin, primaryBotLogin)) {
        requestIndex = index;
      }
    }
  });
  return headIndex !== -1 && requestIndex !== -1 && requestIndex > headIndex;
}
/**
 * #2167: REST `requested_reviewers` can report empty (`{"users":[]}`) even
 * when Copilot review is still genuinely outstanding for the current HEAD --
 * observed on this source repository during PR #2158, where REST returned
 * an empty list (HTTP 200, not a 5xx) while GraphQL `reviewRequests` still
 * listed the primary bot and `computeCopilotPendingCoversHead` was already
 * `true`. `isCopilotPending` alone is REST-only and misses that case;
 * `evaluateAdvisoryWaitOutcome` / `evaluateAdvisoryWaitF3Outcome` and the
 * AW3 table are unchanged -- callers pass this corrected boolean into
 * `outcomeInput` exactly where the uncorrected `isCopilotPending` result
 * used to go, so the corrected pending bit flows through the existing
 * formulas unmodified.
 *
 * Precedence, cheapest signal first:
 * 1. REST `requestedReviewers` already lists the primary bot -> `true`.
 * 2. Already-fetched timeline evidence (`copilotPendingCoversHead`) shows
 *    the primary bot is still requested as of a HEAD the latest Copilot
 *    review does not cover -> `true`, no extra HTTP call needed.
 * 3. `graphqlRequestedReviewerLogins` -- an optional, already-fetched
 *    GraphQL `reviewRequests` login list; `null`/`undefined` means "not
 *    attempted, or the attempt failed" -- lists the primary bot -> `true`.
 * 4. Otherwise -> `false`, including when the optional GraphQL check was
 *    skipped or failed: an absent or failed GraphQL result keeps the
 *    REST-derived result rather than assuming pending.
 */
export function resolveCopilotPending(
  requestedReviewers,
  copilotPendingCoversHead,
  lastCopilotCommit,
  prHeadSha,
  graphqlRequestedReviewerLogins,
  primaryBotLogin = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
) {
  if (isCopilotPending(requestedReviewers, primaryBotLogin)) {
    return true;
  }
  if (copilotPendingCoversHead && lastCopilotCommit !== prHeadSha) {
    return true;
  }
  if (graphqlRequestedReviewerLogins) {
    return isCopilotPending(
      [...graphqlRequestedReviewerLogins],
      primaryBotLogin,
    );
  }
  return false;
}
/**
 * True when the OPTIONAL secondary advisory bot has already been requested for
 * the current HEAD — i.e. a `review_requested` event for `secondaryBotLogin`
 * follows the current HEAD's `committed` event in the PR timeline. This is the
 * once-per-HEAD guard for the non-gating secondary supplement (issue #1099),
 * reusing the same timeline evidence as {@link computeCopilotPendingCoversHead}
 * so no new marker is needed: when HEAD advances, the new `committed` event
 * sits after the prior secondary request and the guard resets to `false`.
 *
 * The secondary is matched by exact normalized login equality (NOT the Copilot
 * family). An empty `secondaryBotLogin` short-circuits to `false` so an
 * unconfigured secondary never matches anything.
 */
export function computeSecondaryRequestedForHead(
  timelineEvents,
  prHeadSha,
  secondaryBotLogin,
) {
  const configured = String(secondaryBotLogin ?? '')
    .trim()
    .toLowerCase();
  if (configured === '') {
    return false;
  }
  let headIndex = -1;
  let requestIndex = -1;
  timelineEvents.forEach((event, index) => {
    const eventName = String(event?.event ?? '');
    if (eventName === 'committed') {
      const sha = String(event?.sha ?? event?.commit_id ?? '');
      if (sha === prHeadSha) {
        headIndex = index;
      }
      return;
    }
    if (eventName === 'review_requested') {
      const reviewerLogin = String(event?.requested_reviewer?.login ?? '')
        .trim()
        .toLowerCase();
      if (reviewerLogin === configured) {
        requestIndex = index;
      }
    }
  });
  return headIndex !== -1 && requestIndex !== -1 && requestIndex > headIndex;
}
export function normalizeTrustedMarkerLogins(logins) {
  return [
    ...new Set(
      (logins ?? [])
        .map((login) =>
          String(login ?? '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ].sort();
}
/**
 * Resolve the trusted marker actors for a read-only evidence helper.
 *
 * Precedence is strict: an explicit `--trusted-marker-logins` flag wins over
 * the `IDD_TRUSTED_MARKER_ACTORS` env var, which wins over the
 * `trustedMarkerActors` array declared in `.github/idd/config.json`. The flag
 * and env var are CSV strings (or arrays); `config` is the parsed policy
 * object. The returned `source` records which input supplied the value so the
 * helper can emit it as auditable JSON evidence.
 */
export function resolveTrustedMarkerActors({
  flagValue = '',
  envValue = '',
  config = null,
} = {}) {
  const fromFlag = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(flagValue),
  );
  if (fromFlag.length > 0) {
    return { actors: fromFlag, source: 'flag' };
  }
  const fromEnv = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(envValue),
  );
  if (fromEnv.length > 0) {
    return { actors: fromEnv, source: 'env' };
  }
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(config?.trustedMarkerActors)
      ? config.trustedMarkerActors
      : [],
  );
  if (fromConfig.length > 0) {
    return { actors: fromConfig, source: 'config' };
  }
  return { actors: [], source: 'none' };
}
function trustedMarkerActorTokens(value) {
  return Array.isArray(value) ? value : String(value ?? '').split(',');
}
export function unionTrustedMarkerActorSources({
  envValue = '',
  config = null,
  extraActors = [],
  extraSource = '',
} = {}) {
  const sources = [];
  const actors = [];
  const extras = normalizeTrustedMarkerLogins(extraActors);
  if (extras.length > 0) {
    actors.push(...extras);
    if (extraSource) {
      sources.push(extraSource);
    }
  }
  const fromEnv = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(envValue),
  );
  if (fromEnv.length > 0) {
    actors.push(...fromEnv);
    sources.push('env');
  }
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(config?.trustedMarkerActors)
      ? config.trustedMarkerActors
      : [],
  );
  if (fromConfig.length > 0) {
    actors.push(...fromConfig);
    sources.push('config');
  }
  return { actors: normalizeTrustedMarkerLogins(actors), sources };
}
export function resolveAdvisoryBotLogins({
  flagValue = '',
  envValue = '',
  config = null,
} = {}) {
  const fromFlag = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(flagValue),
  );
  if (fromFlag.length > 0) {
    return { logins: fromFlag, source: 'flag' };
  }
  const fromEnv = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(envValue),
  );
  if (fromEnv.length > 0) {
    return { logins: fromEnv, source: 'env' };
  }
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(config?.advisoryBotLogins) ? config.advisoryBotLogins : [],
  );
  if (fromConfig.length > 0) {
    return { logins: fromConfig, source: 'config' };
  }
  return { logins: [], source: 'none' };
}
export function deriveIddAgentLogins({
  viewerLogin = '',
  iddAgentLogins = [],
  trustedMarkerLogins = [],
  operationalComments = [],
} = {}) {
  const trustedLogins = new Set(
    normalizeTrustedMarkerLogins(trustedMarkerLogins),
  );
  const derivedLogins = [viewerLogin, ...(iddAgentLogins ?? [])];
  for (const comment of operationalComments ?? []) {
    const authorLogin = String(
      comment?.author?.login ?? comment?.user?.login ?? '',
    )
      .trim()
      .toLowerCase();
    const body = String(comment?.body ?? '');
    const markerPrefix = operationalMarkerPrefix(body);
    if (
      !trustedLogins.has(authorLogin) ||
      !markerPrefix ||
      !IDD_AGENT_DERIVED_MARKERS.has(markerPrefix)
    ) {
      continue;
    }
    derivedLogins.push(authorLogin);
  }
  return normalizeTrustedMarkerLogins(derivedLogins);
}
export function summarizeAdvisoryWaitMarkers(
  comments,
  prHeadSha,
  trustedMarkerLogins,
) {
  const trustedLogins = new Set(
    normalizeTrustedMarkerLogins(trustedMarkerLogins),
  );
  let earliestSameHeadAt = '';
  let trustedSameHeadMarkerCount = 0;
  let trustedSameHeadRequestMarkerCount = 0;
  let trustedRequestMarkerCount = 0;
  let untrustedSameHeadMarkerCount = 0;
  let untrustedRequestMarkerCount = 0;
  for (const comment of comments) {
    const body = String(comment?.body ?? '').trimEnd();
    const login = String(comment?.author?.login ?? comment?.user?.login ?? '')
      .trim()
      .toLowerCase();
    const trusted = trustedLogins.has(login);
    const isSameHeadMarker = advisoryWaitMarkerMatchesHead(body, prHeadSha);
    const isRequestMarker = advisoryWaitRequestMarker(body);
    if (isSameHeadMarker) {
      if (trusted) {
        trustedSameHeadMarkerCount += 1;
        if (isRequestMarker) {
          trustedSameHeadRequestMarkerCount += 1;
        }
        const createdAt = String(
          comment?.createdAt ?? comment?.created_at ?? '',
        );
        if (
          isValidIsoTimestamp(createdAt) &&
          (!earliestSameHeadAt ||
            compareIsoTimestamps(createdAt, earliestSameHeadAt) < 0)
        ) {
          earliestSameHeadAt = createdAt;
        }
      } else {
        untrustedSameHeadMarkerCount += 1;
      }
    }
    if (isRequestMarker) {
      if (trusted) {
        trustedRequestMarkerCount += 1;
      } else {
        untrustedRequestMarkerCount += 1;
      }
    }
  }
  return {
    sameHeadMarkerPresent: trustedSameHeadMarkerCount > 0,
    sameHeadRequestMarkerPresent: trustedSameHeadRequestMarkerCount > 0,
    earliestSameHeadAt,
    sameHeadMarkerCount: trustedSameHeadMarkerCount,
    requestMarkerCount: trustedRequestMarkerCount,
    trustedSameHeadMarkerCount,
    untrustedSameHeadMarkerCount,
    trustedRequestMarkerCount,
    untrustedRequestMarkerCount,
  };
}
export function evaluateAdvisoryWaitOutcome(input) {
  const { requestCap, pendingWindowMinutes, settledWindowMinutes } =
    normalizeAdvisoryWaitRuntimeOptions(input);
  if (input.lastCopilotCommit === input.prHeadSha) {
    return 'SATISFIED';
  }
  if (input.copilotPending) {
    if (!input.sameHeadMarkerPresent) {
      return input.copilotPendingCoversHead
        ? 'RECOVERY_NEEDED'
        : input.requestMarkerCount >= requestCap
          ? 'CAP_EXHAUSTED'
          : 'REQUEST_NEEDED';
    }
    return input.elapsedMinutes >= pendingWindowMinutes ? 'SATISFIED' : 'WAIT';
  }
  if (!input.sameHeadMarkerPresent) {
    return input.requestMarkerCount >= requestCap
      ? 'CAP_EXHAUSTED'
      : 'REQUEST_NEEDED';
  }
  return input.elapsedMinutes >= settledWindowMinutes ? 'SATISFIED' : 'WAIT';
}
// F3 deliberately has a separate outcome from evaluateAdvisoryWaitOutcome:
// once Copilot is no longer pending (review submitted or cancelled), F3
// treats the advisory wait as SATISFIED so a settled-but-not-re-reviewed
// HEAD can merge, even while the shared `outcome` still routes E14/F2 to
// REQUEST_NEEDED. F3 reads f3Outcome exclusively when helper output is
// valid; see idd-advisory-wait.instructions.md §1 (F3-specific interpretation).
export function evaluateAdvisoryWaitF3Outcome(input) {
  if (input.lastCopilotCommit === input.prHeadSha || !input.copilotPending) {
    return 'SATISFIED';
  }
  return evaluateAdvisoryWaitOutcome(input);
}
export function buildAdvisoryWaitSummary(
  {
    prHeadSha,
    reviews = [],
    requestedReviewers = [],
    timelineEvents = [],
    comments = [],
    graphqlRequestedReviewerLogins = null,
  },
  options = {},
) {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  if (!/^[0-9a-f]{40}$/.test(String(prHeadSha ?? ''))) {
    throw new Error('prHeadSha must be a 40-character lowercase commit SHA');
  }
  const trustedMarkerLogins = normalizeTrustedMarkerLogins(
    options.trustedMarkerLogins ?? [],
  );
  const configuredTrustedActors = normalizeTrustedMarkerLogins(
    options.configuredTrustedActors ?? [],
  );
  const primaryBotLogin =
    String(options.primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const markerSummary = summarizeAdvisoryWaitMarkers(
    comments,
    prHeadSha,
    trustedMarkerLogins,
  );
  const elapsedMinutes = markerSummary.sameHeadMarkerPresent
    ? minutesBetweenIso(markerSummary.earliestSameHeadAt, now)
    : 0;
  const lastCopilotCommit = findLastCopilotReviewCommit(
    reviews,
    primaryBotLogin,
  );
  const copilotPendingCoversHead = computeCopilotPendingCoversHead(
    timelineEvents,
    prHeadSha,
    primaryBotLogin,
  );
  const copilotPending = resolveCopilotPending(
    requestedReviewers,
    copilotPendingCoversHead,
    lastCopilotCommit,
    prHeadSha,
    graphqlRequestedReviewerLogins,
    primaryBotLogin,
  );
  const {
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
    pollIntervalMinutes,
    capExhaustedRoute,
  } = normalizeAdvisoryWaitRuntimeOptions(options);
  const outcomeInput = {
    lastCopilotCommit,
    prHeadSha,
    copilotPending,
    copilotPendingCoversHead,
    sameHeadMarkerPresent: markerSummary.sameHeadMarkerPresent,
    requestMarkerCount: markerSummary.requestMarkerCount,
    elapsedMinutes,
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
  };
  const outcome = evaluateAdvisoryWaitOutcome(outcomeInput);
  const f3Outcome = evaluateAdvisoryWaitF3Outcome(outcomeInput);
  // Optional NON-GATING secondary advisory bot (issue #1099). Resolved AFTER
  // `outcome` and never fed into `outcomeInput`, so it can never satisfy or
  // alter the primary advisory-wait gate (contract a). A secondary equal to the
  // primary is treated as unconfigured (misconfiguration guard).
  const secondaryBotLogin = String(options.secondaryBotLogin ?? '')
    .trim()
    .toLowerCase();
  const secondaryConfigured =
    secondaryBotLogin !== '' && secondaryBotLogin !== primaryBotLogin;
  // Once per HEAD, read from the GitHub timeline (a `review_requested` for the
  // secondary after the current HEAD's `committed` event) — no marker is posted
  // for the secondary, so it never receives a primary `advisory-wait` marker
  // and never burns the primary cap (contract b).
  const secondaryAlreadyRequested =
    secondaryConfigured &&
    computeSecondaryRequestedForHead(
      timelineEvents,
      prHeadSha,
      secondaryBotLogin,
    );
  // Request the secondary once per HEAD only when a follow-up pass is genuinely
  // needed (the primary has not reviewed HEAD) AND the primary is
  // cap-exhausted, or stalled/rate-limited (the wait was closed by the elapsed
  // settle/pending window rather than by a HEAD review). REQUEST_NEEDED (primary
  // still requestable), WAIT (still in-window), and RECOVERY_NEEDED (active
  // recovery) deliberately do not trigger the supplement.
  const secondaryRequestNeeded =
    secondaryConfigured &&
    !secondaryAlreadyRequested &&
    lastCopilotCommit !== prHeadSha &&
    (outcome === 'CAP_EXHAUSTED' ||
      (outcome === 'SATISFIED' && markerSummary.sameHeadMarkerPresent));
  return {
    protocolVersion: '1',
    prHeadSha,
    lastCopilotCommit,
    copilotPending,
    copilotPendingCoversHead,
    outcome,
    f3Outcome,
    secondaryBotLogin: secondaryConfigured ? secondaryBotLogin : '',
    secondaryRequestNeeded,
    now,
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
    pollIntervalMinutes,
    capExhaustedRoute,
    elapsedMinutes,
    sameHeadMarkerPresent: markerSummary.sameHeadMarkerPresent,
    sameHeadRequestMarkerPresent: markerSummary.sameHeadRequestMarkerPresent,
    earliestSameHeadAt: markerSummary.earliestSameHeadAt,
    sameHeadMarkerCount: markerSummary.sameHeadMarkerCount,
    requestMarkerCount: markerSummary.requestMarkerCount,
    trustedMarkerSummary: {
      viewerLogin: String(options.viewerLogin ?? '')
        .trim()
        .toLowerCase(),
      configuredTrustedActors,
      collaboratorTrustEnabled: Boolean(options.collaboratorTrustEnabled),
      trustedMarkerLogins,
      trustedSameHeadMarkerCount: markerSummary.trustedSameHeadMarkerCount,
      untrustedSameHeadMarkerCount: markerSummary.untrustedSameHeadMarkerCount,
      trustedRequestMarkerCount: markerSummary.trustedRequestMarkerCount,
      untrustedRequestMarkerCount: markerSummary.untrustedRequestMarkerCount,
    },
  };
}
export function buildActivitySnapshotSummary(
  { comments = [], reviews = [], threads = [], checks = [] },
  options = {},
) {
  const trustedMarkerLogins = new Set(
    (options.trustedMarkerLogins ?? [])
      .map((login) =>
        String(login ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const dispositionAuthorLogins = new Set(
    normalizeTrustedMarkerLogins(options.dispositionAuthorLogins ?? []),
  );
  // An advisory bot can never anchor "dispositions exist": its own
  // **Accepted**/**Rejected**-shaped replies must not start the
  // post-disposition window that classifies its later acks. Excludes via
  // `isConfiguredAdvisoryBotLogin`, not a plain `Set.has`/`.delete`, so a
  // `[bot]`-suffix mismatch between `dispositionAuthorLogins` and
  // `advisoryBotLogins` (e.g. one storing GitHub's suffixed `dual-bot[bot]`
  // author-login form, the other the supported suffixless `dual-bot` form,
  // #2014) still excludes the shared login -- the same normalized identity
  // every other advisory-bot recognition in this file already uses.
  for (const login of [...dispositionAuthorLogins]) {
    if (isConfiguredAdvisoryBotLogin(login, advisoryBotLogins)) {
      dispositionAuthorLogins.delete(login);
    }
  }
  const isAdvisoryBot = (login) =>
    isConfiguredAdvisoryBotLogin(login, advisoryBotLogins);
  const isDispositionAuthor = (login) =>
    dispositionAuthorLogins.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
  // #2014: `isDispositionComment` alone (the `**Accepted**`/`**Rejected**`
  // prefixes) misses the terminal `**Rejection confirmed by maintainer**`
  // marker (`isRejectionConfirmedDisposition`) that E6
  // (idd-review-triage.instructions.md) posts instead of a fresh
  // `**Rejected**` re-post once a maintainer agrees an
  // `**Awaiting maintainer decision**` item needs no action -- a disposition
  // is a disposition regardless of which of the two terminal shapes it took.
  // `classifyThreadAckOnlyPostDisposition` already recognizes both, but ONLY
  // as a reply on a resolved review thread
  // (the marker's own contract, `isRejectionConfirmedDisposition`'s doc
  // comment above). `filteredComments` below are plain top-level PR
  // comments with no thread/resolved concept at all, so they must keep
  // using plain `isDispositionComment` -- recognizing the terminal marker
  // there would accept it as a disposition anchor with no resolved-thread
  // context to validate it against (Copilot review, #2014 PR #2029).
  // Thread-scoped variant: recognizes the terminal rejection-confirmed
  // marker only while its own thread is still resolved, mirroring
  // `hasFreshDisposition`'s identical `threadResolved` gate above -- once a
  // thread is reopened, the marker's "nothing more to do here" claim is
  // stale for that thread. Needed specifically for the cross-thread global
  // scan below (`dispositionCreatedAts`'s `threads.flatMap`), which pools
  // every thread's replies into one PR-wide anchor: without this gate, a
  // stale rejection-confirmed reply on a since-reopened thread could still
  // anchor the window that misclassifies an unrelated, brand-new
  // advisory-bot comment elsewhere on the PR as ack-only. This is the ONLY
  // place the combined (`isDispositionComment` OR
  // `isRejectionConfirmedDisposition`) recognition applies outside a
  // thread whose `isResolved` is already independently confirmed true.
  const isDispositionMarkerComment = (comment) =>
    isDispositionComment(comment) || isRejectionConfirmedDisposition(comment);
  const isDispositionMarkerCommentForThread = (comment, threadResolved) =>
    isDispositionComment(comment) ||
    (threadResolved && isRejectionConfirmedDisposition(comment));
  const filteredComments = comments.filter((comment) => {
    if (!trustedMarkerLogins.has((comment.author?.login ?? '').toLowerCase())) {
      return true;
    }
    return operationalMarkerPrefixByStart(comment.body ?? '') === null;
  });
  // Structural ack-only evidence (#858): the posting moment of the latest
  // disposition by a configured disposition author opens the window;
  // comments and resolved-thread replies are classified per item below.
  // Dispositions are not SHA-bound here — the head-changed check in
  // diffReviewSnapshot plus the unchanged disposition-evidence and
  // unreplied-comment gates backstop that residual.
  const dispositionCreatedAts = [
    ...filteredComments
      .filter(
        (comment) =>
          isDispositionAuthor(comment.author?.login) &&
          isDispositionComment(comment),
      )
      .map((comment) => comment.createdAt),
    ...threads.flatMap((thread) =>
      (thread.comments?.nodes ?? [])
        .filter(
          (comment) =>
            isDispositionAuthor(comment.author?.login) &&
            isDispositionMarkerCommentForThread(
              comment,
              Boolean(thread.isResolved),
            ),
        )
        .map((comment) =>
          // An edited **Rejection confirmed by maintainer** marker anchors by
          // its effective (updatedAt-preferring) activity, matching
          // classifyThreadAckOnlyPostDisposition's choice for the same
          // marker (#2045); ordinary Accepted/Rejected markers keep the
          // pre-existing createdAt anchor.
          isRejectionConfirmedDisposition(comment)
            ? effectiveThreadCommentActivityAt(comment)
            : comment.createdAt,
        ),
    ),
  ].filter(isValidIsoTimestamp);
  const latestDispositionAt = maxIsoTimestamp(dispositionCreatedAts) ?? null;
  const isAckOnlyComment = (comment) => {
    if (!latestDispositionAt) {
      return false;
    }
    if (!isAdvisoryBot(comment.author?.login)) {
      return false;
    }
    if (isDispositionComment(comment)) {
      return false;
    }
    const activityAt = comment.updatedAt ?? comment.createdAt;
    if (!isValidIsoTimestamp(activityAt)) {
      return false;
    }
    return compareIsoTimestamps(activityAt, latestDispositionAt) > 0;
  };
  const ackOnlyComments = filteredComments.filter(isAckOnlyComment);
  const ackOnlyCommentSet = new Set(ackOnlyComments);
  // On a resolved thread whose latest reply chain contains a disposition,
  // later advisory-bot replies are structurally ack-only; the effective
  // thread activity is recomputed from the remaining replies. Reopened
  // (unresolved) threads always keep their raw activity.
  const threadEffective = threads.map((thread) => {
    const nodes = thread.comments?.nodes ?? [];
    const threadDispositionAt =
      maxIsoTimestamp(
        nodes
          .filter(
            (comment) =>
              isDispositionAuthor(comment.author?.login) &&
              isDispositionMarkerCommentForThread(
                comment,
                Boolean(thread.isResolved),
              ),
          )
          .map((comment) =>
            isRejectionConfirmedDisposition(comment)
              ? effectiveThreadCommentActivityAt(comment)
              : comment.createdAt,
          )
          .filter(isValidIsoTimestamp),
      ) ?? null;
    // Per-reply attribution needs the reply timeline: when a caller
    // populates thread.updatedAt we cannot tell whether it reflects an
    // ack or substantive activity, so fail closed and keep raw activity
    // (production normalizers blank thread.updatedAt to opt in).
    if (
      !thread.isResolved ||
      !threadDispositionAt ||
      isValidIsoTimestamp(thread.updatedAt ?? '')
    ) {
      return { activityAt: threadActivityAt(thread), ackReplies: [] };
    }
    const ackReplies = nodes.filter((comment) => {
      if (!isAdvisoryBot(comment.author?.login)) {
        return false;
      }
      if (isDispositionMarkerComment(comment)) {
        return false;
      }
      const activityAt = effectiveThreadCommentActivityAt(comment);
      return (
        isValidIsoTimestamp(activityAt) &&
        compareIsoTimestamps(activityAt, threadDispositionAt) > 0
      );
    });
    if (ackReplies.length === 0) {
      return { activityAt: threadActivityAt(thread), ackReplies: [] };
    }
    const ackReplySet = new Set(ackReplies);
    const keptActivities = nodes
      .filter((comment) => !ackReplySet.has(comment))
      .flatMap((comment) => [comment.updatedAt, comment.createdAt])
      .filter(isValidIsoTimestamp);
    return { activityAt: maxIsoTimestamp(keptActivities), ackReplies };
  });
  const ackOnlyThreadReplies = threadEffective.flatMap(
    (entry) => entry.ackReplies,
  );
  const commentActivities = filteredComments
    .map((comment) => comment.updatedAt ?? comment.createdAt)
    .filter(isValidIsoTimestamp);
  const reviewActivities = reviews
    .map((review) => review.updatedAt ?? review.submittedAt ?? review.createdAt)
    .filter(isValidIsoTimestamp);
  const threadActivities = threads
    .map((thread) => threadActivityAt(thread))
    .filter(isValidIsoTimestamp);
  const latestCiCompletedAt =
    maxIsoTimestamp(
      checks.map((check) => check.completedAt).filter(isCompletedCiTimestamp),
    ) ?? 'none';
  const latestPassingCiCompletedAt =
    maxIsoTimestamp(
      checks
        .filter((check) => {
          const state = String(check.state ?? '').toUpperCase();
          return ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'NOT_APPLICABLE'].includes(
            state,
          );
        })
        .map((check) => check.completedAt)
        .filter(isCompletedCiTimestamp),
    ) ?? 'none';
  const maxActivityUpdatedAt =
    maxIsoTimestamp([
      ...commentActivities,
      ...reviewActivities,
      ...threadActivities,
    ]) ?? 'none';
  const effectiveCommentActivities = filteredComments
    .filter((comment) => !ackOnlyCommentSet.has(comment))
    .map((comment) => comment.updatedAt ?? comment.createdAt)
    .filter(isValidIsoTimestamp);
  const effectiveThreadActivities = threadEffective
    .map((entry) => entry.activityAt)
    .filter(isValidIsoTimestamp);
  const effectiveMaxActivityUpdatedAt =
    maxIsoTimestamp([
      ...effectiveCommentActivities,
      ...reviewActivities,
      ...effectiveThreadActivities,
    ]) ?? 'none';
  const describeAckItem = (kind, comment, activityAt) => ({
    kind,
    id: String(comment.id ?? ''),
    author: String(comment.author?.login ?? '')
      .trim()
      .toLowerCase(),
    activityAt: isValidIsoTimestamp(activityAt) ? activityAt : 'none',
    bodyPreview: String(comment.body ?? '').slice(0, 120),
  });
  return {
    totalItemCount: filteredComments.length + reviews.length + threads.length,
    maxActivityUpdatedAt,
    latestCiCompletedAt,
    latestPassingCiCompletedAt,
    counts: {
      comments: filteredComments.length,
      reviews: reviews.length,
      threads: threads.length,
    },
    ackOnly: {
      advisoryBotLogins: [...advisoryBotLogins].sort(),
      source: String(options.advisoryBotLoginsSource ?? 'none'),
      dispositionsPresent: Boolean(latestDispositionAt),
      latestDispositionAt: latestDispositionAt ?? 'none',
      items: [
        ...ackOnlyComments.map((comment) =>
          describeAckItem(
            'comment',
            comment,
            comment.updatedAt ?? comment.createdAt,
          ),
        ),
        ...ackOnlyThreadReplies.map((comment) =>
          describeAckItem(
            'thread-reply',
            comment,
            effectiveThreadCommentActivityAt(comment),
          ),
        ),
      ],
    },
    effective: {
      maxActivityUpdatedAt: effectiveMaxActivityUpdatedAt,
      totalItemCount:
        filteredComments.length -
        ackOnlyComments.length +
        reviews.length +
        threads.length,
    },
  };
}
export function resolveLatestReviewWatermark(comments, options = {}) {
  const expectedClaimId = String(options.expectedClaimId ?? '').trim();
  const isTrustedAuthor = options.isTrustedAuthor ?? (() => true);
  let latest = null;
  for (const comment of comments) {
    if (!isTrustedAuthor(comment.author?.login ?? comment.user?.login ?? '')) {
      continue;
    }
    const parsed = parseReviewWatermarkComment(
      comment.body ?? '',
      comment.createdAt ?? comment.created_at ?? '',
    );
    if (!parsed) {
      continue;
    }
    // Exact claim-id match is intentional (#2080): a watermark records
    // what THIS claim-holder verified. A takeover starts a new restore
    // scope (`idd-review-snapshot.instructions.md`); do not treat the
    // predecessor `supersedes` id as a match the way
    // `summarizeExternalCheckWaivers` does for maintainer waivers.
    if (expectedClaimId && parsed.claimId !== expectedClaimId) {
      continue;
    }
    const parsedCreatedAt = normalizeComparableTimestamp(parsed.createdAt);
    if (parsedCreatedAt === null || parsedCreatedAt === 'none') {
      continue;
    }
    const latestCreatedAt = normalizeComparableTimestamp(
      latest?.createdAt ?? 'none',
    );
    if (
      latestCreatedAt === null ||
      latestCreatedAt === 'none' ||
      parsedCreatedAt > latestCreatedAt
    ) {
      latest = parsed;
    }
  }
  return latest;
}
/**
 * Scans the same trusted-author comment stream `resolveLatestReviewWatermark`
 * consumes for a `review-watermark`/`review-baseline`-shaped comment whose
 * body fails the strict canonical `pattern` (e.g. a hand-authored note glued
 * directly to the leading underscore, `_IDD ...` with no space, missing
 * `OPTIONAL_IDD_VISIBLE_NOTE_PATTERN`'s `\bIDD\b` boundary). Such a comment
 * already reads as absent to `resolveLatestReviewWatermark` (#2251) -- this
 * gives the F2 caller a way to tell "malformed marker found" apart from
 * "no watermark-shaped comment at all" without changing
 * `resolveLatestReviewWatermark`'s own return shape or selection behavior.
 *
 * `options.expectedClaimId`, when set, restricts the scan to a malformed
 * comment whose own claim-id token (the second token after the marker
 * label -- both `review-watermark` and `review-baseline` share that
 * position) matches, mirroring `resolveLatestReviewWatermark`'s own
 * exact claim-id filtering (#2080). Without this, a different claim's
 * malformed marker would flip `comparisonReason` to `'malformed-watermark'`
 * for a claim whose watermark is simply, genuinely absent (#2251 review
 * follow-up on PR #2387). The claim-id token is pulled directly from the
 * raw body (not via the full canonical parser, since a malformed comment
 * by definition fails that parse) -- both marker shapes' `malformedPrefixPattern`
 * guarantee `\S+\s+\S+` (agent, then claim id) immediately after the label.
 */
const MALFORMED_REVIEW_WATERMARK_CLAIM_ID_RE =
  /^<!--\s*(?:review-watermark|review-baseline):\s+\S+\s+(\S+)/i;
export function detectMalformedReviewWatermarkComments(comments, options = {}) {
  const isTrustedAuthor = options.isTrustedAuthor ?? (() => true);
  const expectedClaimId = String(options.expectedClaimId ?? '').trim();
  return comments.some((comment) => {
    if (!isTrustedAuthor(comment.author?.login ?? comment.user?.login ?? '')) {
      return false;
    }
    const body = comment.body ?? '';
    const label = detectMalformedOperationalMarker(body);
    if (
      label !== '<!-- review-watermark:' &&
      label !== '<!-- review-baseline:'
    ) {
      return false;
    }
    if (!expectedClaimId) {
      return true;
    }
    // No trimStart: detectMalformedOperationalMarker already matched this
    // body's raw (untrimmed) bytes against the label's `^`-anchored
    // malformedPrefixPattern by this point (no leading-whitespace
    // tolerance, by design -- see that pattern's anti-spoofing note), so
    // matching raw `body` here stays consistent with that same anchor.
    const claimId = body.match(MALFORMED_REVIEW_WATERMARK_CLAIM_ID_RE)?.[1];
    return claimId === expectedClaimId;
  });
}
// Pre-merge gate invariant (unreplied regular comments -> `unrepliedComments`):
// does NOT feed `computePreMergeReadinessBlockers` (no code-rollup blocker), but
// it is NOT harmless -- the written F2 gate "Unreplied comments = 0" in
// `idd-pre-merge.instructions.md` routes any non-IDD regular comment without a
// later IDD reply back to review triage. So globally promoting a non-agent into
// `iddAgentLogins` filters that actor's genuine unreplied feedback out of the F2
// gate (fail-OPEN at the process level; its comments are excluded and its reply
// advances the watermark), while missing a real agent over-counts. See the
// consolidated invariants above `summarizeDispositionEvidenceForGate`
// (#1182 / PR #1184).
export function summarizeRegularCommentsForGate(comments, options = {}) {
  const iddAgentLogins = new Set(
    normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []),
  );
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const threads = Array.isArray(options.threads) ? options.threads : [];
  const normalized = comments
    .map((comment, inputIndex) => ({
      id: String(comment.id ?? ''),
      authorLogin: String(comment.author?.login ?? comment.user?.login ?? '')
        .trim()
        .toLowerCase(),
      body: String(comment.body ?? ''),
      createdAt: String(comment.createdAt ?? comment.created_at ?? ''),
      updatedAt: String(comment.updatedAt ?? comment.updated_at ?? ''),
      inputIndex,
    }))
    .filter((comment) => isValidIsoTimestamp(comment.createdAt))
    .map((comment) => ({
      ...comment,
      activityAt: effectiveRegularCommentActivityAt(comment),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.activityAt);
      const rightTime = Date.parse(right.activityAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.inputIndex - right.inputIndex;
    })
    .map((comment, sortedIndex) => ({ ...comment, sortedIndex }));
  const lastIddReplyAt = normalized.reduce((latestTimestamp, comment) => {
    if (
      isOperationalOrDigestCommentForGate(
        comment.body,
        comment.authorLogin,
        trustedMarkerLogins,
      ) ||
      !iddAgentLogins.has(comment.authorLogin)
    ) {
      return latestTimestamp;
    }
    if (
      !latestTimestamp ||
      compareIsoTimestamps(comment.createdAt, latestTimestamp) > 0
    ) {
      return comment.createdAt;
    }
    return latestTimestamp;
  }, '');
  const classificationComments = normalized.map((comment) => ({
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
  }));
  // #1182 A trusted-marker actor's machine-generated advisory disposition — and
  // the advisory-bot sticky it names, matched by bot + type + consumed 1:1 via
  // `matchTrustedAdvisoryStickyDispositions` — is not an unreplied comment.
  // Recognized per item, NOT by promoting the author to a global IDD agent (which
  // would fail the thread gate open) and NOT by advancing the `lastIddReplyAt`
  // watermark (which would clear unrelated earlier feedback). Keyed on the two
  // machine forms only, so a trusted human's ordinary `**Accepted**` /
  // `**Rejected**` review disposition stays a genuine comment.
  const isTrustedMachineDisposition = (authorLogin, body) =>
    trustedMarkerLogins.has(authorLogin) &&
    (isNonReviewNoticeDisposition({ body }) ||
      isReviewSummaryDisposition({ body }));
  const dispositionedStickyIndexes = matchTrustedAdvisoryStickyDispositions(
    normalized,
    advisoryBotLogins,
    trustedMarkerLogins,
    iddAgentLogins,
  );
  const items = normalized
    .filter(
      (comment) =>
        !isOperationalOrDigestCommentForGate(
          comment.body,
          comment.authorLogin,
          trustedMarkerLogins,
        ),
    )
    .filter((comment) => !iddAgentLogins.has(comment.authorLogin))
    .filter(
      (comment) =>
        !isTrustedMachineDisposition(comment.authorLogin, comment.body) &&
        !dispositionedStickyIndexes.has(comment.sortedIndex),
    )
    .filter(
      (comment) =>
        !lastIddReplyAt ||
        compareIsoTimestamps(lastIddReplyAt, comment.activityAt) <= 0,
    )
    .filter((comment) => {
      if (!isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins)) {
        return true;
      }
      return (
        classifyRegularBotComment(
          {
            author: { login: comment.authorLogin },
            body: comment.body,
            createdAt: comment.createdAt,
          },
          classificationComments,
          threads,
          {
            isDispositionAuthor: (login) =>
              iddAgentLogins.has(
                String(login ?? '')
                  .trim()
                  .toLowerCase(),
              ),
          },
        ) === null
      );
    })
    .map((comment) => ({
      id: comment.id,
      authorLogin: comment.authorLogin,
      createdAt: comment.createdAt,
      bodyPreview: buildBodyPreview(comment.body),
    }));
  return {
    count: items.length,
    items,
  };
}
// Pre-merge gate invariants -- READ BEFORE MODIFYING ANY `iddAgentLogins`-KEYED
// GATE HELPER. Three functions key disposition, reply, and thread-author
// recognition on `iddAgentLogins`, and each reacts DIFFERENTLY when that
// recognition is wrong:
//   1. `summarizeDispositionEvidenceForGate` (this fn) -- MERGE-BLOCKING (feeds
//      `computePreMergeReadinessBlockers` via `dispositionEvidence`). Both
//      recognition-error directions matter: FAILING to recognize a real agent
//      leaves its own disposition/reply in the outstanding set -> over-block
//      (fail-closed); GLOBALLY promoting a non-agent instead drops that actor's
//      genuine outstanding feedback (this fn excludes `iddAgentLogins` authors
//      from `outstandingComments`), so `blockingCount` can fall to 0 ->
//      fail-OPEN.
//   2. `summarizeReviewThreadsForGate` (`actionableCount`) -- MERGE-BLOCKING.
//      Without required conversation resolution, an IDD agent's latest thread
//      comment is `awaiting-reviewer` (non-blocking), so GLOBALLY promoting a
//      non-agent into `iddAgentLogins` makes that actor's genuine unresolved
//      feedback stop blocking -> fail-OPEN. This gate keys on latest-author
//      identity, not disposition recognition.
//   3. `summarizeRegularCommentsForGate` (`unrepliedComments`) -- does NOT feed
//      `computePreMergeReadinessBlockers`, but the written F2 gate "Unreplied
//      comments = 0" (`idd-pre-merge.instructions.md`) still consumes it, so
//      promoting a non-agent filters that actor's unreplied feedback out of
//      that gate -> fail-OPEN at the process level (not harmless).
// Across all three: never globally promote a non-agent into `iddAgentLogins` --
// recognize each item by its own author.
// Notice vs summary matching asymmetry (implemented and documented in detail on
// `matchTrustedAdvisoryStickyDispositions`): a non-review NOTICE disposition
// matches time-agnostically -- it carries forward across a re-posted notice
// while the bot still has not reviewed (the #1018 carry-forward) -- while a
// SUMMARY disposition must be STRICTLY NEWER than the sticky, so a stale
// `**Accepted**` cannot clear a summary re-edited after it (the #1122 "a false
// positive is a false merge" hazard).
// Working rule: verify every advisory finding on this code with a byte-exact
// repro before accepting it. #1182 / PR #1184 cycled through five advisory
// rounds, each surfacing a distinct fail mode of exactly these gates.
function isAdvisoryAuthoredThread(thread, advisoryBotLogins) {
  const originating = (thread.comments?.nodes ?? [])[0];
  return (
    isCopilotReviewerLogin(originating?.author?.login) ||
    isGateAdvisoryBotLogin(originating?.author?.login, advisoryBotLogins)
  );
}
function isIddOriginatedThreadReply(comment, options) {
  const body = String(comment.body ?? '');
  if (isIddOriginatedReply(body, options.markerPrefix)) {
    return true;
  }
  const authorLogin = String(comment.author?.login ?? '')
    .trim()
    .toLowerCase();
  if (
    !authorLogin ||
    !(
      options.iddAgentLogins.has(authorLogin) ||
      options.trustedMarkerLogins.has(authorLogin)
    )
  ) {
    return false;
  }
  return (
    isDispositionComment({ body }) || isRejectionConfirmedDisposition({ body })
  );
}
// #978 advisory-only diagnostic, extracted from `summarizeDispositionEvidenceForGate`
// (#2618) so both the F2/F3 merge gate and F4's `audit-pr-cleanup` disposition
// checks share one implementation. A blocking resolved thread is
// "ack-only-post-disposition" when a thread-local IDD disposition exists and
// EVERY external comment newer than the disposition (and, when
// `snapshotBoundaryAt` is supplied, also newer than that boundary) is an
// advisory-bot, non-disposition courtesy ack. `snapshotBoundaryAt` is
// optional: F2/F3 passes the review-snapshot watermark so only feedback that
// re-blocks the gate counts; F4 has no such watermark and omits it, so every
// post-disposition external comment counts. Fails closed (false) without a
// thread-local disposition or for an unresolved thread, and never changes
// any caller's route by itself.
//
// #1313: also computes the narrower `inPlaceEditOnly` sibling signal in the
// same pass (it needs the identical `threadDispositionAt` /
// `postDispositionBlockingFeedback` groundwork, so folding it into one
// function avoids recomputing that twice). `inPlaceEditOnly` additionally
// requires every qualifying comment to be an in-place edit of content that
// already existed at-or-before the disposition (its own `createdAt` is not
// newer than the disposition, and its `updatedAt` is strictly newer than its
// own `createdAt`) rather than a brand-new post-disposition comment.
// Deliberately advisory-only, like its sibling: GitHub's API exposes no
// revision diff for an edited comment, so this helper cannot tell a
// cosmetic append from a substantive change to the finding.
export function classifyThreadAckOnlyPostDisposition(thread, options = {}) {
  const none = { ackOnlyPostDisposition: false, inPlaceEditOnly: false };
  if (!thread.isResolved) {
    return none;
  }
  const snapshotBoundaryAt = isValidIsoTimestamp(options.snapshotBoundaryAt)
    ? String(options.snapshotBoundaryAt)
    : null;
  const iddAgentLogins = new Set(
    normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []),
  );
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  // #2014: an advisory bot can never anchor "a disposition exists" -- see
  // `summarizeDispositionEvidenceForGate`'s identical subtraction (this
  // file, "An advisory bot can never anchor..."). Scoped to only this
  // anchor set; the raw `iddAgentLogins` set above stays unchanged
  // everywhere else, since each caller reacts differently (fail-open vs.
  // fail-closed) to a global change.
  const ackAnchorAuthorLogins = new Set(
    [...iddAgentLogins].filter(
      (login) => !isConfiguredAdvisoryBotLogin(login, advisoryBotLogins),
    ),
  );
  const nodes = thread.comments?.nodes ?? [];
  // Recognize the same dispositions `hasFreshDisposition` accepts on a
  // resolved thread (the gate that already decided this thread blocks): a
  // `**Accepted**`/`**Rejected**` marker OR the terminal
  // `**Rejection confirmed by maintainer**` marker, anchored by effective
  // activity (`updatedAt`-preferring) so an edited disposition is dated
  // consistently. The thread is already known resolved here.
  const threadDispositionAt = maxIsoTimestamp(
    nodes
      .filter(
        (comment) =>
          ackAnchorAuthorLogins.has(
            String(comment.author?.login ?? '')
              .trim()
              .toLowerCase(),
          ) &&
          (isDispositionComment({ body: String(comment.body ?? '') }) ||
            isRejectionConfirmedDisposition({
              body: String(comment.body ?? ''),
            })),
      )
      .map((comment) => effectiveThreadCommentActivityAt(comment))
      .filter(isValidIsoTimestamp),
  );
  if (!threadDispositionAt) {
    return none;
  }
  // The blocking activity is external feedback newer than the thread
  // disposition (so already-dispositioned feedback predating the ack does
  // not disqualify the signal) and, when a snapshot boundary is supplied,
  // also newer than it (so it actually re-blocks that gate). Without a
  // boundary, every post-disposition external comment counts.
  const postDispositionBlockingFeedback = nodes.filter((comment) => {
    const authorLogin = String(comment.author?.login ?? '')
      .trim()
      .toLowerCase();
    if (
      !authorLogin ||
      iddAgentLogins.has(authorLogin) ||
      authorLogin === prAuthorLogin
    ) {
      return false;
    }
    const activityAt = effectiveThreadCommentActivityAt(comment);
    return (
      isValidIsoTimestamp(activityAt) &&
      (!snapshotBoundaryAt ||
        compareIsoTimestamps(activityAt, snapshotBoundaryAt) > 0) &&
      compareIsoTimestamps(activityAt, threadDispositionAt) > 0
    );
  });
  if (postDispositionBlockingFeedback.length === 0) {
    return none;
  }
  // Each remaining item must be a pure advisory-bot courtesy ack: an
  // advisory-bot author whose body is neither a `**Accepted**`/`**Rejected**`
  // marker nor the terminal `**Rejection confirmed by maintainer**` marker,
  // AND (#2641) matches a known courtesy-acknowledgment template -- author +
  // shape alone no longer suffice, since a novel substantive comment that
  // merely doesn't use disposition phrasing must not misclassify as ack-only.
  const ackOnlyPostDisposition = postDispositionBlockingFeedback.every(
    (comment) =>
      isConfiguredAdvisoryBotLogin(comment.author?.login, advisoryBotLogins) &&
      !isDispositionComment({ body: String(comment.body ?? '') }) &&
      !isRejectionConfirmedDisposition({ body: String(comment.body ?? '') }) &&
      isKnownAdvisoryAckTemplate(comment),
  );
  if (!ackOnlyPostDisposition) {
    return none;
  }
  const inPlaceEditOnly = postDispositionBlockingFeedback.every((comment) => {
    const createdAt = String(comment.createdAt ?? '');
    const updatedAt = String(comment.updatedAt ?? '');
    return (
      isValidIsoTimestamp(createdAt) &&
      compareIsoTimestamps(createdAt, threadDispositionAt) <= 0 &&
      isValidIsoTimestamp(updatedAt) &&
      compareIsoTimestamps(updatedAt, createdAt) > 0
    );
  });
  return { ackOnlyPostDisposition, inPlaceEditOnly };
}
export function summarizeDispositionEvidenceForGate(
  { comments = [], threads = [] },
  options = {},
) {
  const iddAgentLogins = new Set(
    normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []),
  );
  // The review-snapshot boundary (the active watermark's
  // max-activity-updatedAt). A resolved thread whose newest external feedback
  // predates it was settled before the snapshot and is out of E7 scope.
  const snapshotBoundaryAt = isValidIsoTimestamp(options.snapshotBoundaryAt)
    ? String(options.snapshotBoundaryAt)
    : null;
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  const explicitMarkerPrefix =
    typeof options.markerPrefix === 'string' ? options.markerPrefix.trim() : '';
  const configuredMarkerPrefix = String(
    loadIddConfig()?.markerPrefix ?? '',
  ).trim();
  const markerPrefix =
    explicitMarkerPrefix || configuredMarkerPrefix || undefined;
  const normalizedComments = comments
    .map((comment, inputIndex) => ({
      id: String(comment.id ?? ''),
      authorLogin: String(comment.author?.login ?? comment.user?.login ?? '')
        .trim()
        .toLowerCase(),
      body: String(comment.body ?? ''),
      createdAt: String(comment.createdAt ?? comment.created_at ?? ''),
      updatedAt: String(comment.updatedAt ?? comment.updated_at ?? ''),
      inputIndex,
    }))
    .filter((comment) => isValidIsoTimestamp(comment.createdAt))
    .map((comment) => ({
      ...comment,
      activityAt: effectiveRegularCommentActivityAt(comment),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.activityAt);
      const rightTime = Date.parse(right.activityAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.inputIndex - right.inputIndex;
    })
    .map((comment, sortedIndex) => ({ ...comment, sortedIndex }));
  const classificationComments = normalizedComments.map((comment) => ({
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
  }));
  // #1182 trusted machine-disposition recognition, scoped to this gate. A
  // trusted-marker actor who authored one of the two machine-generated advisory
  // disposition forms `disposition-non-review-notices` emits — `**Rejected** —
  // {bot} did not review HEAD …` (`isNonReviewNoticeDisposition`) or
  // `**Accepted** — {bot} summary walkthrough …` (`isReviewSummaryDisposition`)
  // — must have that disposition honored even when the author was not resolved
  // into `iddAgentLogins` (e.g. a second trusted session posted it). It is
  // deliberately NOT promoted into a global IDD-agent identity: that same set is
  // passed to `summarizeReviewThreadsForGate`, where an IDD-agent's latest
  // thread comment is `awaiting-reviewer` rather than `actionable-blocking`, so
  // a global promotion would let the actor's genuine unresolved review feedback
  // stop blocking. Recognition stays HERE and covers ONLY the two machine forms
  // — never the general `**Accepted**` / `**Rejected**` prefix — so a trusted
  // human's ordinary review disposition is not swallowed. The disposition itself
  // is dropped from the outstanding set (below); the advisory sticky it clears is
  // matched by bot + type + 1:1 and bound to that item by
  // `matchTrustedAdvisoryStickyDispositions` — never joining the generic 1:1
  // pool, so a trusted disposition whose sticky is absent/already-resolved cannot
  // clear an unrelated human comment.
  const isTrustedMachineDisposition = (authorLogin, body) =>
    trustedMarkerLogins.has(authorLogin) &&
    (isNonReviewNoticeDisposition({ body }) ||
      isReviewSummaryDisposition({ body }));
  const trustedDispositionedStickyIndexes =
    matchTrustedAdvisoryStickyDispositions(
      normalizedComments,
      advisoryBotLogins,
      trustedMarkerLogins,
      iddAgentLogins,
    );
  const outstandingComments = normalizedComments
    .filter(
      (comment) =>
        !isOperationalOrDigestCommentForGate(
          comment.body,
          comment.authorLogin,
          trustedMarkerLogins,
        ),
    )
    .filter(
      (comment) =>
        !iddAgentLogins.has(comment.authorLogin) &&
        !isTrustedMachineDisposition(comment.authorLogin, comment.body),
    )
    .filter((comment) => {
      if (!isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins)) {
        return true;
      }
      return (
        classifyRegularBotComment(
          {
            author: { login: comment.authorLogin },
            body: comment.body,
            createdAt: comment.createdAt,
          },
          classificationComments,
          threads,
          {
            isDispositionAuthor: (login) =>
              iddAgentLogins.has(
                String(login ?? '')
                  .trim()
                  .toLowerCase(),
              ),
          },
        ) === null
      );
    });
  // Only IDD-agent dispositions feed the generic 1:1 pool. Trusted machine
  // dispositions are handled solely by `trustedDispositionedStickyIndexes`
  // (bot + type matched), so they can never clear an unrelated regular comment.
  const dispositionComments = normalizedComments.filter(
    (comment) =>
      iddAgentLogins.has(comment.authorLogin) &&
      isDispositionComment({ body: comment.body }),
  );
  // #1018 non-review-notice carry-forward (fail-closed, author-scoped). A
  // persistent advisory non-review notice already dispositioned `**Rejected** —
  // {bot-login} did not review HEAD …` keeps that disposition across HEAD changes
  // while the bot still has not reviewed any HEAD: a Codex `updatedAt` bump or a
  // re-posted CodeRabbit rate-limit summary must not re-flag
  // `missing-disposition-evidence` for a notice the agent already rejected.
  //
  // Each carry-forward is matched strictly WITHIN one advisory-bot identity: a
  // notice carries forward only against a notice-disposition whose body names
  // that same bot's GitHub login. This repository can configure several advisory
  // bots at once (CodeRabbit + a Codex connector), so a count/order-only pairing
  // could credit bot A's disposition to bot B's still-undispositioned notice and
  // suppress a real blocker. An unattributable disposition (one that names no
  // configured bot login) carries nothing forward — the original re-disposition
  // churn, which is safe. Matched notices leave the outstanding set and the
  // matched notice-dispositions leave the general disposition pool, so a notice
  // disposition never also clears an unrelated regular comment and the notice's
  // bumped activity can never strand its disposition. The guard re-checks the
  // current notice body, so a notice the bot later replaces with a real review no
  // longer matches and still needs a fresh disposition. Any unmatched notice or
  // disposition falls through to the unchanged 1:1 pairing.
  const noticeDispositions = dispositionComments.filter((comment) =>
    isNonReviewNoticeDisposition({ body: comment.body }),
  );
  // #1833 diagnostic-only (see `NON_REVIEW_NOTICE_DISPOSITION_HINT` /
  // `DispositionEvidenceSummary.missingRegularComments[].hint`): IDD-agent
  // replies that start with `**Rejected**` -- so `isDispositionComment` and
  // the generic 1:1 pairing both accept them as SOME disposition -- but that
  // do not match `isNonReviewNoticeDisposition`'s stricter `did not review
  // HEAD` phrase requirement, so they can never satisfy the notice-specific
  // carry-forward above. Kept separate from `noticeDispositions` (its exact
  // complement within `**Rejected**`-prefixed replies) purely to power the
  // hint; never feeds `carriedNoticeIndexes`, `dispositionTimes`, or any
  // other routing input.
  //
  // Deliberately NOT attributed per-bot: `dispositionNamesAdvisoryBot`
  // (the carry-forward's own bot-attribution helper) can only anchor on the
  // canonical `did not review HEAD` template's span, so a wrong-phrase
  // reply -- missing that exact phrase by definition -- can never be
  // attributed to one bot over another by construction. In a multi-bot
  // scenario (e.g. CodeRabbit's notice correctly dispositioned, Codex's
  // still missing) the hint below attaches to every still-missing notice
  // that ANY wrong-phrase reply postdates, not just the one it may have
  // been intended for. Advisory-only, so this is a diagnostic false
  // positive at worst, never a routing change.
  const wrongPhraseRejectedDispositions = dispositionComments.filter(
    (comment) =>
      DISPOSITION_REJECTED_PREFIX_RE.test(comment.body.trimStart()) &&
      !isNonReviewNoticeDisposition({ body: comment.body }),
  );
  // #2249: a broader "close but not exact" pool, independent of the
  // #1833 non-review-notice pairing above. Sourced from ALL IDD-agent
  // comments (not just `dispositionComments`, which already requires
  // `isDispositionComment` to be true) because the motivating mistake --
  // a plain `Accepted — ...` / `Rejected — ...` reply with no bold
  // markdown at all -- never satisfies `isDispositionComment` in the
  // first place, so it would never appear in `dispositionComments`.
  // `!isDispositionComment` excludes any comment that is ALREADY a valid
  // disposition (e.g. `**Accepted**` is well-formed and needs no hint),
  // so this pool and `wrongPhraseRejectedDispositions` are disjoint by
  // construction: the latter's members all satisfy `isDispositionComment`.
  const malformedPrefixDispositions = normalizedComments.filter(
    (comment) =>
      iddAgentLogins.has(comment.authorLogin) &&
      MALFORMED_DISPOSITION_PREFIX_RE.test(comment.body.trimStart()) &&
      !isDispositionComment({ body: comment.body }),
  );
  const outstandingNotices = outstandingComments.filter(
    (comment) =>
      isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) &&
      isAdvisoryNonReviewNotice(comment.body),
  );
  const carriedNoticeIndexes = new Set();
  const consumedNoticeDispositionIndexes = new Set();
  const noticesByAuthor = new Map();
  for (const notice of outstandingNotices) {
    const list = noticesByAuthor.get(notice.authorLogin) ?? [];
    list.push(notice);
    noticesByAuthor.set(notice.authorLogin, list);
  }
  // Sort the bot logins for deterministic iteration order only. Each
  // author's own `matchingDispositions` is computed independently from the
  // full `noticeDispositions` pool -- never filtered by another author's
  // carry -- so a single disposition naming several configured bots
  // (`dispositionNamesAdvisoryBot` matches each one it names) can carry
  // forward one notice per bot it names, not just the alphabetically-first
  // bot processed (#2475). `matchingDispositions.length` still bounds
  // `carry` per author, so this author's own notices are never
  // over-credited from a single matching disposition.
  // `consumedNoticeDispositionIndexes` still accumulates the union of every
  // disposition consumed across every author -- read again below to
  // exclude those same comments from the separate generic 1:1 pool, so a
  // disposition that already carried a notice forward can never also clear
  // an unrelated regular comment there.
  for (const authorLogin of [...noticesByAuthor.keys()].sort()) {
    const notices = noticesByAuthor.get(authorLogin) ?? [];
    const matchingDispositions = noticeDispositions.filter((disposition) =>
      dispositionNamesAdvisoryBot(disposition.body, authorLogin),
    );
    const carry = Math.min(notices.length, matchingDispositions.length);
    for (let index = 0; index < carry; index += 1) {
      carriedNoticeIndexes.add(notices[index].sortedIndex);
      consumedNoticeDispositionIndexes.add(
        matchingDispositions[index].sortedIndex,
      );
    }
  }
  // Count-based 1:1 pairing for the trailing-marker rule: a single later IDD
  // disposition marker addresses at most ONE earlier regular comment, so one
  // trailing marker cannot clear several distinct comments that each still
  // lack a disposition.
  // Walk the outstanding comments oldest-first and greedily consume the
  // earliest disposition marker strictly newer than each (markers that are not
  // newer than the current comment cannot address it or any later comment).
  // 1:1 pairing of later IDD-agent replies. Advisory-bot outstanding
  // comments still require a real disposition prefix. Human outstanding
  // comments also accept an unmarked later IDD-agent reply (presence-only,
  // #2139) so "thanks, fixed" clears the human item without hollowing out
  // Copilot / CodeRabbit pairing.
  const agentReplyComments = normalizedComments
    .filter(
      (comment) =>
        iddAgentLogins.has(comment.authorLogin) &&
        !consumedNoticeDispositionIndexes.has(comment.sortedIndex) &&
        isValidIsoTimestamp(comment.activityAt) &&
        !isOperationalOrDigestCommentForGate(
          comment.body,
          comment.authorLogin,
          trustedMarkerLogins,
        ),
    )
    .sort((left, right) => {
      const byTime = compareIsoTimestamps(left.activityAt, right.activityAt);
      return byTime !== 0 ? byTime : left.sortedIndex - right.sortedIndex;
    });
  const usedReplyIndexes = new Set();
  const missing = [];
  for (const comment of outstandingComments) {
    if (
      carriedNoticeIndexes.has(comment.sortedIndex) ||
      trustedDispositionedStickyIndexes.has(comment.sortedIndex)
    ) {
      continue;
    }
    const requiresDispositionPrefix = isGateAdvisoryBotLogin(
      comment.authorLogin,
      advisoryBotLogins,
    );
    const reply = agentReplyComments.find((candidate) => {
      if (usedReplyIndexes.has(candidate.sortedIndex)) {
        return false;
      }
      if (compareIsoTimestamps(candidate.activityAt, comment.activityAt) <= 0) {
        return false;
      }
      if (
        requiresDispositionPrefix &&
        !isDispositionComment({ body: candidate.body })
      ) {
        return false;
      }
      return true;
    });
    if (reply) {
      usedReplyIndexes.add(reply.sortedIndex);
    } else {
      missing.push(comment);
    }
  }
  const missingRegularComments = missing.map((comment) => {
    // #1833: only hint when this missing item is itself a recognized
    // advisory non-review notice AND a wrong-phrase `**Rejected**` attempt
    // exists that postdates the notice's original `createdAt` -- so the hint
    // targets the specific comment a human/agent plausibly already tried
    // (and mis-phrased) rather than every unrelated missing item whenever any
    // wrong-phrase reply exists anywhere. Deliberately compares against
    // `createdAt`, not the notice's (possibly bumped) `activityAt`: the
    // motivating scenario is a wrong-phrase reply posted right after the
    // notice first appeared, followed by a re-triggered bot bumping
    // `updatedAt` past that reply -- which is exactly what strands the item
    // in `missing` in the first place (see the `activityAt`-based general 1:1
    // pairing above), so requiring the attempt to postdate the bumped
    // `activityAt` would always be false in the one case this hint exists
    // for.
    const isNoticeComment =
      isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) &&
      isAdvisoryNonReviewNotice(comment.body);
    const hasWrongPhraseAttempt =
      isNoticeComment &&
      wrongPhraseRejectedDispositions.some(
        (disposition) =>
          compareIsoTimestamps(disposition.activityAt, comment.createdAt) > 0,
      );
    // #2249: generalizes the diagnostic above beyond the notice-specific
    // wrong-phrase case. Checked only when `hasWrongPhraseAttempt` is
    // false so the more specific #1833 hint always wins when both could
    // apply (they cannot in practice -- see `malformedPrefixDispositions`'
    // disjointness note -- but the precedence keeps the more actionable
    // hint on top if that ever changes).
    //
    // Gated on `isGateAdvisoryBotLogin`, mirroring `isNoticeComment` above
    // (Copilot review on PR #2383): `requiresDispositionPrefix` in the 1:1
    // pairing loop above is the ONLY thing that ever requires the exact
    // `**Accepted**`/`**Rejected**` bold prefix -- a human's outstanding
    // comment accepts any later IDD-agent reply, presence-only (#2139).
    // Without this gate, a single malformed reply that legitimately
    // cleared an earlier human comment (consumed via `usedReplyIndexes`
    // in that loop, invisible to this global `malformedPrefixDispositions`
    // pool) could still misleadingly hint a LATER, still-missing human
    // comment that it needs bold markdown it never required.
    const hasMalformedPrefixAttempt =
      !hasWrongPhraseAttempt &&
      isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) &&
      malformedPrefixDispositions.some(
        (disposition) =>
          compareIsoTimestamps(disposition.activityAt, comment.createdAt) > 0,
      );
    // #2491: neither hint above fires when the existing disposition reply
    // was itself well-formed and correctly timed -- both look for a
    // MIS-PHRASED attempt, and this is not one. Instead the bot live-edited
    // this same comment id in place into a non-review notice afterward,
    // bumping its `activityAt` past the disposition's own timestamp: the
    // disposition `<= comment.activityAt` bound is exactly the complement of
    // the general 1:1 pairing's own success condition above
    // (`candidate.activityAt > comment.activityAt`), so a disposition
    // satisfying it is exactly one that FAILS that pairing. Like the two
    // hints above, this is a plausible-timing heuristic, not a proven
    // causal link to this specific comment -- `dispositionComments.some`
    // matches any well-formed disposition in the window, including one a
    // human/agent posted for a different comment entirely or one already
    // consumed elsewhere via `usedReplyIndexes`; a false-positive hint here
    // is a diagnostic inaccuracy at worst, never a routing change. The
    // `> comment.createdAt` lower bound (mirroring the two hints above)
    // additionally requires the disposition to postdate the comment's
    // original appearance. Gated on `isGateAdvisoryBotLogin` +
    // `isAdvisoryNonReviewNotice`, mirroring `isNoticeComment` above: only a
    // comment whose CURRENT body is itself a non-review notice from a
    // configured advisory bot fits the scenario the issue describes.
    const hasEditedAfterDispositionAttempt =
      !hasWrongPhraseAttempt &&
      !hasMalformedPrefixAttempt &&
      isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) &&
      isAdvisoryNonReviewNotice(comment.body) &&
      dispositionComments.some(
        (disposition) =>
          compareIsoTimestamps(disposition.activityAt, comment.activityAt) <=
            0 &&
          compareIsoTimestamps(disposition.activityAt, comment.createdAt) > 0,
      );
    return {
      id: comment.id || `comment-${comment.sortedIndex + 1}`,
      authorLogin: comment.authorLogin || 'unknown',
      createdAt: comment.createdAt,
      bodyPreview: buildBodyPreview(comment.body),
      ...(hasWrongPhraseAttempt
        ? { hint: NON_REVIEW_NOTICE_DISPOSITION_HINT }
        : hasMalformedPrefixAttempt
          ? { hint: MALFORMED_DISPOSITION_PREFIX_HINT }
          : hasEditedAfterDispositionAttempt
            ? { hint: EDITED_AFTER_DISPOSITION_HINT }
            : {}),
    };
  });
  const missingThreads = (threads ?? [])
    .map((thread, index) => {
      const commentsInThread = thread.comments?.nodes ?? [];
      const hasExternalFeedback = commentsInThread.some((comment) => {
        const authorLogin = String(comment.author?.login ?? '')
          .trim()
          .toLowerCase();
        return (
          authorLogin &&
          !iddAgentLogins.has(authorLogin) &&
          authorLogin !== prAuthorLogin
        );
      });
      if (!hasExternalFeedback) {
        return null;
      }
      if (thread.comments?.pageInfo?.hasNextPage) {
        return {
          id: String(thread.id ?? '') || `thread-${index + 1}`,
          isResolved: Boolean(thread.isResolved),
          reason: 'incomplete-thread-comments',
          ackOnlyPostDisposition: false,
          inPlaceEditOnly: false,
        };
      }
      if (
        hasFreshDisposition(thread, {
          isDispositionAuthor: (login) =>
            iddAgentLogins.has(
              String(login ?? '')
                .trim()
                .toLowerCase(),
            ) ||
            trustedMarkerLogins.has(
              String(login ?? '')
                .trim()
                .toLowerCase(),
            ),
          isIddOriginatedBody: (body) =>
            isIddOriginatedReply(body, markerPrefix),
        })
      ) {
        return null;
      }
      // #2139: unmarked later replies on a *human-authored* thread are
      // presence-only only when no IDD-originated reply exists in the
      // thread. After a stamped or legacy trusted disposition, later
      // human feedback still re-opens freshness (#978). Advisory-authored
      // threads keep marker-first so an unmarked `ok` cannot satisfy
      // Clause 2.
      if (!isAdvisoryAuthoredThread(thread, advisoryBotLogins)) {
        const laterReplies = commentsInThread.slice(1);
        const hasUnmarkedHumanPresence =
          laterReplies.length > 0 &&
          !laterReplies.some((comment) =>
            isIddOriginatedThreadReply(comment, {
              iddAgentLogins,
              trustedMarkerLogins,
              markerPrefix,
            }),
          );
        if (hasUnmarkedHumanPresence) {
          return null;
        }
      }
      // E1 only snapshots UNRESOLVED non-awaiting threads, and E7 only requires
      // dispositions for snapshot items. A thread that is already resolved and
      // whose newest external feedback predates the review-snapshot boundary was
      // settled out-of-band (or resolved by the reviewer) and must not block; a
      // resolved thread with external feedback newer than the boundary (e.g.
      // freshly reopened) still requires a disposition.
      if (thread.isResolved && snapshotBoundaryAt) {
        const newestFeedbackAt = maxIsoTimestamp(
          commentsInThread
            .filter((comment) => {
              const authorLogin = String(comment.author?.login ?? '')
                .trim()
                .toLowerCase();
              return (
                authorLogin &&
                !iddAgentLogins.has(authorLogin) &&
                authorLogin !== prAuthorLogin
              );
            })
            .map((comment) => effectiveThreadCommentActivityAt(comment))
            .filter(isValidIsoTimestamp),
        );
        if (
          !newestFeedbackAt ||
          compareIsoTimestamps(newestFeedbackAt, snapshotBoundaryAt) <= 0
        ) {
          return null;
        }
      }
      const classification = classifyThreadAckOnlyPostDisposition(thread, {
        iddAgentLogins: options.iddAgentLogins,
        advisoryBotLogins: options.advisoryBotLogins,
        prAuthorLogin: options.prAuthorLogin,
        snapshotBoundaryAt: options.snapshotBoundaryAt,
      });
      return {
        id: String(thread.id ?? '') || `thread-${index + 1}`,
        isResolved: Boolean(thread.isResolved),
        reason: thread.isResolved
          ? 'missing-fresh-disposition'
          : 'unresolved-without-fresh-disposition',
        ackOnlyPostDisposition: classification.ackOnlyPostDisposition,
        inPlaceEditOnly: classification.inPlaceEditOnly,
      };
    })
    .filter(Boolean);
  const blockingCount = missingRegularComments.length + missingThreads.length;
  // #978: the sole blocking cause is post-disposition advisory-bot ack-only
  // activity. True only when something blocks AND every blocking item is an
  // ack-only-post-disposition resolved thread (no missing regular comments, no
  // non-ack thread). The guard implies missingThreads is non-empty, so `.every`
  // is never vacuously true.
  const soleCauseAckOnlyPostDisposition =
    blockingCount > 0 &&
    missingRegularComments.length === 0 &&
    missingThreads.every((entry) => entry.ackOnlyPostDisposition === true);
  // #1313: narrower sibling -- true only when every blocking item is ALSO an
  // in-place edit of pre-existing content (see `inPlaceEditOnly` above). A
  // strict subset of `soleCauseAckOnlyPostDisposition`.
  const soleCauseInPlaceEditOnly =
    blockingCount > 0 &&
    missingRegularComments.length === 0 &&
    missingThreads.every((entry) => entry.inPlaceEditOnly === true);
  return {
    route: blockingCount > 0 ? 'return-to-e1' : 'proceed',
    reason: blockingCount > 0 ? 'missing-disposition-evidence' : 'complete',
    blockingCount,
    missingRegularCommentCount: missingRegularComments.length,
    missingThreadCount: missingThreads.length,
    soleCauseAckOnlyPostDisposition,
    soleCauseInPlaceEditOnly,
    missingRegularComments,
    missingThreads,
  };
}
export function summarizeBranchReviewRequirements(
  branchRules = [],
  branchProtection = {},
) {
  const requiredCheckNames = new Set();
  // #1689: the subset of requiredCheckNames whose ruleset/classic-protection
  // entry is source-pinned (see `summarizeRequiredCheckMetadata`'s
  // `pinnedNames`) -- lets `summarizeRequiredChecks` name the specific
  // pinned check(s) in a blocker detail instead of a generic message.
  const requiredCheckSourcePinnedNames = new Set();
  const requiredReviewerLogins = new Set();
  const requiredReviewerTeams = new Set();
  const requiredReviewerRequirements = [];
  const classicBypassPullRequestUserLogins = new Set();
  const classicBypassPullRequestTeamSlugs = new Set();
  const classicBypassPullRequestAppSlugs = new Set();
  let requiredApprovingReviewCount = 0;
  let requireCodeOwnerReview = false;
  let classicRequireCodeOwnerReview = false;
  let requiresConversationResolution = false;
  let requiredCheckSourcePinned = false;
  // #1689: true when at least one pinned source cannot be attributed to a
  // resolved check name (a `workflows` rule, or a pinned entry with no
  // `context`/`name`/`check`) -- independent of whether OTHER, named-and-
  // pinned entries also exist. `trustSourcePinnedRequiredChecks` must never
  // bypass the downgrade while this is true, even when
  // `requiredCheckSourcePinnedNames` is non-empty from a separate entry.
  let requiredCheckSourcePinnedUnresolved = false;
  for (const rule of branchRules) {
    if (rule?.type === 'pull_request') {
      const parameters = rule.parameters ?? {};
      requiredApprovingReviewCount = Math.max(
        requiredApprovingReviewCount,
        Number(parameters.required_approving_review_count ?? 0) || 0,
      );
      requireCodeOwnerReview =
        requireCodeOwnerReview || Boolean(parameters.require_code_owner_review);
      requiresConversationResolution =
        requiresConversationResolution ||
        Boolean(parameters.required_review_thread_resolution);
      for (const reviewer of parameters.required_reviewers ?? []) {
        const requirement = extractRequiredReviewerRequirement(reviewer);
        if (!requirement.identity) {
          continue;
        }
        requiredReviewerRequirements.push(requirement);
        if (requirement.identity.includes('/')) {
          requiredReviewerTeams.add(requirement.identity);
        } else {
          requiredReviewerLogins.add(requirement.identity);
        }
      }
      continue;
    }
    if (rule?.type === 'required_status_checks') {
      const checkMetadata = summarizeRequiredCheckMetadata(
        rule.parameters ?? {},
      );
      requiredCheckSourcePinned =
        requiredCheckSourcePinned || checkMetadata.sourcePinned;
      requiredCheckSourcePinnedUnresolved =
        requiredCheckSourcePinnedUnresolved || checkMetadata.unresolvedPinned;
      for (const name of checkMetadata.names) {
        requiredCheckNames.add(name);
      }
      for (const name of checkMetadata.pinnedNames) {
        requiredCheckSourcePinnedNames.add(name);
      }
      continue;
    }
    if (rule?.type === 'workflows') {
      requiredCheckSourcePinned = true;
      requiredCheckSourcePinnedUnresolved = true;
    }
  }
  const protectionReviews =
    branchProtection.required_pull_request_reviews ?? {};
  classicRequireCodeOwnerReview =
    Boolean(protectionReviews.require_code_owner_reviews) ||
    Boolean(protectionReviews.require_code_owner_review);
  for (const user of protectionReviews.bypass_pull_request_allowances?.users ??
    []) {
    const login = typeof user === 'string' ? user : user?.login;
    for (const normalizedLogin of normalizeTrustedMarkerLogins([login])) {
      classicBypassPullRequestUserLogins.add(normalizedLogin);
    }
  }
  for (const team of protectionReviews.bypass_pull_request_allowances?.teams ??
    []) {
    const slug = typeof team === 'string' ? team : team?.slug;
    for (const normalizedSlug of normalizeTrustedMarkerLogins([slug])) {
      classicBypassPullRequestTeamSlugs.add(normalizedSlug);
    }
  }
  for (const app of protectionReviews.bypass_pull_request_allowances?.apps ??
    []) {
    const slug = typeof app === 'string' ? app : (app?.slug ?? app?.app_slug);
    for (const normalizedSlug of normalizeTrustedMarkerLogins([slug])) {
      classicBypassPullRequestAppSlugs.add(normalizedSlug);
    }
  }
  requiredApprovingReviewCount = Math.max(
    requiredApprovingReviewCount,
    Number(protectionReviews.required_approving_review_count ?? 0) || 0,
  );
  requireCodeOwnerReview =
    requireCodeOwnerReview || classicRequireCodeOwnerReview;
  requiresConversationResolution =
    requiresConversationResolution ||
    Boolean(branchProtection.required_conversation_resolution?.enabled);
  const protectionCheckMetadata = summarizeRequiredCheckMetadata(
    branchProtection.required_status_checks ?? {},
  );
  requiredCheckSourcePinned =
    requiredCheckSourcePinned || protectionCheckMetadata.sourcePinned;
  requiredCheckSourcePinnedUnresolved =
    requiredCheckSourcePinnedUnresolved ||
    protectionCheckMetadata.unresolvedPinned;
  for (const name of protectionCheckMetadata.names) {
    requiredCheckNames.add(name);
  }
  for (const name of protectionCheckMetadata.pinnedNames) {
    requiredCheckSourcePinnedNames.add(name);
  }
  return {
    requiredApprovingReviewCount,
    requireCodeOwnerReview,
    classicRequireCodeOwnerReview,
    classicBypassPullRequestUserLogins: [
      ...classicBypassPullRequestUserLogins,
    ].sort(),
    classicBypassPullRequestTeamSlugs: [
      ...classicBypassPullRequestTeamSlugs,
    ].sort(),
    classicBypassPullRequestAppSlugs: [
      ...classicBypassPullRequestAppSlugs,
    ].sort(),
    requiresConversationResolution,
    requiredCheckSourcePinned,
    requiredCheckSourcePinnedNames: [...requiredCheckSourcePinnedNames].sort(),
    requiredCheckSourcePinnedUnresolved,
    requiredReviewerLogins: [...requiredReviewerLogins].sort(),
    requiredReviewerTeams: [...requiredReviewerTeams].sort(),
    requiredReviewerRequirements,
    requiredCheckNames: [...requiredCheckNames].sort(),
  };
}
/**
 * #1513: resolve whether the base branch's protection or ruleset requires
 * an up-to-date head before merge, and pair that with the PR's live
 * `mergeStateStatus` / `mergeable`. Neither `pre-merge-readiness.mts` nor
 * `idd-merge-execute.mts` previously read this at all -- a live `BEHIND`
 * PR could report `ready: true` right up to the uncaught `gh pr merge`
 * rejection (the field incident this issue documents).
 *
 * Resolution order mirrors `summarizeRequiredChecks`'s existing
 * ruleset-then-classic precedence: a ruleset's `required_status_checks`
 * rule carries `strict_required_status_checks_policy` (confirmed
 * empirically against this repository's own `main`: classic protection
 * returns a genuine 404 "Branch not protected", while
 * `rules/branches/main` returns this field as `true`); classic
 * protection's equivalent field is `required_status_checks.strict`. When
 * neither source resolves `true` AND the branch-protection/ruleset reads
 * were unreadable (a masked 403-as-404, see `protectionReadsUnreadable`
 * in `pre-merge-readiness.mts`), fail closed per
 * `idd-overview-core.instructions.md`'s fail-closed default: assume the
 * requirement is present rather than silently reporting "no requirement."
 * Only a genuinely readable "no rule found" resolves to `none`.
 *
 * Strict `=== true` checks throughout (not `Boolean(...)` coercion) per
 * the write-side mutation-helper critique lens
 * (`idd-overview-appendix.instructions.md`): a non-boolean or missing
 * value must never be silently coerced into "requirement satisfied."
 */
export function summarizeBranchCurrency(
  branchRules = [],
  branchProtection = {},
  options = {},
) {
  // #1513 (Copilot/Codex review on PR #1538): GitHub's ruleset docs state
  // `strict_required_status_checks_policy` "will not take effect unless at
  // least one status check is enabled" -- confirmed against
  // https://docs.github.com/en/rest/repos/rules. Treating the flag alone as
  // authoritative would false-positive block a BEHIND PR under an
  // empty-required-check ruleset that GitHub itself would allow to merge, so
  // also require a non-empty required-check list (reusing the same
  // extraction `summarizeRequiredChecks` already uses for check names).
  // Classic branch protection's `required_status_checks.strict` carries no
  // equivalent documented caveat, so it is left unconditional.
  const rulesetRequires = (branchRules ?? []).some(
    (rule) =>
      rule?.type === 'required_status_checks' &&
      rule.parameters?.strict_required_status_checks_policy === true &&
      summarizeRequiredCheckMetadata(rule.parameters ?? {}).names.length > 0,
  );
  const classicRequires =
    branchProtection.required_status_checks?.strict === true;
  let requiresUpToDateHead;
  let requiresUpToDateHeadSource;
  if (rulesetRequires) {
    requiresUpToDateHead = true;
    requiresUpToDateHeadSource = 'ruleset';
  } else if (classicRequires) {
    requiresUpToDateHead = true;
    requiresUpToDateHeadSource = 'classic-protection';
  } else if (options.protectionReadsUnreadable === true) {
    requiresUpToDateHead = true;
    requiresUpToDateHeadSource = 'unreadable-fail-closed';
  } else {
    requiresUpToDateHead = false;
    requiresUpToDateHeadSource = 'none';
  }
  return {
    mergeStateStatus: String(options.mergeStateStatus ?? '').toUpperCase(),
    mergeable: String(options.mergeable ?? '').toUpperCase(),
    requiresUpToDateHead,
    requiresUpToDateHeadSource,
  };
}
export function summarizeRequiredChecks(
  checks = [],
  branchRules = [],
  branchProtection = {},
  {
    waivers = null,
    waivableSelectors = null,
    protectionReadsUnreadable = false,
    trustSourcePinnedRequiredChecks = false,
    excludeFromWaiverCoverage = null,
    waiverActiveSinceOverride = null,
    treatAsCoveredByWaiver = null,
    treatAsCoveredByWaiverSince = null,
  } = {},
) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const requiredCheckNames = branchReviewRequirements.requiredCheckNames;
  const requiredCheckNameSet = new Set(requiredCheckNames);
  const validWaivers = waivers?.valid ?? [];
  const normalizedChecks = checks.map((check) => {
    const name = String(check.name ?? '');
    const state = String(check.state ?? '').toUpperCase();
    const completedAt = String(check.completedAt ?? '');
    // #2353 (Copilot + Codex + CodeRabbit review on PR #2370, round 5):
    // `isValidIsoTimestamp` alone accepts GitHub's `0001-01-01T00:00:00Z`
    // zero-value sentinel -- `normalizeStatusCheckRollupEntry` substitutes
    // it for BOTH an absent `completedAt` (still QUEUED/IN_PROGRESS) and an
    // absent `startedAt` (not yet started), the same non-nullable-DateTime
    // convention `isCompletedCiTimestamp` already exists to reject (see its
    // doc comment / `parseCompletedAt` above). Reusing it here -- despite
    // its "completed" name -- because the sentinel isn't completion-
    // specific: it is GitHub's stand-in for "this lifecycle moment hasn't
    // happened yet," which applies equally to `startedAt`. Without this, an
    // IN_PROGRESS run (sentinel `completedAt`, but a genuine, fresh
    // `startedAt`) would pass BOTH `completedAtMs !== null` (the sentinel
    // parses as a valid, merely very-old, timestamp) and the `startedAt`
    // freshness cutoff below, reporting a still-running required check
    // `coveredByWaiver: true` while GitHub's own check is neither passed
    // nor even finished.
    const completedAtMs = isCompletedCiTimestamp(completedAt)
      ? Date.parse(completedAt)
      : null;
    const startedAt = String(check.startedAt ?? '');
    const startedAtMs = isCompletedCiTimestamp(startedAt)
      ? Date.parse(startedAt)
      : null;
    const matchingWaivers = validWaivers.filter((w) =>
      matchCheckSelectorLocal(name, w.checkSelector),
    );
    const activeSinceOverride =
      typeof waiverActiveSinceOverride === 'function'
        ? waiverActiveSinceOverride(name)
        : null;
    const activeSinceOverrideMs = isValidIsoTimestamp(activeSinceOverride)
      ? new Date(activeSinceOverride).getTime()
      : null;
    // #2034: a matched waiver only covers a check whose live run's
    // `completedAt` is at or after the moment the waiver became genuinely
    // active -- otherwise the check was never actually re-run since the
    // waiver took effect, so reporting it covered here would diverge from
    // what the real required check (and GitHub's branch protection) still
    // shows. Fails closed on a missing/unparseable `completedAt` (never run,
    // still pending) or waiver `createdAt` (`'none'`).
    const hasFreshWaiverCoverage =
      completedAtMs !== null &&
      matchingWaivers.some((w) => {
        const waiverCreatedAtMs = isValidIsoTimestamp(w.createdAt)
          ? new Date(w.createdAt).getTime()
          : null;
        if (waiverCreatedAtMs === null) return false;
        const activeSinceMs =
          activeSinceOverrideMs !== null
            ? Math.max(waiverCreatedAtMs, activeSinceOverrideMs)
            : waiverCreatedAtMs;
        return completedAtMs >= activeSinceMs;
      });
    // #2353: an independent positive path -- see `treatAsCoveredByWaiver`'s
    // own doc comment for why it deliberately bypasses
    // `excludeFromWaiverCoverage`/`hasFreshWaiverCoverage`/`waivableSelectors`
    // below rather than feeding into the same conjunction. Still requires
    // `completedAtMs !== null` (Copilot + Codex review on PR #2370): the
    // SAME #2034 fail-closed live-run requirement `hasFreshWaiverCoverage`
    // already enforces -- a check that is still QUEUED/IN_PROGRESS/PENDING
    // with no parseable `completedAt` has never actually produced a verdict
    // at all, and treating it as covered would report `success` while
    // GitHub's own required-check state is still pending, reproducing the
    // exact "ready but merge blocked" failure mode #2021 fixed for the
    // direct-waiver path. Also requires the live run to be fresh relative
    // to `treatAsCoveredByWaiverSince` when the caller supplies one, and
    // (Codex review on PR #2370, second follow-up) anchors that freshness
    // check on `startedAt` rather than `completedAt`: a run that began
    // evaluating state before the cutoff never observed whatever made this
    // check relieved, even if it happens to finish (and post `completedAt`)
    // moments after the cutoff passes -- the run's own verdict was already
    // decided using stale state by then. Requires `startedAtMs !== null`
    // for the same fail-closed reason as `completedAtMs !== null` above: a
    // run with no parseable `startedAt` has no evidence it observed
    // anything at all.
    const treatAsCoveredByWaiverSinceOverride =
      typeof treatAsCoveredByWaiverSince === 'function'
        ? treatAsCoveredByWaiverSince(name)
        : null;
    const treatAsCoveredByWaiverSinceMs = isValidIsoTimestamp(
      treatAsCoveredByWaiverSinceOverride,
    )
      ? new Date(treatAsCoveredByWaiverSinceOverride).getTime()
      : null;
    const treatedAsCoveredByWaiver =
      completedAtMs !== null &&
      startedAtMs !== null &&
      typeof treatAsCoveredByWaiver === 'function' &&
      treatAsCoveredByWaiver(name) &&
      (treatAsCoveredByWaiverSinceMs === null ||
        startedAtMs >= treatAsCoveredByWaiverSinceMs);
    const coveredByWaiver =
      !CHECK_PASS_EQUIVALENT_STATES.has(state) &&
      (treatedAsCoveredByWaiver ||
        (!(
          typeof excludeFromWaiverCoverage === 'function' &&
          excludeFromWaiverCoverage(name)
        ) &&
          hasFreshWaiverCoverage &&
          // The check must also sit on the policy's waivable surface. A
          // null/undefined list keeps the legacy behavior with no gate; an
          // empty configured list covers nothing.
          (!Array.isArray(waivableSelectors) ||
            isCheckNameConfiguredWaivable(name, waivableSelectors))));
    return {
      name,
      state,
      completedAt,
      coveredByWaiver,
      // Producer-identity discriminator (#1483); see `CheckLike` and
      // `selectLatestCheckPerName` for how it disambiguates a same-name
      // rerun from a genuinely independent, differently-sourced check.
      type: check.type ? String(check.type) : '',
      workflowName: check.workflowName ? String(check.workflowName).trim() : '',
    };
  });
  const matchedRequiredChecks = normalizedChecks.filter((check) =>
    requiredCheckNameSet.has(check.name),
  );
  const presentNames = new Set(
    matchedRequiredChecks.map((check) => check.name),
  );
  const missingRequiredCheckNames = requiredCheckNames.filter(
    (name) => !presentNames.has(name),
  );
  let status = 'unknown';
  // #1745: discarded non-passing same-name siblings among the REQUIRED
  // checks, e.g. a CANCELLED idd-advisory-convergence instance sitting
  // alongside the SUCCESS instance selectLatestCheckPerName picked as
  // "latest" -- surfaced regardless of the final `status` below so a
  // 'success' verdict here is never silently opaque about a discarded
  // non-passing sibling GitHub's own statusCheckRollup may have weighed
  // differently (the live PR #1741 divergence this field exists to make
  // visible; see classifyCiChecks's own findDiscardedNonPassingSiblings
  // doc comment for the full rationale). Empty (never omitted) when no
  // required checks are configured.
  let discardedNonPassingRequiredChecks = [];
  // #1689: the pinned required-check names that caused the downgrade below
  // (empty unless that downgrade actually fired). Lets a caller's blocker
  // detail name the source-pinned cause explicitly instead of a generic
  // "CI is not all-passing" message -- see `computePreMergeReadinessBlockers`.
  let sourcePinnedRequiredCheckNames = [];
  // #1689: true when the downgrade below fired at least partly because of a
  // pinned source that could not be attributed to any check name (a
  // ruleset `workflows` rule, or a pinned entry with no `context`/`name`/
  // `check`) -- distinct from `sourcePinnedRequiredCheckNames` being empty,
  // which alone would be ambiguous between "no pinning" and "pinning
  // exists but is unnamed." Lets a blocker detail name the cause even when
  // no specific check name can be cited.
  let sourcePinnedUnresolved = false;
  if (requiredCheckNames.length > 0) {
    const effectiveChecks = matchedRequiredChecks.map((c) =>
      c.coveredByWaiver ? { ...c, state: 'SKIPPED' } : c,
    );
    const ciClassification = classifyCiChecks(effectiveChecks);
    status =
      missingRequiredCheckNames.length > 0
        ? 'missing'
        : ciClassification.status;
    // #1689: the `trustSourcePinnedRequiredChecks` opt-in only widens the
    // named/resolved case -- an unresolved pinned source (no check name to
    // correlate with a live run at all) always still forces the downgrade,
    // even when a SEPARATE, named-and-pinned entry also exists and the
    // operator has opted in for that one.
    if (
      status === 'success' &&
      branchReviewRequirements.requiredCheckSourcePinned &&
      (!trustSourcePinnedRequiredChecks ||
        branchReviewRequirements.requiredCheckSourcePinnedUnresolved)
    ) {
      status = 'unknown';
      sourcePinnedRequiredCheckNames = [
        ...branchReviewRequirements.requiredCheckSourcePinnedNames,
      ];
      sourcePinnedUnresolved =
        branchReviewRequirements.requiredCheckSourcePinnedUnresolved;
    }
    // #1753: computed from the RAW matchedRequiredChecks -- deliberately
    // NOT ciClassification.discardedNonPassingInstances above, which is
    // derived from the waiver-adjusted effectiveChecks. A valid waiver
    // rewrites a waived non-passing instance's `state` to 'SKIPPED' (pass-
    // equivalent, outside GENUINELY_NON_PASSING_STATES), so computing this
    // evidence field from effectiveChecks would let a waived CANCELLED
    // sibling silently drop out of this field the moment it is waived --
    // exactly the divergence-masking scenario #1745 exists to surface, and
    // exactly the check this repo's own `idd-advisory-convergence` waivable
    // policy can trigger. `status` above intentionally keeps using the
    // waiver-adjusted effectiveChecks -- a valid waiver legitimately makes
    // a check pass for merge-gate purposes; only this evidence-only
    // computation needs the pre-waiver truth.
    discardedNonPassingRequiredChecks = findDiscardedNonPassingSiblings(
      matchedRequiredChecks,
    );
  }
  return {
    status,
    noRequiredChecksConfigured:
      !protectionReadsUnreadable &&
      requiredCheckNames.length === 0 &&
      !branchReviewRequirements.requiredCheckSourcePinned,
    // #1377: surfaced separately from `noRequiredChecksConfigured` so a hold
    // message can name the unreadable-read cause specifically instead of a
    // generic "CI is not all-passing".
    protectionReadsUnreadable,
    presentRunConclusion: resolvePresentRunConclusion(normalizedChecks),
    requiredCheckCount: requiredCheckNames.length,
    generatedRequiredCheckCount: matchedRequiredChecks.length,
    requiredChecksGenerated:
      requiredCheckNames.length > 0 && missingRequiredCheckNames.length === 0,
    requiredChecksPassing:
      requiredCheckNames.length > 0 && status === 'success',
    requiredCheckNames,
    missingRequiredCheckNames,
    // #1745: see the field's own inline comment above -- reported
    // unconditionally (empty array, never omitted) so a consumer never has
    // to special-case "field absent" vs. "field empty".
    discardedNonPassingRequiredChecks,
    // #1689: see the field's own inline comment above -- reported
    // unconditionally (empty array, never omitted), populated only when the
    // source-pinned downgrade actually fired for this call.
    sourcePinnedRequiredCheckNames,
    // #1689: see the field's own inline comment above -- `false` unless the
    // downgrade fired AND at least one pinned source was unnamed.
    sourcePinnedUnresolved,
    checks: normalizedChecks.map((check) => ({
      name: check.name,
      state: check.state,
      completedAt: isValidIsoTimestamp(check.completedAt)
        ? check.completedAt
        : '',
      required: requiredCheckNameSet.has(check.name),
      ...(check.coveredByWaiver ? { coveredByWaiver: true } : {}),
    })),
  };
}
// Conclusion over *all* present check runs (waiver-covered runs count as
// skipped), used for the F2 fallback when no required checks are configured:
// an unprotected branch must not satisfy CI vacuously, so the gate inspects the
// real run conclusions instead.
function resolvePresentRunConclusion(normalizedChecks) {
  if (normalizedChecks.length === 0) {
    return 'none';
  }
  const effective = normalizedChecks.map((check) =>
    check.coveredByWaiver ? { ...check, state: 'SKIPPED' } : check,
  );
  const { status } = classifyCiChecks(effective);
  if (status === 'success') {
    return 'all-passing';
  }
  if (status === 'pending') {
    return 'pending';
  }
  return 'some-failing';
}
export function resolveCodeownersForFiles(codeownersText, changedFiles = []) {
  const rules = parseCodeownersRules(codeownersText);
  return collectCodeownersForFiles(rules, changedFiles);
}
export function selectCodeownersText(payloads = []) {
  for (const payload of payloads) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Object.hasOwn(payload, 'content')
    ) {
      continue;
    }
    const content = String(payload.content ?? '').replace(/\n/g, '');
    return Buffer.from(content, 'base64').toString('utf8');
  }
  return '';
}
function collectCodeownersForFiles(rules, changedFiles = []) {
  const codeownerUsers = new Set();
  const codeownerTeams = new Set();
  const codeownerEmails = new Set();
  const unmatchedFiles = [];
  for (const filePath of changedFiles) {
    const normalizedPath = String(filePath ?? '').replace(/^\/+/, '');
    if (!normalizedPath) {
      continue;
    }
    const owners = findCodeownersForPath(rules, normalizedPath);
    if (!owners) {
      unmatchedFiles.push(normalizedPath);
      continue;
    }
    if (!hasCodeownerOwners(owners)) {
      continue;
    }
    for (const owner of owners.users) {
      codeownerUsers.add(owner);
    }
    for (const owner of owners.teams) {
      codeownerTeams.add(owner);
    }
    for (const owner of owners.emails) {
      codeownerEmails.add(owner);
    }
  }
  return {
    ruleCount: rules.length,
    changedFileCount: changedFiles.length,
    unmatchedFiles,
    codeownerUserLogins: [...codeownerUsers].sort(),
    codeownerTeamSlugs: [...codeownerTeams].sort(),
    codeownerEmailAddresses: [...codeownerEmails].sort(),
  };
}
export function summarizeReviewerStates(
  reviews = [],
  {
    reviewDecision = '',
    branchRules = [],
    branchRulesets = [],
    branchProtection = {},
    branchRulesetsUnreadable = false,
    codeownersText = '',
    changedFiles = [],
    eligibleCodeownerUserLogins = null,
    eligibleCodeownerUserLoginsUnreadable = false,
    reviewsUnreadable = false,
    advisoryBotLogins = [],
    prAuthorLogin = '',
    viewerLogin = '',
    viewerTeamSlugs = [],
    viewerAppSlug = '',
  } = {},
) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const requiredReviewerLogins = new Set(
    branchReviewRequirements.requiredReviewerLogins,
  );
  const advisoryBotLoginSet = new Set(
    normalizeTrustedMarkerLogins(advisoryBotLogins),
  );
  const codeownerRules = parseCodeownersRules(codeownersText);
  const codeowners = collectCodeownersForFiles(codeownerRules, changedFiles);
  const codeownerUsers = new Set(codeowners.codeownerUserLogins);
  const eligibleCodeownerUsers =
    eligibleCodeownerUserLogins === null
      ? codeownerUsers
      : new Set(
          normalizeTrustedMarkerLogins(eligibleCodeownerUserLogins).filter(
            (login) => codeownerUsers.has(login),
          ),
        );
  const normalizedReviewDecision = String(reviewDecision ?? '');
  const latestByAuthor = [...indexLatestGatingReviewsByAuthor(reviews).values()]
    .map((review) => {
      const login = String(review.author?.login ?? '')
        .trim()
        .toLowerCase();
      const isAdvisoryBot = isGateAdvisoryBotLogin(login, advisoryBotLoginSet);
      const isCodeowner = eligibleCodeownerUsers.has(login);
      const isRequiredReviewer = requiredReviewerLogins.has(login);
      return {
        login,
        state: String(review.state ?? ''),
        submittedAt: String(review.submittedAt ?? review.submitted_at ?? ''),
        isHuman: !isAdvisoryBot,
        isAdvisoryBot,
        isCodeowner,
        isRequiredReviewer,
      };
    })
    .sort((left, right) => left.login.localeCompare(right.login));
  const blockingChangesRequestedLogins = latestByAuthor
    .filter((review) => {
      return review.state === 'CHANGES_REQUESTED' && !review.isAdvisoryBot;
    })
    .map((review) => review.login);
  const humanApprovedCount = latestByAuthor.filter((review) => {
    return review.isHuman && review.state === 'APPROVED';
  }).length;
  // #1818: also require `isHuman` here, mirroring `humanApprovedCount` above.
  // Without it, any advisory bot (default-recognized or configured) that is
  // also listed as a CODEOWNER for the changed files would satisfy the
  // codeowner-approval gate on its own review -- the same fail-open shape
  // `humanApprovedCount` already guarded against. This intentionally
  // diverges from GitHub's own CODEOWNERS gate (which would count a bot
  // codeowner's approval); the stricter, fail-closed reading is deliberate,
  // not a gap to "fix" back.
  const codeownerApproved = latestByAuthor.some((review) => {
    return review.isCodeowner && review.isHuman && review.state === 'APPROVED';
  });
  const hasExplicitCodeownerMatches = changedFiles.some((filePath) => {
    const normalizedPath = String(filePath ?? '').replace(/^\/+/, '');
    if (!normalizedPath) {
      return false;
    }
    const owners = findCodeownersForPath(codeownerRules, normalizedPath);
    return !!owners && hasCodeownerOwners(owners);
  });
  const latestByLogin = new Map(
    latestByAuthor.map((review) => [review.login, review]),
  );
  const requiredReviewerApprovalsSatisfied =
    branchReviewRequirements.requiredReviewerRequirements.every(
      (requirement) => {
        if (
          requirement.filePatterns.length > 0 &&
          !changedFiles.some((filePath) => {
            return requirement.filePatterns.some((pattern) =>
              matchesCodeownersPattern(pattern, filePath),
            );
          })
        ) {
          return true;
        }
        if ((requirement.minimumApprovals ?? 0) <= 0) {
          return true;
        }
        // #1837: deliberately NOT gated by `reviewsUnreadable` (unlike the
        // `codeownerApprovalSatisfied`/`requiredApprovalsSatisfied` bypasses
        // fixed below). A team-identity requirement (`requirement.identity`
        // contains `/`, checked immediately below) can never be resolved to
        // a reviewing login from `reviews` data -- this code has no team
        // membership lookup at all -- so GitHub's own aggregate decision is
        // the only signal available for it regardless of whether the caller
        // fetched full review data. See "required reviewer rule objects
        // stay blocking until GitHub marks approval satisfied" in
        // tests/pre-merge-readiness.test.mts, which locks this in.
        if (normalizedReviewDecision === 'APPROVED') {
          return true;
        }
        if (requirement.identity.includes('/')) {
          return false;
        }
        return latestByLogin.get(requirement.identity)?.state === 'APPROVED';
      },
    );
  // #1837: `normalizedReviewDecision === 'APPROVED'` alone used to be an
  // unconditional bypass here, letting GitHub's own aggregate `reviewDecision`
  // (which can resolve APPROVED from a bot-only review -- GitHub shipped
  // bot-review-state support 2026-08-01, see #1818's background) satisfy this
  // gate even when the classified data this function already computed
  // (`codeownerApproved`) shows the approval came only from a bot. When the
  // caller genuinely could not fetch/classify individual reviews
  // (`reviewsUnreadable`), GitHub's aggregate is still the only available
  // signal and stays a bypass. When review data IS available (the normal
  // `collectPreMergeReadiness` path, which fails closed by throwing rather
  // than ever reaching this function with partial data), the classified
  // `codeownerApproved` check must also agree -- GitHub's `APPROVED` decision
  // no longer overrides it on its own.
  const codeownerSelfApproval = summarizeCodeownerSelfApproval({
    requireCodeOwnerReview: branchReviewRequirements.requireCodeOwnerReview,
    codeownerApprovalSatisfied:
      !branchReviewRequirements.requireCodeOwnerReview ||
      !hasExplicitCodeownerMatches ||
      codeownerApproved ||
      (reviewsUnreadable && normalizedReviewDecision === 'APPROVED'),
    hasExplicitCodeownerMatches,
    codeownerUserLogins: codeowners.codeownerUserLogins,
    eligibleCodeownerUserLogins:
      eligibleCodeownerUserLogins === null
        ? null
        : [...eligibleCodeownerUsers].sort(),
    eligibleCodeownerUserLoginsUnreadable,
    codeownerTeamSlugs: codeowners.codeownerTeamSlugs,
    codeownerEmailAddresses: codeowners.codeownerEmailAddresses,
    prAuthorLogin,
    viewerLogin,
    viewerTeamSlugs,
    viewerAppSlug,
    branchRules,
    branchRulesets,
    branchRulesetsUnreadable,
    classicRequireCodeOwnerReview:
      branchReviewRequirements.classicRequireCodeOwnerReview,
    classicBypassPullRequestUserLogins:
      branchReviewRequirements.classicBypassPullRequestUserLogins,
    classicBypassPullRequestTeamSlugs:
      branchReviewRequirements.classicBypassPullRequestTeamSlugs,
    classicBypassPullRequestAppSlugs:
      branchReviewRequirements.classicBypassPullRequestAppSlugs,
  });
  return {
    reviewDecision: normalizedReviewDecision,
    requiredApprovingReviewCount:
      branchReviewRequirements.requiredApprovingReviewCount,
    requireCodeOwnerReview: branchReviewRequirements.requireCodeOwnerReview,
    requiresConversationResolution:
      branchReviewRequirements.requiresConversationResolution,
    requiredReviewerLogins: branchReviewRequirements.requiredReviewerLogins,
    requiredReviewerTeams: branchReviewRequirements.requiredReviewerTeams,
    codeownerUserLogins: codeowners.codeownerUserLogins,
    codeownerTeamSlugs: codeowners.codeownerTeamSlugs,
    unmatchedCodeownerFiles: codeowners.unmatchedFiles,
    latestByAuthor,
    humanApprovedCount,
    // #1837: see the comment above `codeownerSelfApproval` for the shared
    // rationale. `reviewsUnreadable` keeps the pre-fix blanket-trust bypass
    // (first disjunct) only when review data genuinely could not be
    // classified. Otherwise (the normal, classifiable path -- the second
    // disjunct), an `APPROVED` aggregate is treated the same as an empty
    // one: it still must be corroborated by the classified
    // `humanApprovedCount` reaching the required threshold (or the
    // threshold being `0`, i.e. no approvals required at all -- nothing is
    // missing, so this stays a pass by design, not a gap).
    requiredApprovalsSatisfied:
      requiredReviewerApprovalsSatisfied &&
      ((reviewsUnreadable && normalizedReviewDecision === 'APPROVED') ||
        (!reviewsUnreadable &&
          (normalizedReviewDecision === 'APPROVED' ||
            !normalizedReviewDecision) &&
          (branchReviewRequirements.requiredApprovingReviewCount === 0 ||
            humanApprovedCount >=
              branchReviewRequirements.requiredApprovingReviewCount))),
    codeownerApprovalSatisfied:
      !branchReviewRequirements.requireCodeOwnerReview ||
      !hasExplicitCodeownerMatches ||
      codeownerApproved ||
      (reviewsUnreadable && normalizedReviewDecision === 'APPROVED'),
    codeownerSelfApproval,
    humanChangesRequestedCount: blockingChangesRequestedLogins.length,
    blockingChangesRequestedLogins,
  };
}
function summarizeCodeownerSelfApproval({
  requireCodeOwnerReview,
  codeownerApprovalSatisfied,
  hasExplicitCodeownerMatches,
  codeownerUserLogins = [],
  eligibleCodeownerUserLogins = null,
  eligibleCodeownerUserLoginsUnreadable = false,
  codeownerTeamSlugs = [],
  codeownerEmailAddresses = [],
  prAuthorLogin = '',
  viewerLogin = '',
  viewerTeamSlugs = [],
  viewerAppSlug = '',
  branchRules = [],
  branchRulesets = [],
  branchRulesetsUnreadable = false,
  classicRequireCodeOwnerReview = false,
  classicBypassPullRequestUserLogins = [],
  classicBypassPullRequestTeamSlugs = [],
  classicBypassPullRequestAppSlugs = [],
}) {
  const normalizedAuthor = String(prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  const normalizedViewer = String(viewerLogin ?? '')
    .trim()
    .toLowerCase();
  const normalizedViewerAppSlug = String(viewerAppSlug ?? '')
    .trim()
    .toLowerCase();
  const normalizedViewerTeamSlugs =
    normalizeTrustedMarkerLogins(viewerTeamSlugs);
  const directCodeownerUserLogins =
    normalizeTrustedMarkerLogins(codeownerUserLogins);
  const eligibleDirectCodeownerUserLogins =
    eligibleCodeownerUserLogins === null
      ? directCodeownerUserLogins
      : normalizeTrustedMarkerLogins(eligibleCodeownerUserLogins).filter(
          (login) => directCodeownerUserLogins.includes(login),
        );
  const normalizedCodeownerTeamSlugs =
    normalizeTrustedMarkerLogins(codeownerTeamSlugs);
  const normalizedCodeownerEmailAddresses = normalizeTrustedMarkerLogins(
    codeownerEmailAddresses,
  );
  const classicBypassDetected = Boolean(
    Boolean(classicRequireCodeOwnerReview) &&
      ((normalizedViewer &&
        normalizeTrustedMarkerLogins(
          classicBypassPullRequestUserLogins,
        ).includes(normalizedViewer)) ||
        normalizedViewerTeamSlugs.some((slug) => {
          return normalizeTrustedMarkerLogins(
            classicBypassPullRequestTeamSlugs,
          ).includes(slug);
        }) ||
        (normalizedViewerAppSlug &&
          normalizeTrustedMarkerLogins(
            classicBypassPullRequestAppSlugs,
          ).includes(normalizedViewerAppSlug))),
  );
  const bypass = summarizeRulesetPullRequestBypass(
    branchRulesets,
    branchRules,
    branchRulesetsUnreadable,
  );
  const rulesetGateSatisfiedByBypass =
    bypass.relevantRulesetCount === 0 || bypass.detected;
  const classicGateSatisfiedByBypass =
    !classicRequireCodeOwnerReview || classicBypassDetected;
  const applicableBypassDetected =
    (bypass.detected || classicBypassDetected) &&
    rulesetGateSatisfiedByBypass &&
    classicGateSatisfiedByBypass;
  const applicableBypassMode = applicableBypassDetected
    ? bypass.detected
      ? bypass.mode
      : 'pull_request'
    : 'none';
  // Hoisted above `base` (moved up from its original position further down,
  // right before the `deadlock` branch that also consumes it) so the #1521
  // `prAuthorIsSoleEligibleCodeowner` field below can reuse this exact
  // expression instead of recomputing an equivalent one. Pure and
  // side-effect-free, so hoisting it earlier changes nothing about the
  // later branches that also read it.
  const allDirectUsersAreAuthor =
    eligibleDirectCodeownerUserLogins.length > 0 &&
    eligibleDirectCodeownerUserLogins.every(
      (login) => login === normalizedAuthor,
    );
  // #1521: additive topology fact, computed independently of `status` /
  // `applicableBypassDetected` below and exposed on every branch (not just
  // the `deadlock` one). This is the ONLY safe discriminator an F3 caller
  // may use to gate an automatic `--admin` retry: `status: 'clear'` alone
  // (whether via `applicableBypassDetected` or `hasNonAuthorDirectUser`
  // further down) does NOT prove the PR author is the sole codeowner --
  // `applicableBypassDetected` fires whenever a bypass actor is configured
  // for the viewer, regardless of whether a genuinely distinct non-author
  // codeowner's review is separately outstanding. Deliberately NOT folded
  // into `status`/`reason` themselves (that general gate intentionally
  // keeps its existing pass/fail shape for every adopter repo -- see the
  // #1521 review discussion); a caller that needs the narrow self-deadlock
  // fact must check this field explicitly alongside `status`/`reason`.
  //
  // Requires `!eligibleCodeownerUserLoginsUnreadable` (Codex review, #1521):
  // `eligibleDirectCodeownerUserLogins` can be silently NARROWED by a
  // transient permission-lookup failure for some OTHER direct codeowner
  // (see `resolveEligibleCodeownerUserLogins` in pre-merge-readiness.mts),
  // which would make the author look like the sole eligible codeowner even
  // though a real co-owner's eligibility simply could not be confirmed.
  // Fail closed rather than trust a possibly-incomplete narrowed set.
  const prAuthorIsSoleEligibleCodeowner =
    Boolean(normalizedAuthor) &&
    normalizedCodeownerTeamSlugs.length === 0 &&
    normalizedCodeownerEmailAddresses.length === 0 &&
    !eligibleCodeownerUserLoginsUnreadable &&
    allDirectUsersAreAuthor;
  const base = {
    status: 'not_applicable',
    reason: 'codeowner-review-not-required',
    prAuthorLogin: normalizedAuthor,
    directCodeownerUserLogins,
    codeownerTeamSlugs: normalizedCodeownerTeamSlugs,
    requireCodeOwnerReview: Boolean(requireCodeOwnerReview),
    codeownerApprovalSatisfied: Boolean(codeownerApprovalSatisfied),
    bypassDetected: applicableBypassDetected,
    bypassMode: applicableBypassMode,
    currentUserCanBypass: bypass.currentUserCanBypass,
    // #1380: true when a codeowner-requiring ruleset's *detail* read was
    // masked-404 unreadable, so `bypass.detected` could not rule out an
    // actual configured bypass. Diagnostic only -- never flips a `status`
    // to `clear` on its own -- but downgrades a would-be certain `deadlock`
    // below to the already-documented `possible_deadlock`.
    rulesetBypassUnreadable: bypass.unreadable,
    prAuthorIsSoleEligibleCodeowner,
    // #1521: true when at least one direct-user codeowner's
    // collaborator-permission lookup was unreadable (see
    // `prAuthorIsSoleEligibleCodeowner` above). Diagnostic only, mirroring
    // `rulesetBypassUnreadable`'s shape -- never flips `status` on its own.
    codeownerEligibilityUnreadable: Boolean(
      eligibleCodeownerUserLoginsUnreadable,
    ),
  };
  if (!requireCodeOwnerReview) {
    return base;
  }
  if (!hasExplicitCodeownerMatches) {
    return {
      ...base,
      reason: 'no-explicit-codeowner-match',
    };
  }
  if (codeownerApprovalSatisfied) {
    return {
      ...base,
      reason: 'codeowner-approval-satisfied',
    };
  }
  if (applicableBypassDetected) {
    return {
      ...base,
      status: 'clear',
      reason:
        applicableBypassMode === 'pull_request'
          ? 'pull-request-bypass-available'
          : 'ruleset-bypass-available',
    };
  }
  if (!normalizedAuthor) {
    return {
      ...base,
      status: 'possible_deadlock',
      reason: 'pr-author-unknown',
    };
  }
  // `allDirectUsersAreAuthor` is computed above (hoisted next to
  // `prAuthorIsSoleEligibleCodeowner` in `base`); reused here unchanged.
  const hasNonAuthorDirectUser = eligibleDirectCodeownerUserLogins.some(
    (login) => login !== normalizedAuthor,
  );
  if (hasNonAuthorDirectUser) {
    return {
      ...base,
      status: 'clear',
      reason: 'non-author-codeowner-available',
    };
  }
  if (normalizedCodeownerTeamSlugs.length > 0) {
    return {
      ...base,
      status: 'possible_deadlock',
      reason: 'team-codeowner-ambiguous',
    };
  }
  if (normalizedCodeownerEmailAddresses.length > 0) {
    return {
      ...base,
      status: 'possible_deadlock',
      reason: 'email-codeowner-ambiguous',
    };
  }
  if (allDirectUsersAreAuthor) {
    // #1380: a masked-404 on a relevant ruleset's detail read means
    // `bypass.detected` could not rule out an actual configured bypass for
    // this PR author -- asserting a *certain* `deadlock` here would be an
    // unjustified false-certainty diagnostic. Downgrade to the
    // already-documented `possible_deadlock` (idd-pre-merge.instructions.md:
    // "could not prove ... applicable pull-request bypass, so fail closed")
    // instead of inventing a new status value.
    if (bypass.unreadable) {
      return {
        ...base,
        status: 'possible_deadlock',
        reason: 'ruleset-bypass-unreadable',
      };
    }
    return {
      ...base,
      status: 'deadlock',
      reason:
        eligibleCodeownerUserLogins === null
          ? 'pr-author-is-only-direct-codeowner'
          : 'pr-author-is-only-eligible-direct-codeowner',
    };
  }
  return {
    ...base,
    status: 'possible_deadlock',
    reason: 'no-reviewable-codeowner-identity',
  };
}
function summarizeRulesetPullRequestBypass(
  branchRulesets = [],
  branchRules = [],
  branchRulesetsUnreadable = false,
) {
  const codeownerRulesetIds = new Set(
    (branchRules ?? [])
      .filter((rule) => {
        return (
          rule?.type === 'pull_request' &&
          Boolean(rule?.parameters?.require_code_owner_review)
        );
      })
      .map((rule) => Number.parseInt(String(rule?.ruleset_id ?? ''), 10))
      .filter(Number.isInteger),
  );
  const expectedRulesetCount = codeownerRulesetIds.size;
  const relevantRulesets = (branchRulesets ?? []).filter((ruleset) => {
    const rulesetId = Number.parseInt(
      String(ruleset?.id ?? ruleset?.ruleset_id ?? ''),
      10,
    );
    return codeownerRulesetIds.has(rulesetId);
  });
  const values = relevantRulesets
    .map((ruleset) => String(ruleset?.current_user_can_bypass ?? '').trim())
    .map((value) => {
      return ['always', 'exempt', 'never', 'pull_requests_only'].includes(value)
        ? value
        : 'unknown';
    })
    .filter(Boolean);
  let currentUserCanBypass = 'unknown';
  if (values.length > 1 && new Set(values).size > 1) {
    currentUserCanBypass = 'mixed';
  } else if (values.includes('exempt')) {
    currentUserCanBypass = 'exempt';
  } else if (values.includes('pull_requests_only')) {
    currentUserCanBypass = 'pull_requests_only';
  } else if (values.includes('always')) {
    currentUserCanBypass = 'always';
  } else if (values.includes('never')) {
    currentUserCanBypass = 'never';
  }
  const bypassValues = new Set(['always', 'exempt', 'pull_requests_only']);
  const detected =
    expectedRulesetCount > 0 &&
    relevantRulesets.length === expectedRulesetCount &&
    values.length === relevantRulesets.length &&
    values.every((value) => bypassValues.has(value));
  let mode = 'none';
  if (detected) {
    if (new Set(values).size > 1) {
      mode = 'mixed';
    } else if (values.includes('pull_requests_only')) {
      mode = 'pull_request';
    } else if (values.includes('always')) {
      mode = 'always';
    } else if (values.includes('exempt')) {
      mode = 'exempt';
    }
  }
  // #1380: only report `unreadable` when a *relevant* (codeowner-requiring)
  // ruleset is actually missing from `relevantRulesets` -- not merely
  // whenever `detected` is `false`, since a fully-read ruleset can
  // legitimately report a real, non-bypass value (e.g. `never`) that also
  // makes `detected` false. That is genuine data, not a masked-404 gap, and
  // must not be relabeled as "could not determine". A masked-404 on a
  // relevant ruleset's detail read only ever *prevents* `detected` from
  // becoming `true` (the count check above requires every expected
  // ruleset's detail to be present), so this can never cause a false
  // `detected: true`.
  const unreadable =
    branchRulesetsUnreadable &&
    expectedRulesetCount > 0 &&
    relevantRulesets.length < expectedRulesetCount;
  return {
    detected,
    mode,
    currentUserCanBypass,
    relevantRulesetCount: expectedRulesetCount,
    unreadable,
  };
}
export function resolveRulesetDetailPath(owner, repo, rule, rulesetId) {
  const sourceType = String(
    rule?.ruleset_source_type ?? rule?.source_type ?? '',
  )
    .trim()
    .toLowerCase();
  if (sourceType === 'organization') {
    const source = String(rule?.ruleset_source ?? rule?.source ?? owner).trim();
    const org = source.split('/')[0] || owner;
    return `orgs/${encodeURIComponent(org)}/rulesets/${rulesetId}`;
  }
  if (sourceType === 'enterprise') {
    const source = String(rule?.ruleset_source ?? rule?.source ?? '').trim();
    const enterprise = source.split('/')[0];
    if (enterprise) {
      return `enterprises/${encodeURIComponent(enterprise)}/rulesets/${rulesetId}`;
    }
  }
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rulesets/${rulesetId}`;
}
/**
 * Resolve a PR's first-commit time as an ISO string -- the minimum across all
 * commits of each commit's committer date, falling back to author date. A
 * GitHub `pulls/{pr}/commits` listing is chronological, but compute the
 * minimum defensively rather than relying on order. Returns `null` when no
 * commit carries a parseable date, which makes the Part B gate below fail
 * closed (an `issue-only` handoff against a PR-backed claim stays rejected).
 *
 * Shared by every `prFirstCommitAt` resolver (`pre-merge-readiness.mts`,
 * `advisory-convergence.mts`, `live-status-digest.mts`) so the Part B
 * allowance's date computation has one implementation, not three.
 */
export function resolvePrFirstCommitAt(commits) {
  let earliestMs = null;
  let earliestIso = null;
  for (const commit of commits) {
    const date =
      String(commit?.commit?.committer?.date ?? '').trim() ||
      String(commit?.commit?.author?.date ?? '').trim();
    if (!date) {
      continue;
    }
    const ms = Date.parse(date);
    if (!Number.isFinite(ms)) {
      continue;
    }
    if (earliestMs === null || ms < earliestMs) {
      earliestMs = ms;
      earliestIso = date;
    }
  }
  return earliestIso;
}
/**
 * Build the `isForcedHandoffEnabled` gate shared by every claim-revalidation
 * path (resume routing, the merge-gate, and the write-side helpers).
 *
 * Semantics:
 *
 * - forced-handoff mode disabled → never honor;
 * - no open linked PR backs the claim (`expectedLinkedPrReferences` empty) →
 *   honor an `issue-only` (or any) handoff as before;
 * - an open linked PR backs the claim:
 *   - `issue-plus-pr` handoff → require `linkedPr` to match one of the
 *     expected PRs (unchanged behavior);
 *   - `issue-only` handoff → accept it IFF a `prFirstCommitAt` is supplied
 *     AND the handoff's `createdAt` is a valid ISO timestamp strictly before
 *     it (the handoff predates the PR, so the successor created the PR after
 *     taking over the issue). Any other `issue-only` handoff is rejected.
 *
 * The `prFirstCommitAt` parameter is the Part B extension (#1058). Callers
 * that do not pass it keep the original behavior byte-identical: an
 * `issue-only` handoff against a PR-backed claim is rejected.
 */
export function buildForcedHandoffEnableGate(options) {
  const { forcedHandoffEnabled, expectedLinkedPrReferences } = options;
  const prFirstCommitAt =
    typeof options.prFirstCommitAt === 'string' ? options.prFirstCommitAt : '';
  return (forcedHandoff) => {
    if (!forcedHandoffEnabled) {
      return false;
    }
    if (expectedLinkedPrReferences.size === 0) {
      return true;
    }
    if (forcedHandoff.contextScope === 'issue-plus-pr') {
      return expectedLinkedPrReferences.has(
        normalizeLinkedPrReference(forcedHandoff.linkedPr),
      );
    }
    // issue-only handoff against a PR-backed claim: accept only when it
    // predates the PR's first commit (a robust ISO compare; either side
    // unparseable → fail closed = reject).
    return isStrictlyBeforeIso(forcedHandoff.createdAt, prFirstCommitAt);
  };
}
/**
 * Resolve the active claim for a write-side merge-gate revalidation, honoring
 * an operator-approved forced handoff while failing closed on
 * unauthorized/forged markers exactly as the Resume routing path does.
 *
 * This is the centralized, pure (no I/O) helper used by the write-side
 * helpers (disposition-non-review-notices, resolve-review-thread) so they no
 * longer ignore forced handoffs. It builds the same forced-handoff enable
 * gate as `summarizeClaimValidation` / `buildForcedHandoffEnabledGate`
 * (extended with the Part B time rule) and delegates the rest of the
 * fail-closed enforcement to `applyClaimEvent` rule 7.
 *
 * - `forcedHandoffEnabled` defaults to `false` (forced handoffs ignored).
 * - `expectedLinkedPrs` of `null`/empty marks an issue-scoped revalidation:
 *   an `issue-only` handoff is accepted (issue takeover). A non-empty set
 *   marks a PR-backed claim and applies the `issue-plus-pr` / `prFirstCommitAt`
 *   rules.
 * - `isAuthorizedForcedHandoff` defaults to an allowlist of ∅ ⇒ always false
 *   (every handoff is treated as unauthorized) when not supplied, so callers
 *   that forget to wire it fail closed.
 * - `requireAuthorMatchesForcedBy` defaults to `true` (the strict
 *   self-signed-hijack block used by Resume routing).
 * - `staleAgeMs` (#1310) is an optional config-aware claim-staleness window,
 *   in milliseconds (a parsed `claimTiming.staleAge`). When omitted, invalid
 *   (non-numeric/non-finite), or non-positive, staleness falls back to the
 *   hardcoded 24h `isStaleAt` default unchanged — so callers that do not
 *   pass it keep today's exact behavior. See `isStaleByAge`.
 */
export function resolveActiveClaimForWriteGate(events, options) {
  const expectedLinkedPrReferences = new Set(
    (options.expectedLinkedPrs ?? [])
      .map((value) => normalizeLinkedPrReference(value))
      .filter(Boolean),
  );
  const isForcedHandoffEnabled = buildForcedHandoffEnableGate({
    forcedHandoffEnabled: options.forcedHandoffEnabled === true,
    expectedLinkedPrReferences,
    prFirstCommitAt: options.prFirstCommitAt ?? null,
  });
  return resolveActiveClaim(events, {
    isTrustedAuthor: options.isTrustedAuthor,
    isForcedHandoffEnabled,
    isAuthorizedForcedHandoff:
      typeof options.isAuthorizedForcedHandoff === 'function'
        ? options.isAuthorizedForcedHandoff
        : () => false,
    requireAuthorMatchesForcedBy: options.requireAuthorMatchesForcedBy ?? true,
    isStale: resolveStalePredicate(options.staleAgeMs),
  });
}
export function summarizeClaimValidation(claimEvents = [], options = {}) {
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const authorizedForcedHandoffLogins = new Set(
    normalizeTrustedMarkerLogins(options.authorizedForcedHandoffLogins ?? []),
  );
  const expectedLinkedPrReferences = new Set(
    (options.expectedLinkedPrs ?? [])
      .map((value) => normalizeLinkedPrReference(value))
      .filter(Boolean),
  );
  const expectedClaimId = String(options.expectedClaimId ?? '').trim();
  const expectedAgentId = String(options.expectedAgentId ?? '').trim();
  const trustedAuthorPredicate =
    typeof options.isTrustedAuthor === 'function'
      ? options.isTrustedAuthor
      : (login) =>
          trustedMarkerLogins.has(
            String(login ?? '')
              .trim()
              .toLowerCase(),
          );
  // Merge-side write-gate forced-handoff strictness — intentionally the
  // lenient half of the strict-resume vs. lenient-relay-merge split (see
  // docs/idd-design-rationale.md, "Claim resolution"). This call leaves
  // `requireAuthorMatchesForcedBy` at its lenient default (off) so a
  // maintainer-authorized handoff relayed by a separate automation actor is
  // still honored — authorization rests on `isAuthorizedForcedHandoff` alone —
  // and it passes `prFirstCommitAt` so the Part-B allowance (#1058, an
  // issue-only handoff predating the PR) applies. resume-claim-routing.mts
  // deliberately does the opposite (`requireAuthorMatchesForcedBy: true`, no
  // `prFirstCommitAt`) because a takeover decision must block the same-identity
  // self-signed hijack. The two callers can therefore return different verdicts
  // for the same corrected-handoff state (resume `already_owned` vs. merge
  // `claimLost`) by design; both still funnel through the single
  // resolveActiveClaim resolver.
  const activeClaim = resolveActiveClaim(claimEvents, {
    isTrustedAuthor: trustedAuthorPredicate,
    isForcedHandoffEnabled:
      typeof options.isForcedHandoffEnabled === 'function'
        ? options.isForcedHandoffEnabled
        : buildForcedHandoffEnableGate({
            forcedHandoffEnabled: options.forcedHandoffEnabled === true,
            expectedLinkedPrReferences,
            prFirstCommitAt: options.prFirstCommitAt ?? null,
          }),
    isAuthorizedForcedHandoff:
      typeof options.isAuthorizedForcedHandoff === 'function'
        ? options.isAuthorizedForcedHandoff
        : (forcedBy) => {
            if (authorizedForcedHandoffLogins.size === 0) {
              return false;
            }
            return authorizedForcedHandoffLogins.has(
              String(forcedBy ?? '')
                .trim()
                .toLowerCase(),
            );
          },
    isStale: resolveStalePredicate(options.staleAgeMs),
  });
  const expectedNonce = String(options.expectedNonce ?? '').trim();
  let reason = 'match';
  if (!activeClaim) {
    reason = 'missing-active-claim';
  } else if (expectedClaimId && activeClaim.claimId !== expectedClaimId) {
    reason = 'claim-id-mismatch';
  } else if (expectedAgentId && activeClaim.agentId !== expectedAgentId) {
    reason = 'agent-id-mismatch';
  } else if (expectedClaimId && expectedNonce) {
    // #1528: mirrors evaluateResumeClaimRouting's activation-nonce-mismatch
    // check (resume-claim-routing.mts) -- only meaningful once claim-id and
    // agent-id already match, since claim-id alone cannot distinguish a
    // second, independent activation of the same id. Computed lazily, here,
    // so every pre-#1528 caller that never passes expectedNonce (the
    // default) pays no parsing/sorting cost for it. Trust-filter first
    // (findActivationNonceWinner does no author checks of its own), matching
    // how the resume-side caller pre-filters before calling the same shared
    // primitive.
    const activationNonceWinner = findActivationNonceWinner(
      claimEvents.filter((event) =>
        trustedAuthorPredicate(event.author?.login ?? event.user?.login ?? ''),
      ),
      activeClaim.claimId,
    );
    if (
      activationNonceWinner !== null &&
      activationNonceWinner !== expectedNonce
    ) {
      reason = 'activation-nonce-mismatch';
    }
  }
  return {
    expectedClaimId,
    expectedAgentId,
    activeClaimPresent: Boolean(activeClaim),
    activeClaim: {
      agentId: activeClaim?.agentId ?? '',
      claimId: activeClaim?.claimId ?? '',
      supersedes: activeClaim?.supersedes ?? '',
      branch: activeClaim?.branch ?? '',
      createdAt: activeClaim?.createdAt ?? '',
    },
    matchesExpectedClaim: reason === 'match',
    claimLost: reason !== 'match',
    reason,
  };
}
function preMergeAsRecord(value) {
  return value && typeof value === 'object' ? value : {};
}
function isPreMergeCiAllPassing(ci) {
  // #1377: an unreadable protection/ruleset read means the required-check
  // set this report computed may be incomplete -- a masked 404 can hide
  // additional required checks the readable source(s) never surfaced. Block
  // unconditionally here, before either shortcut below, so a passing
  // subset of (possibly incomplete) required checks can never mark the
  // report ready.
  if (ci.protectionReadsUnreadable === true) {
    return false;
  }
  if (ci.requiredChecksPassing === true || ci.status === 'success') {
    return true;
  }
  return (
    ci.noRequiredChecksConfigured === true &&
    String(ci.presentRunConclusion ?? '') === 'all-passing'
  );
}
function isPreMergeReviewSatisfied(reviewerStates) {
  if (reviewerStates.requiredApprovalsSatisfied !== true) {
    return false;
  }
  if (reviewerStates.codeownerApprovalSatisfied === true) {
    return true;
  }
  const selfApproval = preMergeAsRecord(reviewerStates.codeownerSelfApproval);
  return String(selfApproval.status ?? '') === 'clear';
}
/**
 * Roll up the F2/F3 merge gates from a pre-merge-readiness report into the
 * ordered blocker list. This is the single source of the merge-gate AND:
 * `buildPreMergeReadinessSummary` embeds `{ ready, blockers }` computed from it,
 * and `idd-merge-execute.evaluateMergeGates` delegates to it, so no caller
 * re-implements the conjunction. Fail-closed on missing or garbled
 * evidence. Applies the written F2 ack-only overrides (#2125) so a
 * `fully_autonomous_merge` F3 session can complete when courtesy
 * advisory-bot acks are the sole remaining currency or disposition
 * blocker; any other cause still blocks. A live `BLOCKED` merge state
 * plus a non-empty discarded required-check sibling list is its own
 * gate (#2127) and does not take the `--admin` path.
 */
export function computePreMergeReadinessBlockers(report) {
  const blockers = [];
  // Fail closed on a missing/invalid head: `prHeadSha` binds
  // `--match-head-commit`, so a non-40-hex value must never yield a "ready"
  // verdict with an unsafe merge binding.
  const prHeadSha = String(report.prHeadSha ?? '');
  if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
    blockers.push({
      gate: 'head-sha',
      detail: `prHeadSha "${prHeadSha}" is not a 40-hex commit SHA; cannot bind a safe merge`,
    });
  }
  const reviewCurrency = preMergeAsRecord(report.reviewCurrency);
  const comparisonRoute = String(reviewCurrency.comparisonRoute ?? '');
  const comparisonReason = String(reviewCurrency.comparisonReason ?? '');
  // #2125: F2's ack-only-post-disposition carve-out is now applied here
  // too, so F3 merge-execute does not livelock on CodeRabbit courtesy acks.
  if (
    comparisonRoute !== 'proceed' &&
    !(
      comparisonRoute === 'return-to-e1' &&
      comparisonReason === 'ack-only-post-disposition'
    )
  ) {
    blockers.push({
      gate: 'review-currency',
      detail: `comparisonRoute is "${comparisonRoute}" (expected "proceed"): ${comparisonReason || 'unknown'}`,
    });
  }
  const threads = preMergeAsRecord(report.threads);
  const actionableCount = Number(threads.actionableCount ?? -1);
  if (actionableCount !== 0) {
    blockers.push({
      gate: 'unresolved-threads',
      detail: `actionableCount is ${actionableCount} (expected 0)`,
    });
  }
  // #2335: optional caller-computed evidence -- an entirely absent
  // `report.secondaryQuietWindow` (a caller that predates this gate, or a
  // hand-built fixture) never blocks, the same backward-compat precedent
  // the `copilotUnavailable` gate below uses. A present evidence object
  // with `elapsed !== true` blocks; `buildSecondaryQuietWindowStatus`
  // itself already reports `elapsed: true` unconditionally when the
  // window is off (`0`/absent) or has no activity to anchor on, so this
  // never fires for an adopter that has not configured
  // `advisoryWait.secondaryQuietWindow`.
  if (report.secondaryQuietWindow !== undefined) {
    const secondaryQuietWindow = preMergeAsRecord(report.secondaryQuietWindow);
    if (secondaryQuietWindow.elapsed !== true) {
      blockers.push({
        gate: 'secondary-quiet-window',
        detail: `advisoryWait.secondaryQuietWindow (${String(secondaryQuietWindow.minutes ?? 0)} min) has not elapsed since the last substantive activity at "${String(secondaryQuietWindow.anchorAt ?? 'none')}" -- ${String(secondaryQuietWindow.remainingMinutes ?? 'unknown')} minute(s) remaining`,
      });
    }
  }
  const advisoryWait = preMergeAsRecord(report.advisoryWait);
  const f3Outcome = String(advisoryWait.f3Outcome ?? '');
  if (f3Outcome !== 'SATISFIED') {
    blockers.push({
      gate: 'advisory-wait',
      detail: `f3Outcome is "${f3Outcome}" (expected "SATISFIED")`,
    });
  }
  // #1570: a settled-but-unreviewed Copilot request (`f3Outcome:
  // "SATISFIED"` once `copilotPending` goes `false`, per
  // `evaluateAdvisoryWaitF3Outcome`'s deliberate settled-path shortcut) must
  // NOT merge unattended when the terminal `#1572` recovery contract has
  // separately proven Copilot unavailable on this HEAD -- `f3Outcome` itself
  // is intentionally left untouched (see `buildPreMergeReadinessSummary`'s
  // module notes) so this is a DEDICATED, additive blocker rather than a
  // change to the `advisory-wait` gate above. Only fires when the caller
  // supplied `copilotUnavailable: true` (computed from
  // `buildCopilotRecoverySummary`); omitted/false never fires, so a caller
  // that has not wired this evidence sees unchanged behavior. A valid
  // maintainer waiver for the `idd-advisory-convergence` selector (the same
  // evidence the CI gate consumes, see advisory-convergence.mts) clears it.
  if (
    advisoryWait.copilotUnavailable === true &&
    advisoryWait.copilotUnavailableWaived !== true
  ) {
    blockers.push({
      gate: 'copilot-terminal-unavailable',
      detail:
        'Copilot is terminally unavailable on current HEAD (recovery cap exhausted and terminal window elapsed with no current-HEAD review) with no valid maintainer external-check waiver and no active provider-outage declaration relief for selector ' +
        `"${DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR}"`,
    });
  }
  const ci = preMergeAsRecord(report.ci);
  if (!isPreMergeCiAllPassing(ci)) {
    // #1689: name the source-pinned cause explicitly when a required check
    // is otherwise green but its ruleset entry carries an
    // `app_id`/`integration_id` this helper cannot verify -- see
    // `summarizeRequiredChecks`'s `sourcePinnedRequiredCheckNames` doc
    // comment. Checked before the masked-403-as-404 detail below since the
    // two causes are mutually exclusive (the source-pinned downgrade only
    // fires on a genuinely readable required-check set).
    const sourcePinnedNames = Array.isArray(ci.sourcePinnedRequiredCheckNames)
      ? ci.sourcePinnedRequiredCheckNames.map((name) => String(name ?? ''))
      : [];
    // #1689: a pinned source that could not be attributed to any check name
    // (a ruleset `workflows` rule, or a pinned entry with no `context`/
    // `name`/`check`) -- see `sourcePinnedRequiredCheckNames`'s doc comment.
    // Checked so the detail still names the source-pinned cause even when
    // `sourcePinnedNames` above is empty (or only partially covers the
    // pinning, in the mixed case), and so the opt-in caveat only appears
    // when it is actually relevant (an unresolvable source is never
    // covered by `trustSourcePinnedRequiredChecks`).
    const sourcePinnedUnresolved = ci.sourcePinnedUnresolved === true;
    let sourcePinnedDetail = '';
    if (sourcePinnedNames.length > 0 && sourcePinnedUnresolved) {
      sourcePinnedDetail = `required ${sourcePinnedNames.length > 1 ? 'checks' : 'check'} ${sourcePinnedNames.join(', ')}, plus an unresolvable source-pinned required-check requirement (e.g. a ruleset \`workflows\` rule), are source-pinned; producer verification unavailable (set ciGate.trustSourcePinnedRequiredChecks to opt in for the named check(s); the unresolvable source is never covered by this opt-in)`;
    } else if (sourcePinnedNames.length > 0) {
      sourcePinnedDetail = `required ${sourcePinnedNames.length > 1 ? 'checks' : 'check'} ${sourcePinnedNames.join(', ')} ${sourcePinnedNames.length > 1 ? 'are' : 'is'} source-pinned; producer verification unavailable (set ciGate.trustSourcePinnedRequiredChecks to opt in once the pinned integration is verified)`;
    } else if (sourcePinnedUnresolved) {
      sourcePinnedDetail =
        'an unresolvable source-pinned required-check requirement is in force (e.g. a ruleset `workflows` rule); producer verification unavailable, and this cause is never covered by the ciGate.trustSourcePinnedRequiredChecks opt-in';
    }
    // #1377: name the masked-403-as-404 cause explicitly when that is why the
    // gate is not all-passing, matching idd-ci.instructions.md's wording,
    // instead of the generic status/noRequiredChecksConfigured detail below.
    let detail =
      ci.protectionReadsUnreadable === true
        ? 'cannot determine required checks: protection/ruleset unreadable'
        : sourcePinnedDetail ||
          `CI is not all-passing (status="${String(ci.status ?? '')}", noRequiredChecksConfigured=${Boolean(ci.noRequiredChecksConfigured)}, presentRunConclusion="${String(ci.presentRunConclusion ?? '')}")`;
    // #2021: when the `idd-advisory-convergence` check itself is present,
    // required, and non-passing, and a posted otherwise-valid waiver exists
    // for it but is not yet covering the check because its deadline/
    // terminal precondition has not opened (see
    // `advisoryConvergenceWaiverPrecondition` in
    // `buildPreMergeReadinessSummary`), append that evidence -- including
    // the remaining time-to-deadline -- so an agent reading this blocker
    // does not have to independently re-derive it or mistake "waiver
    // posted" for "check covered". Scoped to that specific check (not just
    // "some ci blocker exists") so an unrelated failing check (e.g. lint)
    // never gets this note appended.
    const advisoryConvergencePrecondition = preMergeAsRecord(
      report.advisoryConvergenceWaiverPrecondition,
    );
    const advisoryConvergenceCheckSelector = String(
      advisoryConvergencePrecondition.checkSelector ?? '',
    );
    const advisoryConvergenceCheckNonPassing =
      advisoryConvergenceCheckSelector &&
      Array.isArray(ci.checks) &&
      ci.checks.some(
        (check) =>
          check?.required === true &&
          check?.coveredByWaiver !== true &&
          !CHECK_PASS_EQUIVALENT_STATES.has(String(check?.state ?? '')) &&
          matchCheckSelectorLocal(
            check?.name,
            advisoryConvergenceCheckSelector,
          ),
      );
    const waiverEvidenceForDetail = preMergeAsRecord(report.waiverEvidence);
    const waiverEvidenceValidList = Array.isArray(waiverEvidenceForDetail.valid)
      ? waiverEvidenceForDetail.valid
      : [];
    // #2021 (Codex review on PR #2033): distinguish an EXACT-selector waiver
    // (the only kind `advisory-convergence.mts`'s own gate ever counts, see
    // `advisoryConvergenceExactWaiverValid` in `buildPreMergeReadinessSummary`)
    // from a broader glob-only match, so this detail never implies "posting
    // an exact waiver and waiting out the deadline is sufficient" when the
    // real cause is that only a glob selector (e.g. `idd-*`) targets this
    // check -- that never converges no matter how long the deadline waits.
    const advisoryConvergenceExactWaiverEntries =
      waiverEvidenceValidList.filter(
        (entry) =>
          String(entry?.checkSelector ?? '') ===
          advisoryConvergenceCheckSelector,
      );
    const advisoryConvergenceExactWaiverCount =
      advisoryConvergenceExactWaiverEntries.length;
    const advisoryConvergenceAnyWaiverCount = waiverEvidenceValidList.filter(
      (entry) =>
        matchCheckSelectorLocal(
          advisoryConvergenceCheckSelector,
          entry?.checkSelector,
        ),
    ).length;
    const advisoryConvergencePreconditionOpenForDetail =
      advisoryConvergencePrecondition.open === true;
    if (
      advisoryConvergenceCheckNonPassing &&
      advisoryConvergenceAnyWaiverCount > 0
    ) {
      const deadlineMinutes = Number(
        advisoryConvergencePrecondition.deadlineMinutes ?? 0,
      );
      const elapsedMinutes = advisoryConvergencePrecondition.elapsedMinutes;
      const remainingMinutes =
        typeof elapsedMinutes === 'number'
          ? Math.max(0, deadlineMinutes - elapsedMinutes)
          : null;
      const reasons = [];
      if (!advisoryConvergencePreconditionOpenForDetail) {
        reasons.push(
          'its deadline/terminal precondition has not opened -- ' +
            `deadlineMinutes=${deadlineMinutes}, ` +
            `elapsedMinutes=${elapsedMinutes ?? 'unknown'}, ` +
            `remainingMinutes=${remainingMinutes ?? 'unknown'}, ` +
            `terminalUnavailable=${Boolean(advisoryConvergencePrecondition.terminalUnavailable)}`,
        );
      }
      if (advisoryConvergenceExactWaiverCount === 0) {
        reasons.push(
          'no posted waiver has a selector that EXACTLY equals ' +
            `"${advisoryConvergenceCheckSelector}" (only a broader/glob ` +
            "selector matches this check by name); advisory-convergence.mts's " +
            'own gate never counts a glob match for its own selector, so ' +
            'this check cannot converge via that waiver regardless of the ' +
            'precondition',
        );
      }
      // #2034: precondition open AND an exact-match waiver exists, yet the
      // check is still reported non-passing -- the only remaining cause is
      // the rerun-freshness gate: the check's own live run last completed
      // before the waiver became genuinely active. Name the stale run's
      // `completedAt` and the waiver's own `createdAt` explicitly, mirroring
      // the other two reasons, instead of leaving an agent to re-derive why
      // an apparently-satisfied waiver still left the check blocked.
      if (
        advisoryConvergencePreconditionOpenForDetail &&
        advisoryConvergenceExactWaiverCount > 0 &&
        reasons.length === 0
      ) {
        const staleCheck = Array.isArray(ci.checks)
          ? ci.checks.find(
              (check) =>
                check?.required === true &&
                check?.coveredByWaiver !== true &&
                !CHECK_PASS_EQUIVALENT_STATES.has(String(check?.state ?? '')) &&
                matchCheckSelectorLocal(
                  check?.name,
                  advisoryConvergenceCheckSelector,
                ),
            )
          : undefined;
        const staleCompletedAt =
          String(staleCheck?.completedAt ?? '') || 'none';
        const waiverCreatedAts = advisoryConvergenceExactWaiverEntries
          .map((entry) => String(entry?.createdAt ?? 'none'))
          .join(', ');
        // The deadline path has a real, computable activation override (the
        // deadline-open moment); the terminal-unavailability path does not,
        // so the cutoff there is the waiver's own createdAt alone -- naming
        // both unconditionally would misstate the terminal case.
        const activeSinceDescription =
          advisoryConvergencePrecondition.deadlinePassed === true
            ? `not at or after the waiver's own createdAt (${waiverCreatedAts}) ` +
              'or the #2021 deadline precondition-open moment, whichever is later'
            : `not at or after the waiver's own createdAt (${waiverCreatedAts})`;
        reasons.push(
          `its live run last completed at "${staleCompletedAt}", which is ` +
            `${activeSinceDescription} -- rerun the check so its live run ` +
            'reflects the waiver before trusting this as covered',
        );
      }
      if (reasons.length > 0) {
        detail +=
          ` (a posted external-check waiver exists for current HEAD but is ` +
          `not yet covering "${advisoryConvergenceCheckSelector}": ${reasons.join('; ')})`;
      }
    }
    blockers.push({ gate: 'ci', detail });
  }
  const reviewerStates = preMergeAsRecord(report.reviewerStates);
  if (!isPreMergeReviewSatisfied(reviewerStates)) {
    const selfApproval = preMergeAsRecord(reviewerStates.codeownerSelfApproval);
    // #1380: name the masked-403-as-404 ruleset-detail cause explicitly when
    // that is *why* the required-reviews gate is unmet, mirroring the CI
    // gate's `protectionReadsUnreadable`-specific detail above, instead of
    // the generic status detail below. Gate on the specific `reason` (set
    // only by the one branch in `summarizeCodeownerSelfApproval` that
    // actually resolved to this cause), not the bare
    // `rulesetBypassUnreadable` boolean: that flag is present on every
    // returned branch (it lives on `base`), so an unrelated resolution --
    // e.g. `possible_deadlock`/`team-codeowner-ambiguous` -- could also
    // carry `rulesetBypassUnreadable: true` (the same fetch that flagged
    // the ruleset unreadable) while the real blocking cause is the
    // ambiguous team, not the unreadable ruleset. Naming the wrong cause
    // would misdirect an operator's remediation.
    const detail =
      selfApproval.reason === 'ruleset-bypass-unreadable'
        ? 'cannot determine CODEOWNER ruleset bypass: ruleset detail unreadable'
        : `required/CODEOWNER reviews not satisfied (requiredApprovalsSatisfied=${Boolean(reviewerStates.requiredApprovalsSatisfied)}, codeownerApprovalSatisfied=${Boolean(reviewerStates.codeownerApprovalSatisfied)}, codeownerSelfApproval.status="${String(selfApproval.status ?? '')}")`;
    blockers.push({ gate: 'required-reviews', detail });
  }
  const claim = preMergeAsRecord(report.claim);
  if (claim.matchesExpectedClaim !== true) {
    blockers.push({
      gate: 'claim-ownership',
      detail: `claim ownership does not match (reason="${String(claim.reason ?? 'unknown')}")`,
    });
  }
  const dispositionEvidence = preMergeAsRecord(report.dispositionEvidence);
  // The written F2/F3 gate requires BOTH `route === 'proceed'` AND
  // `blockingCount === 0`, except the documented F2 override when
  // `soleCauseAckOnlyPostDisposition` is exactly true (#2125). Fail
  // closed on a non-zero or non-numeric blockingCount otherwise.
  const dispositionRoute = String(dispositionEvidence.route ?? '');
  const dispositionBlockingCount = Number(
    dispositionEvidence.blockingCount ?? -1,
  );
  const soleCauseAckOnlyPostDisposition =
    dispositionEvidence.soleCauseAckOnlyPostDisposition === true &&
    dispositionRoute === 'return-to-e1' &&
    Number.isInteger(dispositionBlockingCount) &&
    dispositionBlockingCount > 0;
  if (
    !soleCauseAckOnlyPostDisposition &&
    (dispositionRoute !== 'proceed' || dispositionBlockingCount !== 0)
  ) {
    blockers.push({
      gate: 'disposition-evidence',
      detail: `dispositionEvidence.route is "${dispositionRoute || 'missing'}" (expected "proceed"), blockingCount=${dispositionBlockingCount} (expected 0)`,
    });
  }
  // #1513: fail closed on a missing/garbled `requiresUpToDateHead` -- only
  // an explicit `false` counts as "not required" (matching every gate
  // above's fail-closed promise); an absent/non-boolean value defaults to
  // "required." Scoped to the literal `BEHIND` value only: `UNKNOWN`/null
  // is the async-still-computing state that `idd-pre-merge.instructions.md`
  // F1 and `idd-review-triage.instructions.md`'s E-phase branch-sync check
  // already re-poll as transient, not terminal -- out of this gate's scope.
  // Every other non-BEHIND `gh pr merge` rejection is caught by
  // `idd-merge-execute.mts`'s `deps.mergePr` try/catch instead.
  const branchCurrency = preMergeAsRecord(report.branchCurrency);
  const requiresUpToDateHead = branchCurrency.requiresUpToDateHead !== false;
  const mergeStateStatus = String(
    branchCurrency.mergeStateStatus ?? '',
  ).toUpperCase();
  if (requiresUpToDateHead && mergeStateStatus === 'BEHIND') {
    blockers.push({
      gate: 'branch-currency',
      detail: `mergeStateStatus is "BEHIND" and the base branch requires an up-to-date head before merge (requiresUpToDateHeadSource="${String(branchCurrency.requiresUpToDateHeadSource ?? 'unknown')}")`,
    });
  }
  // #2127: discarded same-named required-check siblings stay evidence-only
  // while GitHub is CLEAN/BEHIND (#1745). Combined with live BLOCKED they
  // are the Rulesets all-instances split (helper latest-wins is green,
  // GitHub still refuses merge). A non-array or missing list is treated
  // as absent so a CODEOWNER-only BLOCKED path (#1663) stays silent here.
  const discardedSiblings = ci.discardedNonPassingRequiredChecks;
  if (
    mergeStateStatus === 'BLOCKED' &&
    Array.isArray(discardedSiblings) &&
    discardedSiblings.length > 0
  ) {
    blockers.push({
      gate: 'discarded-required-check-siblings',
      detail: `mergeStateStatus is "BLOCKED" and ci.discardedNonPassingRequiredChecks has ${String(discardedSiblings.length)} discarded same-named required-check sibling(s); recover via rerun-advisory-convergence, do not merge or --admin`,
    });
  }
  // #2272: fail-closed development-branch invariant. Absent entirely
  // (unmigrated caller / unit fixture) means no gate at all -- distinct
  // from a present-but-empty-`status` value, which this treats as
  // `'unavailable'` (fail closed) rather than silently skipping.
  if (report.developmentBranchTarget) {
    const developmentBranchTarget = preMergeAsRecord(
      report.developmentBranchTarget,
    );
    // `||`, not `??`: an empty-string status (garbled/absent field) must
    // fail closed to 'unavailable' too, not pass '' through unmatched.
    const status = String(developmentBranchTarget.status || 'unavailable');
    const baseRefName = String(developmentBranchTarget.baseRefName ?? '');
    if (status === 'invalid') {
      blockers.push({
        gate: 'development-branch-target',
        detail: `configured developmentBranch is invalid: ${String(developmentBranchTarget.reason ?? 'unknown reason')}`,
      });
    } else if (status === 'unavailable') {
      blockers.push({
        gate: 'development-branch-target',
        detail:
          'effective development branch could not be resolved (no developmentBranch policy value and the live repository default branch could not be read)',
      });
    } else if (status === 'configured' || status === 'default') {
      const effectiveBranch = String(developmentBranchTarget.branch ?? '');
      if (effectiveBranch === '' || effectiveBranch !== baseRefName) {
        blockers.push({
          gate: 'development-branch-target',
          detail: `PR base branch "${baseRefName}" does not match the effective development branch "${effectiveBranch}" (status="${status}")`,
        });
      }
    } else {
      // Whitelist, not a denylist: an unrecognized status (a typo, a
      // future enum value this file does not know about yet, or any
      // other coerced-`String(...)` garbage) must fail closed rather
      // than fall through to the branch comparison, where a coincidental
      // `branch === baseRefName` (including both empty) would otherwise
      // silently pass an invariant this file cannot actually vouch for.
      blockers.push({
        gate: 'development-branch-target',
        detail: `unrecognized developmentBranchTarget.status "${status}" (expected "configured", "default", "invalid", or "unavailable")`,
      });
    }
  }
  return blockers;
}
export function buildPreMergeReadinessSummary(
  {
    prHeadSha,
    comments = [],
    reviews = [],
    threads = [],
    checks = [],
    branchRules = [],
    branchRulesets = [],
    branchProtection = {},
    protectionReadsUnreadable = false,
    branchRulesetsUnreadable = false,
    requestedReviewers = [],
    timelineEvents = [],
    claimEvents = [],
    changedFiles = [],
    codeownersText = '',
    eligibleCodeownerUserLogins = null,
    eligibleCodeownerUserLoginsUnreadable = false,
    reviewsUnreadable = false,
    reviewDecision = '',
    mergeStateStatus = '',
    mergeable = '',
  },
  options = {},
) {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  if (!/^[0-9a-f]{40}$/.test(String(prHeadSha ?? ''))) {
    throw new Error('prHeadSha must be a 40-character lowercase commit SHA');
  }
  const trustedMarkerLogins = normalizeTrustedMarkerLogins(
    options.trustedMarkerLogins ?? [],
  );
  const iddAgentLogins = normalizeTrustedMarkerLogins(
    options.iddAgentLogins ?? [],
  );
  const advisoryBotLogins = normalizeTrustedMarkerLogins(
    options.advisoryBotLogins ?? [],
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const branchCurrency = summarizeBranchCurrency(
    branchRules,
    branchProtection,
    {
      mergeStateStatus,
      mergeable,
      protectionReadsUnreadable,
    },
  );
  const liveSnapshot = buildActivitySnapshotSummary(
    {
      comments,
      reviews,
      threads,
      checks,
    },
    {
      trustedMarkerLogins,
      advisoryBotLogins,
      advisoryBotLoginsSource: options.advisoryBotLoginsSource,
      dispositionAuthorLogins: iddAgentLogins,
    },
  );
  // #2544: whether the configured secondary bot has already posted a
  // genuine (non-notice) comment for the CURRENT HEAD -- reuses
  // `options.advisoryConvergenceHeadCommittedAt` (the HEAD commit's own
  // `committedDate`, already resolved by the caller for the unrelated
  // advisory-convergence-deadline precondition below) rather than a second
  // fetch, since it is exactly "when did this HEAD land" either way.
  const secondaryBotLogin = String(options.secondaryBotLogin ?? '')
    .trim()
    .toLowerCase();
  const secondaryReviewSettlement = secondaryBotLogin
    ? computeSecondaryAdvisoryReviewSettlement(comments, {
        secondaryBotLogin,
        headCommittedAt: options.advisoryConvergenceHeadCommittedAt,
      })
    : { settled: false, settledAt: null, declined: false };
  // #2335: stateless secondary-quiet-window gate, anchored on the same
  // non-ack-only activity ceiling `liveSnapshot.effective` already computes
  // for the review-currency ack-only carve-out below -- see
  // `buildSecondaryQuietWindowStatus`'s own doc comment for why this anchor
  // needs no separate persisted "convergence first observed" timestamp.
  // #2544: `secondaryBotSettledAt` shortens the required wait to a settled
  // buffer once that evidence exists. #2547: `secondaryBotDeclined` skips
  // the wait entirely once the bot has definitively declined this exact
  // HEAD; see `computeSecondaryAdvisoryReviewSettlement` above for how
  // both are derived.
  const secondaryQuietWindow = buildSecondaryQuietWindowStatus({
    minutes: options.secondaryQuietWindowMinutes,
    effectiveMaxActivityUpdatedAt: liveSnapshot.effective?.maxActivityUpdatedAt,
    secondaryBotSettledAt: secondaryReviewSettlement.settledAt,
    secondaryBotDeclined: secondaryReviewSettlement.declined,
    now,
  });
  const isTrustedWatermarkAuthor = (login) =>
    trustedMarkerLogins.includes(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
  const watermark = resolveLatestReviewWatermark(comments, {
    expectedClaimId: options.expectedClaimId,
    isTrustedAuthor: isTrustedWatermarkAuthor,
  });
  const reviewCurrency = watermark
    ? diffReviewSnapshot(
        {
          headSha: watermark.headSha,
          maxActivityUpdatedAt: watermark.maxActivityUpdatedAt,
          totalItemCount: watermark.totalItemCount,
          latestPassingCiCompletedAt: watermark.latestCiCompletedAt,
        },
        {
          headSha: prHeadSha,
          ...liveSnapshot,
        },
      )
    : detectMalformedReviewWatermarkComments(comments, {
          isTrustedAuthor: isTrustedWatermarkAuthor,
          expectedClaimId: options.expectedClaimId,
        })
      ? { route: 'return-to-e1', reason: 'malformed-watermark' }
      : { route: 'return-to-e1', reason: 'missing-watermark' };
  const threadSummary = summarizeReviewThreadsForGate(threads, {
    iddAgentLogins,
    prAuthorLogin,
    requiresConversationResolution:
      branchReviewRequirements.requiresConversationResolution,
  });
  const unrepliedComments = summarizeRegularCommentsForGate(comments, {
    iddAgentLogins,
    advisoryBotLogins,
    trustedMarkerLogins,
    threads,
  });
  // #1818: `options.primaryBotLogin` (the configured advisory-wait primary
  // bot, e.g. a non-default Copilot form or a wholly different bot) must be
  // treated as an advisory bot by `summarizeReviewerStates`'s review-approval
  // counting specifically -- `isKnownReviewBot` only recognizes the literal
  // default bot identities, and a repo that configures a custom
  // `primaryBotLogin` without separately adding it to `advisoryBotLogins`
  // would otherwise have that bot's `APPROVED`/`CHANGES_REQUESTED` review
  // counted as a human's. Union it into a call-site-local set instead of
  // widening the shared `advisoryBotLogins` above, which also feeds
  // `buildActivitySnapshotSummary` and `summarizeRegularCommentsForGate`
  // (unrelated classification needs that must not change as a side effect).
  //
  // Normalize + default `options.primaryBotLogin` the same way
  // `buildAdvisoryWaitSummary` does a few lines below (`primaryBotLogin`
  // local const there) -- an omitted/blank option must still resolve to the
  // Copilot default, not silently drop out of the union. Without this, a
  // caller that relies on defaulting (any caller other than this file's own
  // `collectPreMergeReadiness`, which always resolves a non-empty value)
  // would leave the bare `copilot` login unclassified here even though
  // `isCopilotReviewerLogin` elsewhere already treats it as a genuine
  // Copilot form (Copilot review, PR #1826).
  const resolvedPrimaryBotLogin =
    String(options.primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const reviewerStateAdvisoryBotLogins = normalizeTrustedMarkerLogins([
    ...advisoryBotLogins,
    resolvedPrimaryBotLogin,
  ]);
  const reviewerStates = summarizeReviewerStates(reviews, {
    reviewDecision,
    branchRules,
    branchRulesets,
    branchProtection,
    branchRulesetsUnreadable,
    codeownersText,
    changedFiles,
    eligibleCodeownerUserLogins,
    eligibleCodeownerUserLoginsUnreadable,
    reviewsUnreadable,
    advisoryBotLogins: reviewerStateAdvisoryBotLogins,
    prAuthorLogin,
    viewerLogin: options.viewerLogin,
    viewerTeamSlugs: options.viewerTeamSlugs,
    viewerAppSlug: options.viewerAppSlug,
  });
  const advisoryWaitOptions = normalizeAdvisoryWaitRuntimeOptions(options);
  const advisoryWait = buildAdvisoryWaitSummary(
    {
      prHeadSha,
      reviews,
      requestedReviewers,
      timelineEvents,
      comments,
    },
    {
      now,
      ...advisoryWaitOptions,
      viewerLogin: options.viewerLogin,
      configuredTrustedActors: options.configuredTrustedActors,
      collaboratorTrustEnabled: options.collaboratorTrustEnabled,
      trustedMarkerLogins,
      primaryBotLogin: options.primaryBotLogin,
    },
  );
  const claim = options.claimless
    ? {
        expectedClaimId: 'none',
        expectedAgentId: '',
        activeClaimPresent: false,
        activeClaim: {
          agentId: '',
          claimId: 'none',
          supersedes: '',
          branch: '',
          createdAt: '',
        },
        matchesExpectedClaim: true,
        claimLost: false,
        reason: 'not-applicable',
      }
    : summarizeClaimValidation(claimEvents, {
        trustedMarkerLogins,
        forcedHandoffEnabled: options.forcedHandoffEnabled === true,
        expectedLinkedPrs: options.expectedLinkedPrs ?? [],
        prFirstCommitAt: options.prFirstCommitAt ?? null,
        authorizedForcedHandoffLogins: options.authorizedForcedHandoffLogins,
        isAuthorizedForcedHandoff: options.isAuthorizedForcedHandoff,
        isForcedHandoffEnabled: options.isForcedHandoffEnabled,
        expectedClaimId: options.expectedClaimId,
        expectedAgentId: options.expectedAgentId,
        expectedNonce: options.expectedNonce,
        staleAgeMs: options.staleAgeMs,
      });
  const waivableCheckSelectors = options.waivableCheckSelectors ?? null;
  const waiverEvidence = summarizeExternalCheckWaivers(comments, {
    prHeadSha,
    activeClaimId: claim.activeClaim?.claimId ?? options.activeClaimId ?? '',
    activeClaimSupersedes: claim.activeClaim?.supersedes ?? '',
    trustedMarkerLogins,
    now,
    waivableSelectors: waivableCheckSelectors,
    maxValidity: options.externalCheckWaiverMaxValidity ?? '',
    mode: options.externalCheckWaiverMode ?? '',
  });
  // #1570: the caller-supplied terminal-unavailability verdict, reused below
  // both for the dedicated `copilot-terminal-unavailable` blocker and (#2021)
  // as one of the two preconditions that must open before an
  // `idd-advisory-convergence` waiver counts toward `ci.coveredByWaiver`.
  const copilotUnavailable = options.copilotUnavailable === true;
  // #2021: `advisory-convergence.mts`'s own gate never treats a posted
  // `idd-advisory-convergence` waiver as active until ONE of two independent
  // preconditions is ALSO true -- a 24h deadline anchored on the current HEAD
  // commit's own `committedDate`, or proven terminal Copilot unavailability
  // (`copilotUnavailable` above). Reported truthfully in `waiverEvidence`
  // itself either way (the marker is real and otherwise valid), but a check
  // only becomes `coveredByWaiver` here once this SAME precondition has
  // opened -- otherwise this helper reports `coveredByWaiver: true` before
  // `advisory-convergence.mts` itself would ever call the waiver `waived`,
  // sending an otherwise-correct session into a `gh pr merge` GitHub rejects
  // outright (root cause: kurone-kito/idd-skill#2021).
  const advisoryConvergencePreconditionResult =
    buildAdvisoryConvergenceWaiverPrecondition({
      headCommittedAt: options.advisoryConvergenceHeadCommittedAt,
      deadlineMinutes: options.advisoryConvergenceDeadlineMinutes,
      terminalUnavailable: copilotUnavailable,
      now,
    });
  const advisoryConvergenceWaiverPrecondition =
    advisoryConvergencePreconditionResult.precondition;
  const advisoryConvergenceDeadlinePassed =
    advisoryConvergenceWaiverPrecondition.deadlinePassed;
  const advisoryConvergencePreconditionOpen =
    advisoryConvergenceWaiverPrecondition.open;
  const advisoryConvergenceDeadlineOpensAt =
    advisoryConvergencePreconditionResult.deadlineOpensAt;
  // #2021 (Codex review on PR #2033, two findings): `advisory-convergence.mts`'s
  // own `waived` computation only counts a waiver whose `checkSelector` is an
  // EXACT match to its selector constant (`entry.checkSelector ===
  // waiverCheckSelector`, advisory-convergence.mts line ~1108) -- never a
  // glob. A glob waiver such as `idd-*` (permitted when
  // `waivableCheckSelectors` allows it) would still glob-match the
  // `idd-advisory-convergence` CHECK NAME via `summarizeRequiredChecks`'s
  // `matchCheckSelectorLocal`, so treating "precondition open" as sufficient
  // to fall back to the raw, unfiltered `waiverEvidence` (as an earlier
  // revision of this fix did) would report `coveredByWaiver: true` for a
  // selector that gate would never itself accept -- reproducing this same
  // issue's false-`ready` class for a different trigger. `genuinelyCovered`
  // requires BOTH the precondition open AND an EXACT-match valid entry.
  const advisoryConvergenceExactWaiverValid = waiverEvidence.valid.some(
    (entry) =>
      entry.checkSelector === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  );
  const advisoryConvergenceGenuinelyCovered =
    advisoryConvergencePreconditionOpen && advisoryConvergenceExactWaiverValid;
  // #2353: the caller-precomputed provider-outage-declaration relief
  // verdict, re-ANDed here with the SAME precondition-open evidence the
  // direct-waiver path above requires -- cheap insurance against a future
  // caller passing a relief verdict that was somehow computed without the
  // precondition it logically implies (evaluateProviderOutageRelief's own
  // `prTerminalUnavailable` requirement already implies `terminalUnavailable`,
  // which already implies `advisoryConvergencePreconditionOpen` via the OR,
  // so this is redundant today, not a new gate).
  const advisoryConvergenceOutageRelieved =
    advisoryConvergencePreconditionOpen &&
    options.advisoryConvergenceOutageRelieved === true;
  const ci = summarizeRequiredChecks(checks, branchRules, branchProtection, {
    // Raw, UNFILTERED `waiverEvidence` -- deliberately not a caller-side
    // pre-filtered copy. A pre-filter that removed a whole `valid` entry
    // (e.g. every occurrence of a glob waiver covering
    // `idd-advisory-convergence`) would also strip that SAME entry's
    // coverage of any OTHER check it glob-matches (e.g. a configured
    // `idd-security`), turning a convergence-specific restriction into an
    // unintended block on unrelated checks (Codex review finding on PR
    // #2033). `excludeFromWaiverCoverage` below applies the restriction
    // surgically, per check name, instead.
    waivers: waiverEvidence,
    waivableSelectors: waivableCheckSelectors,
    protectionReadsUnreadable,
    trustSourcePinnedRequiredChecks:
      options.trustSourcePinnedRequiredChecks === true,
    excludeFromWaiverCoverage: (name) =>
      name === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
      !advisoryConvergenceGenuinelyCovered,
    // #2034: only override the cutoff for `idd-advisory-convergence` itself,
    // and only on the deadline path -- an unrelated check's waiver stays
    // anchored on its own comment's `createdAt`.
    waiverActiveSinceOverride: (name) =>
      name === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
      advisoryConvergenceDeadlineOpensAt
        ? advisoryConvergenceDeadlineOpensAt
        : null,
    // #2353: a repository-scoped provider-outage declaration relieves
    // `idd-advisory-convergence` specifically, through a positive path
    // that bypasses `excludeFromWaiverCoverage` above entirely -- see
    // `treatAsCoveredByWaiver`'s own doc comment for why.
    treatAsCoveredByWaiver: (name) =>
      name === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
      advisoryConvergenceOutageRelieved,
    // #2353 (Codex review on PR #2370): the declaration's own `startedAt`
    // -- a required check's live run must have completed at or after this
    // moment, or a stale pre-declaration failed run would be reported
    // covered without ever having actually rerun under the outage window.
    treatAsCoveredByWaiverSince: (name) =>
      name === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
      options.advisoryConvergenceOutageRelievedSince
        ? options.advisoryConvergenceOutageRelievedSince
        : null,
  });
  // #1570: reuse the SAME raw waiver evidence above (already validated for
  // selector/HEAD/claim/authority/expiry) to decide whether the caller-
  // supplied terminal-unavailability verdict is also validly waived, filtered
  // to the `idd-advisory-convergence` selector -- the identical selector
  // advisory-convergence.mts's own terminal-waiver path consumes, so a single
  // maintainer-posted waiver marker satisfies whichever gate (the CI
  // required-check, or this direct F2/F3 evidence collector) is currently
  // asking. Deliberately reads the RAW `waiverEvidence`, not
  // `ciWaiverEvidence`: this blocker is itself gated on
  // `copilotUnavailable === true` (the terminal precondition already proven),
  // so the deadline-vs-terminal precondition split above would be redundant
  // here.
  const copilotUnavailableWaived =
    copilotUnavailable &&
    (waiverEvidence.valid.some(
      (entry) =>
        entry.checkSelector === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
    ) ||
      // #2353: a repository-scoped provider-outage declaration also clears
      // this dedicated blocker, same as a direct maintainer waiver.
      advisoryConvergenceOutageRelieved);
  const dispositionEvidence = options.includeDispositionEvidence
    ? summarizeDispositionEvidenceForGate(
        { comments, threads },
        {
          iddAgentLogins,
          advisoryBotLogins,
          trustedMarkerLogins,
          prAuthorLogin,
          snapshotBoundaryAt: watermark?.maxActivityUpdatedAt ?? null,
        },
      )
    : null;
  const summary = {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    prHeadSha,
    now,
    reviewCurrency: {
      watermarkPresent: Boolean(watermark),
      watermark: {
        agentId: watermark?.agentId ?? '',
        claimId: watermark?.claimId ?? '',
        headSha: watermark?.headSha ?? '',
        maxActivityUpdatedAt: watermark?.maxActivityUpdatedAt ?? 'none',
        totalItemCount: watermark?.totalItemCount ?? 0,
        latestCiCompletedAt: watermark?.latestCiCompletedAt ?? 'none',
        createdAt: watermark?.createdAt ?? 'none',
      },
      live: {
        totalItemCount: liveSnapshot.totalItemCount,
        maxActivityUpdatedAt: liveSnapshot.maxActivityUpdatedAt,
        latestCiCompletedAt: liveSnapshot.latestCiCompletedAt,
        latestPassingCiCompletedAt: liveSnapshot.latestPassingCiCompletedAt,
        counts: liveSnapshot.counts,
        ackOnly: liveSnapshot.ackOnly,
        effective: liveSnapshot.effective,
      },
      comparisonRoute: reviewCurrency.route,
      comparisonReason: reviewCurrency.reason,
    },
    secondaryQuietWindow,
    threads: {
      unresolvedCount: threads.filter((thread) => !thread.isResolved).length,
      actionableCount: threadSummary.actionableCount,
      awaitingReviewerCount: threadSummary.awaitingReviewerCount,
      amdBlockingCount: threadSummary.amdBlockingCount,
      conversationResolveAgentCount:
        threadSummary.conversationResolveAgentCount,
      conversationResolveAuthorCount:
        threadSummary.conversationResolveAuthorCount,
      classifications: threadSummary.classifications,
    },
    unrepliedComments,
    reviewerStates,
    advisoryWait: {
      outcome: advisoryWait.outcome,
      f3Outcome: advisoryWait.f3Outcome,
      lastCopilotCommit: advisoryWait.lastCopilotCommit,
      copilotPending: advisoryWait.copilotPending,
      copilotPendingCoversHead: advisoryWait.copilotPendingCoversHead,
      sameHeadMarkerPresent: advisoryWait.sameHeadMarkerPresent,
      earliestSameHeadAt: advisoryWait.earliestSameHeadAt,
      sameHeadMarkerCount: advisoryWait.sameHeadMarkerCount,
      requestMarkerCount: advisoryWait.requestMarkerCount,
      requestCap: advisoryWait.requestCap,
      pendingWindowMinutes: advisoryWait.pendingWindowMinutes,
      settledWindowMinutes: advisoryWait.settledWindowMinutes,
      pollIntervalMinutes: advisoryWait.pollIntervalMinutes,
      capExhaustedRoute: advisoryWait.capExhaustedRoute,
      elapsedMinutes: advisoryWait.elapsedMinutes,
      copilotUnavailable,
      copilotUnavailableWaived,
    },
    ci,
    claim,
    waiverEvidence,
    // #2021: the deadline/terminal precondition evaluated above, reported
    // unconditionally as its own field (never folded into `waiverEvidence`,
    // whose shape is the schema-locked `ExternalCheckWaiverEvidence`) so a
    // blocker detail or a resuming agent can cite the remaining
    // time-to-deadline without re-deriving it.
    advisoryConvergenceWaiverPrecondition,
    branchCurrency,
  };
  if (dispositionEvidence) {
    summary.dispositionEvidence = dispositionEvidence;
  }
  // #2323: informational only -- never a blocker input, and omitted
  // entirely (not even `null`) when the caller does not pass it, mirroring
  // `dispositionEvidence` above so every pre-#2323 fixture/caller output is
  // byte-for-byte unchanged. See the option's doc comment above for why
  // this can never change `ready`/`blockers`.
  if (options.localValidationEvidenceSummary) {
    summary.localValidationEvidence = options.localValidationEvidenceSummary;
  }
  // #2272: omitted entirely (not even `null`) when the caller does not
  // pass it, so `computePreMergeReadinessBlockers` below can distinguish
  // "no gate" from "gate present" -- see the option's doc comment above.
  if (options.developmentBranchTarget) {
    summary.developmentBranchTarget = options.developmentBranchTarget;
  }
  // Top-level rollup so a consumer reads one `ready` boolean + `blockers[]`
  // instead of hand-ANDing ~8 nested gates (a dropped clause would fail open).
  // Includes the F2 ack-only overrides (#2125) so a fully-autonomous F3
  // session does not livelock on courtesy advisory-bot acks.
  const blockers = computePreMergeReadinessBlockers(summary);
  summary.ready = blockers.length === 0;
  summary.blockers = blockers;
  return summary;
}
function normalizeLiveStatusDigestFields(fields) {
  const normalized = {
    phase: normalizeDigestField(fields.phase, 'Phase'),
    claim: normalizeDigestField(fields.claim, 'Claim'),
    branch: normalizeDigestField(fields.branch, 'Branch'),
    lastChecked: normalizeDigestField(fields.lastChecked, 'Last checked'),
    openBlockers: normalizeDigestField(fields.openBlockers, 'Open blockers'),
    nextAction: normalizeDigestField(fields.nextAction, 'Next action'),
    authoritativeBy: normalizeDigestField(
      fields.authoritativeBy,
      'Authoritative by',
    ),
  };
  if (!isValidIsoTimestamp(normalized.lastChecked)) {
    throw new Error('Last checked must be an ISO 8601 UTC timestamp');
  }
  return normalized;
}
function normalizeDigestField(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}
function escapeMarkdownTableCell(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, '<br>');
}
function firstLine(value) {
  return String(value)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/, 1)[0]
    .trimEnd();
}
function sameDigestBody(currentBody, nextBody) {
  return currentBody.trimEnd() === nextBody.trimEnd();
}
/**
 * The distributed default claim-staleness window (`claimTiming.staleAge`
 * `PT24H`), in milliseconds. Exported so config-aware callers can compare
 * a parsed `claimTiming.staleAge` against "no override configured" and so
 * {@link isStaleByAge} can fast-path to {@link isStaleAt} when the two
 * agree.
 */
export const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;
export function isStaleAt(activeCreatedAt, nextCreatedAt) {
  return (
    new Date(nextCreatedAt).getTime() - new Date(activeCreatedAt).getTime() >=
    DEFAULT_STALE_AGE_MS
  );
}
/**
 * Config-aware claim-staleness primitive: true when `nextCreatedAt` is at
 * least `staleAgeMs` after `activeCreatedAt`. This is the single shared
 * primitive promoted out of the staleness-window comparison that was
 * independently duplicated across the resume and discover paths (each of
 * which already reads `claimTiming.staleAge` from policy correctly) so a
 * write-gate caller can reuse the exact same algorithm instead of adding
 * yet another copy. Delegates to {@link isStaleAt} when `staleAgeMs` equals
 * {@link DEFAULT_STALE_AGE_MS}, so behavior stays byte-identical for
 * repositories on the default. Fails closed to `false` (not stale) when
 * either timestamp is unparseable.
 */
export function isStaleByAge(activeCreatedAt, nextCreatedAt, staleAgeMs) {
  if (staleAgeMs === DEFAULT_STALE_AGE_MS) {
    return isStaleAt(activeCreatedAt, nextCreatedAt);
  }
  const start = Date.parse(activeCreatedAt ?? '');
  const end = Date.parse(nextCreatedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return false;
  }
  return end - start >= staleAgeMs;
}
/**
 * Resolve the `isStale` predicate for the write-gate resolvers below from an
 * optional caller-supplied `staleAgeMs` (a parsed `claimTiming.staleAge` in
 * milliseconds). A valid positive finite value routes through the
 * config-aware {@link isStaleByAge}; an omitted, non-numeric, non-finite, or
 * non-positive value falls back to {@link isStaleAt} unchanged, so callers
 * that do not pass `staleAgeMs` keep today's exact 24h behavior.
 */
function resolveStalePredicate(staleAgeMs) {
  if (
    typeof staleAgeMs !== 'number' ||
    !Number.isFinite(staleAgeMs) ||
    staleAgeMs <= 0
  ) {
    return isStaleAt;
  }
  return (activeCreatedAt, nextCreatedAt) =>
    isStaleByAge(activeCreatedAt, nextCreatedAt, staleAgeMs);
}
function compareClaimIds(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
function createdAtToTime(createdAt) {
  const time = new Date(createdAt ?? '').getTime();
  return Number.isFinite(time) ? time : null;
}
function createdAtToSecond(createdAt) {
  const time = createdAtToTime(createdAt);
  if (time === null) {
    return null;
  }
  return Math.floor(time / 1000);
}
/**
 * Robust ISO timestamp comparison: returns true only when both `left` and
 * `right` parse to valid instants and `left` is strictly before `right`. If
 * either side is missing or unparseable, returns false (fail closed). Used by
 * the forced-handoff enable gate to decide whether an `issue-only` handoff
 * predates a PR's first commit.
 */
function isStrictlyBeforeIso(left, right) {
  const leftTime = createdAtToTime(left);
  const rightTime = createdAtToTime(right);
  if (leftTime === null || rightTime === null) {
    return false;
  }
  return leftTime < rightTime;
}
/**
 * Chronological ordering `resolveActiveClaim` and
 * `resolveActiveClaimWithForcedHandoffTrace` both reduce over: by GitHub
 * `created_at` second, tie-broken by claim-id (same-second contenders),
 * then by sub-second time, then by original array index.
 */
function sortClaimEvents(events) {
  return events
    .map((event, index) => {
      const claim = parseClaimComment(event.body ?? '', event.createdAt ?? '');
      return {
        event,
        index,
        claimId: claim?.claimId ?? null,
        time: createdAtToTime(event.createdAt),
        second: createdAtToSecond(event.createdAt),
      };
    })
    .sort((left, right) => {
      if (
        left.second !== null &&
        right.second !== null &&
        left.second !== right.second
      ) {
        return left.second - right.second;
      }
      if (left.second !== null && right.second === null) {
        return -1;
      }
      if (left.second === null && right.second !== null) {
        return 1;
      }
      if (
        left.second !== null &&
        right.second !== null &&
        left.claimId &&
        right.claimId &&
        left.claimId !== right.claimId
      ) {
        return compareClaimIds(left.claimId, right.claimId);
      }
      if (
        left.time !== null &&
        right.time !== null &&
        left.time !== right.time
      ) {
        return left.time - right.time;
      }
      return left.index - right.index;
    })
    .map(({ event }) => event);
}
/**
 * Same reduction as {@link resolveActiveClaim}, but also tracks which
 * specific forced-handoff marker (if any) produced the final active
 * claim's identity. `resolveActiveClaim`'s state machine has no memory of
 * *why* the active claim changed, so a caller that needs forced-handoff
 * provenance (`resume-claim-routing.mts`'s `evidence.forced_handoff`,
 * kurone-kito/idd-skill#2178) cannot reconstruct it safely by
 * independently re-scanning events for a `new*`-field match against the
 * final active claim: a stale or never-applied forced-handoff marker
 * whose `new*` fields merely coincide with the real active claim's
 * identity (for example a duplicate/retried handoff attempt posted after
 * a first one already succeeded) would misattribute the wrong `old*`
 * fields as evidence. Replaying the identical single-pass reduction here
 * -- the one place that already knows the true before/after state at each
 * step -- is what answers "which marker actually caused this transition"
 * correctly.
 */
export function resolveActiveClaimWithForcedHandoffTrace(
  events,
  isTrustedAuthor = () => true,
) {
  const options = normalizeClaimResolutionOptions(isTrustedAuthor);
  const orderedEvents = sortClaimEvents(events);
  let active = null;
  let appliedForcedHandoff = null;
  for (const event of orderedEvents) {
    const previous = active;
    const next = applyClaimEvent(previous, event, options);
    const identityChanged =
      (next?.claimId ?? null) !== (previous?.claimId ?? null) ||
      (next?.agentId ?? null) !== (previous?.agentId ?? null);
    if (identityChanged) {
      const candidate = previous
        ? parseForcedHandoffComment(event.body ?? '', event.createdAt ?? '')
        : null;
      appliedForcedHandoff =
        candidate &&
        next &&
        previous &&
        candidate.oldAgentId === previous.agentId &&
        candidate.oldClaimId === previous.claimId &&
        candidate.branch === previous.branch &&
        candidate.newAgentId === next.agentId &&
        candidate.newClaimId === next.claimId
          ? candidate
          : null;
    }
    active = next;
  }
  return { activeClaim: active, appliedForcedHandoff };
}
export function resolveActiveClaim(events, isTrustedAuthor = () => true) {
  return resolveActiveClaimWithForcedHandoffTrace(events, isTrustedAuthor)
    .activeClaim;
}
export function applyClaimEvent(activeClaim, event, options = {}) {
  const normalizedOptions = normalizeClaimResolutionOptions(options);
  const authorLogin = event.author?.login ?? '';
  if (!normalizedOptions.isTrustedAuthor(authorLogin)) {
    return activeClaim;
  }
  const claim = parseClaimComment(event.body ?? '', event.createdAt ?? '');
  if (claim) {
    if (!activeClaim) {
      return claim.supersedes === 'none' ? claim : null;
    }
    if (
      claim.agentId === activeClaim.agentId &&
      claim.claimId === activeClaim.claimId
    ) {
      // Enforce the heartbeat branch invariant (idd-claim.instructions.md
      // rule 3.5): a heartbeat candidate whose {branch} does not exactly
      // match the active claim's {branch} is anomalous and must not
      // refresh the stale clock. Without this guard, a spurious heartbeat
      // could extend the stale clock indefinitely and block the 24h
      // stale-takeover recovery path that audit-pr-cleanup depends on.
      if (claim.branch !== activeClaim.branch) {
        normalizedOptions.onAnomalousHeartbeat({
          agentId: claim.agentId,
          claimId: claim.claimId,
          activeBranch: activeClaim.branch,
          heartbeatBranch: claim.branch,
          createdAt: event.createdAt,
        });
        return activeClaim;
      }
      return {
        ...activeClaim,
        createdAt: event.createdAt ?? activeClaim.createdAt,
      };
    }
    if (
      claim.supersedes === activeClaim.claimId &&
      normalizedOptions.isStale(activeClaim.createdAt, event.createdAt ?? '')
    ) {
      return claim;
    }
    return activeClaim;
  }
  const release = parseReleaseComment(event.body ?? '');
  if (
    release &&
    activeClaim &&
    release.agentId === activeClaim.agentId &&
    release.claimId === activeClaim.claimId
  ) {
    return null;
  }
  const forcedHandoff = parseForcedHandoffComment(
    event.body ?? '',
    event.createdAt ?? '',
  );
  if (
    forcedHandoff &&
    activeClaim &&
    forcedHandoff.oldAgentId === activeClaim.agentId &&
    forcedHandoff.oldClaimId === activeClaim.claimId &&
    forcedHandoff.branch === activeClaim.branch
  ) {
    if (!normalizedOptions.isForcedHandoffEnabled(forcedHandoff, event)) {
      normalizedOptions.onIgnoredForcedHandoff({
        reason: 'mode-disabled',
        forcedHandoff,
        event,
      });
      return activeClaim;
    }
    // Optional: bind the asserted forcedBy identity to the comment
    // author so a trusted-marker actor cannot self-attest a handoff by
    // naming an unrelated maintainer in the payload. This is the
    // strict mode used by the Resume routing path (idd-claim.instructions.md
    // rule 7). The default is off because production forced-handoff
    // markers can be posted on behalf of a maintainer by a separate
    // automation account; callers that want the strict binding (e.g.
    // resume-claim-routing.mjs) opt in via `requireAuthorMatchesForcedBy`.
    if (normalizedOptions.requireAuthorMatchesForcedBy) {
      const authorLoginLower = String(authorLogin).trim().toLowerCase();
      const forcedByLower = String(forcedHandoff.forcedBy ?? '')
        .trim()
        .toLowerCase();
      if (!authorLoginLower || authorLoginLower !== forcedByLower) {
        normalizedOptions.onIgnoredForcedHandoff({
          reason: 'author-forced-by-mismatch',
          forcedHandoff,
          event,
        });
        return activeClaim;
      }
    }
    if (
      !normalizedOptions.isAuthorizedForcedHandoff(
        forcedHandoff.forcedBy,
        forcedHandoff,
        event,
      )
    ) {
      normalizedOptions.onIgnoredForcedHandoff({
        reason: 'forced-by-unauthorized',
        forcedHandoff,
        event,
      });
      return activeClaim;
    }
    return {
      agentId: forcedHandoff.newAgentId,
      claimId: forcedHandoff.newClaimId,
      supersedes: forcedHandoff.oldClaimId,
      branch: forcedHandoff.branch,
      createdAt: forcedHandoff.createdAt ?? activeClaim.createdAt,
    };
  }
  return activeClaim;
}
function normalizeClaimResolutionOptions(optionsOrPredicate) {
  if (typeof optionsOrPredicate === 'function') {
    return {
      isTrustedAuthor: optionsOrPredicate,
      isForcedHandoffEnabled: () => false,
      isAuthorizedForcedHandoff: () => false,
      isStale: isStaleAt,
      requireAuthorMatchesForcedBy: false,
      onAnomalousHeartbeat: () => {},
      onIgnoredForcedHandoff: () => {},
    };
  }
  const options = optionsOrPredicate ?? {};
  return {
    isTrustedAuthor:
      typeof options.isTrustedAuthor === 'function'
        ? options.isTrustedAuthor
        : () => true,
    isForcedHandoffEnabled:
      typeof options.isForcedHandoffEnabled === 'function'
        ? options.isForcedHandoffEnabled
        : () => false,
    isAuthorizedForcedHandoff:
      typeof options.isAuthorizedForcedHandoff === 'function'
        ? options.isAuthorizedForcedHandoff
        : () => false,
    isStale:
      typeof options.isStale === 'function' ? options.isStale : isStaleAt,
    requireAuthorMatchesForcedBy: Boolean(options.requireAuthorMatchesForcedBy),
    onAnomalousHeartbeat:
      typeof options.onAnomalousHeartbeat === 'function'
        ? options.onAnomalousHeartbeat
        : () => {},
    onIgnoredForcedHandoff:
      typeof options.onIgnoredForcedHandoff === 'function'
        ? options.onIgnoredForcedHandoff
        : () => {},
  };
}
export function normalizeLinkedPrReference(value) {
  const token = String(value ?? '').trim();
  if (!token) {
    return '';
  }
  if (/^#?[1-9]\d*$/.test(token)) {
    return token.replace(/^#/, '');
  }
  try {
    const parsed = new URL(token);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return token.toLowerCase();
    }
    if (hostname !== 'github.com' && hostname !== 'www.github.com') {
      return token.toLowerCase();
    }
    const pathMatch = parsed.pathname.match(
      /^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/i,
    );
    if (pathMatch) {
      return pathMatch[1];
    }
  } catch {
    // Not a URL-form linked-pr reference.
  }
  return token.toLowerCase();
}
export function classifyResumeRoutingCase(input, options = {}) {
  const staleHours = Number.isFinite(options.staleHours)
    ? options.staleHours
    : 24;
  const stallMinutes = Number.isFinite(options.stallMinutes)
    ? options.stallMinutes
    : 30;
  const pendingCiStates = new Set(
    options.pendingCiStates ?? ['queued', 'in_progress', 'waiting', 'pending'],
  );
  const terminalSafeCiStates = new Set(
    options.terminalSafeCiStates ?? ['success', 'none'],
  );
  if (input.displacedByForcedHandoff) {
    return {
      route: 'claim-lost-stop',
      reason: 'session was displaced by trusted forced-handoff evidence',
    };
  }
  if (!input.hasActiveClaim) {
    return {
      route: 'unclaimed-reclaim-required',
      reason: 'resume requires a fresh claim before continuation',
    };
  }
  if (input.claimOwnedBySession) {
    if (input.rebaseInProgress || input.worktreeDirty) {
      return {
        route: 'crash-recovery',
        reason: 'owned claim with interrupted local state',
      };
    }
    return {
      route: 'ordinary-continuation',
      reason: 'owned claim with clean local state',
    };
  }
  if (input.hasUsableForcedHandoffEvidence) {
    return {
      route: 'forced-handoff-recovery',
      reason:
        'trusted forced-handoff evidence takes precedence over stalled-session takeover',
    };
  }
  if (!Number.isFinite(input.claimAgeHours)) {
    return {
      route: 'hold-for-evidence',
      reason: 'claim age is missing for a non-owned claim',
    };
  }
  if (!Number.isFinite(input.latestActivityAgeMinutes)) {
    return {
      route: 'hold-for-evidence',
      reason: 'activity age is missing for a non-owned active claim',
    };
  }
  const ciState = String(input.ciState ?? 'none').toLowerCase();
  if (pendingCiStates.has(ciState)) {
    return {
      route: 'hold-for-evidence',
      reason: 'CI is still pending for the active non-owned claim',
    };
  }
  if (!terminalSafeCiStates.has(ciState)) {
    return {
      route: 'hold-for-evidence',
      reason: 'CI is not in a terminal-safe state for stalled-claim recovery',
    };
  }
  if (input.claimAgeHours < staleHours) {
    if (input.latestActivityAgeMinutes >= stallMinutes) {
      return {
        route: 'hold-for-evidence',
        reason: `non-owned claim is fresh and idle for >= ${stallMinutes}m, but still non-inheritable`,
      };
    }
    return {
      route: 'hold-for-evidence',
      reason: 'non-owned claim remains non-inheritable until stale',
    };
  }
  if (input.latestActivityAgeMinutes < stallMinutes) {
    return {
      route: 'hold-for-evidence',
      reason: `non-owned claim is stale but quiet-window evidence is < ${stallMinutes}m`,
    };
  }
  return {
    route: 'stale-claim-takeover',
    reason: `non-owned claim is stale at >= ${staleHours}h with quiet-window evidence >= ${stallMinutes}m`,
  };
}
function hasExplicitDispositionAfter(targetComment, comments, options = {}) {
  // Default accepts any non-bot human; an IDD-scoped predicate (when supplied)
  // restricts the disposition author so a reviewer-authored marker does not
  // count as a completed IDD disposition.
  const isDispositionAuthor =
    typeof options.isDispositionAuthor === 'function'
      ? options.isDispositionAuthor
      : (login) => !isKnownReviewBot(login);
  const targetTime = Date.parse(targetComment.createdAt ?? '');
  // The disposition must attribute itself to this sticky's advisory bot. Accept
  // either the product word (`CodeRabbit`) or the bot **login**
  // (`coderabbitai[bot]`) — the canonical disposition-non-review-notices output
  // names the login, which `\bCodeRabbit\b` misses (no word boundary before the
  // trailing `ai`). Naming the login reuses the same `advisoryBotIdentityToken`
  // attribution the rest of the gate relies on. Fail-closed: an unattributable
  // disposition still matches nothing.
  const targetBotLogin = String(targetComment.author?.login ?? '');
  return comments.some((comment) => {
    const author = String(comment.author?.login ?? '')
      .trim()
      .toLowerCase();
    if (!isDispositionAuthor(author) || !isDispositionComment(comment)) {
      return false;
    }
    if (
      !/\bCodeRabbit\b/i.test(comment.body ?? '') &&
      !dispositionNamesAdvisoryBot(comment.body ?? '', targetBotLogin)
    ) {
      return false;
    }
    const dispositionTime = Date.parse(comment.createdAt ?? '');
    return (
      Number.isFinite(targetTime) &&
      Number.isFinite(dispositionTime) &&
      dispositionTime > targetTime
    );
  });
}
function normalizeGatingReviewTimestamp(review, state) {
  const submittedAt = String(review.submittedAt ?? review.submitted_at ?? '');
  if (isValidIsoTimestamp(submittedAt)) {
    return submittedAt;
  }
  if (
    state !== 'APPROVED' &&
    state !== 'CHANGES_REQUESTED' &&
    state !== 'DISMISSED'
  ) {
    return null;
  }
  const updatedAt = String(review.updatedAt ?? review.updated_at ?? '');
  if (isValidIsoTimestamp(updatedAt)) {
    return updatedAt;
  }
  return null;
}
function maxIsoTimestamp(values) {
  let latest = null;
  for (const value of values) {
    const normalized = String(value);
    if (!isValidIsoTimestamp(normalized)) {
      continue;
    }
    if (!latest || compareIsoTimestamps(normalized, latest) > 0) {
      latest = normalized;
    }
  }
  return latest;
}
export function summarizeRequiredCheckMetadata(parameters) {
  const names = new Set();
  // #1689: the SPECIFIC subset of `names` whose rule entry is itself
  // source-pinned -- distinct from the aggregate `sourcePinned` flag below,
  // which only says "at least one pinned entry exists somewhere in this
  // parameters object." `summarizeRequiredChecks` needs the actual pinned
  // names to name the source-pinned cause in a blocker detail instead of a
  // generic "CI is not all-passing" message.
  const pinnedNames = new Set();
  let sourcePinned = false;
  // #1689: true when at least one pinned entry could NOT be attributed to a
  // resolved name (no `context`/`name`/`check` at all) -- distinct from
  // `pinnedNames` being merely empty, which could also mean "no pinned
  // entry exists." A caller must fail closed on this regardless of the
  // `trustSourcePinnedRequiredChecks` opt-in: there is nothing to verify or
  // trust when there is no check name to correlate with a live run.
  let unresolvedPinned = false;
  const rawChecks = [
    ...(parameters.required_status_checks ?? []),
    ...(parameters.required_checks ?? []),
    ...(parameters.checks ?? []),
    ...(parameters.contexts ?? []),
  ];
  for (const rawCheck of rawChecks) {
    if (typeof rawCheck === 'string') {
      if (rawCheck.trim()) {
        names.add(rawCheck.trim());
      }
      continue;
    }
    const isPinned =
      isSourcePinnedRequirementId(rawCheck?.app_id) ||
      isSourcePinnedRequirementId(rawCheck?.integration_id) ||
      Boolean(rawCheck?.source);
    if (isPinned) {
      sourcePinned = true;
    }
    let resolvedName = '';
    for (const candidate of [
      rawCheck?.context,
      rawCheck?.name,
      rawCheck?.check,
      rawCheck?.integration_id ? rawCheck?.name : '',
    ]) {
      const normalized = String(candidate ?? '').trim();
      if (normalized) {
        resolvedName = normalized;
        break;
      }
    }
    if (resolvedName) {
      names.add(resolvedName);
      if (isPinned) {
        pinnedNames.add(resolvedName);
      }
    } else if (isPinned) {
      unresolvedPinned = true;
    }
  }
  return {
    names: [...names].sort(),
    sourcePinned,
    pinnedNames: [...pinnedNames].sort(),
    unresolvedPinned,
  };
}
function extractRequiredReviewerRequirement(reviewer) {
  const record = typeof reviewer === 'string' ? undefined : reviewer;
  const reviewerRef = record?.reviewer ?? {};
  const reviewerType = String(reviewerRef.type ?? record?.type ?? '')
    .trim()
    .toLowerCase();
  const reviewerId = String(reviewerRef.id ?? record?.id ?? '').trim();
  let candidate =
    typeof reviewer === 'string'
      ? reviewer
      : (record?.login ??
        reviewerRef.login ??
        record?.slug ??
        record?.team ??
        reviewerRef.slug ??
        reviewerRef.team ??
        reviewerRef.name ??
        '');
  if (!candidate && reviewerType && reviewerId) {
    candidate = `${reviewerType}/${reviewerId}`;
  }
  return {
    identity: String(candidate ?? '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase(),
    minimumApprovals:
      Number(record?.minimum_approvals ?? record?.min_approvals ?? 1) || 0,
    filePatterns: (record?.file_patterns ?? record?.filePatterns ?? [])
      .map((pattern) => String(pattern ?? '').trim())
      .filter(Boolean),
  };
}
function parseCodeownersRules(codeownersText) {
  return String(codeownersText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => {
      const tokens = tokenizeCodeownersLine(line);
      const pattern = tokens.shift() ?? '';
      const ownerTokens = [];
      for (const token of tokens) {
        if (token.startsWith('#')) {
          break;
        }
        ownerTokens.push(token);
      }
      const users = ownerTokens
        .filter((token) => /^@[^/\s#]+$/.test(token))
        .map((token) => token.slice(1).toLowerCase());
      const teams = ownerTokens
        .filter((token) => /^@[^/\s#]+\/[^/\s#]+$/.test(token))
        .map((token) => token.slice(1).toLowerCase());
      const emails = ownerTokens
        .filter((token) => /^[^@\s#][^\s#]*@[^\s#]+$/.test(token))
        .map((token) => token.toLowerCase());
      if (!pattern) {
        return null;
      }
      return { pattern, users, teams, emails };
    })
    .filter(Boolean);
}
function findCodeownersForPath(rules, path) {
  let latest = null;
  for (const rule of rules) {
    if (matchesCodeownersPattern(rule.pattern, path)) {
      latest = rule;
    }
  }
  return latest;
}
function matchesCodeownersPattern(pattern, path) {
  const normalizedPattern = String(pattern ?? '').trim();
  const normalizedPath = String(path ?? '')
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
  if (!normalizedPattern || !normalizedPath) {
    return false;
  }
  let body = normalizedPattern;
  const anchored = body.startsWith('/');
  if (anchored) {
    body = body.slice(1);
  }
  const rawBody = body;
  const trailingSlashPattern = rawBody.endsWith('/');
  const lastSegment = rawBody.split('/').at(-1) ?? '';
  const anyDepthFromRoot = rawBody.startsWith('**/');
  const directoryLikePattern =
    !trailingSlashPattern &&
    !lastSegment.includes('*') &&
    !lastSegment.includes('?');
  if (trailingSlashPattern) {
    body = `${body}**`;
  }
  if (anyDepthFromRoot) {
    body = body.slice(3);
  }
  const slashAnchored =
    anchored ||
    (rawBody.includes('/') && !anyDepthFromRoot && !trailingSlashPattern);
  let source = anyDepthFromRoot || !slashAnchored ? '^(?:|.*\\/)' : '^';
  for (let index = 0; index < body.length; index += 1) {
    const triplet = body.slice(index, index + 3);
    const pair = body.slice(index, index + 2);
    if (triplet === '**/') {
      source += '(?:[^/]+/)*';
      index += 2;
      continue;
    }
    if (pair === '**') {
      source += '.*';
      index += 1;
      continue;
    }
    const character = body[index];
    if (character === '*') {
      source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(character);
  }
  if (directoryLikePattern) {
    source += '(?:/.*)?';
  }
  source += '$';
  return new RegExp(source).test(normalizedPath);
}
export function effectiveRegularCommentActivityAt(comment) {
  const updatedAt = String(comment.updatedAt ?? '');
  if (
    isValidIsoTimestamp(updatedAt) &&
    compareIsoTimestamps(updatedAt, comment.createdAt) > 0
  ) {
    return updatedAt;
  }
  return comment.createdAt;
}
function isSourcePinnedRequirementId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0;
}
function tokenizeCodeownersLine(line) {
  const tokens = [];
  let current = '';
  let escaped = false;
  for (const character of String(line ?? '')) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === ' ' || character === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (escaped) {
    current += '\\';
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}
function hasCodeownerOwners(rule) {
  return (
    (rule?.users?.length ?? 0) > 0 ||
    (rule?.teams?.length ?? 0) > 0 ||
    (rule?.emails?.length ?? 0) > 0
  );
}
// True when a PR-author login belongs to a gate-relevant advisory bot — a known
// review bot (CodeRabbit/Codex/Copilot defaults) or a configured
// `advisoryBotLogins` entry. The GitHub `[bot]` suffix is normalized
// symmetrically via `advisoryBotIdentityToken` on both the incoming login and
// each configured entry, so a custom bot matches whether the config or the
// author login stores the suffixed (`my-bot[bot]`) or suffixless (`my-bot`)
// form. Fail-closed on an empty token.
export function isGateAdvisoryBotLogin(login, advisoryBotLogins) {
  const token = advisoryBotIdentityToken(login);
  if (!token) {
    return false;
  }
  return (
    isKnownReviewBot(token) ||
    isConfiguredAdvisoryBotLogin(login, advisoryBotLogins)
  );
}
// True when a login matches a **configured** `advisoryBotLogins` entry, with the
// GitHub `[bot]` suffix normalized symmetrically via `advisoryBotIdentityToken`
// on both the incoming login and each configured entry — so a custom bot matches
// whether either side stores the suffixed (`my-bot[bot]`) or suffixless
// (`my-bot`) form. Unlike `isGateAdvisoryBotLogin`, this does **not** also match
// `isKnownReviewBot`: the advisory courtesy-ack carve-outs must recognize only
// configured advisory bots, so a Copilot/known-review-bot ack is never
// reclassified as a configured-advisory-bot ack. Fail-closed on an empty token.
export function isConfiguredAdvisoryBotLogin(login, advisoryBotLogins) {
  const token = advisoryBotIdentityToken(login);
  if (!token) {
    return false;
  }
  for (const configured of advisoryBotLogins) {
    if (advisoryBotIdentityToken(configured) === token) {
      return true;
    }
  }
  return false;
}
function _isOperationalOrDigestComment(body) {
  return (
    operationalMarkerPrefix(body) !== null ||
    firstLine(body) === LIVE_STATUS_DIGEST_MARKER
  );
}
function isOperationalOrDigestCommentForGate(
  body,
  authorLogin,
  trustedMarkerLogins,
) {
  const marker = operationalMarkerPrefix(body);
  if (marker === '<!-- forced-handoff:') {
    return trustedMarkerLogins.has(
      String(authorLogin ?? '')
        .trim()
        .toLowerCase(),
    );
  }
  return marker !== null || firstLine(body) === LIVE_STATUS_DIGEST_MARKER;
}
function buildBodyPreview(body) {
  return firstLine(String(body ?? '')).slice(0, 120);
}
function advisoryWaitMarkerMatchesHead(body, prHeadSha) {
  return (
    new RegExp(`^advisory-wait: [^ ]+ ${escapeRegExp(prHeadSha)}(?: |$)`).test(
      body,
    ) ||
    new RegExp(
      `^advisory-wait-recovery: [^ ]+ ${escapeRegExp(prHeadSha)}(?: |$)`,
    ).test(body) ||
    new RegExp(
      `^<!-- advisory-wait: [^ ]+ ${escapeRegExp(prHeadSha)} [^ ]+ -->$`,
    ).test(body)
  );
}
function advisoryWaitRequestMarker(body) {
  return /^advisory-wait:/.test(body) || /^<!-- advisory-wait:/.test(body);
}
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function minutesBetweenIso(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 60000);
}
export function compareIsoTimestamps(left, right) {
  const leftComparable = normalizeComparableTimestamp(left);
  const rightComparable = normalizeComparableTimestamp(right);
  if (
    typeof leftComparable === 'number' &&
    typeof rightComparable === 'number'
  ) {
    if (leftComparable !== rightComparable) {
      return leftComparable - rightComparable;
    }
    return String(left ?? '').localeCompare(String(right ?? ''));
  }
  if (typeof leftComparable === 'number') {
    return 1;
  }
  if (typeof rightComparable === 'number') {
    return -1;
  }
  return String(left ?? '').localeCompare(String(right ?? ''));
}
function threadActivityAt(thread) {
  if (isValidIsoTimestamp(thread.updatedAt ?? '')) {
    return thread.updatedAt;
  }
  const commentTimes = (thread.comments?.nodes ?? [])
    .flatMap((comment) => [comment.updatedAt, comment.createdAt])
    .filter(isValidIsoTimestamp);
  return maxIsoTimestamp(commentTimes);
}
function effectiveThreadCommentActivityAt(comment) {
  const updatedAt = String(comment?.updatedAt ?? '');
  if (isValidIsoTimestamp(updatedAt)) {
    return updatedAt;
  }
  const createdAt = String(comment?.createdAt ?? '');
  if (isValidIsoTimestamp(createdAt)) {
    return createdAt;
  }
  return '';
}
function hasCompletedBotThreadDispositions(
  threads,
  loginPredicate,
  options = {},
) {
  const botThreads = threads.filter((thread) => {
    return (thread.comments?.nodes ?? []).some((comment) => {
      return (
        loginPredicate(comment.author?.login ?? '') &&
        !isDispositionComment(comment)
      );
    });
  });
  return (
    botThreads.length > 0 &&
    botThreads.every((thread) => {
      return (
        thread.isResolved &&
        !thread.comments?.pageInfo?.hasNextPage &&
        hasFreshDisposition(thread, {
          isDispositionAuthor: options.isDispositionAuthor,
        })
      );
    })
  );
}
function hasUnresolvedKnownBotThreads(threads) {
  return threads.some((thread) => {
    if (thread.isResolved) {
      return false;
    }
    if (thread.comments?.pageInfo?.hasNextPage) {
      return true;
    }
    return (thread.comments?.nodes ?? []).some((comment) => {
      return isKnownReviewBot(comment.author?.login ?? '');
    });
  });
}
function isCompletedCiTimestamp(value) {
  const timestamp = String(value ?? '');
  return timestamp !== '0001-01-01T00:00:00Z' && isValidIsoTimestamp(timestamp);
}
function normalizeComparableTimestamp(value) {
  const normalized = String(value ?? 'none');
  if (normalized === 'none') {
    return 'none';
  }
  if (!isValidIsoTimestamp(normalized)) {
    return null;
  }
  return Date.parse(normalized);
}
