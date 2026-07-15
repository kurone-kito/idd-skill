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
// the roadmap-id/blocked-by dependency-marker rules, and visible/hidden
// line agreement for the suitability and effort footers.
//
// All marker value parsing is delegated to the existing
// autopilot-suitability.mts / effort.mts / marker-regex.mts /
// policy-helpers.mts helpers; this module only layers shape-aware
// structural checks on top of them. Pure and network-free — the CLI reads
// the drafted body from a file or stdin rather than fetching a live issue.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAutopilotSuitabilityMarker } from './autopilot-suitability.mjs';
import { parseEffortMarker } from './effort.mjs';
import { isCliExecution } from './gh-exec.mjs';
import { createMarkerRegex } from './marker-regex.mjs';
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
if (isCliExecution(import.meta.url)) {
  main();
}
/**
 * Audit a drafted issue body against the issue-authoring contract's
 * structural expectations for the declared shape. Every check runs
 * independently (no short-circuit), so one report surfaces every problem
 * at once instead of stopping at the first failure.
 */
export function auditAuthoredIssue(body, options) {
  const text = typeof body === 'string' ? body : String(body ?? '');
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
    checkSuitabilityVisibleLineAgreement(text, suitability),
    checkEffortVisibleLineAgreement(text, markerPrefix),
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
  const pattern = new RegExp(
    `<!--\\s*([^\\s>:]+)-(${AUTHORING_MARKER_SUFFIXES.join('|')}):[^>]*-->`,
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
  if (shape === 'roadmap') {
    if (roadmapIdCount !== 1) {
      return fail(
        id,
        name,
        `roadmap issues must carry exactly one roadmap-id marker, found ${roadmapIdCount}`,
      );
    }
    return pass(id, name, 'exactly one roadmap-id marker is present');
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
  return pass(id, name, `no roadmap-id marker on this ${shape} issue`);
}
function checkSuitabilityVisibleLineAgreement(text, suitability) {
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
  const match = /_Autopilot suitability:\s*([0-9]+)\s*\/\s*5/.exec(text);
  if (!match) {
    return fail(
      id,
      name,
      `missing or unparsable visible autopilot-suitability line for marker value ${suitability.value}`,
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
  const effort = parseEffortMarker(text, markerPrefix);
  if (!effort.present) {
    return pass(id, name, 'not applicable: no effort footer (optional)');
  }
  if (effort.malformed || effort.value === null) {
    return fail(
      id,
      name,
      'effort marker is present but its value is not a single coherent S/M/L hint',
    );
  }
  const match = /_Effort:\s*([A-Za-z]+)/.exec(text);
  if (!match) {
    return fail(
      id,
      name,
      `missing or unparsable visible effort line for marker value ${effort.value}`,
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
function countMarkerOccurrences(text, markerPrefix, suffix) {
  const base = createMarkerRegex(markerPrefix, suffix);
  const global = new RegExp(base.source, `${base.flags}g`);
  return [...text.matchAll(global)].length;
}
function extractHeadings(text) {
  const headings = new Set();
  // Skip lines inside fenced code blocks (``` or ~~~) so a heading-shaped
  // line that only appears inside a pasted template/example snippet does
  // not count as a genuine section heading and mask a truly missing one.
  let fenceChar = null;
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line.trim());
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      fenceChar = fenceChar === char ? null : (fenceChar ?? char);
      continue;
    }
    if (fenceChar !== null) {
      continue;
    }
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      headings.add(headingMatch[1].trim());
    }
  }
  return headings;
}
function normalizeMarkerPrefix(prefix) {
  return typeof prefix === 'string' && prefix.length > 0
    ? prefix
    : DEFAULT_MARKER_PREFIX;
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
  const targetPath = configPath
    ? resolve(process.cwd(), configPath)
    : resolve(process.cwd(), '.github/idd/config.json');
  try {
    const config = JSON.parse(readFileSync(targetPath, 'utf8'));
    return {
      markerPrefix: normalizeMarkerPrefix(config.markerPrefix),
      blockedByHumanLabelName:
        normalizePolicyConfig(config).labels.blockedByHumanLabelName,
    };
  } catch {
    return {
      markerPrefix: DEFAULT_MARKER_PREFIX,
      blockedByHumanLabelName: POLICY_DEFAULTS.labels.blockedByHumanLabelName,
    };
  }
}
function writeReport(report, format) {
  if (format === 'table') {
    console.log(
      `shape=${report.shape} markerPrefix=${report.markerPrefix} passed=${report.passed}`,
    );
    console.log(['id', 'result', 'detail'].join('\t'));
    for (const finding of report.findings) {
      console.log([finding.id, finding.result, finding.detail].join('\t'));
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
dependency-marker rules, and visible/hidden suitability+effort line
agreement. Exits 0 when every check passes, 1 when any check fails, 2 on
a usage error.

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
