#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-viability-gate.mts
//
// The scripts/discover-viability-gate.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { GH_TEXT_LOOP_OPTIONS, ghText } from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';

const CRITERIA = [
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
if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
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
export async function evaluateDiscoverViability(issueNumbers, options = {}) {
  const { loadIssue } = options;
  if (typeof loadIssue !== 'function') {
    throw new Error(
      'evaluateDiscoverViability requires loadIssue(issueNumber)',
    );
  }
  const viable = [];
  const discarded = [];
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
export function evaluateA4Viability(issue) {
  const normalizedIssue = normalizeIssue(issue);
  const criteria = [];
  const failedCriteria = [];
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
export function evaluateLimitedScope(issue) {
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
export function evaluateClearVerification(issue) {
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
export function evaluateAutonomousCompletion(issue) {
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
function parseArgs(argv) {
  const parsed = {
    issueNumbers: [],
    csv: false,
    owner: '',
    repo: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--issue') {
      parsed.issueNumbers.push(value ?? '');
      index += 1;
      continue;
    }
    if (token === '--issues') {
      parsed.issueNumbers.push(...String(value ?? '').split(','));
      index += 1;
      continue;
    }
    if (token === '--owner') {
      parsed.owner = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--repo') {
      parsed.repo = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--csv') {
      parsed.csv = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return {
    ...parsed,
    issueNumbers: normalizeIssueNumbers(parsed.issueNumbers),
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-viability-gate.mjs --issue <number> [--issue <number> ...]
  node scripts/discover-viability-gate.mjs --issues <n1,n2,...>
    [--csv] [--owner <owner>] [--repo <repo>]

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
function normalizeIssueNumbers(values) {
  const parsed = values
    .map((value) => Number.parseInt(String(value).trim(), 10))
    .filter(Number.isInteger);
  return [...new Set(parsed)];
}
function normalizeIssue(issue) {
  const i = issue;
  return {
    number: Number(i?.number ?? 0),
    title: String(i?.title ?? ''),
    body: String(i?.body ?? ''),
    state: String(i?.state ?? ''),
  };
}
function countDiscardedCriteria(discarded) {
  const counts = {};
  for (const item of discarded) {
    for (const criterion of item.failedCriteria ?? []) {
      counts[criterion] = (counts[criterion] ?? 0) + 1;
    }
  }
  return counts;
}
export function renderCsv(summary) {
  const lines = ['kind,number,title,criteria'];
  for (const item of summary.viable) {
    lines.push(`viable,${item.number},${escapeCsv(item.title)},`);
  }
  for (const item of summary.discarded) {
    lines.push(
      `discarded,${item.number},${escapeCsv(item.title)},${escapeCsv((item.failedCriteria ?? []).join('|'))}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
function escapeCsv(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}
function buildIssueLoader(owner, repo) {
  return async function loadIssue(issueNumber) {
    let data;
    try {
      data = ghJson([
        'api',
        `repos/${owner}/${repo}/issues/${issueNumber}`,
        '--jq',
        '.',
      ]);
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
function ghJson(args) {
  const text = ghText(args, GH_TEXT_LOOP_OPTIONS);
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}
