#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-viability-gate.mts
//
// The scripts/discover-viability-gate.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { parseCliArgs } from './cli-args.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';

interface NormalizedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
}

interface EvalResult {
  pass: boolean;
  evidence: string;
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
}

type IssueLoader = (
  issueNumber: number,
) => Promise<IssueLike | null> | IssueLike | null;

const CRITERIA: {
  id: string;
  name: string;
  evaluate: (issue: NormalizedIssue) => EvalResult;
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
  /\b(external coordination|human decision|maintainer decision|stakeholder sign-?off|manual approval|waiting for (?:maintainer|stakeholder)|external system|third-?party access|credential|production access|cross-repo dependency)\b/i;

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
  const summary = await evaluateDiscoverViability(args.issueNumbers, {
    loadIssue: buildIssueLoader(owner, repo),
  });

  if (args.csv) {
    process.stdout.write(renderCsv(summary));
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

export async function evaluateDiscoverViability(
  issueNumbers: unknown[],
  options: { loadIssue?: IssueLoader } = {},
): Promise<ViabilitySummary> {
  const { loadIssue } = options;
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

    const result = evaluateA4Viability(issue);
    if (result.passed) {
      viable.push({
        number: Number(issue.number ?? issueNumber),
        title: String(issue.title ?? ''),
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

export function evaluateA4Viability(issue: unknown): {
  passed: boolean;
  failedCriteria: string[];
  criteria: CriterionResult[];
} {
  const normalizedIssue = normalizeIssue(issue);
  const criteria: CriterionResult[] = [];
  const failedCriteria: string[] = [];

  for (const criterion of CRITERIA) {
    const result = criterion.evaluate(normalizedIssue);
    criteria.push({
      id: criterion.id,
      name: criterion.name,
      result: result.pass ? 'pass' : 'fail',
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

function isInsideCodeSpan(corpus: string, index: number): boolean {
  let backtickCount = 0;
  for (let i = 0; i < index; i += 1) {
    if (corpus[i] === '`') {
      backtickCount += 1;
    }
  }
  return backtickCount % 2 === 1;
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

export function evaluateLimitedScope(issue: NormalizedIssue): EvalResult {
  const corpus = `${issue.title}\n${issue.body}`;
  // Test the broad-scope signal first: a broad/A4-fail cue must fail the
  // gate even when a narrow cue is also present (e.g. "single module change
  // that redesigns a public interface"). Returning narrow-pass first would
  // let that wording bypass the gate.
  const broadScopeMatch = findUnexcludedBroadScopeMatch(corpus);
  if (broadScopeMatch !== null) {
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

export function evaluateAutonomousCompletion(
  issue: NormalizedIssue,
): EvalResult {
  const corpus = `${issue.title}\n${issue.body}`;
  if (EXTERNAL_COORDINATION_PATTERN.test(corpus)) {
    return {
      pass: false,
      evidence: 'External coordination or manual decision signal detected.',
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

export function renderCsv(summary: ViabilitySummary): string {
  const lines = ['kind,number,title,criteria'];
  for (const item of summary.viable) {
    lines.push(`viable,${item.number},${escapeCsv(item.title)},`);
  }
  for (const item of summary.discarded) {
    lines.push(
      `discarded,${item.number},${escapeCsv(item.title)},${escapeCsv(
        (item.failedCriteria ?? []).join('|'),
      )}`,
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
