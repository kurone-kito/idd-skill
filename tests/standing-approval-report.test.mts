import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fetchStandingApprovalReport,
  parseStandingApprovalRecordLine,
  renderStandingApprovalReportJson,
  renderStandingApprovalReportTable,
} from '../src/scripts/standing-approval-report.mts';
import { stubExecutable } from './test-utils.mts';

const CLI_ENTRY = fileURLToPath(
  new URL('../src/scripts/standing-approval-report.mts', import.meta.url),
);
const VALID_BUDGET =
  '<!-- idd-skill-standing-approval: class=budgetRaise; set=set-a734a6d5-f8d9-4d9a-a0c5-8eed2dcc1b12; anchor=kurone-kito/idd-skill#4883; ceiling=5; option=option-a -->';

/** One repository comment as the REST feed returns it. */
function feedComment(issueNumber: number, body: string) {
  return {
    body,
    issue_url: `https://api.github.com/repos/acme/widgets/issues/${issueNumber}`,
  };
}

test('parseStandingApprovalRecordLine accepts the three fixed classes', () => {
  assert.deepEqual(parseStandingApprovalRecordLine(VALID_BUDGET), {
    class: 'budgetRaise',
    set: 'set-a734a6d5-f8d9-4d9a-a0c5-8eed2dcc1b12',
    anchor: 'kurone-kito/idd-skill#4883',
    ceiling: '5',
    option: 'option-a',
  });
  assert.deepEqual(
    parseStandingApprovalRecordLine(
      '<!-- idd-skill-standing-approval: class=split; set=none; anchor=none; ceiling=8; option=split-now -->',
    ),
    {
      class: 'split',
      set: 'none',
      anchor: 'none',
      ceiling: '8',
      option: 'split-now',
    },
  );
  assert.deepEqual(
    parseStandingApprovalRecordLine(
      '<!-- idd-skill-standing-approval: class=release; set=none; anchor=kurone-kito/idd-skill#4883; ceiling=checklist; option=release-self-anchor -->',
    ),
    {
      class: 'release',
      set: 'none',
      anchor: 'kurone-kito/idd-skill#4883',
      ceiling: 'checklist',
      option: 'release-self-anchor',
    },
  );
});

test('parseStandingApprovalRecordLine rejects malformed fields and class ceilings', () => {
  const malformed = [
    VALID_BUDGET.replace('class=budgetRaise', 'class=unknown'),
    VALID_BUDGET.replace('; set=', '; extra=x; set='),
    VALID_BUDGET.replace('ceiling=5', 'ceiling=5%'),
    VALID_BUDGET.replace('ceiling=5', 'ceiling=11'),
    VALID_BUDGET.replace('option=option-a', 'option=Option A'),
    '<!-- idd-skill-standing-approval: class=split; set=none; anchor=none; ceiling=0; option=split-now -->',
    '<!-- idd-skill-standing-approval: class=release; set=none; anchor=none; ceiling=8; option=release -->',
  ];
  for (const line of malformed) {
    assert.equal(parseStandingApprovalRecordLine(line), null, line);
  }
});

test('parseStandingApprovalRecordLine accepts an opaque persisted set ID', () => {
  const parsed = parseStandingApprovalRecordLine(
    VALID_BUDGET.replace(/set=[^;]+/, 'set=legacy:authoring_set.42'),
  );
  assert.equal(parsed?.set, 'legacy:authoring_set.42');
});

test('fetchStandingApprovalReport lists every parsed record and counts malformed lines', () => {
  const calls: string[] = [];
  const report = fetchStandingApprovalReport(
    'kurone-kito',
    'idd-skill',
    (path) => {
      calls.push(path);
      if (path.startsWith('repos/kurone-kito/idd-skill/issues/comments?')) {
        return [
          feedComment(4883, `Decision\n${VALID_BUDGET}`),
          feedComment(
            4883,
            '<!-- idd-skill-standing-approval: class=split; set=none; anchor=none; ceiling=bad; option=split-now -->',
          ),
          feedComment(
            4930,
            '<!-- idd-skill-standing-approval: class=split; set=none; anchor=kurone-kito/idd-skill#4883; ceiling=8; option=option-a -->',
          ),
        ];
      }
      throw new Error(`unexpected API path: ${path}`);
    },
  );

  assert.deepEqual(report.records, [
    {
      class: 'budgetRaise',
      set: 'set-a734a6d5-f8d9-4d9a-a0c5-8eed2dcc1b12',
      anchor: 'kurone-kito/idd-skill#4883',
      ceiling: '5',
      option: 'option-a',
      issueNumber: 4883,
    },
    {
      class: 'split',
      set: 'none',
      anchor: 'kurone-kito/idd-skill#4883',
      ceiling: '8',
      option: 'option-a',
      issueNumber: 4930,
    },
  ]);
  assert.equal(report.malformedCount, 1);
  assert.equal(report.conversationCount, 2);
  assert.match(
    renderStandingApprovalReportTable(report),
    /#4883 \| budgetRaise/,
  );
  assert.match(
    renderStandingApprovalReportTable(report),
    /1 malformed marker line/,
  );
  assert.deepEqual(
    JSON.parse(renderStandingApprovalReportJson(report)),
    report,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? '', /sort=created&direction=asc/);
});

test('fetchStandingApprovalReport follows every page of the repository feed', () => {
  const calls: string[] = [];
  const report = fetchStandingApprovalReport('acme', 'widgets', (path) => {
    calls.push(path);
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
    if (page === 1) {
      return Array.from({ length: 100 }, () => feedComment(7, 'ordinary'));
    }
    if (page === 2) return [feedComment(42, VALID_BUDGET)];
    throw new Error(`unexpected feed page ${page}`);
  });

  assert.deepEqual(report.records, [
    {
      class: 'budgetRaise',
      set: 'set-a734a6d5-f8d9-4d9a-a0c5-8eed2dcc1b12',
      anchor: 'kurone-kito/idd-skill#4883',
      ceiling: '5',
      option: 'option-a',
      issueNumber: 42,
    },
  ]);
  assert.equal(report.conversationCount, 1);
  assert.equal(calls.length, 2);
});

test('fetchStandingApprovalReport returns an empty complete report for no comments', () => {
  const report = fetchStandingApprovalReport('acme', 'widgets', (path) => {
    assert.match(path, /^repos\/acme\/widgets\/issues\/comments\?/);
    return [];
  });
  assert.deepEqual(report.records, []);
  assert.equal(report.malformedCount, 0);
  assert.equal(report.conversationCount, 0);
});

test('fetchStandingApprovalReport fails closed on an unreadable feed page or item', () => {
  assert.throws(
    () =>
      fetchStandingApprovalReport('acme', 'widgets', () => ({
        body: 'not an array',
      })),
    /comments page 1 was not an array/,
  );
  assert.throws(
    () =>
      fetchStandingApprovalReport('acme', 'widgets', () => [
        { body: VALID_BUDGET },
      ]),
    /comments page 1 contained an unreadable comment/,
  );
  assert.throws(
    () =>
      fetchStandingApprovalReport('acme', 'widgets', () => [
        { body: VALID_BUDGET, issue_url: 'https://example.invalid/pull/x' },
      ]),
    /comments page 1 contained an unreadable comment/,
  );
});

test('CLI uses only read-only gh API requests', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-standing-approval-report-'));
  const callLog = join(tempRoot, 'gh-calls.jsonl');
  writeFileSync(callLog, '');
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.IDD_STANDING_REPORT_CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] !== 'api') { process.stderr.write('unexpected gh command\\n'); process.exitCode = 3; }
else if (args[1].startsWith('repos/acme/widgets/issues/comments?')) process.stdout.write(JSON.stringify([{body:${JSON.stringify(VALID_BUDGET)},issue_url:'https://api.github.com/repos/acme/widgets/issues/42'}]));
else { process.stderr.write('unexpected API path\\n'); process.exitCode = 4; }
`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, '--owner', 'acme', '--repo', 'widgets'],
      {
        encoding: 'utf8',
        env: { ...process.env, IDD_STANDING_REPORT_CALL_LOG: callLog },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      records: Array<{ issueNumber: number; class: string }>;
    };
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0]?.issueNumber, 42);
    const calls = readFileSync(callLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 2, JSON.stringify(calls));
    assert.deepEqual(calls[0]?.slice(0, 2), ['auth', 'token']);
    assert.ok(
      calls
        .slice(1)
        .every(
          (args) =>
            args[0] === 'api' &&
            !args.some((arg) =>
              ['--method', '-X', '--input', '-f', '-F'].includes(arg),
            ),
        ),
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI reads oversized feed pages without a stdout buffer cap', () => {
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'token') process.stdout.write('token');
else if (args[0] === 'api' && args[1].startsWith('repos/acme/widgets/issues/comments?')) {
  process.stdout.write(JSON.stringify([{body:'x'.repeat(2*1024*1024)+'\\n'+${JSON.stringify(VALID_BUDGET)},issue_url:'https://api.github.com/repos/acme/widgets/issues/42'}]));
} else { process.stderr.write('unexpected gh command\\n'); process.exitCode = 4; }
`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, '--owner', 'acme', '--repo', 'widgets'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      records: Array<{ issueNumber: number; set: string }>;
    };
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0]?.issueNumber, 42);
    assert.equal(
      report.records[0]?.set,
      'set-a734a6d5-f8d9-4d9a-a0c5-8eed2dcc1b12',
    );
  } finally {
    restore();
  }
});
