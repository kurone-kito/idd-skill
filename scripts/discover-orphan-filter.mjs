#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-orphan-filter.mts
//
// The scripts/discover-orphan-filter.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { existsSync } from 'node:fs';
import {
  buildAuthoringLabelWarning,
  findLatestLabeledAt,
  resolveAuthoringGuardPolicy,
} from './authoring-label-guard.mjs';
import {
  DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
  rankAndRouteBySuitability,
  resolveEffortLPolicy,
} from './autopilot-suitability.mjs';
import { stripLeadingArgumentSeparator } from './cli-args.mjs';
import { collaboratorPermission } from './collaborator-permission.mjs';
import { extractDependencyReferences } from './dependency-grammar.mjs';
import {
  purgeDiscoverHints,
  readDiscoverHint,
} from './discover-hint-cache.mjs';
import {
  extractBlockedByIssueNumbers,
  extractDeferSourceRefsIssueNumbers,
  extractDependencyIssueNumbers,
  hasDeferSourceMarker,
  isParentEpicIssue,
} from './discover-readiness-check.mjs';
import {
  annotateLeafClaimState,
  buildClaimStateResolution,
} from './discover-roadmap-graph.mjs';
import { effortOrdinal, parseEffort } from './effort.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadPolicyConfig } from './idd-config.mjs';
import { maskMarkdownForScan } from './markdown-code.mjs';
import { NOW_FLAG_USAGE_MESSAGE, normalizeNowFlag } from './marker-helpers.mjs';
import { createMarkerRegex } from './marker-regex.mjs';
import {
  normalizePolicyConfig,
  POLICY_DEFAULTS,
  resolveDurableRecordTargets,
} from './policy-helpers.mjs';
import { resolveTrustedMarkerActors } from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  GH_SEARCH_RESULT_CAP,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';
import {
  findTrustedSuitabilityRejection,
  isSuitabilityTriageVerdictCurrent,
  resolveLatestSubstantiveIssueEditAt,
} from './supersession-detection.mjs';
import {
  buildTrustedLoginPredicate,
  candidateFilesExistOnDisk,
  evaluateStructuralEvidence,
  hasAllStructuralSignals,
  hasVerificationCommandSignal,
} from './triage-structural-evidence.mjs';

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
const QUOTE_CHAR_PAIRS = {
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
if (import.meta.main) {
  // #3343: call runCli() directly when the envelope is disabled -- see
  // applyHelperCliOutcomeWhenDisabled's own doc comment for why, including
  // the async-specific .then() note.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('discover-orphan-filter', runCli);
  } else {
    runCli().then(applyHelperCliOutcomeWhenDisabled, (error) => {
      throw error;
    });
  }
}
/**
 * Collect the visible `Blocked by #N` references in `body`. Delegates to the
 * readiness composer's `extractBlockedByIssueNumbers` (#1311) instead of a
 * second inline "Blocked by" regex, so this filter and the readiness gate
 * share one dependency-line primitive — including its colon tolerance
 * (`Blocked by: #123`), blockquote/list-bullet/ordered-list prefix
 * tolerance, and code-region stripping (`dependency-grammar.mts`, #3284).
 * `currentRepo` (`"owner/repo"`) resolves a qualified `owner/repo#N`/URL
 * token naming this repository to a local number; a token naming another
 * repository (or a qualified token when `currentRepo` is unset) is
 * excluded from this function's own return value the same fail-safe way
 * an unrecognized token always has been. `classifyIssue` (below) does not
 * rely on this function alone for that case: it separately collects the
 * shared grammar's own `unresolvable`/`cross_repository_reference` detail
 * and routes it through the `unresolvable_reference` outcome, so a
 * cross-repository-only reference still keeps the issue non-selectable.
 */
export function extractBlockedByReferences(body, currentRepo) {
  return extractBlockedByIssueNumbers(String(body ?? ''), currentRepo);
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
function hasNegationCueBefore(text, matchIndex) {
  const windowStart = Math.max(0, matchIndex - NEGATION_CUE_WINDOW);
  const window = text.slice(windowStart, matchIndex);
  const breaks = [...window.matchAll(NEGATION_HARD_BREAK_PATTERN)];
  const lastBreak = breaks.at(-1);
  const scoped = lastBreak
    ? window.slice(lastBreak.index + lastBreak[0].length)
    : window;
  return NEGATION_CUE_PATTERN.test(scoped);
}
function hasNegationCueAfter(text, matchEnd) {
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
function isQuotedMatch(text, start, end) {
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
function isFollowedByRequirementAssertion(text, quotedContentStart, opener) {
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
function isPrecededByRequirementAssertion(text, referenceStart) {
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
function isAttributedLongQuote(text, start, selfIssueNumber) {
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
export function detectRuntimeObservationPrecondition(body, selfIssueNumber) {
  const stripped = maskMarkdownForScan(String(body ?? ''));
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
export function getOrphanFirstPolicy(config) {
  if (!config || typeof config !== 'object') {
    return 'none';
  }
  const commands = config.commands;
  if (
    commands &&
    typeof commands === 'object' &&
    typeof commands['orphan-first-policy'] === 'string'
  ) {
    return commands['orphan-first-policy'];
  }
  const orphanFirstPolicy = config.orphanFirstPolicy;
  if (typeof orphanFirstPolicy === 'string') {
    return orphanFirstPolicy;
  }
  return 'none';
}
export function classifyIssue(issue, options) {
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
  const authoringOnlyLabelName = normalizeAuthoringOnlyLabelName(
    options.authoringOnlyLabelName,
  );
  // #3281: the marker tests below run against a masked body, not the raw one:
  // an issue that only *quotes* a `roadmap-id`/`blocked-by` marker as an
  // example (inside a code span, fence, or indented code block) is not a real
  // roadmap node or blocked leaf. Mask first, HTML comments kept (the default):
  // the markers themselves are HTML comments.
  const bodyForMarkerTests = maskMarkdownForScan(body);
  const blockedLabels = new Set([
    blockedByHumanLabelName,
    needsDecisionLabelName,
    authoringOnlyLabelName,
  ]);
  const blockedLabel = [...labels].find((label) => blockedLabels.has(label));
  // #4257: a draft carrier is filed as blocked_label before the number-based
  // targets below, so every carrier lands there, as the listing's acceptance
  // criteria require, even when it is also a configured outage or journal
  // target. The audit does not reject a carrier that is only such a target, so
  // this changes where such an issue is filed.
  if (
    labels.has(authoringOnlyLabelName) &&
    createMarkerRegex(markerPrefix, 'draft-carrier').test(bodyForMarkerTests)
  ) {
    return {
      orphan: false,
      reason: 'blocked_label',
      details: blockedLabel ?? authoringOnlyLabelName,
    };
  }
  // #2800: checked ahead of every marker/label check below — the declaration
  // target is deliberately marker-less and label-less, so none of those checks
  // would ever catch it on their own.
  if (
    options.providerOutageDeclarationTarget != null &&
    Number(issue.number) === options.providerOutageDeclarationTarget
  ) {
    return { orphan: false, reason: 'provider_outage_target' };
  }
  // #4115: the configured authoring journal is checked in the same
  // number-first position, after the draft-carrier check, for the same reason:
  // it carries no markers or blocking labels of its own.
  if (
    options.authoringJournalTarget != null &&
    Number(issue.number) === options.authoringJournalTarget
  ) {
    return { orphan: false, reason: 'authoring_journal_target' };
  }
  // #4065 review fix (Codex P2): the same comparison the readiness check uses
  // for needs_decision_label_conflicts_with_authoring_label.
  const labelsCollide =
    authoringLabelName.trim().toLowerCase() ===
    needsDecisionLabelName.trim().toLowerCase();
  const roadmapMarkerRegex = createMarkerRegex(markerPrefix, 'roadmap-id');
  const blockedMarkerRegex = createMarkerRegex(markerPrefix, 'blocked-by');
  if (roadmapMarkerRegex.test(bodyForMarkerTests)) {
    return { orphan: false, reason: 'roadmap_marker' };
  }
  if (blockedMarkerRegex.test(bodyForMarkerTests)) {
    return { orphan: false, reason: 'blocked_by_marker' };
  }
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
    ? { warning: 'runtime_observation_precondition_demoted' }
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
  const blockedRefs = extractBlockedByReferences(body, options.currentRepo);
  const dependencyRefs = extractDependencyIssueNumbers(
    body,
    options.currentRepo,
  );
  // #3284 (Copilot review, PR #3415): `blockedRefs`/`dependencyRefs` above
  // only ever carry resolved *local* numbers -- a `Blocked by`/`Depends
  // on` line naming another repository (or a qualified token when
  // `options.currentRepo` is unset) resolves to nothing there, so without
  // this the issue's own dependency-grammar fail-safe contract (a
  // cross-repository blocker keeps the issue non-selectable) was silently
  // lost here: an issue whose only declared dependency was cross-repo
  // read as having no dependencies at all.
  const crossRepoUnresolvable = [
    ...extractDependencyReferences(body, 'Blocked by', {
      currentRepo: options.currentRepo,
    }).unresolvable,
    ...extractDependencyReferences(body, 'Depends on', {
      currentRepo: options.currentRepo,
    }).unresolvable,
  ];
  if (
    blockedRefs.length === 0 &&
    dependencyRefs.length === 0 &&
    crossRepoUnresolvable.length === 0
  ) {
    return (
      classifyDeferSourceOrigin(body, markerPrefix, options, labelsCollide) ?? {
        orphan: true,
        reason: 'orphan',
        ...demotionWarning,
      }
    );
  }
  const unresolved = crossRepoUnresolvable.map((token) => ({
    reference: token.token,
    reason: 'cross_repository_reference',
  }));
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
      unresolved.push({
        reference: ref,
        reason: 'issue-not-found-or-inaccessible',
      });
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
      unresolved.push({
        reference: ref,
        reason: 'issue-not-found-or-inaccessible',
      });
    }
  }
  if (unresolved.length > 0) {
    const dedupeKeys = new Set();
    const details = unresolved.filter((entry) => {
      const key = `${entry.reason}:${entry.reference}`;
      if (dedupeKeys.has(key)) {
        return false;
      }
      dedupeKeys.add(key);
      return true;
    });
    return {
      orphan: false,
      reason: 'unresolvable_reference',
      details,
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
  return (
    classifyDeferSourceOrigin(body, markerPrefix, options, labelsCollide) ?? {
      orphan: true,
      reason: 'references_non_blocking',
      ...demotionWarning,
    }
  );
}
/**
 * #4065: a defer-source follow-up (`review-fix-loop-cutoff` or
 * `review-needs-decision`) stays out of the orphan list while its single
 * `Refs` origin issue is open, the same origin rule the A3 readiness check
 * applies through `discover-readiness-check.mts`. Returns `null` when the
 * body has no defer-source marker or the origin is closed, so the caller
 * keeps its own verdict. Called only where no earlier reference check
 * blocked the issue, so `blocked_by_open_reference`,
 * `open_dependency_reference`, and `unresolvable_reference` keep precedence.
 *
 * A `review-needs-decision` follow-up also stays blocked when the configured
 * authoring and needs-decision labels collide, whatever its origin state,
 * matching the readiness check's `needs_decision_label_conflicts_with_authoring_label`.
 */
function classifyDeferSourceOrigin(body, markerPrefix, options, labelsCollide) {
  if (!hasDeferSourceMarker(body, markerPrefix)) {
    return null;
  }
  if (
    labelsCollide &&
    hasDeferSourceMarker(body, markerPrefix, 'review-needs-decision')
  ) {
    return {
      orphan: false,
      reason: 'blocked_by_defer_source_origin',
      details: 'needs_decision_label_conflicts_with_authoring_label',
    };
  }
  const { numbers, ambiguous } = extractDeferSourceRefsIssueNumbers(body);
  if (ambiguous) {
    return {
      orphan: false,
      reason: 'blocked_by_defer_source_origin',
      details: 'ambiguous_refs_line',
    };
  }
  if (numbers.length === 0) {
    return {
      orphan: false,
      reason: 'blocked_by_defer_source_origin',
      details: 'missing_refs_line',
    };
  }
  const [originNumber] = numbers;
  const state = (
    resolveIssueState(
      originNumber,
      options.issueStateByNumber,
      options.fetchIssueStateByNumber,
    ) ?? ''
  ).toUpperCase();
  if (state === '' || state === 'UNRESOLVABLE') {
    return {
      orphan: false,
      reason: 'blocked_by_defer_source_origin',
      details: `unresolvable:#${originNumber}`,
      originNumber,
    };
  }
  if (state === 'OPEN') {
    return {
      orphan: false,
      reason: 'blocked_by_defer_source_origin',
      details: `open:#${originNumber}`,
    };
  }
  return null;
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
function isDependencyEpicExempt(ref, options) {
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
/**
 * Classify one issue as a draft carrier, or return `null` (#4257). A carrier
 * carries the authoring-only label and the carrier marker outside code. The
 * label is checked first, so only labelled issues pay for the masked body
 * scan. The verdict does not depend on what `classifyIssue` reaches, and
 * `classifyIssue` files every carrier under `filtered.blocked_label`.
 */
function classifyDraftCarrier(issue, options) {
  const labels = new Set(normalizeLabels(issue.labels));
  const authoringOnlyLabelName = normalizeAuthoringOnlyLabelName(
    options.authoringOnlyLabelName,
  );
  if (!labels.has(authoringOnlyLabelName)) {
    return null;
  }
  const body = String(issue.body ?? '');
  const markerPrefix = normalizeMarkerPrefix(options.markerPrefix);
  // The marker value is not checked here; `audit-authored-issue --shape
  // carrier` owns that. Any carrier-marked issue is listed, so a malformed one
  // still reaches a human.
  if (
    !createMarkerRegex(markerPrefix, 'draft-carrier').test(
      maskMarkdownForScan(body),
    )
  ) {
    return null;
  }
  const number = Number(issue.number);
  const entry = {
    number,
    title: typeof issue.title === 'string' ? issue.title : '',
    url: typeof issue.url === 'string' ? issue.url : '',
  };
  const authoringLabelName = normalizeAuthoringLabelName(
    options.authoringLabelName,
  );
  if (labels.has(authoringLabelName)) {
    const labelEvents = resolveIssueLabelEvents(
      issue,
      options.fetchLabelEventsByIssueNumber,
      options.strictLabelEvents === true,
    );
    const warning = buildAuthoringLabelWarning({
      issueNumber: number,
      labelName: authoringLabelName,
      labelEvents,
      now: options.now ?? new Date(),
      staleAgeMs: options.authoringStaleAgeMs ?? 4 * 60 * 60 * 1000,
    });
    return {
      bucket: 'held',
      entry: {
        ...entry,
        heldSince: findLatestLabeledAt(labelEvents, authoringLabelName) || null,
        stale: warning?.status === 'stale',
      },
    };
  }
  const blockers = draftCarrierBlockers(body, options);
  return blockers.length === 0
    ? { bucket: 'ready', entry }
    : { bucket: 'waiting', entry: { ...entry, blockers } };
}
/**
 * The `Blocked by` references that keep a draft carrier waiting (#4257): an
 * open issue, an unresolvable local number, or a cross-repository token.
 * Closed blockers are dropped. The grammar and lookups are the ones
 * `classifyIssue` uses, so a carrier and an orphan read the same line alike.
 */
function draftCarrierBlockers(body, options) {
  const blockers = [];
  const seen = new Set();
  const add = (blocker) => {
    const key = `${blocker.reason}:${blocker.reference}`;
    if (!seen.has(key)) {
      seen.add(key);
      blockers.push(blocker);
    }
  };
  for (const ref of extractBlockedByReferences(body, options.currentRepo)) {
    const state = resolveIssueState(
      ref,
      options.issueStateByNumber,
      options.fetchIssueStateByNumber,
    );
    if ((state ?? '').toUpperCase() === 'OPEN') {
      add({ reference: ref, reason: 'open' });
    } else if (state === 'UNRESOLVABLE') {
      add({ reference: ref, reason: 'issue-not-found-or-inaccessible' });
    }
  }
  for (const token of extractDependencyReferences(body, 'Blocked by', {
    currentRepo: options.currentRepo,
  }).unresolvable) {
    add({ reference: token.token, reason: 'cross_repository_reference' });
  }
  return blockers;
}
/**
 * Group every draft carrier among `issues` by release state (#4257), in issue
 * number order. The input array is not reordered.
 */
function classifyDraftCarriers(issues, options) {
  const carriers = { held: [], ready: [], waiting: [] };
  const byNumber = [...issues].sort(
    (left, right) => Number(left.number) - Number(right.number),
  );
  for (const issue of byNumber) {
    const verdict = classifyDraftCarrier(issue, options);
    if (verdict === null) {
      continue;
    }
    if (verdict.bucket === 'held') {
      carriers.held.push(verdict.entry);
    } else if (verdict.bucket === 'ready') {
      carriers.ready.push(verdict.entry);
    } else {
      carriers.waiting.push(verdict.entry);
    }
  }
  return carriers;
}
export async function filterOrphanIssues(issues, options = {}) {
  const issueStateByNumber = new Map(options.issueStateByNumber ?? []);
  const fetchIssueStateByNumber =
    typeof options.fetchIssueStateByNumber === 'function'
      ? options.fetchIssueStateByNumber
      : () => 'UNRESOLVABLE';
  const filtered = {
    provider_outage_target: [],
    authoring_journal_target: [],
    roadmap_marker: [],
    blocked_by_marker: [],
    blocked_label: [],
    authoring_label: [],
    runtime_observation_precondition: [],
    blocked_by_open_reference: [],
    open_dependency_reference: [],
    unresolvable_reference: [],
    blocked_by_defer_source_origin: [],
    triage_verdict_rejected: [],
  };
  const orphans = [];
  const unresolvable = [];
  const warnings = [];
  // #2767 (CodeRabbit review, PR #2840): collected here, not pushed
  // immediately -- a candidate can still be excluded from the final
  // `orphans` list below (the triage-verdict-rejected filter, or
  // autopilot's below-floor `routed_to_human` routing), and this warning's
  // own text asserts "it stays listed as an orphan," which would be wrong
  // for an issue that does not survive to the final partition. Emitted
  // only for numbers still present in `ranked` at the end of this
  // function.
  const demotedOrphanNumbers = new Set();
  // Self-batch lookup for the dependency parent-epic exemption (#1536): in
  // the CLI wiring `issues` is always the full open-issue batch
  // (`fetchOpenIssues`), so any `Depends on` / task-list reference that
  // resolves OPEN is guaranteed to already be present here — zero extra
  // GitHub API calls. A reference outside this batch (e.g. a partial list
  // passed directly to `filterOrphanIssues`, such as in a test) fails
  // closed via `isDependencyEpicExempt`'s own absent-entry handling.
  const openIssueDetailsByNumber = new Map(
    issues.map((candidate) => [
      candidate.number,
      { title: candidate.title, labels: candidate.labels },
    ]),
  );
  // #2243 staleness anchor lookup: each candidate's own createdAt, used as
  // the resolveLatestSubstantiveIssueEditAt fallback below.
  const issueCreatedAtByNumber = new Map(
    issues.map((candidate) => [candidate.number, candidate.createdAt]),
  );
  // #2767: built once for the whole batch (not per-candidate) -- the
  // static trustedMarkerLogins check is cheap, and isTrustedCollaborator
  // (when supplied) already caches its own live lookups.
  const isTrustedLogin = buildTrustedLoginPredicate(
    options.trustedMarkerLogins ?? [],
    options.isTrustedCollaborator ?? (() => false),
  );
  for (const issue of issues) {
    const classifyOptions = {
      issueStateByNumber,
      fetchIssueStateByNumber,
      markerPrefix: options.markerPrefix,
      authoringLabelName: options.authoringLabelName,
      blockedByHumanLabelName: options.blockedByHumanLabelName,
      needsDecisionLabelName: options.needsDecisionLabelName,
      authoringOnlyLabelName: options.authoringOnlyLabelName,
      roadmapLabelName: options.roadmapLabelName,
      providerOutageDeclarationTarget: options.providerOutageDeclarationTarget,
      authoringJournalTarget: options.authoringJournalTarget,
      openIssueDetailsByNumber,
      currentRepo: options.currentRepo,
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
          const authorLogin = issue.user?.login;
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
      for (const entry of result.details ?? []) {
        unresolvable.push({
          issue: issue.number,
          reference: entry.reference,
          reason: entry.reason,
        });
      }
    }
    if (
      result.reason === 'blocked_by_defer_source_origin' &&
      result.originNumber !== undefined
    ) {
      unresolvable.push({
        issue: issue.number,
        reference: result.originNumber,
        reason: 'issue-not-found-or-inaccessible',
      });
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
    const entry = {
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
    const survivors = [];
    for (const orphan of orphans) {
      // CodeRabbit review, PR #2557: mirror resolveIssueLabelEvents's own
      // fail-open contract for a per-candidate opportunistic fetch -- a
      // transient GitHub API failure here must not abort the whole
      // default-on discover pass; it degrades to "no evidence" (same as an
      // absent marker) and the candidate stays selectable.
      let record = null;
      try {
        record = findTrustedSuitabilityRejection(
          fetchComments(orphan.number),
          trustedMarkerLogins,
          markerPrefix,
        );
      } catch {
        record = null;
      }
      let editedAt = null;
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
  // candidate, and unscored issues are never routed out by score (fail-safe).
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
      // #4199: effort `L` routing is autopilot-only and opt-in via refuse.
      routeEffortL:
        options.autopilot === true && options.effortLPolicy === 'refuse',
      getEffort: (orphan) => orphan.effort,
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
  // #4257: a carrier is classified from its label and marker alone, so it is
  // reported here whichever A0-O bucket filed it in. Its blockers stay out of
  // the top-level `unresolvable` array and its count.
  const draftCarriers = classifyDraftCarriers(issues, {
    issueStateByNumber,
    fetchIssueStateByNumber,
    fetchLabelEventsByIssueNumber: options.fetchLabelEventsByIssueNumber,
    markerPrefix: options.markerPrefix,
    authoringLabelName: options.authoringLabelName,
    authoringOnlyLabelName: options.authoringOnlyLabelName,
    authoringStaleAgeMs: options.authoringStaleAgeMs,
    now: options.now,
    currentRepo: options.currentRepo,
  });
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
    draftCarriersHeld: draftCarriers.held.length,
    draftCarriersReady: draftCarriers.ready.length,
    draftCarriersWaiting: draftCarriers.waiting.length,
  };
  return {
    orphans: ranked,
    routed_to_human: routedToHuman,
    filtered,
    unresolvable,
    warnings,
    counts,
    draftCarriers,
  };
}
async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  // `--draft-carriers` (#4257) is a standalone listing: one label-filtered
  // search, always live, and it never reads or writes the hint cache.
  if (args.draftCarriers) {
    rejectDraftCarrierCombinations(args);
    const now = resolveDraftCarrierNow(args.now);
    const policy = loadPolicy(args.policy);
    const output = produceDraftCarrierOutput(args, policy, now);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }
  // `--purge-cache` is a standalone maintenance action: it never enumerates.
  if (args.purgeCache) {
    const purged = purgeDiscoverHints();
    process.stdout.write(
      `${JSON.stringify({ cache: { mode: 'purge', ...purged } }, null, 2)}\n`,
    );
    return 0;
  }
  if (args.noCache && args.refreshCache) {
    throw markCliUsageError(
      new Error('--no-cache cannot be combined with --refresh-cache'),
    );
  }
  // #3675: a malformed --now is a usage error before any policy or network
  // read, exactly like the other helpers that route it through
  // normalizeNowFlag.
  resolveClaimStateNow(args);
  const policy = loadPolicy(args.policy);
  // The whole output is the cached unit (#3588): a warm hint skips the open
  // issue list and every per-candidate read. The hint only ranks; the
  // selected candidate's live A3-A5 gates and the claim post never read from
  // it.
  const { report: output, cache } = await readDiscoverHint({
    helper: 'discover-orphan-filter',
    owner: args.owner,
    repo: args.repo,
    args: {
      pr: args.pr,
      now: args.now,
      autopilot: args.autopilot,
      withClaimState: args.withClaimState,
      currentClaimId: args.currentClaimId,
    },
    policy,
    noCache: args.noCache,
    refreshCache: args.refreshCache,
    compute: () => produceOutput(args, policy),
    hasCandidate: hasEligibleOrphan,
  });
  process.stdout.write(
    `${JSON.stringify(cache ? { ...output, cache } : output, null, 2)}\n`,
  );
  return 0;
}
/**
 * Build the `--with-claim-state` resolution for one run (#3675): the live
 * comment loader plus the policy inputs the annotation reads, including the
 * forced-handoff mode that lets it follow a handoff successor.
 */
export function buildOrphanClaimState(port, policy, currentClaimId, nowIso) {
  return buildClaimStateResolution(
    port,
    {
      claimTiming: policy.claimTiming,
      trustedMarkerActors: policy.trustedMarkerActors,
      forcedHandoff: policy.forcedHandoff,
    },
    currentClaimId,
    nowIso,
  );
}
/**
 * The clock `--now` sets for the claim-state annotation (#3675). Only
 * meaningful with `--with-claim-state`: without it, or with an empty value
 * (treated as not provided), this returns `undefined` and leaves the raw
 * `--now` to the other readers of it. A value {@link normalizeNowFlag}
 * rejects is a usage error.
 */
export function resolveClaimStateNow(args) {
  if (!args.withClaimState || !args.now) {
    return undefined;
  }
  const normalized = normalizeNowFlag(args.now);
  if (normalized === null) {
    throw markCliUsageError(new Error(NOW_FLAG_USAGE_MESSAGE));
  }
  return normalized;
}
/**
 * Whether an orphan output still lists a candidate worth trying, so a cached
 * output that answers "no" earns exactly one strict-fresh recompute before
 * exhaustion is believed. Uses `claimEligible` when the annotation ran.
 */
export function hasEligibleOrphan(output) {
  const orphans = output?.orphans;
  if (!Array.isArray(orphans)) return false;
  if (orphans.some((entry) => entry?.claimEligible !== undefined)) {
    return orphans.some((entry) => entry?.claimEligible !== false);
  }
  return orphans.length > 0;
}
/**
 * The `--draft-carriers` flags that have no meaning for the listing (#4257).
 * The listing is always live, so a flag that selects the orphan path or a
 * cache mode is a usage error, not a silent no-op.
 */
function rejectDraftCarrierCombinations(args) {
  const combined = [];
  if (args.autopilot) {
    combined.push('--autopilot');
  }
  if (args.withClaimState) {
    combined.push('--with-claim-state');
  }
  if (args.currentClaimIdGiven) {
    combined.push('--current-claim-id');
  }
  if (args.pr !== null) {
    combined.push('--pr');
  }
  if (args.noCache) {
    combined.push('--no-cache');
  }
  if (args.refreshCache) {
    combined.push('--refresh-cache');
  }
  if (args.purgeCache) {
    combined.push('--purge-cache');
  }
  if (combined.length > 0) {
    throw markCliUsageError(
      new Error(
        `--draft-carriers cannot be combined with ${combined.join(', ')}`,
      ),
    );
  }
}
/**
 * The clock for the held-staleness check in `--draft-carriers` (#4257): the
 * current time, or the validated `--now` value. A malformed `--now` is a usage
 * error, as it is for the claim-state annotation.
 */
function resolveDraftCarrierNow(raw) {
  if (raw === '') {
    return new Date();
  }
  const normalized = normalizeNowFlag(raw);
  if (normalized === null) {
    throw markCliUsageError(new Error(NOW_FLAG_USAGE_MESSAGE));
  }
  return normalized;
}
/** The policy fields both orphan-filter modes print (#4257). */
function describeOrphanPolicy(policy) {
  return {
    source: policy.source,
    orphanFirstPolicy: policy.orphanFirstPolicy,
    markerPrefix: policy.markerPrefix,
    authoringLabelName: policy.authoringLabelName,
    authoringOnlyLabelName: policy.authoringOnlyLabelName,
    authoringStaleAge: policy.authoringStaleAge,
    autopilotSuitabilityFloor: policy.autopilotSuitabilityFloor,
    autopilotSuitabilityEnabled: policy.autopilotSuitabilityEnabled,
  };
}
/**
 * Build the `--draft-carriers` listing (#4257) through the provider port: one
 * label-filtered search, then the same classifier A0-O uses. The search is
 * strict, so a failed call throws instead of reading as "no carriers". A
 * result that reaches the search cap may be incomplete, so it is an error.
 */
export function buildDraftCarrierOutput(port, input) {
  const rows = port.searchOpenWorkItems({
    label: input.policy.authoringOnlyLabelName,
    fields: ['number', 'title', 'body', 'state', 'labels', 'url'],
    limit: GH_SEARCH_RESULT_CAP,
    strict: true,
  });
  if (rows.length >= GH_SEARCH_RESULT_CAP) {
    throw new Error(
      `the ${input.policy.authoringOnlyLabelName} search reached GitHub's ${GH_SEARCH_RESULT_CAP}-result cap, so the draft-carrier listing may be incomplete`,
    );
  }
  const draftCarriers = classifyDraftCarriers(
    rows.map((row) => normalizeIssue(row)),
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: (issueNumber) =>
        fetchIssueState(port, issueNumber),
      fetchLabelEventsByIssueNumber: (issueNumber) =>
        fetchIssueLabelEvents(port, issueNumber),
      strictLabelEvents: true,
      markerPrefix: input.policy.markerPrefix,
      authoringLabelName: input.policy.authoringLabelName,
      authoringOnlyLabelName: input.policy.authoringOnlyLabelName,
      authoringStaleAgeMs: input.policy.authoringStaleAgeMs,
      now: input.now,
      currentRepo:
        input.owner && input.repo ? `${input.owner}/${input.repo}` : undefined,
    },
  );
  return {
    repository: { owner: input.owner, repo: input.repo },
    policy: describeOrphanPolicy(input.policy),
    draftCarriers,
    counts: {
      draftCarriersHeld: draftCarriers.held.length,
      draftCarriersReady: draftCarriers.ready.length,
      draftCarriersWaiting: draftCarriers.waiting.length,
    },
  };
}
/** The `--draft-carriers` CLI entry: the GitHub adapter, then the listing (#4257). */
function produceDraftCarrierOutput(args, policy, now) {
  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  return buildDraftCarrierOutput(createGithubProviderAdapter(owner, repo), {
    owner,
    repo,
    policy,
    now,
  });
}
async function produceOutput(args, policy) {
  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  const openIssues = fetchOpenIssues(port);
  const openStateByNumber = new Map(
    openIssues.map((issue) => [issue.number, String(issue.state)]),
  );
  // The claim-state annotation is strictly opt-in: only when
  // --with-claim-state is passed do we build the comment loader (the sole
  // new GitHub API surface) and resolve the trusted-actor / stale-age
  // policy. The default path leaves `claimState` undefined, so no extra
  // fetch is made and the output is byte-stable (mirrors
  // discover-roadmap-graph's own CLI wiring).
  const claimState = args.withClaimState
    ? buildOrphanClaimState(
        port,
        policy,
        args.currentClaimId,
        resolveClaimStateNow(args),
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
  const collaboratorPermissionCache = new Map();
  // #4115: resolved here, where owner/repo are known, so a journal in another
  // repository contributes nothing. The raw journal reference is carried by
  // loadPolicy, so a config change is a hint-cache miss.
  const durableTargets = resolveDurableRecordTargets({
    journalReference: policy.authoringJournalReference,
    providerOutageTarget: policy.providerOutageDeclarationTarget,
    currentRepo: owner && repo ? `${owner}/${repo}` : undefined,
  });
  const result = await filterOrphanIssues(openIssues, {
    currentRepo: owner && repo ? `${owner}/${repo}` : undefined,
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
    authoringOnlyLabelName: policy.authoringOnlyLabelName,
    roadmapLabelName: policy.roadmapLabelName,
    providerOutageDeclarationTarget: durableTargets.providerOutageTarget,
    authoringJournalTarget: durableTargets.authoringJournalTarget,
    autopilotSuitabilityFloor: policy.autopilotSuitabilityFloor,
    autopilotSuitabilityEnabled: policy.autopilotSuitabilityEnabled,
    effortLPolicy: policy.effortLPolicy,
    autopilot: args.autopilot,
    now: args.now || new Date(),
    claimState,
  });
  const output = {
    repository: { owner, repo },
    diagnostics: {
      pr: args.pr,
    },
    policy: describeOrphanPolicy(policy),
    ...result,
  };
  return output;
}
// Excluded from the #1446 cli-args.mts wrapper: --current-claim-id below
// is an optional-value flag -- it may appear bare or take a following
// value, and only consumes the next token when one is present and does
// not itself look like another flag. `util.parseArgs` cannot express this:
// a `string`-type option always requires exactly one value and a
// `boolean`-type option never takes one; there is no in-between mode.
function parseArgs(rawArgv) {
  // #1921/#2465: strip a pnpm-forwarded leading `--` the same way the
  // shared cli-args.mts wrapper does -- this parser is excluded from that
  // wrapper (see the comment above) so it must call the strip directly.
  const argv = stripLeadingArgumentSeparator(rawArgv);
  const parsed = {
    owner: '',
    repo: '',
    policy: '',
    pr: null,
    help: false,
    now: '',
    autopilot: false,
    withClaimState: false,
    currentClaimId: '',
    currentClaimIdGiven: false,
    noCache: false,
    refreshCache: false,
    purgeCache: false,
    draftCarriers: false,
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
        throw markCliUsageError(
          new Error(`invalid --pr value: ${value ?? ''}`),
        );
      }
      parsed.pr = parsedNumber;
      index += 1;
      continue;
    }
    if (token === '--now') {
      // #3675: a missing value, or one that is really the next flag, is a
      // usage error -- otherwise `--now --with-claim-state` would swallow that
      // flag and silently run the annotation on the wall clock (or, without
      // it, never annotate). An explicitly empty value still means not
      // provided.
      if (value === undefined || value.startsWith('--')) {
        throw markCliUsageError(new Error('missing value for argument: --now'));
      }
      parsed.now = value;
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
    if (token === '--no-cache') {
      parsed.noCache = true;
      continue;
    }
    if (token === '--refresh-cache') {
      parsed.refreshCache = true;
      continue;
    }
    if (token === '--purge-cache') {
      parsed.purgeCache = true;
      continue;
    }
    if (token === '--current-claim-id') {
      parsed.currentClaimIdGiven = true;
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
    if (token === '--draft-carriers') {
      parsed.draftCarriers = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    throw markCliUsageError(new Error(`unknown argument: ${token}`));
  }
  return parsed;
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-orphan-filter.mjs [--owner <owner>] [--repo <repo>] [--policy <path>] [--pr <number>] [--now <ISO8601>] [--autopilot] [--with-claim-state] [--current-claim-id <id>] [--no-cache | --refresh-cache]
  node scripts/discover-orphan-filter.mjs --purge-cache
  node scripts/discover-orphan-filter.mjs --draft-carriers [--owner <owner>] [--repo <repo>] [--policy <path>] [--now <ISO8601>]

Hint cache (opt-in via githubApi.readCache.enabled; off by default): the whole
output is cached as a short-lived HINT, so an unchanged repeat inside
githubApi.readCache.maxAge (default PT5M) makes no discovery request. A hint
only ranks candidates: the selected candidate's live A3-A5 gates and the claim
post never read from it. --no-cache computes live and stores nothing;
--refresh-cache recomputes and stores; --purge-cache removes every cached body
from the host-local read cache and exits. A hint written under an earlier
format version (version 4, from #4257, which added draftCarriers) is never
served. When the cache is active or a cache flag is passed, the output gains
an additive "cache" object:
  "cache": {"mode": "hint|refresh|off|bypass", "source": "hint|live", "ageMs": 0, "maxAgeMs": 0, "complete": true, "enumerations": 0, "exhaustionRefresh": false}
An output with no eligible orphan is recomputed once (exhaustionRefresh true).

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "diagnostics": {"pr": 404},
  "policy": {"source": "...", "orphanFirstPolicy": "none|maintainer-approved|public-disabled", "markerPrefix": "...", "authoringLabelName": "...", "authoringOnlyLabelName": "...", "authoringStaleAge": "...", "autopilotSuitabilityFloor": 3, "autopilotSuitabilityEnabled": true},
  "orphans": [{"number": 1, "title": "...", "state": "OPEN", "reason": "orphan|references_non_blocking", "url": "...", "autopilotSuitability": 4, "effort": "S|M|L|null", "milestone": "v0.8.0|null"}],
  "routed_to_human": [{"number": 2, "title": "...", "state": "OPEN", "reason": "orphan", "url": "...", "autopilotSuitability": 1, "effort": "S|M|L|null", "milestone": "v0.8.0|null"}],
  "filtered": {
    "provider_outage_target": [...],
    "authoring_journal_target": [...],
    "roadmap_marker": [...],
    "blocked_by_marker": [...],
    "blocked_label": [...],
    "authoring_label": [...],
    "runtime_observation_precondition": [...],
    "blocked_by_open_reference": [...],
    "open_dependency_reference": [...],
    "unresolvable_reference": [...],
    "blocked_by_defer_source_origin": [...],
    "triage_verdict_rejected": [...]
  },
  "unresolvable": [{"issue": 1, "reference": 2, "reason": "issue-not-found-or-inaccessible"}],
  "warnings": [{"issueNumber": 1, "message": "Warning: ..."}],
  "draftCarriers": {"held": [{"number": 1, "title": "...", "url": "...", "heldSince": "...|null", "stale": false}], "ready": [{"number": 2, "title": "...", "url": "..."}], "waiting": [{"number": 3, "title": "...", "url": "...", "blockers": [{"reference": 4, "reason": "open|issue-not-found-or-inaccessible|cross_repository_reference"}]}]},
  "counts": {"scanned": 0, "orphans": 0, "routed_to_human": 0, "filtered": {...}, "unresolvable": 0, "draftCarriersHeld": 0, "draftCarriersReady": 0, "draftCarriersWaiting": 0}
}

"filtered.provider_outage_target" (#2800) excludes the exact issue named by
the configured "providerOutage.declarationTarget" -- a permanent,
adopter-authored coordination issue documented to stay open indefinitely,
never claimed, never closed, and carrying no roadmap/blocked marker or
blocking label of its own. Checked by issue number alone, ahead of every
marker/label check above, except that a draft carrier is filed under
"filtered.blocked_label" first. None of those checks would otherwise catch it.
Absent config leaves this filter a no-op.

"filtered.authoring_journal_target" (#4115) excludes the issue named by the
configured "issueAuthoring.journalIssue", but only when that reference names
this repository (owner and repo compared case-insensitively). A journal in
another repository, a malformed reference, or no reference contributes
nothing. The journal is durable infrastructure, not work, so it is excluded
by number ahead of the marker and label checks, except that a draft carrier is
filed under "filtered.blocked_label" first. Its scan covers open issues only,
so a closed journal is reported only by the per-issue mode of
discover-readiness-check. When both numbers are equal, the outage reason takes
precedence for a non-carrier.

"filtered.runtime_observation_precondition" (#2467) excludes an issue whose
body names a runtime/production-observation precondition in prose --
"confirmed in production", "observed live", "runtime-observation" -- with no
issue-number reference to resolve, so it stays excluded even once every
numbered "Blocked by"/"Depends on" reference is closed.

"filtered.blocked_by_defer_source_origin" (#4065) excludes a follow-up whose
body carries a defer-source marker (review-fix-loop-cutoff or
review-needs-decision) while its single Refs origin issue is open, the same
origin rule A3's readiness check applies. A closed origin does not block.
"details" is "open:#N", "missing_refs_line", "ambiguous_refs_line", or
"unresolvable:#N"; the last also adds the origin to the top-level
"unresolvable" array as a bare number. A review-needs-decision follow-up
whose configured authoring and needs-decision labels collide reports
"needs_decision_label_conflicts_with_authoring_label" whatever its origin.

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
as no score: the issue stays in orphans and is never routed out by score. With
autopilotSuitability.effortL set to refuse, --autopilot also moves effort L
orphans to routed_to_human.

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

"draftCarriers" (#4257) lists every draft carrier: an open issue that carries
the configured authoring-only label and the carrier marker outside code. The
marker value is not checked, so a carrier with an unexpected value is still
listed. A carrier never becomes an orphan, and every carrier stays in
"filtered.blocked_label", whichever markers it names or configured target
number it carries.
Its buckets are "held" (the carrier also carries the authoring label, with
"heldSince" the latest labeled event (null when none was read) and "stale"
true once that hold is at
least issueAuthoring.authoringStaleAge old), "ready" (no "Blocked by" reference
is open or unresolvable), and "waiting" (each "blockers" entry carries "reason"
open, issue-not-found-or-inaccessible, or cross_repository_reference). Blockers
never enter the top-level "unresolvable" array or its count.

--draft-carriers (#4257) prints only that listing, from one label-filtered
search. It is always live and never reads or writes the hint cache. It prints
"repository", "policy", "draftCarriers", and "counts" (draftCarriersHeld,
draftCarriersReady, draftCarriersWaiting). It cannot be combined with
--autopilot, --with-claim-state, --current-claim-id, --pr, --no-cache,
--refresh-cache, or --purge-cache. --now sets the clock for the held check.

--with-claim-state (opt-in) annotates each candidate in "orphans" and
"routed_to_human" with active-claim eligibility, exactly mirroring
discover-roadmap-graph's flag of the same name: it fetches that issue's
comments and resolves the active claim using the configured
trustedMarkerActors, claimTiming.staleAge (default PT24H), and
claimTiming.heartbeatInterval (default PT12H). Each annotated candidate
gains (activeClaim is always an object):
  "activeClaim": { "present": bool, "stale": bool, "claimId": str|null, "agentId": str|null, "heartbeatOverdue": bool, "localWorktree"?: object }
                 (present:false with claimId/agentId null = no trusted claim)
  "claimEligible": bool   (eligible = no present, non-stale, trusted claim and no unverified stale/released-claim worktree)
Absent the flag, NO comment API calls are made and no claim fields are
emitted (the output shape is byte-stable).
heartbeatOverdue is true when the latest valid claimed-by/heartbeat
created_at is at or past claimTiming.heartbeatInterval with no later trusted
heartbeat; false otherwise, including whenever present is false. It is
PURELY DIAGNOSTIC: it never feeds claimEligible or any other gate.
--now <ISO8601> (with --with-claim-state) sets the clock the annotation
measures claim age against, for a reproducible run; it must be an ISO 8601
date-time with a Z or numeric UTC offset, and a missing or malformed value is a
usage error.
--current-claim-id <id> additionally sets "ownedByCurrentSession": bool on
each activeClaim (true only when the active claim's claimId equals <id> and
the current worktree's claim lock plus generated-tokens record confirm the
same claim and agent identity).
NOTE: claimEligible is a best-effort SOFT discovery hint that may over- or
under-report (same limitation as discover-roadmap-graph's annotation): with
forcedHandoff.mode "human-gated" it follows a forced-handoff transfer posted by
a trusted marker author without checking the handoff's authorization, and it
does not reproduce legacy active-claim takeover rules. Trusted legacy
claim/release evidence is used only for stale/released local-worktree occupancy
checks; the authoritative A5 claim gate (idd-claim.instructions.md) remains
the real protection.
`);
}
export function loadPolicy(policyPath) {
  // Read-and-parse failure semantics (explicit path throws; default path
  // silently falls back only on ENOENT) are converged in idd-config.mts's
  // loadPolicyConfig (#1721) — this function keeps only its own shape
  // normalization on top of that raw config.
  const { path: source, config: rawConfig } = loadPolicyConfig(policyPath);
  const config = rawConfig ?? {};
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
    authoringOnlyLabelName: labelsPolicy.authoringOnlyLabelName,
    roadmapLabelName: labelsPolicy.roadmapLabelName,
    // #2800: own-property-omitted when unconfigured or invalid, matching
    // normalizePolicyConfig's own absence semantics -- resolved to
    // `null` below so downstream callers get a stable, always-present
    // field instead of testing for key presence.
    providerOutageDeclarationTarget:
      normalizedPolicy.providerOutage.declarationTarget ?? null,
    // #4115: the raw `issueAuthoring.journalIssue` value (null when absent).
    // It is resolved to this repository in produceOutput, where owner/repo
    // are known, and it stays in the policy so a change misses the hint cache.
    authoringJournalReference: config.issueAuthoring?.journalIssue ?? null,
    autopilotSuitabilityFloor: resolveAutopilotSuitabilityFloor(config),
    autopilotSuitabilityEnabled: resolveAutopilotSuitabilityEnabled(config),
    // #4199: part of the returned policy, so it is also in the hint-cache
    // key and an allow-to-refuse switch cannot serve a stale cached result.
    effortLPolicy: resolveEffortLPolicy(config),
    // Passed through verbatim (raw, un-normalized) for
    // buildClaimStateResolution (#1395), which expects this same shape —
    // it is only consumed when --with-claim-state is passed. Undefined
    // when no config was found (default path, ENOENT), matching
    // buildClaimStateResolution's own defaults (24h stale age, env-only
    // trusted actors) — the same soft-default philosophy the graph helper
    // already relies on.
    claimTiming: config.claimTiming,
    trustedMarkerActors: config.trustedMarkerActors,
    // #3675: the mode normalized through the shared policy helper (so the
    // legacy `forcedHandoffMode` spellings resolve too), in the nested shape
    // buildClaimStateResolution reads. Only consumed with --with-claim-state.
    forcedHandoff: { mode: normalizedPolicy.forcedHandoff.mode },
  };
}
function resolveAutopilotSuitabilityFloor(config) {
  // Delegate range/default validation to the shared normalizer so the
  // 1-5 rule and the default cannot drift between modules.
  return normalizeAutopilotSuitabilityFloor(
    config?.autopilotSuitability?.floor,
  );
}
function resolveAutopilotSuitabilityEnabled(config) {
  return config?.autopilotSuitability?.enabled !== false;
}
function normalizeIssue(issue) {
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
function extractOpenMilestoneTitle(milestone) {
  if (typeof milestone !== 'object' || milestone === null) {
    return null;
  }
  const record = milestone;
  if (String(record.state ?? '').toLowerCase() !== 'open') {
    return null;
  }
  return typeof record.title === 'string' && record.title.length > 0
    ? record.title
    : null;
}
function resolveIssueLabelEvents(
  issue,
  fetchLabelEventsByIssueNumber,
  strict = false,
) {
  if (Array.isArray(issue.labelEvents) && issue.labelEvents.length > 0) {
    return issue.labelEvents;
  }
  if (typeof fetchLabelEventsByIssueNumber !== 'function') {
    return [];
  }
  // A strict caller (`--draft-carriers`, #4257) must not read an unreadable
  // timeline as "no labeled event": the error propagates, and the run fails.
  if (strict) {
    return fetchLabelEventsByIssueNumber(issue.number);
  }
  try {
    return fetchLabelEventsByIssueNumber(issue.number);
  } catch {
    return [];
  }
}
function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => {
      if (typeof label === 'string') {
        return label;
      }
      return String(label?.name ?? '');
    })
    .filter(Boolean);
}
function resolveIssueState(
  number,
  issueStateByNumber,
  fetchIssueStateByNumber,
) {
  if (issueStateByNumber.has(number)) {
    return issueStateByNumber.get(number);
  }
  const state = fetchIssueStateByNumber(number);
  issueStateByNumber.set(number, state);
  return state;
}
function fetchIssueState(port, issueNumber) {
  return port.getWorkItemState(issueNumber) || 'UNRESOLVABLE';
}
function fetchIssueLabelEvents(port, issueNumber) {
  return port
    .getWorkItemTimeline(issueNumber)
    .filter((event) => event.event === 'labeled');
}
/**
 * #2243: adapts {@link ProviderPort.listWorkItemComments}'s camelCase
 * `ProviderComment` shape to the raw-REST-shaped
 * `SuitabilityRejectionComment` `findTrustedSuitabilityRejection` expects
 * (mirroring `suitability-triage.mts`'s own direct `gh api` comment fetch).
 * `html_url` is intentionally omitted -- this file never reads the
 * resulting record's `url` field, only `markerOutcome`/`createdAt`.
 */
function fetchIssueCommentsForTriageVerdict(port, issueNumber) {
  return port.listWorkItemComments(issueNumber).map((comment) => ({
    body: comment.body,
    created_at: comment.createdAt,
    user: { login: comment.authorLogin },
  }));
}
function normalizeMarkerPrefix(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    return DEFAULT_MARKER_PREFIX;
  }
  return prefix;
}
function normalizeAuthoringLabelName(labelName) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : 'status:authoring';
}
/** Resolve the configured `labels.blockedByHumanLabelName` (#1273). */
function normalizeBlockedByHumanLabelName(labelName) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.blockedByHumanLabelName;
}
/** Resolve the configured `labels.needsDecisionLabelName` (#1273). */
function normalizeNeedsDecisionLabelName(labelName) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.needsDecisionLabelName;
}
/** Resolve the configured `labels.authoringOnlyLabelName`. */
function normalizeAuthoringOnlyLabelName(labelName) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.authoringOnlyLabelName;
}
/**
 * Resolve the configured `labels.roadmapLabelName` for the dependency
 * parent-epic exemption (#1536), following this file's established
 * defensive-default pattern for the other configurable label names.
 */
function normalizeRoadmapLabelName(labelName) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.roadmapLabelName;
}
/** Exported for `tests/discover-orphan-filter.test.mts`'s #2767 regression
 * (CodeRabbit review, PR #2840): a direct `OrphanIssueInput` fixture in a
 * test bypasses this function and `normalizeIssue` entirely, which is
 * exactly how the live CLI's `user`-propagation gap went uncaught -- a
 * test must go through this function to actually exercise it. */
export function fetchOpenIssues(port) {
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
