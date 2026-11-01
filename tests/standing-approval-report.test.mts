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

function searchPage(numbers: number[], totalCount = numbers.length) {
  return {
    total_count: totalCount,
    incomplete_results: false,
    items: numbers.map((number) => ({ number })),
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

test('fetchStandingApprovalReport lists every parsed record and counts malformed lines', () => {
  const calls: string[] = [];
  const report = fetchStandingApprovalReport(
    'kurone-kito',
    'idd-skill',
    (path) => {
      calls.push(path);
      if (path.startsWith('search/issues?')) return searchPage([4883, 4930]);
      if (
        path.startsWith('repos/kurone-kito/idd-skill/issues/4883/comments?')
      ) {
        return [
          { body: `Decision\n${VALID_BUDGET}` },
          {
            body: '<!-- idd-skill-standing-approval: class=split; set=none; anchor=none; ceiling=bad; option=split-now -->',
          },
        ];
      }
      if (
        path.startsWith('repos/kurone-kito/idd-skill/issues/4930/comments?')
      ) {
        return [
          {
            body: '<!-- idd-skill-standing-approval: class=split; set=none; anchor=kurone-kito/idd-skill#4883; ceiling=8; option=option-a -->',
          },
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
  assert.equal(calls.length, 3);
});

test('fetchStandingApprovalReport paginates complete search results', () => {
  const calls: string[] = [];
  const report = fetchStandingApprovalReport('acme', 'widgets', (path) => {
    calls.push(path);
    if (path.startsWith('search/issues?')) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
      if (page === 1) {
        return searchPage(
          Array.from({ length: 100 }, (_, index) => index + 1),
          101,
        );
      }
      return searchPage([101], 101);
    }
    return [];
  });
  assert.equal(report.conversationCount, 101);
  assert.equal(report.records.length, 0);
  assert.ok(calls.some((path) => path.includes('page=2')));
  assert.equal(calls.length, 103);

  let commentFetches = 0;
  assert.throws(
    () =>
      fetchStandingApprovalReport('acme', 'widgets', (path) => {
        if (path.startsWith('search/issues?')) return searchPage([42, 42], 2);
        commentFetches += 1;
        return [];
      }),
    /duplicate conversations/,
  );
  assert.equal(commentFetches, 0);
});

test('fetchStandingApprovalReport returns an empty complete report for no matches', () => {
  const report = fetchStandingApprovalReport('acme', 'widgets', (path) => {
    assert.match(path, /^search\/issues\?/);
    return searchPage([]);
  });
  assert.deepEqual(report.records, []);
  assert.equal(report.malformedCount, 0);
  assert.equal(report.conversationCount, 0);
});

test('fetchStandingApprovalReport fails closed on incomplete or over-limit search', () => {
  assert.throws(
    () =>
      fetchStandingApprovalReport('acme', 'widgets', () => ({
        total_count: 1,
        incomplete_results: true,
        items: [{ number: 1 }],
      })),
    /marked search page 1 incomplete/,
  );
  assert.throws(
    () =>
      fetchStandingApprovalReport('acme', 'widgets', () =>
        searchPage([], 1001),
      ),
    /beyond GitHub's 1000-result search ceiling/,
  );
});

test('fetchStandingApprovalReport fails closed on unstable search and comments failures', () => {
  let page = 0;
  assert.throws(
    () =>
      fetchStandingApprovalReport('acme', 'widgets', (path) => {
        if (!path.startsWith('search/issues?')) return [];
        page += 1;
        return searchPage(
          page === 1 ? Array.from({ length: 100 }, (_, i) => i + 1) : [101],
          page === 1 ? 101 : 102,
        );
      }),
    /search result count changed during pagination/,
  );
  assert.throws(
    () =>
      fetchStandingApprovalReport('acme', 'widgets', (path) => {
        if (path.startsWith('search/issues?')) return searchPage([12]);
        return { body: 'not an array' };
      }),
    /comments page 1 for #12 was not an array/,
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
else if (args[1].startsWith('search/issues?')) process.stdout.write(JSON.stringify(${JSON.stringify(searchPage([42]))}));
else if (args[1].startsWith('repos/acme/widgets/issues/42/comments?')) process.stdout.write(JSON.stringify([{body:${JSON.stringify(VALID_BUDGET)}}]));
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
    assert.equal(calls.length, 3, JSON.stringify(calls));
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
