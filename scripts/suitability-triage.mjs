#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// cspell:ignore AKIA baprs xoxbaprs

const BLOCKED_LABELS = new Set(["status:blocked-by-human", "status:needs-decision"]);

const CHECKS = [
  {
    id: "repository_fit",
    name: "Repository Fit",
    failureOutcome: "out-of-scope",
    evaluate: checkRepositoryFit,
  },
  {
    id: "coherence",
    name: "Issue Coherence",
    failureOutcome: "unclear",
    evaluate: checkCoherence,
  },
  {
    id: "trust_safety",
    name: "Trust/Safety",
    failureOutcome: "invalid",
    evaluate: checkTrustSafety,
  },
  {
    id: "duplicate_or_superseded",
    name: "Duplicate or Superseded Work",
    failureOutcome: "duplicate",
    evaluate: checkDuplicateOrSuperseded,
  },
  {
    id: "actionability",
    name: "Actionability",
    failureOutcome: "needs-decision",
    evaluate: checkActionability,
  },
  {
    id: "autonomy",
    name: "Autonomy",
    failureOutcome: "blocked-by-human",
    evaluate: checkAutonomy,
  },
  {
    id: "verifiability",
    name: "Verifiability",
    failureOutcome: "needs-decision",
    evaluate: checkVerifiability,
  },
];

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
];

const UNSAFE_PATTERNS = [
  /\bcurl\b[^\n|]*\|\s*(?:sh|bash)\b/i,
  /\bwget\b[^\n|]*\|\s*(?:sh|bash)\b/i,
  /\beval\s*\(/i,
];

const EXECUTION_DIRECTIVE_PATTERN = /\b(run|execute|paste|install|invoke)\b[\s\S]{0,80}\b(command|script|snippet)\b/i;
const EXTERNAL_COORDINATION_PATTERN = /\b(cross-repo|cross repo|external repo|another repo|upstream change|maintainer of)\b/i;
const OUTCOME_SIGNAL_PATTERN = /\b(pass|fail|result|output|contains|include|present|required|objective|measurable|deterministic)\b/i;

if (isCliExecution()) {
  runCli();
}

export function evaluateSuitability(issue, options = {}) {
  const normalized = normalizeIssue(issue);
  const context = {
    issue: normalized,
    repository: normalizeRepository(options.repository),
    duplicateCandidates: normalizeDuplicateCandidates(options.duplicateCandidates),
    trustSafetyAmbiguous: Boolean(options.trustSafetyAmbiguous),
  };

  const checks = [];
  for (const check of CHECKS) {
    const result = check.evaluate(context);
    checks.push({
      id: check.id,
      name: check.name,
      result: result.pass ? "pass" : "fail",
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
    outcome: "pass",
    failedCheck: null,
    checks,
  };
}

export function checkRepositoryFit(context) {
  const { issue, repository } = context;
  if (!repository) {
    return {
      pass: true,
      evidence: "Repository scope was not provided; check treated as pass.",
    };
  }

  const body = issue.body;
  const crossRepoLinks = [];
  const regex = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)\/(?:issues|pull)\/\d+/gi;
  let match = regex.exec(body);
  while (match) {
    const owner = (match[1] ?? "").toLowerCase();
    const repo = (match[2] ?? "").toLowerCase();
    if (owner !== repository.owner || repo !== repository.repo) {
      crossRepoLinks.push(match[0]);
    }
    match = regex.exec(body);
  }
  if (crossRepoLinks.length > 0 && EXTERNAL_COORDINATION_PATTERN.test(body)) {
    return {
      pass: false,
      evidence: `Cross-repository references detected: ${crossRepoLinks.join(", ")}`,
    };
  }

  return {
    pass: true,
    evidence: crossRepoLinks.length > 0
      ? "Cross-repository links appear contextual; no explicit external coordination signal detected."
      : "No out-of-repository scope signals detected.",
  };
}

export function checkCoherence(context) {
  const { issue } = context;
  const title = issue.title.trim();
  const body = issue.body.trim();

  if (title.length < 5 || body.length < 20) {
    return {
      pass: false,
      evidence: "Issue title/body is too short to infer reliable intent.",
    };
  }
  if (/<<<<<<<|=======|>>>>>>>/.test(body)) {
    return {
      pass: false,
      evidence: "Issue body contains unresolved conflict markers.",
    };
  }
  if (/\bTBD\b|\bTODO\b/i.test(body) && !/\bAcceptance Criteria\b|\bScope\b|\bPurpose\b/i.test(body)) {
    return {
      pass: false,
      evidence: "Issue body still appears as an unfinished draft.",
    };
  }

  return {
    pass: true,
    evidence: "Issue body is structurally coherent and interpretable.",
  };
}

export function checkTrustSafety(context) {
  const { issue, trustSafetyAmbiguous } = context;
  const corpus = `${issue.title}\n${issue.body}`;

  if (trustSafetyAmbiguous) {
    return {
      pass: false,
      evidence: "Trust/safety evaluation marked ambiguous; failing closed.",
    };
  }

  const matchedSecret = SECRET_PATTERNS.find((pattern) => pattern.test(corpus));
  if (matchedSecret) {
    return {
      pass: false,
      evidence: `Potential secret pattern detected: ${matchedSecret}`,
    };
  }

  const matchedUnsafe = UNSAFE_PATTERNS.find((pattern) => pattern.test(corpus));
  if (matchedUnsafe) {
    if (!EXECUTION_DIRECTIVE_PATTERN.test(corpus)) {
      return {
        pass: true,
        evidence: "Unsafe command string appears as context only; no execution directive detected.",
      };
    }
    return {
      pass: false,
      evidence: `Unsafe command execution pattern detected: ${matchedUnsafe}`,
    };
  }

  return {
    pass: true,
    evidence: "No trust/safety blockers detected.",
  };
}

export function checkDuplicateOrSuperseded(context) {
  const { issue, duplicateCandidates } = context;
  const body = issue.body;

  if (/duplicate of #\d+/i.test(body) || /superseded by #\d+/i.test(body)) {
    return {
      pass: false,
      evidence: "Issue body declares duplicate/superseded status.",
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

  return {
    pass: true,
    evidence: duplicateCandidates.length === 0
      ? "No duplicate candidate matched."
      : `Checked ${duplicateCandidates.length} duplicate candidates; no match.`,
  };
}

export function checkActionability(context) {
  const { issue } = context;
  const body = issue.body;
  const hasAcceptance = /\bAcceptance Criteria\b|\bOutput\b|\bDeliverables\b/i.test(body);
  const hasChecklist = /^\s*[-*]\s+\[[ xX]\]/m.test(body);
  const hasSteps = /^\s*\d+\.\s+/m.test(body);

  if (hasAcceptance || hasChecklist || hasSteps) {
    return {
      pass: true,
      evidence: "Issue defines actionable scope and verifiable delivery details.",
    };
  }

  return {
    pass: false,
    evidence: "Issue lacks concrete actionable scope or acceptance detail.",
  };
}

export function checkAutonomy(context) {
  const { issue } = context;
  const labels = new Set(issue.labels);
  const body = issue.body;

  for (const label of BLOCKED_LABELS) {
    if (labels.has(label)) {
      return {
        pass: false,
        evidence: `Blocking label present: ${label}`,
      };
    }
  }

  if (/\brequires (?:maintainer|human) (?:decision|approval)\b/i.test(body)) {
    return {
      pass: false,
      evidence: "Issue explicitly requires external human coordination.",
    };
  }

  return {
    pass: true,
    evidence: "No external coordination blockers detected.",
  };
}

export function checkVerifiability(context) {
  const { issue } = context;
  const body = issue.body;
  const hasVerificationChannel = /\btests?\b|\bverification\b|\bvalidate\b|\blint\b|\bci\b/i.test(body);
  const hasObjectiveCriteria = /\bacceptance criteria\b|\bcoverage\b|\boutput\b/i.test(body)
    || (/^\s*\d+\.\s+/m.test(body) && OUTCOME_SIGNAL_PATTERN.test(body))
    || (/^\s*[-*]\s+\[[ xX]\]/m.test(body) && OUTCOME_SIGNAL_PATTERN.test(body));
  const hasObjectiveSignals = hasVerificationChannel || hasObjectiveCriteria;

  if (!hasObjectiveSignals) {
    return {
      pass: false,
      evidence: "Issue does not provide objective verification signals.",
    };
  }

  return {
    pass: true,
    evidence: "Issue includes objective verification language.",
  };
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isInteger(args.issue) || args.issue <= 0) {
    throw new Error("--issue is required and must be a positive integer");
  }
  if (args.token) {
    process.env.GH_TOKEN = args.token;
    process.env.GITHUB_TOKEN = args.token;
  }

  const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
  const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);
  const repoRef = `${owner}/${repo}`;

  const issue = fetchIssue(repoRef, args.issue);
  const duplicateCandidates = fetchDuplicateCandidates(repoRef, issue);
  const result = evaluateSuitability(issue, {
    repository: { owner, repo },
    duplicateCandidates,
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

function parseArgs(argv) {
  const parsed = {
    issue: null,
    token: "",
    owner: "",
    repo: "",
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === "--issue") {
      parsed.issue = Number.parseInt(String(value ?? ""), 10);
      index += 1;
      continue;
    }
    if (token === "--owner") {
      parsed.owner = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--token") {
      parsed.token = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--repo") {
      parsed.repo = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/suitability-triage.mjs --issue <number> [--token <token>] [--owner <owner>] [--repo <repo>] [--verbose]

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "issue": {"number": 392, "title": "...", "state": "OPEN", "url": "..."},
  "passed": true,
  "outcome": "pass|unclear|needs-decision|blocked-by-human|duplicate|out-of-scope|invalid",
  "failedCheck": "repository_fit|...|null",
  "checks": [{"id":"repository_fit","name":"Repository Fit","result":"pass|fail","evidence":"..."}]
}
`);
}

function normalizeIssue(issue) {
  return {
    number: Number.parseInt(String(issue.number), 10),
    title: String(issue.title ?? ""),
    body: String(issue.body ?? ""),
    state: String(issue.state ?? ""),
    labels: normalizeLabels(issue.labels),
    url: String(issue.url ?? issue.html_url ?? ""),
  };
}

function normalizeRepository(repository) {
  if (!repository || typeof repository !== "object") {
    return null;
  }
  const owner = String(repository.owner ?? "").trim().toLowerCase();
  const repo = String(repository.repo ?? "").trim().toLowerCase();
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

function normalizeDuplicateCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates.map((candidate) => ({
    number: Number.parseInt(String(candidate.number), 10),
    title: String(candidate.title ?? ""),
    state: String(candidate.state ?? ""),
    url: String(candidate.url ?? candidate.html_url ?? ""),
  })).filter((candidate) => Number.isInteger(candidate.number) && candidate.number > 0);
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name ?? ""))
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function fetchIssue(repoRef, issueNumber) {
  const issue = ghJson([
    "api",
    `repos/${repoRef}/issues/${issueNumber}`,
  ]);
  return normalizeIssue(issue);
}

function fetchDuplicateCandidates(repoRef, issue) {
  const escapedTitle = issue.title.replaceAll("\"", "\\\"");
  const query = `repo:${repoRef} in:title "${escapedTitle}"`;
  const payload = ghJson([
    "api",
    `search/issues?q=${encodeURIComponent(query)}&per_page=50`,
  ]);
  return normalizeDuplicateCandidates(payload.items ?? []);
}

function ghJson(args) {
  return JSON.parse(runGh(args).trim() || "{}");
}

function ghText(args) {
  return runGh(args).trim();
}

function runGh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}

function isCliExecution() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
