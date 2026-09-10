#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-viability-gate.mts
//
// The scripts/discover-viability-gate.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { existsSync } from 'node:fs';

import { parseCliArgs } from './cli-args.mts';
import {
  type CollaboratorPermissionCache,
  collaboratorPermission,
} from './collaborator-permission.mts';
import { loadPolicyConfig } from './idd-config.mts';
import { resolveTrustedMarkerActors } from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import { findInlineResolvedDecisionSpans } from './resolved-decision.mts';
import {
  buildTrustedLoginPredicate,
  evaluateStructuralEvidence,
  hasAllStructuralSignals,
  type StructuralEvidence,
} from './triage-structural-evidence.mts';

interface NormalizedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
}

interface EvalResult {
  pass: boolean;
  evidence: string;
  /** #2767: set only when this result converted a would-be lexical-fail
   * into a pass because `hasAllStructuralSignals` held -- see
   * `supersession-detection.mts`'s `CheckOutcome.demoted` doc comment for
   * the full contract (this local type mirrors it; `discover-viability-gate.mts`
   * does not import that shared type). */
  demoted?: boolean;
}

interface CriterionResult {
  id: string;
  name: string;
  result: string;
  evidence: string;
}

interface ViableItem {
  number: number;
  title: string;
  /** #2767: present only when at least one criterion was demoted
   * (`result: 'warn'`) rather than an ordinary pass -- omitted otherwise,
   * so an issue with no warn entries keeps the exact pre-#2767 shape. */
  criteria?: CriterionResult[];
}

interface DiscardedItem {
  number: number;
  title: string;
  failedCriteria: string[];
  criteria?: CriterionResult[];
}

interface ViabilitySummary {
  viable: ViableItem[];
  discarded: DiscardedItem[];
  summary: {
    total: number;
    viableCount: number;
    discardedCount: number;
    discardedByCriterion: Record<string, number>;
  };
}

interface IssueLike {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  /** #2767: raw REST `user` field, read only for the `trustedEditor`
   * structural-evidence signal's author login. */
  user?: unknown;
}

type IssueLoader = (
  issueNumber: number,
) => Promise<IssueLike | null> | IssueLike | null;

const CRITERIA: {
  id: string;
  name: string;
  evaluate: (
    issue: NormalizedIssue,
    structuralEvidence?: StructuralEvidence,
  ) => EvalResult;
}[] = [
  {
    id: 'limited_scope',
    name: 'Limited scope',
    evaluate: evaluateLimitedScope,
  },
  {
    id: 'clear_verification',
    name: 'Clear verification',
    evaluate: evaluateClearVerification,
  },
  {
    id: 'autonomous_completion',
    name: 'Autonomous completion',
    evaluate: evaluateAutonomousCompletion,
  },
];

const BROAD_SCOPE_PATTERN =
  /\b(cross-cutting|cross cutting|across (?:many|multiple)|multiple subsystems?|repository-wide|entire repo|public interface|redesign|architecture|global refactor|large refactor)\b/gi;
// A broad-scope word inside a phrase describing something other than this
// issue's own diff footprint should not count (#2417, #2446): a worked
// example of what NOT to do, a citation of another issue's already-resolved
// heuristic, a mention of the documentation/guidance content itself, or a
// bare description of an already-staged foundation. Three exclusion shapes
// cover the observed false positives, matched per-occurrence rather than
// once for the whole corpus (a genuinely broad issue usually trips the
// pattern more than once, so excluding one occurrence still leaves the rest
// to fail the gate).
//
// 1. Avoidance-cue: the match is the disfavored option in a "rather than X"
//    / "prefer Y over X" construction (#2401, #2413).
const AVOIDANCE_CUE_PATTERN =
  /\b(rather than|instead of|avoid|prefer|over a)\b/gi;
const AVOIDANCE_CUE_WINDOW = 80;
// A comma continues the SAME clause the cue governs only when immediately
// followed by a degree/comparative adverb ("a second, more elaborate
// redesign" -- #2401); any other comma, or a period/semicolon/em-dash,
// starts a new clause and cuts the cue's reach short ("Instead of a
// targeted fix, do a full redesign" -- "do" starts a fresh, un-governed
// proposal that must still fail the gate).
const CLAUSE_CONTINUATION_COMMA_PATTERN =
  /,\s+(?!more\b|less\b|even\b|particularly\b|especially\b|slightly\b|somewhat\b)/;
const HARD_CLAUSE_BREAK_PATTERN = /[.;—]|--/;
// 2. Content-noun: the match modifies a noun naming prose/documentation
//    content itself ("cross-cutting ... guidance" -- #2402), not this
//    issue's own change. The noun can sit a token or two past the match
//    (an intervening modifier), so this walks forward through the next
//    few word tokens rather than anchoring immediately after the match.
const CONTENT_NOUN_PATTERN =
  /^(guidance|documentation|docs|heuristic|advice|note|policy|text|wording)$/i;
const CONTENT_NOUN_LOOKAHEAD_CHARS = 60;
const CONTENT_NOUN_LOOKAHEAD_TOKENS = 3;
const WORD_TOKEN_PATTERN = /[A-Za-z][\w-]*/g;
// 3. Preparatory-state: the match is the subject of a stative clause
//    describing an EXISTING staged foundation ("the architecture is being
//    prepared for additional providers" -- #2446), not this issue's own
//    proposed action. Distinct from an action-verb clause on the same word
//    ("architecture is redesigned across many subsystems" must still fail):
//    only a "being/already prepared|staged|planned|designed|built|readied
//    for" construction right after the match counts, never a bare "is
//    <verb>" alone.
const PREPARATORY_STATE_LOOKAHEAD_CHARS = 40;
const PREPARATORY_STATE_PATTERN =
  /^\s+(?:is|are|was|were)\s+(?:already\s+|currently\s+)?(?:being\s+)?(?:prepared|staged|planned|designed|built|readied)\s+for\b/i;
const NARROW_SCOPE_PATTERN =
  /\b(single module|single file|few files|targeted|small fix|localized|narrow scope)\b/i;
const OBJECTIVE_VERIFICATION_PATTERN =
  /\b(test(?:s|ing)?|lint(?:ing)?|ci|coverage|acceptance criteria|objective|measurable|deterministic|verifiable|automated)\b/i;
const SUBJECTIVE_VERIFICATION_PATTERN =
  /\b(feels?|looks? good|opinion|judgement?|ux call|maintainer preference|stakeholder preference|subjective)\b/i;
const EXTERNAL_COORDINATION_PATTERN =
  /\b(external coordination|human decision|maintainer decision|stakeholder sign-?off|manual approval|waiting for (?:maintainer|stakeholder)|external system|third-?party access|credential|production access|cross-repo dependency)\b/gi;
// A trigger phrase inside a phrase describing something other than a live,
// remaining completion blocker should not count (#2738), mirroring
// findUnexcludedBroadScopeMatch's per-occurrence shape above: a negated
// non-requirement, a quoted/cited example of another artifact's own
// content, a past-tense description of an investigation the issue author
// already finished while drafting, or a generic mention of a pattern/
// concept rather than an asserted requirement.
//
// 1. Negation: the match is governed by a negation cue reaching it with no
//    hard clause break in between ("no interactive credential minting" --
//    #2716). `zero` excludes a hyphenated compound ("zero-downtime") so it
//    is never mistaken for a standalone negation word. `without` is a
//    canceling word, not a cue of its own: "cannot complete this WITHOUT
//    production access" asserts the access is required, the mirror image
//    of "no access needed" (Codex review round 2, PR #2757) -- as a
//    standalone cue it wrongly negated exactly that shape. A canceling
//    conjunction ("do not proceed UNTIL production access is granted" --
//    Codex review, PR #2757) flips the negation back to an affirmative
//    prerequisite: the cue negates the verb before the conjunction, not
//    the requirement named after it.
const NEGATION_CUE_PATTERN =
  /\b(no|not|zero(?!-)|never|none|isn'?t|aren'?t|wasn'?t|weren'?t|doesn'?t|don'?t|didn'?t|won'?t|can'?t|cannot)\b/gi;
const NEGATION_CUE_WINDOW = 40;
const NEGATION_CANCELING_CONJUNCTION_PATTERN = /\b(until|unless|without)\b/i;
// "not only X" is an additive idiom that affirms X, not a negation of it
// ("Not only is production access needed for the rollout" -- Codex review
// round 4, PR #2757); scoped to an immediately-following "only" right
// after "not" specifically, not a general requirement-assertion
// cancellation (which would also wrongly cancel a genuine double negative
// like "No credential changes are needed").
const NOT_ONLY_IDIOM_PATTERN = /^\s*only\b/i;
// A backward-looking cue (negation or investigative past tense, below)
// stops governing a match at a period/semicolon/colon/em-dash, a blank
// line, or a following list-item marker -- a bullet's own negation must
// not reach into a SIBLING bullet's independent claim, and a colon
// introducing an independent requirement ("No workaround: production
// access is required before shipping" -- Codex review round 3, PR #2757)
// must not let the preceding negation cross into it. The pattern below
// (CUE_HARD_BREAK_PATTERN) is a superset of HARD_CLAUSE_BREAK_PATTERN
// (period/semicolon/em-dash only), which the broad-scope exclusions
// above use. A bare mid-paragraph newline (a soft-wrapped line) is
// deliberately not a break here: #2711's own wrapped quotation shows
// ordinary prose legitimately continuing a clause across one.
const CUE_HARD_BREAK_PATTERN =
  /[.;:—]|--|\n[ \t]*(?:[-*]\s|\d+[.)]\s)|\n[ \t]*\n/;
function isGovernedByBackwardCue(
  corpus: string,
  matchIndex: number,
  cuePattern: RegExp,
  window: number,
  cancelPattern?: RegExp,
): boolean {
  const windowStart = Math.max(0, matchIndex - window);
  const windowText = corpus.slice(windowStart, matchIndex);
  for (const cueMatch of windowText.matchAll(cuePattern)) {
    const linkText = windowText.slice(cueMatch.index + cueMatch[0].length);
    if (
      CUE_HARD_BREAK_PATTERN.test(linkText) ||
      CLAUSE_CONTINUATION_COMMA_PATTERN.test(linkText) ||
      (cancelPattern && cancelPattern.test(linkText)) ||
      (cueMatch[0].toLowerCase() === 'not' &&
        NOT_ONLY_IDIOM_PATTERN.test(linkText))
    ) {
      continue;
    }
    return true;
  }
  return false;
}
// 2. Quoted example: the match sits on a Markdown blockquote line (an
//    unambiguous citation on its own), or is bounded by a matching pair of
//    quote characters within the containing paragraph (#2711's
//    inverted-attribution quotation shape, which soft-wraps the quoted
//    marker across a line break -- scoped to the paragraph, not the
//    physical line, so that wrap doesn't defeat the pairing) AND no nearby
//    requirement-assertion word (4, below) overrides it -- a paired quote
//    alone does not distinguish a genuine cited example from ordinary
//    emphasis-quoting of this issue's own requirement (`The change
//    requires "production access" before it can ship` -- Codex review,
//    PR #2757); a framing/attribution-verb requirement was tried first but
//    over-scoped to a whole paragraph (wrongly attributing an unrelated
//    sentence's own reporting verb) or under-scoped to one sentence
//    (missing a genuine citation with no reporting verb of its own, as in
//    #2711's own real body -- Codex review round 2, PR #2757); reusing the
//    requirement-assertion check already built for generic mentions (4)
//    avoids both failure modes. A plain straight single quote also marks a
//    contraction ("doesn't") or a possessive after a digit ("2020's"), so a
//    candidate quote character counts as an opener only when the character
//    right before it is neither a letter nor a digit, and as a closer only
//    when the character right after it is neither a letter nor a digit --
//    a contraction's or digit-possessive's apostrophe always sits directly
//    adjacent to a letter or digit on at least one side and fails one of
//    those checks (Copilot review, PR #2757).
const QUOTE_CHAR_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  '‘': '’',
  '“': '”',
};
const QUOTE_ADJACENT_WORD_CHAR_PATTERN = /[A-Za-z0-9]/;
const PARAGRAPH_BREAK_PATTERN = /\n[ \t]*\n/g;
// 3. Investigative past tense: the match describes an investigation the
//    issue author already performed while drafting, not remaining work
//    (#2697's shape, applied here to EXTERNAL_COORDINATION_PATTERN).
const INVESTIGATIVE_PAST_TENSE_PATTERN =
  /\b(?:already|previously)\s+(?:checked|verified|confirmed|investigated|reviewed|searched)\b|\bi\s+(?:already\s+)?checked\b|\ba\s+search\s+(?:already\s+)?found\b|\bconfirmed\s+via\b/gi;
const INVESTIGATIVE_PAST_TENSE_WINDOW = 80;
// 4. Generic mention: the match is followed shortly by a noun naming a
//    general pattern/example rather than asserting a live requirement of
//    this issue ("...a least-privilege CI credential pattern..." -- an
//    incidental background mention in #2716's own real body, distinct
//    from that same issue's separately negated target phrase), UNLESS a
//    requirement-assertion cue (must/require/need/shall/blocked/pending/
//    ...) sits in the same clause -- `A credential approach MUST be
//    supplied by the maintainer before implementation` (Codex review, PR
//    #2757) still imposes a live requirement despite the generic-sounding
//    noun. `blocked`/`pending` cover emphasis-quoting with no must/require
//    wording of its own ("Shipping remains BLOCKED PENDING 'production
//    access'" -- Codex review round 3, PR #2757). `waiting` covers an
//    ongoing dependency the past-investigation exclusion would otherwise
//    wrongly suppress ("We already checked the reproduction and are now
//    WAITING ON production access" -- Codex review round 5, PR #2757):
//    the investigation cue is unrelated to the still-open dependency
//    named right after it.
const GENERIC_MENTION_NOUN_PATTERN =
  /^(pattern|example|scenario|convention|practice|concept|term|approach|precedent|case)$/i;
const GENERIC_MENTION_LOOKAHEAD_CHARS = 40;
const GENERIC_MENTION_LOOKAHEAD_TOKENS = 2;
const REQUIREMENT_ASSERTION_PATTERN =
  /\b(must|require[sd]?|requiring|needed|needs?|shall|mandatory|essential|blocked|blocking|pending|waiting)\b/i;
const REQUIREMENT_ASSERTION_WINDOW_CHARS = 80;

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `issue:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --issue spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger block calls parseArgs()
// synchronously at module-evaluation time, and a `const` declared after
// that point is still in the temporal dead zone when the trigger fires
// (see ci-wait-policy.mts's identical note).
const DISCOVER_VIABILITY_GATE_FLAG_SPEC = {
  '--issue': { type: 'string', multiple: true },
  '--issues': { type: 'string', multiple: true },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--csv': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.issueNumbers.length === 0) {
    throw new Error(
      'missing required --issue <number> (repeatable) or --issues <n1,n2,...>',
    );
  }

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  const summary = await evaluateDiscoverViability(args.issueNumbers, {
    loadIssue: buildIssueLoader(owner, repo),
    computeStructuralEvidence: (issue) =>
      computeLiveStructuralEvidence(port, owner, repo, issue),
  });

  if (args.csv) {
    process.stdout.write(renderCsv(summary));
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

export async function evaluateDiscoverViability(
  issueNumbers: unknown[],
  options: {
    loadIssue?: IssueLoader;
    /** #2767: optional hook computing the structural-evidence signal for
     * `issue` -- omitted (the default for every existing caller/test)
     * means every criterion's demotion check sees `undefined`, which
     * `hasAllStructuralSignals` treats as false, so behavior is byte-
     * identical to before this hook existed. The live CLI below is the
     * only caller that supplies one. */
    computeStructuralEvidence?: (
      issue: IssueLike,
    ) =>
      | StructuralEvidence
      | undefined
      | Promise<StructuralEvidence | undefined>;
  } = {},
): Promise<ViabilitySummary> {
  const { loadIssue, computeStructuralEvidence } = options;
  if (typeof loadIssue !== 'function') {
    throw new Error(
      'evaluateDiscoverViability requires loadIssue(issueNumber)',
    );
  }

  const viable: ViableItem[] = [];
  const discarded: DiscardedItem[] = [];

  for (const issueNumber of normalizeIssueNumbers(issueNumbers)) {
    const issue = await loadIssue(issueNumber);
    if (!issue) {
      discarded.push({
        number: issueNumber,
        title: '',
        failedCriteria: ['issue_not_found'],
      });
      continue;
    }
    if (String(issue.state ?? '').toUpperCase() !== 'OPEN') {
      discarded.push({
        number: Number(issue.number ?? issueNumber),
        title: String(issue.title ?? ''),
        failedCriteria: ['issue_not_open'],
      });
      continue;
    }

    // #2767: evaluate without structural evidence first, and only fetch it
    // (an extra network round trip in the live CLI) when the issue would
    // otherwise fail on a demotable criterion -- an issue that already
    // passes on wording alone never needs the demotion path, and neither
    // does one whose only failure is `clear_verification` (never
    // demotable), so this keeps the common case byte- and
    // network-identical to before this hook existed. (Copilot/Codex
    // review, PR #2840): the prior `!result.passed` condition alone fired
    // this fetch for a `clear_verification`-only failure too, spending an
    // editor-history request plus a collaborator-permission lookup that
    // could never change the outcome.
    let result = evaluateA4Viability(issue);
    const hasDemotableFailure = result.failedCriteria.some(
      (id) => id === 'limited_scope' || id === 'autonomous_completion',
    );
    if (hasDemotableFailure && computeStructuralEvidence) {
      // #2767: a transient GitHub API failure (rate limit, timeout, an
      // absent GraphQL connection) fetching structural evidence must not
      // abort evaluation of every other issue in this batch -- degrade to
      // "no evidence available" (the plain `result` computed above stays
      // unchanged) rather than letting the rejection propagate.
      let structuralEvidence: StructuralEvidence | undefined;
      try {
        structuralEvidence = await computeStructuralEvidence(issue);
      } catch {
        structuralEvidence = undefined;
      }
      if (structuralEvidence) {
        result = evaluateA4Viability(issue, structuralEvidence);
      }
    }
    if (result.passed) {
      // #2767: surface any demoted (`warn`) criterion even on an
      // otherwise-fully-passed issue, so a human reviewer still sees
      // what matched -- omitted when every criterion is an ordinary
      // pass, keeping the exact pre-#2767 shape for the common case.
      const hasWarning = result.criteria.some(
        (criterion) => criterion.result === 'warn',
      );
      viable.push({
        number: Number(issue.number ?? issueNumber),
        title: String(issue.title ?? ''),
        ...(hasWarning ? { criteria: result.criteria } : {}),
      });
      continue;
    }
    discarded.push({
      number: Number(issue.number ?? issueNumber),
      title: String(issue.title ?? ''),
      failedCriteria: result.failedCriteria,
      criteria: result.criteria,
    });
  }

  return {
    viable,
    discarded,
    summary: {
      total: viable.length + discarded.length,
      viableCount: viable.length,
      discardedCount: discarded.length,
      discardedByCriterion: countDiscardedCriteria(discarded),
    },
  };
}

export function evaluateA4Viability(
  issue: unknown,
  structuralEvidence?: StructuralEvidence,
): {
  passed: boolean;
  failedCriteria: string[];
  criteria: CriterionResult[];
} {
  const normalizedIssue = normalizeIssue(issue);
  const criteria: CriterionResult[] = [];
  const failedCriteria: string[] = [];

  for (const criterion of CRITERIA) {
    const result = criterion.evaluate(normalizedIssue, structuralEvidence);
    criteria.push({
      id: criterion.id,
      name: criterion.name,
      // #2767: a demoted result already carries `pass: true` from the
      // criterion itself, so `passed`/`failedCriteria` below need no
      // separate handling -- `result: 'warn'` is presentational only.
      result: result.pass ? (result.demoted ? 'warn' : 'pass') : 'fail',
      evidence: result.evidence,
    });
    if (!result.pass) {
      failedCriteria.push(criterion.id);
    }
  }

  return {
    passed: failedCriteria.length === 0,
    failedCriteria,
    criteria,
  };
}

// CommonMark inline code spans open and close on a run of backticks of the
// SAME length (a multi-backtick delimiter, e.g. ``` `` ```, lets literal
// single backticks appear inside), not on individual-backtick parity -- a
// run of a different length while a span is open is literal content, not a
// closer (#2738 Codex review round 2, PR #2757). A FENCED code block is
// different: its opening run needs only LEADING whitespace on its line
// (trailing content is a valid info string, e.g. ```ts -- Copilot/Codex
// review round 5, PR #2757) and has length >= 3, and CommonMark lets the
// closing fence be LONGER than the opener, not just equal (a fence opened
// with ``` and closed with ```` is still a valid, closed block -- Codex
// review round 3, PR #2757); an exact-length-only rule leaves such a block
// wrongly "open" for the rest of the corpus. A CLOSING fence, unlike the
// opener, allows no info string: it needs both leading AND trailing
// whitespace only. An inline run of 3+ backticks (e.g. all on one line,
// with non-whitespace before it) still requires an exact-length closer.
// Finally, a run with NO valid closer anywhere in the corpus (a stray
// unmatched backtick, e.g. "contains a stray `. Production access is
// required" -- Codex review round 4, PR #2757) never forms a code span at
// all per CommonMark and must not be treated as an opener -- it is
// ordinary literal text, and scanning continues past it looking for the
// next potential opener. A fresh regex literal per call (rather than a
// shared module-level one) sidesteps both the CLI-entry TDZ ordering rule
// this file's helpers must follow (see the flag-spec comment below) and
// any `lastIndex` state leaking across calls.
function hasOnlyLeadingWhitespace(corpus: string, runStart: number): boolean {
  let before = runStart - 1;
  while (before >= 0 && (corpus[before] === ' ' || corpus[before] === '\t')) {
    before--;
  }
  return before < 0 || corpus[before] === '\n';
}
function hasOnlyTrailingWhitespace(corpus: string, runEnd: number): boolean {
  let after = runEnd;
  while (
    after < corpus.length &&
    (corpus[after] === ' ' || corpus[after] === '\t')
  ) {
    after++;
  }
  return after >= corpus.length || corpus[after] === '\n';
}
interface BacktickRun {
  index: number;
  end: number;
  length: number;
  isFenceOpenerCandidate: boolean;
  isFenceCloserCandidate: boolean;
}
function closesRun(candidate: BacktickRun, open: BacktickRun): boolean {
  return open.isFenceOpenerCandidate
    ? candidate.length >= open.length && candidate.isFenceCloserCandidate
    : candidate.length === open.length;
}
function isInsideCodeSpan(corpus: string, index: number): boolean {
  const runPattern = /`+/g;
  const runs: BacktickRun[] = [];
  let match: RegExpExecArray | null = runPattern.exec(corpus);
  while (match !== null) {
    const runIndex = match.index;
    const runEnd = runIndex + match[0].length;
    const leadingOk = hasOnlyLeadingWhitespace(corpus, runIndex);
    runs.push({
      index: runIndex,
      end: runEnd,
      length: match[0].length,
      isFenceOpenerCandidate: match[0].length >= 3 && leadingOk,
      isFenceCloserCandidate:
        match[0].length >= 3 &&
        leadingOk &&
        hasOnlyTrailingWhitespace(corpus, runEnd),
    });
    match = runPattern.exec(corpus);
  }
  let open: BacktickRun | null = null;
  for (const run of runs) {
    if (run.index >= index) {
      break;
    }
    if (open === null) {
      const hasCloser = runs.some(
        (candidate) => candidate.index > run.index && closesRun(candidate, run),
      );
      if (hasCloser) {
        open = run;
      }
    } else if (closesRun(run, open)) {
      open = null;
    }
  }
  return open !== null;
}

function isGovernedByAvoidanceCue(corpus: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - AVOIDANCE_CUE_WINDOW);
  const window = corpus.slice(windowStart, matchIndex);
  // A single "find the first cue" check misses a real governing cue when an
  // EARLIER, unrelated cue also sits in the window but is itself cut off by
  // a hard clause break: "Avoid regressions. But rather than redesign the
  // schema, ..." -- "avoid" is broken from the match by the period, but
  // "rather than" right before "redesign" governs it cleanly. Check every
  // cue in the window; the match is governed if any of them reach it with
  // no break in between.
  for (const cueMatch of window.matchAll(AVOIDANCE_CUE_PATTERN)) {
    const linkText = window.slice(cueMatch.index + cueMatch[0].length);
    if (HARD_CLAUSE_BREAK_PATTERN.test(linkText)) {
      continue;
    }
    if (CLAUSE_CONTINUATION_COMMA_PATTERN.test(linkText)) {
      continue;
    }
    return true;
  }
  return false;
}

function isFollowedByContentNoun(corpus: string, matchEnd: number): boolean {
  // The lookahead must stop at the first sentence/clause boundary: without
  // it, "... redesign the public interface. Guidance: ..." would let an
  // unrelated NEW sentence's "Guidance:" suppress a genuinely broad-scope
  // match in the PRECEDING sentence.
  const rawTail = corpus.slice(
    matchEnd,
    matchEnd + CONTENT_NOUN_LOOKAHEAD_CHARS,
  );
  const breakMatch = HARD_CLAUSE_BREAK_PATTERN.exec(rawTail);
  const tail = breakMatch ? rawTail.slice(0, breakMatch.index) : rawTail;
  const tokens = tail.match(WORD_TOKEN_PATTERN) ?? [];
  return tokens
    .slice(0, CONTENT_NOUN_LOOKAHEAD_TOKENS)
    .some((token) => CONTENT_NOUN_PATTERN.test(token));
}

function isFollowedByPreparatoryState(
  corpus: string,
  matchEnd: number,
): boolean {
  const tail = corpus.slice(
    matchEnd,
    matchEnd + PREPARATORY_STATE_LOOKAHEAD_CHARS,
  );
  return PREPARATORY_STATE_PATTERN.test(tail);
}

/**
 * Finds the first BROAD_SCOPE_PATTERN occurrence that survives every
 * exclusion check (#2417, #2446): a match inside a code span, governed by
 * an avoidance cue, followed by a content noun, or followed by a
 * preparatory-state clause does not describe this issue's own diff
 * footprint and is skipped.
 */
function findUnexcludedBroadScopeMatch(corpus: string): string | null {
  for (const match of corpus.matchAll(BROAD_SCOPE_PATTERN)) {
    const index = match.index;
    const end = index + match[0].length;
    if (
      isInsideCodeSpan(corpus, index) ||
      isGovernedByAvoidanceCue(corpus, index) ||
      isFollowedByContentNoun(corpus, end) ||
      isFollowedByPreparatoryState(corpus, end)
    ) {
      continue;
    }
    return match[0];
  }
  return null;
}

export function evaluateLimitedScope(
  issue: NormalizedIssue,
  structuralEvidence?: StructuralEvidence,
): EvalResult {
  const corpus = `${issue.title}\n${issue.body}`;
  // Test the broad-scope signal first: a broad/A4-fail cue must fail the
  // gate even when a narrow cue is also present (e.g. "single module change
  // that redesigns a public interface"). Returning narrow-pass first would
  // let that wording bypass the gate.
  const broadScopeMatch = findUnexcludedBroadScopeMatch(corpus);
  if (broadScopeMatch !== null) {
    // #2767: a false-positive broad-scope match is exactly the shape this
    // demotion targets -- demote to a warned pass only when every
    // structural signal (a runnable verification command, an existing
    // candidate file, a fully trusted author+editor set) holds; otherwise
    // behave exactly as before.
    if (hasAllStructuralSignals(structuralEvidence)) {
      return {
        pass: true,
        demoted: true,
        evidence: `Broad or cross-cutting scope signal detected: "${broadScopeMatch}" (demoted: structural evidence present).`,
      };
    }
    return {
      pass: false,
      evidence: `Broad or cross-cutting scope signal detected: "${broadScopeMatch}".`,
    };
  }
  if (NARROW_SCOPE_PATTERN.test(corpus)) {
    return {
      pass: true,
      evidence: 'Narrow-scope signal detected.',
    };
  }
  return {
    pass: true,
    evidence: 'No broad-scope signal detected.',
  };
}

export function evaluateClearVerification(issue: NormalizedIssue): EvalResult {
  const corpus = `${issue.title}\n${issue.body}`;
  if (OBJECTIVE_VERIFICATION_PATTERN.test(corpus)) {
    return {
      pass: true,
      evidence: 'Objective verification signal detected.',
    };
  }
  if (SUBJECTIVE_VERIFICATION_PATTERN.test(corpus)) {
    return {
      pass: false,
      evidence: 'Verification appears subjective or opinion-based.',
    };
  }
  return {
    pass: false,
    evidence: 'No objective verification signal detected.',
  };
}

function isGovernedByNegation(corpus: string, matchIndex: number): boolean {
  return isGovernedByBackwardCue(
    corpus,
    matchIndex,
    NEGATION_CUE_PATTERN,
    NEGATION_CUE_WINDOW,
    NEGATION_CANCELING_CONJUNCTION_PATTERN,
  );
}

function isLikelyQuoteOpener(charBefore: string): boolean {
  return !QUOTE_ADJACENT_WORD_CHAR_PATTERN.test(charBefore);
}

function isLikelyQuoteCloser(charAfter: string): boolean {
  return !QUOTE_ADJACENT_WORD_CHAR_PATTERN.test(charAfter);
}

function findParagraphSpan(
  corpus: string,
  offset: number,
): { start: number; end: number } {
  let start = 0;
  for (const breakMatch of corpus
    .slice(0, offset)
    .matchAll(PARAGRAPH_BREAK_PATTERN)) {
    start = breakMatch.index + breakMatch[0].length;
  }
  const afterBreak = /\n[ \t]*\n/.exec(corpus.slice(offset));
  const end = afterBreak ? offset + afterBreak.index : corpus.length;
  return { start, end };
}

function isInsideQuotedExample(
  corpus: string,
  matchIndex: number,
  matchEnd: number,
): boolean {
  const lineStart = corpus.lastIndexOf('\n', matchIndex - 1) + 1;
  if (/^[ \t]*>/.test(corpus.slice(lineStart, matchIndex))) {
    // Blockquote syntax alone does not establish the cited content is
    // non-blocking -- the same requirement-assertion safeguard used for a
    // paired quote below must also apply here ("> Production access is
    // required before shipping" -- Codex review round 4, PR #2757).
    return !isNearRequirementAssertion(corpus, matchIndex, matchEnd);
  }
  const { start: paragraphStart, end: paragraphEnd } = findParagraphSpan(
    corpus,
    matchIndex,
  );
  const before = corpus.slice(paragraphStart, matchIndex);
  const after = corpus.slice(matchEnd, paragraphEnd);
  for (const [open, close] of Object.entries(QUOTE_CHAR_PAIRS)) {
    const openIndex = before.lastIndexOf(open);
    if (
      openIndex === -1 ||
      !isLikelyQuoteOpener(openIndex > 0 ? before[openIndex - 1] : '')
    ) {
      continue;
    }
    const closeIndex = after.indexOf(close);
    if (
      closeIndex === -1 ||
      !isLikelyQuoteCloser(after[closeIndex + 1] ?? '')
    ) {
      continue;
    }
    // A paired quote alone is not proof of external citation -- a nearby
    // requirement-assertion word means the quotes are just emphasizing
    // THIS issue's own live requirement ("The change requires 'production
    // access' before it can ship" -- Codex review round 2, PR #2757),
    // regardless of unrelated framing prose elsewhere in the paragraph.
    return !isNearRequirementAssertion(corpus, matchIndex, matchEnd);
  }
  return false;
}

function isDescribedByPastInvestigation(
  corpus: string,
  matchIndex: number,
  matchEnd: number,
): boolean {
  // The investigation may have CONFIRMED the blocker still holds rather
  // than resolved it away ("We already verified production access IS
  // REQUIRED before this can ship" -- Codex review, PR #2757): a nearby
  // requirement-assertion word means the cited investigation's own
  // conclusion is that the prerequisite remains live.
  return (
    isGovernedByBackwardCue(
      corpus,
      matchIndex,
      INVESTIGATIVE_PAST_TENSE_PATTERN,
      INVESTIGATIVE_PAST_TENSE_WINDOW,
    ) && !isNearRequirementAssertion(corpus, matchIndex, matchEnd)
  );
}

function isNearRequirementAssertion(
  corpus: string,
  matchIndex: number,
  matchEnd: number,
): boolean {
  const forwardRaw = corpus.slice(
    matchEnd,
    matchEnd + REQUIREMENT_ASSERTION_WINDOW_CHARS,
  );
  const forwardBreak = HARD_CLAUSE_BREAK_PATTERN.exec(forwardRaw);
  const forwardText = forwardBreak
    ? forwardRaw.slice(0, forwardBreak.index)
    : forwardRaw;
  if (REQUIREMENT_ASSERTION_PATTERN.test(forwardText)) {
    return true;
  }
  const backwardStart = Math.max(
    0,
    matchIndex - REQUIREMENT_ASSERTION_WINDOW_CHARS,
  );
  const backwardRaw = corpus.slice(backwardStart, matchIndex);
  const priorBreaks = [
    ...backwardRaw.matchAll(new RegExp(HARD_CLAUSE_BREAK_PATTERN, 'g')),
  ];
  const lastBreak = priorBreaks.at(-1);
  const backwardText = lastBreak
    ? backwardRaw.slice(lastBreak.index + lastBreak[0].length)
    : backwardRaw;
  return REQUIREMENT_ASSERTION_PATTERN.test(backwardText);
}

function isFollowedByGenericMentionNoun(
  corpus: string,
  matchIndex: number,
  matchEnd: number,
): boolean {
  const rawTail = corpus.slice(
    matchEnd,
    matchEnd + GENERIC_MENTION_LOOKAHEAD_CHARS,
  );
  const breakMatch = HARD_CLAUSE_BREAK_PATTERN.exec(rawTail);
  const tail = breakMatch ? rawTail.slice(0, breakMatch.index) : rawTail;
  const tokens = tail.match(WORD_TOKEN_PATTERN) ?? [];
  const namesGenericPattern = tokens
    .slice(0, GENERIC_MENTION_LOOKAHEAD_TOKENS)
    .some((token) => GENERIC_MENTION_NOUN_PATTERN.test(token));
  return (
    namesGenericPattern &&
    !isNearRequirementAssertion(corpus, matchIndex, matchEnd)
  );
}

/**
 * True when `index` (an EXTERNAL_COORDINATION_PATTERN match start) falls
 * inside a genuine resolved-decision line -- #2763: `docs/idd-workflow.md`'s
 * Groom-pass workflow tells an operator to record a resolved hearing
 * outcome as `Maintainer decision (<provenance>, <date>): <resolution>`,
 * the exact shape `resolved-decision.mts`'s `findInlineResolvedDecisionSpans`
 * recognizes (single-sourced with suitability-triage.mts's Check 7, #2661)
 * so this file's own gate does not fail an issue groomed exactly as
 * documented, before Check 7 ever gets to honor it. `spans` is precomputed
 * once per `corpus` by the caller, not per match, since it always scans the
 * whole corpus regardless of which EXTERNAL_COORDINATION_PATTERN match is
 * currently being checked.
 */
function isWithinResolvedDecisionSpan(
  spans: { start: number; end: number }[],
  index: number,
): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

/**
 * Finds the first EXTERNAL_COORDINATION_PATTERN occurrence that survives
 * every exclusion check (#2738): a match inside a code span, governed by a
 * negation cue, inside a quoted/cited example, described as an
 * already-completed investigation, naming a generic pattern rather than an
 * asserted requirement, or opening a genuine resolved-decision line (#2763)
 * does not describe this issue's own remaining completion blocker and is
 * skipped.
 */
function findUnexcludedExternalCoordinationMatch(
  corpus: string,
): string | null {
  const resolvedDecisionSpans = findInlineResolvedDecisionSpans(corpus);
  for (const match of corpus.matchAll(EXTERNAL_COORDINATION_PATTERN)) {
    const index = match.index;
    const end = index + match[0].length;
    if (
      isInsideCodeSpan(corpus, index) ||
      isInsideQuotedExample(corpus, index, end) ||
      isGovernedByNegation(corpus, index) ||
      isDescribedByPastInvestigation(corpus, index, end) ||
      isFollowedByGenericMentionNoun(corpus, index, end) ||
      isWithinResolvedDecisionSpan(resolvedDecisionSpans, index)
    ) {
      continue;
    }
    return match[0];
  }
  return null;
}

export function evaluateAutonomousCompletion(
  issue: NormalizedIssue,
  structuralEvidence?: StructuralEvidence,
): EvalResult {
  // A blank line (not a bare "\n") between title and body, unlike the
  // other two evaluate* functions' corpus join: CUE_HARD_BREAK_PATTERN
  // treats "\n[ \t]*\n" as a hard break, so a negation or past-investigation
  // cue in the title can never govern a match in the body (a short title
  // like "No credential changes" must not suppress a genuine body blocker
  // -- Codex review round 2, PR #2757). An ordinary soft-wrapped line
  // inside the body is still a single "\n" and remains ungoverned by this
  // rule, per #2711's own wrapped-quotation requirement. `\r\n` is
  // normalized to `\n` (#2763) so this corpus's offsets share the same
  // 1-char line separator `findInlineResolvedDecisionSpans` normalizes to
  // internally -- without it, a CRLF issue body would drift the two
  // functions' coordinate spaces apart by one byte per CRLF line, the same
  // #2531-class risk `resolved-decision.mts` itself defends against.
  const corpus = `${issue.title}\n\n${issue.body}`.replace(/\r\n/g, '\n');
  const match = findUnexcludedExternalCoordinationMatch(corpus);
  if (match !== null) {
    // #2767: same demotion contract as evaluateLimitedScope above.
    if (hasAllStructuralSignals(structuralEvidence)) {
      return {
        pass: true,
        demoted: true,
        evidence: `External coordination or manual decision signal detected: "${match}" (demoted: structural evidence present).`,
      };
    }
    return {
      pass: false,
      evidence: `External coordination or manual decision signal detected: "${match}".`,
    };
  }
  return {
    pass: true,
    evidence: 'No external coordination signal detected.',
  };
}

/**
 * Walk `argv` and return every occurrence of the given long-flag literals
 * (e.g. `--issue`, `--issues`) in argv order, tagged with which flag
 * matched and its literal string value. `parseCliArgs` has already thrown
 * on anything malformed (a missing value, a flag-shaped value, an unknown
 * flag) by the time this runs, so this is a pure order-reconstruction pass
 * over already-validated input, not a second parse/validation pass. Covers
 * both the `--flag value` and `--flag=value` forms Node's `util.parseArgs`
 * itself accepts for a long option (#1450 review follow-up: grouping every
 * `--issue` occurrence before every `--issues` occurrence silently
 * reordered interleaved input, e.g. `--issues 1,2 --issue 3`).
 */
function collectOrderedOccurrences(
  argv: readonly string[],
  flagNames: readonly string[],
): { flag: string; value: string }[] {
  const occurrences: { flag: string; value: string }[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.indexOf('=');
    const bareFlag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (!flagNames.includes(bareFlag)) {
      continue;
    }
    const value =
      equalsIndex === -1 ? argv[index + 1] : token.slice(equalsIndex + 1);
    occurrences.push({ flag: bareFlag, value });
  }
  return occurrences;
}

export function parseArgs(argv: string[]): {
  issueNumbers: number[];
  csv: boolean;
  owner: string;
  repo: string;
  help: boolean;
} {
  const { values, help } = parseCliArgs(
    argv,
    DISCOVER_VIABILITY_GATE_FLAG_SPEC,
  );
  // Preserves the existing "collect every --issue occurrence plus every
  // comma-split --issues entry, in argv order, then silently drop
  // non-numeric tokens" contract (normalizeIssueNumbers) unchanged by this
  // migration -- only the flag-syntax parsing (missing/flag-shaped values,
  // unknown flags) is now strict.
  const issueTokens = collectOrderedOccurrences(argv, [
    '--issue',
    '--issues',
  ]).flatMap((occurrence) =>
    occurrence.flag === '--issues'
      ? occurrence.value.split(',')
      : [occurrence.value],
  );
  return {
    issueNumbers: normalizeIssueNumbers(issueTokens),
    csv: values.csv as boolean,
    owner: values.owner as string,
    repo: values.repo as string,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/discover-viability-gate.mjs --issue <number> [--issue <number> ...]
  node scripts/discover-viability-gate.mjs --issues <n1,n2,...>
    [--csv] [--owner <owner>] [--repo <repo>] [--help]

Output schema (JSON mode):
  {
    "viable": [{ "number": 123, "title": "..." }],
    "discarded": [{ "number": 124, "title": "...", "failedCriteria": ["..."] }],
    "summary": {
      "total": 2,
      "viableCount": 1,
      "discardedCount": 1,
      "discardedByCriterion": { "limited_scope": 1 }
    }
  }

A "discarded" item (and a "viable" item that carries at least one demoted
criterion, #2767) also includes "criteria": [{ "id", "name", "result",
"evidence" }], where "result" is "pass" | "warn" | "fail" -- "warn" means
a lexical-pattern fail was demoted to a passed, annotated result because
every structural-evidence signal (triage-structural-evidence.mts) held;
it counts as a pass for "passed"/"failedCriteria" but is worth a human's
attention. CSV mode's "warnings" column lists any such demoted criterion
ids, pipe-joined.
`);
}

function normalizeIssueNumbers(values: unknown[]): number[] {
  const parsed = values
    .map((value) => Number.parseInt(String(value).trim(), 10))
    .filter(Number.isInteger);
  return [...new Set(parsed)];
}

function normalizeIssue(issue: unknown): NormalizedIssue {
  const i = issue as IssueLike | null | undefined;
  return {
    number: Number(i?.number ?? 0),
    title: String(i?.title ?? ''),
    body: String(i?.body ?? ''),
    state: String(i?.state ?? ''),
  };
}

function countDiscardedCriteria(
  discarded: DiscardedItem[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of discarded) {
    for (const criterion of item.failedCriteria ?? []) {
      counts[criterion] = (counts[criterion] ?? 0) + 1;
    }
  }
  return counts;
}

/** #2767: pipe-joined ids of any `result: 'warn'` (demoted) criteria on
 * `item`, or `''` when `item` carries no `criteria` array (the common
 * case -- see `ViableItem.criteria`'s doc comment) or none were demoted. */
function warnCriteriaIds(item: { criteria?: CriterionResult[] }): string {
  return (item.criteria ?? [])
    .filter((criterion) => criterion.result === 'warn')
    .map((criterion) => criterion.id)
    .join('|');
}

export function renderCsv(summary: ViabilitySummary): string {
  const lines = ['kind,number,title,criteria,warnings'];
  for (const item of summary.viable) {
    lines.push(
      `viable,${item.number},${escapeCsv(item.title)},,${escapeCsv(
        warnCriteriaIds(item),
      )}`,
    );
  }
  for (const item of summary.discarded) {
    lines.push(
      `discarded,${item.number},${escapeCsv(item.title)},${escapeCsv(
        (item.failedCriteria ?? []).join('|'),
      )},${escapeCsv(warnCriteriaIds(item))}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function buildIssueLoader(
  owner: string,
  repo: string,
): (issueNumber: number) => IssueLike | null {
  // getWorkItem's contract (null on a genuine 404, throws on any other
  // failure) is pinned to this exact fail-closed routing -- see
  // provider-port.mts's doc comment on that method.
  const port = createGithubProviderAdapter(owner, repo);
  return function loadIssue(issueNumber: number): IssueLike | null {
    return port.getWorkItem(issueNumber);
  };
}

/**
 * #2767 live CLI wiring for `computeStructuralEvidence`: fetches the one
 * extra piece of live data the pure `triage-structural-evidence.mts`
 * helper needs beyond the already-loaded issue -- the edit history's
 * editor logins -- then builds the trust predicate from this repository's
 * configured `trustedMarkerActors` plus a live collaborator-permission
 * check, and the file-existence predicate from the real filesystem.
 */
function computeLiveStructuralEvidence(
  port: ReturnType<typeof createGithubProviderAdapter>,
  owner: string,
  repo: string,
  issue: IssueLike,
): StructuralEvidence | undefined {
  const issueNumber = Number(issue.number);
  if (!Number.isInteger(issueNumber)) {
    return undefined;
  }
  const { config } = loadPolicyConfig();
  const { actors: trustedMarkerLogins } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config: config as { trustedMarkerActors?: unknown } | null,
  });
  const collaboratorCache: CollaboratorPermissionCache = new Map();
  const isTrustedLogin = buildTrustedLoginPredicate(
    trustedMarkerLogins,
    (login) => {
      const { permission } = collaboratorPermission(
        owner,
        repo,
        login,
        collaboratorCache,
      );
      return permission === 'admin' || permission === 'write';
    },
  );
  const author = (issue.user as { login?: unknown } | null)?.login;
  const edits = port.getWorkItemUserContentEdits(issueNumber);
  return evaluateStructuralEvidence({
    body: String(issue.body ?? ''),
    author: typeof author === 'string' ? author : '',
    editorLogins: edits.map((edit) => edit.editorLogin),
    isTrustedLogin,
    existsAt: existsSync,
  });
}
