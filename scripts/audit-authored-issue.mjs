// idd-generated-from: src/scripts/audit-authored-issue.mts
//
// The scripts/audit-authored-issue.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Mechanically audits a drafted GitHub issue body against the
// issue-authoring contract's structural expectations
// (skills/issue-authoring/references/contract.md): the autopilot-suitability
// marker's exactly-one/coherent-value rule, its cross-field agreement with
// the configured blocked-by-human label, markerPrefix consistency across
// every authoring marker, the declared shape's required section headings,
// the roadmap shape's `## Tracks` checkbox lines actually resolving to a
// child issue reference, the roadmap-id/blocked-by dependency-marker
// rules, a failing check that rejects a mid-line or near-miss `Blocked
// by`/`Depends on` mention and a cross-repository token on an otherwise
// well-formed dependency line (see checkDependencyLineGrammar, #3285),
// visible/hidden line agreement for the suitability and effort
// footers, an advisory warning-severity check that flags an issue/PR
// reference used near coordination language (e.g. "before", "once",
// "requires") with no corresponding Blocked-by/Depends-on/task-list
// dependency encoding (see checkProseOnlyDependency), and (given
// pre-fetched comment data) a mechanical count of eligible,
// not-yet-minimized superseded authoring-owner / authoring-publication-intent
// marker comments (see checkAuthoringMarkerMinimizationBacklog, #2896).
// Every advisory/count-only check always reports `result: 'pass'` and
// never changes the exit code. For the orphan and child shapes (#3289),
// it also runs the same A4 viability (discover-viability-gate.mts) and
// A4.5 suitability (suitability-triage.mts) evaluators Discover runs
// later, at claim time, so a body that would fail A4/A4.5 then is caught
// before it is ever published instead of only after (see
// buildTriageFindings); the roadmap shape degrades every one of these
// findings to a not-applicable pass, a missing title fails
// triage-title-missing itself for a ready orphan/child audit (degrading
// only the downstream A4.5 findings to "not evaluated"; A4 stays
// title-independent), and Check 4 (duplicates) always reports "not
// applicable" since it needs a live repository.
//
// All marker value parsing is delegated to the existing
// autopilot-suitability.mts / effort.mts / marker-regex.mts /
// policy-helpers.mts helpers; this module only layers shape-aware
// structural checks on top of them. Pure and network-free — the CLI reads
// the drafted body from a file or stdin rather than fetching a live issue.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAutopilotSuitabilityMarker } from './autopilot-suitability.mjs';
import { parseCliArgs } from './cli-args.mjs';
import {
  hasDependencyReferenceListStart,
  matchDependencyKeywordLine,
} from './dependency-grammar.mjs';
import {
  extractBlockedByIssueNumbers,
  extractBlockedByRoadmapMarkers,
  extractDependencyIssueNumbers,
} from './discover-readiness-check.mjs';
import {
  extractRoadmapMarkerId,
  extractTaskListReferences,
  isTaskListBlockBoundary,
  isTaskListCheckboxLine,
} from './discover-roadmap-graph.mjs';
import { parseCandidateFiles } from './discover-shared-file-overlap.mjs';
import { evaluateA4Viability } from './discover-viability-gate.mjs';
import { parseEffortMarker } from './effort.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import {
  isUpstreamEscalationEnabled,
  loadIddConfig,
  loadPolicyConfig,
} from './idd-config.mjs';
import {
  maskMarkdownForScan,
  stripMarkdownCodeRegions,
} from './markdown-code.mjs';
import {
  classifyAuthoringMarkerFamily,
  countMarkerOccurrences,
  DEFAULT_MARKER_PREFIX,
  isAuthoringBucketValue,
  normalizeMarkerPrefix,
  parseAuthoringBucketMarker,
  parseAuthoringOwnerComment,
  parseAuthoringPublicationComment,
  parseAuthoringPublicationIntentComment,
} from './marker-helpers.mjs';
import { createMarkerRegex, escapeRegex } from './marker-regex.mjs';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mjs';
import { resolveTrustedMarkerActors } from './protocol-helpers.mjs';
import {
  evaluateSuitabilityLocal,
  splitLocalDraftTitleAndBody,
} from './suitability-triage.mjs';

// Re-export the pre-#3289 public surface: normalizeMarkerPrefix and
// parseAuthoringBucketMarker (both now defined in marker-helpers.mts, see
// that module's own "Shared markerPrefix / marker-occurrence helpers"
// section for why) were exported from this file before #3289 moved them
// out to break an import cycle with suitability-triage.mts; re-exporting
// the imported bindings here keeps every existing caller of this module
// (e.g. snapshot-issue-body-corpus.mts) working unchanged. The two
// authoring-bucket types are re-exported for the same reason, even though
// no other module currently imports them from here.
export { normalizeMarkerPrefix, parseAuthoringBucketMarker };

// Shared "skip" detail for every ready-shape-only check when
// `--expect-bucket` is set (#2648 review, Codex): a needs-decision/
// blocked-by-human body uses its own distinct heading/footer shape
// (see skills/issue-authoring/references/draft-patterns.md's
// blocked-by-human example), not the ready orphan/roadmap/child shapes
// these checks validate, so running them against a bucket audit would
// fail a correctly-formed bucket body instead of reading as
// not-applicable.
const NOT_APPLICABLE_BUCKET_AUDIT_DETAIL =
  'not applicable: auditing a needs-decision/blocked-by-human bucket publish (--expect-bucket), not a ready-shape body';
// Shared "not applicable" detail for every triage-a4-*/triage-a45-*/
// triage-title-missing finding (#3289) when `shape === 'roadmap'`: Discover
// never routes a roadmap node through A4 (evaluateA4Viability) or A4.5
// (evaluateSuitabilityLocal) -- both gates only ever see an orphan or
// child candidate -- so running them against a roadmap body would invent
// a triage verdict Discover itself never computes.
const TRIAGE_NOT_APPLICABLE_ROADMAP_DETAIL =
  'not applicable: Discover never routes a roadmap node through A4 or A4.5 triage';
// The authoring-marker suffixes this file checks for prefix consistency.
// Most are defined in the contract (skills/issue-authoring/references/
// contract.md); `upstream-candidate` is defined by roadmap #2700 and
// documented there pending #2702. Operational markers (claimed-by,
// review-watermark, ...) never take this `{prefix}-{suffix}` shape, so
// they cannot collide with this scan.
const AUTHORING_MARKER_SUFFIXES = [
  'roadmap-id',
  'blocked-by',
  'autopilot-suitability',
  'effort',
  'authoring-bucket',
  'upstream-candidate',
];
/**
 * The fixed GitHub label paired with the
 * `<!-- {prefix}-upstream-candidate: true -->` marker (roadmap #2700's
 * "Naming" section). Unlike `blockedByHumanLabelName` /
 * `needsDecisionLabelName`, this name is fixed by the roadmap itself, not
 * policy-configurable -- every adopter that opts in via
 * `upstreamEscalation.enabled` uses the same literal label.
 */
const UPSTREAM_CANDIDATE_LABEL_NAME = 'status:upstream-candidate';
const SHAPE_HEADING_REQUIREMENTS = {
  orphan: [
    { anyOf: ['Background', 'Goal'] },
    { anyOf: ['Proposed change'] },
    { anyOf: ['Acceptance criteria'] },
  ],
  roadmap: [
    { anyOf: ['Goal'] },
    { anyOf: ['Background', 'Why this matters'] },
    { anyOf: ['Tracks'] },
    { anyOf: ['Success criteria'] },
  ],
  child: [
    { anyOf: ['Background'] },
    { anyOf: ['Proposed change'] },
    { anyOf: ['Acceptance criteria'] },
  ],
};
// Coordination-language keywords that, alongside an unencoded issue/PR
// reference in the same sentence, suggest the reference is being used as a
// prose-only start-blocking dependency instead of the required `Blocked by`
// / `Depends on` / task-list encoding. Deliberately broad (an advisory
// check can tolerate false positives; the author "consciously confirms" per
// the contract) rather than an exhaustive parse of every possible phrasing.
const PROSE_DEPENDENCY_KEYWORDS = [
  'before',
  'after',
  'once',
  'until',
  'predates',
  'gate',
  'gated',
  'requires',
  'lands first',
];
// Matches a `Refs #NNN (non-blocking)` reference (and multi-target variants
// like `Refs #201, #202 (non-blocking)`) anywhere on a line — the visible
// encoding discover-roadmap-graph.mts's `extractKeywordReferences`
// recognizes as `relationship: 'non-blocking-reference'` (#2236): a
// deliberately informational reference that must never become an A1.5
// closure-audit blocker. Recognized here too so this check's `encoded` set
// treats it as already-documented, the same as the three
// Blocked-by/Depends-on/task-list forms, instead of flagging it as an
// undocumented prose-only dependency. The captured group (everything
// between the Refs/Ref keyword and the `(non-blocking)` annotation) is
// parsed for its `#N` reference list by `consumeNonBlockingRefList` below,
// mirroring the separator-tolerant list parsing
// discover-readiness-check.mts's own `consumeDependencyRefList` already
// uses for the same comma/`and`/whitespace-separated shape (duplicated
// rather than imported: this repository's existing precedent for the same
// textual encoding recognized by two independent modules for two different
// purposes, see that function's own doc comment).
const NON_BLOCKING_REFERENCE_LINE_PATTERN =
  /\bRefs?\b\s*:?\s*([^.\n(]*?)\s*\(non-blocking\)/gi;
function consumeNonBlockingRefList(segment) {
  const numbers = [];
  let remaining = segment;
  while (remaining) {
    const refMatch = remaining.match(/^#(\d+)\b/);
    if (!refMatch) {
      break;
    }
    numbers.push(Number.parseInt(refMatch[1], 10));
    remaining = remaining.slice(refMatch[0].length);
    const separatorMatch = remaining.match(
      /^(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s+)/i,
    );
    if (!separatorMatch) {
      break;
    }
    remaining = remaining.slice(separatorMatch[0].length);
  }
  return numbers;
}
function extractNonBlockingReferenceIssueNumbers(text) {
  const stripped = maskMarkdownForScan(text);
  const numbers = [];
  for (const match of stripped.matchAll(NON_BLOCKING_REFERENCE_LINE_PATTERN)) {
    numbers.push(...consumeNonBlockingRefList(match[1]));
  }
  return [...new Set(numbers)];
}
// Matches a Markdown link whose target is a full GitHub issue/PR URL (e.g.
// `[PR #1391](https://github.com/owner/repo/pull/1391)`), a bare `#123`
// issue/PR reference, a bare full GitHub issue/PR URL, or a local
// `owner/repo#123` shorthand — in that order, capturing each URL/shorthand
// alternative's owner and repo so callers can tell a local reference from
// a cross-repo one (see `currentRepo` handling in checkProseOnlyDependency
// below). The Markdown-link alternative is tried (and, being anchored at
// the label's own `[`, wins) first specifically so that a cross-repo
// link's *label* text — which often repeats the same `#N` the URL already
// names, e.g. the `#1391` above — is consumed as part of that one link
// match rather than separately re-matched by the bare-`#` alternative and
// misread as a local reference once the link's URL itself is correctly
// filtered out as cross-repo. Between the issue/PR number and the link's
// closing `)`, the Markdown-link alternative also tolerates an optional
// trailing `/`, an optional URL fragment (`#issuecomment-123`), and an
// optional quoted title (`"..."` or `'...'`) — each bounded tightly enough
// (a matching quote character, or a fragment charset that excludes `)`,
// quotes, and whitespace) that none of them can consume past the link's
// real closing paren the way a naive `.*\)` would. Without this, any of
// those three trailing forms would break the Markdown-link match and let
// the label's own bare `#N` leak through to the bare-`#` alternative
// below, reintroducing the label-leak false positive the Markdown-link
// alternative exists to prevent. `#` alone (as in an ATX heading) never
// matches without trailing digits. The bare-`#` alternative excludes a `#`
// immediately preceded by a word character or `/` (a negative lookbehind),
// so cross-repo shorthand like `other/repo#123` does not match on its
// trailing `#123` — a cross-repo reference cannot be encoded with this
// repository's local `Blocked by` / `Depends on` markers, so flagging it
// here would be misleading rather than actionable. The final `owner/repo#N`
// shorthand alternative recognizes that same shape as a *distinct*,
// dedicated match (rather than leaving it permanently unmatched) so
// checkProseOnlyDependency can apply the currentRepo comparison to it —
// flagging it only when the shorthand names the current repository (see
// the `currentRepo` JSDoc on `AuditOptions` for the reversed-default-
// polarity rationale). It reuses the bare-`#` alternative's own
// `(?<![\w/])` lookbehind so it, too, only starts matching at a natural
// token boundary rather than mid-path (e.g. inside a 3-segment
// slash-separated path that happens to end in `#123`).
//
// The quoted-title sub-pattern tolerates a backslash-escaped quote
// matching the title's own delimiter (`\"` inside a `"..."` title, or
// `\'` inside a `'...'` title) as content instead of letting it close the
// title early: `(?:\\.|[^"\\\n])*` (and the single-quote equivalent)
// tries consuming a backslash plus the character right after it as one
// unit before falling back to "any character that is not the quote, a
// backslash, or a newline", so an escaped quote is never mistaken for the
// real closing delimiter. Without this, a title like `"reviewed
// \"API\""` would close at the first escaped quote, leave the rest of
// the title as unconsumed content before the link's real closing paren,
// fail the whole Markdown-link alternative, and re-leak the label's own
// bare `#N` to the bare-`#` alternative — the same failure mode the
// trailing-content tolerances above already guard against, just
// triggered by escaping instead of an unhandled trailing shape.
//
// The character class excludes a literal backslash (not just the quote
// and newline) so the two alternatives never overlap on the same input
// character: `\\.` is the only alternative that can ever consume a `\`,
// and the class-based alternative is the only one that can consume
// anything else. A version that let the class also match a bare `\`
// (`[^"\n]` alone) would let the engine choose, for every backslash in a
// run of them, between pairing it with the next character via `\\.` or
// consuming it alone via the class — an ambiguity that multiplies
// combinatorially (Fibonacci-many partitions of an N-backslash run) and
// causes catastrophic backtracking once the overall match fails, i.e.
// exponential-time behavior on a long run of backslashes with no closing
// quote (confirmed empirically: a ~30-character adversarial input took
// several seconds under the ambiguous form; a ~10,000-character one
// resolves in under a millisecond after excluding the backslash from the
// class). This is the standard non-overlapping idiom for a
// backslash-escaped quoted string and applies to both quote styles.
const ISSUE_OR_PR_REFERENCE_PATTERN =
  /\[[^\]\n]*\]\(https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?:\/)?(?:#[^)\s"']+)?(?:\s+(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'))?\)|(?<![\w/])#(\d+)\b|https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\b|(?<![\w/])([\w.-]+)\/([\w.-]+)#(\d+)\b/gi;
// Matches a Markdown list item marker at the start of a line (unordered
// `-`/`*`/`+`, or ordered `1.`/`1)`), optionally indented and optionally
// followed by a task-list checkbox. Captures the leading indentation
// (group 1) so splitIntoListItemBlocks can tell a deeper-indented
// nested/child marker from a new marker at the same or shallower
// indentation as the currently open node at that depth in its
// indentation-ancestry stack — see that function for how the two are
// told apart. Declared here (before the CLI entry
// block below), not next to splitIntoSentences/splitIntoListItemBlocks
// that use it, because those are hoisted function declarations but this
// is a module-level `const` — declaring it after the entry block would be
// a TDZ risk under the CLI path, which calls main() synchronously at this
// point in module evaluation (see tests/cli-entry-smoke.test.mts).
const LIST_ITEM_MARKER_PATTERN = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
// A continuation line (no list-item marker of its own) has no
// LIST_ITEM_MARKER_PATTERN capture group to read an indentation from,
// unlike a marker line — its own leading whitespace has to be measured
// directly (see `lineIndentColumn`, used by splitIntoListItemBlocks's
// continuation-line branch, #1476). Declared here for the same
// TDZ reason as LIST_ITEM_MARKER_PATTERN immediately above: this is a
// module-level `const` reached by the same synchronous CLI call path,
// not a hoisted function declaration.
const LEADING_WHITESPACE_PATTERN = /^\s*/;
// Matches a Markdown reference-style link *usage*: `[text][ref]`, where a
// separate `[ref]: <target>` definition (matched by
// LINK_REFERENCE_DEFINITION_PATTERN below) supplies the actual target
// elsewhere in the document — commonly far from the usage, so this is
// resolved as a whole-document pre-processing step (see
// resolveReferenceStyleLinks) rather than as a fifth alternative inside
// ISSUE_OR_PR_REFERENCE_PATTERN, which cannot look outside its own match
// to find the target. The ref label must be non-empty — this
// deliberately excludes the shortcut forms `[text][]` and bare `[text]`
// (which would resolve the ref from the label text itself); only the
// explicit-ref shape named in issue #1472 is in scope here. Same
// TDZ-avoidance placement rationale as LIST_ITEM_MARKER_PATTERN above.
const REFERENCE_STYLE_LINK_USAGE_PATTERN = /\[([^\]\n]*)\]\[([^\]\n]+)\]/g;
// Matches a Markdown link reference definition line: optionally indented
// (up to 3 spaces, per CommonMark), `[label]: target`, with the target
// read up to the first whitespace. An optional title on the same
// definition line (e.g. `[ref]: <url> "title"`) is intentionally not
// captured — only the destination matters for resolving a reference-style
// link to a GitHub issue/PR URL.
const LINK_REFERENCE_DEFINITION_PATTERN = /^ {0,3}\[([^\]\n]+)\]:\s*(\S+)/gm;
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `shape:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --shape spec key
// below. See cli-args.mts's module header for the full invariant.
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls main() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires.
const AUDIT_AUTHORED_ISSUE_FLAG_SPEC = {
  '--help': { type: 'boolean', short: 'h', default: false },
  '--shape': { type: 'string' },
  '--title': { type: 'string' },
  '--body-file': { type: 'string' },
  '--stdin': { type: 'boolean', default: false },
  '--marker-prefix': { type: 'string' },
  '--config': { type: 'string' },
  '--current-repo': { type: 'string' },
  '--issue': { type: 'string' },
  '--label': { type: 'string', multiple: true },
  '--expect-bucket': { type: 'string' },
  '--comments-file': { type: 'string' },
  '--journal-comments-file': { type: 'string' },
  '--new-issue': { type: 'boolean', default: false },
  '--trusted-marker-logins': { type: 'string' },
  '--format': { type: 'string', default: 'json' },
};
// Declared here (alongside the flag spec above), not next to
// checkAuthoringOwnerMarkerTrail further down: the import.meta.main trigger
// immediately below calls main() -> auditAuthoredIssue() ->
// checkAuthoringOwnerMarkerTrail() synchronously at module-evaluation time,
// and a `const` declared after that point is still in the temporal dead
// zone when the trigger fires (same TDZ hazard as AUDIT_AUTHORED_ISSUE_FLAG_SPEC
// itself and the LIST_ITEM_MARKER_PATTERN family further down this file).
const AUTHORING_OWNER_QUALIFYING_MODES = new Set([
  'acquire',
  'bootstrap',
  'resume',
]);
const AUTHORING_PUBLICATION_INTENT_MEMBER_OR_LATER = new Set([
  'member',
  'cleanup',
  'abandoned',
]);
// A real issue reference has the shape `owner/repo#number` -- the same
// shape the issueAuthoring.journalIssue schema pattern requires, kept
// in sync with it deliberately (word/dot/hyphen segments either side
// of exactly one `/`, a `#`, then a non-zero-leading number; #2681
// review, Copilot). An opaque bootstrap placeholder (e.g.
// `target-<hex>`, `anchor-<hex>`) never matches this shape, so it
// distinguishes "this publication marker named an already-known real
// anchor" from "this publication marker was minted before any anchor
// existed" without depending on the two opaque IDs being textually
// identical (#2681: real authoring sessions mint distinct opaque
// `target`/`anchor` values even for a genuinely self-anchored issue).
// Same TDZ hazard as the two sets above -- declared here, ahead of the
// import.meta.main trigger, not next to
// ownerMarkerAnchorMatchesPublication()/checkAuthoringOwnerMarkerTrail()
// further down.
// Exported so tests/schema-type-reconciliation.test.mts can assert this
// stays textually in sync with schemas/policy.schema.json's
// issueAuthoring.journalIssue pattern (#2681 review, CodeRabbit) --
// deliberately using `[0-9]` rather than `\d` so the only normalization
// needed against the JSON schema string is the regex literal's escaped
// `/`.
export const REAL_ISSUE_REFERENCE_PATTERN = /^[\w.-]+\/[\w.-]+#[1-9][0-9]*$/;
// A canonical or near-miss spelling of one of the two dependency
// keywords, case-insensitively, optionally wrapped in up to 3 leading
// and/or trailing `*`/`_` emphasis markers (a colon, and any emphasis
// this pattern's own trailing group doesn't happen to consume, is
// handled separately by stripDependencyLineDecoration further down).
// Deliberately does NOT use `\b` around the alternation: `\b` treats `_`
// as a word character, so `_Blocked by_ #12` -- ordinary CommonMark
// underscore emphasis, not an obscure shape -- would silently fail to
// match. Both boundaries break independently: a leading `_` (`_Blocked
// by #12`) defeats the boundary check right after the emphasis run, and
// a trailing `_` (`Blocked by_ #12`) defeats the one right after "by",
// so either one alone -- and certainly both together, as in the example
// above -- silently drops the match (confirmed empirically during the
// C1 review of this file, #3285).
// Instead, `(?<![A-Za-z0-9])`/`(?![A-Za-z0-9])` bound the whole
// emphasis-plus-keyword run against a true letter/digit, which an
// emphasis marker never is, so leading/trailing `*`/`_` count as a
// boundary the same as whitespace or punctuation does. This does NOT by
// itself exclude a real machine marker like `idd-skill-blocked-by` (a
// `-` is not a letter/digit either, so the boundary check still passes
// there) -- a marker whose value happens to look like a reference (e.g.
// `<!-- idd-skill-blocked-by: #12 -->`) is instead excluded upstream, by
// checkDependencyLineGrammar masking every well-formed
// `{markerPrefix}-blocked-by` marker out of its near-miss scan input
// before this pattern ever runs against it (#3285 final review round,
// Copilot) -- not by requiring a genuine reference to follow, which
// alone is not enough, since the marker's own value can itself look
// like one. Same TDZ hazard as REAL_ISSUE_REFERENCE_PATTERN and its
// siblings above -- declared here, ahead of the import.meta.main
// trigger, not next to
// findDependencyKeywordMisuse()/checkDependencyLineGrammar() further down
// (#3285: checkDependencyLineGrammar runs synchronously off of
// main() -> auditAuthoredIssue() at CLI-entry time, so a `const` declared
// after this trigger point is still in the temporal dead zone when it
// fires).
const NEAR_MISS_DEPENDENCY_KEYWORD_PATTERN =
  /(?<![A-Za-z0-9])[*_]{0,3}(?:blocked\s+by|blocked-by|blockedby|depends\s+on|depends-on|dependson)[*_]{0,3}(?![A-Za-z0-9])/gi;
// Matches a Markdown link's opening `[label](target)` shape at the start
// of a string -- deliberately looser than ISSUE_OR_PR_REFERENCE_PATTERN's
// own Markdown-link alternative (which requires a full GitHub issue/PR
// URL target): looksLikeIssueMarkdownLink further down narrows it back
// down by requiring an issue-shaped label or target, so this only needs
// to find the link's own boundaries. Same TDZ hazard as
// NEAR_MISS_DEPENDENCY_KEYWORD_PATTERN immediately above.
const MARKDOWN_LINK_START_PATTERN = /^\[([^\]\n]*)\]\(([^)\n]*)\)/;
// Matches a Markdown reference-style link's opening usage at the start of
// a string -- `[label][ref]` (the `ref` itself is defined elsewhere in
// the body, e.g. `[ref]: https://...`, which this per-line function has
// no access to; only the label is checked here, same limitation as
// MARKDOWN_LINK_START_PATTERN's inline-link form above). Deliberately
// does not require the `ref` to be non-empty, unlike
// REFERENCE_STYLE_LINK_USAGE_PATTERN elsewhere in this file (which
// excludes the shortcut `[text][]`/bare `[text]` forms for its own,
// different purpose of resolving a real definition) -- here, any
// bracketed second segment (including empty) still reads as "shaped like
// a reference-style link", which is all this near-miss check needs to
// decide (`idd-skill#3285` final review round, CodeRabbit). Same TDZ
// hazard as MARKDOWN_LINK_START_PATTERN immediately above.
const MARKDOWN_REFERENCE_LINK_START_PATTERN = /^\[([^\]\n]*)\]\[[^\]\n]*\]/;
if (import.meta.main) {
  // #3343: fail_() still writes `error: <message>` and must not also print
  // a stack. Catch that tagged throw here. Call main() directly on the
  // envelope-disabled path so any other uncaught crash keeps its pre-
  // migration stack depth.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('audit-authored-issue', () => {
      try {
        return main();
      } catch (error) {
        if (isAuditCliFail(error)) {
          return { exitCode: 2, kind: 'usage', message: error.message };
        }
        throw error;
      }
    });
  } else {
    try {
      applyHelperCliOutcomeWhenDisabled(main());
    } catch (error) {
      if (!isAuditCliFail(error)) {
        throw error;
      }
      process.exitCode = 2;
    }
  }
}
/**
 * Audit a drafted issue body against the issue-authoring contract's
 * structural expectations for the declared shape. Every check runs
 * independently (no short-circuit), so one report surfaces every problem
 * at once instead of stopping at the first failure. Three checks
 * (`prose-dependency`, `roadmap-tracks-parse`, and
 * `authoring-marker-minimization-backlog`) are advisory-only: each
 * always reports `result: 'pass'` and only ever adds a `severity:
 * 'warning'` marker plus detail on the specific condition it flags, so
 * none of the three ever affects `passed` or the caller's exit code. See
 * {@link AuditFinding.severity}.
 */
export function auditAuthoredIssue(body, options) {
  const rawText = typeof body === 'string' ? body : String(body ?? '');
  // Mask Markdown code regions (fenced blocks, indented blocks, and
  // inline spans) once, up front, and run every check (marker counting,
  // heading detection, visible-line scoping) against the result. A
  // pasted template/example snippet — quoting a marker or heading for
  // illustration — must never count as the real thing. Reuses the same
  // maskMarkdownForScan primitive extractRoadmapMarkerId already relies
  // on (#3281; originally stripMarkdownCodeRegions, which missed
  // indented code), rather than a second, independently-maintained
  // fence tracker.
  const text = maskMarkdownForScan(rawText);
  const shape = options.shape;
  const markerPrefix = normalizeMarkerPrefix(options.markerPrefix);
  const blockedByHumanLabelName =
    typeof options.blockedByHumanLabelName === 'string' &&
    options.blockedByHumanLabelName.length > 0
      ? options.blockedByHumanLabelName
      : POLICY_DEFAULTS.labels.blockedByHumanLabelName;
  const needsDecisionLabelName =
    typeof options.needsDecisionLabelName === 'string' &&
    options.needsDecisionLabelName.length > 0
      ? options.needsDecisionLabelName
      : POLICY_DEFAULTS.labels.needsDecisionLabelName;
  const labels = (options.labels ?? []).map((label) =>
    String(label).trim().toLowerCase(),
  );
  // #3281 review (CodeRabbit): parseAutopilotSuitabilityMarker masks its
  // own input (maskMarkdownForScan), so passing the already-masked
  // `text` here would mask it a SECOND time -- a masked inline code
  // span's replacement spaces can read as a fresh top-level indented
  // code block to a second pass, swallowing real content that follows
  // it on the same line. Pass rawText to every downstream helper that
  // masks its own input; only helpers that scan already-masked text
  // directly (countMarkerOccurrences and friends) still take `text`.
  const suitability = parseAutopilotSuitabilityMarker(rawText, markerPrefix);
  const suitabilityCount = countMarkerOccurrences(
    text,
    markerPrefix,
    'autopilot-suitability',
  );
  const authoringBucket = parseAuthoringBucketMarker(text, markerPrefix);
  const isBucketAudit = options.expectedAuthoringBucket !== undefined;
  const findings = [
    checkSuitabilityMarker(suitabilityCount, suitability, isBucketAudit),
    checkSuitabilityBlockedByHuman(
      suitability,
      authoringBucket,
      labels,
      blockedByHumanLabelName,
    ),
    checkAuthoringBucketNeedsDecision(
      authoringBucket,
      labels,
      needsDecisionLabelName,
    ),
    checkAuthoringBucketMarkerRequired(
      authoringBucket,
      options.expectedAuthoringBucket,
    ),
    checkMarkerPrefixConsistency(
      text,
      markerPrefix,
      options.upstreamEscalationEnabled === true,
    ),
    checkRequiredHeadings(text, shape, isBucketAudit),
    checkRoadmapTracksParse(
      text,
      shape,
      isBucketAudit,
      normalizeCurrentRepo(options.currentRepo),
    ),
    checkDependencyMarkerRule(text, rawText, markerPrefix, shape),
    checkDependencyLineGrammar(
      text,
      rawText,
      normalizeCurrentRepo(options.currentRepo),
      markerPrefix,
    ),
    checkCandidateFilesNotEmpty(
      rawText,
      shape,
      isBucketAudit,
      authoringBucket,
      suitability,
    ),
    checkSuitabilityVisibleLineAgreement(text, markerPrefix, suitability),
    checkEffortVisibleLineAgreement(text, rawText, markerPrefix),
    checkProseOnlyDependency(
      text,
      rawText,
      normalizeCurrentRepo(options.currentRepo),
    ),
    checkAuthoringOwnerMarkerTrail(text, markerPrefix, labels, options),
    checkAuthoringMarkerMinimizationBacklog(markerPrefix, options),
    checkUpstreamCandidateMarkerLabel(
      text,
      markerPrefix,
      labels,
      options.upstreamEscalationEnabled === true,
    ),
    ...buildTriageFindings(
      rawText,
      shape,
      options.title,
      isBucketAudit,
      blockedByHumanLabelName,
      needsDecisionLabelName,
      markerPrefix,
    ),
  ];
  return {
    shape,
    markerPrefix,
    passed: findings.every((finding) => finding.result === 'pass'),
    findings,
  };
}
/**
 * Runs the same A4 viability (`evaluateA4Viability`) and A4.5 suitability
 * (`evaluateSuitabilityLocal`) evaluators Discover and
 * `suitability-triage.mjs --body-file` already run, at authoring time
 * (#3289) -- so a body that would fail A4/A4.5 at claim time is caught
 * before it is ever published, instead of only after. Emits one
 * `triage-title-missing` finding, one `triage-a4-<criterion id>` finding
 * per A4 criterion, and one `triage-a45-<check id>` finding per A4.5
 * check. Every branch below runs `evaluateA4Viability`/
 * `evaluateSuitabilityLocal` unconditionally (even for a `roadmap` shape
 * or a missing title, whose findings are then overridden to "not
 * applicable"/"not evaluated") rather than hardcoding the criterion/check
 * id-and-name list here, so this finding set can never drift from
 * `discover-viability-gate.mts`'s `CRITERIA` array or
 * `suitability-triage.mts`'s `CHECKS` array.
 */
function buildTriageFindings(
  rawText,
  shape,
  explicitTitle,
  isBucketAudit,
  blockedByHumanLabelName,
  needsDecisionLabelName,
  markerPrefix,
) {
  const isRoadmap = shape === 'roadmap';
  const { title: autoTitle, body: autoBody } =
    splitLocalDraftTitleAndBody(rawText);
  const trimmedExplicitTitle =
    typeof explicitTitle === 'string' ? explicitTitle.trim() : '';
  // An explicit --title always wins over a leading "# <title>" body line,
  // per this option's own doc comment on AuditOptions.title.
  const resolvedTitle =
    trimmedExplicitTitle.length > 0 ? trimmedExplicitTitle : autoTitle;
  const titleMissing = resolvedTitle.length === 0;
  // #3 of the proposed change: with --expect-bucket, a would-be-failing
  // triage finding (including triage-title-missing) is demoted to a pass
  // with a warning instead, since a needs-decision/blocked-by-human body
  // is meant to be non-ready -- mirroring how the rest of this file's
  // ready-shape-only checks already special-case isBucketAudit.
  const demoteIfBucketAudit = (finding) =>
    isBucketAudit && finding.result === 'fail'
      ? { ...finding, result: 'pass', severity: 'warning' }
      : finding;
  const titleFinding = (() => {
    const id = 'triage-title-missing';
    const name =
      'A title is resolvable (--title, or a leading "# <title>" body line)';
    if (isRoadmap) {
      return pass(id, name, TRIAGE_NOT_APPLICABLE_ROADMAP_DETAIL);
    }
    // Unlike the A4/A4.5 findings below, a bucket body's own distinct
    // Background/Required action/Ready signal shape carries no title
    // convention at all (see the contract's Mechanical pre-publish gate
    // section) -- this is a structural prerequisite check, not a content
    // triage verdict, so it follows checkSuitabilityMarker/
    // checkRequiredHeadings/checkRoadmapTracksParse's existing
    // isBucketAudit convention (not applicable) rather than
    // demoteIfBucketAudit's fail-to-warning treatment.
    if (isBucketAudit) {
      return pass(id, name, NOT_APPLICABLE_BUCKET_AUDIT_DETAIL);
    }
    if (!titleMissing) {
      return pass(id, name, `title resolved: "${resolvedTitle}"`);
    }
    return fail(
      id,
      name,
      'no title was found: pass --title, or start the drafted body with a leading "# <title>" line',
    );
  })();
  // Deliberately never passes structuralEvidence (proposed-change point
  // 4): authoring time has no live author/file data, so the #2767
  // demotion (a lexical fail promoted to a passing 'warn' criterion) can
  // never fire here -- every criterion result is 'pass' or 'fail', never
  // 'warn', matching the local dry-run CLI's own documented contract.
  const a4Result = evaluateA4Viability({
    number: 0,
    title: resolvedTitle,
    body: autoBody,
    state: 'draft',
  });
  const a4Findings = a4Result.criteria.map((criterion) => {
    const id = `triage-a4-${criterion.id}`;
    const name = `A4 viability: ${criterion.name}`;
    if (isRoadmap) {
      return pass(id, name, TRIAGE_NOT_APPLICABLE_ROADMAP_DETAIL);
    }
    if (criterion.result !== 'fail') {
      return pass(id, name, criterion.evidence);
    }
    return demoteIfBucketAudit(fail(id, name, criterion.evidence));
  });
  // Synthesize a "# <title>\n\nbody" blob so evaluateSuitabilityLocal's
  // own internal splitLocalDraftTitleAndBody recovers exactly the
  // resolved title (an explicit --title, not only a body's own leading H1
  // line) -- it takes bodyText only and has no separate title parameter.
  // When titleMissing, feed it autoBody unchanged: every triage-a45-*
  // finding below is overridden to "not evaluated" regardless of what
  // this run actually reports, so the exact title-less verdict is
  // discarded -- only the check id/name metadata is used.
  const suitabilityBodyText = titleMissing
    ? autoBody
    : `# ${resolvedTitle}\n\n${autoBody}`;
  const suitability = evaluateSuitabilityLocal(suitabilityBodyText, {
    blockedByHumanLabelName,
    needsDecisionLabelName,
    markerPrefix,
  });
  const a45Findings = suitability.checks.map((check) => {
    const id = `triage-a45-${check.id}`;
    const name = `A4.5 suitability: ${check.name}`;
    if (isRoadmap) {
      return pass(id, name, TRIAGE_NOT_APPLICABLE_ROADMAP_DETAIL);
    }
    // Check 4 (duplicate_or_superseded) fundamentally needs a live GitHub
    // search index -- reported as "not applicable" here the same way this
    // file's own bucket-audit/not-applicable findings already read, never
    // as a hard failure (proposed-change point 1).
    if (check.id === 'duplicate_or_superseded') {
      return pass(
        id,
        name,
        `not applicable: needs the live repository (${check.evidence})`,
      );
    }
    if (titleMissing) {
      return pass(
        id,
        name,
        'not evaluated: no title was resolved for this draft (see triage-title-missing)',
      );
    }
    if (check.result !== 'fail') {
      return pass(id, name, check.evidence);
    }
    return demoteIfBucketAudit(fail(id, name, check.evidence));
  });
  return [titleFinding, ...a4Findings, ...a45Findings];
}
function checkSuitabilityMarker(count, suitability, isBucketAudit) {
  const id = 'suitability-marker';
  const name = 'Exactly one coherent autopilot-suitability marker (1-5)';
  if (isBucketAudit) {
    return pass(id, name, NOT_APPLICABLE_BUCKET_AUDIT_DETAIL);
  }
  if (count === 0) {
    return fail(id, name, 'missing autopilot-suitability marker');
  }
  if (count > 1) {
    return fail(
      id,
      name,
      `expected exactly one autopilot-suitability marker, found ${count}`,
    );
  }
  if (suitability.malformed || suitability.value === null) {
    return fail(
      id,
      name,
      'autopilot-suitability marker value is not a coherent integer 1-5',
    );
  }
  return pass(id, name, `suitability score is ${suitability.value}`);
}
/**
 * Suitability=1 implies `blockedByHumanLabelName` -- unless an
 * `authoring-bucket` marker is present, in which case that marker's value
 * decides applicability instead (#2639): `blocked-by-human` requires the
 * label regardless of the suitability score; any other coherent value
 * (currently only `needs-decision`) means this check does not apply, even
 * at suitability 1. A malformed or absent marker (`value: null`) falls
 * back to the pre-existing suitability-1-only rule, preserving behavior
 * for every issue published before this marker existed.
 */
function checkSuitabilityBlockedByHuman(
  suitability,
  authoringBucket,
  labels,
  blockedByHumanLabelName,
) {
  const id = 'suitability-blocked-by-human';
  const name = `Suitability 1 (or an authoring-bucket: blocked-by-human marker) carries the ${blockedByHumanLabelName} label`;
  const applies =
    authoringBucket.value === 'blocked-by-human' ||
    (authoringBucket.value === null && suitability.value === 1);
  if (!applies) {
    return pass(
      id,
      name,
      'not applicable: neither the authoring-bucket marker nor a suitability score of 1 apply',
    );
  }
  const target = blockedByHumanLabelName.trim().toLowerCase();
  if (labels.includes(target)) {
    return pass(id, name, `${blockedByHumanLabelName} label is present`);
  }
  const reason =
    authoringBucket.value === 'blocked-by-human'
      ? `authoring-bucket marker reads blocked-by-human but the ${blockedByHumanLabelName} label was not provided`
      : `suitability score is 1 but the ${blockedByHumanLabelName} label was not provided`;
  return fail(id, name, reason);
}
/**
 * `authoring-bucket: needs-decision` implies `needsDecisionLabelName`
 * (#2639), mirroring {@link checkSuitabilityBlockedByHuman}'s
 * `blocked-by-human` handling. Not applicable when the marker is absent,
 * malformed, or reads `blocked-by-human` instead.
 */
function checkAuthoringBucketNeedsDecision(
  authoringBucket,
  labels,
  needsDecisionLabelName,
) {
  const id = 'authoring-bucket-needs-decision';
  const name = `authoring-bucket: needs-decision carries the ${needsDecisionLabelName} label`;
  if (authoringBucket.value !== 'needs-decision') {
    return pass(
      id,
      name,
      'not applicable: authoring-bucket marker does not read needs-decision',
    );
  }
  const target = needsDecisionLabelName.trim().toLowerCase();
  if (labels.includes(target)) {
    return pass(id, name, `${needsDecisionLabelName} label is present`);
  }
  return fail(
    id,
    name,
    `authoring-bucket marker reads needs-decision but the ${needsDecisionLabelName} label was not provided`,
  );
}
/**
 * Requires the `authoring-bucket` marker to actually be present and match
 * `expectedBucket`, when the caller declares one (#2639 follow-up). The two
 * checks above only validate the marker/label pair *when a marker already
 * exists*; without this check, a body that omits the marker entirely -- the
 * exact gap #2636/#2637 hit -- silently reads as "not applicable" from both,
 * since a `ready`-shape publish is the only case the Mechanical pre-publish
 * gate otherwise audits. `expectedBucket` must be supplied by the caller
 * when (and only when) auditing a body about to be newly published into the
 * `needs-decision` or `blocked-by-human` bucket; a `ready` publish, or an
 * already-published legacy body, passes `undefined` and this check no-ops.
 */
function checkAuthoringBucketMarkerRequired(authoringBucket, expectedBucket) {
  const id = 'authoring-bucket-marker-required';
  const name =
    'A newly published needs-decision/blocked-by-human body carries the matching authoring-bucket marker';
  if (expectedBucket === undefined) {
    return pass(
      id,
      name,
      'not applicable: no expected bucket declared for this audit (ready publish, or a legacy body)',
    );
  }
  if (authoringBucket.value === expectedBucket) {
    return pass(
      id,
      name,
      `authoring-bucket marker matches the declared ${expectedBucket} bucket`,
    );
  }
  if (!authoringBucket.present) {
    return fail(
      id,
      name,
      `expected an authoring-bucket: ${expectedBucket} marker for a newly published ${expectedBucket} body, but none was found`,
    );
  }
  if (authoringBucket.malformed) {
    return fail(
      id,
      name,
      `expected an authoring-bucket: ${expectedBucket} marker, but the marker present is malformed (an unrecognized value, or repeated with disagreeing values)`,
    );
  }
  return fail(
    id,
    name,
    `expected an authoring-bucket: ${expectedBucket} marker, but found authoring-bucket: ${authoringBucket.value} instead`,
  );
}
/**
 * Mirrors {@link checkSuitabilityBlockedByHuman}'s marker/label
 * cross-field pattern, but bidirectionally (#2700/#2703): the
 * `status:upstream-candidate` label and the
 * `<!-- {prefix}-upstream-candidate: true -->` marker must always agree,
 * in either direction -- one present without the other is a fail, both
 * or neither is a pass. This is stricter than the one-directional
 * suitability-1 check above, which only fails a label omission and never
 * flags a label applied without the matching condition; this pair has no
 * pre-existing issues predating it, so there is no backward-compatibility
 * reason to keep it one-directional.
 *
 * Gated on `upstreamEscalationEnabled`: reports "not applicable" when
 * false (the resolved default), per roadmap #2700's own success
 * criterion that a repository which has not opted in "sees no behavior
 * change at all" -- this file's `audit-authored-issue` gate runs
 * unconditionally on every published body in every adopter repository
 * (`skills/issue-authoring/references/workflow-boundary.md`), so without
 * this gate a repository that never enabled the feature could still see
 * a new publish-blocking failure from an incidental `status:
 * upstream-candidate` label applied for an unrelated reason (#2721
 * review, Codex).
 *
 * Value-coherent, not presence-only (#2721 review, Copilot and Codex): a
 * marker occurrence whose value is not exactly `true`, or that appears
 * more than once (even with agreeing values -- see
 * {@link parseUpstreamCandidateMarker}), is `malformed` and is treated as
 * fail-safe *absent* rather than as "present". A malformed marker paired
 * with the label still fails (with a distinct detail), since the label
 * asserts upstream candidacy while the marker itself does not carry a
 * single coherent confirming value.
 */
function checkUpstreamCandidateMarkerLabel(
  text,
  markerPrefix,
  labels,
  upstreamEscalationEnabled,
) {
  const id = 'upstream-candidate-marker-label';
  const name = `${UPSTREAM_CANDIDATE_LABEL_NAME} label and the upstream-candidate marker agree`;
  if (!upstreamEscalationEnabled) {
    return pass(
      id,
      name,
      'not applicable: upstreamEscalation.enabled is not set for this repository',
    );
  }
  const marker = parseUpstreamCandidateMarker(text, markerPrefix);
  const hasLabel = labels.includes(UPSTREAM_CANDIDATE_LABEL_NAME.toLowerCase());
  if (marker.malformed) {
    if (hasLabel) {
      return fail(
        id,
        name,
        `${UPSTREAM_CANDIDATE_LABEL_NAME} label is present but the upstream-candidate marker is malformed (expected exactly one coherent "...: true" occurrence)`,
      );
    }
    return pass(
      id,
      name,
      'neither the label nor a coherent upstream-candidate marker is present (a malformed marker occurrence is fail-safe to absent)',
    );
  }
  const hasMarker = marker.present;
  if (hasMarker === hasLabel) {
    return pass(
      id,
      name,
      hasLabel
        ? `both the ${UPSTREAM_CANDIDATE_LABEL_NAME} label and the upstream-candidate marker are present`
        : `neither the ${UPSTREAM_CANDIDATE_LABEL_NAME} label nor the upstream-candidate marker is present`,
    );
  }
  return fail(
    id,
    name,
    hasLabel
      ? `${UPSTREAM_CANDIDATE_LABEL_NAME} label is present but the upstream-candidate marker was not found`
      : `upstream-candidate marker is present but the ${UPSTREAM_CANDIDATE_LABEL_NAME} label was not provided`,
  );
}
/**
 * Canonical parser for the authored
 * `<!-- {prefix}-upstream-candidate: true -->` marker (roadmap #2700).
 * Unlike `parseAuthoringBucketMarker` (marker-helpers.mts), which tolerates repeated
 * occurrences as long as they agree on the same valid value, this marker
 * requires exactly one occurrence -- a second, even agreeing, `...: true`
 * comment is itself malformed, mirroring {@link checkSuitabilityMarker}'s
 * `count > 1` rule rather than the bucket marker's disagreement-only one
 * (#2721 review, Copilot and Codex both independently flagged the
 * duplicate-tolerant first draft, whose own `malformed` finding detail
 * already promised "exactly one coherent ... occurrence"). Any other
 * token, a value-less occurrence, or a case mismatch (`True`/`TRUE`) is
 * malformed the same way a non-`true` value always was.
 */
function parseUpstreamCandidateMarker(text, markerPrefix) {
  const rawCount = countMarkerOccurrences(
    text,
    markerPrefix,
    'upstream-candidate',
  );
  if (rawCount === 0) {
    return { present: false, malformed: false };
  }
  if (rawCount > 1) {
    return { present: true, malformed: true };
  }
  const regex = new RegExp(
    `<!--\\s*${escapeRegex(markerPrefix)}-upstream-candidate:\\s*([^\\s>]+)\\s*-->`,
    'i',
  );
  const match = regex.exec(text);
  return { present: true, malformed: match?.[1] !== 'true' };
}
// parseAuthoringBucketMarker and isAuthoringBucketValue moved to
// marker-helpers.mts (#3289, same section as above) and are imported back
// in; parseAuthoringBucketMarker is re-exported above.
function checkMarkerPrefixConsistency(
  text,
  markerPrefix,
  upstreamEscalationEnabled,
) {
  const id = 'marker-prefix-consistency';
  const name = 'Every authoring marker uses the resolved target markerPrefix';
  // The captured prefix is compared by string equality below (never
  // re-embedded into a regex), so it only needs to exclude the characters
  // that end a marker prefix syntactically (whitespace, `:`, `>`) — not be
  // restricted to `[a-z0-9-]`. A namespaced adopter prefix may legitimately
  // contain other characters (see marker-regex.mts's escapeRegex docstring:
  // `.`, `+`, `(`, ...); a narrower class here would silently fail to match
  // any marker (right or wrong prefix) and always report a false pass.
  // The value after the suffix is optional (`\b[\s\S]*?-->`, mirroring
  // createMarkerRegex's own shape) rather than requiring a `:` — a
  // malformed, valueless, wrong-prefix marker (e.g. `<!-- other-roadmap-id
  // -->`) is still evidence of a prefix leak and must not evade this scan
  // just because it is also missing its value.
  //
  // `upstream-candidate` is excluded from the scan unless the caller's
  // resolved `upstreamEscalationEnabled` is true (#2721 review, Codex):
  // {@link checkUpstreamCandidateMarkerLabel} is itself gated the same
  // way, so a repository that never opted in treats this marker as dead
  // content -- scanning a dead marker's prefix would fire a new,
  // publish-blocking finding for a repository roadmap #2700 promises
  // "sees no behavior change at all", the same risk the pairing check's
  // own gate exists to close.
  const suffixes = upstreamEscalationEnabled
    ? AUTHORING_MARKER_SUFFIXES
    : AUTHORING_MARKER_SUFFIXES.filter(
        (suffix) => suffix !== 'upstream-candidate',
      );
  const pattern = new RegExp(
    `<!--\\s*([^\\s>:]+)-(${suffixes.join('|')})\\b[\\s\\S]*?-->`,
    'gi',
  );
  const mismatches = [];
  for (const match of text.matchAll(pattern)) {
    const foundPrefix = match[1];
    if (foundPrefix.toLowerCase() !== markerPrefix.toLowerCase()) {
      mismatches.push(`${foundPrefix}-${match[2]}`);
    }
  }
  if (mismatches.length > 0) {
    return fail(
      id,
      name,
      `marker prefix mismatch (expected "${markerPrefix}"): ${mismatches.join(', ')}`,
    );
  }
  return pass(id, name, 'all authoring markers use the resolved markerPrefix');
}
function checkRequiredHeadings(text, shape, isBucketAudit) {
  const id = 'required-headings';
  const name = `Required section headings present for the ${shape} shape`;
  if (isBucketAudit) {
    return pass(id, name, NOT_APPLICABLE_BUCKET_AUDIT_DETAIL);
  }
  const headings = extractHeadings(text);
  const missing = SHAPE_HEADING_REQUIREMENTS[shape].filter(
    (requirement) =>
      !requirement.anyOf.some((heading) => headings.has(heading)),
  );
  if (missing.length > 0) {
    return fail(
      id,
      name,
      `missing required heading(s): ${missing
        .map((requirement) => requirement.anyOf.join(' or '))
        .join('; ')}`,
    );
  }
  return pass(id, name, 'all required headings are present');
}
/**
 * Slices the `## Tracks` section's own lines out of `text` (already
 * code-masked by the caller): from the line after the `## Tracks` heading
 * up to (but excluding) the next `##` heading, or the end of the text
 * when none follows. Empty when no `## Tracks` heading is present.
 */
function extractTracksSectionLines(text) {
  const lines = text.split(/\r?\n/u);
  const headingRe = /^ {0,3}##\s+(.+?)\s*$/u;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(headingRe);
    if (match && match[1].trim() === 'Tracks') {
      start = index + 1;
      break;
    }
  }
  if (start === -1) {
    return [];
  }
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (headingRe.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}
/**
 * Roadmap-shape only (idd-skill#2765): fails when the `## Tracks` section
 * has at least one checkbox line but NONE of them resolve to a child
 * issue reference via `extractTaskListReferences` -- the same parser
 * `discover-roadmap-graph.mts`'s traversal and
 * `idd-roadmap-audit-execute.mts`'s childless gate rely on, reused here
 * rather than a second reference-matching regex. When at least one line
 * resolves but at least one other does not, this is a `severity:
 * 'warning'` pass (not a hard fail) naming the unresolved line(s), so a
 * roadmap with a genuinely mixed Tracks section still publishes with a
 * visible signal instead of being blocked outright.
 *
 * Each checkbox line is evaluated with its own continuation span (the
 * same stop rule `extractTaskListReferences` uses internally) rather
 * than diffing the parser's returned `evidence` strings against the raw
 * checkbox lines, so two textually-identical checkbox lines are scored
 * independently instead of colliding on a shared evidence string.
 */
function checkRoadmapTracksParse(text, shape, isBucketAudit, currentRepo) {
  const id = 'roadmap-tracks-parse';
  const name = 'Roadmap Tracks checkbox lines resolve to a child reference';
  if (isBucketAudit) {
    return pass(id, name, NOT_APPLICABLE_BUCKET_AUDIT_DETAIL);
  }
  if (shape !== 'roadmap') {
    return pass(
      id,
      name,
      'not applicable: only the roadmap shape has a ## Tracks section',
    );
  }
  const sectionLines = extractTracksSectionLines(text);
  const checkboxLineIndexes = sectionLines
    .map((line, index) => (isTaskListCheckboxLine(line) ? index : -1))
    .filter((index) => index >= 0);
  if (checkboxLineIndexes.length === 0) {
    return pass(id, name, 'no ## Tracks checkbox lines to validate');
  }
  // Detects a trailing qualified `owner/repo#N` reference -- `(#N)`
  // optionally wrapped in parens, with an `owner/repo` prefix -- at the
  // end of a task-list item's text, mirroring
  // `extractTaskListReferences`'s own trailing-reference shape
  // (`discover-roadmap-graph.mts`) but without requiring a
  // `currentRepoRef` match. Used only to distinguish "no reference at
  // all" from "a qualified reference exists but this run has no repo
  // context to verify it names the current repository" (idd-skill#2765
  // review, Codex) -- detection only, never itself trusted as a resolved
  // child reference. Declared inside the function (not module-level, per
  // this file's own CLI-entry-order convention -- see
  // `extractTaskListReferences`'s matching per-call regex construction in
  // `discover-roadmap-graph.mts`) so it carries no TDZ risk relative to
  // this file's `if (import.meta.main)` CLI entry block.
  const qualifiedTrailingReferenceRe =
    /(?:^|\s)\(?[\w.-]+\/[\w.-]+#\d+\)?[.,;:]*\s*$/u;
  const unparsedLines = [];
  let parsedCount = 0;
  for (const startIndex of checkboxLineIndexes) {
    let end = startIndex;
    while (
      end + 1 < sectionLines.length &&
      !isTaskListBlockBoundary(sectionLines[end + 1])
    ) {
      end += 1;
    }
    const itemText = sectionLines.slice(startIndex, end + 1).join('\n');
    const itemReferences = extractTaskListReferences(itemText, {
      currentRepoRef: currentRepo,
    });
    if (
      itemReferences.length > 0 ||
      // No repo context to verify a qualified `owner/repo#N` reference
      // against (idd-skill#2765 review, Codex): the documented local
      // invocation of this linter never passes `--current-repo`, and
      // `$GITHUB_REPOSITORY` is only set by GitHub Actions, so this is
      // the common case outside CI. `extractTaskListReferences` then
      // rejects every qualified reference because it can never equal an
      // empty current-repository value -- treat a trailing qualified
      // reference as unverifiable rather than malformed here, so a
      // well-formed roadmap using that form doesn't hard-fail merely
      // because this run lacks repo context.
      (currentRepo === undefined && qualifiedTrailingReferenceRe.test(itemText))
    ) {
      parsedCount += 1;
    } else {
      unparsedLines.push(sectionLines[startIndex].trim());
    }
  }
  if (parsedCount === 0) {
    return fail(
      id,
      name,
      `## Tracks has ${checkboxLineIndexes.length} checkbox line(s) but none resolve to a child issue reference (checked: ${unparsedLines.join(' | ')})`,
    );
  }
  if (unparsedLines.length > 0) {
    return {
      id,
      name,
      result: 'pass',
      severity: 'warning',
      detail: `## Tracks checkbox line(s) did not resolve to a child issue reference: ${unparsedLines.join(' | ')}`,
    };
  }
  return pass(
    id,
    name,
    'every ## Tracks checkbox line resolves to a child issue reference',
  );
}
function checkDependencyMarkerRule(text, rawText, markerPrefix, shape) {
  const id = 'dependency-marker-rule';
  const name = 'roadmap-id / blocked-by marker rule for the declared shape';
  const roadmapIdCount = countMarkerOccurrences(
    text,
    markerPrefix,
    'roadmap-id',
  );
  const blockedByCount = countMarkerOccurrences(
    text,
    markerPrefix,
    'blocked-by',
  );
  // A blocked-by marker missing its `: <roadmap-id>` value is invisible to
  // Discover's own extractBlockedByRoadmapMarkers, so a marker that "looks
  // present" to the author but resolves to no value would silently defeat
  // the intended dependency. Reuse that same extractor (rather than a
  // second hand-rolled value-requiring regex) to require at least one
  // well-formed value whenever a blocked-by marker is present at all,
  // wherever the shape permits the marker (roadmap, child).
  //
  // #3281 review (CodeRabbit): extractBlockedByRoadmapMarkers masks its
  // own input, so it takes rawText, never the already-masked `text` --
  // masking twice can turn a masked inline code span's replacement
  // spaces into a spurious top-level indented code block on a second
  // pass, swallowing real content on the same line. countMarkerOccurrences
  // above has no such self-masking and still needs pre-masked `text`.
  const wellFormedBlockedByCount = extractBlockedByRoadmapMarkers(
    rawText,
    markerPrefix,
  ).length;
  if (shape === 'roadmap') {
    if (roadmapIdCount !== 1) {
      return fail(
        id,
        name,
        `roadmap issues must carry exactly one roadmap-id marker, found ${roadmapIdCount}`,
      );
    }
    // A single marker occurrence can still be malformed (missing its
    // `: <roadmap-id>` value) and the loose shape-only count above would
    // not catch it. extractRoadmapMarkerId requires the value, matching
    // the same strict form Discover relies on to resolve the marker.
    // Self-masking (see the wellFormedBlockedByCount comment above), so
    // rawText here too.
    if (!extractRoadmapMarkerId(rawText, markerPrefix)) {
      return fail(
        id,
        name,
        'the roadmap-id marker is present but malformed (missing its `: <roadmap-id>` value)',
      );
    }
    if (blockedByCount > 0 && wellFormedBlockedByCount === 0) {
      return fail(
        id,
        name,
        'a blocked-by marker is present but malformed (missing its `: <roadmap-id>` value)',
      );
    }
    return pass(
      id,
      name,
      'exactly one well-formed roadmap-id marker is present',
    );
  }
  if (roadmapIdCount > 0) {
    return fail(
      id,
      name,
      `${shape} issues must not carry a roadmap-id marker, found ${roadmapIdCount}`,
    );
  }
  if (shape === 'orphan' && blockedByCount > 0) {
    return fail(
      id,
      name,
      `orphan issues must not carry a blocked-by marker, found ${blockedByCount}`,
    );
  }
  if (
    shape === 'child' &&
    blockedByCount > 0 &&
    wellFormedBlockedByCount === 0
  ) {
    return fail(
      id,
      name,
      'a blocked-by marker is present but malformed (missing its `: <roadmap-id>` value)',
    );
  }
  return pass(id, name, `no roadmap-id marker on this ${shape} issue`);
}
/**
 * `true` when `text` begins with a Markdown link whose label contains a
 * bare `#N` reference (e.g. `[#12](...)`) or whose target contains a
 * GitHub issue/PR path segment (`/issues/N` or `/pull/N`) -- the
 * "Markdown-link reference list" near-miss shape the issue describes
 * (`Blocked by [#12](https://github.com/owner/repo/issues/12)`), which
 * `hasDependencyReferenceListStart` alone does not recognize (its
 * `TOKEN_START` grammar has no Markdown-link alternative). Also
 * recognizes the reference-style form `[#12][ref]` by the same
 * label-contains-`#N` heuristic (`idd-skill#3285` final review round,
 * CodeRabbit): `Blocked by [#12][ref]` resolves no dependency under the
 * shared grammar either, so it must be caught here too, not only the
 * inline-link form.
 */
function looksLikeIssueMarkdownLink(text) {
  const inlineMatch = text.match(MARKDOWN_LINK_START_PATTERN);
  if (inlineMatch) {
    const [, label, target] = inlineMatch;
    if (/#\d+/.test(label) || /\/(?:issues|pull)\/\d+/.test(target)) {
      return true;
    }
  }
  const referenceMatch = text.match(MARKDOWN_REFERENCE_LINK_START_PATTERN);
  return referenceMatch !== null && /#\d+/.test(referenceMatch[1]);
}
/**
 * Strip, in any order and up to a few repeats, the decoration that can
 * sit between a near-miss/mid-line keyword match and its reference:
 * horizontal whitespace, an emphasis-close marker (1-3 of `*`/`_`), and a
 * colon (ASCII `:` or the full-width `：` near-miss spelling) --
 * handles `:**`, `**:`, `** :`, and a bare `:` or `：` alone, in
 * whatever order the author happened to type them.
 */
function stripDependencyLineDecoration(after) {
  let result = after;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const stripped = result
      .replace(/^[ \t]+/, '')
      .replace(/^[*_]{1,3}/, '')
      .replace(/^[:：]/, '');
    if (stripped === result) {
      break;
    }
    result = stripped;
  }
  return result;
}
/**
 * Search `line` for a near-miss or mid-line `Blocked by`/`Depends on`
 * mention: a canonical-or-near-miss-spelled keyword occurrence (anywhere
 * on the line, not just at its start -- distinguishing "near-miss" from
 * "mid-line mention" is a purely positional labeling question the issue's
 * own text does not draw a hard line on, e.g. a hidden mention inside an
 * HTML comment reads as either; both are equally a `dependency-line-grammar`
 * failure, so this function does not classify further) immediately
 * followed -- after stripping any decoration between them -- by something
 * that looks like an issue reference: a bare `#N`/qualified `owner/repo#N`
 * /GitHub-issue-URL token, or a Markdown link to an issue. Returns the
 * first match's own matched text, or `undefined` when nothing on the line
 * qualifies. Callers only reach this after confirming the shared
 * line-anchored grammar (`matchDependencyKeywordLine`) does NOT already
 * accept the line -- a fully canonical line is never re-flagged here.
 */
function findDependencyKeywordMisuse(line) {
  for (const match of line.matchAll(NEAR_MISS_DEPENDENCY_KEYWORD_PATTERN)) {
    const after = line.slice((match.index ?? 0) + match[0].length);
    const stripped = stripDependencyLineDecoration(after);
    // A leading `<` opens a CommonMark autolink (`<https://...>`) --
    // strip it before testing `hasDependencyReferenceListStart`, whose
    // own token grammar has no autolink-wrapper alternative and would
    // otherwise never recognize `Blocked by <https://github.com/owner/
    // repo/issues/12>` as reference-shaped (`idd-skill#3285` final
    // review round, CodeRabbit). The loose `TOKEN_START` test this
    // delegates to only checks what the text STARTS WITH, so the
    // autolink's own trailing `>` needs no separate handling here.
    const unwrapped = stripped.replace(/^</, '');
    if (
      hasDependencyReferenceListStart(unwrapped) ||
      looksLikeIssueMarkdownLink(stripped)
    ) {
      return match[0].trim();
    }
  }
  return undefined;
}
/**
 * #3285: fails on a `Blocked by`/`Depends on` mention that Discover's own
 * shared line-anchored grammar (`dependency-grammar.mts`, #3284) would
 * never resolve as a real dependency -- a mid-line mention (the keyword
 * appears after other prose, or hidden inside an HTML comment), a
 * near-miss line (right position, but an emphasis-wrapped keyword, a
 * hyphenated/camelCase spelling, a full-width colon, or a Markdown-link
 * reference instead of the three plain forms the grammar accepts), or a
 * cross-repository token on an otherwise well-formed line. Each of these
 * either silently produces no dependency at all (Discover's readiness
 * check finds nothing to wait on, so the issue reads as unblocked when
 * the author meant it to be blocked) or, for the cross-repo case,
 * produces a dependency Discover can never resolve (the issue stays
 * blocked forever until someone edits the line).
 *
 * Operates on masked views of the same body, each computed exactly once
 * (never per line -- re-masking a single line in isolation loses the
 * surrounding document context a structural code-block mask depends on,
 * silently mis-masking a validly indented/nested line; see
 * `matchDependencyKeywordLine`'s own doc comment):
 *
 * - `text` (already computed by the caller via `maskMarkdownForScan`
 *   with its default options -- fenced/indented/inline code masked, HTML
 *   comments left visible) is the base for the near-miss/mid-line scan
 *   below, since a hidden dependency line inside an HTML comment must
 *   stay visible to this check.
 * - `nearMissScanLines` additionally masks every well-formed
 *   `{markerPrefix}-blocked-by` sequential-roadmap marker out of `text`
 *   (#3285 review, Copilot) before the near-miss scan runs, since that
 *   marker's own grammar accepts a reference-shaped value (`#12`) and
 *   would otherwise be misread as a "blocked-by" near-miss/mid-line
 *   mention -- the two grammars are unrelated and only coincidentally
 *   share the substring "blocked-by".
 * - A second, separately masked view, masked here with
 *   `{ htmlComments: 'mask' }` -- matching `extractDependencyReferences`'s
 *   own internal masking, i.e. Discover's real view of the body -- is
 *   used to ask "does the shared grammar already accept this line", via
 *   `matchDependencyKeywordLine` (which never masks its input, so
 *   calling it per line here never re-masks).
 *
 * A line the shared grammar already accepts is only re-examined for a
 * cross-repository token (`unresolvable`, and only when `currentRepo` is
 * actually known -- see the cross-repo design note below); it is never
 * also run through the near-miss/mid-line scan.
 */
function checkDependencyLineGrammar(text, rawText, currentRepo, markerPrefix) {
  const id = 'dependency-line-grammar';
  const name =
    'Blocked by / Depends on lines use the canonical line-anchored form';
  const discoverMaskedLines = maskMarkdownForScan(rawText, {
    htmlComments: 'mask',
  }).split('\n');
  // A well-formed `<!-- {markerPrefix}-blocked-by: <value> -->` sequential-
  // roadmap marker (checkDependencyMarkerRule above) coincidentally
  // contains the literal substring "blocked-by", and its own grammar
  // (extractBlockedByRoadmapMarkers) accepts ANY non-whitespace value --
  // including one that happens to look like an issue reference (`#12`),
  // even though a roadmap-id is meant to be a descriptive slug, not a
  // reference (#3285 review, Copilot). Mask every such marker out of the
  // near-miss scan's own visible-line source before running it, so a
  // marker with a reference-shaped value is never misread as a
  // "blocked-by" near-miss/mid-line mention -- the two are unrelated
  // grammars that merely share a keyword substring. The pattern below is
  // copied verbatim from `extractBlockedByRoadmapMarkers`'s own regex
  // source (discover-readiness-check.mts) rather than hand-approximated
  // from scratch -- unlike `hasDependencyReferenceListStart`'s single
  // shared implementation, there is no common helper the two call sites
  // can both import here, since one masks-and-extracts a marker value
  // and the other only needs to blank a match, so keeping the two
  // literal regex sources in sync by inspection (not by construction) is
  // this function's own responsibility if either ever changes -- see
  // this file's own TOKEN_START comment for the general hazard of
  // independently re-deriving a shared pattern. Blanks only non-newline
  // characters, so `nearMissScanLines` keeps the exact same per-line
  // length/count as a plain `text.split('\n')` would produce, keeping
  // every other offset computation below valid.
  const blockedByMarkerPattern = new RegExp(
    `<!--\\s*${escapeRegex(markerPrefix)}-blocked-by:\\s*[^\\s>]+\\s*-->`,
    'gi',
  );
  const nearMissScanLines = text
    .replace(blockedByMarkerPattern, (match) => match.replace(/[^\n]/g, ' '))
    .split('\n');
  // Maps a 1-based accepted line number to how many trailing characters of
  // that line the shared grammar's match left unconsumed (#3285 review,
  // Copilot): the grammar recognizes at most ONE dependency declaration
  // per line, so a second, independent keyword-plus-reference mention
  // after it -- "Blocked by #12. Depends on #13" -- is not itself
  // validated by the accepted match and must still be scanned below,
  // rather than the whole line being skipped outright.
  const acceptedRemainingLength = new Map();
  const issues = [];
  for (const keyword of ['Blocked by', 'Depends on']) {
    for (let index = 0; index < discoverMaskedLines.length; index += 1) {
      const result = matchDependencyKeywordLine(
        discoverMaskedLines,
        index,
        keyword,
        { currentRepo },
      );
      if (!result) {
        continue;
      }
      const lineNo = index + 1;
      acceptedRemainingLength.set(lineNo, result.remaining.length);
      // A qualified/URL token with an invalid number lands in BOTH
      // `unresolvable` (dependency-grammar.mts preserves this for
      // Discover's own runtime consumers, which read it directly and
      // never read `invalidTokens`) and `invalidTokens` (added so this
      // audit-time check can name the real problem). Report each
      // distinct token exactly once, preferring the more specific
      // "invalid number" message over the generic "names another
      // repository" one when both apply to the same token string --
      // the latter is actively misleading for a same-repo token whose
      // only real defect is its number (#3285 final review round,
      // Copilot: a same-repo invalid-number token was previously
      // reported as if it named a different repository).
      const invalidTokenSet = new Set(result.invalidTokens);
      // Cross-repository design decision (#3285): unlike the advisory
      // prose-dependency check (which can afford to lean toward flagging
      // when currentRepo is unknown, since a false positive there only
      // prompts a double-check), this is a hard-failing check -- a false
      // positive here blocks publication outright. Mirroring
      // checkRoadmapTracksParse's own precedent (#2765 review) for the
      // same "no repo context available" situation, treat an unresolved
      // token as unverifiable, not malformed, unless currentRepo is
      // actually known and still does not match: Discover's own live run
      // (with GITHUB_REPOSITORY set) will resolve a same-repo qualified
      // reference correctly regardless of what this offline invocation
      // happened to pass.
      if (result.unresolvable.length > 0 && currentRepo !== undefined) {
        for (const token of result.unresolvable) {
          if (invalidTokenSet.has(token.token)) {
            continue;
          }
          issues.push(
            `line ${lineNo}: "${token.token}" names another repository and cannot be resolved locally -- Discover will keep this issue blocked until the line is fixed`,
          );
        }
      }
      // A bare token that matches the reference shape but resolves to a
      // non-positive/non-integer number (e.g. `#0`) is silently dropped
      // from `numbers` with no other record -- unlike a cross-repository
      // token, it never lands in `unresolvable` either. Unconditional
      // (no `currentRepo` gate): unlike the cross-repository case, this
      // is never a matter of missing repo context -- `#0` is invalid
      // regardless. A line mixing a valid and an invalid token, e.g.
      // "Blocked by #0, #12", must still fail here even though `#12`
      // alone is perfectly valid (#3285 final review round, Copilot) --
      // Discover's own runtime resolution is intentionally unaffected
      // and still resolves #12 from that same line.
      if (result.invalidTokens.length > 0) {
        for (const token of result.invalidTokens) {
          issues.push(
            `line ${lineNo}: "${token}" is not a valid issue reference (the number must be a positive integer) -- remove it or fix the number`,
          );
        }
      }
    }
  }
  for (let index = 0; index < nearMissScanLines.length; index += 1) {
    const lineNo = index + 1;
    const scanLine = nearMissScanLines[index] ?? '';
    // `discoverMaskedLines[index]` and `scanLine` are always the same
    // length (both ultimately derive from maskMarkdownForScan against the
    // same normalized rawText, which preserves length and line structure
    // regardless of which regions each call happens to mask -- marker
    // masking above only blanks non-newline characters in place, so it
    // doesn't change this either), so a trailing-character count measured
    // against the discover-masked line slices the correct suffix of
    // `scanLine` too -- re-scanning the marker-masked VISIBLE text (not
    // the discover-masked one) keeps a hidden HTML-comment mention
    // detectable the same way the no-prior-match branch below already
    // scans it, while a well-formed blocked-by marker's own "blocked-by"
    // substring stays masked out either way.
    const remainingLength = acceptedRemainingLength.get(lineNo);
    const scanText =
      remainingLength === undefined
        ? scanLine
        : scanLine.slice(scanLine.length - remainingLength);
    const misuse = findDependencyKeywordMisuse(scanText);
    if (misuse !== undefined) {
      issues.push(
        `line ${lineNo}: "${misuse}" is not a canonical Blocked by / Depends on line -- use "Blocked by #N" (or "Depends on #N") on its own line, or "Refs #N (non-blocking)" for an informational reference`,
      );
    }
  }
  if (issues.length === 0) {
    return pass(
      id,
      name,
      'every Blocked by / Depends on mention uses the canonical line-anchored form',
    );
  }
  return fail(id, name, issues.join(' | '));
}
/**
 * Child shape only (field-feedback gist round 34 finding 1,
 * kurone-kito/idd-skill#3191): a `child` issue's `## Candidate files`
 * section is required content (contract.md's "Child issue under a
 * roadmap" section), so a body that parses to zero paths -- whether the
 * heading is missing entirely or present but empty/unparseable -- must
 * not pass the mechanical pre-publish gate as a `ready` child. The one
 * exception is a child already routed away from autopilot selection via
 * an `authoring-bucket: needs-decision`/`blocked-by-human` marker or a
 * suitability score of `1`: those legitimately declare "this task does
 * not edit a repository file" and are filtered out of Discover by other
 * means (the blocking label, or the floor skip), so this check does not
 * apply to them.
 *
 * Reuses `parseCandidateFiles` (discover-shared-file-overlap.mts) against
 * the RAW, not code-masked, body: that parser's own backtick-code-span
 * detection needs the original inline-code markup this module's
 * `stripMarkdownCodeRegions` pass would otherwise erase, the same reason
 * every other body-text check in this file receives the masked `text`
 * but this one receives `rawText` instead.
 */
function checkCandidateFilesNotEmpty(
  rawText,
  shape,
  isBucketAudit,
  authoringBucket,
  suitability,
) {
  const id = 'candidate-files-not-empty';
  const name = 'Child ## Candidate files section parses to at least one path';
  if (isBucketAudit) {
    return pass(id, name, NOT_APPLICABLE_BUCKET_AUDIT_DETAIL);
  }
  if (shape !== 'child') {
    return pass(
      id,
      name,
      `not applicable: only the child shape requires ## Candidate files`,
    );
  }
  const routedToHumanBucket =
    authoringBucket.value === 'needs-decision' ||
    authoringBucket.value === 'blocked-by-human' ||
    suitability.value === 1;
  if (routedToHumanBucket) {
    return pass(
      id,
      name,
      'not applicable: issue is routed to a human bucket (authoring-bucket marker or suitability score of 1)',
    );
  }
  const candidateFiles = parseCandidateFiles(rawText);
  if (candidateFiles.length === 0) {
    return fail(
      id,
      name,
      'the ## Candidate files section parses to zero paths (heading missing, or present but empty/unparseable); a ready child cannot claim zero touched files',
    );
  }
  return pass(
    id,
    name,
    `## Candidate files parses to ${candidateFiles.length} path(s)`,
  );
}
function checkSuitabilityVisibleLineAgreement(text, markerPrefix, suitability) {
  const id = 'suitability-visible-line-agreement';
  const name =
    'Visible autopilot-suitability line agrees with the hidden marker';
  if (suitability.value === null) {
    return pass(
      id,
      name,
      'not applicable: no coherent suitability marker value',
    );
  }
  const scope = lastParagraphBeforeMarker(
    text,
    markerPrefix,
    'autopilot-suitability',
  );
  const match = /_Autopilot suitability:\s*([0-9]+)\s*\/\s*5/.exec(scope);
  if (!match) {
    return fail(
      id,
      name,
      `missing or unparsable visible autopilot-suitability line immediately preceding the marker (value ${suitability.value})`,
    );
  }
  const visibleValue = Number.parseInt(match[1], 10);
  if (visibleValue !== suitability.value) {
    return fail(
      id,
      name,
      `visible line says ${visibleValue} but the marker says ${suitability.value}`,
    );
  }
  return pass(
    id,
    name,
    `visible line agrees with marker value ${suitability.value}`,
  );
}
function checkEffortVisibleLineAgreement(text, rawText, markerPrefix) {
  const id = 'effort-visible-line-agreement';
  const name = 'Visible effort line agrees with the hidden marker';
  // parseEffortMarker requires a value token ([^\s>]+ after the colon), so
  // a value-less marker like `<!-- {prefix}-effort: -->` reads as
  // `present: false` — indistinguishable, by that field alone, from no
  // marker at all. Since effort is optional, treating that as "not
  // applicable" would let a clearly malformed footer silently pass. Use
  // the loose shape-only count to tell "genuinely absent" (0) apart from
  // "present but valueless/malformed" (>0 but not a coherent value).
  //
  // Requiring rawCount === 1 (not just > 0) also closes a second gap: a
  // body with one well-formed marker plus a second, valueless one would
  // otherwise still resolve a coherent value (parseEffortMarker's regex
  // silently ignores the valueless occurrence) and could pass by
  // coincidence of which occurrence lastParagraphBeforeMarker lands on.
  // An extra malformed occurrence must fail the check even when a
  // well-formed one is also present.
  const rawCount = countMarkerOccurrences(text, markerPrefix, 'effort');
  if (rawCount === 0) {
    return pass(id, name, 'not applicable: no effort footer (optional)');
  }
  if (rawCount > 1) {
    return fail(
      id,
      name,
      `expected at most one effort marker, found ${rawCount}`,
    );
  }
  // #3281 review (CodeRabbit): parseEffortMarker masks its own input, so
  // it takes rawText, never the already-masked `text` (see
  // checkDependencyMarkerRule's identical comment for why double-masking
  // is unsafe). countMarkerOccurrences above still needs pre-masked
  // `text`.
  const effort = parseEffortMarker(rawText, markerPrefix);
  if (!effort.present || effort.malformed || effort.value === null) {
    return fail(
      id,
      name,
      'effort marker is present but its value is not a single coherent S/M/L hint',
    );
  }
  const scope = lastParagraphBeforeMarker(text, markerPrefix, 'effort');
  const match = /_Effort:\s*([A-Za-z]+)/.exec(scope);
  if (!match) {
    return fail(
      id,
      name,
      `missing or unparsable visible effort line immediately preceding the marker (value ${effort.value})`,
    );
  }
  const visibleValue = match[1].toUpperCase();
  if (visibleValue !== effort.value) {
    return fail(
      id,
      name,
      `visible line says ${visibleValue} but the marker says ${effort.value}`,
    );
  }
  return pass(
    id,
    name,
    `visible line agrees with marker value ${effort.value}`,
  );
}
/**
 * Verify that an authoring-labeled issue carries the owner-marker/
 * publication-token trail the "Authoring label lifecycle" contract
 * (docs/issue-authoring-skill.md) requires. Not applicable (`pass`) when the
 * issue never carries the configured authoring label at all — this is a
 * forward-looking gate on newly authoring-labeled issues, never a
 * retroactive backfill requirement — or when the caller did not supply
 * `comments` (this module stays network-free; a caller not opting into
 * comment-aware checking must not see a false failure).
 */
// #2681 (sub-gap 2): a self-anchored owner marker's `anchor` is the
// issue's own real ref, but its publication marker's `anchor` was
// minted before creation, when no real anchor number existed yet -- an
// opaque placeholder that can never be made to literally equal the
// owner marker's real anchor by construction. Detect that bootstrap
// case by the publication marker's anchor *shape* instead of requiring
// textual equality to the owner marker's anchor: when the owner marker
// is self-anchored and the publication marker's anchor is not itself a
// real issue reference, accept the anchor half unconditionally. A
// publication marker that named a real (but different) anchor while its
// owner marker is self-anchored is a genuine mismatch, and a
// non-self-anchored owner marker (child issue under a real,
// already-numbered anchor) always keeps the strict literal-equality
// requirement below.
function ownerMarkerAnchorMatchesPublication(
  ownerMarker,
  publicationMarker,
  shape,
) {
  // A `child` issue is anchored to an already-numbered real parent by
  // definition -- it can never legitimately bootstrap a standalone
  // anchor, so the exemption below must never apply to it, regardless of
  // what an owner marker (forged, malformed, or otherwise) claims about
  // its own target/anchor equality (#2681 review, Codex: restricting the
  // bootstrap exemption to non-child shapes so a child audit can't use a
  // falsely self-anchored owner marker to bypass the real-anchor binding
  // the check exists to enforce). `orphan` and `roadmap` are the only
  // shapes that can be the first, self-anchored issue of a standalone
  // set.
  const ownerIsSelfAnchored =
    shape !== 'child' &&
    ownerMarker.target.toLowerCase() === ownerMarker.anchor.toLowerCase();
  if (
    ownerIsSelfAnchored &&
    !REAL_ISSUE_REFERENCE_PATTERN.test(publicationMarker.anchor)
  ) {
    return true;
  }
  return ownerMarker.anchor === publicationMarker.anchor;
}
function checkAuthoringOwnerMarkerTrail(text, markerPrefix, labels, options) {
  const id = 'authoring-owner-marker-trail';
  const name =
    'Authoring-labeled issue carries the owner-marker/publication-token trail';
  const authoringLabelName = (
    options.authoringLabelName ??
    POLICY_DEFAULTS.issueAuthoring.authoringLabelName
  )
    .trim()
    .toLowerCase();
  if (!labels.includes(authoringLabelName)) {
    return pass(
      id,
      name,
      'not applicable: issue does not carry the authoring label',
    );
  }
  const currentRepo = normalizeCurrentRepo(options.currentRepo);
  // Lowercased: GitHub owner/repo names are case-insensitive, matching the
  // normalization checkProseOnlyDependency already applies to its own
  // owner/repo comparisons (#2628 review, CodeRabbit). Every comparison
  // against currentIssueRef below lowercases its own operand to match.
  const currentIssueRef =
    currentRepo && options.issueNumber !== undefined
      ? `${currentRepo}#${options.issueNumber}`.toLowerCase()
      : undefined;
  // Validate the new-issue publication line FIRST, independent of whether
  // comment data was supplied: this half only needs the body text and the
  // `newIssue` flag, so it must not be silently skipped just because the
  // caller omitted `comments` -- a genuinely broken new-issue body (no
  // publication line at all) must not get a free pass from a missing
  // --comments-file alone (#2628 review, Codex). parseAuthoringPublicationComment
  // itself requires the marker's literal first bytes (marker-helpers.mts),
  // so no separate first-line regex is needed here.
  let publicationMarker = null;
  if (options.newIssue === true) {
    publicationMarker = parseAuthoringPublicationComment(text, markerPrefix);
    if (publicationMarker === null) {
      return fail(
        id,
        name,
        'new issue is missing a well-formed authoring-publication marker as the first line of the body',
      );
    }
  }
  if (options.comments === undefined) {
    return pass(
      id,
      name,
      publicationMarker === null
        ? 'not applicable: no comment data supplied to this check'
        : 'publication-token line present; not applicable for the owner-marker/journal checks (no comment data supplied to this check)',
    );
  }
  // Strip fenced/inline code regions before parsing, matching the same
  // stripMarkdownCodeRegions(rawText) pass auditAuthoredIssue() already
  // applies to the issue body: a pasted illustrative example wrapped in a
  // comment's own code block must not count as a real marker (#2628
  // review, CodeRabbit).
  const ownerMarkers = options.comments
    .map((comment) =>
      parseAuthoringOwnerComment(
        stripMarkdownCodeRegions(comment.body),
        markerPrefix,
      ),
    )
    .filter((marker) => marker !== null);
  const hasQualifyingOwnerMarker = ownerMarkers.some(
    (marker) =>
      AUTHORING_OWNER_QUALIFYING_MODES.has(marker.mode) &&
      // A qualifying acquire/bootstrap/resume marker targets a real issue,
      // so its body-sha256 must hash an actual body read, never `none`
      // (`none` is only ever legitimate on an anchor-only release-guard
      // marker per docs/issue-authoring-skill.md -- #2628 review, Codex).
      marker.bodySha256 !== 'none' &&
      (currentIssueRef === undefined ||
        marker.target.toLowerCase() === currentIssueRef) &&
      (publicationMarker === null ||
        (ownerMarkerAnchorMatchesPublication(
          marker,
          publicationMarker,
          options.shape,
        ) &&
          marker.set === publicationMarker.set &&
          marker.session === publicationMarker.session)),
  );
  if (!hasQualifyingOwnerMarker) {
    const targetNote =
      currentIssueRef === undefined ? '' : ', target matching this issue';
    const generationNote =
      publicationMarker === null
        ? ''
        : ", anchor/set/session matching the publication marker's generation";
    return fail(
      id,
      name,
      `no valid authoring-owner comment (mode acquire/bootstrap/resume${targetNote}${generationNote}) was found`,
    );
  }
  if (options.newIssue !== true) {
    return pass(
      id,
      name,
      'owner-marker present; not applicable for the publication-token line (not a new issue)',
    );
  }
  // publicationMarker is non-null here: newIssue === true already returned
  // above on a missing/malformed marker.
  const resolvedPublicationMarker = publicationMarker;
  if (options.journalComments === undefined) {
    return pass(
      id,
      name,
      'owner-marker and publication-token line present; not applicable for the journal cross-check (no journal comment data supplied)',
    );
  }
  // Match the FULL token tuple (target/anchor/set/session/token), not just
  // target -- an unrelated or out-of-generation journal record sharing only
  // `target` must not be accepted as evidence (#2628 review, Codex). When
  // the current issue's identity is known, also require the record's own
  // `issue` field to name it exactly: per the protocol, `issue` is resolved
  // to the real identity no later than the `member` transition, so `none`
  // at state=member-or-later is itself a protocol violation, not a
  // tolerable gap.
  const hasMatchingIntentRecord = options.journalComments.some((comment) => {
    const intent = parseAuthoringPublicationIntentComment(
      stripMarkdownCodeRegions(comment.body),
      markerPrefix,
    );
    if (
      intent === null ||
      intent.target !== resolvedPublicationMarker.target ||
      intent.anchor !== resolvedPublicationMarker.anchor ||
      intent.set !== resolvedPublicationMarker.set ||
      intent.session !== resolvedPublicationMarker.session ||
      intent.token !== resolvedPublicationMarker.token
    ) {
      return false;
    }
    if (!AUTHORING_PUBLICATION_INTENT_MEMBER_OR_LATER.has(intent.state)) {
      return false;
    }
    // issue=none is only ever valid at state=pending (docs/issue-authoring-skill.md):
    // "Append the returned identity while it remains pending, append
    // member only after the owner marker is verified" -- a member-or-later
    // record with issue=none is itself a protocol violation, regardless of
    // whether the caller happens to know the current issue's identity
    // (#2628 review, Copilot and Codex).
    if (intent.issue.toLowerCase() === 'none') {
      return false;
    }
    if (
      currentIssueRef !== undefined &&
      intent.issue.toLowerCase() !== currentIssueRef
    ) {
      return false;
    }
    return true;
  });
  if (!hasMatchingIntentRecord) {
    return fail(
      id,
      name,
      'no matching authoring-publication-intent record reaching state=member or later was found on the journal issue',
    );
  }
  return pass(
    id,
    name,
    'owner-marker, publication-token line, and journal publication-intent record are all present and well-formed',
  );
}
/**
 * Counts how many entries in `comments` are byte-exact canonical
 * renderings of `family` (#2896) and are not the single newest such match
 * within its own continuity-chain identity group (#3167: `target=` alone
 * for `authoring-owner`; `target=`+`token=` together for
 * `authoring-publication-intent`) -- mirroring the "skip the just-posted
 * comment itself" rule the hide-on-supersede sweep
 * (`skills/issue-authoring/references/contract.md`'s "Authoring hold and
 * release" section) already applies. "Newest" is the last matching entry
 * in array order, within that same identity group: callers are
 * expected to supply comments in GitHub's deterministic
 * `created_at`-then-id order. This is the first **order-dependent**
 * comment-aware check in this file -- unlike
 * {@link checkAuthoringOwnerMarkerTrail}, which uses order-independent
 * `.some()`/`.every()` scans, this function's result changes if the input
 * order changes. `AuthoringCommentInput.createdAt` is accepted but never
 * consulted here to verify or sort by ascending order; a caller that
 * supplies comments out of order gets a silently wrong count, not a
 * detected error.
 *
 * `family` is matched against the RAW `comment.body` (never
 * `stripMarkdownCodeRegions`-masked): unlike the structural checks above,
 * this count exists to mirror exactly what the live hide-on-supersede
 * sweep would find on the real, unmodified comment body -- a body this
 * function would treat as canonical only by first stripping content out
 * of it is not actually byte-exact against what
 * `matchCanonicalAuthoringMarkerFamily` would see live.
 *
 * When `trustedActors` is provided (#2896 review, Codex), a match whose
 * `comment.author` is missing or not a case-insensitive member of that
 * set is excluded from the candidate set **before** "newest" is
 * selected, not only from the eligible count: the contract states
 * "syntax alone never grants ownership" (see [Per-target
 * ownership](../../skills/issue-authoring/references/contract.md)), so
 * an untrusted-author body -- even a byte-exact canonical one -- is
 * never treated as a real marker for either purpose. An earlier
 * revision filtered trust only for eligibility, which let a trailing
 * untrusted-author match steal "newest" status from the legitimate
 * trusted marker just before it, wrongly reporting that trusted marker
 * as superseded backlog (round 2 of review, Codex: the fix for the
 * `minimize-superseded-markers.mts`/documented-sweep trust
 * requirement -- round 1 -- did not go far enough). `trustedActors` left
 * `undefined` disables this filter entirely (backward-compatible: every
 * byte-exact match counts as a candidate regardless of author, matching
 * pre-#2896-review behavior).
 *
 * A candidate match whose `isMinimized` is already `true` is excluded
 * from the eligible count -- it is not backlog, it is already handled
 * (this exclusion is unaffected by trust filtering: it applies to
 * whichever candidate set survives the trust filter above). Returns `0`
 * when `comments` is `undefined` (the caller, {@link
 * checkAuthoringMarkerMinimizationBacklog}, reports that family as "not
 * checked" rather than treating this `0` as a confirmed zero) or when
 * fewer than two (trust-filtered, when applicable) candidates exist
 * (nothing can be "superseded" without a later candidate to supersede
 * it).
 *
 * Delegates the actual classification to {@link classifyAuthoringMarkerFamily}
 * (`marker-helpers.mts`, extracted in #2935 alongside `sweep-authoring-
 * markers.mts`'s fetch-driven sweep, which needs the same
 * newest-per-(family, identity)-group/trust/already-minimized rule but
 * returns the eligible comments themselves, not just a count) -- kept as
 * a thin count-only wrapper here so this module's public surface and
 * every existing caller are
 * unaffected.
 */
function countEligibleSupersededMarkers(
  comments,
  markerPrefix,
  family,
  trustedActors,
) {
  if (comments === undefined) {
    return 0;
  }
  return classifyAuthoringMarkerFamily(
    comments,
    markerPrefix,
    family,
    trustedActors,
  ).eligibleIndexes.length;
}
/**
 * Reports how many `authoring-owner` (from {@link AuditOptions.comments})
 * and `authoring-publication-intent` (from
 * {@link AuditOptions.journalComments}) comments are eligible for the
 * hide-on-supersede sweep but not yet minimized (#2896). This is the
 * mechanical observability signal the issue-authoring contract's release-
 * time sweep depends on to make a compliance gap visible instead of
 * silent, the way #2750/#2821's original per-post-only instruction's gap
 * went unnoticed for weeks (measured 2026-09-11: 3 of 95 expected-
 * hideable comments across 22 sampled issues, about 3%).
 *
 * Always reports `result: 'pass'` -- a nonzero backlog is surfaced as a
 * `severity: 'warning'` finding, never a hard failure: the same body can
 * be re-audited at any point in an issue's lifecycle (not only
 * immediately after the Stage 2 sweep runs), and the journal issue's own
 * backlog accumulates across every authoring set that shares it, so a
 * strict fail here would block an unrelated publish on backlog this
 * session did not create. Not applicable (as a whole) when the caller
 * supplies neither `comments` nor `journalComments` -- unlike
 * `authoring-owner-marker-trail`, this check is never gated on the
 * authoring label: the backlog it counts exists (or does not) regardless
 * of whether the audited body currently carries that label.
 *
 * **Per-family "not checked" vs "checked, zero found" (#2896 review).**
 * `comments` and `journalComments` are independently optional: a caller
 * may supply only one. The `detail` text always names both families and
 * distinguishes an omitted family ("not checked") from one that was
 * supplied and found to have zero backlog ("0") -- collapsing the two
 * into a bare `0` would misreport "never actually counted" as "counted,
 * found none", which is exactly the kind of silent gap this check exists
 * to surface. `total` (and therefore whether this finding carries
 * `severity: 'warning'`) sums only the families actually checked; an
 * omitted family never contributes a phantom `0` to that sum.
 */
function checkAuthoringMarkerMinimizationBacklog(markerPrefix, options) {
  const id = 'authoring-marker-minimization-backlog';
  const name =
    'Eligible, not-yet-minimized superseded authoring-owner / authoring-publication-intent marker count';
  const ownerChecked = options.comments !== undefined;
  const intentChecked = options.journalComments !== undefined;
  if (!ownerChecked && !intentChecked) {
    return pass(
      id,
      name,
      'not applicable: neither comments nor journalComments were supplied to this check',
    );
  }
  const trustedActors =
    options.trustedMarkerActors === undefined
      ? undefined
      : new Set(
          options.trustedMarkerActors.map((actor) => actor.toLowerCase()),
        );
  const ownerBacklog = ownerChecked
    ? countEligibleSupersededMarkers(
        options.comments,
        markerPrefix,
        'authoring-owner',
        trustedActors,
      )
    : null;
  const publicationIntentBacklog = intentChecked
    ? countEligibleSupersededMarkers(
        options.journalComments,
        markerPrefix,
        'authoring-publication-intent',
        trustedActors,
      )
    : null;
  const total = (ownerBacklog ?? 0) + (publicationIntentBacklog ?? 0);
  const ownerPart = ownerChecked
    ? `authoring-owner: ${ownerBacklog}`
    : 'authoring-owner: not checked (comments not supplied)';
  const intentPart = intentChecked
    ? `authoring-publication-intent: ${publicationIntentBacklog}`
    : 'authoring-publication-intent: not checked (journalComments not supplied)';
  const trustNote =
    trustedActors === undefined
      ? ' [not author-trust-filtered: pass trustedMarkerActors for an accurate count]'
      : '';
  const breakdown = `${ownerPart}, ${intentPart}${trustNote}`;
  if (total === 0) {
    return pass(
      id,
      name,
      `no eligible, not-yet-minimized superseded marker comments found among the checked families (${breakdown})`,
    );
  }
  return {
    id,
    name,
    result: 'pass',
    severity: 'warning',
    detail: `${total} eligible, not-yet-minimized superseded marker comment(s) found among the checked families (${breakdown}) -- run the Stage 2 release-time hide-on-supersede sweep to clear the backlog`,
  };
}
// An empty or whitespace-only currentRepo (reachable via an explicit
// `--current-repo ''`, or an environment where `$GITHUB_REPOSITORY`
// resolves to an empty string) must be treated the same as it being
// unset. Without this, `currentRepo !== undefined` is true for `''`, but
// `${owner}/${repo}` built from a regex match is never empty, so it can
// never equal `''` — every full-URL/cross-repo-shorthand match would then
// be silently treated as "known and different" (cross-repo) and excluded,
// even when the reference is actually local. Returning the *trimmed*
// value (not the original) when it is non-empty is a free, strictly more
// correct bonus: a currentRepo with stray leading/trailing whitespace
// would otherwise never case-insensitively equal a match's own untrimmed
// `owner/repo` either.
function normalizeCurrentRepo(currentRepo) {
  if (currentRepo === undefined) {
    return undefined;
  }
  const trimmed = currentRepo.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
function checkProseOnlyDependency(text, rawText, currentRepo) {
  const id = 'prose-dependency';
  const name =
    'Advisory: issue/PR references near coordination language should use a dependency marker';
  // Numbers already covered by a real machine-readable dependency encoding
  // (Blocked by / Depends on / task-list / the non-blocking Refs form,
  // #2236) are never flagged, regardless of nearby prose — the whole point
  // of this check is to catch references that carry *no* such encoding.
  //
  // #3281 review (CodeRabbit): all three extractors mask their own
  // input, so they take rawText, never the already-masked `text` below
  // -- a masked inline code span's replacement spaces can read as a
  // fresh top-level indented code block to a second masking pass,
  // silently dropping a real `Refs #N (non-blocking)` reference (or any
  // other encoding) that follows it on the same line. `text` stays the
  // input for the sentence-proximity scan below, which needs
  // already-masked prose, not a self-masking extractor.
  const encoded = new Set([
    ...extractBlockedByIssueNumbers(rawText, currentRepo),
    ...extractDependencyIssueNumbers(rawText, currentRepo),
    ...extractNonBlockingReferenceIssueNumbers(rawText),
  ]);
  const keywordPattern = new RegExp(
    `\\b(?:${PROSE_DEPENDENCY_KEYWORDS.map(escapeRegex).join('|')})\\b`,
    'i',
  );
  const flagged = new Set();
  // Resolve reference-style Markdown links (`[text][ref]` + a separate
  // `[ref]: target` definition elsewhere in the body) to the equivalent
  // inline-link shape before splitting into paragraphs/sentences, so the
  // existing Markdown-link alternative below — and its currentRepo /
  // trailing-content handling — recognizes it with no duplicated matching
  // logic. Scoped to this check only; other checks keep using `text`.
  const resolvedText = resolveReferenceStyleLinks(text);
  for (const paragraph of splitIntoParagraphs(resolvedText)) {
    for (const sentence of splitIntoSentences(paragraph)) {
      // Scope proximity to one sentence, not the whole paragraph: a long
      // paragraph can legitimately combine an unrelated coordination word
      // with a pure breadcrumb reference (e.g. "Part of roadmap (#1386)."
      // followed by an unrelated "... before it correctly held ..." later
      // in the same paragraph). Paragraph-level scoping would falsely flag
      // the breadcrumb; sentence-level scoping does not.
      if (!keywordPattern.test(sentence)) {
        continue;
      }
      for (const match of sentence.matchAll(ISSUE_OR_PR_REFERENCE_PATTERN)) {
        const [
          ,
          linkOwner,
          linkRepo,
          linkNumber,
          bareNumber,
          urlOwner,
          urlRepo,
          urlNumber,
          shorthandOwner,
          shorthandRepo,
          shorthandNumber,
        ] = match;
        // Whichever of the two URL-bearing alternatives matched (a
        // Markdown-link target or a bare URL) supplies the owner/repo/number
        // trio; only one of the two can be present for a given match. A URL
        // match with a known currentRepo that points elsewhere is a
        // cross-repo reference: the Blocked by / Depends on markers this
        // check recommends are inherently local, so flagging it here would
        // be actively misleading rather than merely a nuisance false
        // positive. Skip it entirely — for the Markdown-link alternative,
        // this also discards any bare `#N` the link's own label repeated,
        // since that label text was consumed as part of this same match and
        // never separately visited by the bare-`#` alternative. When
        // currentRepo is unknown, keep the prior behavior of flagging a
        // full-URL match by default rather than guessing — though, like
        // any match, it is still suppressed below if its number coincides
        // with one already captured by a local Blocked-by/Depends-on/
        // task-list marker elsewhere in the body.
        const owner = linkOwner ?? urlOwner;
        const repo = linkRepo ?? urlRepo;
        if (
          owner !== undefined &&
          currentRepo !== undefined &&
          `${owner}/${repo}`.toLowerCase() !== currentRepo.toLowerCase()
        ) {
          continue;
        }
        // The owner/repo#N shorthand alternative uses the *opposite*
        // default from the URL-bearing alternatives above: it is excluded
        // unless currentRepo is both known and a case-insensitive match.
        // Unlike a full URL (which was always flaggable pre-#1399), this
        // shorthand was never recognized at all before this alternative
        // existed, so there is no prior "flag by default" behavior to
        // preserve when locality can't be confirmed — see the
        // `currentRepo` JSDoc on `AuditOptions`.
        if (
          shorthandOwner !== undefined &&
          (currentRepo === undefined ||
            `${shorthandOwner}/${shorthandRepo}`.toLowerCase() !==
              currentRepo.toLowerCase())
        ) {
          continue;
        }
        const numberText =
          bareNumber ?? linkNumber ?? urlNumber ?? shorthandNumber;
        const number = Number.parseInt(numberText, 10);
        if (!encoded.has(number)) {
          flagged.add(number);
        }
      }
    }
  }
  if (flagged.size === 0) {
    return pass(
      id,
      name,
      'no unencoded issue/PR reference found near coordination language',
    );
  }
  const refs = [...flagged]
    .sort((left, right) => left - right)
    .map((number) => `#${number}`)
    .join(', ');
  return {
    id,
    name,
    result: 'pass',
    severity: 'warning',
    detail:
      `possible prose-only dependency on ${refs} — convert to a Blocked ` +
      'by / Depends on marker, or confirm this is a breadcrumb reference ' +
      'only',
  };
}
// CommonMark reference labels are compared case-insensitively after
// collapsing internal whitespace and trimming, so `[Upstream PR]` and
// `[upstream  pr]` refer to the same definition.
function normalizeLinkReferenceLabel(label) {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}
// CommonMark §6.6 allows a reference definition's destination to be
// wrapped in angle brackets (`[ref]: <https://...>`), captured verbatim
// (brackets included) by LINK_REFERENCE_DEFINITION_PATTERN's `\S+`.
// Without unwrapping, resolveReferenceStyleLinks would rewrite a usage to
// `[text](<https://...>)`, which ISSUE_OR_PR_REFERENCE_PATTERN's
// Markdown-link alternative does not recognize (it expects the URL
// immediately after the opening paren, no angle brackets) — silently
// leaving the reference-style link unresolved and re-leaking the label's
// bare `#N` to the bare-`#` alternative, the same failure mode item 1
// exists to prevent.
function unwrapAngleBracketDestination(target) {
  return target.startsWith('<') && target.endsWith('>')
    ? target.slice(1, -1)
    : target;
}
/**
 * Resolves every `[text][ref]` reference-style link usage in `text`
 * against its `[ref]: target` definition — which may appear anywhere else
 * in the document, commonly far from the usage — by rewriting the usage
 * to the equivalent inline-link shape `[text](target)`. A usage whose ref
 * does not resolve to any definition is left unchanged: it falls through
 * to the bare-`#` alternative like any other unrecognized bracket shape,
 * the same fallback that already applies today. Duplicate labels keep the
 * first definition, matching CommonMark's rule for duplicate link
 * reference definitions.
 */
function resolveReferenceStyleLinks(text) {
  const definitions = new Map();
  for (const match of text.matchAll(LINK_REFERENCE_DEFINITION_PATTERN)) {
    const key = normalizeLinkReferenceLabel(match[1]);
    if (!definitions.has(key)) {
      definitions.set(key, unwrapAngleBracketDestination(match[2]));
    }
  }
  if (definitions.size === 0) {
    return text;
  }
  return text.replace(
    REFERENCE_STYLE_LINK_USAGE_PATTERN,
    (whole, label, ref) => {
      const target = definitions.get(normalizeLinkReferenceLabel(ref));
      return target === undefined ? whole : `[${label}](${target})`;
    },
  );
}
// Exactly one blank line between two lines of content is two newline
// characters (the left line's own terminator, then the blank line's
// own terminator). Two or more blank lines means three or more, which
// splitIntoParagraphs deliberately treats as a harder break -- see its
// own doc comment.
function isSingleBlankLine(separator) {
  return (separator.match(/\n/g)?.length ?? 0) === 2;
}
// Once any list-item marker line appears in a blank-line-free run of
// text, only a *later* marker line can close its node in
// splitIntoListItemBlocks's own stack bookkeeping (a continuation line
// never does). So, structurally, the *last* marker line anywhere in such
// a run is necessarily still open at the run's end, and that marker's
// own indentation is a cheap proxy for "the indentation of whatever node
// is still open right before the blank line" -- without re-running the
// full ancestry-stack simulation just to find out.
//
// That structural fact is not the same as the list still being open in
// the Markdown a human reader sees, though (found on this PR's own
// review, Codex): a marker followed by unindented plain prose --
// `- Before merging\n  - child\nIndependent prose` -- reads as the list
// having ended before the blank line, even though the algorithm's stack
// still shows a node open (the trailing prose is a continuation line
// attached via the ancestry walk, not a marker, so nothing closes it).
// CommonMark's own lazy-continuation rule technically disagrees --
// "Independent prose" is absorbed into "child"'s own paragraph rather
// than ending the list -- but that is a well-known surprising edge case
// that misleads readers (this PR's own Codex review included) far more
// often than it helps them, so this heuristic follows the visual
// reading over the stricter spec rule. Bridging across the blank line
// in that shape would scope "Before" onto a reference in the next chunk
// that a human author would not expect it to reach. Rather than trying
// to fully re-derive CommonMark's real list-termination semantics,
// require the last marker line to *be* the run's last line -- any
// trailing continuation line makes "is this list still open" ambiguous
// enough that refusing to bridge (a missed advisory, not a false one)
// is the safer default, matching the same
// prefer-a-miss-over-a-false-positive stance the indentation guard below
// already takes for a too-deep right-hand marker.
//
// Returns undefined when `text` has no marker line at all, or when a
// continuation line follows the last marker line.
function lastListItemMarkerIndent(text) {
  const lines = text.split('\n');
  let lastMarkerIndex = -1;
  let lastMarkerIndent;
  for (let index = 0; index < lines.length; index += 1) {
    const marker = LIST_ITEM_MARKER_PATTERN.exec(lines[index]);
    if (marker !== null) {
      lastMarkerIndex = index;
      lastMarkerIndent = indentColumnWidth(marker[1]);
    }
  }
  return lastMarkerIndex === lines.length - 1 ? lastMarkerIndent : undefined;
}
// Two adjacent blank-line-delimited chunks bridge into one loose-list
// paragraph only when the right chunk's first marker is no deeper than
// whatever is still open at the end of the left chunk -- a same-depth
// sibling continuation, or a resumption at a shallower ancestor's own
// level, both legitimate loose-list shapes that splitIntoListItemBlocks's
// existing same-or-shallower sibling-closing logic already re-separates
// correctly when they are not actually related. A *strictly deeper*
// right-hand marker is refused: bridging it would invent a parent/child
// relationship across a blank line the source never expressed -- for
// example a punctuation-free, keyword-bearing checklist item directly
// followed by an unrelated, more-indented bullet, which would otherwise
// flatten into one false-positive "sentence" (see #1476).
function isBridgeableLooseListBoundary(left, separator, right) {
  if (!isSingleBlankLine(separator)) {
    return false;
  }
  const leftTailIndent = lastListItemMarkerIndent(left);
  if (leftTailIndent === undefined) {
    return false;
  }
  const rightMarker = LIST_ITEM_MARKER_PATTERN.exec(right.split('\n')[0] ?? '');
  return (
    rightMarker !== null && indentColumnWidth(rightMarker[1]) <= leftTailIndent
  );
}
/**
 * Splits `text` into paragraphs the same way as `text.split(/\n\s*\n/)`,
 * except that two adjacent blank-line-delimited chunks are re-joined
 * into one paragraph when the blank line between them sits inside what
 * reads as a single loose Markdown list (see `isBridgeableLooseListBoundary`
 * and #1476). Without this, a loose list -- its sibling items separated
 * by a blank line, which is ordinary, valid CommonMark -- silently loses
 * every earlier sibling's ancestor-scoped coordination language the
 * moment `splitIntoListItemBlocks` runs on each paragraph independently.
 *
 * The blank line itself is preserved verbatim in the merged text rather
 * than dropped: `splitIntoListItemBlocks` treats it like any other
 * continuation line (no marker of its own), which never closes a node,
 * so it is inert other than contributing a single collapsed space once
 * `splitIntoSentences` later flattens the block.
 *
 * Merge decisions fold left-to-right against the *running accumulator*,
 * not the original first chunk, so a loose list of three or more sibling
 * items (blank line before the second, blank line before the third, and
 * so on) keeps bridging correctly -- each decision re-derives the
 * accumulator's own trailing indentation from whatever has already been
 * merged in.
 */
function splitIntoParagraphs(text) {
  const parts = text.split(/(\n\s*\n)/);
  const paragraphs = [];
  let current = parts[0] ?? '';
  for (let index = 1; index < parts.length; index += 2) {
    const separator = parts[index] ?? '';
    const next = parts[index + 1] ?? '';
    if (isBridgeableLooseListBoundary(current, separator, next)) {
      current += separator + next;
    } else {
      paragraphs.push(current);
      current = next;
    }
  }
  paragraphs.push(current);
  return paragraphs;
}
/**
 * Split a paragraph into sentences on `.`/`!`/`?` followed by whitespace,
 * after collapsing internal newlines to spaces (so a sentence that wraps
 * across a Markdown soft line break is still scoped as one sentence). This
 * is intentionally simple — good enough to separate two independent
 * clauses sharing one paragraph, not a full natural-language sentence
 * boundary detector.
 *
 * Markdown list items are treated as hard sentence boundaries first,
 * *before* that whitespace-collapsing step: a tight list (items with no
 * blank line between them) is one `\n\s*\n`-delimited "paragraph" to the
 * caller, so collapsing every newline to a space would otherwise merge
 * separate bullets that lack terminal punctuation into a single
 * "sentence" — reintroducing exactly the false-positive risk this
 * sentence-level scoping exists to avoid (e.g. a pure breadcrumb bullet
 * conflated with a sibling bullet's unrelated coordination language).
 */
function splitIntoSentences(paragraph) {
  return splitIntoListItemBlocks(paragraph).flatMap((block) => {
    const flattened = block.replace(/\s+/g, ' ').trim();
    return flattened.length === 0 ? [] : flattened.split(/(?<=[.!?])\s+/);
  });
}
// CommonMark expands a tab to the next column that is a multiple of 4
// when it participates in block structure (e.g. list-item indentation),
// rather than counting as a single character. Comparing raw
// `.length` would undercount a tab-indented marker's effective depth,
// wrongly treating a tab-indented nested child as shallower than (or
// equal to) a same-or-deeper space-indented parent and starting a new
// block instead of keeping the child scoped with its parent — the same
// loss-of-parent-scope splitIntoListItemBlocks exists to prevent, just
// triggered by mixed tab/space indentation instead of an indentation
// depth mismatch.
function indentColumnWidth(indent) {
  let column = 0;
  for (const char of indent) {
    column = char === '\t' ? (Math.floor(column / 4) + 1) * 4 : column + 1;
  }
  return column;
}
function lineIndentColumn(line) {
  return indentColumnWidth(LEADING_WHITESPACE_PATTERN.exec(line)?.[0] ?? '');
}
/**
 * Split a paragraph into blocks at each Markdown list item boundary, while
 * still joining a soft-wrapped continuation line (one with no list marker
 * of its own) onto the item it continues. A paragraph with no list items
 * at all yields exactly one block spanning every line, preserving prior
 * behavior for plain prose.
 *
 * Tracks a full indentation-ancestry stack of open `ListItemNode`s rather
 * than a single most-recently-seen marker indentation (see issue #1474):
 * a marker line strictly *deeper* than the stack's top is pushed as a new
 * child node, nested under it. A marker at the *same or shallower*
 * indentation pops nodes off the stack — closing each one — until the top
 * is strictly shallower (or the stack empties), then pushes the new
 * marker as a fresh node at that level.
 *
 * Closing a node emits it as its own block *only when it never acquired a
 * child* (a leaf): the block is that leaf's still-open ancestors' own
 * lines (root through parent, in document order) followed by the leaf's
 * own lines. A node that did acquire a child is never emitted standalone
 * — its own lines already appear as the ancestor prefix of every one of
 * its descendant leaf blocks, so nothing is lost. Net effect: every
 * root-to-leaf path down the tree emits exactly one block containing
 * every node on that path, and every node lies on at least one such path.
 * That scopes a parent bullet's coordination language together with
 * *every* nested child's reference at any depth — not only the first
 * child under a given parent, fixing the residual gap #1472 left behind
 * — while same-depth sibling bullets never share a leaf block with each
 * other, preserving the original tight-list sentence-conflation fix this
 * function exists for.
 *
 * Lines seen before any node has opened (a plain-prose preamble, or an
 * entire paragraph with no markers at all) accumulate in a separate
 * `preamble` buffer rather than the stack — there is no ancestor above
 * pre-first-marker prose to scope it with. `preamble` is flushed as its
 * own standalone block as soon as the first marker line opens a node
 * (preserving the existing behavior that leading prose never merges with
 * the first list item), or as the paragraph's sole block if no marker
 * ever appears.
 *
 * Two further gaps in the same area, both distinct from the
 * marker-ancestry scoping above, were closed by #1476: a continuation
 * line resuming at an ancestor's own indentation after a deeper child
 * has already opened is now attributed to that ancestor rather than the
 * deepest open child (see the ancestry walk in the continuation-line
 * branch below, using `lineIndentColumn`), and a loose list — sibling
 * items separated by a blank line — no longer resets scope at the
 * paragraph boundary, because its caller (`checkProseOnlyDependency`)
 * now bridges a single blank line between two loose-list chunks via
 * `splitIntoParagraphs` before this function ever runs.
 */
function splitIntoListItemBlocks(paragraph) {
  const blocks = [];
  const stack = [];
  let preamble = [];
  const closeNode = (node) => {
    if (node.hasChild) {
      return;
    }
    const ancestorLines = stack.flatMap((ancestor) => ancestor.lines);
    blocks.push([...ancestorLines, ...node.lines].join('\n'));
  };
  for (const line of paragraph.split('\n')) {
    const marker = LIST_ITEM_MARKER_PATTERN.exec(line);
    const indent = marker === null ? null : indentColumnWidth(marker[1]);
    if (indent === null) {
      // Continuation line: attach to the deepest open node whose own
      // indentation is strictly less than this line's own indentation --
      // the innermost node this line still reads as nested inside of. A
      // continuation at or above an already-open child's own marker
      // indentation is not deep enough to be that child's content; walk
      // up the ancestry until a strictly shallower owner is found,
      // falling back to the shallowest (root) node when none is
      // strictly shallower (#1476: this is what lets a continuation
      // that resumes at an ancestor's own indentation, after a deeper
      // child already opened, land on that ancestor instead of
      // unconditionally on the deepest open child). A continuation
      // genuinely deeper than every open node still resolves at the
      // first (deepest) comparison, so the normal, unambiguous case is
      // unchanged. When no node is open yet, keep attaching to the
      // pre-first-marker preamble.
      const top = stack.at(-1);
      if (top === undefined) {
        preamble.push(line);
        continue;
      }
      const ownIndent = lineIndentColumn(line);
      const owner =
        stack.findLast((node) => node.indent < ownIndent) ?? stack[0];
      owner.lines.push(line);
      continue;
    }
    // A same-or-shallower marker closes every open node at this depth or
    // deeper — one level at a time — before the new marker starts its own
    // node, mirroring the original single-value comparison per stack
    // level instead of once against a single flattened scalar.
    for (
      let top = stack.at(-1);
      top !== undefined && indent <= top.indent;
      top = stack.at(-1)
    ) {
      stack.pop();
      closeNode(top);
    }
    const parent = stack.at(-1);
    if (parent !== undefined) {
      parent.hasChild = true;
    } else if (preamble.length > 0) {
      blocks.push(preamble.join('\n'));
      preamble = [];
    }
    stack.push({ indent, lines: [line], hasChild: false });
  }
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
    stack.pop();
    closeNode(top);
  }
  if (preamble.length > 0) {
    blocks.push(preamble.join('\n'));
  }
  return blocks;
}
// countMarkerOccurrences moved to marker-helpers.mts (#3289, same section
// as above) and is imported back in.
/**
 * The text of the last paragraph (block separated by a blank line) that
 * appears before the LAST occurrence of the `{markerPrefix}-{suffix}`
 * marker in `text`. Used to scope the visible-line/hidden-marker
 * agreement checks to the footer's own paragraph, per the contract's
 * "visible line + hidden marker, paired as one footer" shape — so a
 * visible-line-shaped string elsewhere in the body (e.g. inside a pasted
 * template/example snippet) cannot satisfy the check for a footer whose
 * real visible line is missing or different. Returns '' when the marker
 * is not found.
 */
function lastParagraphBeforeMarker(text, markerPrefix, suffix) {
  const base = createMarkerRegex(markerPrefix, suffix);
  const global = new RegExp(base.source, `${base.flags}g`);
  let lastIndex = -1;
  for (const match of text.matchAll(global)) {
    lastIndex = match.index;
  }
  if (lastIndex < 0) {
    return '';
  }
  // Trim trailing whitespace first: `before` ends exactly at the blank-line
  // separator that precedes the marker, so an untrimmed split would yield
  // an empty trailing paragraph instead of the visible-line paragraph.
  const before = text.slice(0, lastIndex).replace(/\s+$/, '');
  const paragraphs = before.split(/\n\s*\n/);
  return paragraphs.at(-1) ?? '';
}
function extractHeadings(text) {
  const headings = new Set();
  // CommonMark/GitHub Markdown allow up to 3 leading spaces before an ATX
  // heading (the same tolerance stripMarkdownCodeRegions already applies to
  // fence openers), so a slightly-indented "   ## Background" must still
  // count as a real heading.
  for (const match of text.matchAll(/^ {0,3}##\s+(.+?)\s*$/gm)) {
    headings.add(match[1].trim());
  }
  return headings;
}
// normalizeMarkerPrefix moved to marker-helpers.mts (#3289, same section
// as above) and is imported back in and re-exported above.
function pass(id, name, detail) {
  return { id, name, result: 'pass', detail };
}
function fail(id, name, detail) {
  return { id, name, result: 'fail', detail };
}
/**
 * Read and JSON-parse a comments file (an array of
 * `{body, author?, createdAt?, isMinimized?}` objects) the same
 * uncaught-throw-on-malformed-input way `--body-file` already behaves: a
 * missing file or invalid JSON propagates as an unhandled exception
 * rather than a new soft-degrade path this file does not otherwise have.
 */
function readCommentsFile(path) {
  const raw = readFileSync(resolve(process.cwd(), path), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of comments`);
  }
  return parsed.map((entry, index) => {
    const record = entry;
    if (typeof record?.body !== 'string') {
      throw new Error(`${path}[${index}] is missing a string "body" field`);
    }
    return {
      body: record.body,
      ...(typeof record.author === 'string' ? { author: record.author } : {}),
      ...(typeof record.createdAt === 'string'
        ? { createdAt: record.createdAt }
        : {}),
      ...(typeof record.isMinimized === 'boolean'
        ? { isMinimized: record.isMinimized }
        : {}),
    };
  });
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.shape || !isIssueShape(args.shape)) {
    fail_(`--shape is required and must be one of orphan|roadmap|child`);
  }
  if (!args.bodyFile && !args.stdin) {
    fail_('either --body-file <path> or --stdin is required');
  }
  if (args.bodyFile && args.stdin) {
    fail_('choose only one of --body-file or --stdin');
  }
  const bodyText = args.stdin
    ? readFileSync(0, 'utf8')
    : readFileSync(resolve(process.cwd(), args.bodyFile), 'utf8');
  if (args.issue !== undefined && !/^[1-9]\d*$/.test(args.issue)) {
    fail_('--issue must be a positive integer');
  }
  if (
    args.expectBucket !== undefined &&
    !isAuthoringBucketValue(args.expectBucket)
  ) {
    fail_('--expect-bucket must be needs-decision or blocked-by-human');
  }
  // #2896 review: --journal-comments-file no longer requires --new-issue.
  // It used to (the only consumer was the new-issue publication-intent
  // cross-check), but authoring-marker-minimization-backlog also reads
  // journalComments unconditionally, and that check's whole point is to
  // run at Stage 2 release on an already-published (never new) issue --
  // requiring --new-issue here made the CLI unable to reach the exact
  // invocation shape the issue-authoring contract's release-time sweep
  // documents. Dropping this gate does not change
  // authoring-owner-marker-trail's own behavior: it already no-ops the
  // journal cross-check whenever --new-issue is absent (`options.newIssue
  // !== true` returns early before journalComments is ever read), so
  // journalComments passed without --new-issue is simply unused by that
  // check, exactly as before.
  //
  // #2896 review (round 3, Codex): --journal-comments-file also no longer
  // requires --comments-file. It used to (#2628 review, Copilot): without
  // --comments-file, authoring-owner-marker-trail's journal cross-check
  // was unreachable, so journal data alone would go unconsulted by that
  // ONE check -- but that check already reports "not applicable" (never a
  // false compliant pass) whenever --comments-file is absent, with or
  // without this gate, and authoring-marker-minimization-backlog's own
  // publication-intent half now consults journalComments completely on
  // its own. Requiring --comments-file here made the CLI advertise
  // "--comments-file and/or --journal-comments-file" in its own --help
  // text while actually rejecting the journal-only half of that "or".
  // Without this, a new-issue check with real owner-marker evidence but no
  // journal data would report "not applicable" for the journal half and
  // still exit 0 -- a misleading success for the AC's combined
  // publication-line + journal-record requirement (#2628 review,
  // CodeRabbit). The pure auditAuthoredIssue() function itself keeps the
  // graceful not-applicable degradation for a direct (non-CLI) caller that
  // deliberately wants a partial check.
  if (args.newIssue && args.commentsFile && !args.journalCommentsFile) {
    fail_('--new-issue with --comments-file requires --journal-comments-file');
  }
  // Without a known current-issue identity, the journal cross-check cannot
  // verify a publication-intent record actually names THIS issue -- an
  // intent record naming a different (non-none) issue would otherwise pass
  // silently whenever the caller omitted --issue (#2628 review, Codex).
  if (args.newIssue && args.journalCommentsFile && args.issue === undefined) {
    fail_('--new-issue with --journal-comments-file requires --issue');
  }
  // Explicit --current-repo wins; otherwise fall back to the
  // GITHUB_REPOSITORY env var GitHub Actions sets automatically, so CI
  // usage narrows cross-repo URL false positives with no extra flag.
  // undefined (neither present) keeps the pre-#1399-fix default of
  // flagging every full-URL reference for the prose-dependency check --
  // but --issue's target match needs a resolvable repo to mean anything,
  // so require one explicitly rather than silently widening the match
  // (#2628 review, Codex and Copilot both flagged the silent-widening gap).
  const currentRepo = args.currentRepo ?? process.env.GITHUB_REPOSITORY;
  if (args.issue !== undefined && !currentRepo) {
    fail_('--issue requires --current-repo (or $GITHUB_REPOSITORY) to be set');
  }
  const policy = loadPolicy(args.configPath);
  const markerPrefix = args.markerPrefix ?? policy.markerPrefix;
  // Same flag/env/config precedence every other resolveTrustedMarkerActors
  // caller in this codebase uses (#2896 review, Codex): an empty
  // resolution (no flag/env/config trusted actors configured) leaves
  // authoring-marker-minimization-backlog's trust filter disabled, the
  // same as omitting --trusted-marker-logins entirely.
  const { actors: trustedMarkerActors } = resolveTrustedMarkerActors({
    flagValue: args.trustedMarkerLogins ?? '',
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config: policy.rawConfig,
  });
  const report = auditAuthoredIssue(bodyText, {
    shape: args.shape,
    markerPrefix,
    title: args.title,
    labels: args.labels,
    blockedByHumanLabelName: policy.blockedByHumanLabelName,
    needsDecisionLabelName: policy.needsDecisionLabelName,
    expectedAuthoringBucket: args.expectBucket,
    authoringLabelName: policy.authoringLabelName,
    currentRepo,
    issueNumber:
      args.issue !== undefined ? Number.parseInt(args.issue, 10) : undefined,
    comments: args.commentsFile
      ? readCommentsFile(args.commentsFile)
      : undefined,
    journalComments: args.journalCommentsFile
      ? readCommentsFile(args.journalCommentsFile)
      : undefined,
    newIssue: args.newIssue,
    upstreamEscalationEnabled: policy.upstreamEscalationEnabled,
    // An empty resolution (no flag/env/config trusted actors found) is
    // "trust unknown," not "no one is trusted" -- pass `undefined` so
    // authoring-marker-minimization-backlog's trust filter stays
    // disabled (permissive) rather than zeroing out every count.
    trustedMarkerActors:
      trustedMarkerActors.length > 0 ? trustedMarkerActors : undefined,
  });
  writeReport(report, args.format);
  return report.passed ? 0 : 1;
}
function isIssueShape(value) {
  return value === 'orphan' || value === 'roadmap' || value === 'child';
}
/**
 * Deliberate exception (#1721): every sibling `*.mts` `loadPolicy()` throws
 * on an explicit path that cannot be read or parsed (converged through
 * idd-config.mts's `loadPolicyConfig`). This one does not: `main()` may
 * still apply `--marker-prefix` on top of the value this returns, so an
 * unreadable `--config` here does not necessarily mean the invocation is
 * under-specified — hard-failing would reject an invocation that is
 * actually fully specified. This function still calls the same shared
 * `loadPolicyConfig()` reader every sibling routes through for the
 * read-and-parse step, and catches its throw itself right here to keep
 * this warn-and-continue contract instead of propagating it.
 */
function loadPolicy(configPath) {
  // Default path: reuse the shared loadIddConfig() (idd-config.mts) rather
  // than a second "readFileSync + JSON.parse, null on error" copy of the
  // exact pattern it was extracted from (see that module's header, #1208).
  // loadIddConfig() always reads '.github/idd/config.json' relative to cwd
  // and has no path parameter, so an explicit --config override instead
  // goes through loadPolicyConfig() below (caught locally, see doc comment
  // above).
  let config;
  if (configPath) {
    try {
      config = loadPolicyConfig(configPath).config;
    } catch (error) {
      // Stay fail-safe (never hard-crash on a bad config, unlike every
      // sibling *.mts loadPolicy()), but surface an explicit --config that
      // could not be read/parsed: silently validating against the wrong
      // policy would be a confusing, hard-to-notice false pass/fail.
      //
      // Describe this as loadPolicy's own fallback, not the audit's final
      // effective markerPrefix: main() still applies --marker-prefix on
      // top of this return value when the operator passed it, so naming a
      // specific value here (e.g. DEFAULT_MARKER_PREFIX) could mislead
      // when that flag is also present. The report's own markerPrefix
      // field is the authoritative source for the value actually used.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `warning: could not read or parse --config ${configPath}; falling back to default policy unless overridden by --marker-prefix (see the report's markerPrefix field for the effective value): ${message}`,
      );
      config = null;
    }
  } else {
    config = loadIddConfig();
  }
  if (!config) {
    return {
      markerPrefix: DEFAULT_MARKER_PREFIX,
      blockedByHumanLabelName: POLICY_DEFAULTS.labels.blockedByHumanLabelName,
      needsDecisionLabelName: POLICY_DEFAULTS.labels.needsDecisionLabelName,
      authoringLabelName: POLICY_DEFAULTS.issueAuthoring.authoringLabelName,
      upstreamEscalationEnabled: false,
      rawConfig: null,
    };
  }
  return {
    markerPrefix: normalizeMarkerPrefix(config.markerPrefix),
    blockedByHumanLabelName:
      normalizePolicyConfig(config).labels.blockedByHumanLabelName,
    needsDecisionLabelName:
      normalizePolicyConfig(config).labels.needsDecisionLabelName,
    authoringLabelName:
      normalizePolicyConfig(config).issueAuthoring.authoringLabelName,
    upstreamEscalationEnabled: isUpstreamEscalationEnabled(config),
    rawConfig: config,
  };
}
function writeReport(report, format) {
  if (format === 'table') {
    console.log(
      `shape=${report.shape} markerPrefix=${report.markerPrefix} passed=${report.passed}`,
    );
    console.log(['id', 'result', 'severity', 'detail'].join('\t'));
    for (const finding of report.findings) {
      console.log(
        [
          finding.id,
          finding.result,
          finding.severity ?? '',
          finding.detail,
        ].join('\t'),
      );
    }
    return;
  }
  console.log(`${JSON.stringify(report, null, 2)}\n`);
}
function parseArgs(argv) {
  // No test in this file asserts the pre-migration message text or the
  // no-colon "unknown argument X" / "X requires a value" spelling (see
  // #1451's PR description), so a parse failure adopts the wrapper's
  // uniform message. The exit-code-2 contract IS preserved: catch the
  // wrapper's thrown Error here and route it through this file's own
  // fail_() exactly as every other malformed-input path already does.
  let parsed;
  try {
    parsed = parseCliArgs(argv, AUDIT_AUTHORED_ISSUE_FLAG_SPEC);
  } catch (error) {
    fail_(error.message);
  }
  const { values, help } = parsed;
  const format = values.format;
  if (!['json', 'table'].includes(format)) {
    fail_('--format must be json or table');
  }
  return {
    help,
    shape: values.shape,
    title: values.title,
    bodyFile: values['body-file'],
    stdin: values.stdin,
    markerPrefix: values['marker-prefix'],
    configPath: values.config,
    currentRepo: values['current-repo'],
    issue: values.issue,
    labels: values.label ?? [],
    expectBucket: values['expect-bucket'],
    commentsFile: values['comments-file'],
    journalCommentsFile: values['journal-comments-file'],
    newIssue: values['new-issue'],
    trustedMarkerLogins: values['trusted-marker-logins'],
    format,
  };
}
function printUsage() {
  console.log(`usage: node scripts/audit-authored-issue.mjs --shape <orphan|roadmap|child> (--body-file <path> | --stdin) [options]

Mechanically audits a drafted GitHub issue body against the issue-authoring
contract's structural expectations (skills/issue-authoring/references/
contract.md): the autopilot-suitability marker, its cross-field
status:blocked-by-human agreement, markerPrefix consistency, required
section headings for the declared shape, the roadmap-id/blocked-by
dependency-marker rules, visible/hidden suitability+effort line
agreement, and an advisory (warning-severity only) check that flags an
issue/PR reference used near coordination language with no corresponding
dependency marker, (when --comments-file is supplied) the
authoring-owner-marker-trail check that verifies an authoring-labeled
issue carries the owner-marker/publication-token trail, and (when
--comments-file and/or --journal-comments-file is supplied) the
authoring-marker-minimization-backlog check that counts eligible,
not-yet-minimized superseded authoring-owner / authoring-publication-intent
marker comments. For the orphan and child shapes, it also runs the same
A4 viability and A4.5 suitability evaluators Discover uses later
(triage-title-missing, triage-a4-<criterion>, triage-a45-<check>), so a
body that would fail A4/A4.5 at claim time is caught before it is ever
published; triage-a45-duplicate_or_superseded always reports "not
applicable" (it needs a live repository) and the roadmap shape reports
every triage finding as not applicable (Discover never routes a roadmap
node through A4/A4.5). With --expect-bucket, a failing triage finding is
downgraded to a warning instead of failing the report, since such a body
is meant to be non-ready. Exits 0 when every check passes, 1 when any
check fails, 2 on a usage error; the advisory check and
authoring-marker-minimization-backlog never affect the exit code.

Options:
  --shape <orphan|roadmap|child>   declared issue shape (required)
  --title <text>                   the drafted issue's title, for the A4/A4.5
                                    triage checks (orphan/child shapes only);
                                    without it, a leading "# <title>" line of
                                    the body is used instead. Required (one
                                    way or the other) for those checks to
                                    evaluate -- see triage-title-missing
  --body-file <path>               read the drafted issue body from a file
  --stdin                          read the drafted issue body from stdin
  --marker-prefix <prefix>         override the resolved markerPrefix
  --config <path>                  policy config path (default: .github/idd/config.json);
                                    also resolves upstreamEscalation.enabled, which
                                    gates both upstream-candidate checks (the
                                    marker/label pairing check and the
                                    upstream-candidate branch of the prefix scan)
  --label <name>                   a label currently applied/proposed on the issue
                                    (repeatable; used for the suitability=1 /
                                    authoring-bucket cross-field checks, the
                                    upstream-candidate marker/label pairing
                                    check, and the authoring-label check for
                                    authoring-owner-marker-trail)
  --expect-bucket <bucket>         needs-decision or blocked-by-human; set only when
                                    auditing a body about to be newly published into
                                    that bucket -- requires the matching
                                    authoring-bucket marker to be present (omit for a
                                    ready publish or a legacy body)
  --current-repo <owner/repo>      this repository, for the prose-dependency check
                                    to recognize a full-URL issue/PR reference as
                                    cross-repo (default: $GITHUB_REPOSITORY),
                                    for authoring-owner-marker-trail's target match,
                                    and for dependency-line-grammar: a qualified/URL
                                    dependency line naming a different repository
                                    fails publication only when this is supplied
                                    and does not match -- omitting it treats a
                                    qualified reference as unverifiable, not
                                    malformed
  --issue <number>                 this issue's number, for authoring-owner-marker-trail's
                                    target match (requires --current-repo or
                                    $GITHUB_REPOSITORY to be resolvable)
  --comments-file <path>           JSON array of this issue's pre-fetched comments
                                    ({body, author?, createdAt?, isMinimized?});
                                    enables authoring-owner-marker-trail and the
                                    authoring-owner half of
                                    authoring-marker-minimization-backlog
                                    (network-free: this module never fetches
                                    comments itself; isMinimized defaults to
                                    "not minimized" when omitted)
  --journal-comments-file <path>   JSON array of the journal issue's pre-fetched
                                    comments (same shape as --comments-file).
                                    Feeds the authoring-publication-intent half
                                    of authoring-marker-minimization-backlog on
                                    its own -- usable standalone, without
                                    --comments-file or --new-issue (for example,
                                    to audit only the shared journal's backlog at
                                    Stage 2 release on an already-published
                                    issue) -- and additionally feeds the
                                    new-issue publication-intent cross-check
                                    when --comments-file, --new-issue, and
                                    --issue are also given
  --new-issue                      this issue was just created in this invocation
                                    (not an edit); requires the leading
                                    authoring-publication body line, and (when
                                    --comments-file is also given) requires
                                    --journal-comments-file and --issue too
  --trusted-marker-logins <csv>    comma-separated trusted GitHub actor logins
                                    (flag > $IDD_TRUSTED_MARKER_ACTORS >
                                    .github/idd/config.json's trustedMarkerActors);
                                    filters authoring-marker-minimization-backlog's
                                    count to comments from a trusted actor, matching
                                    minimize-superseded-markers.mjs's own trust gate.
                                    Omitted or empty leaves that count unfiltered
                                    (every check above this one is unaffected)
  --format <json|table>            output format (default: json)
  --help                           show this help

Environment:
  IDD_TRUSTED_MARKER_ACTORS        comma-separated trusted actor logins, used when
                                    --trusted-marker-logins is not given (see above)
`);
}
function fail_(message) {
  console.error(`error: ${message}`);
  const error = new Error(message);
  markCliUsageError(error);
  Object.defineProperty(error, 'auditCliFail', {
    value: true,
    enumerable: false,
  });
  throw error;
}
function isAuditCliFail(error) {
  return error instanceof Error && error.auditCliFail === true;
}
