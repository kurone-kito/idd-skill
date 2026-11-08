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
  status?: number;
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
  options: {
    policy?: Parameters<
      typeof createGithubProvisionalDecisionStore
    >[0]['policy'];
    environment?: { GH_HOST?: string; GITHUB_SERVER_URL?: string };
    authHosts?: unknown;
    authFail?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'idd-provisional-store-'));
  const path = join(directory, 'state.json');
  writeFileSync(
    path,
    JSON.stringify({
      steps,
      calls: [],
      authHosts:
        options.authHosts === undefined ? ['github.com'] : options.authHosts,
      authFail: options.authFail === true,
    }),
  );
  const previousEnvironment = {
    GH_HOST: process.env.GH_HOST,
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
  };
  const environment = options.environment ?? { GH_HOST: 'github.com' };
  for (const name of ['GH_HOST', 'GITHUB_SERVER_URL'] as const) {
    const value = environment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const restorePolicy = pinLoadControlOff();
  const restore = stubExecutable(
    'gh',
    `
const fs = require('node:fs');
const path = ${JSON.stringify(path)};
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
if (args[0] === 'auth' && args[1] === 'status') {
  state.calls.push({ args, input });
  fs.writeFileSync(path, JSON.stringify(state));
  process.stdout.write(JSON.stringify(state.authHosts));
  process.exit(state.authFail ? 1 : 0);
}
const endpoint = args[0] === 'api'
  ? args.slice(1).find((arg, i, tail) => !arg.startsWith('-') && tail[i - 1] !== '--hostname') || ''
  : args[1] || '';
const kind = args[0] === 'pr' ? 'pr' : args[0] === 'issue' ? 'label'
  : endpoint === 'graphql' ? (args.some(arg => arg.includes('statusCheckRollup')) ? 'checks' : 'edits')
  : args.includes('POST') ? 'post'
  : endpoint.includes('/comments') ? (args.includes('--paginate') ? 'pages' : 'date')
  : endpoint.includes('/rules/branches/') ? 'rules'
  : endpoint.includes('/protection') ? 'protection'
  : endpoint.includes('/contents/.github/idd/config.json') ? 'trusted-config' : 'issue';
const step = state.steps.shift();
state.calls.push({ args, input });
fs.writeFileSync(path, JSON.stringify(state));
if (!step || step.kind !== kind) {
  process.stderr.write('unexpected stub request: ' + kind);
  process.exit(2);
}
const response = kind === 'date' && Array.isArray(step.response)
  ? step.response.slice(0, Number(new URL('https://example.test/' + endpoint).searchParams.get('per_page') || 30))
  : step.response;
let result = step.raw === undefined ? JSON.stringify(response) : step.raw;
if (args.includes('--include') && !step.fail) {
  result = 'HTTP/2.0 200 OK\\r\\nDate: ' + (step.date || ${JSON.stringify(date)}) + '\\r\\n\\r\\n' + result;
}
process.stdout.write(result || '');
if (step.fail) {
  process.stderr.write('gh: unavailable (HTTP ' + (step.status || 503) + ')');
  process.exit(1);
}
`,
  );
  try {
    const store = createGithubProvisionalDecisionStore({
      repository,
      issueNumber,
      policy:
        options.policy === undefined
          ? { trustedMarkerActors: ['KuRoNe-KiTo'] }
          : options.policy,
    });
    await run(store, () => JSON.parse(readFileSync(path, 'utf8')).calls);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).steps.length, 0);
  } finally {
    restore();
    restorePolicy();
    for (const name of ['GH_HOST', 'GITHUB_SERVER_URL'] as const) {
      const value = previousEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

test('large history bounds the header page without dropping paginated bodies', async () => {
  const body = 'x'.repeat(60_000);
  const rows = Array.from({ length: 20 }, (_, index) =>
    row(String(index + 1), { body }),
  );
  const steps = history(rows);
  steps[0] = { kind: 'date', response: rows };
  await withGh(steps, async (store) => {
    const result = await store.readHistory();
    assert.equal(result.complete, true);
    assert.equal(result.serverDate, date);
    assert.equal(result.comments.length, rows.length);
    assert.ok(result.comments.every((comment) => comment.body === body));
  });
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

function checksStep(
  value: ReturnType<typeof pr>,
  overrides: Record<string, unknown> = {},
): Step {
  const nodes = (value.statusCheckRollup as unknown[]).map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const check = raw as Record<string, unknown>;
    return check.__typename === 'CheckRun'
      ? {
          ...check,
          checkSuite: {
            app: { slug: 'github-actions' },
            workflowRun:
              check.workflowName || check.workflowPath
                ? {
                    workflow: { name: check.workflowName ?? '' },
                    file: { path: check.workflowPath ?? null },
                  }
                : null,
          },
        }
      : {
          ...check,
          updatedAt: check.updatedAt ?? check.completedAt ?? check.createdAt,
        };
  });
  return {
    kind: 'checks',
    response: {
      data: {
        repository: {
          pullRequest: {
            headRefOid: value.headRefOid,
            baseRefName: value.baseRefName,
            statusCheckRollup: {
              contexts: {
                nodes,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
            ...overrides,
          },
        },
      },
    },
  };
}

function prSteps(
  value: ReturnType<typeof pr>,
  protectionFail = false,
  checksExpected = true,
): Step[] {
  const view = {
    ...value,
    statusCheckRollup: Array.isArray(value.statusCheckRollup)
      ? value.statusCheckRollup.map((raw) => {
          const check = { ...raw } as Record<string, unknown>;
          // gh pr view exposes workflowName, not the workflow file path.
          delete check.workflowPath;
          return check;
        })
      : value.statusCheckRollup,
  };
  return [
    { kind: 'pr', response: view },
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
          ...(!protectionFail && checksExpected ? [checksStep(value)] : []),
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

function trustedConfig(value: unknown): Step {
  return {
    kind: 'trusted-config',
    raw: Buffer.from(JSON.stringify(value)).toString('base64'),
  };
}

test('only trusted base policy can classify not-found governance as empty', async () => {
  for (const missing of ['rules', 'protection', 'both']) {
    const steps = prSteps(pr());
    if (missing !== 'protection') {
      steps[1] = { kind: 'rules', fail: true, status: 404 };
    }
    if (missing !== 'rules') {
      steps[2] = { kind: 'protection', fail: true, status: 404 };
    }
    steps.splice(
      missing === 'protection' ? 3 : 2,
      0,
      trustedConfig({ ciGate: { trustEmptyProtectionReads: true } }),
    );
    await withGh(
      steps,
      async (store, calls) => {
        assert.equal(
          (await store.readPullRequest(url)).requiredChecksPassing,
          true,
        );
        const configReads = calls().filter((call) =>
          call.args[1]?.includes('/contents/.github/idd/config.json'),
        );
        assert.equal(configReads.length, 1);
        assert.ok(configReads[0]?.args.includes('ref=release/next'));
      },
      { policy: { ciGate: { trustEmptyProtectionReads: false } } },
    );
  }
});

test('caller policy cannot enable a trusted-base governance opt-in', async () => {
  const steps = prSteps(pr(), false, false);
  steps[2] = { kind: 'protection', fail: true, status: 404 };
  steps.push(trustedConfig({ ciGate: { trustEmptyProtectionReads: false } }));
  await withGh(
    steps,
    async (store) => {
      assert.equal(
        (await store.readPullRequest(url)).requiredChecksPassing,
        false,
      );
    },
    { policy: { ciGate: { trustEmptyProtectionReads: true } } },
  );
});

test('failed and malformed governance or trusted policy remain false', async () => {
  const value: Step = { kind: 'pr', response: pr() };
  const rules = prSteps(pr())[1] as Step;
  for (const steps of [
    [value, { kind: 'rules', fail: true }],
    [
      value,
      { kind: 'rules', response: [null] },
      { kind: 'protection', response: {} },
    ],
    [
      value,
      { kind: 'rules', response: [{}] },
      { kind: 'protection', response: {} },
    ],
    [
      value,
      {
        kind: 'rules',
        raw: JSON.stringify({
          type: 'required_status_checks',
          parameters: { required_status_checks: [''] },
        }),
      },
      { kind: 'protection', response: {} },
    ],
    [value, rules, { kind: 'protection', response: [] }],
    [
      value,
      rules,
      { kind: 'protection', response: { required_status_checks: {} } },
    ],
    [
      value,
      rules,
      { kind: 'protection', response: { required_status_checks: 'bad' } },
    ],
    [
      value,
      rules,
      { kind: 'protection', fail: true, status: 404 },
      trustedConfig(null),
    ],
    [
      value,
      rules,
      { kind: 'protection', fail: true, status: 404 },
      { kind: 'trusted-config', fail: true },
    ],
    [
      value,
      { kind: 'rules', fail: true, status: 404 },
      trustedConfig({ ciGate: { trustEmptyProtectionReads: true } }),
      { kind: 'protection', fail: true },
    ],
  ]) {
    await withGh(steps, async (store) => {
      assert.equal(
        (await store.readPullRequest(url)).requiredChecksPassing,
        false,
      );
    });
  }
});

test('required reruns use the shared latest-instance and tie semantics', async () => {
  const success = {
    __typename: 'CheckRun',
    name: 'required',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    completedAt: '2026-11-08T00:02:00Z',
  };
  for (const [other, expected] of [
    [
      {
        ...success,
        conclusion: 'FAILURE',
        completedAt: '2026-11-08T00:01:00Z',
      },
      true,
    ],
    [
      {
        ...success,
        conclusion: 'CANCELLED',
        completedAt: '2026-11-08T00:01:00Z',
      },
      true,
    ],
    [
      {
        ...success,
        conclusion: 'FAILURE',
        completedAt: '2026-11-08T00:03:00Z',
      },
      false,
    ],
    [{ ...success, conclusion: 'FAILURE' }, false],
    [{ ...success, conclusion: 'CANCELLED' }, true],
    [
      {
        ...success,
        status: 'IN_PROGRESS',
        completedAt: '2026-11-08T00:01:00Z',
      },
      false,
    ],
    [
      {
        ...success,
        conclusion: 'UNKNOWN',
        completedAt: '2026-11-08T00:01:00Z',
      },
      false,
    ],
  ] as const) {
    for (const checks of [
      [other, success],
      [success, other],
    ]) {
      await withGh(
        prSteps(pr({ statusCheckRollup: checks })),
        async (store) => {
          assert.equal(
            (await store.readPullRequest(url)).requiredChecksPassing,
            expected,
          );
        },
      );
    }
  }
});

test('legacy status reruns preserve pending and failed-current evidence', async () => {
  const success = {
    __typename: 'StatusContext',
    context: 'required',
    state: 'SUCCESS',
    createdAt: '2026-11-08T00:02:00Z',
  };
  for (const [other, expected] of [
    [{ ...success, state: 'ERROR', createdAt: '2026-11-08T00:01:00Z' }, true],
    [{ ...success, state: 'ERROR', createdAt: '2026-11-08T00:03:00Z' }, false],
    [
      { ...success, state: 'PENDING', createdAt: '2026-11-08T00:01:00Z' },
      false,
    ],
    [{ ...success, state: 'ERROR' }, false],
  ] as const) {
    await withGh(
      prSteps(pr({ statusCheckRollup: [other, success] })),
      async (store) => {
        assert.equal(
          (await store.readPullRequest(url)).requiredChecksPassing,
          expected,
        );
      },
    );
  }
});

test('independent required-check producers cannot supersede one another', async () => {
  const success = {
    __typename: 'CheckRun',
    name: 'required',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    completedAt: '2026-11-08T00:02:00Z',
    workflowName: 'Linting workflow',
    workflowPath: '.github/workflows/lint.yml',
  };
  const failure = {
    ...success,
    conclusion: 'FAILURE',
    completedAt: '2026-11-08T00:01:00Z',
  };
  const status = {
    __typename: 'StatusContext',
    context: 'required',
    state: 'SUCCESS',
    updatedAt: '2026-11-08T00:02:00Z',
  };
  for (const [entries, expected] of [
    [[failure, status], false],
    [
      [
        { ...status, state: 'FAILURE', updatedAt: '2026-11-08T00:01:00Z' },
        success,
      ],
      false,
    ],
    [[failure, { ...success, workflowName: 'Another workflow' }], false],
    [
      [failure, { ...success, workflowPath: '.github/workflows/decoy.yml' }],
      false,
    ],
    [[failure, success], true],
  ] as const) {
    for (const statusCheckRollup of [entries, [...entries].reverse()]) {
      await withGh(prSteps(pr({ statusCheckRollup })), async (store, calls) => {
        assert.equal(
          (await store.readPullRequest(url)).requiredChecksPassing,
          expected,
        );
        assert.ok(
          calls().some((call) =>
            call.args.some((arg) => arg.includes('workflowRun')),
          ),
        );
      });
    }
  }
});

test('changed or incomplete check snapshots cannot pass', async () => {
  const value = pr();
  for (const overrides of [
    { headRefOid: 'b'.repeat(40) },
    { baseRefName: 'other-base' },
    { statusCheckRollup: null },
    {
      statusCheckRollup: {
        contexts: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      },
    },
  ]) {
    const steps = prSteps(value);
    steps[3] = checksStep(value, overrides);
    await withGh(steps, async (store) => {
      assert.equal(
        (await store.readPullRequest(url)).requiredChecksPassing,
        false,
      );
    });
  }
});

test('pinned required-check sources stay false despite caller trust opt-ins', async () => {
  for (const pinned of ['rules', 'protection']) {
    const steps = prSteps(pr(), false, false);
    if (pinned === 'rules') {
      steps[1] = {
        kind: 'rules',
        raw: JSON.stringify({
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              { context: 'required', integration_id: 123 },
            ],
          },
        }),
      };
    } else {
      steps[2] = {
        kind: 'protection',
        response: {
          required_status_checks: {
            checks: [{ context: 'required', app_id: 123 }],
          },
        },
      };
    }
    await withGh(
      steps,
      async (store) => {
        assert.equal(
          (await store.readPullRequest(url)).requiredChecksPassing,
          false,
        );
      },
      { policy: { ciGate: { trustSourcePinnedRequiredChecks: true } } },
    );
  }
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

test('a sole authenticated GHES host scopes PR and label operations without environment hints', async () => {
  const host = 'ghe.example.test';
  await withGh(
    [
      ...prSteps(pr()),
      { kind: 'label', response: '' },
      { kind: 'issue', response: { labels: [{ name: 'needs-decision' }] } },
    ],
    async (store, calls) => {
      assert.equal(
        (await store.readPullRequest(`https://${host}/${repository}/pull/5000`))
          .requiredChecksPassing,
        true,
      );
      assert.deepEqual(
        await store.applyOrReadDecisionLabel({
          labelName: 'needs-decision',
          apply: true,
        }),
        { present: true },
      );
      for (const command of ['pr', 'issue']) {
        const args = calls().find((call) => call.args[0] === command)?.args;
        assert.equal(
          args?.[args.indexOf('--repo') + 1],
          `${host}/${repository}`,
        );
      }
      assert.deepEqual(calls()[0]?.args, [
        'auth',
        'status',
        '--json',
        'hosts',
        '--jq',
        '.hosts | keys',
      ]);
      assert.ok(
        calls()
          .filter((call) => call.args[0] === 'api')
          .every((call) => !call.args.includes('--hostname')),
      );
      await assert.rejects(store.readPullRequest(url));
    },
    { environment: {}, authHosts: [host] },
  );
});

test('explicit host and Actions server URL retain precedence over authenticated defaults', async () => {
  const host = 'ghe.example.test';
  for (const [environment, expectedHost, apiHostname] of [
    [
      { GH_HOST: host, GITHUB_SERVER_URL: 'https://github.com' },
      host,
      undefined,
    ],
    [{ GITHUB_SERVER_URL: `https://${host}` }, host, host],
    [{ GITHUB_SERVER_URL: 'https://github.com' }, 'github.com', undefined],
  ] as const) {
    await withGh(
      prSteps(pr()),
      async (store, calls) => {
        assert.equal(
          (
            await store.readPullRequest(
              `https://${expectedHost}/${repository}/pull/5000`,
            )
          ).requiredChecksPassing,
          true,
        );
        assert.ok(calls().every((call) => call.args[0] !== 'auth'));
        const args = calls().find((call) => call.args[0] === 'pr')?.args;
        assert.equal(
          args?.[args.indexOf('--repo') + 1],
          expectedHost === 'github.com'
            ? repository
            : `${expectedHost}/${repository}`,
        );
        for (const call of calls().filter((call) => call.args[0] === 'api')) {
          assert.equal(
            call.args.includes('--hostname'),
            apiHostname !== undefined,
          );
          if (apiHostname)
            assert.equal(
              call.args[call.args.indexOf('--hostname') + 1],
              apiHostname,
            );
        }
      },
      { environment, authHosts: ['other.example.test'] },
    );
  }
});

test('absent, ambiguous, malformed or failed host discovery retains the public default', async () => {
  for (const options of [
    { authHosts: ['github.com'] },
    { authHosts: [] },
    { authHosts: ['github.com', 'ghe.example.test'] },
    { authHosts: null },
    { authHosts: [''] },
    { authHosts: { invalid: true } },
    { authHosts: ['ghe.example.test'], authFail: true },
  ]) {
    await withGh(
      prSteps(pr()),
      async (store, calls) => {
        await assert.rejects(
          store.readPullRequest(
            `https://ghe.example.test/${repository}/pull/5000`,
          ),
        );
        assert.equal(
          (await store.readPullRequest(url)).requiredChecksPassing,
          true,
        );
        assert.equal(
          calls().filter((call) => call.args[0] === 'auth').length,
          1,
        );
        const args = calls().find((call) => call.args[0] === 'pr')?.args;
        assert.equal(args?.[args.indexOf('--repo') + 1], repository);
      },
      { ...options, environment: {} },
    );
  }
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
