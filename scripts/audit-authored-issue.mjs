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
// the roadmap-id/blocked-by dependency-marker rules, visible/hidden line
// agreement for the suitability and effort footers, and an advisory
// warning-severity check that flags an issue/PR reference used near
// coordination language (e.g. "before", "once", "requires") with no
// corresponding Blocked-by/Depends-on/task-list dependency encoding. The
// advisory check never fails the report or changes the exit code — see
// checkProseOnlyDependency.
//
// All marker value parsing is delegated to the existing
// autopilot-suitability.mts / effort.mts / marker-regex.mts /
// policy-helpers.mts helpers; this module only layers shape-aware
// structural checks on top of them. Pure and network-free — the CLI reads
// the drafted body from a file or stdin rather than fetching a live issue.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAutopilotSuitabilityMarker } from './autopilot-suitability.mjs';
import {
  extractBlockedByIssueNumbers,
  extractBlockedByRoadmapMarkers,
  extractDependencyIssueNumbers,
} from './discover-readiness-check.mjs';
import { extractRoadmapMarkerId } from './discover-roadmap-graph.mjs';
import { parseEffortMarker } from './effort.mjs';
import { loadIddConfig } from './idd-config.mjs';
import { stripMarkdownCodeRegions } from './markdown-code.mjs';
import { createMarkerRegex, escapeRegex } from './marker-regex.mjs';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mjs';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
// The four authoring-marker suffixes defined in the contract. Operational
// markers (claimed-by, review-watermark, ...) never take this
// `{prefix}-{suffix}` shape, so they cannot collide with this scan.
const AUTHORING_MARKER_SUFFIXES = [
  'roadmap-id',
  'blocked-by',
  'autopilot-suitability',
  'effort',
];
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
if (import.meta.main) {
  main();
}
/**
 * Audit a drafted issue body against the issue-authoring contract's
 * structural expectations for the declared shape. Every check runs
 * independently (no short-circuit), so one report surfaces every problem
 * at once instead of stopping at the first failure. One check
 * (`prose-dependency`) is advisory-only: it always reports `result:
 * 'pass'` and only ever adds a `severity: 'warning'` marker plus detail,
 * so it never affects `passed` or the caller's exit code.
 */
export function auditAuthoredIssue(body, options) {
  const rawText = typeof body === 'string' ? body : String(body ?? '');
  // Strip Markdown code regions (fenced blocks and inline spans) once, up
  // front, and run every check (marker counting, heading detection,
  // visible-line scoping) against the result. A pasted template/example
  // snippet — quoting a marker or heading for illustration — must never
  // count as the real thing. Reuses the same stripMarkdownCodeRegions
  // primitive extractRoadmapMarkerId already relies on, rather than a
  // second, independently-maintained fence tracker.
  const text = stripMarkdownCodeRegions(rawText);
  const shape = options.shape;
  const markerPrefix = normalizeMarkerPrefix(options.markerPrefix);
  const blockedByHumanLabelName =
    typeof options.blockedByHumanLabelName === 'string' &&
    options.blockedByHumanLabelName.length > 0
      ? options.blockedByHumanLabelName
      : POLICY_DEFAULTS.labels.blockedByHumanLabelName;
  const labels = (options.labels ?? []).map((label) =>
    String(label).trim().toLowerCase(),
  );
  const suitability = parseAutopilotSuitabilityMarker(text, markerPrefix);
  const suitabilityCount = countMarkerOccurrences(
    text,
    markerPrefix,
    'autopilot-suitability',
  );
  const findings = [
    checkSuitabilityMarker(suitabilityCount, suitability),
    checkSuitabilityBlockedByHuman(
      suitability,
      labels,
      blockedByHumanLabelName,
    ),
    checkMarkerPrefixConsistency(text, markerPrefix),
    checkRequiredHeadings(text, shape),
    checkDependencyMarkerRule(text, markerPrefix, shape),
    checkSuitabilityVisibleLineAgreement(text, markerPrefix, suitability),
    checkEffortVisibleLineAgreement(text, markerPrefix),
    checkProseOnlyDependency(text, normalizeCurrentRepo(options.currentRepo)),
  ];
  return {
    shape,
    markerPrefix,
    passed: findings.every((finding) => finding.result === 'pass'),
    findings,
  };
}
function checkSuitabilityMarker(count, suitability) {
  const id = 'suitability-marker';
  const name = 'Exactly one coherent autopilot-suitability marker (1-5)';
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
function checkSuitabilityBlockedByHuman(
  suitability,
  labels,
  blockedByHumanLabelName,
) {
  const id = 'suitability-blocked-by-human';
  const name = `Suitability score of 1 carries the ${blockedByHumanLabelName} label`;
  if (suitability.value !== 1) {
    return pass(id, name, 'not applicable: suitability score is not 1');
  }
  const target = blockedByHumanLabelName.trim().toLowerCase();
  if (labels.includes(target)) {
    return pass(id, name, `${blockedByHumanLabelName} label is present`);
  }
  return fail(
    id,
    name,
    `suitability score is 1 but the ${blockedByHumanLabelName} label was not provided`,
  );
}
function checkMarkerPrefixConsistency(text, markerPrefix) {
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
  const pattern = new RegExp(
    `<!--\\s*([^\\s>:]+)-(${AUTHORING_MARKER_SUFFIXES.join('|')})\\b[\\s\\S]*?-->`,
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
function checkRequiredHeadings(text, shape) {
  const id = 'required-headings';
  const name = `Required section headings present for the ${shape} shape`;
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
function checkDependencyMarkerRule(text, markerPrefix, shape) {
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
  const wellFormedBlockedByCount = extractBlockedByRoadmapMarkers(
    text,
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
    if (!extractRoadmapMarkerId(text, markerPrefix)) {
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
function checkEffortVisibleLineAgreement(text, markerPrefix) {
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
  const effort = parseEffortMarker(text, markerPrefix);
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
function checkProseOnlyDependency(text, currentRepo) {
  const id = 'prose-dependency';
  const name =
    'Advisory: issue/PR references near coordination language should use a dependency marker';
  // Numbers already covered by a real machine-readable dependency encoding
  // (Blocked by / Depends on / task-list) are never flagged, regardless of
  // nearby prose — the whole point of this check is to catch references
  // that carry *no* such encoding.
  const encoded = new Set([
    ...extractBlockedByIssueNumbers(text),
    ...extractDependencyIssueNumbers(text),
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
// text, only a *later* marker line can close its node (a continuation
// line never does -- see splitIntoListItemBlocks). So the *last* marker
// line anywhere in such a run is necessarily still open at the run's
// end, and that marker's own indentation is an exact, cheap proxy for
// "the indentation of whatever node is still open right before the
// blank line" -- without re-running the full ancestry-stack simulation
// just to find out. Returns undefined when `text` has no marker line at
// all.
function lastListItemMarkerIndent(text) {
  let last;
  for (const line of text.split('\n')) {
    const marker = LIST_ITEM_MARKER_PATTERN.exec(line);
    if (marker !== null) {
      last = indentColumnWidth(marker[1]);
    }
  }
  return last;
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
function countMarkerOccurrences(text, markerPrefix, suffix) {
  const base = createMarkerRegex(markerPrefix, suffix);
  const global = new RegExp(base.source, `${base.flags}g`);
  return [...text.matchAll(global)].length;
}
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
function normalizeMarkerPrefix(prefix) {
  // Trim first: a config value or CLI input with accidental leading/
  // trailing whitespace (e.g. "idd-skill ") would otherwise become a
  // distinct prefix that never matches any real marker, producing
  // confusing false failures across every check.
  const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_MARKER_PREFIX;
}
function pass(id, name, detail) {
  return { id, name, result: 'pass', detail };
}
function fail(id, name, detail) {
  return { id, name, result: 'fail', detail };
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
  const policy = loadPolicy(args.configPath);
  const markerPrefix = args.markerPrefix ?? policy.markerPrefix;
  const report = auditAuthoredIssue(bodyText, {
    shape: args.shape,
    markerPrefix,
    labels: args.labels,
    blockedByHumanLabelName: policy.blockedByHumanLabelName,
    // Explicit --current-repo wins; otherwise fall back to the
    // GITHUB_REPOSITORY env var GitHub Actions sets automatically, so CI
    // usage narrows cross-repo URL false positives with no extra flag.
    // undefined (neither present) keeps the pre-#1399-fix default of
    // flagging every full-URL reference.
    currentRepo: args.currentRepo ?? process.env.GITHUB_REPOSITORY,
  });
  writeReport(report, args.format);
  process.exit(report.passed ? 0 : 1);
}
function isIssueShape(value) {
  return value === 'orphan' || value === 'roadmap' || value === 'child';
}
function loadPolicy(configPath) {
  // Default path: reuse the shared loadIddConfig() (idd-config.mts) rather
  // than a second "readFileSync + JSON.parse, null on error" copy of the
  // exact pattern it was extracted from (see that module's header, #1208).
  // loadIddConfig() always reads '.github/idd/config.json' relative to cwd
  // and has no path parameter, so an explicit --config override still
  // falls back to its own JSON.parse branch.
  const config = configPath
    ? loadConfigFromPath(resolve(process.cwd(), configPath))
    : loadIddConfig();
  if (!config) {
    // Stay fail-safe (never hard-crash on a bad config, matching every
    // sibling *.mts loadPolicy()), but surface an explicit --config that
    // could not be read/parsed: silently validating against the wrong
    // policy would be a confusing, hard-to-notice false pass/fail.
    if (configPath) {
      // Describe this as loadPolicy's own fallback, not the audit's final
      // effective markerPrefix: main() still applies --marker-prefix on
      // top of this return value when the operator passed it, so naming a
      // specific value here (e.g. DEFAULT_MARKER_PREFIX) could mislead
      // when that flag is also present. The report's own markerPrefix
      // field is the authoritative source for the value actually used.
      console.error(
        `warning: could not read or parse --config ${configPath}; falling back to default policy unless overridden by --marker-prefix (see the report's markerPrefix field for the effective value)`,
      );
    }
    return {
      markerPrefix: DEFAULT_MARKER_PREFIX,
      blockedByHumanLabelName: POLICY_DEFAULTS.labels.blockedByHumanLabelName,
    };
  }
  return {
    markerPrefix: normalizeMarkerPrefix(config.markerPrefix),
    blockedByHumanLabelName:
      normalizePolicyConfig(config).labels.blockedByHumanLabelName,
  };
}
function loadConfigFromPath(targetPath) {
  try {
    return JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
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
  const parsed = { labels: [], format: 'json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--shape':
        parsed.shape = readValue(argv, ++index, arg);
        break;
      case '--body-file':
        parsed.bodyFile = readValue(argv, ++index, arg);
        break;
      case '--stdin':
        parsed.stdin = true;
        break;
      case '--marker-prefix':
        parsed.markerPrefix = readValue(argv, ++index, arg);
        break;
      case '--config':
        parsed.configPath = readValue(argv, ++index, arg);
        break;
      case '--current-repo':
        parsed.currentRepo = readValue(argv, ++index, arg);
        break;
      case '--label':
        parsed.labels.push(readValue(argv, ++index, arg));
        break;
      case '--format':
        parsed.format = readValue(argv, ++index, arg);
        if (!['json', 'table'].includes(parsed.format)) {
          fail_('--format must be json or table');
        }
        break;
      default:
        fail_(`unknown argument ${arg}`);
    }
  }
  return parsed;
}
function readValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    fail_(`${flag} requires a value`);
  }
  return value;
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
dependency marker. Exits 0 when every check passes, 1 when any check
fails, 2 on a usage error; the advisory check never affects the exit
code.

Options:
  --shape <orphan|roadmap|child>   declared issue shape (required)
  --body-file <path>               read the drafted issue body from a file
  --stdin                          read the drafted issue body from stdin
  --marker-prefix <prefix>         override the resolved markerPrefix
  --config <path>                  policy config path (default: .github/idd/config.json)
  --label <name>                   a label currently applied/proposed on the issue
                                    (repeatable; used for the suitability=1
                                    cross-field check)
  --current-repo <owner/repo>      this repository, for the prose-dependency check
                                    to recognize a full-URL issue/PR reference as
                                    cross-repo (default: $GITHUB_REPOSITORY)
  --format <json|table>            output format (default: json)
  --help                           show this help
`);
}
function fail_(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}
