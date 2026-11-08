import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGithubProvisionalDecisionStore } from '../src/scripts/provisional-decision-github.mts';
import { parseProvisionalDecisionRecordComment } from '../src/scripts/provisional-decision-state.mts';
import { pinLoadControlOff, stubExecutable } from './test-utils.mts';

const repository = 'kurone-kito/idd-skill';
const issueNumber = 4798;
const date = 'Sun, 08 Nov 2026 01:00:00 GMT';
const url = `https://github.com/${repository}/pull/5000`;
const headSha = 'a'.repeat(40);

interface Step {
  kind: string;
  response?: unknown;
  raw?: string;
  fail?: boolean;
  date?: string;
}

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    node_id: `IC_${id}`,
    html_url: `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${id}`,
    body: `Comment ${id}`,
    created_at: '2026-11-08T00:00:00Z',
    user: { login: 'kurone-kito' },
    ...overrides,
  };
}

function history(
  rows: ReturnType<typeof row>[],
  options: {
    partial?: boolean;
    edits?: Record<string, unknown>;
    raw?: string;
  } = {},
): Step[] {
  return [
    { kind: 'date', response: [] },
    {
      kind: 'pages',
      raw: options.raw ?? rows.map((value) => JSON.stringify(value)).join('\n'),
      fail: options.partial,
    },
    ...(rows.length
      ? [
          {
            kind: 'edits',
            response: {
              data: Object.fromEntries(
                rows.map((value, index) => [
                  `c${index}`,
                  options.edits?.[value.id] ?? {
                    id: value.node_id,
                    lastEditedAt: null,
                  },
                ]),
              ),
            },
          },
        ]
      : []),
  ];
}

async function withGh(
  steps: Step[],
  run: (
    store: ReturnType<typeof createGithubProvisionalDecisionStore>,
    calls: () => { args: string[]; input: string }[],
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'idd-provisional-store-'));
  const path = join(directory, 'state.json');
  writeFileSync(path, JSON.stringify({ steps, calls: [] }));
  const restorePolicy = pinLoadControlOff();
  const restore = stubExecutable(
    'gh',
    `
const fs = require('node:fs');
const path = ${JSON.stringify(path)};
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
const endpoint = args[1] || '';
const kind = args[0] === 'pr' ? 'pr' : args[0] === 'issue' ? 'label'
  : endpoint === 'graphql' ? 'edits'
  : args.includes('POST') ? 'post'
  : endpoint.includes('/comments') ? (args.includes('--paginate') ? 'pages' : 'date')
  : endpoint.includes('/rules/branches/') ? 'rules'
  : endpoint.includes('/protection') ? 'protection' : 'issue';
const step = state.steps.shift();
state.calls.push({ args, input });
fs.writeFileSync(path, JSON.stringify(state));
if (!step || step.kind !== kind) {
  process.stderr.write('unexpected stub request: ' + kind);
  process.exit(2);
}
let result = step.raw === undefined ? JSON.stringify(step.response) : step.raw;
if (args.includes('--include') && !step.fail) {
  result = 'HTTP/2.0 200 OK\\r\\nDate: ' + (step.date || ${JSON.stringify(date)}) + '\\r\\n\\r\\n' + result;
}
process.stdout.write(result || '');
if (step.fail) {
  process.stderr.write('gh: unavailable (HTTP 503)');
  process.exit(1);
}
`,
  );
  try {
    const store = createGithubProvisionalDecisionStore({
      repository,
      issueNumber,
      policy: { trustedMarkerActors: ['KuRoNe-KiTo'] },
    });
    await run(store, () => JSON.parse(readFileSync(path, 'utf8')).calls);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).steps.length, 0);
  } finally {
    restore();
    restorePolicy();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('history retains all authors, string IDs, edit evidence and first-page Date', async () => {
  const rows = [
    row('10000000000000000001', { user: { login: 'outsider' } }),
    row('10000000000000000000'),
    row('2', { user: null, created_at: '2026-11-07T00:00:00Z' }),
  ];
  await withGh(
    history(rows, {
      edits: {
        '10000000000000000001': {
          id: rows[0]?.node_id,
          lastEditedAt: '2026-11-08T00:01:00Z',
        },
      },
    }),
    async (store, calls) => {
      const result = await store.readHistory();
      assert.equal(result.complete, true);
      assert.equal(result.serverDate, date);
      assert.deepEqual(
        result.comments.map((comment) => comment.id),
        ['2', '10000000000000000000', '10000000000000000001'],
      );
      assert.deepEqual(
        result.comments.map((comment) => comment.trustedAuthor),
        [false, true, false],
      );
      assert.deepEqual(
        result.comments.map((comment) => comment.edited),
        [false, false, true],
      );
      assert.equal(result.comments[0]?.authorLogin, null);
      assert.equal(result.comments[2]?.body, 'Comment 10000000000000000001');
      assert.ok(calls()[1]?.args.includes('.[] | .id |= tostring'));
      assert.ok(calls()[2]?.args.some((arg) => arg.includes('lastEditedAt')));
    },
  );
});

test('a failed later page preserves its prefix and reports incomplete', async () => {
  await withGh(history([row('1')], { partial: true }), async (store) => {
    const result = await store.readHistory();
    assert.equal(result.complete, false);
    assert.equal(result.serverDate, date);
    assert.equal(result.comments[0]?.id, '1');
  });
});

test('missing edit evidence cannot produce an unedited comment', async () => {
  await withGh(
    history([row('1')], { edits: { '1': { id: 'IC_1' } } }),
    async (store) => {
      const result = await store.readHistory();
      assert.equal(result.complete, false);
      assert.deepEqual(result.comments, []);
    },
  );
});

test('a missing author remains in history as null and untrusted', async () => {
  const missing = row('1');
  delete (missing as Record<string, unknown>).user;
  await withGh(history([missing]), async (store) => {
    const result = await store.readHistory();
    assert.equal(result.complete, true);
    assert.equal(result.comments[0]?.authorLogin, null);
    assert.equal(result.comments[0]?.trustedAuthor, false);
  });
});

test('failed first-page request throws before pagination', async () => {
  await withGh([{ kind: 'date', fail: true }], async (store) => {
    await assert.rejects(store.readHistory());
  });
});

test('source issue retains exact title, body and updatedAt', async () => {
  const body = '  Exact body\r\n\n<!-- marker -->\n';
  await withGh(
    [
      {
        kind: 'issue',
        response: { title: 'Title', body, updated_at: '2026-11-08T00:00:00Z' },
      },
    ],
    async (store) => {
      assert.deepEqual(await store.readSourceIssue(), {
        title: 'Title',
        body,
        updatedAt: '2026-11-08T00:00:00Z',
      });
    },
  );
});

function pr(overrides: Record<string, unknown> = {}) {
  return {
    state: 'OPEN',
    mergedAt: null,
    headRefOid: headSha,
    mergeCommit: null,
    baseRefName: 'release/next',
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'required',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        completedAt: '2026-11-08T00:00:00Z',
      },
      {
        __typename: 'CheckRun',
        name: 'advisory',
        status: 'IN_PROGRESS',
        conclusion: null,
      },
    ],
    ...overrides,
  };
}

function prSteps(value: ReturnType<typeof pr>, protectionFail = false): Step[] {
  return [
    { kind: 'pr', response: value },
    ...(Array.isArray(value.statusCheckRollup)
      ? [
          {
            kind: 'rules',
            raw: JSON.stringify({
              type: 'required_status_checks',
              parameters: { required_status_checks: [{ context: 'required' }] },
            }),
          },
          { kind: 'protection', response: {}, fail: protectionFail },
        ]
      : []),
  ];
}

test('PR states and commit IDs are read with required-only successful checks', async () => {
  for (const [state, mergedAt, expected] of [
    ['MERGED', '2026-11-08T00:00:00Z', 'merged'],
    ['OPEN', null, 'open'],
    ['CLOSED', null, 'closed-unmerged'],
  ] as const) {
    const mergeCommit = mergedAt ? { oid: 'b'.repeat(40) } : null;
    await withGh(
      prSteps(pr({ state, mergedAt, mergeCommit })),
      async (store, calls) => {
        assert.deepEqual(await store.readPullRequest(url), {
          state: expected,
          headSha,
          mergeCommitSha: mergeCommit?.oid ?? null,
          requiredChecksPassing: true,
        });
        // cspell:ignore Fnext
        assert.ok(calls()[1]?.args[1]?.includes('release%2Fnext'));
      },
    );
  }
});

test('pending, missing, neutral and uncompleted required checks are false', async () => {
  for (const statusCheckRollup of [
    [
      {
        __typename: 'CheckRun',
        name: 'required',
        status: 'IN_PROGRESS',
        conclusion: 'SUCCESS',
        completedAt: '2026-11-08T00:00:00Z',
      },
    ],
    [],
    null,
    [
      {
        __typename: 'CheckRun',
        name: 'required',
        status: 'COMPLETED',
        conclusion: 'NEUTRAL',
        completedAt: '2026-11-08T00:00:00Z',
      },
    ],
    [
      {
        __typename: 'CheckRun',
        name: 'required',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        completedAt: null,
      },
    ],
  ]) {
    await withGh(prSteps(pr({ statusCheckRollup })), async (store) => {
      assert.equal(
        (await store.readPullRequest(url)).requiredChecksPassing,
        false,
      );
    });
  }
});

test('unreadable protection cannot pass or apply a waiver', async () => {
  await withGh(prSteps(pr(), true), async (store) => {
    assert.equal(
      (await store.readPullRequest(url)).requiredChecksPassing,
      false,
    );
  });
});

test('classic protection joins ruleset requirements and successful legacy statuses pass', async () => {
  const value = pr();
  const steps = prSteps(
    pr({
      statusCheckRollup: [
        ...value.statusCheckRollup,
        {
          __typename: 'StatusContext',
          context: 'legacy',
          state: 'SUCCESS',
        },
      ],
    }),
  );
  steps[2] = {
    kind: 'protection',
    response: { required_status_checks: { contexts: ['legacy'] } },
  };
  await withGh(steps, async (store) => {
    assert.equal(
      (await store.readPullRequest(url)).requiredChecksPassing,
      true,
    );
  });
});

test('a PR from another repository is rejected without execution', async () => {
  await withGh([], async (store) => {
    await assert.rejects(
      store.readPullRequest('https://github.com/other/repo/pull/1'),
    );
  });
});

const recordId = `prov-${'c'.repeat(32)}`;
const recordBody = `<!-- idd-provisional-decision-record:v1 -->\n${JSON.stringify(
  {
    schemaVersion: 1,
    recordId,
    source: {
      repository,
      issueNumber,
      snapshot: {
        title: 'Title',
        bodySha256: 'a'.repeat(64),
        updatedAt: '2026-11-08T00:00:00Z',
      },
    },
    bundleGeneration: 1,
    decisionGeneration: 1,
    claimLineage: [
      {
        claimId: 'test-claim',
        agentId: 'codex-test',
        branch: 'issue/4798-store',
        claimedAt: '2026-11-08T00:00:00Z',
      },
    ],
    evidenceReferences: [
      `https://github.com/${repository}/issues/${issueNumber}`,
    ],
    event: {
      type: 'work-started',
      startedAt: '2026-11-08T00:00:01Z',
      planReference: `https://github.com/${repository}/issues/${issueNumber}#issuecomment-1`,
    },
  },
)}`;

test('append finds the parsed record ID and never posts or deletes duplicates', async () => {
  assert.equal(parseProvisionalDecisionRecordComment(recordBody).ok, true);
  await withGh(
    history([row('1', { body: recordBody }), row('2', { body: recordBody })]),
    async (store, calls) => {
      assert.deepEqual(await store.appendRecordBody(recordId, recordBody), {
        result: 'existed',
        record: { id: '1', url: row('1').html_url },
      });
      assert.equal(calls().length, 3);
    },
  );
});

test('append posts once with JSON input and returns the read-back comment identity', async () => {
  const posted = row('10000000000000000001', { body: recordBody });
  await withGh(
    [
      ...history([]),
      { kind: 'post', response: { id: posted.id, html_url: posted.html_url } },
      ...history([posted, row('10000000000000000002', { body: recordBody })]),
    ],
    async (store, calls) => {
      assert.deepEqual(await store.appendRecordBody(recordId, recordBody), {
        result: 'created',
        record: { id: posted.id, url: posted.html_url },
      });
      const posts = calls().filter((call) => call.args.includes('POST'));
      assert.equal(posts.length, 1);
      assert.deepEqual(JSON.parse(posts[0]?.input ?? ''), { body: recordBody });
      assert.equal(
        calls().some((call) => call.args.includes('DELETE')),
        false,
      );
    },
  );
});

test('successful append with a missing read-back throws without a second post', async () => {
  await withGh(
    [
      ...history([]),
      { kind: 'post', response: { id: '1', html_url: row('1').html_url } },
      ...history([]),
    ],
    async (store, calls) => {
      await assert.rejects(
        store.appendRecordBody(recordId, recordBody),
        /absent/,
      );
      assert.equal(
        calls().filter((call) => call.args.includes('POST')).length,
        1,
      );
    },
  );
});

test('failed append throws and incomplete history prevents posting', async () => {
  await withGh(
    [...history([]), { kind: 'post', fail: true }],
    async (store) => {
      await assert.rejects(store.appendRecordBody(recordId, recordBody));
    },
  );
  await withGh(history([row('1')], { partial: true }), async (store) => {
    await assert.rejects(
      store.appendRecordBody(recordId, recordBody),
      /incomplete/,
    );
  });
});

test('labels only read when apply is false, and return the add read-back when true', async () => {
  for (const apply of [false, true]) {
    await withGh(
      [
        ...(apply ? [{ kind: 'label', response: {} }] : []),
        { kind: 'issue', response: { labels: [{ name: 'decision-label' }] } },
      ],
      async (store, calls) => {
        assert.deepEqual(
          await store.applyOrReadDecisionLabel({
            apply,
            labelName: 'decision-label',
          }),
          { present: true },
        );
        assert.equal(
          calls().filter((call) => call.args.includes('--add-label')).length,
          apply ? 1 : 0,
        );
        if (apply) assert.ok(calls()[0]?.args.includes(repository));
      },
    );
  }
});

test('successful label add followed by failed read-back throws and never removes it', async () => {
  await withGh(
    [
      { kind: 'label', response: {} },
      { kind: 'issue', fail: true },
    ],
    async (store, calls) => {
      await assert.rejects(
        store.applyOrReadDecisionLabel({
          apply: true,
          labelName: 'decision-label',
        }),
      );
      assert.equal(calls().length, 2);
      assert.equal(
        calls().some((call) => call.args.includes('--remove-label')),
        false,
      );
    },
  );
  await withGh([{ kind: 'label', fail: true }], async (store) => {
    await assert.rejects(
      store.applyOrReadDecisionLabel({
        apply: true,
        labelName: 'decision-label',
      }),
    );
  });
});

test('a missing decision label is returned as absent', async () => {
  await withGh([{ kind: 'issue', response: { labels: [] } }], async (store) => {
    assert.deepEqual(
      await store.applyOrReadDecisionLabel({
        apply: false,
        labelName: 'decision-label',
      }),
      { present: false },
    );
  });
});

test('a comma-bearing label stays one exact CSV field in the add request', async () => {
  const labelName = 'decision, "review"';
  await withGh(
    [
      { kind: 'label', response: {} },
      { kind: 'issue', response: { labels: [{ name: labelName }] } },
    ],
    async (store, calls) => {
      assert.deepEqual(
        await store.applyOrReadDecisionLabel({ apply: true, labelName }),
        { present: true },
      );
      const args = calls()[0]?.args ?? [];
      assert.equal(
        args[args.indexOf('--add-label') + 1],
        '"decision, ""review"""',
      );
    },
  );
});
