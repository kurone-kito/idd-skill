#!/usr/bin/env node
// idd-generated-from: src/scripts/suitability-triage.mts
//
// The scripts/suitability-triage.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { computeBranchName } from './branch-name.mts';
import { parseCliArgs } from './cli-args.mts';
import {
  DEFAULT_BUNDLE_IDS,
  DEFAULT_MANIFEST_PATH,
  parseCandidateFiles,
  resolveHighContentionFiles,
} from './discover-shared-file-overlap.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import { loadPolicyConfig } from './idd-config.mts';
import {
  findMarkdownCodeRanges,
  getMarkdownCodeRange,
  type MarkdownCodeRange,
  maskMarkdownCodeRegionsPreservingPositions,
} from './markdown-code.mts';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mts';
import { resolveTrustedMarkerActors } from './protocol-helpers.mts';
import {
  buildClosedByMergedPrArgs,
  buildMergedPrByBranchArgs,
  buildMergedPrListArgs,
  buildPrDetailArgs,
  type CheckOutcome,
  evaluateHighConfidenceDuplicate,
  findCandidateFileOverlap,
  findTrustedSuitabilityRejection,
  type HighConfidenceDuplicateInput,
  type HighConfidenceMergedPr,
  prReferencesIssue,
  resolveCandidateFileSet,
  type SuitabilityRejectionComment,
  type SuitabilityRejectionRecord,
} from './supersession-detection.mts';

/**
 * Wall-clock budget for the #1484 merged-PR file-overlap scan (CodeRabbit
 * review finding on this PR): up to `supersession-detection.mts`'s own
 * merged-PR-scan limit (50, mirroring B2.0's own documented `gh pr list
 * --limit 50`) sequential `gh pr view` calls at 30s each could otherwise
 * take ~25 minutes in the worst case (a degraded/rate-limited GitHub API).
 * Stop early and return whatever has been collected once this budget
 * elapses, rather than blocking the whole A4.5 evaluation on a slow scan.
 * (#1499: that limit is baked into `buildMergedPrListArgs`'s own argv,
 * which this file now only calls rather than builds -- this comment stays
 * prose-only rather than importing the value, since nothing here needs it
 * as a live binding.)
 */
const MERGED_PR_SCAN_DEADLINE_MS = 2 * 60 * 1000;

/** Parsed CLI arguments. */
interface SuitabilityTriageArgs {
  issue: number | null;
  /** #2102: local/offline dry-run input, mutually exclusive with --issue. */
  bodyFile?: string;
  /** #2102: local/offline dry-run input, mutually exclusive with --issue. */
  stdin: boolean;
  ghToken: string;
  owner: string;
  repo: string;
  policy: string;
  /** #1499: high-contention manifest override, mirroring
   * `discover-shared-file-overlap.mts`'s own `--manifest` flag so a
   * repository that customizes its A4 Step 2 manifest path gets a matching
   * Check-4 exclusion set instead of the hardcoded default. */
  manifest: string;
  /** #1499: high-contention bundle-id override, mirroring
   * `discover-shared-file-overlap.mts`'s own `--bundles` flag. `null` means
   * "not passed" -- the caller falls back to `DEFAULT_BUNDLE_IDS`. */
  bundles: string[] | null;
  verbose: boolean;
  help: boolean;
}

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `issue:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --issue spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see ci-wait-policy.mts's identical note).
const SUITABILITY_TRIAGE_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--body-file': { type: 'string' },
  '--stdin': { type: 'boolean', default: false },
  '--gh-token': { type: 'string' },
  '--token': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--policy': { type: 'string', default: '' },
  '--manifest': { type: 'string', default: DEFAULT_MANIFEST_PATH },
  '--bundles': { type: 'string' },
  '--verbose': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

interface NormalizedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
  /** #1484: the merged-PR scan window start (no claim exists yet at A4.5). */
  createdAt: string;
}

interface Repository {
  owner: string;
  repo: string;
}

interface DuplicateCandidate {
  number: number;
  title: string;
  state: string;
  url: string;
}

interface Context {
  issue: NormalizedIssue;
  repository: Repository | null;
  duplicateCandidates: DuplicateCandidate[];
  trustSafetyAmbiguous: boolean;
  /** Configured `labels.blockedByHumanLabelName` (#1273). */
  blockedByHumanLabelName?: string;
  /** Configured `labels.needsDecisionLabelName` (#1273). */
  needsDecisionLabelName?: string;
  /** #1484: high-confidence duplicate/superseded mechanical evidence. */
  highConfidenceDuplicate?: HighConfidenceDuplicateInput;
  /**
   * #1484 (Codex P2 review finding): `true` when a high-confidence evidence
   * collector genuinely failed (recorded in `collectionWarnings` by
   * `runCli`), as opposed to running cleanly and finding nothing. Before
   * this tier existed, any Check 4 collector failure crashed the whole
   * evaluation; this tier's own try/catch introduced the first scenario
   * where a collector can fail yet Check 4 still runs -- which must
   * degrade to the documented "Timeout on duplicate detection... fall back
   * to exact title match only" Edge Case, not the full weak heuristic
   * (specifically, not the near-duplicate fuzzy match, which could
   * otherwise flag a merely similarly-titled but genuinely distinct issue
   * as a false duplicate precisely because evidence collection broke).
   */
  highConfidenceCollectionDegraded?: boolean;
}

interface CheckResult {
  id: string;
  name: string;
  result: string;
  evidence: string;
  /** #1499: present only for a fail whose evidence came from the
   * high-confidence mechanical kernel vs. the weak title/declaration
   * heuristic -- see `CheckOutcome` in `supersession-detection.mts`. */
  tier?: 'high-confidence' | 'weak';
}

interface SuitabilityResult {
  passed: boolean;
  outcome: string;
  failedCheck: string | null;
  checks: CheckResult[];
}

interface SuitabilityOptions {
  repository?: unknown;
  duplicateCandidates?: unknown;
  trustSafetyAmbiguous?: unknown;
  blockedByHumanLabelName?: unknown;
  needsDecisionLabelName?: unknown;
  /** #1484 */
  highConfidenceDuplicate?: unknown;
  /** #1484 */
  highConfidenceCollectionDegraded?: unknown;
}

const CHECKS: {
  id: string;
  name: string;
  failureOutcome: string;
  evaluate: (context: Context) => CheckOutcome;
}[] = [
  {
    id: 'repository_fit',
    name: 'Repository Fit',
    failureOutcome: 'out-of-scope',
    evaluate: checkRepositoryFit,
  },
  {
    id: 'coherence',
    name: 'Issue Coherence',
    failureOutcome: 'unclear',
    evaluate: checkCoherence,
  },
  {
    id: 'trust_safety',
    name: 'Trust/Safety',
    failureOutcome: 'invalid',
    evaluate: checkTrustSafety,
  },
  {
    id: 'duplicate_or_superseded',
    name: 'Duplicate or Superseded Work',
    failureOutcome: 'duplicate',
    evaluate: checkDuplicateOrSuperseded,
  },
  {
    id: 'actionability',
    name: 'Actionability',
    failureOutcome: 'needs-decision',
    evaluate: checkActionability,
  },
  {
    id: 'autonomy',
    name: 'Autonomy',
    failureOutcome: 'blocked-by-human',
    evaluate: checkAutonomy,
  },
  {
    id: 'verifiability',
    name: 'Verifiability',
    failureOutcome: 'needs-decision',
    evaluate: checkVerifiability,
  },
];

// cspell:ignore AKIA baprs xoxbaprs
const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
];

// Allow an optional `sudo` and/or `env VAR=val ...` prefix before the
// shell on the right-hand side of the pipe, so `curl … | sudo bash` and
// `curl … | env FOO=bar sh` are still detected.
const UNSAFE_SHELL_SUFFIX = String.raw`\|\s*(?:sudo\s+|env\s+(?:\S+=\S*\s+)*)*(?:sh|bash)\b`;
const UNSAFE_PATTERNS = [
  new RegExp(String.raw`\bcurl\b[^\n|]*${UNSAFE_SHELL_SUFFIX}`, 'i'),
  new RegExp(String.raw`\bwget\b[^\n|]*${UNSAFE_SHELL_SUFFIX}`, 'i'),
  /\beval\s*\(/i,
];

const EXECUTION_VERB_PATTERN = /\b(run|execute|paste|install|invoke)\b/i;
const EXTERNAL_COORDINATION_PATTERN =
  /\b(cross-repo|cross repo|external repo|another repo|upstream change|maintainer of)\b/i;
const EXTERNAL_SYSTEM_ACCESS_PATTERN =
  /\b(requires?|need(?:s)?|must|depends on)\b[\s\S]{0,120}\b((?:external|third-?party|production|dashboard|workspace|console|service|system|slack|jira|datadog)[\s\S]{0,40}(?:access|credentials?|login|permission|sign-?in)|(?:access|credentials?|login|permission|sign-?in)[\s\S]{0,40}(?:external|third-?party|production|dashboard|workspace|console|service|system|slack|jira|datadog))\b/i;
const DUPLICATE_DECLARATION_PATTERN =
  /\b(duplicate of|superseded by)\s*(?:#\d+|https?:\/\/\S+?\/(?:issues|pull)\/\d+)\b/gi;
const DUPLICATE_NEGATION_PATTERN = /\b(not|no|avoid)\b[\s\S]{0,30}$/i;
// A bare `\b` treats a hyphen as a non-word character, so it also matches the
// tail of this repository's own hyphenated outcome/label vocabulary (e.g.
// `decision` inside `needs-decision`, `human` inside `blocked-by-human`).
// `(?<![\w-])`/`(?![\w-])` reject a match immediately adjacent to a hyphen
// (part of a larger hyphenated token) while still matching a freestanding
// use of the same word (#2205).
const SUBJECTIVE_SUBJECT_PATTERN =
  /(?<![\w-])(maintainer|stakeholder|human|opinion|judgment|judgement|ux|feel)(?![\w-])/i;
const SUBJECTIVE_GATE_PATTERN =
  /(?<![\w-])(approval|sign-?off|decision|preference)(?![\w-])/i;
// #2501: a bare `\b` on each word's dictionary form never matches an
// ordinary inflected form ("passes", "included", "requires", "failing",
// "presented", "resulted") -- an Acceptance Criteria bullet written with
// any of those verb forms produced a false `does not provide objective
// verification signals` failure despite being concretely, objectively
// checkable. Each verb word below carries an explicit `-s|-ed/-d|-ing`
// suffix group instead of the bare form; `objective`/`measurable`/
// `deterministic` stay bare since they are adjectives, not conjugated as
// verbs in this context. `include`/`require` end in a silent `e` that
// standard English orthography drops before `-ing` ("including" /
// "requiring", not "includeing" / "requireing" -- caught in PR review),
// so their stem omits the trailing `e` and the `e[sd]?|ing` group is
// mandatory rather than optional.
const OUTCOME_SIGNAL_PATTERN =
  /\b(pass(?:e[sd]|ing)?|fail(?:s|ed|ing)?|result(?:s|ed|ing)?|output(?:s|ted|ting)?|contain(?:s|ed|ing)?|includ(?:e[sd]?|ing)|present(?:s|ed|ing)?|requir(?:e[sd]?|ing)|objective|measurable|deterministic)\b/i;
// Whole-body proximity variant of the subjective-approval check, built from
// the same two pattern sources above (not hand-duplicated) so the
// hyphen-boundary fix (#2205) applies to both the per-line and whole-body
// test paths.
const SUBJECTIVE_PROXIMITY_PATTERN = new RegExp(
  `${SUBJECTIVE_GATE_PATTERN.source}[\\s\\S]{0,80}${SUBJECTIVE_SUBJECT_PATTERN.source}`,
  'i',
);
// #2512: a match landing in a paragraph that also reports on another
// document's or process's existing behavior ("...paragraph SAYS a later
// worker session removes the label once a human decision resolves the
// hold" -- #2472's exact shape) uses the subject/gate vocabulary as the
// OBJECT of that report, not as a claim that THIS issue's own completion
// needs anyone's say-so. GitHub issue bodies are hard-wrapped, so the
// reporting verb and the subject/gate words routinely land on different
// physical lines of the same sentence -- a paragraph (blank-line
// delimited), not a raw split(\n) line, is the unit that must see both
// (the same "line wrap is not a boundary, blank line is" shape as
// `sliceUnsafeDirectiveWindow`'s Check 3 window). Exempting the whole
// paragraph, not a tighter window around the verb, is a soft trade-off
// matching this check's existing resolved-decision heuristic below: a
// false negative (an unrelated reporting verb elsewhere in a long
// paragraph) is accepted in exchange for not re-deriving sentence
// boundaries.
const FRAMING_VERB_PATTERN =
  /\b(documents?|describes?|says?|states?|explains?|reports?)\b/i;

/** Blank-line-delimited paragraph offsets within `body`. */
function getParagraphSpans(body: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const boundary of body.matchAll(/\r?\n[ \t]*(?:\r?\n)+/g)) {
    spans.push({ start: cursor, end: boundary.index });
    cursor = boundary.index + boundary[0].length;
  }
  spans.push({ start: cursor, end: body.length });
  return spans;
}

// Check 3 precision: an unsafe execution directive tells the agent to act on
// *supplied / untrusted* content, not any command verb that merely lands near
// the ordinary determiner "this". Match the strong untrusted-origin signals, or
// a determiner that points at supplied content followed (within two words) by a
// runnable-content noun ("run this script", "paste the following command").
// Prose that documents a tool's own behavior ("run the helper; this prints the
// body") no longer false-fires. The piped `curl … | sh`, `sudo`-wrapped
// pipeline, and `eval(` catches stay in the separate UNSAFE_PATTERNS loop.
const UNSAFE_DIRECTIVE_VERB = '(?:execute|run|paste|install|invoke)';
const SUPPLIED_CONTENT_NOUN =
  '(?:command|script|code|snippet|payload|url|link|instruction|input|file|attachment|gist|one-?liner|program|binary|shell)s?';
// `[\x60'"]?` (an optional backtick / quote, written hex so it can live inside
// a String.raw template) lets the noun be wrapped in inline code, so
// "run this `script`" is still caught.
//
// #2218: "following/attached/pasted/provided" are themselves untrusted-origin
// signals (something hand-supplied to the agent inline), so a match anywhere
// in the verb's clause window still counts, same as before. The ambiguous
// "this/that" determiner is not inherently untrusted-origin -- it commonly
// points at an ordinary in-repo artifact mentioned later in the same
// sentence, past an unrelated coordinated clause ("re-run the linter and
// address whatever it flags about this file"), not at the executing verb's
// own object. Restrict "this/that" to the verb's immediate object: anchored
// to the start of the clause window, optionally past a single parenthetical
// aside (e.g. "run (in Node.js) this script" -- #2146's abbreviation-period
// regression fixture), but not past any other intervening text -- a second
// object or a coordinating clause before "this/that" means the determiner
// belongs to a different, unrelated clause. The verb-match loop below still
// tries every unsafe verb occurrence, so "download and then execute this
// script" still flags via the `execute` iteration's own window.
//
// The determiner-to-noun gap allows at most one modifier word (unlike the
// two-word filler on the untrusted-origin branch below), and that one word
// must not itself be a coordinating conjunction -- a wider filler would let
// a conjunction slip past the anchor from the other side, e.g. "run this
// and inspect script output" ("this" is a dangling reference and "script"
// is the object of the unrelated verb "inspect", not of "this"), while no
// filler at all would wrongly stop matching a genuine single-adjective
// object like "run this quick script" (Copilot review, #2218).
const SUPPLIED_CONTENT_UNTRUSTED_DETERMINER = String.raw`(?:following|attached|pasted|provided|the\s+(?:following|above|below|attached|pasted|provided))`;
const SUPPLIED_CONTENT_AMBIGUOUS_DETERMINER = '(?:this|that)';
const SUPPLIED_CONTENT_PARENTHETICAL_ASIDE = String.raw`(?:\([^()\n]{0,60}\)\s*)?`;
const SUPPLIED_CONTENT_COORDINATOR = 'and|or|but|then|also';
const SUPPLIED_CONTENT_OBJECT_FILLER = String.raw`(?:(?!\b(?:${SUPPLIED_CONTENT_COORDINATOR})\b)\S+\s+){0,1}?`;
const SUPPLIED_CONTENT_REFERENCE = String.raw`${SUPPLIED_CONTENT_UNTRUSTED_DETERMINER}\s+(?:\S+\s+){0,2}?[\x60'"]?${SUPPLIED_CONTENT_NOUN}`;
const SUPPLIED_CONTENT_OBJECT_REFERENCE = String.raw`^\s*${SUPPLIED_CONTENT_PARENTHETICAL_ASIDE}${SUPPLIED_CONTENT_AMBIGUOUS_DETERMINER}\s+${SUPPLIED_CONTENT_OBJECT_FILLER}[\x60'"]?${SUPPLIED_CONTENT_NOUN}`;
const UNSAFE_DIRECTIVE_TARGET_SOURCE = String.raw`(?:\b(?:untrusted|user-provided|user input|(?:from|by)\s+(?:the\s+)?user|${SUPPLIED_CONTENT_REFERENCE})\b|${SUPPLIED_CONTENT_OBJECT_REFERENCE}\b)`;
const UNSAFE_DIRECTIVE_WINDOW_CHARS = 100;
const NEGATION_PATTERN =
  /\b(not|no|don'?t|doesn'?t|can'?t|won'?t|never|avoid|skip|omit|ignore|exempt)\b/i;
// The repeated `disable` entries are preserved verbatim from the original
// inline regex literal (harmless redundancy in an alternation) to keep this
// pattern byte-identical rather than pulled in as an incidental fix here.
// #2399: this alternation deliberately stays on a bare, unguarded `\b`
// (unlike `POLICY_OVERRIDE_NOUN_SOURCE` below) -- three review rounds on
// #2407 each replaced a fixed-distance regex lookbehind here with a wider
// one, and each replacement still let some hyphen- or symbol-prefixed CLI
// flag phrasing (`--skip`, `--skip-checks`, `--force-skip`,
// `/force-skip`) evade detection by looking enough like an ordinary
// hyphenated compound word (`evidence-skip`) at a fixed lookbehind
// distance. Distinguishing the two needs to trace a whole token back to
// its own origin, which no fixed-width lookbehind can do; see
// `isOrdinaryHyphenatedCompoundToken` below, called from
// `findPolicyOverrideMatch`, for that classification instead.
const POLICY_OVERRIDE_VERB_SOURCE = `(?:ignore|bypass|override|disable|disable|skip|turn off|suppress|disable)`;
// #2218: a bare `\b` treats a hyphen as a non-word character, so every one
// of these nouns also matched inside an ordinary hyphenated file-path
// mention (e.g. this project's own marker prefix in `idd-workflow-notes.md`
// -- both `idd` and `workflow` matched there, each independently), with
// nothing nearby actually attempting to change this checker's own
// behavior. The trailing `(?![\w-])` guard below excludes a noun
// immediately followed by a hyphen (e.g. `idd` in `idd-workflow-notes.md`)
// -- unlike the leading side (#2408 below), this direction has no
// classifier-based counterpart: the leading-side classifier can trace a
// hyphen run back to its own origin because a flag's OWN name always
// starts there, but a hyphen AFTER the noun could just as easily continue
// a real flag name the noun is only the first component of (`--policy-file`,
// `--gate-config`) as it could an ordinary compound (`idd-workflow`) --
// nothing at the noun's own trailing edge distinguishes the two shapes.
// A listed noun referenced as a non-final flag component is therefore a
// deliberate, documented limit of this guard, the same class of limit as
// the verb side's bare, un-code-wrapped "force-skip" (see
// isOrdinaryHyphenatedCompoundToken's own comment below): nothing in shape
// alone separates `--policy-file` from `idd-workflow`, and any guard broad
// enough to catch the former would reintroduce the #2218 false positive on
// the latter.
//
// #2408: an earlier revision also wrapped the LEADING side in the same
// `(?<![\w-])` shape (mirroring `SUBJECTIVE_SUBJECT_PATTERN`, #2205),
// which excluded every hyphen-adjacent noun outright -- including a
// genuine directive phrased as a hyphen-prefixed CLI flag reference
// (`--policy`), the same class of gap `#2407` already fixed on the verb
// side. A bare leading lookbehind cannot distinguish that from an
// ordinary compound (`idd-workflow`); only tracing the whole hyphen run
// back to its own origin can, which is exactly what
// `isOrdinaryHyphenatedCompoundToken` (shared with the verb side, renamed
// from `isOrdinaryHyphenatedCompoundVerb`) does. The leading guard is
// removed here, and that classifier is called from
// `findPolicyOverrideMatch` at the noun's own match position instead, so
// a freestanding use ("bypass idd", "disable IDD gate", "bypass workflow
// checks") and a flag-style reference ("--policy", "/policy") both still
// match, while an ordinary hyphenated compound noun stays excluded.
const POLICY_OVERRIDE_NOUN_SOURCE = String.raw`(?:repo|repository|policy|workflow|idd|process|check|gate|requirement)(?![\w-])`;
// #2408: shared with findGenuineNounMatch below, which re-searches this
// same verb-to-noun span when the pattern's own greedy noun pick turns out
// to be an excluded ordinary compound.
const POLICY_OVERRIDE_WINDOW_CHARS = 60;
const POLICY_OVERRIDE_PATTERN = new RegExp(
  `\\b(${POLICY_OVERRIDE_VERB_SOURCE})\\b[\\s\\S]{0,${POLICY_OVERRIDE_WINDOW_CHARS}}\\b(${POLICY_OVERRIDE_NOUN_SOURCE})\\b`,
  'i',
);
// Reused by findNegationWithinTwoWordsAfter to stop the post-verb scan once
// the phrase's own noun is reached -- a negation word past the noun negates
// the *next* clause, not this trigger.
const POLICY_OVERRIDE_NOUN_PATTERN = new RegExp(
  `\\b(${POLICY_OVERRIDE_NOUN_SOURCE})\\b`,
  'i',
);
// #2468: the pattern's `[\s\S]{0,60}` window has no concept of a Markdown
// heading boundary, so a verb ending one line -- most commonly this
// repository's issue title, given the near-universal repeated-title-as-H1
// body convention -- can pair with a noun that is only the leading word of
// an unrelated heading starting immediately after. The heading is a
// structural label, not a continuation of the verb's own sentence.
// Excluding a heading-adjacent noun this way, rather than special-casing
// only the title/body boundary, also covers a later `##` subheading whose
// own leading noun coincidentally follows a verb from the end of the prior
// paragraph. A genuine directive that does not cross a heading line is
// unaffected -- including one deliberately split across the title/body
// boundary with no heading in between (see the dedicated regression test
// pinning this as distinct from "never match across the title/body split
// at all"). CommonMark/GFM (what GitHub renders issue bodies with) also
// allows a 1-3 space indent before the `#` run and still treats the line
// as an ATX heading (#2468 critique finding 2), so the leading-space class
// is optional-bounded rather than requiring the `#` at column 0.
const HEADING_LINE_BOUNDARY_PATTERN = /\n {0,3}#{1,6}[ \t]/;

/**
 * True when `nounStart` (start of the matched noun) falls on the same
 * physical line as ANY Markdown ATX heading marker (`\n {0,3}#{1,6}[\t ]`)
 * that starts somewhere between `verbEnd` (end of the matched verb) and
 * `nounStart` -- i.e. the noun is itself part of an unrelated heading's own
 * text, not prose several lines further into the body (#2468 critique
 * finding 1: a heading merely *appearing* in the gap, with the noun landing
 * on a later, ordinary prose line, must not suppress a genuine directive).
 * Checks every heading found in the gap, not only the first (#2468 critique
 * round 2: a first heading whose own line does not reach the noun must not
 * short-circuit a second heading further along whose line does). `scanSource`
 * must always be `maskedText` -- both `findGenuineNounMatch` call sites in
 * `findPolicyOverrideMatch` pass it here even in the raw-fallback loop
 * (which otherwise scans raw `text`), so a heading marker inside a masked
 * code region -- already replaced with spaces -- cannot itself manufacture
 * a boundary (#2468 critique finding 1's code-comment-as-heading bypass).
 */
function matchCrossesHeadingBoundary(
  scanSource: string,
  verbEnd: number,
  nounStart: number,
): boolean {
  if (nounStart <= verbEnd) {
    return false;
  }
  const gap = scanSource.slice(verbEnd, nounStart);
  const headingPattern = new RegExp(HEADING_LINE_BOUNDARY_PATTERN.source, 'g');
  let headingMatch: RegExpExecArray | null;
  while (true) {
    headingMatch = headingPattern.exec(gap);
    if (headingMatch === null) {
      return false;
    }
    const headingLineStart = verbEnd + headingMatch.index + 1;
    const nextNewline = scanSource.indexOf('\n', headingLineStart);
    const headingLineEnd = nextNewline === -1 ? scanSource.length : nextNewline;
    if (nounStart <= headingLineEnd) {
      return true;
    }
    if (headingPattern.lastIndex === headingMatch.index) {
      headingPattern.lastIndex += 1;
    }
  }
}

// #2219: broadens checkAutonomy's coordination-language matcher beyond its two
// original fixed templates (requires .../stakeholder ... sign-off) to catch
// equally natural phrasings for the same unresolved human-coordination
// dependency -- reported by an adopter as passing checkAutonomy under
// different wording. Deliberately excludes a bare "unresolved" alternative:
// this repository's own instruction files use that word constantly for
// unrelated concepts (unresolved review threads, unresolved roadmap
// descendants), so only the multi-word "unresolved decision/question/choice"
// phrasing is included.
const UNRESOLVED_CHOICE_SOURCE =
  '(?:TBD|to be determined|still undecided|undecided|not (?:yet )?decided|unresolved (?:decision|question|choice)|pending (?:a |the )?(?:decision|approval)|open question(?:s)? for (?:the )?(?:maintainer|team|stakeholders?)|awaiting (?:a |the )?(?:decision|approval|input)|maintainer (?:to |must |needs to )?(?:decide|choose))';
const UNRESOLVED_CHOICE_PATTERN = new RegExp(
  `\\b${UNRESOLVED_CHOICE_SOURCE}\\b`,
  'gi',
);
// #2219: an either/or acceptance-criterion shape naming two mutually
// exclusive implementation paths. Only flagged together with an
// un-negated UNRESOLVED_CHOICE_PATTERN match nearby (see checkAutonomy) --
// the either/or structure alone also describes an ordinary AC offering two
// already-resolved, equivalent options, which must keep passing.
const EITHER_OR_PROXIMITY_WINDOW_CHARS = 120;
const EITHER_OR_PATTERN = new RegExp(
  `\\beither\\b[\\s\\S]{0,${EITHER_OR_PROXIMITY_WINDOW_CHARS}}?\\bor\\b`,
  'gi',
);
// Window checkAutonomy's negation checks scan on either side of a match --
// shared by the coordination-language, unresolved-choice, and either/or
// marker checks via isNegatedNearby below.
const NEGATION_WINDOW_CHARS = 60;
/**
 * True when a negation word (NEGATION_PATTERN) appears within
 * `windowChars` immediately before or after `matchText` at `matchIndex`
 * in `body` -- e.g. "no longer TBD" negates a "TBD" match rather than
 * confirming it. Used by checkAutonomy's coordination-language,
 * unresolved-choice, and either/or marker checks (#2219).
 */
function isNegatedNearby(
  body: string,
  matchText: string,
  matchIndex: number,
  windowChars: number,
): boolean {
  const contextBefore = body.slice(
    Math.max(0, matchIndex - windowChars),
    matchIndex,
  );
  const contextAfter = body.slice(
    matchIndex + matchText.length,
    Math.min(body.length, matchIndex + matchText.length + windowChars),
  );
  return (
    NEGATION_PATTERN.test(contextBefore) || NEGATION_PATTERN.test(contextAfter)
  );
}
// A Markdown paragraph break: two newlines with only horizontal
// whitespace (spaces/tabs) between them -- a blank line still counts
// as a break even when it carries trailing whitespace (Copilot review,
// #2508).
const PARAGRAPH_BREAK_PATTERN = /\n[ \t]*\n/;
// A decoration typical of a compact label/mapping entry -- a
// hyphenated or slash-joined slug, an "->" mapping arrow, or a code
// span -- rather than ordinary prose (#2508). Matched only after
// collapsing "a -> b" whitespace in looksLikeLabelEntry, so this must
// find decoration in what is otherwise a single whitespace-free token,
// not merely somewhere inside a multi-word phrase (Copilot/CodeRabbit
// review round 3: a lone hyphen used as prose punctuation, e.g.
// "blocking this work - resolve later", or a plain dictionary word
// with no decoration at all, e.g. "unfortunately", must not qualify).
const LABEL_ENTRY_DECORATION_PATTERN = /[-/`]/;
// An "a -> b" mapping arrow with any surrounding whitespace (including
// a hand-wrapped newline), collapsed to a bare "->" before the
// whitespace check below so a wrapped mapping still counts as one
// compact token.
const LABEL_ENTRY_ARROW_PATTERN = /\s*->\s*/g;
/**
 * True when `segment` (one comma-delimited entry from a parenthetical,
 * excluding the marker's own entry) reads as a compact label name or
 * label-to-label mapping -- e.g. "not-yet-ready" or
 * "undecided -> `needs-decision`" -- rather than an ordinary multi-word
 * phrase. After collapsing "->" mapping whitespace, the *entire* entry
 * must contain no remaining whitespace and must carry a hyphen, slash,
 * or backtick; a plain word with none of those (e.g. "unfortunately")
 * or a multi-word phrase that merely contains a hyphen somewhere (e.g.
 * "blocking this work - resolve later") does not qualify. Used by
 * isEnumeratedParentheticalEntry to require every *other* entry in the
 * list to look like fixed vocabulary before excluding the marker: a
 * genuine aside such as "(still undecided, blocking this work)" has an
 * ordinary-prose other entry ("blocking this work") and must not be
 * excluded.
 */
function looksLikeLabelEntry(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const collapsed = trimmed.replace(LABEL_ENTRY_ARROW_PATTERN, '->');
  if (/\s/.test(collapsed)) {
    return false;
  }
  return LABEL_ENTRY_DECORATION_PATTERN.test(collapsed);
}
/**
 * True when the UNRESOLVED_CHOICE_PATTERN match at `matchIndex` sits
 * inside a parenthetical enumerating a fixed vocabulary -- e.g.
 * "(undecided, waits-on-person/credential, order-dependency,
 * not-yet-ready)" -- evidence the match names one entry in that
 * vocabulary rather than a claim about this issue's own open next step
 * (#2508). Every comma-delimited entry other than the marker's own
 * must look like a compact label name (looksLikeLabelEntry); a
 * parenthetical with no comma, or one whose other entries read as
 * ordinary prose (e.g. "(still undecided, blocking this work)"), still
 * counts as a genuine unresolved marker and is not excluded. A
 * paragraph break inside the span means the "(" and ")" belong to
 * unrelated parentheticals in different paragraphs, not one enclosing
 * span -- rejected -- but a single soft-wrapped newline inside one
 * hand-wrapped Markdown paragraph does not end the span.
 */
function isEnumeratedParentheticalEntry(
  body: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  const openIndex = body.lastIndexOf('(', matchIndex);
  if (openIndex === -1) {
    return false;
  }
  const before = body.slice(openIndex + 1, matchIndex);
  if (before.includes(')') || PARAGRAPH_BREAK_PATTERN.test(before)) {
    return false;
  }

  const closeIndex = body.indexOf(')', matchIndex + matchLength);
  if (closeIndex === -1) {
    return false;
  }
  const after = body.slice(matchIndex + matchLength, closeIndex);
  if (after.includes('(') || PARAGRAPH_BREAK_PATTERN.test(after)) {
    return false;
  }
  if (!before.includes(',') && !after.includes(',')) {
    return false;
  }

  const beforeEntries = before.split(',').slice(0, -1);
  const afterEntries = after.split(',').slice(1);
  const otherEntries = [...beforeEntries, ...afterEntries];
  return otherEntries.length > 0 && otherEntries.every(looksLikeLabelEntry);
}
const ACCEPTANCE_CRITERIA_PATTERN = /^#+\s*Acceptance\s+Criteria\s*$/im;
// #2589: a bullet under "## Acceptance Criteria" that names something
// concrete -- an inline-code span (covers a quoted file path, command, or
// identifier) or a bare dotted filename -- is substantive on its own,
// independent of OUTCOME_SIGNAL_PATTERN's closed English vocabulary. Check 5
// (actionability) already accepts the same checklist as actionable; this
// keeps Check 7 from re-gating it behind a keyword spot-check the
// checklist's own content already satisfies. Deliberately has no bare
// slash-path alternative: `\bfoo\/bar\b` alone also matches an ordinary
// conjunction like "and/or" or "read/write" with no real path underneath --
// a real file path in this repo's AC bullets is either backticked or ends
// in a dotted extension, both already covered below.
//
// Copilot review (PR #2602) flagged, across two passes, that treating ANY
// inline-code span as substantive lets a backticked placeholder --
// "- [ ] `TODO`", "- [ ] `N/A`", "- [ ] `TODO later`" -- wrongly pass. A
// code span now needs a structural signal of being a real
// path/command/identifier (a slash, dot, underscore, colon, or hyphen)
// AND its leading token (split on whitespace, colon, or hyphen -- not
// slash, so a slash-joined token like "N/A" itself stays intact) must not
// exactly match a short, closed placeholder-token list. Checking only the
// lead token (not the whole span) catches a trailing-punctuation or
// trailing-word variant ("TODO-later", "TODO: fix", "N/A yet") without
// having to enumerate every such phrase.
const PLACEHOLDER_TOKEN_PATTERN =
  /^(?:TODO|TBD|N\/A|NA|XXX|FIXME|WIP|PENDING|PLACEHOLDER|NONE|ASAP)$/i;
const CODE_SPAN_STRUCTURE_PATTERN = /[/._:-]/;
const BARE_DOTTED_FILENAME_PATTERN = /\b[\w-]{2,}\.[a-zA-Z]{1,5}\b/;

function looksLikePlaceholder(content: string): boolean {
  const leadToken = content.split(/[\s:-]+/)[0] ?? '';
  return PLACEHOLDER_TOKEN_PATTERN.test(leadToken);
}

function hasSubstantiveBullet(text: string): boolean {
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const content = (match[1] ?? '').trim();
    if (
      content.length > 0 &&
      CODE_SPAN_STRUCTURE_PATTERN.test(content) &&
      !looksLikePlaceholder(content)
    ) {
      return true;
    }
  }
  return BARE_DOTTED_FILENAME_PATTERN.test(text);
}
// A heading line such as "## Decision (resolved 2026-06-27)" records that a
// human has already ruled on the issue's open question (see Check 7). The
// negative lookahead rejects only a still-open *phrase* that directly negates
// "resolved" ("not [yet] [been] resolved", "to be resolved", "never [been]
// resolved"), so an unrelated negator elsewhere on the line — e.g. "Decision
// (not user-facing; resolved 2026-06-27)" — still counts as resolved. A
// lookahead (not a variable-length lookbehind) keeps the assertion portable
// across JavaScript regex engines.
const RESOLVED_DECISION_PATTERN =
  /^#{1,6}\s+Decision\b(?![^\n]*\b(?:not(?:\s+yet)?(?:\s+been)?\s+resolved|(?:to\s+be|yet\s+to\s+be|remains?\s+to\s+be)\s+resolved|never(?:\s+been)?\s+resolved)\b)[^\n]*\bresolved\b/im;

// #2024: a negation word immediately before the trigger verb, allowing at
// most one intervening word (e.g. "does not *ever* skip") between the
// negation word and the trailing whitespace that reaches the verb. The
// intervening word may not contain clause-terminating punctuation
// (`.!?;,:`) -- otherwise an unrelated negation ending the *previous*
// clause (e.g. "Do not warn. Ignore repository policy." or "Do not warn,
// ignore repository policy." or "Do not warn: ignore repository policy.")
// would count as "immediately before" a later, unrelated directive.
// Anything wider than one clean word also risks reaching into a prior
// occurrence several words back. #2040: the colon is included alongside
// the other clause-boundary punctuation -- a colon introduces an
// explanation, list, or quoted directive after an independent clause just
// as a period or semicolon does.
// #2024: the post-verb negation word list deliberately excludes "ignore"
// and "skip" -- both trigger verbs *and* negation words -- so a chained
// directive ("Ignore and skip repository policy.") is never misread as the
// second verb negating the first. #2041: the before-check uses this same
// narrowed list, otherwise an independent first trigger sitting just
// outside POLICY_OVERRIDE_PATTERN's 60-character window is misread as
// negating a later trigger ("Ignore and override … repository policy").
// `[^\\s.!?;,:]*` after the negation word tolerates that word's own
// closing Markdown delimiter with no extra whitespace ("**not** skip").
const POST_VERB_NEGATION_PATTERN =
  /\b(not|no|don'?t|doesn'?t|can'?t|won'?t|never|avoid|omit|exempt)\b/i;

const NEGATION_IMMEDIATELY_BEFORE_PATTERN = new RegExp(
  `${POST_VERB_NEGATION_PATTERN.source}[^\\s.!?;,:]*(?:\\s+[^\\s.!?;,:]+){0,1}\\s*$`,
  'i',
);
// A clause boundary (sentence-ending punctuation, a comma/semicolon, or a
// colon) stops the post-verb scan outright -- see
// findNegationWithinTwoWordsAfter's clause terminator check for why
// (#2024 round 2, "Disable workflow; no notifications." /
// "Disable workflow, no notifications."; #2040, "Disable workflow: no
// notifications.").
const CLAUSE_TERMINATOR_PATTERN = /[.!?;,:]/;

// #2041: scan from the trigger to the phrase's own noun or a clause
// boundary, whichever comes first -- not a fixed two-word cap -- so a
// negation such as "should absolutely never touch the workflow" still
// counts. Visibility is the exact matched negation span, so a fully
// masked "not" glued to a visible suffix (`not`-optional) stays inert.
// A negation whose next word is a gerund/participle ("not following")
// modifies that later verb, not this trigger; skipping it preserves the
// #2024 noun-clause case that a naive scan-to-noun would treat as safe.
// A negation past the noun or a terminator belongs to the next clause
// ("Disable workflow no questions asked." / "Disable workflow; no
// notifications."), same as #2024 / #2040.
function findNegationWithinTwoWordsAfter(
  rawSource: string,
  maskedSource: string,
  afterStart: number,
  getCodeRangeAt: (start: number) => { start: number; end: number } | null,
): boolean {
  const substring = rawSource.slice(afterStart);

  const termMatch = CLAUSE_TERMINATOR_PATTERN.exec(substring);
  const firstTerminator = termMatch ? termMatch.index : Infinity;

  // #2408: skip a noun match `isOrdinaryHyphenatedCompoundToken` would
  // itself exclude from POLICY_OVERRIDE_PATTERN (e.g. the hyphen-adjacent
  // "check" in "per-check") when locating the phrase's own noun boundary --
  // otherwise a negation that comes after an excluded compound but before
  // the directive's real, genuine noun is wrongly read as belonging to a
  // later clause and the directive stays (wrongly) un-negated.
  const genuineNoun = findGenuineNounMatch(
    rawSource,
    afterStart,
    rawSource,
    getCodeRangeAt,
    Infinity,
    false,
    null,
  );
  const firstNoun = genuineNoun ? genuineNoun.relativeIndex : Infinity;

  const boundary = Math.min(firstTerminator, firstNoun);

  const negRegex = new RegExp(POST_VERB_NEGATION_PATTERN.source, 'gi');
  while (true) {
    const negationMatch = negRegex.exec(substring);
    if (negationMatch === null || negationMatch.index > boundary) {
      break;
    }
    const matchText = negationMatch[0] ?? '';
    const negStart = afterStart + negationMatch.index;
    const negEnd = negStart + matchText.length;
    const maskedSpan = maskedSource.slice(negStart, negEnd);
    if (maskedSpan.trim() === '') {
      continue;
    }
    const rest = substring.slice(negationMatch.index + matchText.length);
    // Optional Markdown wrappers around the gerund (emphasis or inline
    // code around "following") so those delimiters do not hide the skip.
    if (/^\s+[*_`~]*[A-Za-z]+ing\b/.test(rest)) {
      continue;
    }
    return true;
  }
  return false;
}

// #2024 / #2041: the detector must not fire on a negated instance of its
// own trigger pattern (e.g. "does not skip the required checks"). A match
// is negated when a narrowed (non-trigger) negation word appears either
// immediately before the trigger, or anywhere after it before the phrase's
// own noun or a clause boundary. NEGATION_PATTERN stays the source for
// checkRepositoryFit and the coordination-match loop later in this file.
//
// Several deliberate choices keep this from misfiring, each closing a gap a
// review round found empirically (dedicated regression coverage exists for
// every one of them):
//
// 1. Always locate candidate negation words via `maskedSource`
//    (position-preserving, code-masked) for the before-check, never raw
//    `rawSource`, even when the caller is inspecting a raw-text fallback
//    match. A prior or later occurrence sitting inside code (inert) is
//    masked to spaces there, so it can never be mistaken for real negation
//    context.
// 2. Stop the after-verb scan at the first policy noun or clause
//    terminator, and skip a negation that only modifies a later gerund;
//    see findNegationWithinTwoWordsAfter above for the full rationale.
// 3. Cross-check the "before" case's whitespace gap against `rawSource`
//    too, not just `maskedSource`: a masked-out code region collapses to
//    pure whitespace in `maskedSource`, so an unrelated negation word
//    before a masked span (e.g. "This marker is *not* `safe;` ignore
//    repository policy.") would otherwise look "immediately before" a
//    later, genuine directive once the code span vanishes. A raw
//    character in the gap is still allowed when it is literally the
//    backtick *delimiter* of the same code range the verb itself sits
//    inside (that range's own opening delimiter, e.g. the backtick in
//    "does not `skip`") -- content-bearing characters inside that same
//    range are never transparent (only the delimiter is), or a directive
//    could be smuggled inside the verb's own span (e.g. "not `safe;
//    skip the` repository policy" -- the `safe; ` text sits in the same
//    range as `skip` but is not itself a delimiter, so it must still
//    break the adjacency). A *separate*, already-closed code range fully
//    inside the gap (F3's `safe;`) breaks the adjacency the same way.
function isNegatedPolicyOverrideMatch(
  rawSource: string,
  maskedSource: string,
  matchIndex: number,
  verb: string,
  getCodeRangeAt: (start: number) => { start: number; end: number } | null,
): boolean {
  const beforeStart = Math.max(0, matchIndex - 100);
  const contextBefore = maskedSource.slice(beforeStart, matchIndex);
  const beforeMatch = NEGATION_IMMEDIATELY_BEFORE_PATTERN.exec(contextBefore);
  if (beforeMatch) {
    const trailingWhitespace = /\s*$/.exec(beforeMatch[0])?.[0] ?? '';
    const gapStart = matchIndex - trailingWhitespace.length;
    const verbCodeRange = getCodeRangeAt(matchIndex);
    let gapIsClear = true;
    for (let cursor = gapStart; cursor < matchIndex; cursor += 1) {
      const rawChar = rawSource[cursor] ?? '';
      if (/\s/.test(rawChar)) {
        continue;
      }
      if (
        rawChar === '`' &&
        verbCodeRange &&
        cursor >= verbCodeRange.start &&
        cursor < verbCodeRange.end
      ) {
        continue;
      }
      gapIsClear = false;
      break;
    }
    if (gapIsClear) {
      return true;
    }
  }
  const afterVerbStart = matchIndex + verb.length;
  return findNegationWithinTwoWordsAfter(
    rawSource,
    maskedSource,
    afterVerbStart,
    getCodeRangeAt,
  );
}

// #2408: shared by findNegationWithinTwoWordsAfter's boundary computation
// and findPolicyOverrideMatch's noun re-pick -- both need "a noun match
// starting at or after `afterStart`, in `searchText`, that
// isOrdinaryHyphenatedCompoundToken would NOT exclude," skipping any
// candidate that fails the same code-range + compound-classifier gate
// `findPolicyOverrideMatch` already applies to a verb match. `maxChars`
// bounds only the GAP before a candidate noun's own start position
// (mirroring POLICY_OVERRIDE_PATTERN's `[\s\S]{0,N}`, which limits what
// comes BEFORE the noun, not the noun's own length -- the search text
// itself stays unbounded on the right, or a noun whose start falls within
// the gap but whose own characters extend past it would be truncated
// mid-word and silently fail to match); pass `Infinity` for an unbounded
// scan (the negation-boundary use, which must reach the phrase's own noun
// regardless of distance).
//
// `preferFarthest` selects which surviving candidate to return:
// - `false` (negation boundary): the NEAREST one, matching the original
//   single, non-looping `nounRegex.exec` call this replaces.
// - `true` (findPolicyOverrideMatch's noun re-pick): the FARTHEST one,
//   matching POLICY_OVERRIDE_PATTERN's own greedy `[\s\S]{0,N}` -- greedy
//   backtracking tries the longest gap first and returns on the first
//   syntactic match found working backward, so it naturally lands on the
//   farthest candidate. Re-picking the nearest one instead would silently
//   shrink the reported evidence span whenever an earlier valid noun sits
//   before the one the pattern itself would have chosen.
// #2468: `headingBoundary`, when passed, is `findPolicyOverrideMatch`'s two
// call sites opting a candidate noun into the same heading-crossing
// exclusion `matchCrossesHeadingBoundary` applies elsewhere -- checked
// per-candidate here (not once against the pattern's own raw capture)
// so a heading-excluded farthest candidate correctly falls back to a
// nearer genuine one instead of the whole verb occurrence being dropped.
// `findNegationWithinTwoWordsAfter`'s unrelated negation-boundary use
// passes no `headingBoundary` (`null`), since a heading crossing has no
// bearing on where that scan should stop. Always checked against
// `headingBoundary.maskedText`, never `searchText`/`rawSource` directly
// -- `searchText` is raw `text` in the raw-fallback call, and a
// heading-shaped line inside a masked code region must not forge a
// boundary (see `matchCrossesHeadingBoundary`'s own doc comment).
// `maskedText` and `text` are position-preserving, so `absoluteIndex`
// (computed against whichever `searchText` this call scans) locates the
// same character in either.
function findGenuineNounMatch(
  searchText: string,
  afterStart: number,
  rawSource: string,
  getCodeRangeAt: (start: number) => { start: number; end: number } | null,
  maxChars: number,
  preferFarthest: boolean,
  headingBoundary: { maskedText: string; verbEnd: number } | null,
): { relativeIndex: number; length: number } | null {
  const substring = searchText.slice(afterStart);
  const nounRegex = new RegExp(POLICY_OVERRIDE_NOUN_PATTERN.source, 'gi');
  let nounMatch: RegExpExecArray | null;
  let farthest: { relativeIndex: number; length: number } | null = null;
  while (true) {
    nounMatch = nounRegex.exec(substring);
    if (nounMatch === null || nounMatch.index > maxChars) {
      return farthest;
    }
    const absoluteIndex = afterStart + nounMatch.index;
    // #2408: a candidate noun sitting inside a masked code range always
    // counts as a genuine (non-excluded) match, the same way the verb side
    // already treats a code-wrapped bare key (#2407 review round 5): being
    // wrapped in code at all is itself the distinguishing signal a bare
    // hyphenated compound in prose lacks, so a directive referencing a
    // listed noun via a code-wrapped identifier (e.g. `` `per-check` ``)
    // stays detectable even though the same bare, un-code-wrapped text in
    // prose is a deliberately accepted ordinary-compound exclusion.
    if (
      (getCodeRangeAt(absoluteIndex) ||
        !isOrdinaryHyphenatedCompoundToken(rawSource, absoluteIndex)) &&
      !(
        headingBoundary &&
        matchCrossesHeadingBoundary(
          headingBoundary.maskedText,
          headingBoundary.verbEnd,
          absoluteIndex,
        )
      )
    ) {
      const candidate = {
        relativeIndex: nounMatch.index,
        length: nounMatch[0].length,
      };
      if (!preferFarthest) {
        return candidate;
      }
      farthest = candidate;
    }
    if (nounRegex.lastIndex === nounMatch.index) {
      nounRegex.lastIndex += 1;
    }
  }
}

// #2399/#2407: a true prose boundary immediately before a hyphenated run's
// own word-character origin -- whitespace, or one of the wrapping
// delimiters this file already treats as optional token punctuation
// elsewhere (backtick, single/double quote, open paren; see
// SUPPLIED_CONTENT_OBJECT_REFERENCE above). Deliberately minimal, and
// deliberately NOT grown to cover every prose-punctuation character that
// might directly abut a flag with no whitespace (colon, period, comma, ...,
// #2407 review round 6, Copilot): isOrdinaryHyphenatedCompoundToken only
// ever tests this pattern against the single character immediately before
// a `[\w-]` run's own origin, never against a character INSIDE that run --
// so adding a character here can only ever narrow (never widen) which runs
// get excluded, and can never create a bypass for a flag token that
// happens to contain that character internally (e.g. a dotted config key
// like `--config.force-skip`, or `--env:force-skip`). See that function's
// own comment for why the run itself is walked with a fixed `[\w-]`
// character class rather than this boundary set.
const COMPOUND_TOKEN_BOUNDARY_PATTERN = /[\s\x60'"(]/;

// #2399: `#2218` wrapped `POLICY_OVERRIDE_NOUN_SOURCE` in a hyphen-boundary
// guard so an ordinary hyphenated compound noun (e.g. a file name like
// `idd-workflow-notes.md`) no longer false-positives Check 3. The verb
// list needed the equivalent exclusion for a hyphen-adjacent compound like
// "duplicate-evidence-skip check" (#2213's own title), but a regex
// lookbehind proved unable to also keep detecting a directive phrased as a
// CLI flag: `--skip`, `--skip-checks`, `--force-skip`, and (#2407 review
// round 4, Codex) non-hyphen-prefixed forms like `/force-skip` all put a
// hyphen directly before the verb too, indistinguishable from a genuine
// compound at any FIXED lookbehind distance -- only tracing the whole
// token back to where it truly begins tells them apart. A flag token
// (however it is itself prefixed) never begins with a word character at
// that origin; an ordinary compound word always does.
//
// Called from findPolicyOverrideMatch alongside isNegatedPolicyOverrideMatch,
// with the same "treat as inert, resume scanning after it" handling -- a
// verb classified here as part of an ordinary compound must not stop this
// checker from finding a later, genuine trigger. Every call site also gates
// this classifier on the verb not sitting inside a masked code range (#2407
// review round 5, Codex): a code-wrapped hyphenated key like
// `` `force-skip` `` carries a real, distinguishing shape signal -- being
// wrapped in code at all -- that bare prose lacks, and the raw-fallback
// pass already exists specifically to keep code-wrapped directives
// detectable (the `--skip` case this file's round-1 fix started with), so
// excluding a code-wrapped compound here would undercut that pass's own
// purpose. A BARE, unquoted, un-code-wrapped "force-skip" is deliberately
// left excluded (classified as an ordinary compound) even when meant as a
// directive: nothing distinguishes it, in shape alone, from #2213's own
// "evidence-skip" -- the exact false positive this whole guard exists to
// fix. Any rule general enough to also detect a bare "force-skip" detects
// bare "evidence-skip" too, reintroducing #2213 (see the dedicated
// regression test pinning this as a known, deliberate limit).
//
// The run of characters walked back from the verb's own leading hyphen
// uses a fixed `[\w-]` class -- letters, digits, underscore, and hyphen,
// exactly the characters that make up an ordinary hyphenated word or a
// hyphen-flag name -- rather than "any character not in
// COMPOUND_TOKEN_BOUNDARY_PATTERN" (#2407 review round 6, Copilot: a
// directive can directly abut a flag with no whitespace, e.g.
// "Pass:--skip repository policy"; growing the boundary set to also cover
// `:` closed that case, but any character added to a "boundary" set this
// way stops the walk *inside* an unrelated flag name too -- a dotted or
// colon-joined config key like `--config.force-skip` or `--env:force-skip`
// would then misclassify as excluded, a regression the boundary-list
// approach cannot avoid without an ever-growing, never-complete
// enumeration). Walking a fixed `[\w-]` run instead means the only
// question left is whether the character immediately before that run's
// own origin is a true prose boundary or not -- `.`, `:`, `=`, and every
// other symbol that can legally sit *inside* a flag name never stops the
// run early, so they can never manufacture a false "ordinary compound"
// classification, while still correctly closing the reported gap (that
// run now starts at the flag's own leading hyphen, not several characters
// further back across the punctuation).
//
// #2408: renamed from `isOrdinaryHyphenatedCompoundVerb` and reused
// unchanged for `POLICY_OVERRIDE_NOUN_SOURCE`'s leading side too -- every
// comment above describes the general "walk a hyphen run back to its own
// origin" mechanism, not anything specific to the verb word list, so the
// noun side needed no logic changes here, only a second call site in
// `findPolicyOverrideMatch` at the noun's own match position.
function isOrdinaryHyphenatedCompoundToken(
  rawSource: string,
  matchIndex: number,
): boolean {
  if (rawSource[matchIndex - 1] !== '-') {
    return false;
  }
  let cursor = matchIndex - 1;
  while (cursor > 0 && /[\w-]/.test(rawSource[cursor - 1] ?? '')) {
    // A double hyphen with no surrounding space directly preceded by a word character
    // ("time--skip") is prose punctuation -- a typewriter-style em/en dash
    // used as a clause separator -- not a compound-word joiner or a
    // flag-prefix hyphen chain (#2407 review round 7, Codex). A *real*
    // em/en dash character here was already detected before this change:
    // it fails the leading-hyphen guard clause above outright, since it
    // is not the ASCII '-' that clause checks for. This keeps the ASCII
    // typewriter substitute behaving the same way. Checking
    // `rawSource[cursor]` (not `rawSource[cursor - 1]`) for the first
    // hyphen of the pair matters: an ordinary single-hyphen compound like
    // "evidence-skip" also has a hyphen one step further back, and
    // conflating the two would wrongly stop the walk on every compound
    // joiner, not just a genuine double-hyphen separator.
    if (
      rawSource[cursor] === '-' &&
      rawSource[cursor - 1] === '-' &&
      /\w/.test(rawSource[cursor - 2] ?? '')
    ) {
      break;
    }
    cursor -= 1;
  }
  if (!/\w/.test(rawSource[cursor] ?? '')) {
    return false;
  }
  return (
    cursor === 0 ||
    COMPOUND_TOKEN_BOUNDARY_PATTERN.test(rawSource[cursor - 1] ?? '')
  );
}

function findPolicyOverrideMatch(
  text: string,
  maskedText: string,
  getCodeRangeAt: (start: number) => { start: number; end: number } | null,
): { index: number; text: string } | null {
  // #2408: POLICY_OVERRIDE_PATTERN's own greedy `[\s\S]{0,N}` backtracks
  // from the far end of the window inward, so its own noun capture (group
  // 2) is whichever syntactically valid noun sits FARTHEST from the verb,
  // not nearest -- and if that farthest candidate turns out to be an
  // excluded ordinary compound (e.g. "check" in "anti-check"), a nearer
  // genuine noun in the same window (e.g. "repository" right after the
  // verb) would otherwise never be tried, silently letting a real
  // directive through. Both passes below use the combined pattern only as
  // a cheap "is there any noun candidate in range at all" filter, then
  // independently re-pick the actual accepted noun via
  // findGenuineNounMatch (farthest-first, skipping excluded candidates,
  // including one whose position crosses a heading boundary from the verb
  // -- #2468 -- same selection direction the pattern's own backtracking
  // already used) rather than trusting the pattern's own capture.
  const maskedPattern = new RegExp(POLICY_OVERRIDE_PATTERN.source, 'gi');
  let maskedMatch: RegExpExecArray | null;
  while (true) {
    maskedMatch = maskedPattern.exec(maskedText);
    if (maskedMatch === null) {
      break;
    }
    const index = maskedMatch.index;
    const verb = maskedMatch[1] ?? '';
    if (
      (!getCodeRangeAt(index) &&
        isOrdinaryHyphenatedCompoundToken(text, index)) ||
      isNegatedPolicyOverrideMatch(
        text,
        maskedText,
        index,
        verb,
        getCodeRangeAt,
      )
    ) {
      // A negated (or ordinary-compound) match's own greedy span can reach
      // up to POLICY_OVERRIDE_WINDOW_CHARS past the verb and swallow a
      // second, genuine trigger further along (e.g. "does not skip the
      // release check. Ignore repository policy."). The engine already
      // auto-advanced lastIndex to the end of that whole span; rewind it to
      // resume scanning right after the skipped verb, so a later
      // independent trigger is never missed. Mirrors the code-only skip's
      // "resume just after the inert occurrence" rule below.
      maskedPattern.lastIndex = index + (verb.length || 1);
      continue;
    }
    const genuineNoun = findGenuineNounMatch(
      maskedText,
      index + verb.length,
      text,
      getCodeRangeAt,
      POLICY_OVERRIDE_WINDOW_CHARS,
      true,
      { maskedText, verbEnd: index + verb.length },
    );
    if (genuineNoun === null) {
      // Every noun candidate in this verb's window is an excluded ordinary
      // compound -- not a genuine trigger. Resume scanning after the verb.
      maskedPattern.lastIndex = index + (verb.length || 1);
      continue;
    }
    const nounEnd =
      index + verb.length + genuineNoun.relativeIndex + genuineNoun.length;
    return {
      index,
      text: text.slice(index, nounEnd),
    };
  }

  // A real directive may wrap one of its tokens in inline code. The masked
  // pass intentionally removes that token, so inspect raw matches as a
  // fallback and retain only matches that are not wholly inside code.
  const pattern = new RegExp(POLICY_OVERRIDE_PATTERN.source, 'gi');
  let match: RegExpExecArray | null;
  while (true) {
    match = pattern.exec(text);
    if (match === null) {
      break;
    }
    const index = match.index ?? -1;
    if (index < 0) {
      continue;
    }
    const verb = match[1] ?? '';
    if (
      (!getCodeRangeAt(index) &&
        isOrdinaryHyphenatedCompoundToken(text, index)) ||
      isNegatedPolicyOverrideMatch(
        text,
        maskedText,
        index,
        verb,
        getCodeRangeAt,
      )
    ) {
      // Same rewind as the masked-pass loop above: a negated or
      // ordinary-compound match's own greedy span can swallow a later,
      // genuine trigger.
      pattern.lastIndex = index + (verb.length || 1);
      continue;
    }
    const genuineNoun = findGenuineNounMatch(
      text,
      index + verb.length,
      text,
      getCodeRangeAt,
      POLICY_OVERRIDE_WINDOW_CHARS,
      true,
      { maskedText, verbEnd: index + verb.length },
    );
    if (genuineNoun === null) {
      pattern.lastIndex = index + (verb.length || 1);
      continue;
    }
    const end =
      index + verb.length + genuineNoun.relativeIndex + genuineNoun.length;
    const codeRange = getCodeRangeAt(index);
    if (codeRange) {
      const codeOnlyMatch = POLICY_OVERRIDE_PATTERN.exec(
        text.slice(index, codeRange.end),
      );
      if (codeOnlyMatch?.index === 0) {
        // The raw pattern may greedily span a code-only occurrence and a
        // later prose occurrence. Resume just after the inert occurrence, not
        // the entire code range: a later trigger in the same code span may
        // still form a cross-boundary match with visible prose after it.
        pattern.lastIndex = index + codeOnlyMatch[0].length;
        continue;
      }
    }
    let sawMaskedCharacter = false;
    let fullyMasked = true;
    for (let cursor = index; cursor < end; cursor += 1) {
      const rawCharacter = text[cursor];
      if (
        rawCharacter !== '\n' &&
        rawCharacter !== '\r' &&
        /\S/u.test(rawCharacter ?? '')
      ) {
        if (maskedText[cursor] !== ' ') {
          fullyMasked = false;
          break;
        }
        sawMaskedCharacter = true;
      }
    }
    if (
      !fullyMasked ||
      !sawMaskedCharacter ||
      !codeRange ||
      codeRange.start > index ||
      end > codeRange.end
    ) {
      return { index, text: text.slice(index, end) };
    }
  }
  return null;
}

function isUnsafeDirectiveSentenceEnd(raw: string, index: number): boolean {
  const char = raw[index];
  if (char !== '.' && char !== '?' && char !== '!') {
    return false;
  }
  let cursor = index + 1;
  while (
    raw[cursor] === ' ' ||
    raw[cursor] === '\t' ||
    raw[cursor] === '\n' ||
    raw[cursor] === '\r'
  ) {
    cursor += 1;
  }
  if (cursor >= raw.length) {
    return true;
  }
  const next = raw[cursor] ?? '';
  return /[A-Z]/.test(next);
}

// #2146: bound the verb-to-noun window at a sentence end or a blank line
// only. Comma, colon, and a single wrap newline are not clause ends —
// GitHub issue bodies are hard-wrapped, and `CLAUSE_TERMINATOR_PATTERN`
// exists to attribute negation on the other Check 3 screen. A `.` inside
// an identifier (Node.js) is not a sentence end: require following
// whitespace and an uppercase letter, or the end of the window.
function sliceUnsafeDirectiveWindow(source: string, start: number): string {
  const raw = source.slice(start, start + UNSAFE_DIRECTIVE_WINDOW_CHARS);
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === undefined) {
      break;
    }
    if (isUnsafeDirectiveSentenceEnd(raw, index)) {
      return raw.slice(0, index);
    }
    if (char !== '\n' && char !== '\r') {
      continue;
    }
    let cursor = index + 1;
    if (char === '\r' && raw[cursor] === '\n') {
      cursor += 1;
    }
    while (raw[cursor] === ' ' || raw[cursor] === '\t') {
      cursor += 1;
    }
    if (raw[cursor] === '\n' || raw[cursor] === '\r') {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function isVerbWhollyInBodyCode(
  verbStart: number,
  verbLength: number,
  bodyOffset: number,
  body: string,
  bodyCodeRanges: MarkdownCodeRange[],
): boolean {
  if (verbStart < bodyOffset) {
    return false;
  }
  const bodyStart = verbStart - bodyOffset;
  const range = getMarkdownCodeRange(body, bodyStart, bodyCodeRanges);
  return range !== null && bodyStart + verbLength <= range.end;
}

// #2146: new skip rules on this screen only. Do not copy
// findPolicyOverrideMatch — its raw fallback still fires when the whole
// match is not inside one code range, which is exactly the #1911
// false-positive (code-wrapped verb + later visible noun).
function findUnsafeExecutionDirectiveMatch(
  corpus: string,
  bodyOffset: number,
  body: string,
  bodyCodeRanges: MarkdownCodeRange[],
): string | null {
  const verbPattern = new RegExp(
    String.raw`\b${UNSAFE_DIRECTIVE_VERB}\b`,
    'gi',
  );
  const targetPattern = new RegExp(UNSAFE_DIRECTIVE_TARGET_SOURCE, 'i');
  let verbMatch: RegExpExecArray | null = verbPattern.exec(corpus);
  while (verbMatch) {
    const verbStart = verbMatch.index;
    const verbText = verbMatch[0] ?? '';
    if (
      !isVerbWhollyInBodyCode(
        verbStart,
        verbText.length,
        bodyOffset,
        body,
        bodyCodeRanges,
      )
    ) {
      const window = sliceUnsafeDirectiveWindow(
        corpus,
        verbStart + verbText.length,
      );
      const targetMatch = targetPattern.exec(window);
      if (targetMatch) {
        const targetStart = targetMatch.index ?? 0;
        const targetText = targetMatch[0] ?? '';
        return corpus.slice(
          verbStart,
          verbStart + verbText.length + targetStart + targetText.length,
        );
      }
    }
    verbMatch = verbPattern.exec(corpus);
  }
  return null;
}

if (import.meta.main) {
  runCli();
}

export function evaluateSuitability(
  issue: unknown,
  options: SuitabilityOptions = {},
): SuitabilityResult {
  const normalized = normalizeIssue(issue);
  const context: Context = {
    issue: normalized,
    repository: normalizeRepository(options.repository),
    duplicateCandidates: normalizeDuplicateCandidates(
      options.duplicateCandidates,
    ),
    trustSafetyAmbiguous: Boolean(options.trustSafetyAmbiguous),
    blockedByHumanLabelName: normalizeConfiguredLabelName(
      options.blockedByHumanLabelName,
      POLICY_DEFAULTS.labels.blockedByHumanLabelName,
    ),
    needsDecisionLabelName: normalizeConfiguredLabelName(
      options.needsDecisionLabelName,
      POLICY_DEFAULTS.labels.needsDecisionLabelName,
    ),
    highConfidenceDuplicate: normalizeHighConfidenceDuplicateInput(
      options.highConfidenceDuplicate,
    ),
    highConfidenceCollectionDegraded: Boolean(
      options.highConfidenceCollectionDegraded,
    ),
  };

  const checks: CheckResult[] = [];
  for (const check of CHECKS) {
    const result = check.evaluate(context);
    checks.push({
      id: check.id,
      name: check.name,
      result: result.pass ? 'pass' : 'fail',
      evidence: result.evidence,
      ...(result.tier ? { tier: result.tier } : {}),
    });
    if (!result.pass) {
      return {
        passed: false,
        outcome: check.failureOutcome,
        failedCheck: check.id,
        checks,
      };
    }
  }

  return {
    passed: true,
    outcome: 'ready',
    failedCheck: null,
    checks,
  };
}

export function checkRepositoryFit(context: Context): CheckOutcome {
  const { issue, repository } = context;
  if (!repository) {
    return {
      pass: true,
      evidence: 'Repository scope was not provided; check treated as pass.',
    };
  }

  const body = issue.body;
  const crossRepoLinks: string[] = [];
  const regex =
    /https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)\/(?:issues|pull)\/\d+/gi;
  let match: RegExpExecArray | null = regex.exec(body);
  while (match) {
    const owner = (match[1] ?? '').toLowerCase();
    const repo = (match[2] ?? '').toLowerCase();
    if (owner !== repository.owner || repo !== repository.repo) {
      crossRepoLinks.push(match[0]);
    }
    match = regex.exec(body);
  }
  if (crossRepoLinks.length > 0 && EXTERNAL_COORDINATION_PATTERN.test(body)) {
    return {
      pass: false,
      evidence: `Cross-repository references detected: ${crossRepoLinks.join(', ')}`,
    };
  }
  for (const match of body.matchAll(
    new RegExp(EXTERNAL_SYSTEM_ACCESS_PATTERN.source, 'gi'),
  )) {
    const matchIndex = match.index ?? 0;
    const matchText = match[0] ?? '';
    const contextBefore = body.slice(Math.max(0, matchIndex - 60), matchIndex);
    // Skip a negated non-requirement; only an un-negated external-access
    // requirement blocks Repository Fit. The negation may sit *before* the
    // match ("does **not** require production credentials") or *after* the
    // requirement verb inside the match ("requires **no** production
    // credentials").
    const negatedRequirement =
      /\b(?:requires?|needs?|must|depends?\s+on)\s+(?:no|not|never|without|n['’]?t)\b/i;
    if (
      NEGATION_PATTERN.test(contextBefore) ||
      negatedRequirement.test(matchText)
    ) {
      continue;
    }
    return {
      pass: false,
      evidence:
        'Issue requires external system access beyond repository scope.',
    };
  }

  return {
    pass: true,
    evidence:
      crossRepoLinks.length > 0
        ? 'Cross-repository links appear contextual; no explicit external coordination signal detected.'
        : 'No out-of-repository scope signals detected.',
  };
}

export function checkCoherence(context: Context): CheckOutcome {
  const { issue } = context;
  const title = issue.title.trim();
  const body = issue.body.trim();

  if (title.length < 5 || body.length < 20) {
    return {
      pass: false,
      evidence: 'Issue title/body is too short to infer reliable intent.',
    };
  }
  if (/<<<<<<<|=======|>>>>>>>/.test(body)) {
    return {
      pass: false,
      evidence: 'Issue body contains unresolved conflict markers.',
    };
  }
  return {
    pass: true,
    evidence: 'Issue body is structurally coherent and interpretable.',
  };
}

export function checkTrustSafety(context: Context): CheckOutcome {
  const { issue, trustSafetyAmbiguous } = context;
  const corpus = `${issue.title}\n${issue.body}`;

  if (trustSafetyAmbiguous) {
    return {
      pass: false,
      evidence: 'Trust/safety evaluation marked ambiguous; failing closed.',
    };
  }

  const matchedSecret = SECRET_PATTERNS.find((pattern) => pattern.test(corpus));
  if (matchedSecret) {
    return {
      pass: false,
      evidence: `Potential secret pattern detected: ${matchedSecret}`,
    };
  }

  // Check for explicit policy-override directives. Issue titles are plain
  // fields, not Markdown documents, so scan them raw. In the body, find the
  // directive on raw text and ignore it only when the entire match is inside
  // a valid Markdown code region. This keeps inert examples from firing while
  // preserving fail-closed behavior when code formatting wraps only part of a
  // real directive. The position-preserving mask keeps evidence offsets exact
  // even when a fenced block precedes the match.
  const bodyOffset = issue.title.length + 1;
  const bodyCodeRanges = findMarkdownCodeRanges(issue.body);
  const policyMatch = findPolicyOverrideMatch(
    corpus,
    `${issue.title}\n${maskMarkdownCodeRegionsPreservingPositions(issue.body, bodyCodeRanges)}`,
    (start) => {
      if (start < bodyOffset) {
        return null;
      }
      const range = getMarkdownCodeRange(
        issue.body,
        start - bodyOffset,
        bodyCodeRanges,
      );
      return range === null
        ? null
        : {
            start: range.start + bodyOffset,
            end: range.end + bodyOffset,
          };
    },
  );
  if (policyMatch) {
    return {
      pass: false,
      evidence: `Policy-override directive detected: "${policyMatch.text}". Untrusted policy-manipulation instructions cannot be processed.`,
    };
  }

  // Check for explicit unsafe execution directives. #2146: skip a verb
  // wholly inside a body code region, and stop the verb-to-noun window
  // at `.` / `?` / `!` or a blank line. Do not whole-corpus-mask — a
  // visible verb with a code-wrapped noun must still fail.
  const unsafeDirective = findUnsafeExecutionDirectiveMatch(
    corpus,
    bodyOffset,
    issue.body,
    bodyCodeRanges,
  );
  if (unsafeDirective) {
    return {
      pass: false,
      evidence: `Explicit unsafe execution directive detected: "${unsafeDirective}". Cannot execute untrusted user-provided instructions.`,
    };
  }

  // Inspect every unsafe-command occurrence across all patterns, not just
  // the first: an issue may discuss a command safely and then later direct
  // running it. Any single occurrence with an un-negated execution directive
  // in its local context fails the check.
  let sawUnsafeContextOnly = false;
  for (const pattern of UNSAFE_PATTERNS) {
    const directivePattern = new RegExp(
      `${EXECUTION_VERB_PATTERN.source}[\\s\\S]{0,80}${pattern.source}`,
      'i',
    );
    const negatedDirectivePattern = new RegExp(
      `\\b(do not|don't|never|avoid)\\s+(?:run|execute|paste|install|invoke)\\b[^\\n.!?]{0,60}${pattern.source}`,
      'i',
    );
    for (const occurrence of corpus.matchAll(
      new RegExp(pattern.source, 'gi'),
    )) {
      const unsafeIndex = occurrence.index ?? -1;
      const matchText = occurrence[0] ?? '';
      const contextStart = Math.max(0, unsafeIndex - 140);
      const contextEnd = Math.min(
        corpus.length,
        unsafeIndex + matchText.length + 40,
      );
      const localContext =
        unsafeIndex >= 0 ? corpus.slice(contextStart, contextEnd) : corpus;
      if (
        directivePattern.test(localContext) &&
        !negatedDirectivePattern.test(localContext)
      ) {
        return {
          pass: false,
          evidence: `Unsafe command execution pattern detected: ${pattern}`,
        };
      }
      sawUnsafeContextOnly = true;
    }
  }
  if (sawUnsafeContextOnly) {
    return {
      pass: true,
      evidence:
        'Unsafe command string appears as context only; no execution directive detected.',
    };
  }

  return {
    pass: true,
    evidence: 'No trust/safety blockers detected.',
  };
}

export function checkDuplicateOrSuperseded(context: Context): CheckOutcome {
  const highConfidence = evaluateHighConfidenceDuplicate(
    context.highConfidenceDuplicate,
    context.issue.number,
  );
  if (highConfidence) {
    return highConfidence;
  }

  const { issue, duplicateCandidates } = context;

  // #1484 (Codex P2 review finding): a genuine high-confidence
  // evidence-collection failure -- not "checked, found nothing" -- degrades
  // to exact-title matching ONLY, per the documented "Timeout on duplicate
  // detection... fall back to exact title match only" Edge Case. Skips the
  // free-text declaration scan and the near-duplicate fuzzy (>80%
  // Levenshtein) check entirely: a merely similarly-titled but genuinely
  // distinct issue must never read as a false duplicate just because
  // evidence collection broke.
  if (context.highConfidenceCollectionDegraded) {
    const degradedExactTitle = normalizeText(issue.title);
    const degradedExactMatch = duplicateCandidates.find(
      (candidate) =>
        candidate.number !== issue.number &&
        normalizeText(candidate.title) === degradedExactTitle,
    );
    if (degradedExactMatch) {
      return {
        pass: false,
        evidence: `Exact-title duplicate found: #${degradedExactMatch.number}`,
        tier: 'weak',
      };
    }
    return {
      pass: true,
      evidence:
        'High-confidence evidence collection failed; degraded to exact-title match only per the documented "Timeout on duplicate detection" Edge Case. No exact-title duplicate found.',
    };
  }

  const body = issue.body;

  const declarations = [...body.matchAll(DUPLICATE_DECLARATION_PATTERN)];
  for (const declaration of declarations) {
    const matched = declaration[0] ?? '';
    const index = declaration.index ?? 0;
    const prefix = body.slice(Math.max(0, index - 30), index);
    if (DUPLICATE_NEGATION_PATTERN.test(prefix)) {
      continue;
    }
    return {
      pass: false,
      evidence: `Issue body declares duplicate/superseded status: ${matched}`,
      tier: 'weak',
    };
  }

  const exactTitle = normalizeText(issue.title);
  const duplicate = duplicateCandidates.find((candidate) => {
    if (candidate.number === issue.number) {
      return false;
    }
    return normalizeText(candidate.title) === exactTitle;
  });
  if (duplicate) {
    return {
      pass: false,
      evidence: `Exact-title duplicate found: #${duplicate.number}`,
      tier: 'weak',
    };
  }

  // Near-duplicate detection: check for high similarity (>80% Levenshtein match)
  const nearDuplicate = duplicateCandidates.find((candidate) => {
    if (candidate.number === issue.number) {
      return false;
    }
    if (candidate.state === 'CLOSED') {
      return false;
    }
    const sim = computeSimilarity(exactTitle, normalizeText(candidate.title));
    return sim > 0.8;
  });
  if (nearDuplicate) {
    return {
      pass: false,
      evidence: `Near-duplicate found: #${nearDuplicate.number} ("${nearDuplicate.title}"). Title similarity >80%.`,
      tier: 'weak',
    };
  }

  return {
    pass: true,
    evidence:
      duplicateCandidates.length === 0
        ? 'No duplicate candidate matched.'
        : `Checked ${duplicateCandidates.length} duplicate candidates; no exact or near match.`,
  };
}

function computeSimilarity(str1: string, str2: string): number {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) {
    return 1;
  }
  const distance = levenshteinDistance(str1, str2);
  return (maxLen - distance) / maxLen;
}

function levenshteinDistance(str1: string, str2: string): number {
  const memo: Record<string, number> = {};
  function lev(i: number, j: number): number {
    if (i === 0) return j;
    if (j === 0) return i;
    const key = `${i},${j}`;
    if (memo[key] !== undefined) return memo[key];
    const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
    memo[key] = Math.min(
      lev(i - 1, j) + 1,
      lev(i, j - 1) + 1,
      lev(i - 1, j - 1) + cost,
    );
    return memo[key];
  }
  return lev(str1.length, str2.length);
}

export function checkActionability(context: Context): CheckOutcome {
  const { issue } = context;
  const body = issue.body;
  const hasAcceptance =
    /\bAcceptance Criteria\b|\bOutput\b|\bDeliverables\b/i.test(body);
  const hasChecklist = /^\s*[-*]\s+\[[ xX]\]/m.test(body);
  const hasSteps = /^\s*\d+\.\s+/m.test(body);

  if (hasAcceptance || hasChecklist || hasSteps) {
    return {
      pass: true,
      evidence:
        'Issue defines actionable scope and verifiable delivery details.',
    };
  }

  return {
    pass: false,
    evidence: 'Issue lacks concrete actionable scope or acceptance detail.',
  };
}

export function checkAutonomy(context: Context): CheckOutcome {
  const { issue } = context;
  const labels = new Set(issue.labels);
  const body = issue.body;
  const blockedLabels = new Set([
    normalizeConfiguredLabelName(
      context.blockedByHumanLabelName,
      POLICY_DEFAULTS.labels.blockedByHumanLabelName,
    ),
    normalizeConfiguredLabelName(
      context.needsDecisionLabelName,
      POLICY_DEFAULTS.labels.needsDecisionLabelName,
    ),
  ]);

  for (const label of blockedLabels) {
    if (labels.has(label)) {
      return {
        pass: false,
        evidence: `Blocking label present: ${label}`,
      };
    }
  }

  // #2219: an either/or acceptance-criterion shape naming two mutually
  // exclusive implementation paths without saying which one to take.
  // Checked before the standalone unresolved-choice scan further below:
  // both checks match against the same UNRESOLVED_CHOICE_PATTERN markers,
  // so checking either/or first is what makes this variant's own evidence
  // message reachable rather than always pre-empted by that later, more
  // generic match on the same marker. Requires an un-negated marker
  // touching or within EITHER_OR_PROXIMITY_WINDOW_CHARS of the either/or
  // span -- an ordinary AC offering two already-resolved, equivalent
  // options must keep passing, including when a resolved statement nearby
  // happens to mention a marker word in its own negated form (e.g. "this
  // is no longer TBD").
  const eitherOrMatches = [...body.matchAll(EITHER_OR_PATTERN)];
  if (eitherOrMatches.length > 0) {
    for (const marker of body.matchAll(UNRESOLVED_CHOICE_PATTERN)) {
      const markerText = marker[0] ?? '';
      const markerIndex = marker.index ?? 0;
      if (
        isNegatedNearby(body, markerText, markerIndex, NEGATION_WINDOW_CHARS)
      ) {
        continue;
      }
      if (
        isEnumeratedParentheticalEntry(body, markerIndex, markerText.length)
      ) {
        continue;
      }

      const markerEnd = markerIndex + markerText.length;
      const isNearOrInsideEitherOr = eitherOrMatches.some((eitherOr) => {
        const eitherOrText = eitherOr[0] ?? '';
        const eitherOrIndex = eitherOr.index ?? 0;
        const eitherOrEnd = eitherOrIndex + eitherOrText.length;
        if (markerIndex < eitherOrEnd && markerEnd > eitherOrIndex) {
          // The marker overlaps the either/or span itself (e.g. "either
          // TBD ... or ...").
          return true;
        }
        const gapAfterEitherOr = markerIndex - eitherOrEnd;
        const gapBeforeEitherOr = eitherOrIndex - markerEnd;
        return (
          (gapAfterEitherOr >= 0 &&
            gapAfterEitherOr <= EITHER_OR_PROXIMITY_WINDOW_CHARS) ||
          (gapBeforeEitherOr >= 0 &&
            gapBeforeEitherOr <= EITHER_OR_PROXIMITY_WINDOW_CHARS)
        );
      });

      if (!isNearOrInsideEitherOr) {
        continue;
      }

      return {
        pass: false,
        evidence:
          'Issue presents an unresolved either/or implementation choice.',
      };
    }
  }

  // Negation-aware parsing for external coordination and human decision requirements
  const coordinationMatches = [
    ...body.matchAll(
      /\brequires (?:maintainer|human|stakeholder) (?:decision|approval|sign-?off)\b/gi,
    ),
    ...body.matchAll(
      /\bstakeholder\b[\s\S]{0,80}\b(sign-?off|approval|decision)\b/gi,
    ),
  ];

  for (const match of coordinationMatches) {
    const matchedText = match[0] ?? '';
    const matchIndex = match.index ?? 0;
    if (isNegatedNearby(body, matchedText, matchIndex, NEGATION_WINDOW_CHARS)) {
      // This is a negated non-requirement; skip this match
      continue;
    }

    return {
      pass: false,
      evidence:
        'Issue explicitly requires external human coordination or approval.',
    };
  }

  // #2219: a nearby-word unresolved-choice phrasing beyond the two fixed
  // templates above -- TBD, to be determined, pending a decision, an open
  // question for the maintainer, and similar (see UNRESOLVED_CHOICE_SOURCE).
  for (const marker of body.matchAll(UNRESOLVED_CHOICE_PATTERN)) {
    const markerText = marker[0] ?? '';
    const markerIndex = marker.index ?? 0;
    if (isNegatedNearby(body, markerText, markerIndex, NEGATION_WINDOW_CHARS)) {
      continue;
    }
    if (isEnumeratedParentheticalEntry(body, markerIndex, markerText.length)) {
      continue;
    }

    return {
      pass: false,
      evidence: 'Issue names an unresolved product or design choice.',
    };
  }

  return {
    pass: true,
    evidence: 'No external coordination blockers detected.',
  };
}

export function checkVerifiability(context: Context): CheckOutcome {
  const { issue } = context;
  const body = issue.body;
  const hasVerificationChannel =
    /\btests?\b|\bverification\b|\bvalidate\b|\blint\b|\bci\b/i.test(body);

  // Check for substantive objective criteria, not just empty headings
  let hasObjectiveCriteria = false;

  // Check for "Acceptance Criteria" with substantive content after it
  const acceptanceCriteriaMatch = body.match(ACCEPTANCE_CRITERIA_PATTERN);
  if (acceptanceCriteriaMatch) {
    const indexAfter =
      (acceptanceCriteriaMatch.index ?? 0) +
      (acceptanceCriteriaMatch[0]?.length ?? 0);
    const contentAfter = body.slice(indexAfter, indexAfter + 500).trim();
    // Bound the AC section at the next heading so a trailing sibling
    // section (e.g. this repo's own "## Candidate files" convention, which
    // is itself a bullet list of paths) never leaks substance or an
    // outcome-signal keyword into a genuinely placeholder AC list (#2589).
    const nextHeadingIndex = contentAfter.search(/\n#{1,6}\s/);
    const listSection =
      nextHeadingIndex === -1
        ? contentAfter
        : contentAfter.slice(0, nextHeadingIndex);
    // Require either a list (starting with - or *) or numbered content. A
    // substantive bullet (hasSubstantiveBullet) satisfies this on its own;
    // an outcome-signal keyword remains a fallback for a list that names
    // no concrete file, command, or artifact (#2589).
    if (/^[-*]\s+/.test(listSection) || /^\d+\.\s+/.test(listSection)) {
      hasObjectiveCriteria =
        hasSubstantiveBullet(listSection) ||
        OUTCOME_SIGNAL_PATTERN.test(listSection);
    }
  }

  // Alternative: check for numbered steps with outcome signals or checklists
  if (!hasObjectiveCriteria) {
    const hasNumSteps =
      /^\s*\d+\.\s+/m.test(body) && OUTCOME_SIGNAL_PATTERN.test(body);
    const hasChecklist =
      /^\s*[-*]\s+\[[ xX]\]/m.test(body) && OUTCOME_SIGNAL_PATTERN.test(body);
    hasObjectiveCriteria = hasNumSteps || hasChecklist;
  }

  // Fallback: check for "Output", "Deliverables", or "Verification" keywords with signal words
  if (!hasObjectiveCriteria) {
    hasObjectiveCriteria =
      /\b(?:Output|Deliverables|Verification)\b[\s\S]{0,300}(?:must|should|required|contains|includes|result)/i.test(
        body,
      );
  }

  const hasObjectiveSignals = hasVerificationChannel || hasObjectiveCriteria;

  if (!hasObjectiveSignals) {
    return {
      pass: false,
      evidence:
        'Issue does not provide objective verification signals or substantive acceptance criteria.',
    };
  }
  const hasSubjectiveApproval = ((): boolean => {
    // Normalized once so every offset computed below (line-split cursor,
    // paragraph spans, proximity match index) shares the same 1-char line
    // separator -- a raw `\r\n` body otherwise drifts the running
    // `lineOffset` cursor by 1 byte per CRLF line, eventually pointing
    // `isFramedAsDescriptive` at the wrong paragraph (#2531 review).
    const normalizedBody = body.replace(/\r\n/g, '\n');
    const paragraphSpans = getParagraphSpans(normalizedBody);
    const isFramedAsDescriptive = (offset: number): boolean => {
      const span =
        paragraphSpans.find(
          (candidate) => offset >= candidate.start && offset <= candidate.end,
        ) ?? paragraphSpans[paragraphSpans.length - 1];
      return FRAMING_VERB_PATTERN.test(
        normalizedBody.slice(
          span?.start ?? 0,
          span?.end ?? normalizedBody.length,
        ),
      );
    };

    let lineOffset = 0;
    for (const line of normalizedBody.split('\n')) {
      if (
        SUBJECTIVE_SUBJECT_PATTERN.test(line) &&
        SUBJECTIVE_GATE_PATTERN.test(line) &&
        !isFramedAsDescriptive(lineOffset)
      ) {
        return true;
      }
      lineOffset += line.length + 1;
    }

    const proximityPattern = new RegExp(
      SUBJECTIVE_PROXIMITY_PATTERN.source,
      'gi',
    );
    let proximityMatch = proximityPattern.exec(normalizedBody);
    while (proximityMatch) {
      if (!isFramedAsDescriptive(proximityMatch.index)) {
        return true;
      }
      proximityMatch = proximityPattern.exec(normalizedBody);
    }

    return false;
  })();
  // A body that carries BOTH a resolved-decision marker (a
  // "## Decision (resolved …)" section) AND a concrete, objectively-verifiable
  // acceptance-criteria section is treated as having had its subjective call
  // already settled by a human, so its prose merely *describes* that prior
  // approval/decision. This is a soft heuristic for a soft advisory gate: it
  // co-occurrence-matches the two signals rather than proving the decision
  // resolves the exact approval wording, which is an accepted trade-off for
  // maintainer-authored issues. An approval-gated body with no resolved
  // decision still routes to needs-decision.
  const hasResolvedDecision = RESOLVED_DECISION_PATTERN.test(body);
  if (hasSubjectiveApproval && !(hasResolvedDecision && hasObjectiveCriteria)) {
    return {
      pass: false,
      evidence: 'Issue success depends on subjective approval or judgment.',
    };
  }

  return {
    pass: true,
    evidence:
      'Issue includes objective verification language and substantive criteria.',
  };
}

/**
 * #2102: `--issue`, `--body-file`, and `--stdin` select mutually exclusive
 * input modes; exactly one is required. Exported (and thus independently
 * testable) so both `throw` branches can be exercised without invoking
 * `runCli`'s own process-level side effects (env mutation, `gh` calls).
 */
export function resolveInputMode(
  args: Pick<SuitabilityTriageArgs, 'issue' | 'bodyFile' | 'stdin'>,
): 'issue' | 'local' {
  // Checks flag *presence* (`!== undefined`), not truthiness: `--body-file=`
  // parses to `''` under Node's util.parseArgs, and a truthy check would
  // silently fold that into "no mode selected" instead of the explicit,
  // actionable empty-path error thrown below.
  const inputModeCount =
    (args.issue !== null ? 1 : 0) +
    (args.bodyFile !== undefined ? 1 : 0) +
    (args.stdin ? 1 : 0);
  if (inputModeCount === 0) {
    throw new Error('one of --issue, --body-file, or --stdin is required');
  }
  if (inputModeCount > 1) {
    throw new Error('choose only one of --issue, --body-file, or --stdin');
  }
  if (args.bodyFile === '') {
    throw new Error('--body-file requires a non-empty path');
  }
  return args.bodyFile !== undefined || args.stdin ? 'local' : 'issue';
}

/**
 * #1485: `runCli`'s own Check 4 high-confidence evidence-collection block,
 * extracted (pure move, no behavior change) so `suitability-close-execute.mts`
 * can reuse the identical fetch orchestration instead of duplicating it --
 * `#1485`'s own acceptance criteria require the mechanical check to be
 * "reused, not duplicated." Assumes the caller has already confirmed Checks
 * 1-3 pass for this candidate (as `runCli`'s own `shouldCollectEvidence` gate
 * does; `suitability-close-execute.mts` only ever runs after A4.5's Decision
 * Flow has already reached Check 4 for the same reason) -- this function
 * itself applies no such gate and always collects.
 *
 * The three mechanical signals (closedByPullRequestsReferences, the
 * branch-name-exact-match lookup, and the same-candidate-files merged-PR
 * scan) are collected in separate try/catch blocks: an earlier version
 * wrapped the first two in one block, so a failure collecting the second
 * signal discarded an already-successful first signal too. Each block's own
 * failure is recorded independently in `collectionWarnings` and degrades
 * only that one signal to empty/absent -- never silently reported as "no
 * evidence" (that would mask a genuinely broken collector as a clean pass),
 * and never discarding a sibling signal that already collected cleanly.
 * `gh`/API fetch failures in any block are always recorded here; a
 * manifest-unavailable same-candidate-files skip (documented on
 * `loadHighContentionFiles` itself) is a distinct, deliberate degradation
 * rather than a genuine fetch failure, but it still pushes its own
 * `collectionWarnings` entry below -- Check 4 must degrade to exact-title-only
 * for this case exactly as it does for a real `gh`/API failure (Copilot
 * review finding on PR #2558: an earlier version of this comment claimed
 * the opposite). This is also why a failure here
 * never throws out to the caller -- this tier is an optional enhancement
 * layered onto Check 4, and Check 4's own documented Edge Case ("Timeout on
 * duplicate detection... fall back to exact title match only") already
 * anticipates exactly this degradation.
 */
export function collectHighConfidenceDuplicateEvidence(
  owner: string,
  repo: string,
  repoRef: string,
  issue: { number: number; title: string; body: string; createdAt: string },
  manifestPath: string,
  bundleIds: string[],
): {
  highConfidenceDuplicate: HighConfidenceDuplicateInput;
  collectionWarnings: string[];
} {
  const collectionWarnings: string[] = [];
  let closedByMergedPrNumbers: number[] = [];
  let candidateFiles: string[] = [];
  let highContentionFiles: string[] = [];
  let mergedPrs: HighConfidenceMergedPr[] = [];
  let branchNameMergedPr: { number: number; mergedAt: string } | null = null;

  try {
    closedByMergedPrNumbers = fetchClosedByMergedPrNumbers(
      owner,
      repo,
      issue.number,
    );
  } catch (error) {
    collectionWarnings.push(
      `closedByPullRequestsReferences: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    branchNameMergedPr = fetchMergedPrByBranchName(
      repoRef,
      computeBranchName(issue.number, issue.title),
      owner,
    );
  } catch (error) {
    collectionWarnings.push(
      `branch-name merged-PR lookup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    candidateFiles = parseCandidateFiles(issue.body);
    const resolvedHighContentionFiles =
      candidateFiles.length > 0
        ? loadHighContentionFiles(manifestPath, bundleIds)
        : null;
    const shouldScanMergedPrs =
      candidateFiles.length > 0 &&
      resolvedHighContentionFiles !== null &&
      issue.createdAt.length > 0;
    highContentionFiles = resolvedHighContentionFiles ?? [];
    if (candidateFiles.length > 0 && resolvedHighContentionFiles === null) {
      collectionWarnings.push(
        'same-candidate-files scan: high-contention manifest unavailable, skipping the scan',
      );
    }
    if (shouldScanMergedPrs) {
      const scanResult = fetchMergedPrFileOverlapEvidence(
        repoRef,
        issue.createdAt,
        candidateFiles,
        highContentionFiles,
        issue.number,
      );
      mergedPrs = scanResult.mergedPrs;
      if (scanResult.truncatedByDeadline) {
        collectionWarnings.push(
          'same-candidate-files scan: truncated by MERGED_PR_SCAN_DEADLINE_MS before scanning every merged PR in the window',
        );
      }
    } else {
      mergedPrs = [];
    }
  } catch (error) {
    collectionWarnings.push(
      `same-candidate-files scan: ${error instanceof Error ? error.message : String(error)}`,
    );
    candidateFiles = [];
    mergedPrs = [];
  }

  return {
    highConfidenceDuplicate: {
      closedByMergedPrNumbers,
      candidateFiles,
      highContentionFiles,
      mergedPrs,
      branchNameMergedPr,
    },
    collectionWarnings,
  };
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // #2102: --body-file/--stdin never touch the network -- resolved before
  // any of the --issue-only setup below.
  if (resolveInputMode(args) === 'local') {
    runLocalCli(args);
    return;
  }

  if (args.issue === null || !Number.isInteger(args.issue) || args.issue <= 0) {
    throw new Error('--issue is required and must be a positive integer');
  }
  if (args.ghToken) {
    process.env.GH_TOKEN = args.ghToken;
    process.env.GITHUB_TOKEN = args.ghToken;
  }

  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repoRef = `${owner}/${repo}`;

  const issue = fetchIssue(repoRef, args.issue);
  const duplicateCandidates = fetchDuplicateCandidates(repoRef, issue);
  const policyConfig = loadPolicy(args.policy);
  const labelsPolicy = normalizePolicyConfig(policyConfig).labels;

  // #1887: surface an existing, trusted `A4.5 suitability gate rejection`
  // comment (if any) as a distinct output field, independent of the seven
  // checks below and of the shouldCollectEvidence gate further down (that
  // gate exists only to skip Check 4's own network-cost evidence when
  // Checks 1-3 already fail) -- a prior trusted rejection matters
  // regardless of which check a fresh run would fail today (the #1878
  // scenario this issue documents: Check 7 fails fresh, but a human
  // already ruled on it). Wrapped in its own try/catch: this is
  // detect-only evidence, not a gate, so a transient `gh` failure here
  // must degrade to `existingRejection: null` plus a warning, never crash
  // the whole seven-check evaluation the way a genuine
  // fetchIssue/fetchDuplicateCandidates failure still does.
  const { actors: trustedMarkerActors } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config: policyConfig as { trustedMarkerActors?: unknown } | null,
  });
  const existingRejectionCollectionWarnings: string[] = [];
  let existingRejection: SuitabilityRejectionRecord | null = null;
  // Copilot review finding on PR #1890: findTrustedSuitabilityRejection can
  // never return a match with zero trusted actors (it returns null before
  // even looking at `comments`), so fetching the full, possibly-paginated
  // comment thread in that case is guaranteed wasted `gh api` traffic with
  // no observable benefit. Skip the fetch entirely rather than only
  // skipping the (already-cheap) scan.
  if (trustedMarkerActors.length > 0) {
    try {
      const issueComments = fetchIssueComments(repoRef, args.issue);
      existingRejection = findTrustedSuitabilityRejection(
        issueComments,
        trustedMarkerActors,
      );
    } catch (error) {
      existingRejectionCollectionWarnings.push(
        `existingRejection scan: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // #1815: repository_fit, coherence, and trust_safety are cheap, local,
  // no-I/O checks that run before duplicate_or_superseded (Check 4) in
  // evaluateSuitability's own CHECKS order, which short-circuits the whole
  // 7-check loop on the first failure -- so collecting Check 4's
  // network-heavy evidence below (closedByPullRequestsReferences, plus the
  // up-to-50-sequential merged-PR file-overlap scan) is wasted work
  // whenever one of the three already fails. Evaluate them here, against
  // the same Context shape evaluateSuitability builds internally, purely to
  // decide whether to collect that evidence at all -- evaluateSuitability
  // below still re-runs all three (cheap, no I/O) as part of its own normal
  // 7-check loop, so this changes only which network calls happen, never a
  // check's pass/fail outcome (fetchDuplicateCandidates above stays eager:
  // a single `gh api search/issues` call, not the network cost this issue
  // targets).
  const preEvidenceContext: Context = {
    issue,
    repository: normalizeRepository({ owner, repo }),
    duplicateCandidates: [],
    trustSafetyAmbiguous: false,
  };
  const shouldCollectEvidence =
    checkRepositoryFit(preEvidenceContext).pass &&
    checkCoherence(preEvidenceContext).pass &&
    checkTrustSafety(preEvidenceContext).pass;

  // #1484: high-confidence Check 4 tier evidence, collected by
  // `collectHighConfidenceDuplicateEvidence` below only when
  // `shouldCollectEvidence` is true (#1815) -- when it is false, Check 4 is
  // never reached anyway, so `collectionWarnings` correctly stays empty
  // (this is a deliberate skip, not a collection failure). See that
  // function's own doc comment for the per-signal try/catch and
  // degradation rationale.
  let collectionWarnings: string[] = [];
  let highConfidenceDuplicate: SuitabilityOptions['highConfidenceDuplicate'] = {
    closedByMergedPrNumbers: [],
    candidateFiles: [],
    highContentionFiles: [],
    mergedPrs: [],
    branchNameMergedPr: null,
  };

  if (shouldCollectEvidence) {
    const evidence = collectHighConfidenceDuplicateEvidence(
      owner,
      repo,
      repoRef,
      issue,
      args.manifest,
      args.bundles ?? DEFAULT_BUNDLE_IDS,
    );
    highConfidenceDuplicate = evidence.highConfidenceDuplicate;
    collectionWarnings = evidence.collectionWarnings;
  }

  const result = evaluateSuitability(issue, {
    repository: { owner, repo },
    duplicateCandidates,
    blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
    needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
    highConfidenceDuplicate,
    highConfidenceCollectionDegraded: collectionWarnings.length > 0,
  });

  const output = {
    repository: { owner, repo },
    issue: {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
    },
    passed: result.passed,
    outcome: result.outcome,
    failedCheck: result.failedCheck,
    ...(existingRejection ? { existingRejection } : {}),
    ...(existingRejectionCollectionWarnings.length > 0
      ? { existingRejectionCollectionWarnings }
      : {}),
    ...(collectionWarnings.length > 0
      ? { highConfidenceDuplicateCollectionWarnings: collectionWarnings }
      : {}),
    checks: args.verbose
      ? result.checks
      : result.checks.map((check) => ({
          id: check.id,
          name: check.name,
          result: check.result,
          // #1499: carried through even in non-verbose mode -- the typed
          // tier signal exists precisely so a consumer can branch on it
          // without asking for full evidence prose.
          ...(check.tier ? { tier: check.tier } : {}),
        })),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

interface LocalSuitabilityResult {
  mode: 'local';
  issue: { title: string };
  checks: CheckResult[];
}

interface LocalSuitabilityOptions {
  blockedByHumanLabelName?: string;
  needsDecisionLabelName?: string;
}

/**
 * #2102: local/offline dry-run core for `--body-file`/`--stdin`, mirroring
 * `evaluateSuitability`'s split from `runCli`: this is the pure,
 * exported-and-testable half; `runLocalCli` below is the thin I/O wrapper
 * (read the file/stdin, call this, print JSON).
 *
 * Runs the same exported check functions `evaluateSuitability` calls for
 * every check except `duplicate_or_superseded` (Check 4), which
 * fundamentally needs a live `gh api search/issues` query and cannot run
 * offline -- reported as its own explicit `"not_evaluated"` result value
 * in every run, never silently omitted and never counted toward a
 * pass/fail rollup. Unlike `evaluateSuitability`, this never short-circuits
 * on the first failing check: a dry-run's whole purpose is surfacing every
 * check's verdict in one pass, not the live path's checks-are-expensive
 * early-exit (no check here does network I/O, so there is no cost to
 * avoid).
 *
 * The return value has no `outcome` field at all, and no aggregate
 * `passed` value: `mode: "local"` plus a per-check `checks[]` array is the
 * entire contract, so a caller cannot mistake a six-of-seven local pass
 * for a live `--issue <n>` verdict -- the same class of category error
 * this repository's own prior finding flagged for
 * `audit-authored-issue.mjs` (a structural-lint pass is not a
 * `suitability-triage.mjs` semantic pass); this must not repeat one level
 * down. Always returns every check's full evidence; `runLocalCli` applies
 * the same verbose/non-verbose evidence filtering the live path uses.
 */
export function evaluateSuitabilityLocal(
  bodyText: string,
  options: LocalSuitabilityOptions = {},
): LocalSuitabilityResult {
  const { title, body } = splitLocalDraftTitleAndBody(bodyText);

  const localIssue: NormalizedIssue = {
    number: 0,
    title,
    body,
    state: 'draft',
    labels: [],
    url: '',
    // #2102 Copilot review: none of the six local checks read `createdAt`
    // (only checkDuplicateOrSuperseded does, and that check never runs
    // locally) -- a wall-clock timestamp here would make this "pure"
    // evaluation nondeterministic for no benefit.
    createdAt: '',
  };

  const context: Context = {
    issue: localIssue,
    repository: null,
    duplicateCandidates: [],
    trustSafetyAmbiguous: false,
    blockedByHumanLabelName: normalizeConfiguredLabelName(
      options.blockedByHumanLabelName,
      POLICY_DEFAULTS.labels.blockedByHumanLabelName,
    ),
    needsDecisionLabelName: normalizeConfiguredLabelName(
      options.needsDecisionLabelName,
      POLICY_DEFAULTS.labels.needsDecisionLabelName,
    ),
  };

  const checks: CheckResult[] = CHECKS.map((check) => {
    if (check.id === 'duplicate_or_superseded') {
      return {
        id: check.id,
        name: check.name,
        result: 'not_evaluated',
        evidence:
          'Local dry-run mode has no live GitHub search index; this check cannot run offline.',
      };
    }
    const outcome = check.evaluate(context);
    return {
      id: check.id,
      name: check.name,
      result: outcome.pass ? 'pass' : 'fail',
      evidence: outcome.evidence,
      ...(outcome.tier ? { tier: outcome.tier } : {}),
    };
  });

  return { mode: 'local', issue: { title }, checks };
}

function runLocalCli(args: SuitabilityTriageArgs): void {
  const bodyText = args.stdin
    ? readFileSync(0, 'utf8')
    : readFileSync(resolve(process.cwd(), args.bodyFile as string), 'utf8');

  const policyConfig = loadPolicy(args.policy);
  const labelsPolicy = normalizePolicyConfig(policyConfig).labels;
  const result = evaluateSuitabilityLocal(bodyText, {
    blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
    needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
  });

  const output = {
    mode: result.mode,
    issue: result.issue,
    checks: args.verbose
      ? result.checks
      : result.checks.map((check) => ({
          id: check.id,
          name: check.name,
          result: check.result,
          ...(check.tier ? { tier: check.tier } : {}),
        })),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

/**
 * Restores this file's pre-#1450 permissive `Number.parseInt` contract:
 * absent resolves to `null` (the original `issue: null` default, never
 * overwritten when `--issue` is absent); present feeds the raw token
 * straight to `Number.parseInt`, which accepts trailing-garbage ("42abc"
 * -> 42) and leading-zero ("007" -> 7) tokens the same way the original
 * hand-rolled `Number.parseInt(String(value ?? ''), 10)` always did.
 * `cli-args.mts`'s `parseCanonicalIntegerOrNull` is a poor substitute
 * here: its canonical-pattern regex rejects those same tokens outright,
 * which is a real contract change a CodeRabbit review on PR #1466 caught
 * -- #1450's acceptance criteria protect the post-parse integer contract
 * as-is, only flag *syntax* (missing/flag-shaped values, unknown flags)
 * is meant to tighten. This file's own `args.issue === null ||
 * !Number.isInteger(args.issue) || args.issue <= 0` use-site guard
 * already treats `NaN` (an invalid parseInt result) the same as `null`,
 * so this restores the exact original resolved value, not just an
 * equivalent downstream verdict.
 */
function parseLenientIntegerOrNull(token: string | undefined): number | null {
  return token === undefined ? null : Number.parseInt(token, 10);
}

function warnDeprecatedFlag(deprecated: string, canonical: string): void {
  process.stderr.write(
    `warning: ${deprecated} is deprecated; use ${canonical} instead.\n`,
  );
}

/**
 * Find `flag`'s last occurrence in `argv`, recognizing both the
 * two-token form (`--flag value`) and the single-token `--flag=value`
 * form `parseCliArgs` also accepts.
 */
function findLastFlagOccurrenceIndex(
  argv: readonly string[],
  flag: string,
): number {
  const equalsPrefix = `${flag}=`;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    if (argv[index] === flag || argv[index].startsWith(equalsPrefix)) {
      return index;
    }
  }
  return -1;
}

/**
 * Resolve a canonical/deprecated flag pair: whichever flag's LAST
 * occurrence comes later in argv wins when both spellings are given
 * together (matches `pre-merge-readiness.mts`'s `--claim-id` /
 * `--expected-claim-id` precedent). `-1` (never given) sorts before any
 * real index, so an absent flag never wins against one that was
 * actually passed.
 */
function resolveLastGivenAlias(
  argv: readonly string[],
  canonicalFlag: string,
  canonicalValue: string | undefined,
  deprecatedFlag: string,
  deprecatedValue: string | undefined,
): string | undefined {
  if (canonicalValue === undefined) {
    return deprecatedValue;
  }
  if (deprecatedValue === undefined) {
    return canonicalValue;
  }
  const lastCanonicalIndex = findLastFlagOccurrenceIndex(argv, canonicalFlag);
  const lastDeprecatedIndex = findLastFlagOccurrenceIndex(argv, deprecatedFlag);
  return lastDeprecatedIndex > lastCanonicalIndex
    ? deprecatedValue
    : canonicalValue;
}

export function parseArgs(argv: string[]): SuitabilityTriageArgs {
  const { values, help } = parseCliArgs(argv, SUITABILITY_TRIAGE_FLAG_SPEC);
  const ghToken = resolveLastGivenAlias(
    argv,
    '--gh-token',
    values['gh-token'] as string | undefined,
    '--token',
    values.token as string | undefined,
  );
  const deprecatedTokenValue = values.token as string | undefined;
  if (deprecatedTokenValue !== undefined) {
    warnDeprecatedFlag('--token', '--gh-token');
  }
  return {
    issue: parseLenientIntegerOrNull(values.issue as string | undefined),
    bodyFile: values['body-file'] as string | undefined,
    stdin: values.stdin as boolean,
    ghToken: ghToken ?? '',
    owner: values.owner as string,
    repo: values.repo as string,
    policy: values.policy as string,
    manifest: values.manifest as string,
    // #1499: mirrors `discover-shared-file-overlap.mts`'s own `--bundles`
    // parsing exactly -- absent means "not passed" (`null`), present is a
    // comma-split, trimmed, empty-token-filtered list.
    bundles:
      values.bundles === undefined
        ? null
        : String(values.bundles as string)
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
    verbose: values.verbose as boolean,
    help,
  };
}

/**
 * Load and parse `.github/idd/config.json` (or `--policy <path>` when
 * given). Read-and-parse failure semantics (explicit path throws; default
 * path silently falls back only on ENOENT, matching an absent default
 * policy file so the CLI stays usable without one, #1273) are converged in
 * idd-config.mts's `loadPolicyConfig` (#1721) — this function has no shape
 * normalization of its own beyond returning the raw config.
 */
function loadPolicy(policyPath: string): unknown {
  return loadPolicyConfig(policyPath).config;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/suitability-triage.mjs --issue <number> [--gh-token <token>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--manifest <path>] [--bundles <id1,id2>] [--verbose] [--help]
  node scripts/suitability-triage.mjs (--body-file <path> | --stdin) [--policy <path>] [--verbose] [--help]
  Deprecated aliases (one release): --token -> --gh-token

--issue, --body-file, and --stdin are mutually exclusive; exactly one is
required. --body-file/--stdin (#2102) run a local, offline dry-run against
a drafted issue's text before it is ever published: six of the seven
checks (every check except duplicate_or_superseded, Check 4, which
fundamentally needs a live search index) run against the same exported
check functions the live --issue path uses. A leading "# Title" line in
the supplied text is extracted as the title; everything else, minus any
blank lines immediately after the title, is the body. See "Local mode
output schema" below -- it is a distinct, deliberately
incompatible shape from the live --issue output directly below it, so a
local dry-run result can never be mistaken for a live verdict.

--manifest / --bundles override the Check 4 high-confidence tier's
high-contention exclusion set (default: the same manifest path and bundle
IDs as discover-shared-file-overlap.mjs's own --manifest/--bundles), so a
repository that customizes its A4 Step 2 contention bundles gets a matching
Check-4 exclusion set instead of a stale hardcoded default.

Live (--issue) output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "issue": {"number": 392, "title": "...", "state": "OPEN", "url": "..."},
  "passed": true,
  "outcome": "ready|unclear|needs-decision|blocked-by-human|duplicate|out-of-scope|invalid",
  "failedCheck": "repository_fit|...|null",
  "existingRejection": {"author":"...","createdAt":"...","url":"...","outcome":"...|null","check":"...|null"},
  "checks": [{"id":"repository_fit","name":"Repository Fit","result":"pass|fail","evidence":"..."}]
}

Each checks[] entry may also carry "tier":"high-confidence|weak" -- present
only on a duplicate_or_superseded fail (absent on every pass and on every
other check), distinguishing a high-confidence mechanical hit from the weak
title/declaration heuristic.

"existingRejection" (#1887) is present only when a trusted marker actor
already posted a correctly-formatted "A4.5 suitability gate rejection"
comment on this issue -- the most recent one, when more than one exists.
Absent (not null) for the common never-triaged case, and never surfaced for
a rejection-shaped comment from an untrusted actor. An optional sibling
"existingRejectionCollectionWarnings" array is present only when fetching
or scanning the comment thread itself failed.

Local (--body-file/--stdin) output schema (#2102):
{
  "mode": "local",
  "issue": {"title": "..."},
  "checks": [
    {"id":"repository_fit","name":"Repository Fit","result":"pass|fail","evidence":"..."},
    {"id":"coherence","name":"Issue Coherence","result":"pass|fail","evidence":"..."},
    {"id":"trust_safety","name":"Trust/Safety","result":"pass|fail","evidence":"..."},
    {"id":"duplicate_or_superseded","name":"Duplicate or Superseded Work","result":"not_evaluated","evidence":"..."},
    {"id":"actionability","name":"Actionability","result":"pass|fail","evidence":"..."},
    {"id":"autonomy","name":"Autonomy","result":"pass|fail","evidence":"..."},
    {"id":"verifiability","name":"Verifiability","result":"pass|fail","evidence":"..."}
  ]
}

There is no "passed", "outcome", or "failedCheck" field in local mode, and
no aggregate rollup of any kind: "duplicate_or_superseded" always reports
"not_evaluated" and is never counted toward a pass/fail verdict, so a
caller must inspect each checks[] entry individually rather than infer an
overall suitability outcome from a local run.

Like the live path, each entry's "evidence" is present only with
--verbose; the schema above shows every field a checks[] entry can carry,
not what a default (non-verbose) run actually returns.
`);
}

/**
 * #2102: split a locally-drafted `--body-file`/`--stdin` text blob into a
 * title and a body, for the local dry-run mode. `audit-authored-issue.mts`
 * has no equivalent split -- it validates body structure only, never a
 * title -- so this convention is new here, not reused from that file.
 *
 * A leading `# Title` line (a single Markdown H1, the common convention
 * for a drafted issue file that mirrors what GitHub's own title field will
 * hold) is extracted as the title -- any blank lines *before* it are
 * skipped first, so it need not be the literal first line, only the first
 * non-blank content, and it needs no trailing newline of its own (a draft
 * whose entire content is `# Title` still extracts correctly). Any blank
 * lines immediately following the H1 line are also consumed so the
 * remaining body does not start with stray leading blank lines. Anything
 * else -- no H1, or an H1 preceded by non-blank content -- leaves the
 * title empty and the entire input becomes the body unchanged:
 * `checkCoherence` and the other checks below already tolerate an empty
 * title (see the live path's own `normalizeIssue`, which defaults a
 * genuinely missing title to `''`), so under-splitting fails safe rather
 * than guessing.
 */
export function splitLocalDraftTitleAndBody(text: string): {
  title: string;
  body: string;
} {
  const match = text.match(
    /^(?:[ \t]*\r?\n)*[ \t]*#[ \t]+(\S[^\n]*?)[ \t]*(?:\r?\n|$)/,
  );
  if (!match) {
    return { title: '', body: text };
  }
  const title = match[1] ?? '';
  const rest = text.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
  return { title, body: rest };
}

function normalizeIssue(issue: unknown): NormalizedIssue {
  const i = (issue ?? {}) as {
    number?: unknown;
    title?: unknown;
    body?: unknown;
    state?: unknown;
    labels?: unknown;
    url?: unknown;
    html_url?: unknown;
    created_at?: unknown;
  };
  return {
    number: Number.parseInt(String(i.number), 10),
    title: String(i.title ?? ''),
    body: String(i.body ?? ''),
    state: String(i.state ?? ''),
    labels: normalizeLabels(i.labels),
    url: String(i.url ?? i.html_url ?? ''),
    createdAt: String(i.created_at ?? ''),
  };
}

/**
 * Normalize the `evaluateSuitability` options-boundary input for #1484's
 * high-confidence tier. Returns `undefined` for anything that isn't a
 * plausible object (existing callers that don't know about this field never
 * pass it, which must resolve to "absent", not an empty-but-present shape --
 * `evaluateHighConfidenceDuplicate` special-cases `undefined` for exactly
 * this reason). Every array field defaults to `[]` on a malformed shape.
 */
function normalizeHighConfidenceDuplicateInput(
  raw: unknown,
): HighConfidenceDuplicateInput | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as {
    closedByMergedPrNumbers?: unknown;
    candidateFiles?: unknown;
    highContentionFiles?: unknown;
    mergedPrs?: unknown;
    branchNameMergedPr?: unknown;
  };
  return {
    closedByMergedPrNumbers: normalizePositiveIntArray(
      r.closedByMergedPrNumbers,
    ),
    candidateFiles: normalizeStringArray(r.candidateFiles),
    highContentionFiles: normalizeStringArray(r.highContentionFiles),
    mergedPrs: normalizeHighConfidenceMergedPrs(r.mergedPrs),
    branchNameMergedPr: normalizeBranchNameMergedPr(r.branchNameMergedPr),
  };
}

/** #2313: normalize the Signal 3 options-boundary field the same fail-safe
 * way as every other field here -- a malformed shape degrades to `null`
 * (no evidence), never a crash or a manufactured match. */
function normalizeBranchNameMergedPr(
  value: unknown,
): { number: number; mergedAt: string } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as { number?: unknown; mergedAt?: unknown };
  const number = Number(v.number);
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  return { number, mergedAt: String(v.mergedAt ?? '') };
}

function normalizePositiveIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry ?? ''))
    .filter((entry) => entry.length > 0);
}

function normalizeHighConfidenceMergedPrs(
  value: unknown,
): HighConfidenceMergedPr[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const e = (entry ?? {}) as {
        number?: unknown;
        mergedAt?: unknown;
        files?: unknown;
        closingIssuesReferences?: unknown;
        title?: unknown;
        body?: unknown;
      };
      return {
        number: Number(e.number),
        mergedAt: String(e.mergedAt ?? ''),
        files: normalizeStringArray(e.files),
        // #1878: same-issue-reference evidence, normalized the same
        // fail-safe way as every other field on this options boundary --
        // a malformed shape degrades to "no reference" rather than crashing
        // or manufacturing a match.
        closingIssuesReferences: normalizePositiveIntArray(
          e.closingIssuesReferences,
        ),
        title: String(e.title ?? ''),
        body: String(e.body ?? ''),
      };
    })
    .filter((entry) => Number.isInteger(entry.number) && entry.number > 0);
}

/**
 * Resolve one configured `labels.*` name (#1273), falling back to the given
 * `policy-helpers.mts` `POLICY_DEFAULTS.labels` default for an absent or
 * invalid value.
 */
function normalizeConfiguredLabelName(
  labelName: unknown,
  fallback: string,
): string {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : fallback;
}

function normalizeRepository(repository: unknown): Repository | null {
  if (!repository || typeof repository !== 'object') {
    return null;
  }
  const r = repository as { owner?: unknown; repo?: unknown };
  const owner = String(r.owner ?? '')
    .trim()
    .toLowerCase();
  const repo = String(r.repo ?? '')
    .trim()
    .toLowerCase();
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

function normalizeDuplicateCandidates(
  candidates: unknown,
): DuplicateCandidate[] {
  if (!Array.isArray(candidates)) {
    return [];
  }
  return (candidates as unknown[])
    .map((candidate) => {
      const c = (candidate ?? {}) as {
        number?: unknown;
        title?: unknown;
        state?: unknown;
        url?: unknown;
        html_url?: unknown;
      };
      return {
        number: Number.parseInt(String(c.number), 10),
        title: String(c.title ?? ''),
        state: String(c.state ?? ''),
        url: String(c.url ?? c.html_url ?? ''),
      };
    })
    .filter(
      (candidate) => Number.isInteger(candidate.number) && candidate.number > 0,
    );
}

function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  return (labels as unknown[])
    .map((label) =>
      typeof label === 'string'
        ? label
        : ((label as { name?: unknown })?.name ?? ''),
    )
    .map((label) => String(label).trim().toLowerCase())
    .filter(Boolean);
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function fetchIssue(repoRef: string, issueNumber: number): NormalizedIssue {
  const issue = ghJson(['api', `repos/${repoRef}/issues/${issueNumber}`]);
  return normalizeIssue(issue);
}

function fetchDuplicateCandidates(
  repoRef: string,
  issue: NormalizedIssue,
): DuplicateCandidate[] {
  const escapedTitle = issue.title.replaceAll('"', '\\"');
  const query = `repo:${repoRef} in:title "${escapedTitle}"`;
  const payload = ghJson([
    'api',
    `search/issues?q=${encodeURIComponent(query)}&per_page=50`,
  ]) as { items?: unknown };
  return normalizeDuplicateCandidates(payload.items ?? []);
}

/**
 * Paginated fetch of `<owner>/<repo>` issue `<issueNumber>`'s full comment
 * thread (#1887), mirroring `resume-claim-routing.mts`'s own
 * `fetchIssueComments` -- REST issue comments, 100 per page, until a
 * short page signals the end. Feeds `findTrustedSuitabilityRejection`
 * (`supersession-detection.mts`). Throws on a `gh` failure like every other
 * `ghJson`-based fetch in this file; the caller wraps this call in its own
 * try/catch so a failure here degrades `existingRejection` to `null` plus a
 * warning instead of crashing the whole seven-check evaluation.
 */
function fetchIssueComments(
  repoRef: string,
  issueNumber: number,
): SuitabilityRejectionComment[] {
  const comments: SuitabilityRejectionComment[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const pageItems = ghJson([
      'api',
      `repos/${repoRef}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${page}`,
    ]) as SuitabilityRejectionComment[];
    comments.push(...pageItems);
    if (pageItems.length < pageSize) {
      break;
    }
  }
  return comments;
}

// --- #1484: high-confidence Check 4 tier CLI glue ---------------------------
// The pure argv-builders (`buildClosedByMergedPrArgs`, `buildMergedPrListArgs`,
// `buildPrDetailArgs`) and the evaluation kernel (`evaluateHighConfidenceDuplicate`)
// moved to `supersession-detection.mts` (#1499); this file keeps only the
// `gh`-executing orchestration below (fetch, try/catch, deadline budget,
// `collectionWarnings`), which the issue does not name as part of the
// extraction.

/**
 * Fetch the candidate issue's own merged closing-PR references. Throws (via
 * `runGh`, no try/catch here) on a `gh` error rather than silently reading a
 * broken fetch as "no evidence" -- the latter would make a real duplicate
 * look clean. The caller (`runCli`) wraps this in its own try/catch,
 * separate from the same-candidate-files scan's try/catch below (Copilot
 * review finding on this PR: an earlier version described both as sharing
 * one try/catch, which stopped being accurate once they were split so a
 * failure in one signal's collection couldn't discard an already-successful
 * sibling), so a failure here degrades the optional high-confidence tier
 * (Check 4's own documented "Timeout on duplicate detection... fall back to
 * exact title match only" Edge Case) without aborting the other six checks
 * (Codex review finding on this PR: an earlier version let this throw
 * uncaught all the way out of `runCli`, crashing the whole evaluation).
 *
 * Also requires the candidate issue's own current `state` to be `CLOSED`,
 * mirroring B2.0's identical gate on this same signal
 * (`idd-work.instructions.md`'s "Closed-by-a-merged-PR signal": `select(.state
 * == "CLOSED")`). `closedByPullRequestsReferences` is not cleared when an
 * issue is reopened, so without this gate a reopened issue with genuine
 * remaining work would still show its old merged closing PR and get
 * misclassified as a completed duplicate (Codex review finding on this PR).
 */
export function fetchClosedByMergedPrNumbers(
  owner: string,
  repo: string,
  issueNumber: number,
): number[] {
  const parsed = ghJson(
    buildClosedByMergedPrArgs(owner, repo, issueNumber),
  ) as {
    data?: {
      repository?: {
        issue?: {
          state?: unknown;
          closedByPullRequestsReferences?: {
            nodes?: { number?: unknown; state?: unknown }[] | null;
          } | null;
        } | null;
      } | null;
    };
    errors?: unknown;
  };
  // `gh api graphql` exits non-zero (throwing via runGh) on a schema-level
  // query error, but a GraphQL response can also return HTTP 200 with a
  // non-empty top-level `errors` array alongside partial/null `data` (a
  // resolver-level failure on a nullable field) -- verified empirically
  // that gh's own exit code does not always catch this shape. Treating that
  // silently as "no evidence" would suppress a real collection failure
  // (Copilot review finding on this PR); throw explicitly so the caller's
  // try/catch records it in `collectionWarnings` instead.
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new Error(
      `closedByPullRequestsReferences GraphQL response returned errors: ${JSON.stringify(parsed.errors)}`,
    );
  }
  if (String(parsed.data?.repository?.issue?.state ?? '') !== 'CLOSED') {
    return [];
  }
  const nodes =
    parsed.data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
  return nodes
    .filter((node) => String(node?.state ?? '') === 'MERGED')
    .map((node) => Number.parseInt(String(node?.number ?? ''), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * #2313, Signal 3: exact-match branch-name lookup. `--head` filters
 * server-side by head branch NAME only -- `gh pr list --help` documents
 * that `"<owner>:<branch>" syntax` is "not supported" -- so a merged PR
 * from a FORK using the same branch name can also come back (Copilot
 * review finding on this PR). `owner` (the repository owner, not the fork
 * contributor) is required so every entry can be filtered to
 * `headRepositoryOwner.login === owner` before being treated as a hit;
 * `buildMergedPrByBranchArgs` requests that field and a `--limit` above 1
 * for exactly this reason. Still iterates rather than indexing `[0]`
 * directly, matching the rest of this file's "never trust the shape of a
 * `gh` JSON response" convention.
 */
export function fetchMergedPrByBranchName(
  repoRef: string,
  branchName: string,
  owner: string,
): { number: number; mergedAt: string } | null {
  const list = ghJsonArray(buildMergedPrByBranchArgs(repoRef, branchName)) as {
    number?: unknown;
    headRefName?: unknown;
    mergedAt?: unknown;
    headRepositoryOwner?: { login?: unknown } | null;
  }[];
  const normalizedOwner = owner.trim().toLowerCase();
  for (const entry of list) {
    const number = Number.parseInt(String(entry?.number ?? ''), 10);
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    if (String(entry?.headRefName ?? '') !== branchName) {
      continue;
    }
    const headOwner = String(entry?.headRepositoryOwner?.login ?? '')
      .trim()
      .toLowerCase();
    if (!headOwner || headOwner !== normalizedOwner) {
      // A fork's PR (or a response missing headRepositoryOwner) never
      // counts as a hit -- fail-safe, matching this file's "never fail
      // toward a false high-confidence flag" contract.
      continue;
    }
    return { number, mergedAt: String(entry?.mergedAt ?? '') };
  }
  return null;
}

/** Return shape for {@link fetchMergedPrFileOverlapEvidence} (#1484): pairs
 * the collected evidence with whether the scan was cut short by
 * `MERGED_PR_SCAN_DEADLINE_MS` before finishing. */
interface MergedPrFileOverlapScanResult {
  mergedPrs: HighConfidenceMergedPr[];
  truncatedByDeadline: boolean;
}

/**
 * Bounded two-step merged-PR file-overlap scan (list, then per-PR file
 * list), mirroring B2.0's own documented commands exactly rather than a new
 * query shape. A malformed list entry (non-positive-integer or absent
 * `number`) is skipped rather than shelled out to `gh pr view` (Copilot
 * review finding on this PR: `ghJsonArray` intentionally returns
 * `unknown[]`, so an unexpected API shape should degrade this one entry,
 * not become a hard `gh pr view NaN`/`gh pr view 0` failure). Also stops
 * early, returning whatever has been collected so far plus
 * `truncatedByDeadline: true`, once `MERGED_PR_SCAN_DEADLINE_MS` elapses
 * (CodeRabbit review finding on this PR: up to `MERGED_PR_SCAN_LIMIT`
 * sequential `gh pr view` calls with no overall cap could otherwise run for
 * tens of minutes under a degraded/rate-limited GitHub API). The
 * `truncatedByDeadline` flag matters because this early exit returns
 * normally rather than throwing (Codex P2 review finding on this PR): an
 * earlier version left the caller unable to distinguish "scanned
 * everything, found nothing" from "gave up partway through", so a
 * deadline-truncated scan silently ran the FULL weak heuristic (including
 * the near-duplicate fuzzy match) on incomplete evidence instead of
 * degrading to the documented exact-title-only fallback the way a thrown
 * `gh` error already does. A genuine `gh` error on a well-formed entry
 * still throws -- the caller (`runCli`) wraps this and its sibling fetch in
 * a separate try/catch so that surfaces as the same documented Check 4 Edge
 * Case fallback for just this signal, without discarding the other.
 *
 * `candidateFiles` / `highContentionFiles` (#1815) let the scan stop early:
 * `evaluateHighConfidenceDuplicate` only needs the FIRST merged PR (in scan
 * order) whose changed files overlap the exclusion-adjusted candidate set
 * AND references `candidateIssueNumber` itself (#1878; see
 * `prReferencesIssue` in `supersession-detection.mts`) to return a
 * high-confidence fail -- every PR after it would otherwise be fetched and
 * then ignored. `resolveCandidateFileSet` / `findCandidateFileOverlap` /
 * `prReferencesIssue` (`supersession-detection.mts`) are the exact same
 * helpers `evaluateHighConfidenceDuplicate` itself now uses, so the PR
 * this loop stops on is provably the same PR the downstream evaluation
 * would stop on -- no evidence-content change, only fewer PRs fetched. A
 * merged PR whose files overlap but that never references the candidate
 * (the #1862-vs-#1863/PR#1864 false positive #1878 fixes) no longer stops
 * the scan -- every merged PR in the window is now fetched in that case,
 * which is the fail-safe direction (worst case, a `truncatedByDeadline`
 * scan degrades Check 4 to exact-title-only, never a false high-confidence
 * hit) but does mean `MERGED_PR_SCAN_DEADLINE_MS` is reached far more
 * often for a candidate whose files are shared across an entire roadmap of
 * siblings, none of which reference it individually.
 * Exported (not just called) so `fetchMergedPrFileOverlapEvidence` can be
 * unit-tested directly against a stubbed `gh` on `PATH`, the way this
 * repo's other `gh`-calling functions are exercised (see
 * `tests/gh-exec.test.mts` / `tests/discover-roadmap-graph.test.mts`).
 */
export function fetchMergedPrFileOverlapEvidence(
  repoRef: string,
  sinceIso: string,
  candidateFiles: string[],
  highContentionFiles: string[],
  candidateIssueNumber: number,
): MergedPrFileOverlapScanResult {
  const list = ghJsonArray(buildMergedPrListArgs(repoRef, sinceIso));
  const mergedPrs: HighConfidenceMergedPr[] = [];
  const deadline = Date.now() + MERGED_PR_SCAN_DEADLINE_MS;
  let truncatedByDeadline = false;
  const candidateSet = resolveCandidateFileSet(
    candidateFiles,
    highContentionFiles,
  );
  for (const entry of list) {
    if (Date.now() >= deadline) {
      truncatedByDeadline = true;
      break;
    }
    const pr = (entry ?? {}) as { number?: unknown; mergedAt?: unknown };
    const number = Number.parseInt(String(pr.number ?? ''), 10);
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    const detail = ghJson(buildPrDetailArgs(repoRef, number)) as {
      files?: { path?: unknown }[];
      title?: unknown;
      body?: unknown;
      closingIssuesReferences?: { number?: unknown }[];
    };
    const files = (Array.isArray(detail.files) ? detail.files : [])
      .map((file) => String(file?.path ?? ''))
      .filter(Boolean);
    const closingIssuesReferences = (
      Array.isArray(detail.closingIssuesReferences)
        ? detail.closingIssuesReferences
        : []
    )
      .map((ref) => Number(ref?.number))
      .filter((n) => Number.isInteger(n) && n > 0);
    const title = String(detail.title ?? '');
    const body = String(detail.body ?? '');
    mergedPrs.push({
      number,
      mergedAt: String(pr.mergedAt ?? ''),
      files,
      closingIssuesReferences,
      title,
      body,
    });
    if (
      findCandidateFileOverlap(files, candidateSet).length > 0 &&
      prReferencesIssue(
        { closingIssuesReferences, title, body },
        candidateIssueNumber,
      )
    ) {
      // Qualifying overlap + same-issue reference found (#1815, #1878):
      // stop -- see the doc comment above. Deliberately a plain `break`,
      // NOT `truncatedByDeadline = true`: this is a complete, successful
      // scan that found its answer early, not a scan cut short before
      // finishing. Setting the flag here would wrongly push a
      // `collectionWarnings` entry in `runCli`, which degrades Check 4 to
      // exact-title-only -- silently turning a genuine high-confidence hit
      // into a false pass.
      break;
    }
  }
  return { mergedPrs, truncatedByDeadline };
}

/**
 * Resolve the high-contention exclusion set the same way A4 Step 2's
 * `discover-shared-file-overlap` does, so the #1484 same-candidate-files
 * signal never treats a broadly-shared bundle/manifest file as
 * high-confidence evidence on its own. Returns `null` (not `[]`) when the
 * manifest cannot be loaded, so `runCli` can skip the same-candidate-files
 * scan entirely in that case rather than proceeding with zero exclusions --
 * an empty exclusion set would make that signal MORE permissive, which is
 * the wrong fail direction for "never fail toward a false high-confidence
 * flag". `runCli` also records this as a `collectionWarnings` entry (Codex
 * P2 review finding on this PR): from Check 4's perspective, "manifest
 * unavailable" and "gh/API fetch failed" are the same class of "evidence
 * could not be collected" and must degrade the weak-heuristic fallback the
 * same way. `closedByPullRequestsReferences` is a separate, independent
 * signal and is unaffected by either fallback.
 */
export function loadHighContentionFiles(
  manifestPath: string,
  bundleIds: string[],
): string[] | null {
  // Copilot review finding on this PR: `[].every(...)` is vacuously `true`,
  // so an explicitly-empty (or whitespace-only, after --bundles parsing)
  // override would otherwise sail through the completeness check below and
  // resolve to a high-contention set containing only `extraFiles` (just the
  // manifest path) -- the opposite of this tier's fail-safe contract, since
  // a smaller exclusion set makes the overlap scan MORE permissive, not
  // less. Treat an empty list the same as any other invalid/incomplete
  // request: degrade to null (collection warning, exact-title-only) rather
  // than silently accepting zero bundles as "all resolved".
  if (bundleIds.length === 0) {
    return null;
  }
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), manifestPath), 'utf8'),
    );
    // Codex P2 review finding: a manifest that parses but lacks usable
    // `bundleBudgets` entries for one or both target bundle IDs (an empty
    // object, or an older schema) doesn't throw here -- `resolveHighContentionFiles`
    // degrades gracefully to just the manifest path itself for A4 Step 2's
    // own, lower-stakes de-prioritization use. But for this tier, an
    // incomplete exclusion set can miss a genuinely high-contention file, so
    // a shared bundle/instruction file could be misread as specific overlap
    // evidence -- exactly the false high-confidence flag Check 4 must never
    // produce. Require every requested bundle ID (#1499: the caller's own
    // `--bundles` override when given, not the hardcoded default -- a
    // repository that customizes its bundle set must have THOSE bundles
    // validated, not `DEFAULT_BUNDLE_IDS`) to actually resolve before
    // accepting the set; otherwise treat it the same as an unreadable
    // manifest (return null, which the caller already records as a
    // collection warning and degrades to exact-title-only).
    const bundles = (manifest as { bundleBudgets?: unknown } | null)
      ?.bundleBudgets;
    if (!Array.isArray(bundles)) {
      return null;
    }
    const nonEmptyFilesBundleIds = new Set(
      bundles
        .filter((bundle) => {
          const files = (bundle as { files?: unknown } | null)?.files;
          return Array.isArray(files) && files.length > 0;
        })
        .map((bundle) => String((bundle as { id?: unknown })?.id ?? '')),
    );
    // Codex P2 review finding: a bundle entry whose id matched but whose
    // `files` was missing, non-array, or empty passed the id-only check
    // above yet still let `resolveHighContentionFiles` silently omit that
    // bundle's real shared files -- the same false-flag risk as a missing
    // bundle id entirely, so it must degrade the same way.
    const allBundleIdsResolved = bundleIds.every((id) =>
      nonEmptyFilesBundleIds.has(id),
    );
    if (!allBundleIdsResolved) {
      return null;
    }
    return [
      ...resolveHighContentionFiles({
        manifest,
        bundleIds,
        // #1499: mirrors `discover-shared-file-overlap.mts`'s own `runCli`
        // pattern -- the manifest path actually in use is the file reported
        // (and matched) as high-contention, not a hardcoded default that
        // silently stops tracking a customized manifest.
        extraFiles: [manifestPath],
      }),
    ];
  } catch {
    return null;
  }
}

function ghJson(args: string[]): unknown {
  return JSON.parse(runGh(args).trim() || '{}');
}

// Relocated from discover-shared-file-overlap.mts (#2266): that file's own
// `gh` usage moved onto provider-port.mts, but this array-safe parser had no
// port-shaped equivalent this file's two `gh api`/`gh pr list` array call
// sites (buildMergedPrByBranchArgs, buildMergedPrListArgs) could move onto,
// so it moves here instead of being deleted -- its only remaining consumer.
function ghJsonArray(args: string[]): unknown[] {
  const parsed = JSON.parse(runGh(args).trim() || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

function runGh(args: string[]): string {
  try {
    return ghText(args, GH_TEXT_LOOP_TIMEOUT_OPTIONS);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? '').trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}
