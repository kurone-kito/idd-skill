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
  type ProvisionalDecisionPlan,
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
  replayProvisionalDecisionHistory,
  type VerifiedProvisionalReworkRoadmap,
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
  labelApplyFails = false;
  labelApplyReturnsFalse = false;
  waitForLabelOnExisted = false;
  appendCalls = 0;
  readHistoryHook?: (
    readNumber: number,
    store: MemoryStore,
  ) => void | Promise<void>;
  beforeAppend?: (
    recordId: string,
    body: string,
    store: MemoryStore,
  ) => void | Promise<void>;
  afterAppend?: (
    appended: ProvisionalDecisionHistoryComment,
    store: MemoryStore,
  ) => void | Promise<void>;
  labelCalls: Array<{ labelName: string; apply: boolean }> = [];
  pullRequestReads: string[] = [];
  historyReads = 0;
  sourceReads = 0;
  readFails = false;

  async readHistory(): Promise<ProvisionalDecisionHistoryRead> {
    this.historyReads += 1;
    if (this.readFails) throw new Error('history unavailable');
    await this.readHistoryHook?.(this.historyReads, this);
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

  async appendRecordBody(
    recordId: string,
    body: string,
  ): Promise<{
    result: 'created' | 'existed';
    record: { id: string; url: string };
  }> {
    this.appendCalls += 1;
    await this.beforeAppend?.(recordId, body, this);
    const existing = this.history.comments.find((candidate) => {
      const parsed = parseProvisionalDecisionRecordComment(candidate.body);
      return parsed.ok && parsed.record.recordId === recordId;
    });
    if (existing) {
      while (this.waitForLabelOnExisted && !this.labelPresent) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      return {
        result: 'existed',
        record: { id: existing.id, url: existing.url },
      };
    }
    const previousServerTime = Date.parse(this.history.serverDate);
    const appendedTime =
      (Number.isFinite(previousServerTime)
        ? previousServerTime
        : Date.parse('2026-11-03T11:00:10Z')) + 1000;
    const appendedAt = new Date(appendedTime)
      .toISOString()
      .replace('.000Z', 'Z');
    const appended = comment(String(99 + this.appendCalls), body, appendedAt);
    this.history = {
      ...this.history,
      comments: [...this.history.comments, appended],
      serverDate: new Date(appendedTime + 1000).toUTCString(),
    };
    await this.afterAppend?.(appended, this);
    return {
      result: 'created',
      record: { id: appended.id, url: appended.url },
    };
  }

  async applyOrReadDecisionLabel(input: {
    labelName: string;
    apply: boolean;
  }): Promise<{ present: boolean }> {
    this.labelCalls.push(input);
    if (this.labelReadFails) throw new Error('label lookup failed');
    if (input.apply && this.labelApplyFails)
      throw new Error('label apply failed');
    if (input.apply && !this.labelApplyReturnsFalse) {
      this.labelPresent = true;
    }
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
  assert.deepEqual(store.labelCalls, []);
});

test('comment URL casing preserves selection and work-started retry identity', async (t) => {
  const mixedCaseRepository = 'KuRoNe-KiTo/IDD-SKILL';
  const mixedCaseEvidenceUrl = evidenceUrl.replace(
    repository,
    mixedCaseRepository,
  );

  await t.test(
    'selection retry matches casing changes in the request and record',
    async () => {
      const { store, record } = await selectedRecord();
      const storedRecord = {
        ...record,
        evidenceReferences: [mixedCaseEvidenceUrl],
      } as ProvisionalDecisionRecord;
      store.history = {
        ...store.history,
        comments: [...store.history.comments, selectionComment(storedRecord)],
      };

      const result = await runProvisionalDecisionCommand(
        request({ evidenceUrl: mixedCaseEvidenceUrl }),
        store,
      );

      assert.equal(result.state, 'reconciled', JSON.stringify(result));
      assert.equal(result.recordId, record.recordId);
    },
  );

  await t.test(
    'history lookup matches casing changes in both stored URLs',
    async () => {
      const { store, record } = await selectedRecord();
      const evidence = store.history.comments.find((item) => item.id === '2');
      assert.ok(evidence);
      const storedRecord = {
        ...record,
        evidenceReferences: [mixedCaseEvidenceUrl],
      } as ProvisionalDecisionRecord;
      store.history = {
        ...store.history,
        comments: [
          ...store.history.comments.map((item) =>
            item.id === evidence.id
              ? { ...item, url: mixedCaseEvidenceUrl }
              : item,
          ),
          selectionComment(storedRecord),
        ],
      };

      const result = await runProvisionalDecisionCommand(request(), store);

      assert.equal(result.state, 'reconciled', JSON.stringify(result));
      assert.equal(result.recordId, record.recordId);
    },
  );

  await t.test(
    'work-started retry matches a casing-changed plan URL',
    async () => {
      const { store, record } = await selectedRecord();
      store.history = withSelection(store.history, record);
      const planComment = comment(
        '4',
        'Plan for the selected decision.',
        '2026-11-03T11:00:03Z',
      );
      store.history = {
        ...store.history,
        comments: [...store.history.comments, planComment],
      };
      const first = await runProvisionalDecisionCommand(
        request({ type: 'work-started', planCommentUrl: planComment.url }),
        store,
      );
      assert.equal(first.state, 'planned', JSON.stringify(first));
      if (first.state !== 'planned') return;
      store.history = {
        ...store.history,
        comments: [
          ...store.history.comments,
          selectionComment(
            first.plan.candidateRecord,
            '5',
            '2026-11-03T11:00:04Z',
          ),
        ],
      };

      const result = await runProvisionalDecisionCommand(
        request({
          type: 'work-started',
          planCommentUrl: planComment.url.replace(
            repository,
            mixedCaseRepository,
          ),
        }),
        store,
      );

      assert.equal(result.state, 'reconciled', JSON.stringify(result));
      assert.equal(result.recordId, first.recordId);
    },
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

test('step-6 existing record trust, edit, and baseline failures fail closed', async (t) => {
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

test('changed claim lineage under the same recordId reconciles for the active claim', async () => {
  const { store, record } = await selectedRecord();
  const releaseAt = '2026-11-03T11:00:03Z';
  const nextClaimAt = '2026-11-03T11:00:04Z';
  const nextClaimId = 'claim-4840-b';
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      selectionComment(record, '3', '2026-11-03T11:00:02Z'),
      comment(
        '4',
        renderUnclaimedByMarker({
          agentId: 'codex-test-agent',
          claimId,
          timestamp: releaseAt,
        }),
        releaseAt,
      ),
      comment(
        '5',
        renderClaimedByMarker({
          agentId: 'codex-next-agent',
          claimId: nextClaimId,
          supersedes: 'none',
          timestamp: nextClaimAt,
          branch,
        }),
        nextClaimAt,
      ),
    ],
  };

  const result = await runProvisionalDecisionCommand(
    request({ claimId: nextClaimId }),
    store,
    { apply: true },
  );

  assert.equal(result.state, 'reconciled', JSON.stringify(result));
  assert.equal(result.recordId, record.recordId);
  assert.equal(store.appendCalls, 0);
  assert.deepEqual(store.labelCalls, []);
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
  const completionRequest = request({
    type: 'work-completed',
    evidenceUrl: evidence2.url,
    pullRequestUrl: pr2Url,
    verifiedHeadSha: headSha,
    executionCriteriaSatisfied: true,
  });
  const plan = await runProvisionalDecisionCommand(completionRequest, store);
  assert.equal(plan.state, 'planned', JSON.stringify(plan));
  if (plan.state !== 'planned') return;
  assert.equal(plan.plan.locatedDecision?.status, 'in-progress');
  assert.equal(plan.plan.locatedDecision?.bundleState, 'accepting');
  const current = await runProvisionalDecisionCommand(
    completionRequest,
    store,
    { apply: true },
  );
  assert.equal(current.state, 'applied', JSON.stringify(current));
  assert.equal(store.appendCalls, 1);
  assert.equal(store.labelPresent, true);
  assert.ok(store.labelCalls.some(({ apply }) => apply));
  assert.equal(current.recordId, plan.plan.candidateRecord.recordId);
  assertStoredRecord(store, current.recordId, 'work-completed');
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

// The tests below cover each refusal code that replayProvisionalDecisionHistory
// creates through createReplayIssue in src/scripts/provisional-decision-state.mts
// (issue #4841). Each replay subtest is named after the code that its history
// makes the first replay issue. The last test covers the codes that an earlier
// command step always catches first, so the replay never reports them.
async function assertHeldWithoutWrites(
  store: MemoryStore,
  reason: string,
  overrides: Partial<ProvisionalDecisionCommandRequest> = {},
): Promise<void> {
  const result = await runProvisionalDecisionCommand(request(overrides), store);
  assertRefused(result, 'recovery-hold');
  assert.equal(result.reason, reason);
  assert.equal(store.appendCalls, 0);
  assert.deepEqual(store.labelCalls, []);
}

function replayRefusal(code: string): string {
  return `decision history replay refused: ${code}`;
}

function appendComments(
  store: MemoryStore,
  ...comments: ProvisionalDecisionHistoryComment[]
): void {
  store.history = {
    ...store.history,
    comments: [...store.history.comments, ...comments],
  };
}

function replaceComment(
  store: MemoryStore,
  replacement: ProvisionalDecisionHistoryComment,
): void {
  store.history = {
    ...store.history,
    comments: store.history.comments.map((item) =>
      item.id === replacement.id ? replacement : item,
    ),
  };
}

async function completedFixture(): Promise<{
  store: MemoryStore;
  selection: ProvisionalDecisionRecord;
  started: ProvisionalDecisionRecord;
  completion: ProvisionalDecisionRecord;
}> {
  const { store, selection, started } = await workStartedFixture();
  store.pullRequests.set(prUrl, {
    state: 'merged',
    headSha,
    mergeCommitSha: mergeSha,
    requiredChecksPassing: true,
  });
  const planned = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      pullRequestUrl: prUrl,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
  );
  assert.equal(planned.state, 'planned', JSON.stringify(planned));
  if (planned.state !== 'planned')
    throw new Error('expected work-completed plan');
  const completion = planned.plan.candidateRecord;
  appendComments(
    store,
    selectionComment(completion, '6', '2026-11-03T11:00:05Z'),
  );
  store.history = {
    ...store.history,
    serverDate: 'Tue, 03 Nov 2026 11:00:10 GMT',
  };
  return { store, selection, started, completion };
}

function answerComment(
  id: string,
  createdAt: string,
  selection: ProvisionalDecisionRecord,
  completion: ProvisionalDecisionRecord,
  fields: Record<string, unknown> = {
    response: 'accepted',
    answerText: 'Yes, I accept the presented completed choice.',
  },
): ProvisionalDecisionHistoryComment {
  return comment(
    id,
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
          workCompletedRecordId: completion.recordId,
          result: completion.event.result,
        },
      ],
      ...fields,
    })}`,
    createdAt,
  );
}

function reworkAnswerFields(
  requestedOptionId = 'change',
  rationale = 'Revise this comparison.',
): Record<string, unknown> {
  return {
    response: 'rework',
    requestedOptionId,
    rationale,
    answerText: 'I prefer the alternate option.',
  };
}

function confirmedRecord(
  base: ProvisionalDecisionRecord,
  recordId: string,
  answer: ProvisionalDecisionHistoryComment,
  confirmedAt = answer.createdAt,
): ProvisionalDecisionRecord {
  return {
    ...base,
    recordId,
    event: {
      type: 'confirmed',
      confirmation: {
        commentUrl: answer.url,
        response: 'accepted',
        confirmedAt,
        confirmedBy: 'Operator',
      },
    },
  } as ProvisionalDecisionRecord;
}

function reworkRequestRecord(
  base: ProvisionalDecisionRecord,
  recordId: string,
  answer: ProvisionalDecisionHistoryComment,
  requestedOptionId = 'change',
  rationale = 'Revise this comparison.',
): ProvisionalDecisionRecord {
  return {
    ...base,
    recordId,
    event: {
      type: 'rework-requested',
      reworkRequest: {
        commentUrl: answer.url,
        requestedAt: answer.createdAt,
        requestedOptionId,
        rationale,
      },
    },
  } as ProvisionalDecisionRecord;
}

function reworkAuthoredRecord(
  base: ProvisionalDecisionRecord,
  recordId: string,
): ProvisionalDecisionRecord {
  return {
    ...base,
    recordId,
    event: {
      type: 'rework-authored',
      reworkRoadmap: {
        roadmapIssueNumber: issueNumber,
        roadmapMarkerId: 'marker-rework',
        authoringSetId: 'set-rework',
        url: `https://github.com/${repository}/issues/${issueNumber}`,
      },
    },
  } as ProvisionalDecisionRecord;
}

function reworkEvidence(
  authored: ProvisionalDecisionRecord,
  publishedCommentId: string,
  publishedAt: string,
): VerifiedProvisionalReworkRoadmap {
  return {
    recordId: authored.recordId,
    sourceBefore: authored.source,
    sourceAfter: authored.source,
    roadmapIssueNumber: issueNumber,
    roadmapMarkerId: 'marker-rework',
    authoringSetId: 'set-rework',
    url: `https://github.com/${repository}/issues/${issueNumber}`,
    publishedCommentId,
    publishedAt,
  };
}

test('record and source replay refusals are recovery holds that append nothing', async (t) => {
  await t.test('record-authority-invalid', async () => {
    const { store, record } = await selectedRecord();
    appendComments(
      store,
      selectionComment(record, '3', '2026-11-03T11:00:02Z', { edited: true }),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('record-authority-invalid'),
    );
  });

  await t.test('duplicate-record-id', async () => {
    const { store, record } = await selectedRecord();
    appendComments(
      store,
      selectionComment(record, '3', '2026-11-03T11:00:02Z'),
      selectionComment(record, '4', '2026-11-03T11:00:03Z'),
    );
    await assertHeldWithoutWrites(store, replayRefusal('duplicate-record-id'));
  });

  await t.test('claim-binding-mismatch', async () => {
    const { store, record } = await selectedRecord();
    const otherAgent = {
      ...record,
      claimLineage: record.claimLineage.map((claim) => ({
        ...claim,
        agentId: 'codex-other-agent',
      })),
    } as ProvisionalDecisionRecord;
    appendComments(store, selectionComment(otherAgent));
    await assertHeldWithoutWrites(
      store,
      replayRefusal('claim-binding-mismatch'),
    );
  });

  await t.test('source-binding-mismatch', async () => {
    const { store, record } = await selectedRecord();
    appendComments(store, selectionComment(record));
    store.source = { ...sourceRead, body: `${body}\nEdited after selection.` };
    await assertHeldWithoutWrites(
      store,
      replayRefusal('source-binding-mismatch'),
    );
  });
});

test('lifecycle replay refusals are recovery holds that append nothing', async (t) => {
  await t.test('bundle-generation-regression', async () => {
    const { store, record } = await selectedRecord();
    const laterBundle = {
      ...record,
      recordId: 'prov-bundle-two',
      bundleGeneration: 2,
    } as ProvisionalDecisionRecord;
    appendComments(
      store,
      selectionComment(laterBundle, '3', '2026-11-03T11:00:02Z'),
      selectionComment(record, '4', '2026-11-03T11:00:03Z'),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('bundle-generation-regression'),
    );
  });

  await t.test('bundle-generation-overlap', async () => {
    const { store, record } = await selectedRecord();
    const nextBundle = {
      ...record,
      recordId: 'prov-bundle-two',
      bundleGeneration: 2,
    } as ProvisionalDecisionRecord;
    appendComments(
      store,
      selectionComment(record, '3', '2026-11-03T11:00:02Z'),
      selectionComment(nextBundle, '4', '2026-11-03T11:00:03Z'),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('bundle-generation-overlap'),
    );
  });

  await t.test('bundle-generation-closed', async () => {
    const { store, selection, completion } = await completedFixture();
    const answer = answerComment(
      '7',
      '2026-11-03T11:00:06Z',
      selection,
      completion,
    );
    const lateSelection = {
      ...selection,
      recordId: 'prov-late-selection',
      decisionGeneration: 2,
    } as ProvisionalDecisionRecord;
    appendComments(
      store,
      answer,
      selectionComment(
        confirmedRecord(completion, 'prov-confirmed', answer),
        '8',
        '2026-11-03T11:00:07Z',
      ),
      selectionComment(lateSelection, '9', '2026-11-03T11:00:08Z'),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('bundle-generation-closed'),
    );
  });

  await t.test('duplicate-selection', async () => {
    const { store, record } = await selectedRecord();
    const again = {
      ...record,
      recordId: 'prov-selection-again',
    } as ProvisionalDecisionRecord;
    appendComments(
      store,
      selectionComment(record, '3', '2026-11-03T11:00:02Z'),
      selectionComment(again, '4', '2026-11-03T11:00:03Z'),
    );
    await assertHeldWithoutWrites(store, replayRefusal('duplicate-selection'));
  });

  await t.test('transition-without-selection', async () => {
    const { started } = await workStartedFixture();
    const store = new MemoryStore();
    store.history = baseHistory([
      comment('4', 'Implementation plan.', '2026-11-03T11:00:03Z'),
      selectionComment(started, '5', '2026-11-03T11:00:04Z'),
    ]);
    await assertHeldWithoutWrites(
      store,
      replayRefusal('transition-without-selection'),
    );
  });

  await t.test('work-started-conflict', async () => {
    const { store, started } = await workStartedFixture();
    const again = {
      ...started,
      recordId: 'prov-started-again',
    } as ProvisionalDecisionRecord;
    appendComments(store, selectionComment(again, '6', '2026-11-03T11:00:05Z'));
    await assertHeldWithoutWrites(
      store,
      replayRefusal('work-started-conflict'),
    );
  });

  await t.test('work-start-time-order-invalid', async () => {
    const { store, started } = await workStartedFixture();
    const beforeSelection = {
      ...started,
      event: { ...started.event, startedAt: '2026-11-03T11:00:01Z' },
    } as ProvisionalDecisionRecord;
    replaceComment(
      store,
      selectionComment(beforeSelection, '5', '2026-11-03T11:00:04Z'),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('work-start-time-order-invalid'),
    );
  });

  await t.test('work-completion-order-invalid', async () => {
    const { store } = await completedFixture();
    store.history = {
      ...store.history,
      comments: store.history.comments.filter((item) => item.id !== '5'),
    };
    await assertHeldWithoutWrites(
      store,
      replayRefusal('work-completion-order-invalid'),
    );
  });

  await t.test('work-verification-order-invalid', async () => {
    const { store, completion } = await completedFixture();
    const verifiedLater = {
      ...completion,
      event: {
        ...completion.event,
        result: {
          ...(completion.event.result as Record<string, unknown>),
          verifiedAt: '2026-11-03T11:00:09Z',
        },
      },
    } as ProvisionalDecisionRecord;
    replaceComment(
      store,
      selectionComment(verifiedLater, '6', '2026-11-03T11:00:05Z'),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('work-verification-order-invalid'),
    );
  });
});

test('confirmation replay refusals are recovery holds that append nothing', async (t) => {
  await t.test('confirmation-order-invalid', async () => {
    const { store, started } = await workStartedFixture();
    const answer = comment('6', 'Yes, I accept.', '2026-11-03T11:00:05Z');
    appendComments(
      store,
      answer,
      selectionComment(
        confirmedRecord(started, 'prov-confirmed', answer),
        '7',
        '2026-11-03T11:00:06Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('confirmation-order-invalid'),
    );
  });

  await t.test('confirmation-answer-untrusted', async () => {
    const { store, completion } = await completedFixture();
    const ordinary = comment('7', 'Yes, I accept.', '2026-11-03T11:00:06Z');
    appendComments(
      store,
      ordinary,
      selectionComment(
        confirmedRecord(completion, 'prov-confirmed', ordinary),
        '8',
        '2026-11-03T11:00:07Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('confirmation-answer-untrusted'),
    );
  });

  await t.test('confirmation-time-mismatch', async () => {
    const { store, selection, completion } = await completedFixture();
    const answer = answerComment(
      '7',
      '2026-11-03T11:00:06Z',
      selection,
      completion,
    );
    appendComments(
      store,
      answer,
      selectionComment(
        confirmedRecord(
          completion,
          'prov-confirmed',
          answer,
          '2026-11-03T11:00:05Z',
        ),
        '8',
        '2026-11-03T11:00:07Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('confirmation-time-mismatch'),
    );
  });

  await t.test('confirmation-bundle-incomplete', async () => {
    const { store, selection, completion } = await completedFixture();
    const secondSelection = {
      ...selection,
      recordId: 'prov-second-selection',
      decisionGeneration: 2,
    } as ProvisionalDecisionRecord;
    const answer = answerComment(
      '8',
      '2026-11-03T11:00:07Z',
      selection,
      completion,
    );
    appendComments(
      store,
      selectionComment(secondSelection, '7', '2026-11-03T11:00:06Z'),
      answer,
      selectionComment(
        confirmedRecord(completion, 'prov-confirmed', answer),
        '9',
        '2026-11-03T11:00:08Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('confirmation-bundle-incomplete'),
    );
  });

  await t.test('confirmation-scope-mismatch', async () => {
    const { store, selection, completion } = await completedFixture();
    const answer = answerComment(
      '7',
      '2026-11-03T11:00:06Z',
      selection,
      completion,
      {
        bundleGeneration: 2,
        response: 'accepted',
        answerText: 'Yes, I accept the presented completed choice.',
      },
    );
    appendComments(
      store,
      answer,
      selectionComment(
        confirmedRecord(completion, 'prov-confirmed', answer),
        '8',
        '2026-11-03T11:00:07Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('confirmation-scope-mismatch'),
    );
  });

  await t.test('confirmation-answer-not-accepted', async () => {
    const { store, selection, completion } = await completedFixture();
    const answer = answerComment(
      '7',
      '2026-11-03T11:00:06Z',
      selection,
      completion,
      reworkAnswerFields(),
    );
    appendComments(
      store,
      answer,
      selectionComment(
        confirmedRecord(completion, 'prov-confirmed', answer),
        '8',
        '2026-11-03T11:00:07Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('confirmation-answer-not-accepted'),
    );
  });

  await t.test('duplicate-confirmation', async () => {
    const { store, selection, completion } = await completedFixture();
    const answer = answerComment(
      '7',
      '2026-11-03T11:00:06Z',
      selection,
      completion,
    );
    appendComments(
      store,
      answer,
      selectionComment(
        confirmedRecord(completion, 'prov-confirmed', answer),
        '8',
        '2026-11-03T11:00:07Z',
      ),
      selectionComment(
        confirmedRecord(completion, 'prov-confirmed-again', answer),
        '9',
        '2026-11-03T11:00:08Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('duplicate-confirmation'),
    );
  });
});

test('rework replay refusals are recovery holds that append nothing', async (t) => {
  await t.test('rework-request-order-invalid', async () => {
    const { store, started } = await workStartedFixture();
    const ordinary = comment(
      '6',
      'Please switch to the alternate option.',
      '2026-11-03T11:00:05Z',
    );
    appendComments(
      store,
      ordinary,
      selectionComment(
        reworkRequestRecord(started, 'prov-rework-request', ordinary),
        '7',
        '2026-11-03T11:00:06Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('rework-request-order-invalid'),
    );
  });

  await t.test('rework-option-invalid', async () => {
    const { store, selection, completion } = await completedFixture();
    const answer = answerComment(
      '7',
      '2026-11-03T11:00:06Z',
      selection,
      completion,
      reworkAnswerFields('keep'),
    );
    appendComments(
      store,
      answer,
      selectionComment(
        reworkRequestRecord(completion, 'prov-rework-request', answer, 'keep'),
        '8',
        '2026-11-03T11:00:07Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('rework-option-invalid'),
    );
  });

  await t.test('rework-answer-untrusted', async () => {
    const { store, completion } = await completedFixture();
    const ordinary = comment(
      '7',
      'Please switch to the alternate option.',
      '2026-11-03T11:00:06Z',
    );
    appendComments(
      store,
      ordinary,
      selectionComment(
        reworkRequestRecord(completion, 'prov-rework-request', ordinary),
        '8',
        '2026-11-03T11:00:07Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('rework-answer-untrusted'),
    );
  });

  await t.test('rework-answer-scope-mismatch', async () => {
    const { store, selection, completion } = await completedFixture();
    const answer = answerComment(
      '7',
      '2026-11-03T11:00:06Z',
      selection,
      completion,
      reworkAnswerFields(),
    );
    appendComments(
      store,
      answer,
      selectionComment(
        reworkRequestRecord(
          completion,
          'prov-rework-request',
          answer,
          'change',
          'A rationale the answer never gave.',
        ),
        '8',
        '2026-11-03T11:00:07Z',
      ),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('rework-answer-scope-mismatch'),
    );
  });

  await t.test('rework-roadmap-order-invalid', async () => {
    const { store, record } = await selectedRecord();
    const publication = comment(
      '4',
      'Rework roadmap publication.',
      '2026-11-03T11:00:03Z',
    );
    const authored = reworkAuthoredRecord(record, 'prov-rework-authored');
    appendComments(
      store,
      selectionComment(record, '3', '2026-11-03T11:00:02Z'),
      publication,
      selectionComment(authored, '5', '2026-11-03T11:00:04Z'),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('rework-roadmap-order-invalid'),
      {
        verifiedReworkRoadmaps: [
          reworkEvidence(authored, publication.id, publication.createdAt),
        ],
      },
    );
  });

  await t.test('rework-roadmap-unverified', async () => {
    const { store, selection, completion } = await completedFixture();
    const answer = answerComment(
      '7',
      '2026-11-03T11:00:06Z',
      selection,
      completion,
      reworkAnswerFields(),
    );
    const authored = reworkAuthoredRecord(completion, 'prov-rework-authored');
    appendComments(
      store,
      answer,
      selectionComment(
        reworkRequestRecord(completion, 'prov-rework-request', answer),
        '8',
        '2026-11-03T11:00:07Z',
      ),
      selectionComment(authored, '9', '2026-11-03T11:00:08Z'),
    );
    await assertHeldWithoutWrites(
      store,
      replayRefusal('rework-roadmap-unverified'),
      {
        verifiedReworkRoadmaps: [
          reworkEvidence(
            authored,
            'missing-publication',
            '2026-11-03T11:00:07Z',
          ),
        ],
      },
    );
  });
});

test('inputs behind replay codes the command cannot reach are held before replay', async (t) => {
  await t.test(
    'history-incomplete: step 0 holds an incomplete history',
    async () => {
      const store = new MemoryStore();
      store.history = baseHistory([], { complete: false });
      await assertHeldWithoutWrites(
        store,
        'history is incomplete or its server Date is invalid',
      );
    },
  );

  await t.test(
    'claim-lineage-unverified: the claim fold holds a history with no claim',
    async () => {
      const store = new MemoryStore();
      store.history = {
        ...store.history,
        comments: store.history.comments.filter((item) => item.id !== '1'),
      };
      await assertHeldWithoutWrites(
        store,
        'active claim lineage could not be verified: empty-lineage',
      );
    },
  );

  await t.test(
    'duplicate-comment: the claim fold holds a repeated comment ID',
    async () => {
      const store = new MemoryStore();
      appendComments(
        store,
        comment('2', 'Duplicate history comment.', '2026-11-03T11:00:02Z'),
      );
      await assertHeldWithoutWrites(
        store,
        'active claim lineage could not be verified: duplicate-comment',
      );
    },
  );

  await t.test(
    'history-order-invalid: the claim fold holds an out-of-order comment',
    async () => {
      const store = new MemoryStore();
      appendComments(
        store,
        comment('3', 'Out-of-order history comment.', '2026-11-03T10:59:59Z'),
      );
      await assertHeldWithoutWrites(
        store,
        'active claim lineage could not be verified: history-order-invalid',
      );
    },
  );

  await t.test(
    'work-evidence-insufficient: historical verification holds an unmatched completion',
    async () => {
      const { store } = await completedFixture();
      store.pullRequests.set(prUrl, {
        state: 'merged',
        headSha,
        mergeCommitSha: 'c'.repeat(40),
        requiredChecksPassing: true,
      });
      await assertHeldWithoutWrites(
        store,
        `historical completion verification failed: historical pull request verification failed for ${prUrl}`,
      );
    },
  );

  await t.test(
    'transition-order-invalid: the claim fold holds a transition posted before its selection',
    async () => {
      // The replay's own history order gate would also refuse this input
      // before its transition-order-invalid check.
      const { store, selection, started } = await workStartedFixture();
      store.history = baseHistory([
        selectionComment(selection, '3', '2026-11-03T11:00:03Z'),
        selectionComment(started, '5', '2026-11-03T11:00:02Z'),
      ]);
      await assertHeldWithoutWrites(
        store,
        'active claim lineage could not be verified: history-order-invalid',
      );
    },
  );
});

async function workCompletedPlanFixture(): Promise<{
  store: MemoryStore;
  request: ProvisionalDecisionCommandRequest;
  record: ProvisionalDecisionRecord;
}> {
  const { store } = await workStartedFixture();
  store.pullRequests.set(prUrl, {
    state: 'merged',
    headSha,
    mergeCommitSha: mergeSha,
    requiredChecksPassing: true,
  });
  const completionRequest = request({
    type: 'work-completed',
    pullRequestUrl: prUrl,
    verifiedHeadSha: headSha,
    executionCriteriaSatisfied: true,
  });
  const result = await runProvisionalDecisionCommand(completionRequest, store);
  assert.equal(result.state, 'planned', JSON.stringify(result));
  if (result.state !== 'planned') {
    throw new Error('expected work-completed plan');
  }
  return {
    store,
    request: completionRequest,
    record: result.plan.candidateRecord,
  };
}

function addHistoryRecord(
  store: MemoryStore,
  record: ProvisionalDecisionRecord,
  id = '100',
  createdAt = '2026-11-03T11:00:06Z',
): ProvisionalDecisionHistoryComment {
  const added = selectionComment(record, id, createdAt);
  store.history = {
    ...store.history,
    comments: [...store.history.comments, added],
  };
  return added;
}

function assertStoredRecord(
  store: MemoryStore,
  recordId: string,
  eventType: string,
): ProvisionalDecisionRecord {
  const matching = store.history.comments.filter((item) => {
    const parsed = parseProvisionalDecisionRecordComment(item.body);
    return parsed.ok && parsed.record.recordId === recordId;
  });
  assert.equal(matching.length, 1);
  const storedComment = matching[0];
  assert.ok(storedComment);
  assert.equal(storedComment.trustedAuthor, true);
  assert.equal(storedComment.edited, false);
  const parsed = parseProvisionalDecisionRecordComment(storedComment.body);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('expected a readable stored decision record');
  assert.equal(parsed.record.recordId, recordId);
  assert.equal(parsed.record.event.type, eventType);
  return parsed.record;
}

function assertReplayStatus(
  store: MemoryStore,
  plan: ProvisionalDecisionPlan,
  expected: 'selected' | 'in-progress',
): void {
  const replay = replayProvisionalDecisionHistory({
    comments: store.history.comments,
    completeHistory: store.history.complete,
    currentSource: plan.candidateRecord.source,
    verifiedClaimLineage: plan.verifiedClaimLineage,
    verifiedWork: [],
    verifiedReworkRoadmaps: [],
  });
  assert.equal(replay.valid, true, JSON.stringify(replay.issues));
  assert.equal(replay.status, expected);
  assert.equal(replay.decisions.length, 1);
  assert.equal(replay.decisions[0]?.status, expected);
}

test('apply appends selected and work-started records without decision-label calls', async (t) => {
  await t.test('selected', async () => {
    const store = new MemoryStore();
    const planned = await runProvisionalDecisionCommand(request(), store);
    assert.equal(planned.state, 'planned', JSON.stringify(planned));
    if (planned.state !== 'planned') return;
    const result = await runProvisionalDecisionCommand(request(), store, {
      apply: true,
    });
    assert.equal(result.state, 'applied', JSON.stringify(result));
    assert.equal('action' in result, false);
    assert.equal(store.appendCalls, 1);
    assert.deepEqual(store.labelCalls, []);
    assert.match(result.commentUrl, /issuecomment-100$/u);
    assert.equal(store.history.comments.length, 3);
    assert.equal(result.recordId, planned.plan.candidateRecord.recordId);
    assertStoredRecord(store, result.recordId, 'selected');
    assertReplayStatus(store, planned.plan, 'selected');
  });

  await t.test('work-started', async () => {
    const { store, record } = await selectedRecord();
    store.history = withSelection(store.history, record);
    const planComment = comment(
      '4',
      'Implementation plan.',
      '2026-11-03T11:00:03Z',
    );
    store.history = {
      ...store.history,
      comments: [...store.history.comments, planComment],
    };
    const workStartedRequest = request({
      type: 'work-started',
      planCommentUrl: planComment.url,
    });
    const planned = await runProvisionalDecisionCommand(
      workStartedRequest,
      store,
    );
    assert.equal(planned.state, 'planned', JSON.stringify(planned));
    if (planned.state !== 'planned') return;
    const result = await runProvisionalDecisionCommand(
      workStartedRequest,
      store,
      { apply: true },
    );
    assert.equal(result.state, 'applied', JSON.stringify(result));
    assert.equal('action' in result, false);
    assert.equal(store.appendCalls, 1);
    assert.deepEqual(store.labelCalls, []);
    assert.equal(result.recordId, planned.plan.candidateRecord.recordId);
    assertStoredRecord(store, result.recordId, 'work-started');
    assertReplayStatus(store, planned.plan, 'in-progress');
  });
});

test('apply appends work-completed, verifies it, then applies and reads back the label', async () => {
  const { store, request: completionRequest } =
    await workCompletedPlanFixture();
  const result = await runProvisionalDecisionCommand(completionRequest, store, {
    apply: true,
  });
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal('action' in result, false);
  assert.equal(store.appendCalls, 1);
  assert.equal(store.labelPresent, true);
  assert.deepEqual(
    store.labelCalls.map(({ apply }) => apply),
    [false, true],
  );
  assert.equal(
    store.history.comments.filter(
      (item) => parseProvisionalDecisionRecordComment(item.body).ok,
    ).length,
    3,
  );
});

test('a completion retry defaults to dry-run and applies only the missing label', async () => {
  const {
    store,
    request: completionRequest,
    record,
  } = await workCompletedPlanFixture();
  const completion = addHistoryRecord(store, record, '6');

  const dryRun = await runProvisionalDecisionCommand(completionRequest, store);
  assert.equal(dryRun.state, 'planned', JSON.stringify(dryRun));
  assert.equal('action' in dryRun, false);
  assert.equal(store.appendCalls, 0);
  assert.equal(store.labelPresent, false);
  assert.deepEqual(
    store.labelCalls.map(({ apply }) => apply),
    [false],
  );

  store.labelCalls = [];
  const retry = await runProvisionalDecisionCommand(completionRequest, store, {
    apply: true,
  });
  assert.equal(retry.state, 'applied', JSON.stringify(retry));
  assert.equal('action' in retry, false);
  assert.equal(retry.recordId, record.recordId);
  assert.equal(retry.commentUrl, completion.url);
  assert.equal(store.appendCalls, 0);
  assert.equal(store.labelPresent, true);
  assert.deepEqual(
    store.labelCalls.map(({ apply }) => apply),
    [false, false, true],
  );
});

test('a missing completion label remains retryable after a sibling is confirmed', async () => {
  const { store, selection: firstSelection } = await workStartedFixture();
  const secondEvidence = comment(
    '6',
    'Second decision comparison.',
    '2026-11-03T11:00:06Z',
  );
  store.history = {
    ...store.history,
    comments: [...store.history.comments, secondEvidence],
    serverDate: 'Tue, 03 Nov 2026 11:00:07 GMT',
  };

  const secondSelectionPlan = await runProvisionalDecisionCommand(
    request({ evidenceUrl: secondEvidence.url }),
    store,
  );
  assert.equal(secondSelectionPlan.state, 'planned');
  if (secondSelectionPlan.state !== 'planned') return;
  const secondSelection = secondSelectionPlan.plan.candidateRecord;
  const secondSelectionComment = selectionComment(
    secondSelection,
    '7',
    '2026-11-03T11:00:08Z',
  );
  const secondPlanComment = comment(
    '8',
    'Plan for the second decision.',
    '2026-11-03T11:00:09Z',
  );
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      secondSelectionComment,
      secondPlanComment,
    ],
    serverDate: 'Tue, 03 Nov 2026 11:00:10 GMT',
  };
  const secondStartedPlan = await runProvisionalDecisionCommand(
    request({
      type: 'work-started',
      evidenceUrl: secondEvidence.url,
      planCommentUrl: secondPlanComment.url,
    }),
    store,
  );
  assert.equal(secondStartedPlan.state, 'planned');
  if (secondStartedPlan.state !== 'planned') return;
  const secondStartedComment = selectionComment(
    secondStartedPlan.plan.candidateRecord,
    '9',
    '2026-11-03T11:00:11Z',
  );
  store.history = {
    ...store.history,
    comments: [...store.history.comments, secondStartedComment],
    serverDate: 'Tue, 03 Nov 2026 11:00:12 GMT',
  };
  store.pullRequests.set(prUrl, {
    state: 'merged',
    headSha,
    mergeCommitSha: mergeSha,
    requiredChecksPassing: true,
  });

  const firstCompletionPlan = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      pullRequestUrl: prUrl,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
  );
  assert.equal(firstCompletionPlan.state, 'planned');
  if (firstCompletionPlan.state !== 'planned') return;
  const firstCompletion = firstCompletionPlan.plan.candidateRecord;
  const firstCompletionComment = selectionComment(
    firstCompletion,
    '10',
    '2026-11-03T11:00:13Z',
  );
  store.history = {
    ...store.history,
    comments: [...store.history.comments, firstCompletionComment],
    serverDate: 'Tue, 03 Nov 2026 11:00:14 GMT',
  };

  const secondCompletionRequest = request({
    type: 'work-completed',
    evidenceUrl: secondEvidence.url,
    pullRequestUrl: prUrl,
    verifiedHeadSha: headSha,
    executionCriteriaSatisfied: true,
  });
  const secondCompletionPlan = await runProvisionalDecisionCommand(
    secondCompletionRequest,
    store,
  );
  assert.equal(secondCompletionPlan.state, 'planned');
  if (secondCompletionPlan.state !== 'planned') return;
  const secondCompletion = secondCompletionPlan.plan.candidateRecord;
  const secondCompletionComment = selectionComment(
    secondCompletion,
    '11',
    '2026-11-03T11:00:15Z',
  );
  const answer = comment(
    '12',
    `${PROVISIONAL_DECISION_ANSWER_MARKER}\n${JSON.stringify({
      schemaVersion: 1,
      source: firstSelection.source,
      bundleGeneration: 1,
      decisionGenerations: [
        firstCompletion.decisionGeneration,
        secondCompletion.decisionGeneration,
      ].sort((left, right) => left - right),
      claimIds: [claimId],
      presentedBundle: [
        {
          decisionGeneration: firstCompletion.decisionGeneration,
          question: firstSelection.event.question,
          selectedOptionId: 'keep',
          feasibleAlternativeIds: ['change'],
          workCompletedRecordId: firstCompletion.recordId,
          result: firstCompletion.event.result,
        },
        {
          decisionGeneration: secondCompletion.decisionGeneration,
          question: secondSelection.event.question,
          selectedOptionId: 'keep',
          feasibleAlternativeIds: ['change'],
          workCompletedRecordId: secondCompletion.recordId,
          result: secondCompletion.event.result,
        },
      ],
      response: 'accepted',
      answerText: 'Both completed choices are accepted.',
    })}`,
    '2026-11-03T11:00:16Z',
  );
  const firstConfirmed = confirmedRecord(
    firstCompletion,
    'prov-confirmed-first-decision',
    answer,
  );
  store.history = {
    ...store.history,
    comments: [
      ...store.history.comments,
      secondCompletionComment,
      answer,
      selectionComment(firstConfirmed, '13', '2026-11-03T11:00:17Z'),
    ],
    serverDate: 'Tue, 03 Nov 2026 11:00:18 GMT',
  };

  const retry = await runProvisionalDecisionCommand(
    secondCompletionRequest,
    store,
    { apply: true },
  );
  assert.equal(retry.state, 'applied', JSON.stringify(retry));
  assert.equal(retry.recordId, secondCompletion.recordId);
  assert.equal(retry.commentUrl, secondCompletionComment.url);
  assert.equal(store.appendCalls, 0);
  assert.equal(store.labelPresent, true);
  assert.equal(store.labelCalls.filter(({ apply }) => apply).length, 1);
});

test('step-8 holds a completion retry when confirmation arrives before label apply', async () => {
  const { store, transitionedHistory } =
    await bundleTransitionFixture('accepted');
  const beforeConfirmation: ProvisionalDecisionHistoryRead = {
    ...transitionedHistory,
    comments: transitionedHistory.comments.filter(
      (item) => item.id !== '8' && item.id !== '9',
    ),
    serverDate: 'Tue, 03 Nov 2026 11:00:08 GMT',
  };
  store.history = beforeConfirmation;
  store.historyReads = 0;
  store.readHistoryHook = (readNumber, current) => {
    if (readNumber === 2) current.history = transitionedHistory;
  };
  const result = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      evidenceUrl,
      pullRequestUrl: prUrl,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
    { apply: true },
  );
  assertRefused(result, 'recovery-hold');
  if (result.state === 'refused') {
    assert.match(result.reason ?? '', /located decision, bundle/u);
  }
  assert.equal(store.appendCalls, 0);
  assert.equal(store.labelPresent, false);
  assert.ok(store.labelCalls.every(({ apply }) => !apply));
});

test('a completion label apply or read-back failure reconciles without deleting the record', async (t) => {
  for (const [name, configure] of [
    ['apply throws', (store: MemoryStore) => (store.labelApplyFails = true)],
    [
      'read-back is absent',
      (store: MemoryStore) => (store.labelApplyReturnsFalse = true),
    ],
  ] as const) {
    await t.test(name, async () => {
      const {
        store,
        request: completionRequest,
        record,
      } = await workCompletedPlanFixture();
      const completion = addHistoryRecord(store, record, '6');
      configure(store);

      const result = await runProvisionalDecisionCommand(
        completionRequest,
        store,
        { apply: true },
      );
      assert.equal(result.state, 'reconciled', JSON.stringify(result));
      if (result.state === 'reconciled')
        assert.equal(result.action, 'reconcile');
      assert.equal(result.recordId, record.recordId);
      assert.equal(result.commentUrl, completion.url);
      assert.equal(store.appendCalls, 0);
      assert.ok(
        store.history.comments.some((item) => item.url === completion.url),
      );
    });
  }
});

test('a completion retry with failed claim, policy, or worktree gates does not apply its label', async (t) => {
  const cases = [
    ['claim', { claimId: 'claim-other' }],
    ['policy', { policyTrusted: false }],
    ['worktree', { worktreeBranch: 'main' }],
  ] as const;
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const {
        store,
        request: completionRequest,
        record,
      } = await workCompletedPlanFixture();
      addHistoryRecord(store, record, '6');
      const result = await runProvisionalDecisionCommand(
        request({ ...completionRequest, ...overrides }),
        store,
        { apply: true },
      );
      assertRefused(result, 'fix-input');
      assert.equal(store.appendCalls, 0);
      assert.equal(store.labelPresent, false);
      assert.ok(store.labelCalls.every(({ apply }) => !apply));
    });
  }
});

test('step-8 claim handoff and source changes hold without appending', async (t) => {
  await t.test('claim handoff', async () => {
    const store = new MemoryStore();
    store.readHistoryHook = (readNumber, current) => {
      if (readNumber !== 2) return;
      const releaseAt = '2026-11-03T11:00:05Z';
      const nextClaimAt = '2026-11-03T11:00:06Z';
      current.history = {
        ...current.history,
        comments: [
          ...current.history.comments,
          comment(
            '3',
            renderUnclaimedByMarker({
              agentId: 'codex-test-agent',
              claimId,
              timestamp: releaseAt,
            }),
            releaseAt,
          ),
          comment(
            '4',
            renderClaimedByMarker({
              agentId: 'codex-next-agent',
              claimId: 'claim-next',
              supersedes: 'none',
              timestamp: nextClaimAt,
              branch,
            }),
            nextClaimAt,
          ),
        ],
      };
    };
    const result = await runProvisionalDecisionCommand(request(), store, {
      apply: true,
    });
    assertRefused(result, 'recovery-hold');
    assert.equal(store.appendCalls, 0);
  });

  await t.test('source baseline changes', async () => {
    const store = new MemoryStore();
    store.readHistoryHook = (readNumber, current) => {
      if (readNumber === 2) {
        current.source = { ...sourceRead, body: `${body}\nChanged.` };
      }
    };
    const result = await runProvisionalDecisionCommand(request(), store, {
      apply: true,
    });
    assertRefused(result, 'recovery-hold');
    assert.equal(store.appendCalls, 0);
  });
});

test('step-9 read-back failures preserve the URL returned by created', async (t) => {
  await t.test('edited record', async () => {
    const store = new MemoryStore();
    store.afterAppend = (appended, current) => {
      current.history = {
        ...current.history,
        comments: current.history.comments.map((item) =>
          item.id === appended.id ? { ...item, edited: true } : item,
        ),
      };
    };
    const result = await runProvisionalDecisionCommand(request(), store, {
      apply: true,
    });
    assertRefused(result, 'recovery-hold');
    assert.equal(typeof result.recordId, 'string');
    assert.equal(result.commentUrl, store.history.comments.at(-1)?.url);
    assert.match(result.commentUrl, /issuecomment-100$/u);
    assert.equal(store.appendCalls, 1);
  });

  await t.test('duplicate record ID', async () => {
    const store = new MemoryStore();
    store.afterAppend = (appended, current) => {
      current.history = {
        ...current.history,
        comments: [
          ...current.history.comments,
          { ...appended, id: 'another-comment' },
        ],
      };
    };
    const result = await runProvisionalDecisionCommand(request(), store, {
      apply: true,
    });
    assertRefused(result, 'recovery-hold');
    assert.equal(result.commentUrl, store.history.comments.at(-2)?.url);
    assert.equal(store.appendCalls, 1);
  });
});

test('repeated rework-evidence failure after append holds and preserves the record', async () => {
  const { store, record } = await selectedRecord();
  const rework = {
    ...record,
    recordId: `prov-${'e'.repeat(32)}`,
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
  let appendedUrl = '';
  store.afterAppend = (_appended, current) => {
    appendedUrl = _appended.url;
    current.history = {
      ...current.history,
      comments: [
        ...current.history.comments,
        selectionComment(rework, '101', '2026-11-03T11:00:13Z'),
      ],
    };
  };

  const result = await runProvisionalDecisionCommand(request(), store, {
    apply: true,
  });
  assertRefused(result, 'recovery-hold');
  if (result.state === 'refused') {
    assert.match(result.reason ?? '', /verified rework evidence/u);
  }
  assert.equal(result.commentUrl, appendedUrl);
  assert.equal(store.appendCalls, 1);
  assert.ok(store.history.comments.some(({ url }) => url === appendedUrl));
  assert.deepEqual(store.labelCalls, []);
});

test('create-if-absent existed uses fresh history and preserves step-6 gate outcomes', async (t) => {
  await t.test('matching record reconciles', async () => {
    const store = new MemoryStore();
    let concurrent: ProvisionalDecisionHistoryComment | undefined;
    let requestedRecordId = '';
    store.beforeAppend = (recordId, bodyText, current) => {
      requestedRecordId = recordId;
      concurrent = comment('101', bodyText, '2026-11-03T11:00:11Z');
      current.history = {
        ...current.history,
        comments: [...current.history.comments, concurrent],
      };
      assert.match(bodyText, new RegExp(recordId, 'u'));
    };
    const result = await runProvisionalDecisionCommand(request(), store, {
      apply: true,
    });
    assert.equal(result.state, 'reconciled', JSON.stringify(result));
    if (result.state === 'reconciled') assert.equal(result.action, 'reconcile');
    assert.equal(store.appendCalls, 1);
    assert.equal(result.recordId, requestedRecordId);
    assert.equal(result.commentUrl, concurrent?.url);
    assert.equal(
      store.history.comments.filter(
        (item) => parseProvisionalDecisionRecordComment(item.body).ok,
      ).length,
      1,
    );
  });

  await t.test('step-6 gate failure stays fix-input', async () => {
    const store = new MemoryStore();
    const writeRequest = request();
    store.beforeAppend = (_recordId, bodyText, current) => {
      const concurrent = comment('101', bodyText, '2026-11-03T11:00:11Z');
      current.history = {
        ...current.history,
        comments: [...current.history.comments, concurrent],
      };
      Object.assign(writeRequest, { policyTrusted: false });
    };
    const result = await runProvisionalDecisionCommand(writeRequest, store, {
      apply: true,
    });
    assertRefused(result, 'fix-input');
    assert.equal(store.appendCalls, 1);
  });

  await t.test(
    'baseline difference holds and preserves the concurrent URL',
    async () => {
      const store = new MemoryStore();
      let concurrent: ProvisionalDecisionHistoryComment | undefined;
      store.beforeAppend = (_recordId, bodyText, current) => {
        concurrent = comment('101', bodyText, '2026-11-03T11:00:11Z');
        current.history = {
          ...current.history,
          comments: [...current.history.comments, concurrent],
        };
        current.source = { ...sourceRead, body: `${body}\nChanged.` };
      };
      const result = await runProvisionalDecisionCommand(request(), store, {
        apply: true,
      });
      assertRefused(result, 'recovery-hold');
      assert.equal(result.commentUrl, concurrent?.url);
      assert.equal(store.appendCalls, 1);
      assert.ok(store.labelCalls.every(({ apply }) => !apply));
    },
  );
});

test('two concurrent applies create one record and the later completion run reconciles', async () => {
  const { store, request: completionRequest } =
    await workCompletedPlanFixture();
  store.waitForLabelOnExisted = true;
  const [first, second] = await Promise.all([
    runProvisionalDecisionCommand(completionRequest, store, { apply: true }),
    runProvisionalDecisionCommand(completionRequest, store, { apply: true }),
  ]);
  assert.deepEqual([first.state, second.state].sort(), [
    'applied',
    'reconciled',
  ]);
  assert.equal(store.appendCalls, 2);
  assert.equal(store.labelPresent, true);
  const matchingRecords = store.history.comments.filter((item) => {
    const parsed = parseProvisionalDecisionRecordComment(item.body);
    return parsed.ok && parsed.record.recordId === first.recordId;
  });
  assert.equal(matchingRecords.length, 1);
});

async function bundleTransitionFixture(
  response: 'accepted' | 'rework',
): Promise<{
  store: MemoryStore;
  nextEvidence: ProvisionalDecisionHistoryComment;
  acceptingHistory: ProvisionalDecisionHistoryRead;
  transitionedHistory: ProvisionalDecisionHistoryRead;
}> {
  const { store, selection } = await workStartedFixture();
  store.pullRequests.set(prUrl, {
    state: 'merged',
    headSha,
    mergeCommitSha: mergeSha,
    requiredChecksPassing: true,
  });
  const completionPlan = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      pullRequestUrl: prUrl,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
  );
  assert.equal(completionPlan.state, 'planned');
  if (completionPlan.state !== 'planned') {
    throw new Error('expected completion plan for bundle fixture');
  }

  const nextEvidence = comment(
    '6',
    'A second decision comparison.',
    '2026-11-03T11:00:06Z',
  );
  const completedRecord = completionPlan.plan.candidateRecord;
  const completion = selectionComment(
    completedRecord,
    '7',
    '2026-11-03T11:00:07Z',
  );
  const rationale = 'The current option needs another pass.';
  const answer = comment(
    '8',
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
          workCompletedRecordId: completedRecord.recordId,
          result: completedRecord.event.result,
        },
      ],
      response,
      ...(response === 'rework'
        ? { requestedOptionId: 'change', rationale }
        : {}),
      answerText:
        response === 'accepted'
          ? 'The completed choice is accepted.'
          : 'Please revise the comparison.',
    })}`,
    '2026-11-03T11:00:08Z',
  );
  const transition = {
    ...completedRecord,
    recordId:
      response === 'accepted'
        ? 'prov-accepted-bundle'
        : 'prov-rework-request-bundle',
    event:
      response === 'accepted'
        ? {
            type: 'confirmed',
            confirmation: {
              commentUrl: answer.url,
              response: 'accepted',
              confirmedAt: answer.createdAt,
              confirmedBy: 'Operator',
            },
          }
        : {
            type: 'rework-requested',
            reworkRequest: {
              commentUrl: answer.url,
              requestedAt: answer.createdAt,
              requestedOptionId: 'change',
              rationale,
            },
          },
  } as ProvisionalDecisionRecord;
  const transitionComment = selectionComment(
    transition,
    '9',
    '2026-11-03T11:00:09Z',
  );
  const acceptingHistory: ProvisionalDecisionHistoryRead = {
    ...store.history,
    comments: [...store.history.comments, nextEvidence],
    serverDate: 'Tue, 03 Nov 2026 11:00:10 GMT',
  };
  const transitionedHistory: ProvisionalDecisionHistoryRead = {
    ...acceptingHistory,
    comments: [
      ...acceptingHistory.comments,
      completion,
      answer,
      transitionComment,
    ],
  };
  store.historyReads = 0;
  store.history = acceptingHistory;
  return { store, nextEvidence, acceptingHistory, transitionedHistory };
}

test('step-8 turns a newly waiting bundle into recovery-hold instead of none', async () => {
  const { store, nextEvidence, acceptingHistory, transitionedHistory } =
    await bundleTransitionFixture('rework');
  store.history = acceptingHistory;
  store.readHistoryHook = (readNumber, current) => {
    if (readNumber === 2) current.history = transitionedHistory;
  };
  const result = await runProvisionalDecisionCommand(
    request({ evidenceUrl: nextEvidence.url }),
    store,
    { apply: true },
  );
  assertRefused(result, 'recovery-hold');
  if (result.state === 'refused') {
    assert.match(result.reason ?? '', /no longer satisfies the plan/u);
  }
  assert.equal(store.appendCalls, 0);
});

test('work-completed refuses a new record after a same-generation sibling is confirmed', async () => {
  const { store, nextEvidence, acceptingHistory, transitionedHistory } =
    await bundleTransitionFixture('accepted');
  store.history = acceptingHistory;
  const nextSelectionPlan = await runProvisionalDecisionCommand(
    request({ evidenceUrl: nextEvidence.url }),
    store,
  );
  assert.equal(nextSelectionPlan.state, 'planned');
  if (nextSelectionPlan.state !== 'planned') return;
  const nextSelectionComment = selectionComment(
    nextSelectionPlan.plan.candidateRecord,
    '10',
    '2026-11-03T11:00:10Z',
  );
  const planComment = comment(
    '11',
    'Plan for the second decision.',
    '2026-11-03T11:00:11Z',
  );
  store.history = {
    ...store.history,
    comments: [...store.history.comments, nextSelectionComment, planComment],
    serverDate: 'Tue, 03 Nov 2026 11:00:12 GMT',
  };
  const nextStartedPlan = await runProvisionalDecisionCommand(
    request({
      type: 'work-started',
      evidenceUrl: nextEvidence.url,
      planCommentUrl: planComment.url,
    }),
    store,
  );
  assert.equal(nextStartedPlan.state, 'planned');
  if (nextStartedPlan.state !== 'planned') return;
  const nextStartedComment = selectionComment(
    nextStartedPlan.plan.candidateRecord,
    '12',
    '2026-11-03T11:00:13Z',
  );
  store.history = {
    ...transitionedHistory,
    comments: [
      ...transitionedHistory.comments,
      nextSelectionComment,
      planComment,
      nextStartedComment,
    ],
    serverDate: 'Tue, 03 Nov 2026 11:00:14 GMT',
  };

  const result = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      evidenceUrl: nextEvidence.url,
      pullRequestUrl: prUrl,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
    { apply: true },
  );

  assertRefused(result, 'recovery-hold');
  if (result.state === 'refused') {
    assert.match(result.reason ?? '', /bundle-generation-closed/u);
  }
  assert.equal(store.appendCalls, 0);
  assert.deepEqual(store.labelCalls, []);
});

test('step-8 detects a confirmation that lands between the plan and append', async () => {
  const { store, nextEvidence, acceptingHistory, transitionedHistory } =
    await bundleTransitionFixture('accepted');
  store.history = acceptingHistory;
  store.readHistoryHook = (readNumber, current) => {
    if (readNumber === 2) current.history = transitionedHistory;
  };
  const result = await runProvisionalDecisionCommand(
    request({ evidenceUrl: nextEvidence.url }),
    store,
    { apply: true },
  );
  assertRefused(result, 'recovery-hold');
  if (result.state === 'refused') {
    assert.match(result.reason ?? '', /located decision, bundle/u);
  }
  assert.equal(store.appendCalls, 0);
});

test('step-8 holds when a concurrent completion changes its bundle before label apply', async () => {
  const { store, acceptingHistory, transitionedHistory } =
    await bundleTransitionFixture('accepted');
  store.history = acceptingHistory;
  store.readHistoryHook = (readNumber, current) => {
    if (readNumber === 2) current.history = transitionedHistory;
  };
  const result = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      pullRequestUrl: prUrl,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
    { apply: true },
  );
  assertRefused(result, 'recovery-hold');
  if (result.state === 'refused') {
    assert.match(result.reason ?? '', /located decision, bundle/u);
  }
  assert.equal(store.appendCalls, 0);
  assert.ok(store.labelCalls.every(({ apply }) => !apply));
});

test('work-completed in a later bundle applies despite a confirmed prior decision', async () => {
  const { store, nextEvidence, transitionedHistory } =
    await bundleTransitionFixture('accepted');
  store.history = transitionedHistory;

  const nextSelection = await runProvisionalDecisionCommand(
    request({ evidenceUrl: nextEvidence.url }),
    store,
    { apply: true },
  );
  assert.equal(nextSelection.state, 'applied', JSON.stringify(nextSelection));
  const planComment = comment(
    '200',
    'Plan for the second decision.',
    '2026-11-03T11:00:13Z',
  );
  store.history = {
    ...store.history,
    comments: [...store.history.comments, planComment],
    serverDate: 'Tue, 03 Nov 2026 11:00:14 GMT',
  };
  const nextStarted = await runProvisionalDecisionCommand(
    request({
      type: 'work-started',
      evidenceUrl: nextEvidence.url,
      planCommentUrl: planComment.url,
    }),
    store,
    { apply: true },
  );
  assert.equal(nextStarted.state, 'applied', JSON.stringify(nextStarted));

  const secondPrUrl = `https://github.com/${repository}/pull/5099`;
  store.pullRequests.set(secondPrUrl, {
    state: 'merged',
    headSha,
    mergeCommitSha: 'c'.repeat(40),
    requiredChecksPassing: true,
  });
  const completion = await runProvisionalDecisionCommand(
    request({
      type: 'work-completed',
      evidenceUrl: nextEvidence.url,
      pullRequestUrl: secondPrUrl,
      verifiedHeadSha: headSha,
      executionCriteriaSatisfied: true,
    }),
    store,
    { apply: true },
  );
  assert.equal(completion.state, 'applied', JSON.stringify(completion));
  assert.equal(store.labelPresent, true);
  assert.ok(store.labelCalls.some(({ apply }) => apply));
});
