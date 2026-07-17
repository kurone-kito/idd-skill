#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-viability-gate.mts
//
// The scripts/discover-viability-gate.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from './cli-args.mts';
import { GH_TEXT_LOOP_OPTIONS, ghText } from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';

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
  /\b(cross-cutting|cross cutting|across (?:many|multiple)|multiple subsystems?|repository-wide|entire repo|public interface|redesign|architecture|global refactor|large refactor)\b/i;
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
// Declared here, above the isMainModule trigger below, rather than
// alongside parseArgs further down: the trigger block calls parseArgs()
// synchronously at module-evaluation time, and a `const` declared after
// that point is still in the temporal dead zone when the trigger fires
// (see ci-wait-policy.mts's identical note).
const DISCOVER_VIABILITY_GATE_FLAG_SPEC = {
  '--issue': { type: 'string', multiple: true },
  '--issues': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--csv': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (isMainModule(import.meta.url)) {
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

  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_OPTIONS,
    );
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

export function evaluateLimitedScope(issue: NormalizedIssue): EvalResult {
  const corpus = `${issue.title}\n${issue.body}`;
  // Test the broad-scope signal first: a broad/A4-fail cue must fail the
  // gate even when a narrow cue is also present (e.g. "single module change
  // that redesigns a public interface"). Returning narrow-pass first would
  // let that wording bypass the gate.
  if (BROAD_SCOPE_PATTERN.test(corpus)) {
    return {
      pass: false,
      evidence: 'Broad or cross-cutting scope signal detected.',
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
  // comma-split --issues entry, then silently drop non-numeric tokens"
  // contract (normalizeIssueNumbers), unchanged by this migration -- only
  // the flag-syntax parsing (missing/flag-shaped values, unknown flags)
  // is now strict.
  const issueTokens = [
    ...((values.issue as string[] | undefined) ?? []),
    ...(values.issues === undefined
      ? []
      : String(values.issues as string).split(',')),
  ];
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
): (issueNumber: number) => Promise<IssueLike | null> {
  return async function loadIssue(
    issueNumber: number,
  ): Promise<IssueLike | null> {
    let data: IssueLike | null;
    try {
      data = ghJson([
        'api',
        `repos/${owner}/${repo}/issues/${issueNumber}`,
        '--jq',
        '.',
      ]) as IssueLike | null;
    } catch (error) {
      // Fail closed: only a genuine 404 means the issue is absent. Auth,
      // rate-limit, network, and unknown failures (status null) must
      // propagate so discovery aborts instead of marking the issue
      // not-found. `gh` exits 1 for every HTTP error, so derive the real
      // status from its output rather than the process exit code.
      if (deriveGhHttpStatus(error) === 404) {
        return null;
      }
      throw error;
    }
    if (!data) {
      return null;
    }
    return {
      number: Number(data.number),
      title: String(data.title ?? ''),
      body: String(data.body ?? ''),
      state: String(data.state ?? '').toUpperCase(),
    };
  };
}

function ghJson(args: string[]): unknown {
  const text = ghText(args, GH_TEXT_LOOP_OPTIONS);
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

function isMainModule(metaUrl: string): boolean {
  if (!metaUrl || !process.argv[1]) {
    return false;
  }
  // Compare filesystem paths instead of building a file:// URL from
  // argv[1], which mis-parses Windows drive-letter paths.
  return fileURLToPath(metaUrl) === resolve(process.argv[1]);
}
