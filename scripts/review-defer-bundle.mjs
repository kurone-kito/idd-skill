// idd-generated-from: src/scripts/review-defer-bundle.mts
//
// The scripts/review-defer-bundle.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Pure rendering and linting of the follow-up issue body that bundles one
// review pass's deferred findings (the "Bundle one E5 pass's deferred
// items" rule in idd-review-triage). renderDeferBundle builds the title and
// body; lintDeferBundle runs the orphan-shape authored-issue audit over
// them. There is no command-line entry point here: the command that wires
// these functions is a later roadmap issue.
import {
  auditAuthoredIssue,
  EFFORT_CANDIDATE_FILE_LIMITS,
} from './audit-authored-issue.mjs';
import { extractDeferSourceRefsIssueNumbers } from './discover-readiness-check.mjs';

const DEFER_SOURCE_VALUE = 'review-fix-loop-cutoff';
const AUTOPILOT_SUITABILITY_SCORE = 4;
const MARKER_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// An HTML comment opener in body text could hide the footers and the
// defer-source marker. A bare closer cannot open or close anything, so it is
// allowed as ordinary prose.
const HTML_COMMENT_OPENER_PATTERN = /<!--/;
const LINE_BREAK_PATTERN = /[\r\n]/;
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}
function requirePositiveInteger(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}
function requireMarkerPrefix(value) {
  const prefix = requireText(value, 'markerPrefix').trim();
  if (!MARKER_PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(
      'markerPrefix must start with a letter or digit and contain only letters, digits, dots, underscores, and hyphens',
    );
  }
  return prefix;
}
function rejectHtmlCommentOpener(value, field) {
  if (HTML_COMMENT_OPENER_PATTERN.test(value)) {
    throw new TypeError(`${field} must not contain an HTML comment opener`);
  }
}
function validateItem(raw, index) {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError(`items[${index}] must be an object`);
  }
  const item = raw;
  const at = (field) => `items[${index}].${field}`;
  const title = requireText(item.title, at('title'));
  rejectHtmlCommentOpener(title, at('title'));
  const threadUrl = requireText(item.threadUrl, at('threadUrl')).trim();
  if (LINE_BREAK_PATTERN.test(threadUrl)) {
    throw new TypeError(`${at('threadUrl')} must not contain a line break`);
  }
  rejectHtmlCommentOpener(threadUrl, at('threadUrl'));
  const finding = requireText(item.finding, at('finding'));
  rejectHtmlCommentOpener(finding, at('finding'));
  const acceptance = requireText(item.acceptance, at('acceptance'));
  rejectHtmlCommentOpener(acceptance, at('acceptance'));
  const path = requireText(item.path, at('path')).trim();
  if (LINE_BREAK_PATTERN.test(path)) {
    throw new TypeError(`${at('path')} must not contain a line break`);
  }
  if (path.includes('`')) {
    throw new TypeError(`${at('path')} must not contain a backtick`);
  }
  rejectHtmlCommentOpener(path, at('path'));
  return { title, threadUrl, finding, acceptance, path };
}
/** Replace each line break with one space, then trim the ends. */
function oneLine(value) {
  return value.replace(/\r\n|\r|\n/g, ' ').trim();
}
/**
 * Normalize CRLF and CR to LF, right-trim every line, keep interior
 * newlines, then trim the ends.
 */
function multiline(value) {
  return value
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}
/** Indent every continuation line by two spaces; blank lines stay empty. */
function indentContinuation(text) {
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line === '' ? line : `  ${line}`))
    .join('\n');
}
/**
 * Render the title and Markdown body of one follow-up issue that bundles a
 * review pass's deferred findings. Throws a TypeError naming the offending
 * field for any invalid input. Beyond the conditions listed in issue #4191,
 * it also refuses: a markerPrefix that does not start with a letter or digit
 * or that holds anything else than letters, digits, dots, underscores, and
 * hyphens (the prefix is written into HTML comments); a path with a backtick
 * or a line break (it sits in a code span); a line break in threadUrl; an
 * HTML comment opener in any body text; and item text that would give the
 * body a second Refs line by the same count the defer-source check uses.
 * Only that Refs invariant is guaranteed here. Every other lint finding, such
 * as a mid-line Depends on reference in prose, is left to lintDeferBundle.
 */
// audit:ignore-dead-export: wired by the idd-review-defer-bundle command in a later roadmap issue
export function renderDeferBundle(input) {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('input must be an object');
  }
  const originIssue = requirePositiveInteger(input.originIssue, 'originIssue');
  const pr = requirePositiveInteger(input.pr, 'pr');
  const title = oneLine(requireText(input.title, 'title'));
  const markerPrefix = requireMarkerPrefix(input.markerPrefix);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new TypeError('items must be a non-empty array');
  }
  // Array.from visits holes, so a sparse array fails item validation instead
  // of silently dropping its entries.
  const items = Array.from(input.items, (raw, index) =>
    validateItem(raw, index),
  );
  const paths = [...new Set(items.map((item) => item.path))].sort();
  if (paths.length > EFFORT_CANDIDATE_FILE_LIMITS.M) {
    throw new TypeError(
      `items name ${paths.length} distinct paths, more than the ${EFFORT_CANDIDATE_FILE_LIMITS.M} one bundle may name; split the review pass into smaller bundles`,
    );
  }
  const effort = paths.length <= EFFORT_CANDIDATE_FILE_LIMITS.S ? 'S' : 'M';
  const background = [
    '## Background',
    '',
    `Deferred from PR #${pr} under the review defer policy; see the threads below.`,
    '',
    ...items.map((item) => `- ${oneLine(item.title)}: ${item.threadUrl}`),
  ].join('\n');
  const proposedChange = [
    '## Proposed change',
    '',
    ...items.map(
      (item) =>
        `- ${oneLine(item.title)}: ${indentContinuation(multiline(item.finding))}`,
    ),
  ].join('\n');
  const acceptanceCriteria = [
    '## Acceptance criteria',
    '',
    ...items.map((item) => `- [ ] ${oneLine(item.acceptance)}`),
  ].join('\n');
  const candidateFiles = [
    '## Candidate files',
    '',
    ...paths.map((path) => `- \`${path}\``),
  ].join('\n');
  const suitabilityFooter = [
    `_Autopilot suitability: ${AUTOPILOT_SUITABILITY_SCORE} / 5 -- higher is more autopilot-suitable;`,
    'below the configured floor is human-oriented._',
  ].join('\n');
  const effortFooter = [
    `_Effort: ${effort} -- author-estimated size; a soft autopilot selection`,
    'tie-breaker only._',
  ].join('\n');
  const body = [
    background,
    proposedChange,
    acceptanceCriteria,
    candidateFiles,
    `Refs #${originIssue}`,
    '---',
    suitabilityFooter,
    `<!-- ${markerPrefix}-autopilot-suitability: ${AUTOPILOT_SUITABILITY_SCORE} -->`,
    effortFooter,
    `<!-- ${markerPrefix}-effort: ${effort} -->`,
    `<!-- ${markerPrefix}-authoring-defer-source: ${DEFER_SOURCE_VALUE} -->`,
  ].join('\n\n');
  // Ask the same count the defer-source check uses, so render refuses exactly
  // when lint would find a second Refs line. Only the origin's line may stay.
  const refs = extractDeferSourceRefsIssueNumbers(body);
  if (refs.ambiguous || refs.numbers.length !== 1) {
    throw new TypeError(
      'items must not add a second Refs line: a title or finding line reads as a Refs reference to the defer-source check',
    );
  }
  return { title, body };
}
/**
 * Lint a rendered bundle with the orphan-shape authored-issue audit.
 * `failures` lists `<id>: <detail>` for every failing check. The lint does
 * not apply the effort candidate-file cap; renderDeferBundle enforces it. A
 * markerPrefix that fails the same rule as renderDeferBundle throws a
 * TypeError naming markerPrefix.
 */
// audit:ignore-dead-export: wired by the idd-review-defer-bundle command in a later roadmap issue
export function lintDeferBundle(rendered, markerPrefix) {
  const report = auditAuthoredIssue(rendered.body, {
    shape: 'orphan',
    markerPrefix: requireMarkerPrefix(markerPrefix),
    title: rendered.title,
  });
  return {
    passed: report.passed,
    failures: report.findings
      .filter((finding) => finding.result === 'fail')
      .map((finding) => `${finding.id}: ${finding.detail}`),
  };
}
