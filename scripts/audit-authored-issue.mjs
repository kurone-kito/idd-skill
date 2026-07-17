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
import { isCliExecution } from './gh-exec.mjs';
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
// Matches a bare `#123` issue/PR reference or a full GitHub issue/PR URL.
// `#` alone (as in an ATX heading) never matches without trailing digits.
// The bare-`#` alternative excludes a `#` immediately preceded by a word
// character or `/` (a negative lookbehind), so cross-repo shorthand like
// `other/repo#123` does not match on its trailing `#123` — a cross-repo
// reference cannot be encoded with this repository's local `Blocked by` /
// `Depends on` markers, so flagging it here would be misleading rather than
// actionable. The full-URL alternative already requires a literal
// `https://github.com/` prefix, so it is unaffected by this exclusion.
const ISSUE_OR_PR_REFERENCE_PATTERN =
  /(?<![\w/])#(\d+)\b|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)\b/gi;
if (isCliExecution(import.meta.url)) {
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
    checkProseOnlyDependency(text),
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
function checkProseOnlyDependency(text) {
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
  for (const paragraph of text.split(/\n\s*\n/)) {
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
        const numberText = match[1] ?? match[2];
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
/**
 * Naively split a paragraph into sentences on `.`/`!`/`?` followed by
 * whitespace, after collapsing internal newlines to spaces (so a sentence
 * that wraps across a Markdown soft line break is still scoped as one
 * sentence). This is intentionally simple — good enough to separate two
 * independent clauses sharing one paragraph, not a full natural-language
 * sentence boundary detector.
 */
function splitIntoSentences(paragraph) {
  const flattened = paragraph.replace(/\s+/g, ' ').trim();
  if (flattened.length === 0) {
    return [];
  }
  return flattened.split(/(?<=[.!?])\s+/);
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
  --format <json|table>            output format (default: json)
  --help                           show this help
`);
}
function fail_(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}
