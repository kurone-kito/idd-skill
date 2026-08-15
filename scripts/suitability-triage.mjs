#!/usr/bin/env node
// idd-generated-from: src/scripts/suitability-triage.mts
//
// The scripts/suitability-triage.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCliArgs } from './cli-args.mjs';
import {
  DEFAULT_BUNDLE_IDS,
  DEFAULT_MANIFEST_PATH,
  ghJson as ghJsonArray,
  parseCandidateFiles,
  resolveHighContentionFiles,
} from './discover-shared-file-overlap.mjs';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mjs';
import { loadPolicyConfig } from './idd-config.mjs';
import {
  findMarkdownCodeRanges,
  getMarkdownCodeRange,
  maskMarkdownCodeRegionsPreservingPositions,
} from './markdown-code.mjs';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mjs';
import { resolveTrustedMarkerActors } from './protocol-helpers.mjs';
import {
  buildClosedByMergedPrArgs,
  buildMergedPrListArgs,
  buildPrDetailArgs,
  evaluateHighConfidenceDuplicate,
  findCandidateFileOverlap,
  findTrustedSuitabilityRejection,
  prReferencesIssue,
  resolveCandidateFileSet,
} from './supersession-detection.mjs';

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
  '--token': { type: 'string', default: '' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--policy': { type: 'string', default: '' },
  '--manifest': { type: 'string', default: DEFAULT_MANIFEST_PATH },
  '--bundles': { type: 'string' },
  '--verbose': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
};
const CHECKS = [
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
// The repeated `disable` entries are preserved verbatim from the original
// inline regex literal (harmless redundancy in an alternation) to keep this
// pattern byte-identical rather than pulled in as an incidental fix here.
const POLICY_OVERRIDE_VERB_SOURCE =
  'ignore|bypass|override|disable|disable|skip|turn off|suppress|disable';
const POLICY_OVERRIDE_NOUN_SOURCE =
  'repo|repository|policy|workflow|idd|process|check|gate|requirement';
const POLICY_OVERRIDE_PATTERN = new RegExp(
  `\\b(${POLICY_OVERRIDE_VERB_SOURCE})\\b[\\s\\S]{0,60}\\b(${POLICY_OVERRIDE_NOUN_SOURCE})\\b`,
  'i',
);
// Reused by findNegationWithinTwoWordsAfter to stop the post-verb scan once
// the phrase's own noun is reached -- a negation word past the noun negates
// the *next* clause, not this trigger.
const POLICY_OVERRIDE_NOUN_PATTERN = new RegExp(
  `\\b(${POLICY_OVERRIDE_NOUN_SOURCE})\\b`,
  'i',
);
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
const NEGATION_IMMEDIATELY_BEFORE_PATTERN = new RegExp(
  `${NEGATION_PATTERN.source}(?:\\s+[^\\s.!?;,:]+){0,1}\\s*$`,
  'i',
);
// #2024: the post-verb negation word list deliberately excludes "ignore"
// and "skip" -- both trigger verbs *and* negation words -- so a chained
// directive ("Ignore and skip repository policy.") is never misread as the
// second verb negating the first. The before-check keeps the full
// NEGATION_PATTERN: "not"/"never"/etc. never double as trigger verbs, so
// there is no equivalent chaining risk there.
const POST_VERB_NEGATION_PATTERN =
  /\b(not|no|don'?t|doesn'?t|can'?t|won'?t|never|avoid|omit|exempt)\b/i;
// A clause boundary (sentence-ending punctuation, a comma/semicolon, or a
// colon) stops the post-verb scan outright -- see
// findNegationWithinTwoWordsAfter's clause terminator check for why
// (#2024 round 2, "Disable workflow; no notifications." /
// "Disable workflow, no notifications."; #2040, "Disable workflow: no
// notifications.").
const CLAUSE_TERMINATOR_PATTERN = /[.!?;,:]/;
// #2024: within the first two words after the trigger verb, is there a
// visible (non-masked) negation word, without crossing a clause boundary or
// the phrase's own noun? Word-tokenizes `rawSource` (not `maskedSource`) so
// a masked/inert word still consumes a word slot -- otherwise two
// consecutive masked words collapse to nothing and a real negation word
// three words away (e.g. "Ignore `warnings about` *not* following
// repository policy.") would wrongly look adjacent once "warnings about"
// vanishes into whitespace. Each candidate word must still be genuinely
// visible in `maskedSource` to count as real negation (an inert, code-only
// "not" never counts). A word containing clause-terminating punctuation
// (`.!?;,:`), or matching the phrase's own policy noun, ends the scan
// immediately, whether or not that word is itself a negation word -- a
// negation word past either boundary (e.g. "Disable workflow; *no*
// notifications." or "Disable workflow no questions asked.", where "no"
// follows the completed "Disable workflow" match) negates the next clause,
// not this trigger.
function findNegationWithinTwoWordsAfter(rawSource, maskedSource, afterStart) {
  let cursor = afterStart;
  const length = rawSource.length;
  for (let wordCount = 0; wordCount < 2; wordCount += 1) {
    while (cursor < length && /\s/.test(rawSource[cursor] ?? '')) {
      cursor += 1;
    }
    if (cursor >= length) {
      return false;
    }
    const wordStart = cursor;
    while (cursor < length && !/\s/.test(rawSource[cursor] ?? '')) {
      cursor += 1;
    }
    const rawWord = rawSource.slice(wordStart, cursor);
    const maskedWord = maskedSource.slice(wordStart, cursor);
    if (maskedWord.trim() !== '' && POST_VERB_NEGATION_PATTERN.test(rawWord)) {
      return true;
    }
    if (
      CLAUSE_TERMINATOR_PATTERN.test(rawWord) ||
      POLICY_OVERRIDE_NOUN_PATTERN.test(rawWord)
    ) {
      return false;
    }
  }
  return false;
}
// #2024: the detector must not fire on a negated instance of its own
// trigger pattern (e.g. "does not skip the required checks"). Reuse the
// existing NEGATION_PATTERN word list -- already wired into two other
// checks (checkRepositoryFit and the coordination-match loop later in this
// file) -- rather than inventing a new mechanism. A match is negated when a
// negation word appears either immediately before the trigger word, or
// within the first two words after it.
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
// 2. Never search out to "the nearest noun" for the after-verb check --
//    only the first two (raw-tokenized) words; see
//    findNegationWithinTwoWordsAfter above for the full rationale.
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
  rawSource,
  maskedSource,
  matchIndex,
  verb,
  getCodeRangeAt,
) {
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
  );
}
function findPolicyOverrideMatch(text, maskedText, getCodeRangeAt) {
  const maskedPattern = new RegExp(POLICY_OVERRIDE_PATTERN.source, 'gi');
  let maskedMatch;
  while (true) {
    maskedMatch = maskedPattern.exec(maskedText);
    if (maskedMatch === null) {
      break;
    }
    const index = maskedMatch.index;
    if (
      isNegatedPolicyOverrideMatch(
        text,
        maskedText,
        index,
        maskedMatch[1] ?? '',
        getCodeRangeAt,
      )
    ) {
      // A negated match's own greedy span can reach up to 60 chars past the
      // verb and swallow a second, genuine trigger further along (e.g.
      // "does not skip the release check. Ignore repository policy."). The
      // engine already auto-advanced lastIndex to the end of that whole
      // span; rewind it to resume scanning right after the skipped verb, so
      // a later independent trigger is never missed. Mirrors the code-only
      // skip's "resume just after the inert occurrence" rule below.
      maskedPattern.lastIndex = index + (maskedMatch[1]?.length || 1);
      continue;
    }
    return {
      index,
      text: text.slice(index, index + maskedMatch[0].length),
    };
  }
  // A real directive may wrap one of its tokens in inline code. The masked
  // pass intentionally removes that token, so inspect raw matches as a
  // fallback and retain only matches that are not wholly inside code.
  const pattern = new RegExp(POLICY_OVERRIDE_PATTERN.source, 'gi');
  let match;
  while (true) {
    match = pattern.exec(text);
    if (match === null) {
      break;
    }
    const index = match.index ?? -1;
    if (index < 0) {
      continue;
    }
    if (
      isNegatedPolicyOverrideMatch(
        text,
        maskedText,
        index,
        match[1] ?? '',
        getCodeRangeAt,
      )
    ) {
      // Same rewind as the masked-pass loop above: a negated match's own
      // greedy span can swallow a later, genuine trigger.
      pattern.lastIndex = index + (match[1]?.length || 1);
      continue;
    }
    const end = index + match[0].length;
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
      return { index, text: match[0] };
    }
  }
  return null;
}
if (import.meta.main) {
  runCli();
}
export function evaluateSuitability(issue, options = {}) {
  const normalized = normalizeIssue(issue);
  const context = {
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
  const checks = [];
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
export function checkRepositoryFit(context) {
  const { issue, repository } = context;
  if (!repository) {
    return {
      pass: true,
      evidence: 'Repository scope was not provided; check treated as pass.',
    };
  }
  const body = issue.body;
  const crossRepoLinks = [];
  const regex =
    /https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)\/(?:issues|pull)\/\d+/gi;
  let match = regex.exec(body);
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
export function checkCoherence(context) {
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
export function checkTrustSafety(context) {
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
export function checkDuplicateOrSuperseded(context) {
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
function computeSimilarity(str1, str2) {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) {
    return 1;
  }
  const distance = levenshteinDistance(str1, str2);
  return (maxLen - distance) / maxLen;
}
function levenshteinDistance(str1, str2) {
  const memo = {};
  function lev(i, j) {
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
export function checkActionability(context) {
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
export function checkAutonomy(context) {
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
export function checkVerifiability(context) {
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
  const hasSubjectiveApproval = (() => {
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
/**
 * #2102: `--issue`, `--body-file`, and `--stdin` select mutually exclusive
 * input modes; exactly one is required. Exported (and thus independently
 * testable) so both `throw` branches can be exercised without invoking
 * `runCli`'s own process-level side effects (env mutation, `gh` calls).
 */
export function resolveInputMode(args) {
  const inputModeCount =
    (args.issue !== null ? 1 : 0) +
    (args.bodyFile ? 1 : 0) +
    (args.stdin ? 1 : 0);
  if (inputModeCount === 0) {
    throw new Error('one of --issue, --body-file, or --stdin is required');
  }
  if (inputModeCount > 1) {
    throw new Error('choose only one of --issue, --body-file, or --stdin');
  }
  return args.bodyFile || args.stdin ? 'local' : 'issue';
}
function runCli() {
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
    config: policyConfig,
  });
  const existingRejectionCollectionWarnings = [];
  let existingRejection = null;
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
  const preEvidenceContext = {
    issue,
    repository: normalizeRepository({ owner, repo }),
    duplicateCandidates: [],
    trustSafetyAmbiguous: false,
  };
  const shouldCollectEvidence =
    checkRepositoryFit(preEvidenceContext).pass &&
    checkCoherence(preEvidenceContext).pass &&
    checkTrustSafety(preEvidenceContext).pass;
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
  // match only") already anticipates exactly this degradation. Both blocks
  // below run only when `shouldCollectEvidence` is true (#1815) -- when it
  // is false, Check 4 is never reached anyway, so `collectionWarnings`
  // correctly stays empty (this is a deliberate skip, not a collection
  // failure).
  const collectionWarnings = [];
  let closedByMergedPrNumbers = [];
  let candidateFiles = [];
  let highContentionFiles = [];
  let mergedPrs = [];
  if (shouldCollectEvidence) {
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
    try {
      candidateFiles = parseCandidateFiles(issue.body);
      // Only resolve the high-contention exclusion set (a file read + JSON
      // parse) when there is a '## Candidate files' section to check it
      // against -- most issues have none, and the result would otherwise be
      // discarded.
      const resolvedHighContentionFiles =
        candidateFiles.length > 0
          ? loadHighContentionFiles(
              args.manifest,
              args.bundles ?? DEFAULT_BUNDLE_IDS,
            )
          : null;
      const shouldScanMergedPrs =
        candidateFiles.length > 0 &&
        resolvedHighContentionFiles !== null &&
        issue.createdAt.length > 0;
      highContentionFiles = resolvedHighContentionFiles ?? [];
      if (candidateFiles.length > 0 && resolvedHighContentionFiles === null) {
        // Codex P2 review finding: an unreadable/missing high-contention
        // manifest silently skipped the same-candidate-files scan without
        // recording a warning -- but from Check 4's perspective this is the
        // same class of "high-confidence evidence could not be collected" as
        // a genuine gh/API failure, and must degrade the same way (exact
        // title match only), not let the full weak heuristic run.
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
          // Codex P2 review finding: a deadline-truncated scan returns
          // normally (not a throw), so it must record its own warning here --
          // otherwise Check 4 would run the full weak heuristic on
          // incomplete evidence instead of degrading to exact-title-only.
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
  }
  const highConfidenceDuplicate = {
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
export function evaluateSuitabilityLocal(bodyText, options = {}) {
  const { title, body } = splitLocalDraftTitleAndBody(bodyText);
  const localIssue = {
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
  const context = {
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
  const checks = CHECKS.map((check) => {
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
function runLocalCli(args) {
  const bodyText = args.stdin
    ? readFileSync(0, 'utf8')
    : readFileSync(resolve(process.cwd(), args.bodyFile), 'utf8');
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
function parseLenientIntegerOrNull(token) {
  return token === undefined ? null : Number.parseInt(token, 10);
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, SUITABILITY_TRIAGE_FLAG_SPEC);
  return {
    issue: parseLenientIntegerOrNull(values.issue),
    bodyFile: values['body-file'],
    stdin: values.stdin,
    token: values.token,
    owner: values.owner,
    repo: values.repo,
    policy: values.policy,
    manifest: values.manifest,
    // #1499: mirrors `discover-shared-file-overlap.mts`'s own `--bundles`
    // parsing exactly -- absent means "not passed" (`null`), present is a
    // comma-split, trimmed, empty-token-filtered list.
    bundles:
      values.bundles === undefined
        ? null
        : String(values.bundles)
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
    verbose: values.verbose,
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
function loadPolicy(policyPath) {
  return loadPolicyConfig(policyPath).config;
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/suitability-triage.mjs --issue <number> [--token <token>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--manifest <path>] [--bundles <id1,id2>] [--verbose] [--help]
  node scripts/suitability-triage.mjs (--body-file <path> | --stdin) [--policy <path>] [--verbose] [--help]

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
export function splitLocalDraftTitleAndBody(text) {
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
function normalizeIssue(issue) {
  const i = issue ?? {};
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
function normalizeHighConfidenceDuplicateInput(raw) {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw;
  return {
    closedByMergedPrNumbers: normalizePositiveIntArray(
      r.closedByMergedPrNumbers,
    ),
    candidateFiles: normalizeStringArray(r.candidateFiles),
    highContentionFiles: normalizeStringArray(r.highContentionFiles),
    mergedPrs: normalizeHighConfidenceMergedPrs(r.mergedPrs),
  };
}
function normalizePositiveIntArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}
function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry ?? ''))
    .filter((entry) => entry.length > 0);
}
function normalizeHighConfidenceMergedPrs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const e = entry ?? {};
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
function normalizeConfiguredLabelName(labelName, fallback) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : fallback;
}
function normalizeRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    return null;
  }
  const r = repository;
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
function normalizeDuplicateCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates
    .map((candidate) => {
      const c = candidate ?? {};
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
function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => (typeof label === 'string' ? label : (label?.name ?? '')))
    .map((label) => String(label).trim().toLowerCase())
    .filter(Boolean);
}
function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
function fetchIssue(repoRef, issueNumber) {
  const issue = ghJson(['api', `repos/${repoRef}/issues/${issueNumber}`]);
  return normalizeIssue(issue);
}
function fetchDuplicateCandidates(repoRef, issue) {
  const escapedTitle = issue.title.replaceAll('"', '\\"');
  const query = `repo:${repoRef} in:title "${escapedTitle}"`;
  const payload = ghJson([
    'api',
    `search/issues?q=${encodeURIComponent(query)}&per_page=50`,
  ]);
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
function fetchIssueComments(repoRef, issueNumber) {
  const comments = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const pageItems = ghJson([
      'api',
      `repos/${repoRef}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${page}`,
    ]);
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
function fetchClosedByMergedPrNumbers(owner, repo, issueNumber) {
  const parsed = ghJson(buildClosedByMergedPrArgs(owner, repo, issueNumber));
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
  repoRef,
  sinceIso,
  candidateFiles,
  highContentionFiles,
  candidateIssueNumber,
) {
  const list = ghJsonArray(buildMergedPrListArgs(repoRef, sinceIso));
  const mergedPrs = [];
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
    const pr = entry ?? {};
    const number = Number.parseInt(String(pr.number ?? ''), 10);
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    const detail = ghJson(buildPrDetailArgs(repoRef, number));
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
export function loadHighContentionFiles(manifestPath, bundleIds) {
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
    const bundles = manifest?.bundleBudgets;
    if (!Array.isArray(bundles)) {
      return null;
    }
    const nonEmptyFilesBundleIds = new Set(
      bundles
        .filter((bundle) => {
          const files = bundle?.files;
          return Array.isArray(files) && files.length > 0;
        })
        .map((bundle) => String(bundle?.id ?? '')),
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
function ghJson(args) {
  return JSON.parse(runGh(args).trim() || '{}');
}
function runGh(args) {
  try {
    return ghText(args, GH_TEXT_LOOP_TIMEOUT_OPTIONS);
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}
