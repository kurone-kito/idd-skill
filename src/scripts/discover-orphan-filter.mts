#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-orphan-filter.mts
//
// The scripts/discover-orphan-filter.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { existsSync } from 'node:fs';

import {
  buildAuthoringLabelWarning,
  resolveAuthoringGuardPolicy,
} from './authoring-label-guard.mts';
import {
  DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
  rankAndRouteBySuitability,
} from './autopilot-suitability.mts';
import { stripLeadingArgumentSeparator } from './cli-args.mts';
import {
  type CollaboratorPermissionCache,
  collaboratorPermission,
} from './collaborator-permission.mts';
import {
  extractBlockedByIssueNumbers,
  extractDependencyIssueNumbers,
  isParentEpicIssue,
} from './discover-readiness-check.mts';
import {
  annotateLeafClaimState,
  buildClaimStateResolution,
  type ClaimStateResolution,
  type LeafActiveClaim,
} from './discover-roadmap-graph.mts';
import { type EffortHint, effortOrdinal, parseEffort } from './effort.mts';
import { loadPolicyConfig } from './idd-config.mts';
import { stripMarkdownCodeRegions } from './markdown-code.mts';
import { createMarkerRegex } from './marker-regex.mts';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mts';
import { resolveTrustedMarkerActors } from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type { ProviderPort } from './provider-port.mts';
import {
  findTrustedSuitabilityRejection,
  isSuitabilityTriageVerdictCurrent,
  resolveLatestSubstantiveIssueEditAt,
  type SuitabilityRejectionComment,
} from './supersession-detection.mts';
import {
  buildTrustedLoginPredicate,
  candidateFilesExistOnDisk,
  evaluateStructuralEvidence,
  hasAllStructuralSignals,
  hasVerificationCommandSignal,
  type StructuralEvidence,
} from './triage-structural-evidence.mts';

const DEFAULT_MARKER_PREFIX = 'idd-skill';

// A runtime/production-observation precondition (#2467) carries no
// issue-number reference, so neither the marker checks above nor the
// numbered-reference resolution below ever see it -- a follow-up gated by
// "confirmed in production" / "observed live" / "runtime-observation" reads
// as a plain orphan once its linked code dependency merges. Kept narrow
// (three phrasings plus tense variants) rather than a broad "wait/deploy"
// vocabulary: a false positive here permanently exiles a startable issue
// from the discover pool, while a false negative only preserves today's
// behavior.
const RUNTIME_OBSERVATION_PATTERNS = [
  /\bconfirm(?:ed|ing)?\s+(?:to\s+take\s+effect\s+)?in\s+production\b/gi,
  /\bobserv(?:ed|ing)?\s+live\b/gi,
  /\bruntime[- ]observation\b/gi,
];
const NEGATION_CUE_PATTERN =
  /\b(?:not|never|without|isn't|is not|doesn't|does not|don't|do not|won't|will not|no need|needn't)\b/i;
const NEGATION_CUE_WINDOW = 40;
const NEGATION_HARD_BREAK_PATTERN = /[.;\n]|--|—/g;
const OPEN_QUOTE_CHARS = new Set(['"', "'", '“', '‘']);
const CLOSE_QUOTE_CHARS = new Set(['"', "'", '”', '’']);
const TRAILING_QUOTE_PUNCTUATION_PATTERN = /^[.,!?;:]*/;
// A match opening a much longer quoted excerpt attributed to a different,
// cited issue by number ("Issue #2743 asserted in its Background:
// '<trigger phrase>: ...much more quoted prose...' -- describing a
// specific event.", #2746) is quoted historical context from another
// issue, not a live precondition on THIS issue -- even though ordinary
// sentence punctuation (a colon) continues the quotation right after the
// match instead of a closing quote character, so `isQuotedMatch` below
// never recognizes it. Scoped narrowly to the shape this issue found: an
// open-quote character immediately before the match (the same adjacency
// `isQuotedMatch` requires), preceded within a bounded window by an
// issue-number reference and then a colon introducing the quotation.
//
// Two conditions bound the colon to that same attribution, not just any
// nearby colon (Copilot/Codex/CodeRabbit review, PR #2760): the colon
// must directly introduce the quote (only whitespace between the colon
// and the opening quote character -- "Issue #42: prior history. The
// requirement is 'X'" has no such colon and must NOT match), and no hard
// clause break (period/semicolon/em-dash) may separate the issue-number
// reference from that colon -- "See #42 for rollout details. Acceptance
// gate: 'X'" has an unrelated label's colon after a sentence break and
// must NOT match either, even though a colon does directly precede the
// quote. When more than one issue reference sits in the window ("See #1.
// Issue #2 asserted: 'X'"), bind to the LAST one, not the first -- an
// earlier, unrelated reference must not make a genuine attribution look
// hard-broken (round-2 Copilot/Codex review, PR #2760).
//
// Attribution alone does not prove the quoted text is inert history: an
// issue can cite another issue's prerequisite and explicitly RE-ADOPT it,
// either right after the quote closes ("Per issue #42: 'confirmed in
// production before shipping' remains required" -- Codex review, PR
// #2760) or right before the citation opens ("This change still
// requires issue #42's gate: 'confirmed in production before shipping'"
// -- Codex review round 4, PR #2760). A requirement-assertion word on
// EITHER side, with no hard break in between, cancels this exclusion --
// the same bidirectional shape `discover-viability-gate.mts`'s own
// requirement-assertion cancellation already uses.
const CITED_ISSUE_ATTRIBUTION_WINDOW = 80;
const ISSUE_NUMBER_REFERENCE_PATTERN = /#\d+/g;
const CITED_ISSUE_ATTRIBUTION_COLON_PATTERN = /:\s*$/;
// Every standard English sentence terminator, not just period/semicolon
// -- a question or exclamation mark ending an unrelated sentence must
// also stop an earlier reference from attributing a later quote (Codex
// review round 3, PR #2760). A bare newline is a Markdown SOFT wrap, not
// a clause break -- only a blank line OR a following list-item marker
// (a real paragraph/list boundary) counts, matching
// `discover-viability-gate.mts`'s own CUE_HARD_BREAK_PATTERN exactly: a
// genuine attribution can wrap between the reference and its colon just
// as easily as between the colon and the quote (Codex review round 5,
// PR #2760), but separate bullets written without a blank line ("-
// Related issue #42\n- Acceptance gate: 'X'") must not connect through
// each other either (Codex review round 6, PR #2760).
const CITED_ISSUE_ATTRIBUTION_HARD_BREAK_PATTERN =
  /[.;?!]|--|—|\n[ \t]*(?:[-*]\s|\d+[.)]\s)|\n[ \t]*\n/;
// The requirement-assertion lookahead/lookbehind windows stay bounded
// (40 chars); only the CLOSE-QUOTE search itself is unbounded, since
// this exclusion exists specifically for quotes that copy a "much
// longer" excerpt verbatim -- an artificial bound there left a real
// closer, and any re-adoption cue past it, unreached (Codex review
// round 4, PR #2760; comment corrected per Copilot review round 5).
const ATTRIBUTION_REQUIREMENT_LOOKAHEAD_WINDOW = 40;
// `blocked`/`blocking`/`pending`/`waiting`/`shall`/`essential` join the
// same vocabulary `discover-viability-gate.mts`'s own requirement-
// assertion pattern already uses, so a re-adopted prerequisite phrased
// as "remains blocked" or "shall remain the acceptance gate" is
// recognized too, not only "remains required" (Codex review rounds 3
// and 5, PR #2760).
const ATTRIBUTION_REQUIREMENT_ASSERTION_PATTERN =
  /\b(required|require[sd]?|requiring|must|needed|needs?|mandatory|necessary|blocked|blocking|pending|waiting|shall|essential)\b/i;
// A quoted excerpt's closer must PAIR with its actual opener, not match
// any member of the flat CLOSE_QUOTE_CHARS set -- otherwise an unrelated
// apostrophe of a DIFFERENT quote family inside the excerpt (a plural
// possessive like "operators'", not merely a contraction already
// guarded above) can still be mistaken for the closer, making the real
// closer and any re-adoption cue past it unreachable (Codex review
// round 5, PR #2760). Mirrors `discover-viability-gate.mts`'s own
// `QUOTE_CHAR_PAIRS`.
const QUOTE_CHAR_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  '‘': '’',
  '“': '”',
};
// A straight/curly apostrophe inside the quoted excerpt itself (a
// contraction or possessive, e.g. "it's") must not be mistaken for the
// closing quote -- only a candidate NOT immediately followed by a
// letter or digit is a plausible closer (Copilot review round 3, PR
// #2760), mirroring `discover-viability-gate.mts`'s own
// quote-vs-apostrophe adjacency check.
const WORD_CHAR_PATTERN = /[A-Za-z0-9]/;

/** Reasons that keep an issue out of the orphan candidate list. */
export type OrphanFilteredReason =
  | 'provider_outage_target'
  | 'roadmap_marker'
  | 'blocked_by_marker'
  | 'blocked_label'
  | 'authoring_label'
  | 'runtime_observation_precondition'
  | 'blocked_by_open_reference'
  | 'open_dependency_reference'
  | 'unresolvable_reference'
  | 'triage_verdict_rejected';

/** Classification verdict for one issue in the orphan filter. */
export type OrphanClassification =
  | {
      orphan: true;
      reason: 'orphan' | 'references_non_blocking';
      details?: undefined;
      /** #2767: present only when a runtime-observation-precondition hit
       * was demoted (every structural-evidence signal held) rather than
       * genuinely absent -- the caller surfaces this in its top-level
       * `warnings[]` array, mirroring the existing stale-authoring-label
       * warning shape. */
      warning?: 'runtime_observation_precondition_demoted';
    }
  | {
      orphan: false;
      reason:
        | 'provider_outage_target'
        | 'roadmap_marker'
        | 'blocked_by_marker'
        | 'runtime_observation_precondition';
      details?: undefined;
    }
  | {
      orphan: false;
      reason: 'blocked_label' | 'authoring_label';
      details: string;
    }
  | { orphan: false; reason: 'blocked_by_open_reference'; details: number }
  | { orphan: false; reason: 'open_dependency_reference'; details: number }
  | { orphan: false; reason: 'unresolvable_reference'; details: number[] };

interface OrphanIssueInput {
  number: number;
  title?: unknown;
  state?: unknown;
  labels?: unknown;
  labelEvents?: unknown;
  body?: unknown;
  url?: unknown;
  milestone?: unknown;
  /** GitHub `created_at` (#2243): the staleness-check fallback anchor
   * consumed by {@link resolveLatestSubstantiveIssueEditAt} when the
   * candidate has never been substantively edited. */
  createdAt?: unknown;
  /** #2767: raw REST `user` field, read only for the `trustedEditor`
   * structural-evidence signal's author login. */
  user?: unknown;
}

interface ClassifyIssueOptions {
  issueStateByNumber: Map<number, string>;
  fetchIssueStateByNumber: (issueNumber: number) => string;
  markerPrefix?: unknown;
  authoringLabelName?: unknown;
  blockedByHumanLabelName?: unknown;
  needsDecisionLabelName?: unknown;
  roadmapLabelName?: unknown;
  /**
   * The configured `providerOutage.declarationTarget` issue number
   * (#2800), or `null`/absent when unconfigured. That issue is a
   * permanent, adopter-authored coordination issue meant to stay open
   * indefinitely, carrying no roadmap/blocked markers or blocking
   * labels of its own — so it is excluded by number, ahead of every
   * marker/label check below, rather than relying on any of them.
   */
  providerOutageDeclarationTarget?: number | null;
  /**
   * Lookup used **only** to resolve an open `Depends on #NNN` / task-list
   * dependency reference's title/labels for the parent-epic exemption
   * (#1536) — never for `Blocked by` references, which have no exemption,
   * matching A3's own asymmetry in `discover-readiness-check.mts`. A
   * reference absent from this map (or the map itself absent) fails
   * closed: treated as not epic-exempt, so it still blocks.
   */
  openIssueDetailsByNumber?: Map<number, { title: unknown; labels: unknown }>;
  /** #2767: pre-computed structural-evidence signal for this issue, read
   * only to decide whether a `runtime_observation_precondition` hit
   * demotes to a warned orphan instead of a hard filter. */
  structuralEvidence?: StructuralEvidence;
}

interface FilterOrphanIssuesOptions {
  issueStateByNumber?: Iterable<[number, string]>;
  fetchIssueStateByNumber?: (issueNumber: number) => string;
  fetchLabelEventsByIssueNumber?: (issueNumber: number) => unknown[];
  markerPrefix?: unknown;
  authoringLabelName?: unknown;
  blockedByHumanLabelName?: unknown;
  needsDecisionLabelName?: unknown;
  roadmapLabelName?: unknown;
  /** See {@link ClassifyIssueOptions.providerOutageDeclarationTarget}. */
  providerOutageDeclarationTarget?: number | null;
  authoringStaleAgeMs?: number;
  autopilotSuitabilityFloor?: number;
  autopilotSuitabilityEnabled?: boolean;
  autopilot?: boolean;
  now?: Date | string;
  /**
   * Opt-in active-claim annotation (`--with-claim-state`, #1395). Gated the
   * same way as `discover-roadmap-graph`: absent means NO extra GitHub API
   * calls and no claim fields on any candidate, keeping the default output
   * byte-stable.
   */
  claimState?: ClaimStateResolution;
  /**
   * #2243 triage-verdict exclusion (default-on, unlike `claimState` above):
   * fetches each surviving candidate's comments to look for a still-current
   * trusted `A4.5 suitability gate rejection` marker. Only actually runs
   * when BOTH this and {@link trustedMarkerLogins} are supplied and
   * non-empty -- the CLI wiring always supplies both, so the live default
   * output does carry this check; a caller (including this file's own
   * tests) that omits either gets the prior byte-stable shape with no
   * extra fetch, matching this module's existing fail-safe direction (a
   * missing evidence source never skips a candidate, it just leaves the
   * candidate unfiltered by this specific check).
   */
  fetchCommentsByIssueNumber?: (
    issueNumber: number,
  ) => SuitabilityRejectionComment[];
  /** #2243: per-candidate timeline fetch for the staleness anchor
   * ({@link resolveLatestSubstantiveIssueEditAt}). Defaults to "no events"
   * when omitted, which only widens the staleness window (never narrows
   * it), so an absent fetcher cannot itself cause a wrongful skip. */
  fetchTimelineByIssueNumber?: (issueNumber: number) => unknown[];
  /** #2762: per-candidate GraphQL `userContentEdits.editedAt` fetch for the
   * same staleness anchor -- the only place GitHub records a body edit (a
   * REST timeline `edited` event with a `changes.body` payload is never
   * emitted for a real edit). Defaults to "no timestamps" when omitted,
   * which only widens the staleness window like
   * {@link fetchTimelineByIssueNumber} above, never narrows it. Called
   * inside the same try/catch as the timeline fetch below, so a failure
   * here degrades the whole anchor to `null` ("unknown") rather than
   * silently falling back to a partial computation -- never the bare
   * `created_at` anchor #2762 fixes. */
  fetchUserContentEditsByIssueNumber?: (issueNumber: number) => unknown[];
  /** #2243: trust-actor allowlist for the triage-verdict marker scan, same
   * semantics as `idd-claim.instructions.md`'s trusted marker actors. Also
   * doubles (#2767) as the static allow-list half of the structural-
   * evidence `trustedEditor` signal's trust predicate. */
  trustedMarkerLogins?: string[];
  /** #2767: per-candidate editor-login fetch (GraphQL
   * `Issue.userContentEdits.editor.login`), called ONLY when a candidate
   * would otherwise be filtered as `runtime_observation_precondition` --
   * computing the full structural-evidence signal is real network cost
   * (this fetch plus a live collaborator-permission check per unique
   * editor), so it is never paid for a candidate no demotion could help.
   * Absent means "never demotes" (the prior, byte-stable behavior). */
  fetchUserContentEditorsByIssueNumber?: (
    issueNumber: number,
  ) => (string | null)[];
  /** #2767: collaborator-permission-based fallback half of the
   * `trustedEditor` trust predicate, checked only when a login is not in
   * `trustedMarkerLogins`. Absent means the static list alone decides. */
  isTrustedCollaborator?: (login: string) => boolean;
  /** #2767: filesystem existence check for the `candidateFilesExist`
   * signal. Defaults to the real `existsSync` when absent -- overridable
   * for tests. */
  existsAt?: (path: string) => boolean;
}

/** #2767: warning shape for a demoted `runtime_observation_precondition`
 * hit, distinct from {@link buildAuthoringLabelWarning}'s
 * `AuthoringLabelWarning` shape (which carries label-specific fields that
 * don't apply here) but sharing the same `issueNumber` + `message`
 * surface every warnings[] consumer already reads generically. */
interface StructuralEvidenceDemotionWarning {
  issueNumber: number;
  reason: 'runtime_observation_precondition_demoted';
  message: string;
}

interface FilteredIssueEntry {
  number: number;
  title: unknown;
  state: unknown;
  reason: OrphanFilteredReason;
  details: string | number | number[] | null;
  url: unknown;
}

interface OrphanCandidate {
  number: number;
  title: unknown;
  state: unknown;
  reason: string;
  url: unknown;
  autopilotSuitability: number | null;
  effort: EffortHint | null;
  /**
   * Title of this candidate's OPEN milestone, or null when it has none,
   * the milestone is closed, or the field was absent from the API
   * response — surfaced for evidence only; this file's own ranking does
   * not read it (#2340; see `discover-roadmap-graph.mts`'s
   * `discover.milestoneScope` preference for the ranking behavior).
   */
  milestone: string | null;
  /**
   * Active-claim annotation, present only under `--with-claim-state` (#1395),
   * mirroring `discover-roadmap-graph`'s `RoadmapGraphNode.activeClaim` shape
   * exactly (Design O): `present: false` (with `claimId: null`,
   * `agentId: null`) means no trusted claim is present, `present: true` means
   * one exists (possibly stale). Absent in the default (flag-absent) path so
   * the byte-stable output shape is unchanged.
   */
  activeClaim?: LeafActiveClaim;
  /**
   * Derived eligibility: `true` when no present, non-stale, trusted-actor
   * claim blocks this candidate. Present only under `--with-claim-state`.
   */
  claimEligible?: boolean;
}

interface ParsedArgs {
  owner: string;
  repo: string;
  policy: string;
  pr: number | null;
  help: boolean;
  now: string;
  autopilot: boolean;
  withClaimState: boolean;
  currentClaimId: string;
}

if (import.meta.main) {
  await runCli();
}

/**
 * Collect the visible `Blocked by #N` references in `body`. Delegates to the
 * readiness composer's `extractBlockedByIssueNumbers` (#1311) instead of a
 * second inline "Blocked by" regex, so this filter and the readiness gate
 * share one dependency-line primitive — including its colon tolerance
 * (`Blocked by: #123`), blockquote/list-bullet prefix tolerance, and
 * code-region stripping.
 */
export function extractBlockedByReferences(body: unknown): number[] {
  return extractBlockedByIssueNumbers(String(body ?? ''));
}

// A negation ("does not need to be confirmed in production") within the
// same clause turns the match into the opposite of a precondition -- scoped
// to the nearest hard clause break so a negation cue from an earlier (or,
// for the after-match check, a later) unrelated sentence cannot suppress a
// genuine match (mirrors `AVOIDANCE_CUE_WINDOW`'s clause-scoping in
// `discover-viability-gate.mts`). A same-clause negation can follow the
// matched phrase too ("Runtime observation is not required before
// starting", #2529 review) -- both directions share the same cue list and
// window.
function hasNegationCueBefore(text: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - NEGATION_CUE_WINDOW);
  const window = text.slice(windowStart, matchIndex);
  const breaks = [...window.matchAll(NEGATION_HARD_BREAK_PATTERN)];
  const lastBreak = breaks.at(-1);
  const scoped = lastBreak
    ? window.slice(lastBreak.index + lastBreak[0].length)
    : window;
  return NEGATION_CUE_PATTERN.test(scoped);
}

function hasNegationCueAfter(text: string, matchEnd: number): boolean {
  const windowEnd = Math.min(text.length, matchEnd + NEGATION_CUE_WINDOW);
  const window = text.slice(matchEnd, windowEnd);
  const breaks = [...window.matchAll(NEGATION_HARD_BREAK_PATTERN)];
  const firstBreak = breaks[0];
  const scoped = firstBreak ? window.slice(0, firstBreak.index) : window;
  return NEGATION_CUE_PATTERN.test(scoped);
}

// A phrase quoted as a term being discussed (e.g. this function's own
// motivating issue, which names the trigger phrases inside straight double
// quotes) is meta-discussion, not an asserted precondition on THIS issue.
// Sentence punctuation routinely sits INSIDE the closing quote ("observed
// live." -- #2529 review), so the close side tolerates a short run of
// punctuation between the match and the quote character; the open side
// stays exact-adjacent, matching every observed real-world shape.
function isQuotedMatch(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const afterSlice = text.slice(end, end + 4);
  const punctuation = TRAILING_QUOTE_PUNCTUATION_PATTERN.exec(afterSlice);
  const after = afterSlice[punctuation?.[0]?.length ?? 0];
  return (
    before !== undefined &&
    after !== undefined &&
    OPEN_QUOTE_CHARS.has(before) &&
    CLOSE_QUOTE_CHARS.has(after)
  );
}

// A requirement-assertion word shortly after the quote closes, with no
// hard break in between, means the citing issue RE-ADOPTS the quoted
// prerequisite as its own live requirement rather than merely reporting
// inert history (Codex review, PR #2760). The close side searches the
// rest of the corpus for a character that PAIRS with `opener` -- this
// exclusion exists precisely for "much longer" quotes, so the closer can
// be arbitrarily far from the match (Codex review round 4, PR #2760) --
// rather than any member of CLOSE_QUOTE_CHARS, so an apostrophe of a
// DIFFERENT quote family inside the excerpt (a plural possessive like
// "operators'" inside a double-quoted excerpt) is never mistaken for
// the real closer (Codex review round 5, PR #2760). Pairing alone still
// isn't enough for a SINGLE-quoted excerpt: an internal plural
// possessive apostrophe is the SAME family as the real closer, so every
// plausible candidate is tried in order (not just the first) until one
// is followed by a requirement assertion, or none are left (Copilot/
// Codex review round 6, PR #2760).
function isFollowedByRequirementAssertion(
  text: string,
  quotedContentStart: number,
  opener: string,
): boolean {
  const closer = QUOTE_CHAR_PAIRS[opener];
  if (closer === undefined) {
    return false;
  }
  const region = text.slice(quotedContentStart);
  let searchFrom = 0;
  while (searchFrom < region.length) {
    let closeOffset = -1;
    for (let i = searchFrom; i < region.length; i++) {
      if (region[i] !== closer) {
        continue;
      }
      if (WORD_CHAR_PATTERN.test(region[i + 1] ?? '')) {
        continue;
      }
      closeOffset = i;
      break;
    }
    if (closeOffset === -1) {
      return false;
    }
    const afterClose = quotedContentStart + closeOffset + 1;
    const lookahead = text.slice(
      afterClose,
      Math.min(
        text.length,
        afterClose + ATTRIBUTION_REQUIREMENT_LOOKAHEAD_WINDOW,
      ),
    );
    const hardBreak =
      CITED_ISSUE_ATTRIBUTION_HARD_BREAK_PATTERN.exec(lookahead);
    const scoped = hardBreak ? lookahead.slice(0, hardBreak.index) : lookahead;
    if (ATTRIBUTION_REQUIREMENT_ASSERTION_PATTERN.test(scoped)) {
      return true;
    }
    searchFrom = closeOffset + 1;
  }
  return false;
}

// The mirror image of {@link isFollowedByRequirementAssertion}: a
// requirement-assertion word shortly BEFORE the cited reference, with no
// hard break in between, means the citing issue already re-adopted the
// prerequisite before ever citing it ("This change still requires issue
// #42's gate: 'X'" -- Codex review round 4, PR #2760).
function isPrecededByRequirementAssertion(
  text: string,
  referenceStart: number,
): boolean {
  const windowStart = Math.max(
    0,
    referenceStart - ATTRIBUTION_REQUIREMENT_LOOKAHEAD_WINDOW,
  );
  const lookbehind = text.slice(windowStart, referenceStart);
  const breaks = [
    ...lookbehind.matchAll(
      new RegExp(CITED_ISSUE_ATTRIBUTION_HARD_BREAK_PATTERN, 'g'),
    ),
  ];
  const lastBreak = breaks.at(-1);
  const scoped = lastBreak
    ? lookbehind.slice(lastBreak.index + lastBreak[0].length)
    : lookbehind;
  return ATTRIBUTION_REQUIREMENT_ASSERTION_PATTERN.test(scoped);
}

// A match that opens a longer quoted excerpt attributed to a different,
// cited issue by number (#2746) -- see the constants above for the
// motivating shape. Only the open-quote adjacency is required on the
// open side (unlike `isQuotedMatch`: the whole point of this exclusion
// is the shape where no nearby closing quote follows the match itself).
// `selfIssueNumber`, when given, prevents an issue from attributing a
// quote to ITSELF: "Issue #122 acceptance criterion: 'X'" inside issue
// #122's own body is not an external citation, so the cited number must
// differ from the candidate's own (Codex review round 5, PR #2760).
function isAttributedLongQuote(
  text: string,
  start: number,
  selfIssueNumber?: number,
): boolean {
  const before = text[start - 1];
  if (before === undefined || !OPEN_QUOTE_CHARS.has(before)) {
    return false;
  }
  const windowStart = Math.max(0, start - 1 - CITED_ISSUE_ATTRIBUTION_WINDOW);
  const window = text.slice(windowStart, start - 1);
  const colonMatch = CITED_ISSUE_ATTRIBUTION_COLON_PATTERN.exec(window);
  if (!colonMatch) {
    return false;
  }
  const referenceMatches = [...window.matchAll(ISSUE_NUMBER_REFERENCE_PATTERN)];
  const referenceMatch = referenceMatches.at(-1);
  if (!referenceMatch || referenceMatch.index === undefined) {
    return false;
  }
  if (
    selfIssueNumber !== undefined &&
    Number(referenceMatch[0].slice(1)) === selfIssueNumber
  ) {
    return false;
  }
  // Stop at the introducing colon itself -- the whitespace AFTER it
  // (which can include a Markdown soft-wrap newline before the quote,
  // e.g. "Background:\n\"X\"") is not part of the reference-to-colon
  // relationship this hard-break scan is meant to police (Codex review
  // round 3, PR #2760).
  const betweenReferenceAndColon = window.slice(
    referenceMatch.index + referenceMatch[0].length,
    colonMatch.index,
  );
  return (
    !CITED_ISSUE_ATTRIBUTION_HARD_BREAK_PATTERN.test(
      betweenReferenceAndColon,
    ) &&
    !isFollowedByRequirementAssertion(text, start, before) &&
    !isPrecededByRequirementAssertion(text, windowStart + referenceMatch.index)
  );
}

/**
 * Detect prose naming a runtime/production-observation precondition
 * (#2467) anywhere in `body`, outside of code regions. Returns `true` on
 * the first match that is neither quoted nor negated -- callers only need a
 * boolean gate, not the matched span. `selfIssueNumber`, when given, stops
 * the candidate's own issue number from being treated as an external
 * citation by {@link isAttributedLongQuote} (Codex review round 5, PR
 * #2760).
 */
export function detectRuntimeObservationPrecondition(
  body: unknown,
  selfIssueNumber?: number,
): boolean {
  const stripped = stripMarkdownCodeRegions(String(body ?? ''));
  for (const pattern of RUNTIME_OBSERVATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(stripped);
    while (match) {
      const end = match.index + match[0].length;
      if (
        !isQuotedMatch(stripped, match.index, end) &&
        !isAttributedLongQuote(stripped, match.index, selfIssueNumber) &&
        !hasNegationCueBefore(stripped, match.index) &&
        !hasNegationCueAfter(stripped, end)
      ) {
        return true;
      }
      match = pattern.exec(stripped);
    }
  }
  return false;
}

export function getOrphanFirstPolicy(config: unknown): string {
  if (!config || typeof config !== 'object') {
    return 'none';
  }

  const commands = (config as { commands?: unknown }).commands;
  if (
    commands &&
    typeof commands === 'object' &&
    typeof (commands as Record<string, unknown>)['orphan-first-policy'] ===
      'string'
  ) {
    return (commands as Record<string, string>)['orphan-first-policy'];
  }

  const orphanFirstPolicy = (config as { orphanFirstPolicy?: unknown })
    .orphanFirstPolicy;
  if (typeof orphanFirstPolicy === 'string') {
    return orphanFirstPolicy;
  }

  return 'none';
}

export function classifyIssue(
  issue: OrphanIssueInput,
  options: ClassifyIssueOptions,
): OrphanClassification {
  // #2800: checked first, ahead of every marker/label check below — the
  // declaration target is deliberately marker-less and label-less, so
  // none of those checks would ever catch it on their own.
  if (
    options.providerOutageDeclarationTarget != null &&
    Number(issue.number) === options.providerOutageDeclarationTarget
  ) {
    return { orphan: false, reason: 'provider_outage_target' };
  }

  const labels = new Set(normalizeLabels(issue.labels));
  const body = String(issue.body ?? '');
  const markerPrefix = normalizeMarkerPrefix(options.markerPrefix);
  const authoringLabelName = normalizeAuthoringLabelName(
    options.authoringLabelName,
  );
  const blockedByHumanLabelName = normalizeBlockedByHumanLabelName(
    options.blockedByHumanLabelName,
  );
  const needsDecisionLabelName = normalizeNeedsDecisionLabelName(
    options.needsDecisionLabelName,
  );
  const roadmapMarkerRegex = createMarkerRegex(markerPrefix, 'roadmap-id');
  const blockedMarkerRegex = createMarkerRegex(markerPrefix, 'blocked-by');

  if (roadmapMarkerRegex.test(body)) {
    return { orphan: false, reason: 'roadmap_marker' };
  }

  if (blockedMarkerRegex.test(body)) {
    return { orphan: false, reason: 'blocked_by_marker' };
  }

  const blockedLabels = new Set([
    blockedByHumanLabelName,
    needsDecisionLabelName,
  ]);
  const blockedLabel = [...labels].find((label) => blockedLabels.has(label));
  if (blockedLabel) {
    return { orphan: false, reason: 'blocked_label', details: blockedLabel };
  }

  if (labels.has(authoringLabelName)) {
    return {
      orphan: false,
      reason: 'authoring_label',
      details: authoringLabelName,
    };
  }

  // Runs regardless of blockedRefs/dependencyRefs state (#2467): a
  // production-observation precondition has no issue-number reference to
  // resolve, so it must still hold even when every numbered reference below
  // is absent or already closed.
  //
  // #2767: a hit demotes to a warned orphan (fall through, don't return)
  // only when every structural-evidence signal holds; otherwise this
  // remains a hard filter exactly as before.
  let runtimeObservationDemoted = false;
  if (detectRuntimeObservationPrecondition(body, Number(issue.number))) {
    if (hasAllStructuralSignals(options.structuralEvidence)) {
      runtimeObservationDemoted = true;
    } else {
      return { orphan: false, reason: 'runtime_observation_precondition' };
    }
  }
  const demotionWarning = runtimeObservationDemoted
    ? ({ warning: 'runtime_observation_precondition_demoted' } as const)
    : {};

  // Two independent reference families, matching A3's own dependency check
  // in `discover-readiness-check.mts` (#1536): visible `Blocked by #NNN`
  // lines (a hard sequential dependency, no exemption) and `Depends on
  // #NNN` / task-list dependency references (which exempt an open parent
  // epic / aggregate issue, mirroring `isParentEpicIssue`). A0-O passes
  // survivors directly to A3.5 and skips A3 entirely, so without this
  // second family a helper-driven run could select an orphan whose only
  // open blocker is a dependency reference, even though the roadmap path
  // would already filter it out. `Blocked by` is checked first (matching
  // the original single-list order) so an issue that carries both kinds
  // reports the same `blocked_by_open_reference` / `unresolvable_reference`
  // reason it always has when that reference alone already blocks.
  const blockedRefs = extractBlockedByReferences(body);
  const dependencyRefs = extractDependencyIssueNumbers(body);
  if (blockedRefs.length === 0 && dependencyRefs.length === 0) {
    return { orphan: true, reason: 'orphan', ...demotionWarning };
  }

  const unresolved: number[] = [];

  for (const ref of blockedRefs) {
    const state = resolveIssueState(
      ref,
      options.issueStateByNumber,
      options.fetchIssueStateByNumber,
    );
    if ((state ?? '').toUpperCase() === 'OPEN') {
      return {
        orphan: false,
        reason: 'blocked_by_open_reference',
        details: ref,
      };
    }
    if (state === 'UNRESOLVABLE') {
      unresolved.push(ref);
    }
  }

  for (const ref of dependencyRefs) {
    const state = resolveIssueState(
      ref,
      options.issueStateByNumber,
      options.fetchIssueStateByNumber,
    );
    if ((state ?? '').toUpperCase() === 'OPEN') {
      if (isDependencyEpicExempt(ref, options)) {
        continue;
      }
      return {
        orphan: false,
        reason: 'open_dependency_reference',
        details: ref,
      };
    }
    if (state === 'UNRESOLVABLE') {
      unresolved.push(ref);
    }
  }

  if (unresolved.length > 0) {
    return {
      orphan: false,
      reason: 'unresolvable_reference',
      details: [...new Set(unresolved)],
    };
  }

  // Reaching here means blockedRefs/dependencyRefs was non-empty (the
  // earlier both-empty check already returned `orphan`) and every ref
  // resolved to a non-open, non-unresolvable state -- either genuinely
  // closed, or an open parent epic exempted by isDependencyEpicExempt
  // above (the `continue` a few lines up) -- never "no refs at all"
  // again. Named `references_non_blocking` rather than a
  // "blocked"-sounding name (originally `blocked_references_closed`):
  // that name read as the opposite of its actual meaning once an
  // issue also landed in `routed_to_human` for an unrelated reason
  // (#2932, illustrated on #2781). `references_non_blocking` also
  // covers the exempt-open-epic path correctly, unlike an interim
  // `references_resolved` name would have (Copilot/Codex review, PR
  // #2936): an exempt epic reference has not resolved/closed, it is
  // merely non-blocking.
  return {
    orphan: true,
    reason: 'references_non_blocking',
    ...demotionWarning,
  };
}

/**
 * Resolve whether an **open** dependency reference is exempt as a parent
 * epic / aggregate issue (#1536), reusing `isParentEpicIssue` from
 * `discover-readiness-check.mts` rather than re-implementing the exemption.
 * Only ever consulted for `Depends on` / task-list references, never for
 * `Blocked by` references, matching A3's asymmetry. Fails closed (not
 * exempt) when `openIssueDetailsByNumber` is absent or does not carry the
 * referenced issue's details.
 */
function isDependencyEpicExempt(
  ref: number,
  options: ClassifyIssueOptions,
): boolean {
  const detail = options.openIssueDetailsByNumber?.get(ref);
  if (!detail) {
    return false;
  }
  return isParentEpicIssue(
    {
      title: String(detail.title ?? ''),
      labels: new Set(normalizeLabels(detail.labels)),
    },
    normalizeRoadmapLabelName(options.roadmapLabelName),
  );
}

export async function filterOrphanIssues(
  issues: OrphanIssueInput[],
  options: FilterOrphanIssuesOptions = {},
) {
  const issueStateByNumber = new Map(options.issueStateByNumber ?? []);
  const fetchIssueStateByNumber =
    typeof options.fetchIssueStateByNumber === 'function'
      ? options.fetchIssueStateByNumber
      : () => 'UNRESOLVABLE';
  const filtered: Record<OrphanFilteredReason, FilteredIssueEntry[]> = {
    provider_outage_target: [],
    roadmap_marker: [],
    blocked_by_marker: [],
    blocked_label: [],
    authoring_label: [],
    runtime_observation_precondition: [],
    blocked_by_open_reference: [],
    open_dependency_reference: [],
    unresolvable_reference: [],
    triage_verdict_rejected: [],
  };
  const orphans: OrphanCandidate[] = [];
  const unresolvable: {
    issue: number;
    reference: number;
    reason: string;
  }[] = [];
  const warnings: (
    | NonNullable<ReturnType<typeof buildAuthoringLabelWarning>>
    | StructuralEvidenceDemotionWarning
  )[] = [];
  // #2767 (CodeRabbit review, PR #2840): collected here, not pushed
  // immediately -- a candidate can still be excluded from the final
  // `orphans` list below (the triage-verdict-rejected filter, or
  // autopilot's below-floor `routed_to_human` routing), and this warning's
  // own text asserts "it stays listed as an orphan," which would be wrong
  // for an issue that does not survive to the final partition. Emitted
  // only for numbers still present in `ranked` at the end of this
  // function.
  const demotedOrphanNumbers = new Set<number>();
  // Self-batch lookup for the dependency parent-epic exemption (#1536): in
  // the CLI wiring `issues` is always the full open-issue batch
  // (`fetchOpenIssues`), so any `Depends on` / task-list reference that
  // resolves OPEN is guaranteed to already be present here — zero extra
  // GitHub API calls. A reference outside this batch (e.g. a partial list
  // passed directly to `filterOrphanIssues`, such as in a test) fails
  // closed via `isDependencyEpicExempt`'s own absent-entry handling.
  const openIssueDetailsByNumber = new Map(
    issues.map(
      (candidate) =>
        [
          candidate.number,
          { title: candidate.title, labels: candidate.labels },
        ] as const,
    ),
  );
  // #2243 staleness anchor lookup: each candidate's own createdAt, used as
  // the resolveLatestSubstantiveIssueEditAt fallback below.
  const issueCreatedAtByNumber = new Map(
    issues.map((candidate) => [candidate.number, candidate.createdAt] as const),
  );
  // #2767: built once for the whole batch (not per-candidate) -- the
  // static trustedMarkerLogins check is cheap, and isTrustedCollaborator
  // (when supplied) already caches its own live lookups.
  const isTrustedLogin = buildTrustedLoginPredicate(
    options.trustedMarkerLogins ?? [],
    options.isTrustedCollaborator ?? (() => false),
  );

  for (const issue of issues) {
    const classifyOptions: ClassifyIssueOptions = {
      issueStateByNumber,
      fetchIssueStateByNumber,
      markerPrefix: options.markerPrefix,
      authoringLabelName: options.authoringLabelName,
      blockedByHumanLabelName: options.blockedByHumanLabelName,
      needsDecisionLabelName: options.needsDecisionLabelName,
      roadmapLabelName: options.roadmapLabelName,
      providerOutageDeclarationTarget: options.providerOutageDeclarationTarget,
      openIssueDetailsByNumber,
    };
    let result = classifyIssue(issue, classifyOptions);
    // #2767: only a `runtime_observation_precondition` filter can ever be
    // demoted, and computing structural evidence costs a network fetch
    // (editor logins plus a live collaborator-permission check) -- pay it
    // only for a candidate that plain classification already filtered on
    // exactly this reason, and only when the caller actually wired the
    // editor-login fetch (absent means "never demotes", the prior
    // byte-stable behavior).
    if (
      result.reason === 'runtime_observation_precondition' &&
      typeof options.fetchUserContentEditorsByIssueNumber === 'function'
    ) {
      // Codex review, PR #2840 (round 15): check the two local-only
      // signals first -- both read only the already-loaded issue body, no
      // network call -- and skip `fetchUserContentEditorsByIssueNumber` (a
      // paginated GraphQL round trip) plus the live collaborator-
      // permission check entirely when either is already false. Demotion
      // requires all three signals together, so a false
      // verificationCommand/candidateFilesExist makes the live
      // trustedEditor signal moot regardless of what it would resolve to
      // -- the same short-circuit `discover-viability-gate.mts` and
      // `suitability-triage.mts`'s own `computeLiveStructuralEvidence`
      // already apply for this identical reason.
      const body = String(issue.body ?? '');
      const existsAt = options.existsAt ?? existsSync;
      const verificationCommand = hasVerificationCommandSignal(body);
      const candidateFilesExist = candidateFilesExistOnDisk(body, existsAt);
      if (verificationCommand && candidateFilesExist) {
        // CodeRabbit review, PR #2557 (same fail-open contract this file
        // already applies below to its other opportunistic per-candidate
        // fetches): a transient GitHub API failure from either the editor
        // fetch or the live collaborator-permission check must not abort
        // the whole default-on discover pass. Degrade to "no structural
        // evidence available" -- keep the plain `result` computed above
        // unchanged -- rather than crashing or guessing a trust verdict.
        try {
          const authorLogin = (issue.user as { login?: unknown } | null)?.login;
          const structuralEvidence = evaluateStructuralEvidence({
            body,
            author: typeof authorLogin === 'string' ? authorLogin : '',
            editorLogins: options.fetchUserContentEditorsByIssueNumber(
              issue.number,
            ),
            isTrustedLogin,
            existsAt,
          });
          result = classifyIssue(issue, {
            ...classifyOptions,
            structuralEvidence,
          });
        } catch {
          // Keep the original `result` (still filtered under
          // runtime_observation_precondition, the prior byte-stable
          // behavior).
        }
      }
    }

    if (result.reason === 'unresolvable_reference') {
      for (const number of result.details ?? []) {
        unresolvable.push({
          issue: issue.number,
          reference: number,
          reason: 'issue-not-found-or-inaccessible',
        });
      }
    }
    if (result.reason === 'authoring_label') {
      const warning = buildAuthoringLabelWarning({
        issueNumber: issue.number,
        labelName: result.details,
        labelEvents: resolveIssueLabelEvents(
          issue,
          options.fetchLabelEventsByIssueNumber,
        ),
        now: options.now ?? new Date(),
        staleAgeMs: options.authoringStaleAgeMs ?? 4 * 60 * 60 * 1000,
      });
      if (warning) {
        warnings.push(warning);
      }
    }

    if (result.orphan) {
      if (result.warning === 'runtime_observation_precondition_demoted') {
        demotedOrphanNumbers.add(issue.number);
      }
      orphans.push({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        reason: result.reason,
        url: issue.url ?? '',
        autopilotSuitability: parseAutopilotSuitability(
          issue.body,
          typeof options.markerPrefix === 'string'
            ? options.markerPrefix
            : undefined,
        ),
        effort: parseEffort(
          issue.body,
          typeof options.markerPrefix === 'string'
            ? options.markerPrefix
            : undefined,
        ),
        milestone: extractOpenMilestoneTitle(issue.milestone),
      });
      continue;
    }

    const entry: FilteredIssueEntry = {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      reason: result.reason,
      details: result.details ?? null,
      url: issue.url ?? '',
    };
    filtered[result.reason].push(entry);
  }

  // #2243: exclude a candidate whose most recent trusted `A4.5
  // suitability gate rejection` comment carries a still-current
  // `<!-- {prefix}-triage-verdict: <outcome> -->` marker for one of the
  // four non-label outcomes (unclear/duplicate/out-of-scope/invalid).
  // Survivors-only: runs after every free (body/label) filter above has
  // already narrowed the candidate set, so this is at most one
  // comments-plus-timeline fetch pair per surviving candidate, never per
  // scanned issue. Default-on for the live CLI (see
  // `FilterOrphanIssuesOptions.fetchCommentsByIssueNumber`'s doc comment)
  // but a no-op here when either input is absent, keeping this file's
  // existing tests and any other caller byte-stable by default.
  if (
    typeof options.fetchCommentsByIssueNumber === 'function' &&
    Array.isArray(options.trustedMarkerLogins) &&
    options.trustedMarkerLogins.length > 0
  ) {
    const fetchComments = options.fetchCommentsByIssueNumber;
    const fetchTimeline =
      typeof options.fetchTimelineByIssueNumber === 'function'
        ? options.fetchTimelineByIssueNumber
        : () => [];
    const fetchUserContentEdits =
      typeof options.fetchUserContentEditsByIssueNumber === 'function'
        ? options.fetchUserContentEditsByIssueNumber
        : () => [];
    const trustedMarkerLogins = options.trustedMarkerLogins;
    const markerPrefix =
      typeof options.markerPrefix === 'string'
        ? options.markerPrefix
        : undefined;
    const survivors: typeof orphans = [];
    for (const orphan of orphans) {
      // CodeRabbit review, PR #2557: mirror resolveIssueLabelEvents's own
      // fail-open contract for a per-candidate opportunistic fetch -- a
      // transient GitHub API failure here must not abort the whole
      // default-on discover pass; it degrades to "no evidence" (same as an
      // absent marker) and the candidate stays selectable.
      let record: ReturnType<typeof findTrustedSuitabilityRejection> = null;
      try {
        record = findTrustedSuitabilityRejection(
          fetchComments(orphan.number),
          trustedMarkerLogins,
          markerPrefix,
        );
      } catch {
        record = null;
      }
      let editedAt: string | null = null;
      if (record?.markerOutcome) {
        // Both fetches evaluate inside this one try block (#2762): a
        // failure from EITHER the timeline or the userContentEdits read
        // degrades the whole anchor to null ("unknown") rather than
        // computing a partial result from whichever fetch happened to
        // succeed -- a partial result could still collapse to the bare
        // `created_at` anchor this issue fixes.
        try {
          editedAt = resolveLatestSubstantiveIssueEditAt(
            issueCreatedAtByNumber.get(orphan.number),
            fetchTimeline(orphan.number),
            fetchUserContentEdits(orphan.number),
          );
        } catch {
          editedAt = null;
        }
      }
      if (record && isSuitabilityTriageVerdictCurrent(record, editedAt)) {
        filtered.triage_verdict_rejected.push({
          number: orphan.number,
          title: orphan.title,
          state: orphan.state,
          reason: 'triage_verdict_rejected',
          details: record.markerOutcome,
          url: orphan.url,
        });
        continue;
      }
      survivors.push(orphan);
    }
    orphans.length = 0;
    orphans.push(...survivors);
  }

  // Opt-in (#1395): annotate each orphan candidate with active-claim
  // eligibility, mirroring `discover-roadmap-graph`'s own sequential
  // per-leaf loop. Gated on `options.claimState` so the default path makes
  // no extra GitHub API call and the output shape stays byte-stable. Runs
  // before the ranking/routing split below so both the ranked `orphans` and
  // `routed_to_human` partitions carry the annotation (they share the same
  // object references; `rankAndRouteBySuitability` only reorders/filters).
  if (options.claimState) {
    const claimState = options.claimState;
    for (const orphan of orphans) {
      const annotated = await annotateLeafClaimState(orphan.number, claimState);
      orphan.activeClaim = annotated.activeClaim;
      orphan.claimEligible = annotated.claimEligible;
    }
  }

  // Rank the orphan candidate list by authored autopilot-suitability
  // score. Pre-sort by the soft effort tie-breaker (lower effort first,
  // with a missing hint at the neutral middle) and then issue number, so
  // the stable score sort below resolves equal scores by effort and then
  // lowest number (the Step 2 tie-breaks) rather than by API fetch order.
  // Below-floor routing is opt-in (autopilot runs only): in attended
  // discovery the low-score issues stay selectable, just ranked last.
  // Advisory throughout — the A4.5/A5 gates still run on any selected
  // candidate, and unscored issues are never routed out (fail-safe).
  const orphansByEffortThenNumber = [...orphans].sort(
    (left, right) =>
      effortOrdinal(left.effort) - effortOrdinal(right.effort) ||
      left.number - right.number,
  );
  const { ranked, routedToHuman } = rankAndRouteBySuitability(
    orphansByEffortThenNumber,
    {
      floor:
        options.autopilotSuitabilityFloor ??
        DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
      enabled: options.autopilotSuitabilityEnabled !== false,
      routeBelowFloor: options.autopilot === true,
      getScore: (orphan) => orphan.autopilotSuitability,
    },
  );

  // #2767 (CodeRabbit review, PR #2840): emit the demotion warning only
  // for a candidate that actually survives to the final `ranked` orphans
  // list -- the triage-verdict filter above and the routing split just
  // above can both remove a candidate from that final partition, and the
  // warning's own text asserts it stays listed as an orphan.
  if (demotedOrphanNumbers.size > 0) {
    const rankedNumbers = new Set(ranked.map((orphan) => orphan.number));
    for (const issueNumber of demotedOrphanNumbers) {
      if (!rankedNumbers.has(issueNumber)) {
        continue;
      }
      warnings.push({
        issueNumber,
        reason: 'runtime_observation_precondition_demoted',
        message:
          `Warning: Issue #${issueNumber} names a runtime/production-observation ` +
          'precondition, but every structural-evidence signal held, so it stays listed as an orphan.',
      });
    }
  }

  const counts = {
    scanned: issues.length,
    orphans: ranked.length,
    routed_to_human: routedToHuman.length,
    filtered: Object.fromEntries(
      Object.entries(filtered).map(([reason, entries]) => [
        reason,
        entries.length,
      ]),
    ),
    unresolvable: unresolvable.length,
  };

  return {
    orphans: ranked,
    routed_to_human: routedToHuman,
    filtered,
    unresolvable,
    warnings,
    counts,
  };
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  const policy = loadPolicy(args.policy);

  const openIssues = fetchOpenIssues(port);
  const openStateByNumber = new Map(
    openIssues.map(
      (issue) => [issue.number, String(issue.state)] as [number, string],
    ),
  );

  // The claim-state annotation is strictly opt-in: only when
  // --with-claim-state is passed do we build the comment loader (the sole
  // new GitHub API surface) and resolve the trusted-actor / stale-age
  // policy. The default path leaves `claimState` undefined, so no extra
  // fetch is made and the output is byte-stable (mirrors
  // discover-roadmap-graph's own CLI wiring).
  const claimState = args.withClaimState
    ? buildClaimStateResolution(
        port,
        {
          claimTiming: policy.claimTiming,
          trustedMarkerActors: policy.trustedMarkerActors,
        },
        args.currentClaimId,
      )
    : undefined;

  // #2243: always resolved (unlike claimState above) -- the triage-verdict
  // exclusion is default-on, not an opt-in flag. An empty resolution (no
  // flag/env/config trusted actors configured) makes the check a no-op via
  // filterOrphanIssues's own trustedMarkerLogins-empty guard, matching
  // every other trusted-marker consumer's fail-safe default.
  const { actors: trustedMarkerLogins } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config: { trustedMarkerActors: policy.trustedMarkerActors },
  });
  // #2767: shared across every isTrustedCollaborator call below, so a
  // repeated editor login across candidates costs one live lookup.
  const collaboratorPermissionCache: CollaboratorPermissionCache = new Map();

  const result = await filterOrphanIssues(openIssues, {
    issueStateByNumber: openStateByNumber,
    fetchIssueStateByNumber: (issueNumber) =>
      fetchIssueState(port, issueNumber),
    fetchLabelEventsByIssueNumber: (issueNumber) =>
      fetchIssueLabelEvents(port, issueNumber),
    fetchCommentsByIssueNumber: (issueNumber) =>
      fetchIssueCommentsForTriageVerdict(port, issueNumber),
    fetchTimelineByIssueNumber: (issueNumber) =>
      port.getWorkItemTimeline(issueNumber),
    fetchUserContentEditsByIssueNumber: (issueNumber) =>
      port.getWorkItemUserContentEditTimestamps(issueNumber),
    // #2767: only ever called for a candidate plain classification already
    // filtered as runtime_observation_precondition -- see
    // filterOrphanIssues's own lazy-retry comment.
    fetchUserContentEditorsByIssueNumber: (issueNumber) =>
      port
        .getWorkItemUserContentEdits(issueNumber)
        .map((edit) => edit.editorLogin),
    isTrustedCollaborator: (login) => {
      const { permission } = collaboratorPermission(
        owner,
        repo,
        login,
        collaboratorPermissionCache,
      );
      return permission === 'admin' || permission === 'write';
    },
    trustedMarkerLogins,
    markerPrefix: policy.markerPrefix,
    authoringLabelName: policy.authoringLabelName,
    authoringStaleAgeMs: policy.authoringStaleAgeMs,
    blockedByHumanLabelName: policy.blockedByHumanLabelName,
    needsDecisionLabelName: policy.needsDecisionLabelName,
    roadmapLabelName: policy.roadmapLabelName,
    providerOutageDeclarationTarget: policy.providerOutageDeclarationTarget,
    autopilotSuitabilityFloor: policy.autopilotSuitabilityFloor,
    autopilotSuitabilityEnabled: policy.autopilotSuitabilityEnabled,
    autopilot: args.autopilot,
    now: args.now || new Date(),
    claimState,
  });

  const output = {
    repository: { owner, repo },
    diagnostics: {
      pr: args.pr,
    },
    policy: {
      source: policy.source,
      orphanFirstPolicy: policy.orphanFirstPolicy,
      markerPrefix: policy.markerPrefix,
      authoringLabelName: policy.authoringLabelName,
      authoringStaleAge: policy.authoringStaleAge,
      autopilotSuitabilityFloor: policy.autopilotSuitabilityFloor,
      autopilotSuitabilityEnabled: policy.autopilotSuitabilityEnabled,
    },
    ...result,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

// Excluded from the #1446 cli-args.mts wrapper: --current-claim-id below
// is an optional-value flag -- it may appear bare or take a following
// value, and only consumes the next token when one is present and does
// not itself look like another flag. `util.parseArgs` cannot express this:
// a `string`-type option always requires exactly one value and a
// `boolean`-type option never takes one; there is no in-between mode.
function parseArgs(rawArgv: string[]): ParsedArgs {
  // #1921/#2465: strip a pnpm-forwarded leading `--` the same way the
  // shared cli-args.mts wrapper does -- this parser is excluded from that
  // wrapper (see the comment above) so it must call the strip directly.
  const argv = stripLeadingArgumentSeparator(rawArgv);
  const parsed: ParsedArgs = {
    owner: '',
    repo: '',
    policy: '',
    pr: null,
    help: false,
    now: '',
    autopilot: false,
    withClaimState: false,
    currentClaimId: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--owner') {
      parsed.owner = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--repo') {
      parsed.repo = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--policy') {
      parsed.policy = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--pr') {
      const parsedNumber = Number.parseInt(String(value ?? ''), 10);
      if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
        throw new Error(`invalid --pr value: ${value ?? ''}`);
      }
      parsed.pr = parsedNumber;
      index += 1;
      continue;
    }
    if (token === '--now') {
      parsed.now = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--autopilot') {
      parsed.autopilot = true;
      continue;
    }
    if (token === '--with-claim-state') {
      parsed.withClaimState = true;
      continue;
    }
    if (token === '--current-claim-id') {
      // Only consume the next token as the id when it exists and is not
      // itself a flag, mirroring discover-roadmap-graph's own parsing, so
      // `--current-claim-id --with-claim-state` does not swallow the
      // following flag as the id. A missing/flag value leaves
      // currentClaimId empty and the next flag is left for its own
      // iteration.
      if (value !== undefined && !value.startsWith('--')) {
        parsed.currentClaimId = value;
        index += 1;
      }
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-orphan-filter.mjs [--owner <owner>] [--repo <repo>] [--policy <path>] [--pr <number>] [--now <ISO8601>] [--autopilot] [--with-claim-state] [--current-claim-id <id>]

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "diagnostics": {"pr": 404},
  "policy": {"source": "...", "orphanFirstPolicy": "none|maintainer-approved|public-disabled", "markerPrefix": "...", "authoringLabelName": "...", "authoringStaleAge": "...", "autopilotSuitabilityFloor": 3, "autopilotSuitabilityEnabled": true},
  "orphans": [{"number": 1, "title": "...", "state": "OPEN", "reason": "orphan|references_non_blocking", "url": "...", "autopilotSuitability": 4, "effort": "S|M|L|null", "milestone": "v0.8.0|null"}],
  "routed_to_human": [{"number": 2, "title": "...", "state": "OPEN", "reason": "orphan", "url": "...", "autopilotSuitability": 1, "effort": "S|M|L|null", "milestone": "v0.8.0|null"}],
  "filtered": {
    "provider_outage_target": [...],
    "roadmap_marker": [...],
    "blocked_by_marker": [...],
    "blocked_label": [...],
    "authoring_label": [...],
    "runtime_observation_precondition": [...],
    "blocked_by_open_reference": [...],
    "open_dependency_reference": [...],
    "unresolvable_reference": [...],
    "triage_verdict_rejected": [...]
  },
  "unresolvable": [{"issue": 1, "reference": 2, "reason": "issue-not-found-or-inaccessible"}],
  "warnings": [{"issueNumber": 1, "message": "Warning: ..."}],
  "counts": {"scanned": 0, "orphans": 0, "routed_to_human": 0, "filtered": {...}, "unresolvable": 0}
}

"filtered.provider_outage_target" (#2800) excludes the exact issue named by
the configured "providerOutage.declarationTarget" -- a permanent,
adopter-authored coordination issue documented to stay open indefinitely,
never claimed, never closed, and carrying no roadmap/blocked marker or
blocking label of its own. Checked by issue number alone, ahead of every
marker/label check above, since none of them would otherwise catch it.
Absent config leaves this filter a no-op.

"filtered.runtime_observation_precondition" (#2467) excludes an issue whose
body names a runtime/production-observation precondition in prose --
"confirmed in production", "observed live", "runtime-observation" -- with no
issue-number reference to resolve, so it stays excluded even once every
numbered "Blocked by"/"Depends on" reference is closed.

A "runtime_observation_precondition" hit demotes to a warned orphan
(#2767) instead -- kept in "orphans" with "reason": "orphan" and a
"warnings[]" entry carrying "reason":
"runtime_observation_precondition_demoted" -- only when every
structural-evidence signal (triage-structural-evidence.mts: a runnable
verification command, an existing candidate file, a fully trusted
author+editor set) holds for that issue. Requires
"fetchUserContentEditorsByIssueNumber" to be wired (the live CLI always
wires it); absent, this never demotes, matching the pre-#2767 behavior
exactly.

"filtered.open_dependency_reference" (#1536) mirrors A3's own dependency
check in discover-readiness-check.mjs: a candidate whose body contains an
open "Depends on #NNN" line or an open task-list "- [ ] #NNN" reference is
excluded, UNLESS that referenced issue is itself a parent epic / aggregate
issue (title starting with "roadmap", or carrying the configured roadmap
label) -- matching A3's exemption exactly. This exemption never applies to
"Blocked by #NNN" references (filtered.blocked_by_open_reference), which
stay a hard sequential dependency with no exemption. An unresolvable
dependency reference (issue not found or inaccessible) is treated as
blocking, the same fail-safe "unresolvable_reference" applies to an
unresolvable "Blocked by" reference.

orphans are always ranked by authored autopilot-suitability score (high
first; equal scores tie-break by lowest issue number). With --autopilot
(autopilot runs), orphans whose score is below autopilotSuitabilityFloor
(default 3) are moved to routed_to_human; without it (attended runs) they
stay in orphans, ranked last. A missing or out-of-range score is treated
as no score: the issue stays in orphans and is never routed out.

"filtered.triage_verdict_rejected" (#2243, default-on, not opt-in) excludes
a candidate whose most recent trusted "A4.5 suitability gate rejection"
comment carries a still-current
"<!-- {markerPrefix}-triage-verdict: <outcome> -->" marker for one of the
four non-label outcomes (unclear/duplicate/out-of-scope/invalid); each
filtered entry's "details" field is that outcome string.
"needs-decision"/"blocked-by-human" never emit this marker -- those already
carry a stable label. Only runs for a candidate every cheaper (label/body)
filter above has already let through (one comments-plus-timeline fetch pair
per surviving candidate, never per scanned issue), and requires trusted
marker actors to be configured (env/flag/repo config); with none
configured, this check is a no-op and makes no extra GitHub API call.
Staleness-checked (fail-closed toward NOT excluding): the marker only
excludes when the rejection comment is at or after the issue's latest
substantive (title/body) edit, so an issue legitimately improved after
being rejected stays selectable -- a title edit is a timeline "renamed"
event, and a body edit is a GraphQL "userContentEdits.editedAt" value
(#2762); a failed GraphQL read degrades the anchor to unknown rather than
falling back to created_at.

--with-claim-state (opt-in) annotates each candidate in "orphans" and
"routed_to_human" with active-claim eligibility, exactly mirroring
discover-roadmap-graph's flag of the same name: it fetches that issue's
comments and resolves the active claim using the configured
trustedMarkerActors, claimTiming.staleAge (default PT24H), and
claimTiming.heartbeatInterval (default PT12H). Each annotated candidate
gains (activeClaim is always an object):
  "activeClaim": { "present": bool, "stale": bool, "claimId": str|null, "agentId": str|null, "heartbeatOverdue": bool }
                 (present:false with claimId/agentId null = no trusted claim)
  "claimEligible": bool   (eligible = no present, non-stale, trusted claim)
Absent the flag, NO comment API calls are made and no claim fields are
emitted (the output shape is byte-stable).
heartbeatOverdue is true when the latest valid claimed-by/heartbeat
created_at is at or past claimTiming.heartbeatInterval with no later trusted
heartbeat; false otherwise, including whenever present is false. It is
PURELY DIAGNOSTIC: it never feeds claimEligible or any other gate.
--current-claim-id <id> additionally sets "ownedByCurrentSession": bool on
each activeClaim (true when the active claim's claimId equals <id>).
NOTE: claimEligible is a best-effort SOFT discovery hint (same limitation
as discover-roadmap-graph's annotation): it resolves only new-format
claimed-by markers and intentionally does NOT account for legacy
claim-id-less markers or forced-handoff transfers; the authoritative A5
claim gate (idd-claim.instructions.md) remains the real protection.
`);
}

function loadPolicy(policyPath: string) {
  // Read-and-parse failure semantics (explicit path throws; default path
  // silently falls back only on ENOENT) are converged in idd-config.mts's
  // loadPolicyConfig (#1721) — this function keeps only its own shape
  // normalization on top of that raw config.
  const { path: source, config: rawConfig } = loadPolicyConfig(policyPath);
  const config = (rawConfig ?? {}) as {
    markerPrefix?: unknown;
    claimTiming?: { staleAge?: unknown; heartbeatInterval?: unknown };
    trustedMarkerActors?: unknown;
  };
  const authoringPolicy = resolveAuthoringGuardPolicy(config);
  const normalizedPolicy = normalizePolicyConfig(config);
  const labelsPolicy = normalizedPolicy.labels;
  return {
    source,
    orphanFirstPolicy: getOrphanFirstPolicy(config),
    markerPrefix: normalizeMarkerPrefix(config.markerPrefix),
    authoringLabelName: authoringPolicy.labelName,
    authoringStaleAge: authoringPolicy.staleAge,
    authoringStaleAgeMs: authoringPolicy.staleAgeMs,
    blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
    needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
    roadmapLabelName: labelsPolicy.roadmapLabelName,
    // #2800: own-property-omitted when unconfigured or invalid, matching
    // normalizePolicyConfig's own absence semantics -- resolved to
    // `null` below so downstream callers get a stable, always-present
    // field instead of testing for key presence.
    providerOutageDeclarationTarget:
      normalizedPolicy.providerOutage.declarationTarget ?? null,
    autopilotSuitabilityFloor: resolveAutopilotSuitabilityFloor(config),
    autopilotSuitabilityEnabled: resolveAutopilotSuitabilityEnabled(config),
    // Passed through verbatim (raw, un-normalized) for
    // buildClaimStateResolution (#1395), which expects this same shape —
    // it is only consumed when --with-claim-state is passed. Undefined
    // when no config was found (default path, ENOENT), matching
    // buildClaimStateResolution's own defaults (24h stale age, env-only
    // trusted actors) — the same soft-default philosophy the graph helper
    // already relies on.
    claimTiming: config.claimTiming,
    trustedMarkerActors: config.trustedMarkerActors,
  };
}

function resolveAutopilotSuitabilityFloor(config: unknown): number {
  // Delegate range/default validation to the shared normalizer so the
  // 1-5 rule and the default cannot drift between modules.
  return normalizeAutopilotSuitabilityFloor(
    (config as { autopilotSuitability?: { floor?: unknown } } | null)
      ?.autopilotSuitability?.floor,
  );
}

function resolveAutopilotSuitabilityEnabled(config: unknown): boolean {
  return (
    (config as { autopilotSuitability?: { enabled?: unknown } } | null)
      ?.autopilotSuitability?.enabled !== false
  );
}

function normalizeIssue(issue: {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  labels?: unknown;
  labelEvents?: unknown;
  body?: unknown;
  url?: unknown;
  html_url?: unknown;
  milestone?: unknown;
  createdAt?: unknown;
  user?: unknown;
}) {
  return {
    number: Number.parseInt(String(issue.number), 10),
    title: issue.title ?? '',
    state: issue.state ?? '',
    labels: normalizeLabels(issue.labels),
    labelEvents: Array.isArray(issue.labelEvents) ? issue.labelEvents : [],
    body: issue.body ?? '',
    url: issue.url ?? issue.html_url ?? '',
    milestone: issue.milestone,
    createdAt: issue.createdAt,
    // #2767 (CodeRabbit review, PR #2840): carried through so the live CLI
    // wiring below can read the author login for the `trustedEditor`
    // structural-evidence signal -- omitting it here silently made that
    // signal fail closed for every live orphan candidate.
    user: issue.user,
  };
}

/**
 * Read the OPEN milestone's title from a REST `milestone` object. Returns
 * null for a missing/non-object field, a closed milestone, or a
 * non-string/empty title -- every one of these is the same "no scope
 * input" neutral case for the surfaced `milestone` output field (#2340).
 * Duplicated from `discover-roadmap-graph.mts`'s identical helper rather
 * than shared, matching this file's own already-duplicated
 * `normalizeIssue` pattern.
 */
function extractOpenMilestoneTitle(milestone: unknown): string | null {
  if (typeof milestone !== 'object' || milestone === null) {
    return null;
  }
  const record = milestone as { state?: unknown; title?: unknown };
  if (String(record.state ?? '').toLowerCase() !== 'open') {
    return null;
  }
  return typeof record.title === 'string' && record.title.length > 0
    ? record.title
    : null;
}

function resolveIssueLabelEvents(
  issue: OrphanIssueInput,
  fetchLabelEventsByIssueNumber?: (issueNumber: number) => unknown[],
) {
  if (Array.isArray(issue.labelEvents) && issue.labelEvents.length > 0) {
    return issue.labelEvents;
  }
  if (typeof fetchLabelEventsByIssueNumber !== 'function') {
    return [];
  }
  try {
    return fetchLabelEventsByIssueNumber(issue.number);
  } catch {
    return [];
  }
}

function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => {
      if (typeof label === 'string') {
        return label;
      }
      return String((label as { name?: unknown } | null)?.name ?? '');
    })
    .filter(Boolean);
}

function resolveIssueState(
  number: number,
  issueStateByNumber: Map<number, string>,
  fetchIssueStateByNumber: (issueNumber: number) => string,
): string | undefined {
  if (issueStateByNumber.has(number)) {
    return issueStateByNumber.get(number);
  }
  const state = fetchIssueStateByNumber(number);
  issueStateByNumber.set(number, state);
  return state;
}

function fetchIssueState(port: ProviderPort, issueNumber: number): string {
  return port.getWorkItemState(issueNumber) || 'UNRESOLVABLE';
}

function fetchIssueLabelEvents(port: ProviderPort, issueNumber: number) {
  return port
    .getWorkItemTimeline(issueNumber)
    .filter((event) => (event as { event?: unknown }).event === 'labeled');
}

/**
 * #2243: adapts {@link ProviderPort.listWorkItemComments}'s camelCase
 * `ProviderComment` shape to the raw-REST-shaped
 * `SuitabilityRejectionComment` `findTrustedSuitabilityRejection` expects
 * (mirroring `suitability-triage.mts`'s own direct `gh api` comment fetch).
 * `html_url` is intentionally omitted -- this file never reads the
 * resulting record's `url` field, only `markerOutcome`/`createdAt`.
 */
function fetchIssueCommentsForTriageVerdict(
  port: ProviderPort,
  issueNumber: number,
): SuitabilityRejectionComment[] {
  return port.listWorkItemComments(issueNumber).map((comment) => ({
    body: comment.body,
    created_at: comment.createdAt,
    user: { login: comment.authorLogin },
  }));
}

function normalizeMarkerPrefix(prefix: unknown): string {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    return DEFAULT_MARKER_PREFIX;
  }
  return prefix;
}

function normalizeAuthoringLabelName(labelName: unknown): string {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : 'status:authoring';
}

/** Resolve the configured `labels.blockedByHumanLabelName` (#1273). */
function normalizeBlockedByHumanLabelName(labelName: unknown): string {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.blockedByHumanLabelName;
}

/** Resolve the configured `labels.needsDecisionLabelName` (#1273). */
function normalizeNeedsDecisionLabelName(labelName: unknown): string {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.needsDecisionLabelName;
}

/**
 * Resolve the configured `labels.roadmapLabelName` for the dependency
 * parent-epic exemption (#1536), following this file's established
 * defensive-default pattern for the other configurable label names.
 */
function normalizeRoadmapLabelName(labelName: unknown): string {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.roadmapLabelName;
}

/** Exported for `tests/discover-orphan-filter.test.mts`'s #2767 regression
 * (CodeRabbit review, PR #2840): a direct `OrphanIssueInput` fixture in a
 * test bypasses this function and `normalizeIssue` entirely, which is
 * exactly how the live CLI's `user`-propagation gap went uncaught -- a
 * test must go through this function to actually exercise it. */
export function fetchOpenIssues(
  port: ProviderPort,
): ReturnType<typeof normalizeIssue>[] {
  // listOpenWorkItems() already excludes pull requests -- no re-filtering
  // needed here.
  return port.listOpenWorkItems().map((item) =>
    normalizeIssue({
      number: item.number,
      title: item.title,
      state: item.state,
      labels: item.labels,
      body: item.body,
      url: item.url,
      html_url: item.htmlUrl,
      milestone: item.milestone,
      createdAt: item.createdAt,
      user: item.user,
    }),
  );
}
