#!/usr/bin/env node
// idd-generated-from: src/scripts/suitability-triage.mts
//
// The scripts/suitability-triage.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCliArgs } from './cli-args.mts';
import {
  DEFAULT_BUNDLE_IDS,
  DEFAULT_EXTRA_FILES,
  DEFAULT_MANIFEST_PATH,
  ghJson as ghJsonArray,
  normalizeContentionPath,
  parseCandidateFiles,
  resolveHighContentionFiles,
} from './discover-shared-file-overlap.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mts';

/** Upper bound on the #1484 bounded merged-PR scan (mirrors B2.0's own
 * documented `gh pr list --limit 50`). */
const MERGED_PR_SCAN_LIMIT = 50;

/**
 * Wall-clock budget for the #1484 merged-PR file-overlap scan (CodeRabbit
 * review finding on this PR): up to MERGED_PR_SCAN_LIMIT sequential
 * `gh pr view` calls at 30s each could otherwise take ~25 minutes in the
 * worst case (a degraded/rate-limited GitHub API). Stop early and return
 * whatever has been collected once this budget elapses, rather than
 * blocking the whole A4.5 evaluation on a slow scan. Referenced from inside
 * `fetchMergedPrFileOverlapEvidence`, which the `import.meta.main` trigger
 * below can reach synchronously, so this must stay declared above that
 * trigger for the same temporal-dead-zone reason as `CLOSED_BY_MERGED_PR_QUERY`.
 */
const MERGED_PR_SCAN_DEADLINE_MS = 2 * 60 * 1000;

/**
 * GraphQL query for the closed-by-merged-PR read (#1484), bounded to the
 * first 50 closing-PR references. A later page could theoretically hold an
 * additional MERGED reference this misses, but that only makes the tier
 * under-detect (fall back to the weak heuristic) rather than over-detect --
 * the safe fail direction for a check that must never fail TOWARD a false
 * positive, so a full pagination loop (as `idd-roadmap-audit-execute.mts`'s
 * `hasOpenClosingPr` implements for its own different, block-a-close use
 * case) is not required here. Declared here, above the `import.meta.main`
 * trigger below, rather than alongside the other #1484 CLI glue further
 * down: the trigger calls `runCli()` synchronously at module-evaluation
 * time, and a `const` declared after that point is still in the temporal
 * dead zone when the trigger fires (see `discover-shared-file-overlap.mts`'s
 * identical note on its own flag-spec constant).
 */
const CLOSED_BY_MERGED_PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      closedByPullRequestsReferences(first:50){
        nodes { number state }
      }
    }
  }
}`;

/** Parsed CLI arguments. */
interface SuitabilityTriageArgs {
  issue: number | null;
  token: string;
  owner: string;
  repo: string;
  policy: string;
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
  '--token': { type: 'string', default: '' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--policy': { type: 'string', default: '' },
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

/** One merged PR's changed-file evidence for the high-confidence tier (#1484). */
export interface HighConfidenceMergedPr {
  number: number;
  mergedAt: string;
  files: string[];
}

/**
 * Mechanical B2.0-style evidence for the Check 4 high-confidence tier
 * (#1484): a candidate issue's own `closedByPullRequestsReferences`, plus a
 * bounded merged-PR-vs-`## Candidate files` overlap scan. Reuses
 * `discover-shared-file-overlap.mts`'s path normalization and high-contention
 * set instead of re-implementing either. Every field is defensively
 * re-validated by `evaluateHighConfidenceDuplicate` itself (not just at the
 * `evaluateSuitability` options boundary), so a caller that hand-builds a
 * `Context` directly -- as several existing tests already do, bypassing
 * normalization -- can never crash it or manufacture a false hit from a
 * malformed shape; a missing or malformed field just falls through to
 * today's weak heuristic unchanged.
 */
export interface HighConfidenceDuplicateInput {
  closedByMergedPrNumbers: number[];
  candidateFiles: string[];
  /** High-contention files (bundle + manifest) excluded from the overlap
   * check -- a coincidental hit on a broadly-shared file is not on its own
   * high-confidence evidence that THIS issue was superseded. */
  highContentionFiles: string[];
  mergedPrs: HighConfidenceMergedPr[];
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

interface CheckOutcome {
  pass: boolean;
  evidence: string;
}

interface CheckResult {
  id: string;
  name: string;
  result: string;
  evidence: string;
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
const SUBJECTIVE_SUBJECT_PATTERN =
  /\b(maintainer|stakeholder|human|opinion|judgment|judgement|ux|feel)\b/i;
const SUBJECTIVE_GATE_PATTERN = /\b(approval|sign-?off|decision|preference)\b/i;
const OUTCOME_SIGNAL_PATTERN =
  /\b(pass|fail|result|output|contains|include|present|required|objective|measurable|deterministic)\b/i;
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
const SUPPLIED_CONTENT_REFERENCE = String.raw`(?:this|that|following|attached|pasted|provided|the\s+(?:following|above|below|attached|pasted|provided))\s+(?:\S+\s+){0,2}?[\x60'"]?${SUPPLIED_CONTENT_NOUN}`;
const EXPLICIT_UNSAFE_DIRECTIVE_PATTERN = new RegExp(
  String.raw`\b${UNSAFE_DIRECTIVE_VERB}\b[\s\S]{0,100}\b(?:untrusted|user-provided|user input|(?:from|by)\s+(?:the\s+)?user|${SUPPLIED_CONTENT_REFERENCE})\b`,
  'i',
);
const NEGATION_PATTERN =
  /\b(not|no|don'?t|doesn'?t|can'?t|won'?t|never|avoid|skip|omit|ignore|exempt)\b/i;
const POLICY_OVERRIDE_PATTERN =
  /\b(ignore|bypass|override|disable|disable|skip|turn off|suppress|disable)\b[\s\S]{0,60}\b(repo|repository|policy|workflow|idd|process|check|gate|requirement)\b/i;
const ACCEPTANCE_CRITERIA_PATTERN = /^#+\s*Acceptance\s+Criteria\s*$/im;
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

  // Check for explicit policy-override directives
  if (POLICY_OVERRIDE_PATTERN.test(corpus)) {
    const match = corpus.match(POLICY_OVERRIDE_PATTERN);
    return {
      pass: false,
      evidence: `Policy-override directive detected: "${match?.[0] ?? ''}". Untrusted policy-manipulation instructions cannot be processed.`,
    };
  }

  // Check for explicit unsafe execution directives
  if (EXPLICIT_UNSAFE_DIRECTIVE_PATTERN.test(corpus)) {
    const match = corpus.match(EXPLICIT_UNSAFE_DIRECTIVE_PATTERN);
    return {
      pass: false,
      evidence: `Explicit unsafe execution directive detected: "${match?.[0] ?? ''}". Cannot execute untrusted user-provided instructions.`,
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

/**
 * High-confidence Check 4 tier (#1484): evaluate the mechanical B2.0-style
 * signals -- a merged closing-PR reference on the candidate issue itself, or
 * a merged PR that already changed one of the issue's own declared
 * `## Candidate files` (excluding high-contention/shared files, which many
 * unrelated issues touch and so are not on their own high-confidence
 * evidence that THIS issue was superseded). Returns `null` -- never a
 * synthesized verdict of its own -- whenever no strong signal fires, so the
 * caller falls through to the existing weak title/declaration heuristic
 * unchanged. This is the fail-safe contract the issue requires: never fail
 * TOWARD a false high-confidence flag. `input` may be `undefined` (evidence
 * not collected by the caller) or a partially malformed shape; both degrade
 * to "no verdict" rather than a crash or a false hit.
 */
export function evaluateHighConfidenceDuplicate(
  input: HighConfidenceDuplicateInput | undefined,
): CheckOutcome | null {
  if (!input) {
    return null;
  }

  const closedByMergedPrNumbers = (
    Array.isArray(input.closedByMergedPrNumbers)
      ? input.closedByMergedPrNumbers
      : []
  ).filter((n) => Number.isInteger(n) && n > 0);
  if (closedByMergedPrNumbers.length > 0) {
    return {
      pass: false,
      evidence: `High-confidence duplicate: issue is already referenced by merged closing PR(s) #${closedByMergedPrNumbers.join(', #')} (closedByPullRequestsReferences).`,
    };
  }

  const highContention = new Set(
    (Array.isArray(input.highContentionFiles)
      ? input.highContentionFiles
      : []
    ).map((file) => normalizeContentionPath(file)),
  );
  const candidateFiles = [
    ...new Set(
      (Array.isArray(input.candidateFiles) ? input.candidateFiles : [])
        .map((file) => normalizeContentionPath(file))
        .filter((file) => file.length > 0 && !highContention.has(file)),
    ),
  ];
  if (candidateFiles.length === 0) {
    return null;
  }
  const candidateSet = new Set(candidateFiles);

  const mergedPrs: unknown[] = Array.isArray(input.mergedPrs)
    ? input.mergedPrs
    : [];
  for (const raw of mergedPrs) {
    const pr = (raw ?? {}) as {
      number?: unknown;
      mergedAt?: unknown;
      files?: unknown;
    };
    const number = Number(pr.number);
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    const files = Array.isArray(pr.files) ? pr.files : [];
    const overlap = [
      ...new Set(files.map((file) => normalizeContentionPath(file))),
    ].filter((file) => candidateSet.has(file));
    if (overlap.length > 0) {
      const mergedAt = String(pr.mergedAt ?? '');
      return {
        pass: false,
        evidence: `High-confidence duplicate: merged PR #${number}${mergedAt ? ` (merged ${mergedAt})` : ''} already changed candidate file(s): ${overlap.sort().join(', ')}.`,
      };
    }
  }

  return null;
}

export function checkDuplicateOrSuperseded(context: Context): CheckOutcome {
  const highConfidence = evaluateHighConfidenceDuplicate(
    context.highConfidenceDuplicate,
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
    const contextBefore = body.slice(Math.max(0, matchIndex - 60), matchIndex);
    const contextAfter = body.slice(
      matchIndex + matchedText.length,
      Math.min(body.length, matchIndex + matchedText.length + 60),
    );

    // Check if negated (either before or immediately after)
    if (
      NEGATION_PATTERN.test(contextBefore) ||
      NEGATION_PATTERN.test(contextAfter)
    ) {
      // This is a negated non-requirement; skip this match
      continue;
    }

    return {
      pass: false,
      evidence:
        'Issue explicitly requires external human coordination or approval.',
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
    // Require either a list (starting with - or *) or numbered content with outcome signals
    if (/^[-*]\s+/.test(contentAfter) || /^\d+\.\s+/.test(contentAfter)) {
      const hasOutcomeSignals = OUTCOME_SIGNAL_PATTERN.test(contentAfter);
      if (hasOutcomeSignals) {
        hasObjectiveCriteria = true;
      }
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
    const lines = body.split(/\r?\n/);
    return (
      lines.some(
        (line) =>
          SUBJECTIVE_SUBJECT_PATTERN.test(line) &&
          SUBJECTIVE_GATE_PATTERN.test(line),
      ) ||
      /\b(approval|sign-?off|decision|preference)\b[\s\S]{0,80}\b(maintainer|stakeholder|human|opinion|judgment|judgement|ux|feel)\b/i.test(
        body,
      )
    );
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

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.issue === null || !Number.isInteger(args.issue) || args.issue <= 0) {
    throw new Error('--issue is required and must be a positive integer');
  }
  if (args.token) {
    process.env.GH_TOKEN = args.token;
    process.env.GITHUB_TOKEN = args.token;
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
  const labelsPolicy = normalizePolicyConfig(loadPolicy(args.policy)).labels;

  // #1484: high-confidence Check 4 tier evidence. The two mechanical signals
  // (closedByPullRequestsReferences, and the same-candidate-files merged-PR
  // scan) are collected in two SEPARATE try/catch blocks (CodeRabbit review
  // finding on this PR): an earlier version wrapped both in one block, so a
  // failure collecting the second signal discarded an already-successful
  // first signal too. Each block's own failure is recorded independently in
  // `collectionWarnings` and degrades only that one signal to empty/absent
  // -- never silently reported as "no evidence" (that would mask a
  // genuinely broken collector as a clean pass), and never discarding a
  // sibling signal that already collected cleanly. `gh`/API fetch failures
  // in either block are always recorded here; a manifest-unavailable
  // same-candidate-files skip is a distinct, deliberate degradation
  // documented on `loadHighContentionFiles` itself, not a fetch failure, so
  // it is not added to this list (Copilot review finding on this PR: an
  // earlier comment overclaimed that every degradation path surfaces here).
  // This is also why an uncaught failure no longer aborts the entire
  // 7-check evaluation (Codex review finding on this PR) -- this tier is an
  // optional enhancement layered onto Check 4, and Check 4's own documented
  // Edge Case ("Timeout on duplicate detection... fall back to exact title
  // match only") already anticipates exactly this degradation.
  const collectionWarnings: string[] = [];
  let closedByMergedPrNumbers: number[] = [];
  try {
    closedByMergedPrNumbers = fetchClosedByMergedPrNumbers(
      owner,
      repo,
      args.issue,
    );
  } catch (error) {
    collectionWarnings.push(
      `closedByPullRequestsReferences: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let candidateFiles: string[] = [];
  let highContentionFiles: string[] = [];
  let mergedPrs: HighConfidenceMergedPr[] = [];
  try {
    candidateFiles = parseCandidateFiles(issue.body);
    // Only resolve the high-contention exclusion set (a file read + JSON
    // parse) when there is a '## Candidate files' section to check it
    // against -- most issues have none, and the result would otherwise be
    // discarded.
    const resolvedHighContentionFiles =
      candidateFiles.length > 0 ? loadHighContentionFiles() : null;
    const shouldScanMergedPrs =
      candidateFiles.length > 0 &&
      resolvedHighContentionFiles !== null &&
      issue.createdAt.length > 0;
    highContentionFiles = resolvedHighContentionFiles ?? [];
    mergedPrs = shouldScanMergedPrs
      ? fetchMergedPrFileOverlapEvidence(repoRef, issue.createdAt)
      : [];
  } catch (error) {
    collectionWarnings.push(
      `same-candidate-files scan: ${error instanceof Error ? error.message : String(error)}`,
    );
    candidateFiles = [];
    mergedPrs = [];
  }

  const highConfidenceDuplicate: SuitabilityOptions['highConfidenceDuplicate'] =
    {
      closedByMergedPrNumbers,
      candidateFiles,
      highContentionFiles,
      mergedPrs,
    };

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
    ...(collectionWarnings.length > 0
      ? { highConfidenceDuplicateCollectionWarnings: collectionWarnings }
      : {}),
    checks: args.verbose
      ? result.checks
      : result.checks.map((check) => ({
          id: check.id,
          name: check.name,
          result: check.result,
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

export function parseArgs(argv: string[]): SuitabilityTriageArgs {
  const { values, help } = parseCliArgs(argv, SUITABILITY_TRIAGE_FLAG_SPEC);
  return {
    issue: parseLenientIntegerOrNull(values.issue as string | undefined),
    token: values.token as string,
    owner: values.owner as string,
    repo: values.repo as string,
    policy: values.policy as string,
    verbose: values.verbose as boolean,
    help,
  };
}

/**
 * Load and parse `.github/idd/config.json` (or `--policy <path>` when given),
 * falling back to `{}` on a missing/invalid default path so the CLI stays
 * usable without any policy file (#1273; mirrors the sibling helpers'
 * `loadPolicy` pattern, e.g. `discover-orphan-filter.mts`). An explicit
 * `--policy <path>` that fails to read/parse throws, matching the sibling
 * helpers' fail-loud behavior for an operator-specified path.
 */
function loadPolicy(policyPath: string): unknown {
  const targetPath = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), '.github/idd/config.json');
  try {
    return JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch (error) {
    if (!policyPath) {
      return {};
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load policy from ${targetPath}: ${detail}`);
  }
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/suitability-triage.mjs --issue <number> [--token <token>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--verbose] [--help]

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "issue": {"number": 392, "title": "...", "state": "OPEN", "url": "..."},
  "passed": true,
  "outcome": "ready|unclear|needs-decision|blocked-by-human|duplicate|out-of-scope|invalid",
  "failedCheck": "repository_fit|...|null",
  "checks": [{"id":"repository_fit","name":"Repository Fit","result":"pass|fail","evidence":"..."}]
}
`);
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
  };
  return {
    closedByMergedPrNumbers: normalizePositiveIntArray(
      r.closedByMergedPrNumbers,
    ),
    candidateFiles: normalizeStringArray(r.candidateFiles),
    highContentionFiles: normalizeStringArray(r.highContentionFiles),
    mergedPrs: normalizeHighConfidenceMergedPrs(r.mergedPrs),
  };
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
      };
      return {
        number: Number(e.number),
        mergedAt: String(e.mergedAt ?? ''),
        files: normalizeStringArray(e.files),
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

// --- #1484: high-confidence Check 4 tier CLI glue ---------------------------
// Read-only: every function below only ever calls `gh api graphql` (with a
// `query` operation, never `mutation`), `gh pr list`, or `gh pr view` (no
// -X/--method, no issue/PR mutation subcommand).
// #1484 is detect-only by design; do not add a mutating gh call here -- a
// later gated-close follow-up (#1485) is a separate, human-gated change.
// The argv-builders are exported so tests can assert the exact read-only
// verb without shelling out (a compiled-text grep for mutating verb
// literals would miss a `gh api ... -X POST`-shaped mutation, since none of
// this file's own calls use one).

/**
 * Argv for the closed-by-merged-PR read. Uses `gh api graphql` rather than
 * `gh issue view --json closedByPullRequestsReferences`: the latter's
 * REST-shimmed shape carries no per-PR `state`, and the connection includes
 * OPEN (not yet merged) PRs, not only merged ones -- confirmed empirically
 * against this repo's own issue #1489 (OPEN) / PR #1497 (OPEN), and matches
 * `idd-roadmap-audit-execute.mts`'s documented note that the field "returns
 * merged PRs even with `includeClosedPrs:false`" (i.e. state alone
 * determines relevance, not that flag). Filtering to `state === 'MERGED'`
 * happens in `fetchClosedByMergedPrNumbers` below, after this fetch --
 * without it, an issue with only an in-progress unmerged closing PR would
 * wrongly read as "already referenced by a merged closing PR".
 */
export function buildClosedByMergedPrArgs(
  owner: string,
  repo: string,
  issueNumber: number,
): string[] {
  return [
    'api',
    'graphql',
    '-f',
    `query=${CLOSED_BY_MERGED_PR_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
    '-F',
    `number=${issueNumber}`,
  ];
}

/** Argv for the bounded merged-PR list scan (mirrors B2.0's own documented
 * `gh pr list --search "merged:>=<since>"` shape). */
export function buildMergedPrListArgs(
  repoRef: string,
  sinceIso: string,
): string[] {
  return [
    'pr',
    'list',
    '--repo',
    repoRef,
    '--state',
    'merged',
    '--search',
    `merged:>=${sinceIso}`,
    '--json',
    'number,mergedAt',
    '--limit',
    String(MERGED_PR_SCAN_LIMIT),
  ];
}

/** Argv for one merged PR's changed-file list. */
export function buildPrFilesArgs(repoRef: string, prNumber: number): string[] {
  return [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repoRef,
    '--json',
    'files',
    '--jq',
    '.files[].path',
  ];
}

/**
 * Fetch the candidate issue's own merged closing-PR references. Throws (via
 * `runGh`, no try/catch here) on a `gh` error rather than silently reading a
 * broken fetch as "no evidence" -- the latter would make a real duplicate
 * look clean. The caller (`runCli`) wraps this and its sibling fetches below
 * in one try/catch so a failure here degrades the optional high-confidence
 * tier (Check 4's own documented "Timeout on duplicate detection... fall
 * back to exact title match only" Edge Case) without aborting the other six
 * checks (Codex review finding on this PR: an earlier version let this
 * throw uncaught all the way out of `runCli`, crashing the whole
 * evaluation).
 */
function fetchClosedByMergedPrNumbers(
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
  const nodes =
    parsed.data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
  return nodes
    .filter((node) => String(node?.state ?? '') === 'MERGED')
    .map((node) => Number.parseInt(String(node?.number ?? ''), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Bounded two-step merged-PR file-overlap scan (list, then per-PR file
 * list), mirroring B2.0's own documented commands exactly rather than a new
 * query shape. A malformed list entry (non-positive-integer or absent
 * `number`) is skipped rather than shelled out to `gh pr view` (Copilot
 * review finding on this PR: `ghJsonArray` intentionally returns
 * `unknown[]`, so an unexpected API shape should degrade this one entry,
 * not become a hard `gh pr view NaN`/`gh pr view 0` failure). Also stops
 * early, returning whatever has been collected so far, once
 * `MERGED_PR_SCAN_DEADLINE_MS` elapses (CodeRabbit review finding on this
 * PR: up to `MERGED_PR_SCAN_LIMIT` sequential `gh pr view` calls with no
 * overall cap could otherwise run for tens of minutes under a
 * degraded/rate-limited GitHub API). A genuine `gh` error on a well-formed
 * entry still throws -- the caller (`runCli`) wraps this and its sibling
 * fetch in a separate try/catch so that surfaces as the documented Check 4
 * Edge Case fallback for just this signal, without discarding the other.
 */
function fetchMergedPrFileOverlapEvidence(
  repoRef: string,
  sinceIso: string,
): HighConfidenceMergedPr[] {
  const list = ghJsonArray(buildMergedPrListArgs(repoRef, sinceIso));
  const results: HighConfidenceMergedPr[] = [];
  const deadline = Date.now() + MERGED_PR_SCAN_DEADLINE_MS;
  for (const entry of list) {
    if (Date.now() >= deadline) {
      break;
    }
    const pr = (entry ?? {}) as { number?: unknown; mergedAt?: unknown };
    const number = Number.parseInt(String(pr.number ?? ''), 10);
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    const files = runGh(buildPrFilesArgs(repoRef, number))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    results.push({ number, mergedAt: String(pr.mergedAt ?? ''), files });
  }
  return results;
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
 * flag". `closedByPullRequestsReferences` is a separate, independent signal
 * and is unaffected by this fallback.
 */
function loadHighContentionFiles(): string[] | null {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), DEFAULT_MANIFEST_PATH), 'utf8'),
    );
    return [
      ...resolveHighContentionFiles({
        manifest,
        bundleIds: DEFAULT_BUNDLE_IDS,
        extraFiles: DEFAULT_EXTRA_FILES,
      }),
    ];
  } catch {
    return null;
  }
}

function ghJson(args: string[]): unknown {
  return JSON.parse(runGh(args).trim() || '{}');
}

function runGh(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? '').trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}
