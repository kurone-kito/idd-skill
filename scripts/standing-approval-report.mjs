#!/usr/bin/env node
// idd-generated-from: src/scripts/standing-approval-report.mts
// Read-only repository-wide report of standing-approval records posted in
// issue and pull-request conversation comments.
import { parseCliArgs } from './cli-args.mjs';
import {
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghTextUnbounded,
  resolveGhOwnerRepo,
} from './gh-exec.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';

const SEARCH_PAGE_SIZE = 100;
const SEARCH_RESULT_CAP = 1000;
const MARKER_PREFIX = '<!-- idd-skill-standing-approval:';
const MARKER_PATTERN =
  /^<!-- idd-skill-standing-approval: class=(budgetRaise|split|release); set=(none|[A-Za-z0-9][A-Za-z0-9._:-]{0,127}); anchor=(none|[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*); ceiling=([^;\s<>]+); option=([a-z0-9-]+) -->$/;
const STANDING_APPROVAL_REPORT_FLAG_SPEC = {
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--format': { type: 'string', default: 'json' },
  '--help': { type: 'boolean', short: 'h' },
};
/**
 * Read one REST page without a fixed stdout buffer. Search results and
 * comment bodies are user-authored and can exceed execFileSync's 1 MiB
 * default even when the request is limited to 100 rows. ghTextUnbounded
 * captures through a temporary file and keeps the normal load-control and
 * GHES-host handling.
 */
function readGhApiJsonUnbounded(path) {
  const raw = ghTextUnbounded(['api', path], {
    timeout: GH_TEXT_LOOP_TIMEOUT_OPTIONS.timeout,
  });
  return JSON.parse(raw.trim() || '{}');
}
/** Parse one complete record line using the grammar recorded in issue #4886. */
export function parseStandingApprovalRecordLine(line) {
  const match = MARKER_PATTERN.exec(line);
  if (!match) return null;
  const [, approvalClass, set, anchor, ceiling, option] = match;
  if (
    approvalClass !== 'budgetRaise' &&
    approvalClass !== 'split' &&
    approvalClass !== 'release'
  ) {
    return null;
  }
  if (approvalClass === 'budgetRaise') {
    if (!/^(?:0|[1-9][0-9]*)$/.test(ceiling) || Number(ceiling) > 10) {
      return null;
    }
  } else if (approvalClass === 'split') {
    if (!/^[1-9][0-9]*$/.test(ceiling)) return null;
  } else if (ceiling !== 'checklist') {
    return null;
  }
  return { class: approvalClass, set, anchor, ceiling, option };
}
function parseIssueSearchPage(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const row = payload;
  if (
    typeof row.total_count !== 'number' ||
    !Number.isInteger(row.total_count) ||
    row.total_count < 0 ||
    typeof row.incomplete_results !== 'boolean' ||
    !Array.isArray(row.items)
  ) {
    return null;
  }
  const numbers = [];
  for (const item of row.items) {
    if (item === null || typeof item !== 'object') return null;
    const number = item.number;
    if (
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number <= 0
    ) {
      return null;
    }
    numbers.push(number);
  }
  return {
    totalCount: row.total_count,
    incompleteResults: row.incomplete_results,
    numbers,
  };
}
function fetchCandidateConversationNumbers(owner, repo, api) {
  const query = `repo:${owner}/${repo} in:comments idd-skill-standing-approval`;
  const fetchPage = (page) => {
    const path =
      `search/issues?q=${encodeURIComponent(query)}` +
      `&per_page=${SEARCH_PAGE_SIZE}&page=${page}`;
    const parsed = parseIssueSearchPage(api(path));
    if (!parsed) {
      throw new Error(
        `standing-approval-report: search page ${page} was not a readable response`,
      );
    }
    if (parsed.incompleteResults) {
      throw new Error(
        `standing-approval-report: GitHub marked search page ${page} incomplete`,
      );
    }
    return parsed;
  };
  const first = fetchPage(1);
  if (first.totalCount > SEARCH_RESULT_CAP) {
    throw new Error(
      `standing-approval-report: search returned ${first.totalCount} conversations, beyond GitHub's ${SEARCH_RESULT_CAP}-result search ceiling`,
    );
  }
  const pageCount = Math.max(1, Math.ceil(first.totalCount / SEARCH_PAGE_SIZE));
  const pages = [first];
  for (let page = 2; page <= pageCount; page += 1) {
    const parsed = fetchPage(page);
    if (parsed.totalCount !== first.totalCount) {
      throw new Error(
        'standing-approval-report: search result count changed during pagination',
      );
    }
    pages.push(parsed);
  }
  const collected = pages.flatMap((page) => page.numbers);
  if (collected.length !== first.totalCount) {
    throw new Error(
      `standing-approval-report: search pagination returned ${collected.length} of ${first.totalCount} conversations`,
    );
  }
  const uniqueNumbers = [...new Set(collected)];
  if (uniqueNumbers.length !== first.totalCount) {
    throw new Error(
      'standing-approval-report: search pagination returned duplicate conversations',
    );
  }
  return uniqueNumbers.sort((a, b) => a - b);
}
function fetchIssueComments(owner, repo, issueNumber, api) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const path =
      `repos/${owner}/${repo}/issues/${issueNumber}/comments` +
      `?per_page=${SEARCH_PAGE_SIZE}&page=${page}`;
    const payload = api(path);
    if (!Array.isArray(payload)) {
      throw new Error(
        `standing-approval-report: comments page ${page} for #${issueNumber} was not an array`,
      );
    }
    const pageComments = [];
    for (const item of payload) {
      if (
        item === null ||
        typeof item !== 'object' ||
        typeof item.body !== 'string'
      ) {
        throw new Error(
          `standing-approval-report: comments page ${page} for #${issueNumber} contained an unreadable comment`,
        );
      }
      pageComments.push({ body: item.body });
    }
    comments.push(...pageComments);
    if (pageComments.length < SEARCH_PAGE_SIZE) return comments;
  }
}
/** Fetch and parse every comment thread identified by GitHub's comment search. */
export function fetchStandingApprovalReport(
  owner,
  repo,
  api = readGhApiJsonUnbounded,
) {
  const conversationNumbers = fetchCandidateConversationNumbers(
    owner,
    repo,
    api,
  );
  const records = [];
  let malformedCount = 0;
  for (const issueNumber of conversationNumbers) {
    const comments = fetchIssueComments(owner, repo, issueNumber, api);
    for (const comment of comments) {
      for (const line of comment.body.split(/\r?\n/)) {
        if (!line.startsWith(MARKER_PREFIX)) continue;
        const parsed = parseStandingApprovalRecordLine(line);
        if (!parsed) {
          malformedCount += 1;
          continue;
        }
        records.push({ ...parsed, issueNumber });
      }
    }
  }
  records.sort(
    (left, right) =>
      left.issueNumber - right.issueNumber ||
      compareText(left.class, right.class) ||
      compareText(left.set, right.set) ||
      compareText(left.anchor, right.anchor) ||
      compareText(left.ceiling, right.ceiling) ||
      compareText(left.option, right.option),
  );
  return {
    repository: { owner, repo },
    conversationCount: conversationNumbers.length,
    malformedCount,
    records,
  };
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function renderStandingApprovalReportJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
export function renderStandingApprovalReportTable(report) {
  const lines = [
    `Standing approvals in ${report.repository.owner}/${report.repository.repo}`,
    '',
    '| issue/PR | class | set | anchor | ceiling | option |',
    '| ---: | --- | --- | --- | --- | --- |',
  ];
  if (report.records.length === 0) lines.push('| — | — | — | — | — | — |');
  for (const row of report.records) {
    lines.push(
      `| #${row.issueNumber} | ${row.class} | ${row.set} | ${row.anchor} | ${row.ceiling} | ${row.option} |`,
    );
  }
  lines.push(
    '',
    `Total: ${report.records.length} valid record(s), ${report.malformedCount} malformed marker line(s) across ${report.conversationCount} conversation(s).`,
  );
  return lines.join('\n');
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/standing-approval-report.mjs [--owner <owner>] [--repo <repo>] [--format json|table]

  --owner <owner>   Repository owner (default: auto-detected via gh repo view).
  --repo <repo>     Repository name (default: auto-detected via gh repo view).
  --format <format> Output format: json (default) or table.
  --help, -h        Show this help.
`);
}
function runCli() {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    STANDING_APPROVAL_REPORT_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    return 0;
  }
  const ownerFlag = String(values.owner ?? '').trim();
  const repoFlag = String(values.repo ?? '').trim();
  if ((ownerFlag === '') !== (repoFlag === '')) {
    throw markCliUsageError(
      new Error(
        'standing-approval-report: --owner and --repo must be used together',
      ),
    );
  }
  const format = String(values.format ?? 'json');
  if (format !== 'json' && format !== 'table') {
    throw markCliUsageError(
      new Error(
        `standing-approval-report: --format must be json or table, got: ${format}`,
      ),
    );
  }
  const { owner, repo } = resolveGhOwnerRepo(
    { owner: ownerFlag || undefined, repo: repoFlag || undefined },
    GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  );
  const report = fetchStandingApprovalReport(owner, repo);
  process.stdout.write(
    format === 'json'
      ? renderStandingApprovalReportJson(report)
      : `${renderStandingApprovalReportTable(report)}\n`,
  );
  return 0;
}
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('standing-approval-report', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}
