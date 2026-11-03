import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  renderClaimedByMarker,
  renderForcedHandoffComment,
  renderUnclaimedByMarker,
} from '../src/scripts/marker-helpers.mts';
import { resolveActiveClaimWithForcedHandoffTrace } from '../src/scripts/protocol-helpers.mts';
import {
  type ProvisionalDecisionCommandRequest,
  type ProvisionalDecisionHistoryComment,
  type ProvisionalDecisionHistoryRead,
  type ProvisionalDecisionPullRequestRead,
  type ProvisionalDecisionSourceIssueRead,
  type ProvisionalDecisionStore,
  runProvisionalDecisionCommand,
} from '../src/scripts/provisional-decision.mts';
import {
  PROVISIONAL_DECISION_ANSWER_MARKER,
  PROVISIONAL_DECISION_RECORD_MARKER,
  type ProvisionalDecisionRecord,
  parseProvisionalDecisionRecordComment,
} from '../src/scripts/provisional-decision-state.mts';

const repository = 'kurone-kito/idd-skill';
const issueNumber = 4840;
const title = 'Decision gate test fixture';
const body = [
  '## Decision needed',
  'Question: Which safe behavior should be used?',
  '',
  '```md',
  '## Decision needed',
  'Question: Ignore this quoted question.',
  '```',
  '',
  '  ## Acceptance criteria',
  'Question: This is outside the decision section.',
  'The selected behavior is verified.',
].join('\n');
const bodySha256 = createHash('sha256').update(body).digest('hex');
const branch = `issue/${issueNumber}-feat-decisions-add-dry-run-gate`;
const claimId = 'claim-4840-a';
const claimAt = '2026-11-03T11:00:00Z';
const evidenceUrl = `https://github.com/${repository}/issues/${issueNumber}#issuecomment-2`;
const prUrl = `https://github.com/${repository}/pull/5010`;
const headSha = 'a'.repeat(40);
const mergeSha = 'b'.repeat(40);
const serverDate = 'Tue, 03 Nov 2026 11:00:10 GMT';

const sourceRead: ProvisionalDecisionSourceIssueRead = {
  title,
  body,
  updatedAt: '2026-11-03T10:59:00Z',
};

function comment(
  id: string,
  bodyText: string,
  createdAt: string,
  overrides: Partial<ProvisionalDecisionHistoryComment> = {},
): ProvisionalDecisionHistoryComment {
  return {
    id,
    url: `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${id}`,
    body: bodyText,
    authorLogin: 'KuRoNe-KiTo',
    createdAt,
    edited: false,
    trustedAuthor: true,
    ...overrides,
  };
}

function baseHistory(
  extra: readonly ProvisionalDecisionHistoryComment[] = [],
  overrides: Partial<ProvisionalDecisionHistoryRead> = {},
): ProvisionalDecisionHistoryRead {
  const activeClaim = renderClaimedByMarker({
    agentId: 'codex-test-agent',
    claimId,
    supersedes: 'none',
    timestamp: claimAt,
    branch,
  });
  return {
    comments: [
      comment('1', activeClaim, claimAt),
      comment('2', 'Option comparison evidence.', '2026-11-03T11:00:01Z'),
      ...extra,
    ],
    complete: true,
    serverDate,
    ...overrides,
  };
}

function option(id: string, alternative = false) {
  const common = {
    id,
    description: `Description for ${id}`,
    feasibilityRationale: 'It can be implemented in this repository.',
    requirementFit: 'It meets the stated requirement.',
    consequences: 'It has a bounded effect.',
    verification: 'Run the focused tests.',
    reversalOrMigration: 'No migration is needed.',
  };
  return alternative
    ? {
        ...common,
        comparison: 'The selected choice has stronger evidence.',
        rejectionReason: 'This choice adds unnecessary complexity.',
      }
    : { ...common, rationale: 'It best fits the current evidence.' };
}

function request(
  overrides: Partial<ProvisionalDecisionCommandRequest> = {},
): ProvisionalDecisionCommandRequest {
  return {
    type: 'selected',
    repository,
    issueNumber,
    evidenceUrl,
    claimId,
    policyTrusted: true,
    optionComparisonValid: true,
    worktreeBranch: branch,
    baseline: { title, bodySha256 },
    verifiedReworkRoadmaps: [],
    selectedOption: option('keep'),
    feasibleAlternatives: [option('change', true)],
    executionCriteria: ['The chosen behavior passes focused validation.'],
    ...overrides,
  } as ProvisionalDecisionCommandRequest;
}

class MemoryStore implements ProvisionalDecisionStore {
  history: ProvisionalDecisionHistoryRead = baseHistory();
  source: ProvisionalDecisionSourceIssueRead = sourceRead;
  pullRequests = new Map<string, ProvisionalDecisionPullRequestRead>();
  labelPresent = false;
  labelReadFails = false;
  appendCalls = 0;
  labelCalls: Array<{ labelName: string; apply: boolean }> = [];
  pullRequestReads: string[] = [];
  historyReads = 0;
  sourceReads = 0;
  readFails = false;

  async readHistory(): Promise<ProvisionalDecisionHistoryRead> {
    this.historyReads += 1;
    if (this.readFails) throw new Error('history unavailable');
    return this.history;
  }

  async readSourceIssue(): Promise<ProvisionalDecisionSourceIssueRead> {
    this.sourceReads += 1;
    if (this.readFails) throw new Error('source unavailable');
    return this.source;
  }

  async readPullRequest(
    url: string,
  ): Promise<ProvisionalDecisionPullRequestRead> {
    this.pullRequestReads.push(url);
    const result = this.pullRequests.get(url);
    if (!result) throw new Error(`missing pull request ${url}`);
    return result;
  }

  async appendRecordBody(): Promise<{
    result: 'created';
    record: { id: string; url: string };
  }> {
    this.appendCalls += 1;
    return { result: 'created', record: { id: 'new', url: 'new-url' } };
  }

  async applyOrReadDecisionLabel(input: {
    labelName: string;
    apply: boolean;
  }): Promise<{ present: boolean }> {
    this.labelCalls.push(input);
    if (this.labelReadFails) throw new Error('label lookup failed');
    if (input.apply) this.labelPresent = true;
    return { present: this.labelPresent };
  }

  readTrustedDangerouslyAutoDecide(): never {
    throw new Error('the dry-run command must not read this policy');
  }
}

function selectionComment(
  record: ProvisionalDecisionRecord,
  id = '3',
  createdAt = '2026-11-03T11:00:02Z',
  overrides: Partial<ProvisionalDecisionHistoryComment> = {},
): ProvisionalDecisionHistoryComment {
  return comment(
    id,
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(record)}`,
    createdAt,
    overrides,
  );
}

async function selectedRecord(
  store = new MemoryStore(),
  overrides: Partial<ProvisionalDecisionCommandRequest> = {},
): Promise<{ store: MemoryStore; record: ProvisionalDecisionRecord }> {
  const result = await runProvisionalDecisionCommand(request(overrides), store);
  assert.equal(result.state, 'planned', JSON.stringify(result));
  if (result.state !== 'planned') throw new Error('expected selected plan');
  return { store, record: result.plan.candidateRecord };
}

function withSelection(
  history: ProvisionalDecisionHistoryRead,
  record: ProvisionalDecisionRecord,
  createdAt = '2026-11-03T11:00:02Z',
): ProvisionalDecisionHistoryRead {
  return {
    ...history,
    comments: [...history.comments, selectionComment(record, '3', createdAt)],
  };
}

function assertRefused(
  result: Awaited<ReturnType<typeof runProvisionalDecisionCommand>>,
  action: 'none' | 'recovery-hold' | 'fix-input',
) {
  assert.equal(result.state, 'refused', JSON.stringify(result));
  if (result.state === 'refused') assert.equal(result.action, action);
}

test('plans a valid selection with its exact candidate and performs no writes', async () => {
  const store = new MemoryStore();
  const result = await runProvisionalDecisionCommand(request(), store);
  assert.equal(result.state, 'planned');
  assert.equal('action' in result, false);
  assert.equal(store.appendCalls, 0);
  assert.deepEqual(store.labelCalls, []);
  assert.equal(store.historyReads, 1);
  assert.equal(store.sourceReads, 1);
  if (result.state !== 'planned') return;
  assert.equal(result.plan.candidateRecord.source.repository, repository);
  assert.equal(result.plan.candidateRecord.source.issueNumber, issueNumber);
  assert.deepEqual(result.plan.candidateRecord.evidenceReferences, [
    evidenceUrl,
  ]);
  assert.equal(
    result.plan.candidateRecord.event.question,
    'Which safe behavior should be used?',
  );
  assert.equal(result.plan.verifiedAt, '2026-11-03T11:00:10Z');
  assert.equal(result.plan.verifiedClaimLineage[0]?.commentId, '1');
  assert.equal(result.plan.candidateRecord.claimLineage[0]?.branch, branch);
});

test('repository casing keeps record identity stable and reconciles stored records', async () => {
  const { store, record } = await selectedRecord();
  const storedRecord = {
    ...record,
    source: { ...record.source, repository: repository.toUpperCase() },
  } as ProvisionalDecisionRecord;
  store.history = {
    ...store.history,
    comments: [...store.history.comments, selectionComment(storedRecord)],
  };

  const result = await runProvisionalDecisionCommand(
    request({ repository: repository.toUpperCase() }),
    store,
  );
  assert.equal(result.state, 'reconciled', JSON.stringify(result));
  assert.equal(result.recordId, record.recordId);
});

test('does not call a throwing dangerouslyAutoDecide reader and keeps branch evidence in lineage', async () => {
  const store = new MemoryStore();
  const result = await runProvisionalDecisionCommand(request(), store);
  assert.equal(result.state, 'planned');
  if (result.state !== 'planned') return;
  const missingBranch = {
    ...result.plan.candidateRecord,
    claimLineage: result.plan.candidateRecord.claimLineage.map((claim) => {
      const { branch: _branch, ...withoutBranch } = claim;
      return withoutBranch;
    }),
  } as unknown as ProvisionalDecisionRecord;
  const parse = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(missingBranch)}`,
  );
  assert.equal(parse.ok, false);
});

test('a step-7 gate takes precedence over candidate parse failure', async () => {
  const result = await runProvisionalDecisionCommand(
    request({
      policyTrusted: false,
      selectedOption: undefined,
      feasibleAlternatives: [],
      executionCriteria: [],
    }),
    new MemoryStore(),
  );
  assertRefused(result, 'fix-input');
  if (result.state === 'refused') {
    assert.match(result.reason ?? '', /policy is not enabled/u);
  }
});

test('incomplete history and failed reads stop at step 0', async () => {
  const incomplete = new MemoryStore();
  incomplete.history = baseHistory([], { complete: false });
  assertRefused(
    await runProvisionalDecisionCommand(request(), incomplete),
    'recovery-hold',
  );

  const unavailable = new MemoryStore();
  unavailable.readFails = true;
  assertRefused(
    await runProvisionalDecisionCommand(request(), unavailable),
    'recovery-hold',
  );
});

test('any replay refusal is a recovery hold with its refusal code', async (t) => {
  await t.test('duplicate comment identity', async () => {
    const store = new MemoryStore();
    const duplicate = comment(
      '2',
      'Duplicate history comment.',
      '2026-11-03T11:00:02Z',
    );
    store.history = {
      ...store.history,
      comments: [...store.history.comments, duplicate],
    };
    const result = await runProvisionalDecisionCommand(request(), store);
    assertRefused(result, 'recovery-hold');
    if (result.state === 'refused')
      assert.match(result.reason ?? '', /duplicate-comment/u);
    assert.equal(store.appendCalls, 0);
    assert.deepEqual(store.labelCalls, []);
  });

  await t.test('history order refusal', async () => {
    const store = new MemoryStore();
    store.history = {
      ...store.history,
      comments: [
        ...store.history.comments,
        comment('3', 'Out-of-order history comment.', '2026-11-03T10:59:59Z'),
      ],
    };
    const result = await runProvisionalDecisionCommand(request(), store);
    assertRefused(result, 'recovery-hold');
    if (result.state === 'refused')
      assert.match(result.reason ?? '', /history-order-invalid/u);
    assert.equal(store.appendCalls, 0);
    assert.deepEqual(store.labelCalls, []);
  });
});

test('a rework-authored history record without verified roadmap evidence holds before replay', async () => {
  const { store, record } = await selectedRecord();
  const authoredRecord = {
    ...record,
    recordId: `prov-${'c'.repeat(32)}`,
    event: {
      type: 'rework-authored',
      reworkRoadmap: {
        roadmapIssueNumber: issueNumber,
        roadmapMarkerId: 'marker-4840',
        authoringSetId: 'set-4840',
        url: `https://github.com/${repository}/issues/${issueNumber}`,
      },
    },
  } as ProvisionalDecisionRecord;
  const authoredComment = selectionComment(authoredRecord);
  assert.equal(
    parseProvisionalDecisionRecordComment(authoredComment.body).ok,
    true,
  );
  store.history = {
    ...store.history,
    comments: [...store.history.comments, authoredComment],
  };

  const result = await runProvisionalDecisionCommand(request(), store);
  assertRefused(result, 'recovery-hold');
  if (result.state === 'refused')
    assert.match(result.reason ?? '', /verified rework evidence/u);
  assert.equal(store.appendCalls, 0);
  assert.deepEqual(store.labelCalls, []);
});

test('verified rework evidence without a matching history record holds before replay', async () => {
  const { store, record } = await selectedRecord();
  const result = await runProvisionalDecisionCommand(
    request({
      verifiedReworkRoadmaps: [
        {
          recordId: `prov-${'d'.repeat(32)}`,
          sourceBefore: record.source,
          sourceAfter: record.source,
          roadmapIssueNumber: issueNumber,
          roadmapMarkerId: 'marker-extra',
          authoringSetId: 'set-extra',
          url: `https://github.com/${repository}/issues/${issueNumber}`,
          publishedCommentId: 'extra-publication',
          publishedAt: '2026-11-03T11:00:03Z',
        },
      ],
    }),
    store,
  );
  assertRefused(result, 'recovery-hold');
  if (result.state === 'refused')
    assert.match(result.reason ?? '', /verified rework evidence/u);
});

test('missing pullRequestUrl is rejected before any step-0 read', async () => {
  const store = new MemoryStore();
  const result = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      pullRequestUrl: undefined,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
  );
  assertRefused(result, 'fix-input');
  assert.equal(store.historyReads, 0);
  assert.equal(store.sourceReads, 0);
});

test('an evidence URL missing from history is rejected and does not create a decision', async () => {
  const store = new MemoryStore();
  const result = await runProvisionalDecisionCommand(
    request({
      evidenceUrl: `https://github.com/${repository}/issues/${issueNumber}#issuecomment-999`,
    }),
    store,
  );
  assertRefused(result, 'fix-input');
  assert.equal(store.appendCalls, 0);
  assert.deepEqual(store.labelCalls, []);
});

test('missing evidenceUrl is a step-3 fix-input refusal', async () => {
  const result = await runProvisionalDecisionCommand(
    request({ evidenceUrl: undefined }),
    new MemoryStore(),
  );
  assertRefused(result, 'fix-input');
});

test('source question parsing rejects missing, empty, and repeated sections', async () => {
  for (const invalidBody of [
    '## Other\nQuestion: missing section',
    '## Decision needed\nQuestion: \n',
    '## Decision needed\nQuestion: one\n## Decision needed\nQuestion: two',
  ]) {
    const store = new MemoryStore();
    store.source = { ...sourceRead, body: invalidBody };
    store.history = baseHistory();
    const result = await runProvisionalDecisionCommand(
      request({
        baseline: {
          title,
          bodySha256: createHash('sha256').update(invalidBody).digest('hex'),
        },
      }),
      store,
    );
    assertRefused(result, 'fix-input');
  }
});

test('option, branch, claim, and baseline gates reject new writes', async (t) => {
  const cases: Array<[string, Partial<ProvisionalDecisionCommandRequest>]> = [
    ['option comparison', { optionComparisonValid: false }],
    ['worktree branch', { worktreeBranch: 'main' }],
    ['different claim', { claimId: 'claim-other' }],
    ['baseline', { baseline: { title: 'changed', bodySha256 } }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const result = await runProvisionalDecisionCommand(
        request(overrides),
        new MemoryStore(),
      );
      assertRefused(result, 'fix-input');
    });
  }
});

test('invalid candidate option shape returns fix-input after passing prechecks', async () => {
  const result = await runProvisionalDecisionCommand(
    request({ selectedOption: { id: 'broken' } as never }),
    new MemoryStore(),
  );
  assertRefused(result, 'fix-input');
  if (result.state === 'refused')
    assert.match(result.reason ?? '', /schema parsing/u);
});

test('malformed candidate takes step 5 before same-record recovery', async () => {
  const { store, record } = await selectedRecord();
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      selectionComment(record, '3', '2026-11-03T11:00:02Z', {
        trustedAuthor: false,
      }),
    ],
  };
  const result = await runProvisionalDecisionCommand(
    request({ selectedOption: { id: 'broken' } as never }),
    store,
  );
  assertRefused(result, 'fix-input');
  if (result.state === 'refused')
    assert.match(result.reason ?? '', /schema parsing/u);
});

test('the claim fold rejects trusted ignored handoffs, stale takeovers, and malformed lineage', async (t) => {
  await t.test(
    'ignores an allowlisted login when the comment is untrusted',
    async () => {
      const handoff = renderForcedHandoffComment({
        oldAgentId: 'codex-test-agent',
        oldClaimId: claimId,
        newAgentId: 'agent-next',
        newClaimId: 'claim-next',
        branch,
        forcedBy: 'kurone-kito',
        reason: 'This marker must remain untrusted.',
        timestamp: '2026-11-03T11:00:03Z',
        contextScope: 'issue-only',
      });
      const store = new MemoryStore();
      store.history = baseHistory([
        comment('3', handoff, '2026-11-03T11:00:03Z', {
          trustedAuthor: false,
        }),
      ]);
      assert.equal(
        (await runProvisionalDecisionCommand(request(), store)).state,
        'planned',
      );
    },
  );

  await t.test(
    'active forced handoff reported by the canonical trace',
    async () => {
      const handoff = renderForcedHandoffComment({
        oldAgentId: 'codex-test-agent',
        oldClaimId: claimId,
        newAgentId: 'agent-next',
        newClaimId: 'claim-next',
        branch,
        forcedBy: 'kurone-kito',
        reason:
          'The command must hold when the canonical trace ignores a handoff.',
        timestamp: '2026-11-03T11:00:03Z',
        contextScope: 'issue-only',
      });
      const store = new MemoryStore();
      store.history = baseHistory([
        comment('3', handoff, '2026-11-03T11:00:03Z'),
      ]);
      assertRefused(
        await runProvisionalDecisionCommand(request(), store),
        'recovery-hold',
      );
    },
  );

  await t.test('ignored non-active forced handoff', async () => {
    const handoff = renderForcedHandoffComment({
      oldAgentId: 'not-active',
      oldClaimId: 'not-active-claim',
      newAgentId: 'someone-else',
      newClaimId: 'claim-next',
      branch,
      forcedBy: 'kurone-kito',
      reason: 'Recovery test marker.',
      timestamp: '2026-11-03T11:00:03Z',
      contextScope: 'issue-only',
    });
    const store = new MemoryStore();
    store.history = baseHistory([
      comment('4', handoff, '2026-11-03T11:00:03Z'),
    ]);
    assertRefused(
      await runProvisionalDecisionCommand(request(), store),
      'recovery-hold',
    );
  });

  await t.test('stale takeover', async () => {
    const oldClaim = renderClaimedByMarker({
      agentId: 'agent-old',
      claimId: 'claim-old',
      supersedes: 'none',
      timestamp: '2026-11-01T00:00:00Z',
      branch,
    });
    const takeover = renderClaimedByMarker({
      agentId: 'agent-new',
      claimId: 'claim-new',
      supersedes: 'claim-old',
      timestamp: '2026-11-03T00:00:00Z',
      branch,
    });
    const store = new MemoryStore();
    store.history = {
      ...baseHistory(),
      comments: [
        comment('1', oldClaim, '2026-11-01T00:00:00Z'),
        comment('2', 'Option comparison evidence.', '2026-11-01T00:00:01Z'),
        comment('3', takeover, '2026-11-03T00:00:00Z'),
      ],
    };
    assertRefused(
      await runProvisionalDecisionCommand(
        request({ claimId: 'claim-new' }),
        store,
      ),
      'recovery-hold',
    );
  });

  await t.test('malformed trusted claim marker', async () => {
    const store = new MemoryStore();
    store.history = baseHistory([
      comment('4', '<!-- claimed-by: broken -->', '2026-11-03T11:00:03Z'),
    ]);
    assertRefused(
      await runProvisionalDecisionCommand(request(), store),
      'recovery-hold',
    );
  });

  await t.test('edited trusted release marker', async () => {
    const store = new MemoryStore();
    store.history = baseHistory([
      comment(
        '4',
        renderUnclaimedByMarker({
          agentId: 'codex-test-agent',
          claimId,
          timestamp: '2026-11-03T11:00:03Z',
        }),
        '2026-11-03T11:00:03Z',
        { edited: true },
      ),
    ]);
    assertRefused(
      await runProvisionalDecisionCommand(request(), store),
      'recovery-hold',
    );
  });

  await t.test('noncanonical trusted branch', async () => {
    const store = new MemoryStore();
    store.history = {
      ...baseHistory(),
      comments: [
        comment(
          '1',
          renderClaimedByMarker({
            agentId: 'codex-test-agent',
            claimId,
            supersedes: 'none',
            timestamp: claimAt,
            branch: 'main',
          }),
          claimAt,
        ),
        comment('2', 'Option comparison evidence.', '2026-11-03T11:00:01Z'),
      ],
    };
    assertRefused(
      await runProvisionalDecisionCommand(request(), store),
      'recovery-hold',
    );
  });
});

test('lineage appends a fresh post-release identity, rejects duplicate IDs, and keeps heartbeat claimedAt', async (t) => {
  await t.test(
    'fresh post-release claim has a distinct lineage entry',
    async () => {
      const releaseAt = '2026-11-03T11:00:02Z';
      const newClaimAt = '2026-11-03T11:00:03Z';
      const secondClaim = 'claim-4840-b';
      const store = new MemoryStore();
      store.history = {
        ...baseHistory(),
        comments: [
          comment(
            '1',
            renderClaimedByMarker({
              agentId: 'agent-a',
              claimId,
              supersedes: 'none',
              timestamp: claimAt,
              branch,
            }),
            claimAt,
          ),
          comment(
            '2',
            renderUnclaimedByMarker({
              agentId: 'agent-a',
              claimId,
              timestamp: releaseAt,
            }),
            releaseAt,
          ),
          comment(
            '3',
            renderClaimedByMarker({
              agentId: 'agent-b',
              claimId: secondClaim,
              supersedes: 'none',
              timestamp: newClaimAt,
              branch,
            }),
            newClaimAt,
          ),
          comment('4', 'Option comparison evidence.', '2026-11-03T11:00:04Z'),
        ],
      };
      const result = await runProvisionalDecisionCommand(
        request({
          claimId: secondClaim,
          evidenceUrl: store.history.comments[3]?.url,
        }),
        store,
      );
      assert.equal(result.state, 'planned');
      if (result.state === 'planned') {
        assert.deepEqual(
          result.plan.verifiedClaimLineage.map((claim) => claim.claimId),
          [claimId, secondClaim],
        );
        assert.equal(
          result.plan.verifiedClaimLineage.at(-1)?.claimedAt,
          newClaimAt,
        );
      }
    },
  );

  await t.test('reusing the released claim ID is refused', async () => {
    const releaseAt = '2026-11-03T11:00:02Z';
    const secondClaimAt = '2026-11-03T11:00:03Z';
    const store = new MemoryStore();
    store.history = {
      ...baseHistory(),
      comments: [
        comment(
          '1',
          renderClaimedByMarker({
            agentId: 'agent-a',
            claimId,
            supersedes: 'none',
            timestamp: claimAt,
            branch,
          }),
          claimAt,
        ),
        comment(
          '2',
          renderUnclaimedByMarker({
            agentId: 'agent-a',
            claimId,
            timestamp: releaseAt,
          }),
          releaseAt,
        ),
        comment(
          '3',
          renderClaimedByMarker({
            agentId: 'agent-b',
            claimId,
            supersedes: 'none',
            timestamp: secondClaimAt,
            branch,
          }),
          secondClaimAt,
        ),
        comment('4', 'Option comparison evidence.', '2026-11-03T11:00:04Z'),
      ],
    };
    assertRefused(
      await runProvisionalDecisionCommand(
        request({ evidenceUrl: store.history.comments[3]?.url }),
        store,
      ),
      'recovery-hold',
    );
  });

  await t.test(
    'heartbeat does not move claimedAt from activeSince',
    async () => {
      const heartbeatAt = '2026-11-03T11:00:02Z';
      const store = new MemoryStore();
      store.history = baseHistory([
        comment(
          '3',
          renderClaimedByMarker({
            agentId: 'codex-test-agent',
            claimId,
            supersedes: 'none',
            timestamp: heartbeatAt,
            branch,
          }),
          heartbeatAt,
        ),
      ]);
      const result = await runProvisionalDecisionCommand(request(), store);
      assert.equal(result.state, 'planned');
      if (result.state === 'planned') {
        const trace = resolveActiveClaimWithForcedHandoffTrace(
          store.history.comments.map((entry) => ({
            id: entry.id,
            url: entry.url,
            body: entry.body,
            createdAt: entry.createdAt,
            author: { login: entry.authorLogin ?? '' },
            lastEditedAt: entry.edited ? entry.createdAt : null,
          })),
          { isTrustedAuthor: (login) => login.toLowerCase() === 'kurone-kito' },
        );
        assert.equal(
          result.plan.verifiedClaimLineage.at(-1)?.claimedAt,
          trace.activeSince,
        );
        assert.equal(result.plan.verifiedClaimLineage.at(-1)?.commentId, '1');
      }
    },
  );
});

test('a same evidence URL selection retry reconciles to the stored record', async () => {
  const { store, record } = await selectedRecord();
  const existing = selectionComment(record);
  store.history = {
    ...store.history,
    comments: [...store.history.comments, existing],
  };
  const result = await runProvisionalDecisionCommand(request(), store);
  assert.equal(result.state, 'reconciled');
  if (result.state === 'reconciled') {
    assert.equal(result.action, 'reconcile');
    assert.equal(result.commentUrl, existing.url);
    assert.equal(result.plan?.existingRecord?.labelPresent, false);
  }
  assert.equal(store.appendCalls, 0);
  assert.deepEqual(
    store.labelCalls.map(({ apply }) => apply),
    [false],
  );
});

test('a matching record is not reconciled when claim, policy, or worktree gates fail', async (t) => {
  const { record } = await selectedRecord();
  const cases = [
    ['policy', { policyTrusted: false }],
    ['option comparison', { optionComparisonValid: false }],
    ['worktree', { worktreeBranch: 'main' }],
    ['claim', { claimId: 'claim-elsewhere' }],
  ] as const;
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const store = new MemoryStore();
      store.history = {
        ...store.history,
        comments: [...store.history.comments, selectionComment(record)],
      };
      assertRefused(
        await runProvisionalDecisionCommand(request(overrides), store),
        'fix-input',
      );
      assert.equal(store.appendCalls, 0);
      assert.deepEqual(store.labelCalls, []);
    });
  }
});

test('step-6 existing record trust, edit, baseline, and label failures fail closed', async (t) => {
  const { record } = await selectedRecord();
  for (const [name, overrides, expected] of [
    ['untrusted', { trustedAuthor: false }, 'recovery-hold'],
    ['edited', { edited: true }, 'recovery-hold'],
  ] as const) {
    await t.test(name, async () => {
      const store = new MemoryStore();
      store.history = {
        ...store.history,
        comments: [
          ...store.history.comments,
          selectionComment(record, '3', '2026-11-03T11:00:02Z', overrides),
        ],
      };
      assertRefused(
        await runProvisionalDecisionCommand(request(), store),
        expected,
      );
      assert.deepEqual(store.labelCalls, []);
    });
  }
  await t.test('baseline changed for existing record', async () => {
    const store = new MemoryStore();
    store.history = {
      ...store.history,
      comments: [...store.history.comments, selectionComment(record)],
    };
    assertRefused(
      await runProvisionalDecisionCommand(
        request({ baseline: { title: 'old', bodySha256 } }),
        store,
      ),
      'recovery-hold',
    );
  });
  await t.test('label read fails', async () => {
    const store = new MemoryStore();
    store.history = {
      ...store.history,
      comments: [...store.history.comments, selectionComment(record)],
    };
    store.labelReadFails = true;
    assertRefused(
      await runProvisionalDecisionCommand(request(), store),
      'recovery-hold',
    );
  });
});

test('different content under the same recordId returns recovery-hold', async () => {
  const { record } = await selectedRecord();
  const changed = {
    ...record,
    event: { ...record.event, question: 'Changed question' },
  } as ProvisionalDecisionRecord;
  const store = new MemoryStore();
  store.history = {
    ...store.history,
    comments: [...store.history.comments, selectionComment(changed)],
  };
  assertRefused(
    await runProvisionalDecisionCommand(request(), store),
    'recovery-hold',
  );
});

test('multiple decisions using the evidence URL are ambiguous', async () => {
  const { record } = await selectedRecord();
  const second = {
    ...record,
    recordId: 'prov-second-selection',
    decisionGeneration: 2,
  } as ProvisionalDecisionRecord;
  const store = new MemoryStore();
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      selectionComment(record, '3', '2026-11-03T11:00:02Z'),
      selectionComment(second, '4', '2026-11-03T11:00:03Z'),
    ],
  };
  const result = await runProvisionalDecisionCommand(request(), store);
  assertRefused(result, 'recovery-hold');
  assert.equal(result.commentUrl, '');
});

test('selected request in a waiting latest bundle returns action none', async () => {
  const { store, selection } = await workStartedFixture();
  store.pullRequests.set(prUrl, {
    state: 'merged',
    headSha,
    mergeCommitSha: mergeSha,
    requiredChecksPassing: true,
  });
  const completion = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      pullRequestUrl: prUrl,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
  );
  assert.equal(completion.state, 'planned');
  if (completion.state !== 'planned') return;
  const answer = comment(
    '7',
    `${PROVISIONAL_DECISION_ANSWER_MARKER}\n${JSON.stringify({
      schemaVersion: 1,
      source: selection.source,
      bundleGeneration: 1,
      decisionGenerations: [1],
      claimIds: [claimId],
      presentedBundle: [
        {
          decisionGeneration: 1,
          question: selection.event.question,
          selectedOptionId: 'keep',
          feasibleAlternativeIds: ['change'],
          workCompletedRecordId: completion.plan.candidateRecord.recordId,
          result: completion.plan.candidateRecord.event.result,
        },
      ],
      response: 'rework',
      requestedOptionId: 'change',
      rationale: 'Revise this comparison.',
      answerText: 'I prefer the alternate option.',
    })}`,
    '2026-11-03T11:00:06Z',
  );
  const rework = {
    ...completion.plan.candidateRecord,
    recordId: 'prov-rework-request',
    event: {
      type: 'rework-requested',
      reworkRequest: {
        commentUrl: answer.url,
        requestedAt: answer.createdAt,
        requestedOptionId: 'change',
        rationale: 'Revise this comparison.',
      },
    },
  } as ProvisionalDecisionRecord;
  const nextEvidence = comment(
    '9',
    'A new comparison while the bundle waits.',
    '2026-11-03T11:00:08Z',
  );
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      selectionComment(
        completion.plan.candidateRecord,
        '6',
        '2026-11-03T11:00:05Z',
      ),
      answer,
      selectionComment(rework, '8', '2026-11-03T11:00:07Z'),
      nextEvidence,
    ],
    serverDate: 'Tue, 03 Nov 2026 11:00:10 GMT',
  };
  const result = await runProvisionalDecisionCommand(
    request({ evidenceUrl: nextEvidence.url }),
    store,
  );
  assertRefused(result, 'none');
});

test('work-started requires a history plan comment no earlier than selection', async (t) => {
  const { record } = await selectedRecord();
  const store = new MemoryStore();
  store.history = withSelection(store.history, record);
  const requestBase = {
    type: 'work-started' as const,
    repository,
    issueNumber,
    evidenceUrl,
    claimId,
    policyTrusted: true,
    optionComparisonValid: true,
    worktreeBranch: branch,
    baseline: { title, bodySha256 },
    verifiedReworkRoadmaps: [],
  };
  await t.test('missing plan URL', async () => {
    assertRefused(
      await runProvisionalDecisionCommand(request(requestBase), store),
      'fix-input',
    );
  });
  await t.test('plan URL absent from history', async () => {
    assertRefused(
      await runProvisionalDecisionCommand(
        request({
          ...requestBase,
          planCommentUrl: 'https://example.invalid/plan',
        }),
        store,
      ),
      'fix-input',
    );
  });
  await t.test('plan URL predates selection', async () => {
    const early = comment(
      '4',
      'Plan was written too early.',
      '2026-11-03T11:00:01Z',
    );
    store.history = {
      ...store.history,
      comments: [
        store.history.comments[0] as ProvisionalDecisionHistoryComment,
        store.history.comments[1] as ProvisionalDecisionHistoryComment,
        early,
        selectionComment(record, '5', '2026-11-03T11:00:02Z'),
      ],
    };
    assertRefused(
      await runProvisionalDecisionCommand(
        request({ ...requestBase, planCommentUrl: early.url }),
        store,
      ),
      'fix-input',
    );
  });
});

test('work transitions without a matching selected decision return fix-input', async (t) => {
  await t.test('work-started', async () => {
    const store = new MemoryStore();
    assertRefused(
      await runProvisionalDecisionCommand(
        request({ type: 'work-started', planCommentUrl: evidenceUrl }),
        store,
      ),
      'fix-input',
    );
  });

  await t.test('work-completed', async () => {
    const store = new MemoryStore();
    store.pullRequests.set(prUrl, {
      state: 'merged',
      headSha,
      mergeCommitSha: mergeSha,
      requiredChecksPassing: true,
    });
    assertRefused(
      await runProvisionalDecisionCommand(
        request({
          type: 'work-completed',
          pullRequestUrl: prUrl,
          verifiedHeadSha: headSha,
          executionCriteriaSatisfied: true,
        }),
        store,
      ),
      'fix-input',
    );
  });
});

async function workStartedFixture(): Promise<{
  store: MemoryStore;
  selection: ProvisionalDecisionRecord;
  started: ProvisionalDecisionRecord;
  planUrl: string;
}> {
  const { store, record: selection } = await selectedRecord();
  const planComment = comment(
    '4',
    'Implementation plan.',
    '2026-11-03T11:00:03Z',
  );
  store.history = withSelection(store.history, selection);
  store.history = {
    ...store.history,
    comments: [...store.history.comments, planComment],
  };
  const startedResult = await runProvisionalDecisionCommand(
    request({ type: 'work-started', planCommentUrl: planComment.url }),
    store,
  );
  assert.equal(startedResult.state, 'planned', JSON.stringify(startedResult));
  if (startedResult.state !== 'planned')
    throw new Error('expected work-started plan');
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      comment(
        '5',
        `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(startedResult.plan.candidateRecord)}`,
        '2026-11-03T11:00:04Z',
      ),
    ],
    serverDate: 'Tue, 03 Nov 2026 11:00:05 GMT',
  };
  return {
    store,
    selection,
    started: startedResult.plan.candidateRecord,
    planUrl: planComment.url,
  };
}

test('a claim-fold recovery hold takes precedence over a step-7 status failure', async () => {
  const { store, planUrl } = await workStartedFixture();
  const ignoredHandoff = renderForcedHandoffComment({
    oldAgentId: 'not-active',
    oldClaimId: 'not-active-claim',
    newAgentId: 'someone-else',
    newClaimId: 'claim-next',
    branch,
    forcedBy: 'kurone-kito',
    reason: 'Recovery precedence test marker.',
    timestamp: '2026-11-03T11:00:06Z',
    contextScope: 'issue-only',
  });
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      comment('6', ignoredHandoff, '2026-11-03T11:00:06Z'),
    ],
  };

  const result = await runProvisionalDecisionCommand(
    request({ type: 'work-started', planCommentUrl: planUrl }),
    store,
  );
  assertRefused(result, 'recovery-hold');
  if (result.state === 'refused')
    assert.match(result.reason ?? '', /claim lineage/u);
});

test('work-completed rejects a fresh head mismatch before status and check failures', async (t) => {
  for (const state of ['open', 'closed-unmerged', 'merged'] as const) {
    await t.test(state, async () => {
      const { store } = await workStartedFixture();
      store.pullRequests.set(prUrl, {
        state,
        headSha: 'c'.repeat(40),
        mergeCommitSha: state === 'merged' ? mergeSha : null,
        requiredChecksPassing: false,
      });
      const result = await runProvisionalDecisionCommand(
        request({
          type: 'work-completed',
          pullRequestUrl: prUrl,
          verifiedHeadSha: headSha,
          executionCriteriaSatisfied: false,
        }),
        store,
      );
      assertRefused(result, 'recovery-hold');
    });
  }
});

test('work-completed status, checks, criteria, and timestamp gates return fix-input', async (t) => {
  await t.test('open PR', async () => {
    const { store } = await workStartedFixture();
    store.pullRequests.set(prUrl, {
      state: 'open',
      headSha,
      mergeCommitSha: null,
      requiredChecksPassing: true,
    });
    assertRefused(
      await runProvisionalDecisionCommand(
        request({
          type: 'work-completed',
          pullRequestUrl: prUrl,
          verifiedHeadSha: headSha,
          executionCriteriaSatisfied: true,
        }),
        store,
      ),
      'fix-input',
    );
  });
  await t.test('closed-unmerged PR', async () => {
    const { store } = await workStartedFixture();
    store.pullRequests.set(prUrl, {
      state: 'closed-unmerged',
      headSha,
      mergeCommitSha: null,
      requiredChecksPassing: true,
    });
    assertRefused(
      await runProvisionalDecisionCommand(
        request({
          type: 'work-completed',
          pullRequestUrl: prUrl,
          verifiedHeadSha: headSha,
          executionCriteriaSatisfied: true,
        }),
        store,
      ),
      'fix-input',
    );
  });
  await t.test('required checks fail', async () => {
    const { store } = await workStartedFixture();
    store.pullRequests.set(prUrl, {
      state: 'merged',
      headSha,
      mergeCommitSha: mergeSha,
      requiredChecksPassing: false,
    });
    assertRefused(
      await runProvisionalDecisionCommand(
        request({
          type: 'work-completed',
          pullRequestUrl: prUrl,
          verifiedHeadSha: headSha,
          executionCriteriaSatisfied: true,
        }),
        store,
      ),
      'fix-input',
    );
  });
  await t.test('execution criteria fail', async () => {
    const { store } = await workStartedFixture();
    store.pullRequests.set(prUrl, {
      state: 'merged',
      headSha,
      mergeCommitSha: mergeSha,
      requiredChecksPassing: true,
    });
    assertRefused(
      await runProvisionalDecisionCommand(
        request({
          type: 'work-completed',
          pullRequestUrl: prUrl,
          verifiedHeadSha: headSha,
          executionCriteriaSatisfied: false,
        }),
        store,
      ),
      'fix-input',
    );
  });
  await t.test('verifiedAt predates startedAt', async () => {
    const { store } = await workStartedFixture();
    store.history = {
      ...store.history,
      serverDate: 'Tue, 03 Nov 2026 11:00:02 GMT',
    };
    store.pullRequests.set(prUrl, {
      state: 'merged',
      headSha,
      mergeCommitSha: mergeSha,
      requiredChecksPassing: true,
    });
    assertRefused(
      await runProvisionalDecisionCommand(
        request({
          type: 'work-completed',
          pullRequestUrl: prUrl,
          verifiedHeadSha: headSha,
          executionCriteriaSatisfied: true,
        }),
        store,
      ),
      'fix-input',
    );
  });
});

test('work-completed plan captures step-0 server time and a retry reuses stored verifiedAt', async () => {
  const { store } = await workStartedFixture();
  store.pullRequests.set(prUrl, {
    state: 'merged',
    headSha,
    mergeCommitSha: mergeSha,
    requiredChecksPassing: true,
  });
  const completeRequest = request({
    type: 'work-completed',
    pullRequestUrl: prUrl,
    verifiedHeadSha: headSha,
    executionCriteriaSatisfied: true,
  });
  const planned = await runProvisionalDecisionCommand(completeRequest, store);
  assert.equal(planned.state, 'planned');
  if (planned.state !== 'planned') return;
  assert.equal(planned.plan.verifiedAt, '2026-11-03T11:00:05Z');
  assert.equal(
    (planned.plan.candidateRecord.event.result as { verifiedAt: string })
      .verifiedAt,
    planned.plan.verifiedAt,
  );
  const completionComment = comment(
    '6',
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(planned.plan.candidateRecord)}`,
    '2026-11-03T11:00:06Z',
  );
  store.history = {
    ...store.history,
    comments: [...store.history.comments, completionComment],
    serverDate: 'Tue, 03 Nov 2026 11:00:10 GMT',
  };
  const retry = await runProvisionalDecisionCommand(completeRequest, store);
  assert.equal(retry.state, 'planned');
  if (retry.state === 'planned') {
    assert.equal(retry.commentUrl, completionComment.url);
    assert.equal(
      (retry.plan.candidateRecord.event.result as { verifiedAt: string })
        .verifiedAt,
      '2026-11-03T11:00:05Z',
    );
    assert.equal(retry.plan.existingRecord?.labelPresent, false);
  }
  store.labelPresent = true;
  const labeledRetry = await runProvisionalDecisionCommand(
    completeRequest,
    store,
  );
  assert.equal(labeledRetry.state, 'reconciled');
  if (labeledRetry.state === 'reconciled')
    assert.equal(labeledRetry.action, 'reconcile');
});

test('a historical completion is re-verified against its merged PR SHAs', async () => {
  const { store } = await workStartedFixture();
  store.pullRequests.set(prUrl, {
    state: 'merged',
    headSha,
    mergeCommitSha: 'c'.repeat(40),
    requiredChecksPassing: true,
  });
  const completion: ProvisionalDecisionRecord = {
    schemaVersion: 1,
    recordId: 'prov-historical-completion',
    source: {
      repository,
      issueNumber,
      snapshot: { title, bodySha256, updatedAt: sourceRead.updatedAt },
    },
    bundleGeneration: 1,
    decisionGeneration: 1,
    claimLineage: [
      { claimId, agentId: 'codex-test-agent', branch, claimedAt: claimAt },
    ],
    evidenceReferences: [evidenceUrl],
    event: {
      type: 'work-completed',
      result: {
        kind: 'merged-pull-request',
        reference: prUrl,
        verifiedAt: '2026-11-03T11:00:05Z',
        headSha,
        mergeCommitSha: mergeSha,
      },
    },
  } as ProvisionalDecisionRecord;
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      comment(
        '8',
        `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(completion)}`,
        '2026-11-03T11:00:07Z',
      ),
    ],
  };
  assertRefused(
    await runProvisionalDecisionCommand(request(), store),
    'recovery-hold',
  );
});

test('work-completed is allowed for an in-progress decision in a mixed bundle', async () => {
  const { store, record: selection1 } = await selectedRecord();
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      selectionComment(selection1, '3', '2026-11-03T11:00:02Z'),
    ],
  };
  const evidence2 = comment(
    '4',
    'Second decision comparison.',
    '2026-11-03T11:00:03Z',
  );
  store.history = {
    ...store.history,
    comments: [...store.history.comments, evidence2],
  };
  const selection2Plan = await runProvisionalDecisionCommand(
    request({ evidenceUrl: evidence2.url }),
    store,
  );
  assert.equal(selection2Plan.state, 'planned');
  if (selection2Plan.state !== 'planned') return;
  const selection2 = selection2Plan.plan.candidateRecord;
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      selectionComment(selection2, '5', '2026-11-03T11:00:04Z'),
    ],
  };
  const plan2 = comment('6', 'Plan for decision two.', '2026-11-03T11:00:05Z');
  store.history = {
    ...store.history,
    comments: [...store.history.comments, plan2],
  };
  const started2 = await runProvisionalDecisionCommand(
    request({
      type: 'work-started',
      evidenceUrl: evidence2.url,
      planCommentUrl: plan2.url,
    }),
    store,
  );
  assert.equal(started2.state, 'planned');
  if (started2.state !== 'planned') return;
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      selectionComment(
        started2.plan.candidateRecord,
        '7',
        '2026-11-03T11:00:06Z',
      ),
    ],
    serverDate: 'Tue, 03 Nov 2026 11:00:07 GMT',
  };
  const pr2Url = 'https://github.com/kurone-kito/idd-skill/pull/5011';
  store.pullRequests.set(pr2Url, {
    state: 'merged',
    headSha,
    mergeCommitSha: 'c'.repeat(40),
    requiredChecksPassing: true,
  });
  const current = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      evidenceUrl: evidence2.url,
      pullRequestUrl: pr2Url,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
  );
  assert.equal(current.state, 'planned', JSON.stringify(current));
  if (current.state === 'planned') {
    assert.equal(current.plan.locatedDecision?.status, 'in-progress');
    assert.equal(current.plan.locatedDecision?.bundleState, 'accepting');
  }
});

test('a new selection after a replay-accepted complete bundle uses the next generation', async () => {
  const { store, selection } = await workStartedFixture();
  store.pullRequests.set(prUrl, {
    state: 'merged',
    headSha,
    mergeCommitSha: mergeSha,
    requiredChecksPassing: true,
  });
  const completion = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      pullRequestUrl: prUrl,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
  );
  assert.equal(completion.state, 'planned');
  if (completion.state !== 'planned') return;
  const acceptedAnswer = comment(
    '7',
    `${PROVISIONAL_DECISION_ANSWER_MARKER}\n${JSON.stringify({
      schemaVersion: 1,
      source: selection.source,
      bundleGeneration: 1,
      decisionGenerations: [1],
      claimIds: [claimId],
      presentedBundle: [
        {
          decisionGeneration: 1,
          question: selection.event.question,
          selectedOptionId: 'keep',
          feasibleAlternativeIds: ['change'],
          workCompletedRecordId: completion.plan.candidateRecord.recordId,
          result: completion.plan.candidateRecord.event.result,
        },
      ],
      response: 'accepted',
      answerText: 'Yes, I accept the presented completed choice.',
    })}`,
    '2026-11-03T11:00:06Z',
  );
  const confirmed = {
    ...completion.plan.candidateRecord,
    recordId: 'prov-confirmed-decision',
    event: {
      type: 'confirmed',
      confirmation: {
        commentUrl: acceptedAnswer.url,
        response: 'accepted',
        confirmedAt: acceptedAnswer.createdAt,
        confirmedBy: 'Operator',
      },
    },
  } as ProvisionalDecisionRecord;
  const nextEvidence = comment(
    '9',
    'Next decision comparison.',
    '2026-11-03T11:00:08Z',
  );
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      selectionComment(
        completion.plan.candidateRecord,
        '6',
        '2026-11-03T11:00:05Z',
      ),
      acceptedAnswer,
      selectionComment(confirmed, '8', '2026-11-03T11:00:07Z'),
      nextEvidence,
    ],
    serverDate: 'Tue, 03 Nov 2026 11:00:10 GMT',
  };
  const next = await runProvisionalDecisionCommand(
    request({ evidenceUrl: nextEvidence.url }),
    store,
  );
  assert.equal(next.state, 'planned', JSON.stringify(next));
  if (next.state === 'planned') {
    assert.equal(next.plan.candidateRecord.bundleGeneration, 2);
    assert.equal(next.plan.candidateRecord.decisionGeneration, 1);
  }
});
