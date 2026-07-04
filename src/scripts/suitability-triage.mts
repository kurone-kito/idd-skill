#!/usr/bin/env node
// idd-generated-from: src/scripts/suitability-triage.mts
//
// The scripts/suitability-triage.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghText,
  isCliExecution,
} from './gh-exec.mts';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mts';

interface NormalizedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
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

if (isCliExecution(import.meta.url)) {
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

export function checkDuplicateOrSuperseded(context: Context): CheckOutcome {
  const { issue, duplicateCandidates } = context;
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
  const result = evaluateSuitability(issue, {
    repository: { owner, repo },
    duplicateCandidates,
    blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
    needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
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

function parseArgs(argv: string[]): {
  issue: number | null;
  token: string;
  owner: string;
  repo: string;
  policy: string;
  verbose: boolean;
  help: boolean;
} {
  const parsed: {
    issue: number | null;
    token: string;
    owner: string;
    repo: string;
    policy: string;
    verbose: boolean;
    help: boolean;
  } = {
    issue: null,
    token: '',
    owner: '',
    repo: '',
    policy: '',
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--issue') {
      parsed.issue = Number.parseInt(String(value ?? ''), 10);
      index += 1;
      continue;
    }
    if (token === '--owner') {
      parsed.owner = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--token') {
      parsed.token = value ?? '';
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
    if (token === '--verbose') {
      parsed.verbose = true;
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
  node scripts/suitability-triage.mjs --issue <number> [--token <token>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--verbose]

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
  };
  return {
    number: Number.parseInt(String(i.number), 10),
    title: String(i.title ?? ''),
    body: String(i.body ?? ''),
    state: String(i.state ?? ''),
    labels: normalizeLabels(i.labels),
    url: String(i.url ?? i.html_url ?? ''),
  };
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
