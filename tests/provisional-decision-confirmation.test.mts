import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadIddConfig } from '../src/scripts/idd-config.mts';
import {
  parseClaimComment,
  renderClaimedByMarker,
  renderUnclaimedByMarker,
} from '../src/scripts/marker-helpers.mts';
import {
  type ConfirmationInput,
  type ConfirmationTerminalEvent,
  PROVISIONAL_CONFIRMATION_QUESTION,
  type ProvisionalDecisionCommandRequest,
  type ProvisionalDecisionHistoryComment,
  type ProvisionalDecisionHistoryRead,
  type ProvisionalDecisionPullRequestRead,
  type ProvisionalDecisionSourceIssueRead,
  type ProvisionalDecisionSourceStateRead,
  type ProvisionalResolutionCloseExpectation,
  type ProvisionalResolutionRequest,
  type ProvisionalResolutionResult,
  type ProvisionalResolutionStore,
  type ProvisionalResolveRequest,
  type ProvisionalReworkAuthoringEvidence,
  readConfirmationAnswer,
  runProvisionalDecisionCommand,
  runProvisionalResolution,
} from '../src/scripts/provisional-decision.mts';
import {
  PROVISIONAL_DECISION_ANSWER_MARKER,
  PROVISIONAL_DECISION_ANSWER_NOTE,
  PROVISIONAL_DECISION_RECORD_MARKER,
  type ProvisionalDecisionRecord,
  type ProvisionalReworkHandoff,
  parseProvisionalDecisionAnswerComment,
  parseProvisionalDecisionRecordComment,
  replayProvisionalDecisionHistory,
  type VerifiedProvisionalReworkRoadmap,
} from '../src/scripts/provisional-decision-state.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const repository = 'kurone-kito/idd-skill';
const issueNumber = 4536;
const title = 'Confirmation resolution fixture';
const body = [
  '## Decision needed',
  'Question: Which safe behavior should be used?',
  '',
  '## Acceptance criteria',
  'The selected behavior is verified.',
].join('\n');
const implClaim = 'claim-4536-impl';
const implAgent = 'codex-impl-agent';
const implBranch = 'issue/4536-feat-decisions-implement-choice';
const coordAgent = 'codex-coordination-agent';
const coordBranch = 'issue/4536-confirm-choices';
const issueUrl = `https://github.com/${repository}/issues/${issueNumber}`;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

type FailureMode = 'before' | 'after' | 'silent' | undefined;

/** An in-memory issue with a server clock that advances on every write. */
class MemoryStore implements ProvisionalResolutionStore {
  history: ProvisionalDecisionHistoryRead = {
    comments: [],
    complete: true,
    serverDate: '',
  };
  source: ProvisionalDecisionSourceIssueRead = {
    title,
    body,
    updatedAt: '2026-11-03T10:59:00Z',
  };
  sourceState: ProvisionalDecisionSourceStateRead = {
    state: 'open',
    stateReason: null,
  };
  pullRequests = new Map<string, ProvisionalDecisionPullRequestRead>();
  policy?: ReturnType<typeof loadIddConfig>;
  serverMs = Date.parse('2026-11-03T11:00:10Z');
  /** When true, new comments share the current second instead of advancing. */
  frozen = false;
  nextId = 100;
  answerAppends = 0;
  recordAppends = 0;
  closes = 0;
  releases = 0;
  labelCalls = 0;
  recordFailure?: (eventType: string, body: string) => FailureMode;
  answerFailure: FailureMode;
  historyReads = 0;
  readHook?: (readNumber: number, store: MemoryStore) => void;
  closeFailure: FailureMode;
  closeReason = 'completed';
  releaseFailure: FailureMode;

  constructor() {
    this.addComment(
      (at) =>
        renderClaimedByMarker({
          agentId: implAgent,
          claimId: implClaim,
          supersedes: 'none',
          timestamp: at,
          branch: implBranch,
        }),
      '2026-11-03T11:00:00Z',
    );
    this.addComment(
      () => 'Option comparison evidence one.',
      '2026-11-03T11:00:01Z',
    );
    this.addComment(
      () => 'Option comparison evidence two.',
      '2026-11-03T11:00:02Z',
    );
  }

  url(id: string): string {
    return `${issueUrl}#issuecomment-${id}`;
  }

  baseline(): { title: string; bodySha256: string } {
    return { title: this.source.title, bodySha256: sha256(this.source.body) };
  }

  /** Append a trusted comment; the server clock moves past it. */
  addComment(
    render: (createdAt: string) => string,
    at?: string,
    overrides: Partial<ProvisionalDecisionHistoryComment> = {},
  ): ProvisionalDecisionHistoryComment {
    let createdAt: string;
    if (at) {
      createdAt = at;
    } else {
      if (!this.frozen) this.serverMs += 1000;
      createdAt = iso(this.serverMs);
    }
    const id =
      at && !overrides.id
        ? String(this.history.comments.length + 1)
        : (overrides.id ?? String(this.nextId++));
    const comment: ProvisionalDecisionHistoryComment = {
      id,
      url: this.url(id),
      body: render(createdAt),
      authorLogin: 'KuRoNe-KiTo',
      createdAt,
      edited: false,
      trustedAuthor: true,
      ...overrides,
    };
    this.history = {
      ...this.history,
      comments: [...this.history.comments, comment],
    };
    if (!at && !this.frozen) this.serverMs += 1000;
    return comment;
  }

  replaceComment(
    id: string,
    patch: Partial<ProvisionalDecisionHistoryComment>,
  ): void {
    this.history = {
      ...this.history,
      comments: this.history.comments.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    };
  }

  async readHistory(): Promise<ProvisionalDecisionHistoryRead> {
    this.historyReads += 1;
    this.readHook?.(this.historyReads, this);
    return {
      ...this.history,
      serverDate: new Date(this.serverMs).toUTCString(),
    };
  }

  async readSourceIssue(): Promise<ProvisionalDecisionSourceIssueRead> {
    return this.source;
  }

  async readSourceState(): Promise<ProvisionalDecisionSourceStateRead> {
    return this.sourceState;
  }

  async readPullRequest(
    url: string,
  ): Promise<ProvisionalDecisionPullRequestRead> {
    const found = this.pullRequests.get(url);
    if (!found) throw new Error(`missing pull request ${url}`);
    return found;
  }

  async appendRecordBody(
    recordId: string,
    text: string,
  ): Promise<{
    result: 'created' | 'existed';
    record: { id: string; url: string };
  }> {
    this.recordAppends += 1;
    const existing = this.history.comments.find((item) => {
      const parsed = parseProvisionalDecisionRecordComment(item.body);
      return parsed.ok && parsed.record.recordId === recordId;
    });
    if (existing) {
      return {
        result: 'existed',
        record: { id: existing.id, url: existing.url },
      };
    }
    const parsed = parseProvisionalDecisionRecordComment(text);
    const mode = this.recordFailure?.(
      parsed.ok ? String(parsed.record.event.type) : 'invalid',
      text,
    );
    if (mode === 'before') throw new Error('record write failed');
    const added = this.addComment(() => text);
    if (mode === 'after') throw new Error('record write response lost');
    return { result: 'created', record: { id: added.id, url: added.url } };
  }

  async appendAnswerBody(text: string): Promise<{
    result: 'created' | 'existed';
    record: { id: string; url: string };
  }> {
    this.answerAppends += 1;
    const existing = this.history.comments.find((item) => item.body === text);
    if (existing) {
      return {
        result: 'existed',
        record: { id: existing.id, url: existing.url },
      };
    }
    if (this.answerFailure === 'silent') {
      return { result: 'created', record: { id: '1', url: this.url('1') } };
    }
    if (this.answerFailure === 'before') throw new Error('answer write failed');
    const added = this.addComment(() => text);
    if (this.answerFailure === 'after') {
      throw new Error('answer write response lost');
    }
    return { result: 'created', record: { id: added.id, url: added.url } };
  }

  beforeClose?: (store: MemoryStore) => void;

  /** The claim ID of the latest unreleased claimed-by marker, if any. */
  activeClaimId(): string | null {
    let active: string | null = null;
    for (const comment of this.history.comments) {
      const claim = parseClaimComment(comment.body, comment.createdAt);
      if (claim) active = claim.claimId;
      else if (comment.body.startsWith('<!-- unclaimed-by')) active = null;
    }
    return active;
  }

  async closeSourceIssue(
    expected: ProvisionalResolutionCloseExpectation,
  ): Promise<void> {
    this.closes += 1;
    this.beforeClose?.(this);
    if (this.closeFailure === 'before') throw new Error('close failed');
    // The store closes only while everything the plan evaluated still holds.
    if (this.sourceState.state !== expected.state) {
      throw new Error('the source is no longer open');
    }
    if (this.activeClaimId() !== expected.claim.claimId) {
      throw new Error('the coordination claim is no longer active');
    }
    if (
      this.source.title !== expected.title ||
      sha256(this.source.body) !== expected.bodySha256
    ) {
      throw new Error('the source changed since the plan');
    }
    this.sourceState = { state: 'closed', stateReason: this.closeReason };
    if (this.closeFailure === 'after') throw new Error('close response lost');
  }

  async releaseCoordinationClaim(claim: {
    claimId: string;
    agentId: string;
    branch: string;
  }): Promise<void> {
    this.releases += 1;
    if (this.releaseFailure === 'before') throw new Error('release failed');
    if (this.releaseFailure !== 'silent') {
      this.addComment((at) =>
        renderUnclaimedByMarker({
          agentId: claim.agentId,
          claimId: claim.claimId,
          timestamp: at,
        }),
      );
    }
    if (this.releaseFailure === 'after')
      throw new Error('release response lost');
  }

  async applyOrReadDecisionLabel(input: {
    labelName: string;
    apply: boolean;
  }): Promise<{ present: boolean }> {
    this.labelCalls += 1;
    return { present: input.apply };
  }

  writes(): number {
    return (
      this.answerAppends + this.recordAppends + this.closes + this.releases
    );
  }

  /** Forget the writes made while building the fixture. */
  resetCounters(): void {
    this.answerAppends = 0;
    this.recordAppends = 0;
    this.closes = 0;
    this.releases = 0;
    this.labelCalls = 0;
  }
}

function commandRequest(
  store: MemoryStore,
  overrides: Partial<ProvisionalDecisionCommandRequest> & {
    claimId: string;
    worktreeBranch: string;
  },
): ProvisionalDecisionCommandRequest {
  return {
    type: 'selected',
    repository,
    issueNumber,
    policyTrusted: true,
    optionComparisonValid: true,
    baseline: store.baseline(),
    verifiedReworkRoadmaps: [],
    ...overrides,
  } as ProvisionalDecisionCommandRequest;
}

function option(id: string, alternative = false) {
  const common = {
    id,
    description: `Description for ${id}`,
    feasibilityRationale: 'It can be implemented in this repository.',
    requirementFit: 'It meets the stated requirement.',
    consequences: `Consequences of ${id}`,
    verification: 'Run the focused tests.',
    reversalOrMigration: `Reworking away from ${id} needs a migration.`,
  };
  return alternative
    ? {
        ...common,
        comparison: 'The selected choice has stronger evidence.',
        rejectionReason: 'This choice adds unnecessary complexity.',
      }
    : { ...common, rationale: 'It best fits the current evidence.' };
}

interface DecisionDrive {
  readonly evidenceId: string;
  readonly pullNumber: number;
  readonly claimId?: string;
  readonly branch?: string;
  readonly verifiedReworkRoadmaps?: VerifiedProvisionalReworkRoadmap[];
}

/** Drive one decision from selection to verified completion. */
async function completeDecision(
  store: MemoryStore,
  drive: DecisionDrive,
): Promise<void> {
  const claimId = drive.claimId ?? implClaim;
  const worktreeBranch = drive.branch ?? implBranch;
  const evidenceUrl = store.url(drive.evidenceId);
  const run = async (overrides: Record<string, unknown>) => {
    const result = await runProvisionalDecisionCommand(
      commandRequest(store, {
        claimId,
        worktreeBranch,
        evidenceUrl,
        verifiedReworkRoadmaps: drive.verifiedReworkRoadmaps ?? [],
        ...overrides,
      } as never),
      store,
      { apply: true },
    );
    assert.ok(
      result.state === 'applied' || result.state === 'reconciled',
      JSON.stringify(result),
    );
  };
  await run({
    type: 'selected',
    selectedOption: option('keep'),
    feasibleAlternatives: [option('change', true)],
    executionCriteria: ['The chosen behavior passes focused validation.'],
  });
  const plan = store.addComment(() => 'Implementation plan.');
  await run({ type: 'work-started', planCommentUrl: plan.url });
  const pullUrl = `https://github.com/${repository}/pull/${drive.pullNumber}`;
  const hex = drive.pullNumber.toString(16).padStart(40, '0');
  const merge = (drive.pullNumber + 1000).toString(16).padStart(40, '0');
  store.pullRequests.set(pullUrl, {
    state: 'merged',
    headSha: hex,
    mergeCommitSha: merge,
    requiredChecksPassing: true,
  });
  await run({
    type: 'work-completed',
    pullRequestUrl: pullUrl,
    verifiedHeadSha: hex,
    executionCriteriaSatisfied: true,
  });
}

function postCoordinationClaim(store: MemoryStore, claimId: string): void {
  store.addComment((at) =>
    renderClaimedByMarker({
      agentId: coordAgent,
      claimId,
      supersedes: 'none',
      timestamp: at,
      branch: coordBranch,
    }),
  );
}

function releaseImplementation(store: MemoryStore): void {
  store.addComment((at) =>
    renderUnclaimedByMarker({
      agentId: implAgent,
      claimId: implClaim,
      timestamp: at,
    }),
  );
}

/** A completed bundle of `count` decisions with a coordination claim active. */
async function pendingStore(
  count = 1,
  coordClaim = 'claim-4536-coord',
): Promise<MemoryStore> {
  const store = new MemoryStore();
  for (let index = 0; index < count; index += 1) {
    await completeDecision(store, {
      evidenceId: String(index + 2),
      pullNumber: 6000 + index,
    });
  }
  releaseImplementation(store);
  postCoordinationClaim(store, coordClaim);
  store.resetCounters();
  return store;
}

const conversationYes: ConfirmationInput = {
  channel: 'conversation',
  origin: 'user',
  message: 'Yes, I accept the presented completed choices.',
  interpretation: { response: 'accepted' },
};

const terminalYes: ConfirmationInput = {
  channel: 'terminal',
  origin: 'user',
  interactive: true,
  event: { kind: 'line', text: 'y' },
};

const reworkConversation: ConfirmationInput = {
  channel: 'conversation',
  origin: 'user',
  message: 'I prefer the alternative option.',
  interpretation: {
    response: 'rework',
    requestedOptionId: 'change',
    rationale: 'Revise this comparison.',
  },
};

function resolveRequest(
  overrides: Partial<ProvisionalResolveRequest> = {},
  claimId = 'claim-4536-coord',
): ProvisionalResolveRequest {
  return {
    type: 'resolve',
    repository,
    issueNumber,
    claimId,
    agentId: coordAgent,
    branch: coordBranch,
    verifiedReworkRoadmaps: [],
    decisionGenerations: [1],
    ...overrides,
  };
}

/** The digest a user was shown, read from a dry run. */
async function shownDigest(
  store: MemoryStore,
  overrides: Partial<ProvisionalResolveRequest> = {},
  claimId = 'claim-4536-coord',
): Promise<string> {
  const dry = await runProvisionalResolution(
    resolveRequest({ input: null, ...overrides }, claimId),
    store,
  );
  assert.ok(dry.presentationSha256, JSON.stringify(dry));
  return dry.presentationSha256;
}

async function answered(
  store: MemoryStore,
  input: ConfirmationInput | null,
  overrides: Partial<ProvisionalResolveRequest> = {},
  claimId = 'claim-4536-coord',
  apply = true,
): Promise<ProvisionalResolutionResult> {
  const digest = await shownDigest(store, overrides, claimId);
  return runProvisionalResolution(
    resolveRequest(
      { input, answeredPresentationSha256: digest, ...overrides },
      claimId,
    ),
    store,
    { apply },
  );
}

function recordsOf(store: MemoryStore): ProvisionalDecisionRecord[] {
  return store.history.comments.flatMap((comment) => {
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    return parsed.ok ? [parsed.record] : [];
  });
}

function eventsOf(store: MemoryStore): string[] {
  return recordsOf(store).map((record) => String(record.event.type));
}

function answersOf(store: MemoryStore) {
  return store.history.comments.flatMap((comment) => {
    if (!comment.body.startsWith(PROVISIONAL_DECISION_ANSWER_MARKER)) return [];
    const parsed = parseProvisionalDecisionAnswerComment(comment.body);
    return parsed.ok ? [{ comment, answer: parsed.answer }] : [];
  });
}

function activeCoordinationClaim(store: MemoryStore): boolean {
  const claims = store.history.comments.filter((comment) =>
    comment.body.includes('claim-4536-coord'),
  );
  return (
    claims.some((comment) => comment.body.startsWith('<!-- claimed-by')) &&
    !claims.some((comment) => comment.body.startsWith('<!-- unclaimed-by'))
  );
}

function sourceOf(store: MemoryStore) {
  return {
    repository,
    issueNumber,
    snapshot: {
      title: store.source.title,
      bodySha256: sha256(store.source.body),
      updatedAt: store.source.updatedAt,
    },
  };
}

function assertRefused(
  result: ProvisionalResolutionResult,
  action: 'none' | 'recovery-hold' | 'fix-input',
  reason?: RegExp,
): void {
  assert.equal(result.state, 'refused', JSON.stringify(result));
  assert.equal(result.action, action, JSON.stringify(result));
  if (reason) assert.match(result.reason ?? '', reason);
}

// ---------------------------------------------------------------------------
// Input adapter
// ---------------------------------------------------------------------------

test('an interactive terminal y accepts and the default N does not', () => {
  const accepted = (text: string) =>
    readConfirmationAnswer(
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'line', text },
      },
      ['change'],
    );
  for (const text of ['y', 'Y', 'yes', ' YES ']) {
    assert.deepEqual(accepted(text), {
      kind: 'accepted',
      channel: 'terminal',
      answerText: text,
    });
  }
  assert.deepEqual(accepted(''), { kind: 'pending', reason: 'default-no' });
  assert.deepEqual(accepted('   '), { kind: 'pending', reason: 'default-no' });
  assert.deepEqual(accepted('n'), { kind: 'pending', reason: 'declined' });
  assert.deepEqual(accepted('No'), { kind: 'pending', reason: 'declined' });
  assert.deepEqual(accepted('sure'), {
    kind: 'pending',
    reason: 'unrecognized',
  });
  assert.deepEqual(accepted('yes please'), {
    kind: 'pending',
    reason: 'unrecognized',
  });
});

test('EOF, cancellation, timeout, and missing input leave the source pending', () => {
  const terminal = (event: ConfirmationInput) =>
    readConfirmationAnswer(event, ['change']);
  assert.deepEqual(
    terminal({
      channel: 'terminal',
      origin: 'user',
      interactive: true,
      event: { kind: 'eof' },
    }),
    { kind: 'pending', reason: 'eof' },
  );
  assert.deepEqual(
    terminal({
      channel: 'terminal',
      origin: 'user',
      interactive: true,
      event: { kind: 'cancelled' },
    }),
    { kind: 'pending', reason: 'cancelled' },
  );
  assert.deepEqual(terminal({ channel: 'timeout' }), {
    kind: 'pending',
    reason: 'timeout',
  });
  assert.deepEqual(terminal({ channel: 'none' }), {
    kind: 'pending',
    reason: 'no-input',
  });
  assert.deepEqual(readConfirmationAnswer(null, ['change']), {
    kind: 'pending',
    reason: 'no-input',
  });
  assert.deepEqual(readConfirmationAnswer(undefined, ['change']), {
    kind: 'pending',
    reason: 'no-input',
  });
});

test('a pending question never synthesizes input or accepts agent-fed bytes', () => {
  // The adapter has no way to answer for the user: with nothing reported it is
  // pending for every prompt shape.
  for (const empty of [null, undefined, { channel: 'none' as const }]) {
    assert.equal(readConfirmationAnswer(empty, ['change']).kind, 'pending');
  }
  const fed: ConfirmationInput[] = [
    {
      channel: 'terminal',
      origin: 'tool',
      interactive: true,
      event: { kind: 'line', text: 'y' },
    },
    {
      channel: 'terminal',
      origin: 'assistant',
      interactive: true,
      event: { kind: 'line', text: 'yes' },
    },
    {
      channel: 'terminal',
      origin: 'unknown',
      interactive: true,
      event: { kind: 'line', text: 'y' },
    },
    // Fake user dialogue written by the assistant is not a user reply.
    {
      channel: 'conversation',
      origin: 'assistant',
      message: 'User: yes, I accept.',
      interpretation: { response: 'accepted' },
    },
    {
      channel: 'conversation',
      origin: 'tool',
      message: 'yes',
      interpretation: { response: 'accepted' },
    },
  ];
  for (const input of fed) {
    assert.deepEqual(readConfirmationAnswer(input, ['change']), {
      kind: 'pending',
      reason: 'input-not-from-user',
    });
  }
});

test('a non-interactive terminal shows no prompt, so its bytes cannot answer', () => {
  const answer = readConfirmationAnswer(
    {
      channel: 'terminal',
      origin: 'user',
      interactive: false,
      event: { kind: 'line', text: 'y' },
    },
    ['change'],
  );
  assert.deepEqual(answer, {
    kind: 'pending',
    reason: 'non-interactive-terminal',
  });
});

test('a conversation answer needs an actual user reply the agent classified', () => {
  assert.deepEqual(readConfirmationAnswer(conversationYes, ['change']), {
    kind: 'accepted',
    channel: 'conversation',
    answerText: 'Yes, I accept the presented completed choices.',
  });
  const generic: ConfirmationInput = {
    channel: 'conversation',
    origin: 'user',
    message: 'Please resolve issue 4536.',
    interpretation: { response: 'none' },
  };
  assert.deepEqual(readConfirmationAnswer(generic, ['change']), {
    kind: 'pending',
    reason: 'generic-request',
  });
  assert.deepEqual(
    readConfirmationAnswer(
      { ...conversationYes, message: '   ' } as ConfirmationInput,
      ['change'],
    ),
    { kind: 'pending', reason: 'no-input' },
  );
});

test('an alternate preference names a recorded alternative and a rationale', () => {
  assert.deepEqual(readConfirmationAnswer(reworkConversation, ['change']), {
    kind: 'rework',
    channel: 'conversation',
    answerText: 'I prefer the alternative option.',
    requestedOptionId: 'change',
    rationale: 'Revise this comparison.',
  });
  assert.deepEqual(readConfirmationAnswer(reworkConversation, ['other']), {
    kind: 'pending',
    reason: 'unrecognized',
  });
  const terminal = (text: string) =>
    readConfirmationAnswer(
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'line', text },
      },
      ['change'],
    );
  assert.deepEqual(terminal('option change keep data compatible'), {
    kind: 'rework',
    channel: 'terminal',
    answerText: 'option change keep data compatible',
    requestedOptionId: 'change',
    rationale: 'keep data compatible',
  });
  assert.deepEqual(terminal('option missing because'), {
    kind: 'pending',
    reason: 'unrecognized',
  });
  assert.deepEqual(terminal('option change'), {
    kind: 'pending',
    reason: 'unrecognized',
  });
});

// ---------------------------------------------------------------------------
// Confirmed close
// ---------------------------------------------------------------------------

test('a dry run presents the bundle and writes nothing', async () => {
  const store = await pendingStore();
  const before = store.history.comments.length;
  const dry = await runProvisionalResolution(resolveRequest(), store);
  assert.equal(dry.state, 'planned');
  assert.equal(dry.nextStep, 'release-claim');
  assert.equal(dry.presentation?.question, PROVISIONAL_CONFIRMATION_QUESTION);
  assert.equal(dry.presentation?.decisions.length, 1);
  const decision = dry.presentation?.decisions[0];
  assert.equal(decision?.status, 'confirmation-pending');
  const selected = decision?.selectedOption as { id: string } | undefined;
  const alternative = decision?.alternatives[0] as
    | { reworkImpact: string }
    | undefined;
  assert.equal(selected?.id, 'keep');
  assert.equal(
    alternative?.reworkImpact,
    'Reworking away from change needs a migration.',
  );
  assert.equal(store.history.comments.length, before);
  assert.equal(store.writes(), 0);
  const accepted = await runProvisionalResolution(
    resolveRequest({
      input: conversationYes,
      answeredPresentationSha256: dry.presentationSha256,
    }),
    store,
  );
  assert.equal(accepted.state, 'planned');
  assert.equal(accepted.nextStep, 'append-answer');
  assert.equal(store.writes(), 0);
});

test('an actual conversation answer recorded by an agent confirms, closes, and releases', async () => {
  const store = await pendingStore();
  const result = await answered(store, conversationYes);
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.outcome, 'confirmed-closed');
  assert.deepEqual(result.steps, [
    'append-answer',
    'append-confirmation',
    'close-source',
    'release-claim',
  ]);
  const [stored] = answersOf(store);
  assert.ok(stored);
  assert.equal(stored.answer.response, 'accepted');
  assert.equal(
    stored.answer.presentedQuestion,
    PROVISIONAL_CONFIRMATION_QUESTION,
  );
  assert.equal(
    stored.answer.answerText,
    'Yes, I accept the presented completed choices.',
  );
  assert.deepEqual(stored.answer.decisionGenerations, [1]);
  assert.equal(stored.answer.presentedBundle[0]?.selectedOptionId, 'keep');
  assert.deepEqual(eventsOf(store).slice(-1), ['confirmed']);
  assert.equal(store.sourceState.state, 'closed');
  assert.equal(store.sourceState.stateReason, 'completed');
  assert.equal(activeCoordinationClaim(store), false);
  // The answer is a trusted, unedited comment from the shared account.
  assert.equal(stored.comment.trustedAuthor, true);
  assert.equal(stored.comment.authorLogin, 'KuRoNe-KiTo');
});

test('the confirmed record follows the answer in the order replay requires', async () => {
  const store = await pendingStore();
  await answered(store, conversationYes);
  const ids = store.history.comments.map((comment) => comment.id);
  const answerComment = answersOf(store)[0]?.comment;
  const confirmed = store.history.comments.find((comment) => {
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    return parsed.ok && parsed.record.event.type === 'confirmed';
  });
  assert.ok(answerComment && confirmed);
  assert.ok(ids.indexOf(answerComment.id) < ids.indexOf(confirmed.id));
  const record = recordsOf(store).find(
    (item) => item.event.type === 'confirmed',
  ) as ProvisionalDecisionRecord;
  assert.deepEqual(record.event.confirmation, {
    commentUrl: answerComment.url,
    response: 'accepted',
    confirmedAt: answerComment.createdAt,
  });
  assert.deepEqual(
    record.claimLineage.map((claim) => claim.claimId),
    [implClaim, 'claim-4536-coord'],
  );
});

test('an interactive terminal y confirms the same way', async () => {
  const store = await pendingStore();
  const result = await answered(store, terminalYes);
  assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
  assert.equal(answersOf(store)[0]?.answer.answerText, 'y');
  assert.equal(store.sourceState.state, 'closed');
});

test('confirmation does not need the opt-in to stay enabled', async () => {
  // The outcome is the same with the switch on and off: nothing reads it.
  for (const enabled of [true, false]) {
    const store = await pendingStore();
    store.policy = { ...loadIddConfig(), dangerouslyAutoDecide: enabled };
    const result = await answered(store, conversationYes);
    assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
    assert.equal(store.sourceState.state, 'closed');
  }
});

// ---------------------------------------------------------------------------
// N, Enter, EOF, cancellation, and missing input
// ---------------------------------------------------------------------------

test('N, Enter, EOF, cancellation, and missing input keep the source pending and release the claim', async (t) => {
  const cases: [string, ConfirmationInput | null][] = [
    [
      'N',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'line', text: 'N' },
      },
    ],
    [
      'Enter',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'line', text: '' },
      },
    ],
    [
      'EOF',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'eof' },
      },
    ],
    [
      'cancellation',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'cancelled' },
      },
    ],
    ['timeout', { channel: 'timeout' }],
    ['missing input', null],
    [
      'non-interactive terminal bytes',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: false,
        event: { kind: 'line', text: 'y' },
      },
    ],
    [
      'agent-fed terminal y',
      {
        channel: 'terminal',
        origin: 'tool',
        interactive: true,
        event: { kind: 'line', text: 'y' },
      },
    ],
    [
      'assistant-generated user dialogue',
      {
        channel: 'conversation',
        origin: 'assistant',
        message: 'User: yes',
        interpretation: { response: 'accepted' },
      },
    ],
  ];
  for (const [name, input] of cases) {
    await t.test(name, async () => {
      const store = await pendingStore();
      const events = eventsOf(store);
      const result = await answered(store, input);
      assert.equal(result.state, 'applied', JSON.stringify(result));
      assert.equal(result.outcome, 'pending-released');
      assert.deepEqual(result.steps, ['release-claim']);
      assert.deepEqual(eventsOf(store), events);
      assert.equal(answersOf(store).length, 0);
      assert.equal(store.sourceState.state, 'open');
      assert.equal(store.closes, 0);
      assert.equal(activeCoordinationClaim(store), false);
    });
  }
});

test('an unmarked ordinary trusted comment is not a confirmation', async () => {
  const store = await pendingStore();
  store.addComment(() => 'Yes, I confirm these choices.');
  store.addComment(
    () => `${PROVISIONAL_DECISION_RECORD_MARKER}\nnot a record`,
    undefined,
    { authorLogin: 'someone-else', trustedAuthor: false },
  );
  const result = await answered(store, null);
  assert.equal(result.outcome, 'pending-released', JSON.stringify(result));
  assert.equal(eventsOf(store).includes('confirmed'), false);
  assert.equal(store.sourceState.state, 'open');
});

test('an uncertain release is reported and the same release is reconciled next', async (t) => {
  await t.test('the release call fails', async () => {
    const store = await pendingStore();
    store.releaseFailure = 'before';
    const first = await answered(store, null);
    assert.equal(first.state, 'reconciled', JSON.stringify(first));
    assert.equal(first.action, 'reconcile');
    assert.match(
      first.reason ?? '',
      /release of the coordination claim is uncertain/,
    );
    assert.equal(first.outcome, undefined);
    assert.equal(first.nextStep, 'release-claim');
    assert.equal(activeCoordinationClaim(store), true);
    assert.equal(eventsOf(store).includes('confirmed'), false);
    // A new resolution attempt under another claim must not start first.
    const other = await runProvisionalResolution(
      resolveRequest({ input: conversationYes }, 'claim-4536-other'),
      store,
      { apply: true },
    );
    assertRefused(other, 'fix-input', /a different claim is active/);
    store.releaseFailure = undefined;
    const second = await answered(store, null);
    assert.equal(second.state, 'applied', JSON.stringify(second));
    assert.deepEqual(second.steps, ['release-claim']);
    assert.equal(activeCoordinationClaim(store), false);
  });

  await t.test('the release response is lost after it applied', async () => {
    const store = await pendingStore();
    store.releaseFailure = 'after';
    const first = await answered(store, null);
    // A fresh read proves the release landed, so it counts as done.
    assert.equal(first.state, 'applied', JSON.stringify(first));
    assert.equal(first.outcome, 'pending-released');
    assert.deepEqual(first.steps, ['release-claim']);
    assert.equal(activeCoordinationClaim(store), false);
    store.releaseFailure = undefined;
    const releasesBefore = store.releases;
    // With the claim gone, nothing more can be written under it.
    const second = await runProvisionalResolution(resolveRequest(), store, {
      apply: true,
    });
    assertRefused(second, 'fix-input', /active coordination claim is required/);
    assert.equal(store.releases, releasesBefore);
  });

  await t.test('the release call returns but nothing is posted', async () => {
    const store = await pendingStore();
    store.releaseFailure = 'silent';
    const result = await answered(store, null);
    assert.equal(result.state, 'reconciled', JSON.stringify(result));
    assert.match(result.reason ?? '', /not confirmed by a fresh read/);
    assert.equal(activeCoordinationClaim(store), true);
  });
});

// ---------------------------------------------------------------------------
// Replay and resume
// ---------------------------------------------------------------------------

test('a previously valid confirmation replays without another prompt', async () => {
  const store = await pendingStore();
  store.closeFailure = 'before';
  const first = await answered(store, conversationYes);
  assert.equal(first.state, 'refused', JSON.stringify(first));
  assert.equal(first.action, 'recovery-hold');
  assert.deepEqual(first.steps, ['append-answer', 'append-confirmation']);
  assert.equal(eventsOf(store).includes('confirmed'), true);
  assert.equal(store.sourceState.state, 'open');
  assert.equal(activeCoordinationClaim(store), true);

  // Unattended resume: no input, no digest, and no new prompt or record.
  store.closeFailure = undefined;
  const answersBefore = answersOf(store).length;
  const recordsBefore = eventsOf(store).length;
  const resumed = await runProvisionalResolution(resolveRequest(), store, {
    apply: true,
  });
  assert.equal(resumed.state, 'applied', JSON.stringify(resumed));
  assert.equal(resumed.outcome, 'confirmed-closed');
  assert.deepEqual(resumed.steps, ['close-source', 'release-claim']);
  assert.equal(answersOf(store).length, answersBefore);
  assert.equal(eventsOf(store).length, recordsBefore);
  assert.equal(store.sourceState.state, 'closed');
  assert.equal(activeCoordinationClaim(store), false);
});

test('a lost close response resumes only the release, never another close or execution', async () => {
  const store = await pendingStore();
  store.closeFailure = 'after';
  store.releaseFailure = 'before';
  const first = await answered(store, conversationYes);
  assert.equal(first.state, 'reconciled', JSON.stringify(first));
  assert.match(
    first.reason ?? '',
    /release of the coordination claim is uncertain/,
  );
  assert.equal(store.sourceState.state, 'closed');
  assert.equal(activeCoordinationClaim(store), true);
  assert.deepEqual(first.steps, [
    'append-answer',
    'append-confirmation',
    'close-source',
  ]);

  store.closeFailure = undefined;
  store.releaseFailure = undefined;
  const closesBefore = store.closes;
  const recordsBefore = store.recordAppends;
  const answersBefore = store.answerAppends;
  const resumed = await runProvisionalResolution(resolveRequest(), store, {
    apply: true,
  });
  assert.equal(resumed.state, 'applied', JSON.stringify(resumed));
  assert.deepEqual(resumed.steps, ['release-claim']);
  assert.equal(store.closes, closesBefore);
  assert.equal(store.recordAppends, recordsBefore);
  assert.equal(store.answerAppends, answersBefore);

  // Once everything is done a rerun writes nothing.
  const again = await runProvisionalResolution(resolveRequest(), store, {
    apply: true,
  });
  assert.equal(again.state, 'reconciled', JSON.stringify(again));
  assert.equal(again.outcome, 'confirmed-closed');
  assert.deepEqual(again.steps, []);
});

test('an uncertain confirmation write is reconciled by a fresh read before any retry', async (t) => {
  await t.test('the write landed but its response was lost', async () => {
    const store = await pendingStore();
    store.recordFailure = (type) =>
      type === 'confirmed' ? 'after' : undefined;
    const result = await answered(store, conversationYes);
    assert.equal(result.state, 'applied', JSON.stringify(result));
    assert.equal(
      eventsOf(store).filter((type) => type === 'confirmed').length,
      1,
    );
    assert.equal(store.sourceState.state, 'closed');
  });

  await t.test('the write did not land', async () => {
    const store = await pendingStore();
    store.recordFailure = (type) =>
      type === 'confirmed' ? 'before' : undefined;
    const result = await answered(store, conversationYes);
    assertRefused(
      result,
      'recovery-hold',
      /append-confirmation write is uncertain/,
    );
    assert.equal(store.sourceState.state, 'open');
    assert.equal(activeCoordinationClaim(store), true);
    assert.equal(answersOf(store).length, 1);
    // The retry reuses the persisted answer: no second answer, no prompt.
    store.recordFailure = undefined;
    const retry = await runProvisionalResolution(resolveRequest(), store, {
      apply: true,
    });
    assert.equal(retry.outcome, 'confirmed-closed', JSON.stringify(retry));
    assert.equal(answersOf(store).length, 1);
  });
});

test('a failed close is a recovery hold that resumes the close, not execution', async () => {
  const store = await pendingStore();
  store.closeFailure = 'before';
  const result = await answered(store, conversationYes);
  assertRefused(result, 'recovery-hold', /close-source write is uncertain/);
  assert.equal(store.releases, 0);
  assert.equal(activeCoordinationClaim(store), true);
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test('a competing or implementation claim, or no claim, refuses without writing', async (t) => {
  await t.test('a competing active claim', async () => {
    const store = await pendingStore(1, 'claim-4536-coord');
    const result = await runProvisionalResolution(
      resolveRequest({ input: conversationYes }, 'claim-4536-mine'),
      store,
      { apply: true },
    );
    assertRefused(result, 'fix-input', /a different claim is active/);
    assert.equal(store.writes(), 0);
  });

  await t.test('the still-active implementation claim', async () => {
    const store = new MemoryStore();
    await completeDecision(store, { evidenceId: '2', pullNumber: 6000 });
    store.resetCounters();
    const result = await runProvisionalResolution(
      resolveRequest(
        { input: conversationYes, agentId: implAgent, branch: implBranch },
        implClaim,
      ),
      store,
      { apply: true },
    );
    assertRefused(result, 'fix-input', /ran the implementation/);
    assert.equal(store.writes(), 0);
  });

  await t.test('no active coordination claim', async () => {
    const store = new MemoryStore();
    await completeDecision(store, { evidenceId: '2', pullNumber: 6000 });
    releaseImplementation(store);
    store.resetCounters();
    const result = await runProvisionalResolution(
      resolveRequest({
        input: conversationYes,
        answeredPresentationSha256: 'x',
      }),
      store,
      { apply: true },
    );
    assertRefused(result, 'fix-input', /active coordination claim is required/);
    assert.equal(store.writes(), 0);
  });
});

test('a source that is not execution-complete or is already closed is not resolved', async (t) => {
  await t.test('no provisional decision', async () => {
    const store = new MemoryStore();
    postCoordinationClaim(store, 'claim-4536-coord');
    releaseImplementation(store);
    const result = await runProvisionalResolution(resolveRequest(), store);
    assertRefused(result, 'none', /no provisional decision/);
  });

  await t.test('work still in progress', async () => {
    const store = new MemoryStore();
    const run = await runProvisionalDecisionCommand(
      commandRequest(store, {
        claimId: implClaim,
        worktreeBranch: implBranch,
        type: 'selected',
        evidenceUrl: store.url('2'),
        selectedOption: option('keep'),
        feasibleAlternatives: [option('change', true)],
        executionCriteria: ['The chosen behavior passes focused validation.'],
      } as never),
      store,
      { apply: true },
    );
    assert.equal(run.state, 'applied');
    releaseImplementation(store);
    postCoordinationClaim(store, 'claim-4536-coord');
    const result = await runProvisionalResolution(resolveRequest(), store);
    assertRefused(result, 'none', /without verified completed work/);
  });

  await t.test('closed while unconfirmed', async () => {
    const store = await pendingStore();
    store.sourceState = { state: 'closed', stateReason: 'not_planned' };
    const result = await runProvisionalResolution(
      resolveRequest({
        input: conversationYes,
        answeredPresentationSha256: 'x',
      }),
      store,
    );
    assertRefused(result, 'none', /already closed/);
  });

  await t.test('decisions outside the current bundle', async () => {
    const store = await pendingStore();
    const result = await runProvisionalResolution(
      resolveRequest({ decisionGenerations: [9] }),
      store,
    );
    assertRefused(result, 'fix-input', /decisionGenerations/);
    const empty = await runProvisionalResolution(
      resolveRequest({ decisionGenerations: [] }),
      store,
    );
    assertRefused(empty, 'fix-input', /decisionGenerations/);
  });
});

test('incomplete history and failed reads are recovery holds', async () => {
  const store = await pendingStore();
  store.history = { ...store.history, complete: false };
  assertRefused(
    await runProvisionalResolution(resolveRequest(), store),
    'recovery-hold',
    /incomplete/,
  );
  store.history = { ...store.history, complete: true };
  store.readSourceState = async () => {
    throw new Error('state unavailable');
  };
  assertRefused(
    await runProvisionalResolution(resolveRequest(), store),
    'recovery-hold',
    /fresh read failed/,
  );
});

// ---------------------------------------------------------------------------
// Stale, partial, changed, and untrusted evidence
// ---------------------------------------------------------------------------

test('an answer needs the digest of the presentation it answered', async (t) => {
  await t.test('a missing digest', async () => {
    const store = await pendingStore();
    const result = await runProvisionalResolution(
      resolveRequest({ input: conversationYes }),
      store,
      { apply: true },
    );
    assertRefused(
      result,
      'fix-input',
      /answeredPresentationSha256 is required/,
    );
    assert.equal(store.writes(), 0);
  });

  await t.test('a stale digest', async () => {
    const store = await pendingStore();
    const result = await runProvisionalResolution(
      resolveRequest({
        input: conversationYes,
        answeredPresentationSha256: 'f'.repeat(64),
      }),
      store,
      { apply: true },
    );
    assertRefused(result, 'fix-input', /no longer matches/);
    assert.equal(store.writes(), 0);
  });
});

test('a source edit after the presentation is held by the replay before any write', async () => {
  const store = await pendingStore();
  const digest = await shownDigest(store);
  store.source = { ...store.source, body: `${body}\nEdited after the answer.` };
  const result = await runProvisionalResolution(
    resolveRequest({
      input: conversationYes,
      answeredPresentationSha256: digest,
    }),
    store,
    { apply: true },
  );
  assertRefused(result, 'recovery-hold', /source-binding-mismatch/);
  assert.equal(store.writes(), 0);
});

test('a changed verified result after the presentation holds before any write', async () => {
  const store = await pendingStore();
  const digest = await shownDigest(store);
  const [pullUrl] = [...store.pullRequests.keys()];
  assert.ok(pullUrl);
  store.pullRequests.set(pullUrl, {
    state: 'merged',
    headSha: 'f'.repeat(40),
    mergeCommitSha: 'e'.repeat(40),
    requiredChecksPassing: true,
  });
  const result = await runProvisionalResolution(
    resolveRequest({
      input: conversationYes,
      answeredPresentationSha256: digest,
    }),
    store,
    { apply: true },
  );
  assertRefused(
    result,
    'recovery-hold',
    /historical pull request verification failed/,
  );
  assert.equal(store.writes(), 0);
});

function craftedAnswer(
  store: MemoryStore,
  edit: (answer: Record<string, unknown>) => void,
): string {
  const record = recordsOf(store).find(
    (item) => item.event.type === 'work-completed',
  ) as ProvisionalDecisionRecord;
  const selection = recordsOf(store).find(
    (item) => item.event.type === 'selected',
  ) as ProvisionalDecisionRecord;
  const answer: Record<string, unknown> = {
    schemaVersion: 1,
    source: sourceOf(store),
    bundleGeneration: 1,
    decisionGenerations: [1],
    claimIds: [implClaim, 'claim-4536-coord'],
    presentedBundle: [
      {
        decisionGeneration: 1,
        question: selection.event.question,
        selectedOptionId: 'keep',
        feasibleAlternativeIds: ['change'],
        workCompletedRecordId: record.recordId,
        result: record.event.result,
      },
    ],
    response: 'accepted',
    presentedQuestion: PROVISIONAL_CONFIRMATION_QUESTION,
    answerText: 'Yes, I accept.',
  };
  edit(answer);
  return `${PROVISIONAL_DECISION_ANSWER_MARKER}\n${JSON.stringify(answer)}`;
}

test('a partial or stale earlier answer is ignored and grants no confirmation', async (t) => {
  const stale: [string, (answer: Record<string, unknown>) => void][] = [
    [
      'partial bundle',
      (answer) => {
        answer.presentedBundle = [];
      },
    ],
    [
      'an unknown decision',
      (answer) => {
        answer.decisionGenerations = [1, 2];
      },
    ],
    [
      'a different result',
      (answer) => {
        const [entry] = answer.presentedBundle as {
          result: Record<string, unknown>;
        }[];
        assert.ok(entry);
        entry.result = {
          kind: 'other',
          reference: 'https://example.com/other',
          verifiedAt: '2026-11-03T11:00:00Z',
        };
      },
    ],
    [
      'another claim lineage',
      (answer) => {
        answer.claimIds = ['claim-other'];
      },
    ],
    [
      'a changed source',
      (answer) => {
        (
          answer.source as { snapshot: { bodySha256: string } }
        ).snapshot.bodySha256 = 'a'.repeat(64);
      },
    ],
  ];
  for (const [name, edit] of stale) {
    await t.test(name, async () => {
      const store = await pendingStore();
      store.addComment(() => craftedAnswer(store, edit));
      const answersBefore = answersOf(store).length;
      // With no input the stale answer does not confirm.
      const pendingRun = await answered(store, null);
      assert.equal(
        pendingRun.outcome,
        'pending-released',
        JSON.stringify(pendingRun),
      );
      assert.equal(eventsOf(store).includes('confirmed'), false);
      assert.equal(answersOf(store).length, answersBefore);
    });
  }
});

test('a stale earlier answer does not stop a fresh actual answer from confirming', async () => {
  const store = await pendingStore();
  store.addComment(() =>
    craftedAnswer(store, (answer) => {
      answer.claimIds = ['claim-other'];
    }),
  );
  const result = await answered(store, conversationYes);
  assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
  const [stale, fresh] = answersOf(store);
  assert.deepEqual(stale?.answer.claimIds, ['claim-other']);
  const record = recordsOf(store).find(
    (item) => item.event.type === 'confirmed',
  );
  const confirmation = record?.event.confirmation as
    | { commentUrl: string }
    | undefined;
  assert.equal(confirmation?.commentUrl, fresh?.comment.url);
});

function danglingReworkAnswer(answer: Record<string, unknown>): void {
  answer.response = 'rework';
  answer.requestedOptionId = 'change';
  answer.rationale = 'Revise this comparison.';
  answer.answerText = 'I prefer the alternative.';
}

const terminalNo: ConfirmationInput = {
  channel: 'terminal',
  origin: 'user',
  interactive: true,
  event: { kind: 'line', text: 'n' },
};

test('a persisted valid answer resumes unattended and agrees with a matching input', async (t) => {
  await t.test('no input', async () => {
    const store = await pendingStore();
    store.addComment(() => craftedAnswer(store, () => {}));
    const result = await runProvisionalResolution(resolveRequest(), store, {
      apply: true,
    });
    assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
    assert.equal(answersOf(store).length, 1);
    assert.equal(result.steps.includes('append-answer'), false);
  });

  await t.test('the same acceptance as input', async () => {
    const store = await pendingStore();
    store.addComment(() => craftedAnswer(store, () => {}));
    const result = await answered(store, conversationYes);
    assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
    assert.equal(answersOf(store).length, 1);
  });

  await t.test(
    'input that is not from the user is not a conflict',
    async () => {
      const store = await pendingStore();
      store.addComment(() => craftedAnswer(store, () => {}));
      const result = await answered(store, {
        channel: 'terminal',
        origin: 'tool',
        interactive: true,
        event: { kind: 'line', text: 'n' },
      });
      assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
    },
  );

  await t.test('a persisted rework answer resumes the handoff', async () => {
    const store = await pendingStore();
    store.addComment(() =>
      craftedAnswer(store, (answer) => {
        danglingReworkAnswer(answer);
        answer.appliesToDecisionGenerations = [1];
      }),
    );
    const result = await answered(store, reworkConversation);
    assert.equal(
      result.outcome,
      'rework-handoff-recorded',
      JSON.stringify(result),
    );
    assert.equal(store.sourceState.state, 'open');
  });
});

test('an explicit input that conflicts with a persisted answer is refused, not overridden', async (t) => {
  const conflicts: [string, ConfirmationInput][] = [
    ['an explicit N', terminalNo],
    [
      'Enter',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'line', text: '' },
      },
    ],
    [
      'EOF',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'eof' },
      },
    ],
    [
      'cancellation',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'cancelled' },
      },
    ],
    ['an alternate option', reworkConversation],
  ];
  for (const [name, input] of conflicts) {
    await t.test(name, async () => {
      const store = await pendingStore();
      store.addComment(() => craftedAnswer(store, () => {}));
      const result = await runProvisionalResolution(
        resolveRequest({ input }),
        store,
        { apply: true },
      );
      assertRefused(result, 'fix-input', /conflicts with it/);
      assert.equal(store.writes(), 0);
      assert.equal(eventsOf(store).includes('confirmed'), false);
      assert.equal(store.sourceState.state, 'open');
      assert.equal(activeCoordinationClaim(store), true);
    });
  }

  await t.test('a persisted rework answer and an acceptance', async () => {
    const store = await pendingStore();
    store.addComment(() =>
      craftedAnswer(store, (answer) => {
        danglingReworkAnswer(answer);
        answer.appliesToDecisionGenerations = [1];
      }),
    );
    const result = await runProvisionalResolution(
      resolveRequest({ input: conversationYes }),
      store,
      { apply: true },
    );
    assertRefused(result, 'fix-input', /conflicts with it/);
    assert.equal(store.writes(), 0);
  });
});

test('an earlier answer without the presented question is not adopted', async () => {
  const store = await pendingStore();
  store.addComment(() =>
    craftedAnswer(store, (answer) => {
      delete answer.presentedQuestion;
    }),
  );
  const result = await answered(store, null);
  assert.equal(result.outcome, 'pending-released', JSON.stringify(result));
  assert.equal(eventsOf(store).includes('confirmed'), false);
});

test('the answer comment shows a readable note before its JSON', async () => {
  const store = await pendingStore();
  await answered(store, conversationYes);
  const comment = answersOf(store)[0]?.comment;
  assert.ok(comment);
  const lines = comment.body.split('\n');
  assert.equal(lines[0], PROVISIONAL_DECISION_ANSWER_MARKER);
  assert.equal(lines[1], PROVISIONAL_DECISION_ANSWER_NOTE);
  assert.equal(parseProvisionalDecisionAnswerComment(comment.body).ok, true);

  // The note is optional, and nothing else may stand between marker and JSON.
  const json = lines.slice(2).join('\n');
  const legacy = `${PROVISIONAL_DECISION_ANSWER_MARKER}\n${json}`;
  assert.equal(parseProvisionalDecisionAnswerComment(legacy).ok, true);
  const prose = `${PROVISIONAL_DECISION_ANSWER_MARKER}\nplain text\n${json}`;
  assert.equal(parseProvisionalDecisionAnswerComment(prose).ok, false);
  const twice = `${PROVISIONAL_DECISION_ANSWER_MARKER}\n${PROVISIONAL_DECISION_ANSWER_NOTE}\n${PROVISIONAL_DECISION_ANSWER_NOTE}\n${json}`;
  assert.equal(parseProvisionalDecisionAnswerComment(twice).ok, false);
  const bare = `${PROVISIONAL_DECISION_ANSWER_MARKER}\n${PROVISIONAL_DECISION_ANSWER_NOTE}\n`;
  assert.equal(parseProvisionalDecisionAnswerComment(bare).ok, false);
});

test('an untrusted or edited record or answer grants nothing', async (t) => {
  await t.test(
    'a trusted confirmation citing an untrusted answer holds',
    async () => {
      const store = await pendingStore();
      const answer = store.addComment(
        () => craftedAnswer(store, () => {}),
        undefined,
        {
          authorLogin: 'someone-else',
          trustedAuthor: false,
        },
      );
      const completed = recordsOf(store).find(
        (item) => item.event.type === 'work-completed',
      ) as ProvisionalDecisionRecord;
      const forged = {
        ...completed,
        recordId: 'prov-forged-confirmed',
        claimLineage: [
          ...completed.claimLineage,
          {
            claimId: 'claim-4536-coord',
            agentId: coordAgent,
            branch: coordBranch,
            supersedes: 'none',
            claimedAt: store.history.comments.find((comment) =>
              comment.body.includes('claim-4536-coord'),
            )?.createdAt,
          },
        ],
        event: {
          type: 'confirmed',
          confirmation: {
            commentUrl: answer.url,
            response: 'accepted',
            confirmedAt: answer.createdAt,
          },
        },
      };
      store.addComment(
        () =>
          `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(forged)}`,
      );
      const result = await runProvisionalResolution(resolveRequest(), store, {
        apply: true,
      });
      assertRefused(result, 'recovery-hold', /confirmation-answer-untrusted/);
      assert.equal(store.writes(), 0);
      assert.equal(store.sourceState.state, 'open');
    },
  );

  await t.test('an untrusted record comment is ignored', async () => {
    const store = await pendingStore();
    const completed = recordsOf(store).find(
      (item) => item.event.type === 'work-completed',
    ) as ProvisionalDecisionRecord;
    store.addComment(
      () =>
        `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify({ ...completed, recordId: 'prov-forged' })}`,
      undefined,
      { authorLogin: 'someone-else', trustedAuthor: false },
    );
    const result = await answered(store, null);
    assert.equal(result.outcome, 'pending-released', JSON.stringify(result));
  });

  await t.test('an edited answer is ignored', async () => {
    const store = await pendingStore();
    store.addComment(() => craftedAnswer(store, () => {}), undefined, {
      edited: true,
    });
    const result = await answered(store, null);
    assert.equal(result.outcome, 'pending-released', JSON.stringify(result));
    assert.equal(eventsOf(store).includes('confirmed'), false);
  });

  await t.test('an edited record holds the replay', async () => {
    const store = await pendingStore();
    const comment = store.history.comments.find((item) => {
      const parsed = parseProvisionalDecisionRecordComment(item.body);
      return parsed.ok && parsed.record.event.type === 'work-started';
    });
    assert.ok(comment);
    store.replaceComment(comment.id, { edited: true });
    const result = await runProvisionalResolution(resolveRequest(), store);
    assertRefused(result, 'recovery-hold', /record-authority-invalid/);
  });
});

// ---------------------------------------------------------------------------
// Several decisions
// ---------------------------------------------------------------------------

test('one answer can confirm every decision of a bundle, then close once', async () => {
  const store = await pendingStore(2);
  const result = await answered(store, conversationYes, {
    decisionGenerations: [1, 2],
  });
  assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
  assert.deepEqual(result.steps, [
    'append-answer',
    'append-confirmation',
    'append-confirmation',
    'close-source',
    'release-claim',
  ]);
  assert.equal(answersOf(store).length, 1);
  assert.deepEqual(answersOf(store)[0]?.answer.decisionGenerations, [1, 2]);
  assert.equal(
    eventsOf(store).filter((type) => type === 'confirmed').length,
    2,
  );
  assert.equal(store.closes, 1);
});

test('confirming only some decisions leaves the source open', async () => {
  const store = await pendingStore(2);
  const first = await answered(store, conversationYes, {
    decisionGenerations: [1],
  });
  assert.equal(first.state, 'applied', JSON.stringify(first));
  assert.equal(first.outcome, 'pending-released');
  assert.deepEqual(first.steps, [
    'append-answer',
    'append-confirmation',
    'release-claim',
  ]);
  assert.equal(store.sourceState.state, 'open');
  assert.equal(store.closes, 0);

  // A later review under a new coordination claim finishes the bundle.
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const second = await answered(
    store,
    conversationYes,
    { decisionGenerations: [2] },
    'claim-4536-coord-b',
  );
  assert.equal(second.outcome, 'confirmed-closed', JSON.stringify(second));
  assert.equal(store.sourceState.state, 'closed');
  assert.equal(answersOf(store).length, 2);
});

test('an alternate option for one decision is not an answer for the other', async () => {
  const store = await pendingStore(2);
  const accepted = await answered(store, conversationYes, {
    decisionGenerations: [1],
  });
  assert.equal(accepted.outcome, 'pending-released', JSON.stringify(accepted));
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const rework = await answered(
    store,
    reworkConversation,
    { decisionGenerations: [2] },
    'claim-4536-coord-b',
  );
  assert.equal(
    rework.outcome,
    'rework-handoff-recorded',
    JSON.stringify(rework),
  );
  assert.equal(store.sourceState.state, 'open');
  assert.deepEqual(
    recordsOf(store)
      .filter((record) =>
        ['confirmed', 'rework-requested'].includes(String(record.event.type)),
      )
      .map((record) => `${record.decisionGeneration}:${record.event.type}`),
    ['1:confirmed', '2:rework-requested'],
  );
});

test('an alternate preference applies to exactly one decision per answer', async () => {
  const store = await pendingStore(2);
  const result = await answered(store, reworkConversation, {
    decisionGenerations: [1, 2],
  });
  assertRefused(result, 'fix-input', /exactly one decision/);
  assert.equal(store.writes(), 0);
});

// ---------------------------------------------------------------------------
// Alternate preference and the rework handoff
// ---------------------------------------------------------------------------

function handoffOf(store: MemoryStore): ProvisionalReworkHandoff {
  const record = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  ) as ProvisionalDecisionRecord;
  return (record.event.reworkRequest as { handoff: ProvisionalReworkHandoff })
    .handoff;
}

test('another selected option persists one handoff, releases the claim, and keeps the source open', async () => {
  const store = await pendingStore();
  const result = await answered(store, reworkConversation, {
    downstreamResults: ['https://github.com/kurone-kito/idd-skill/pull/5999'],
  });
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.outcome, 'rework-handoff-recorded');
  assert.deepEqual(result.steps, [
    'append-answer',
    'append-rework-request',
    'release-claim',
  ]);
  assert.equal(store.sourceState.state, 'open');
  assert.equal(store.closes, 0);
  assert.equal(eventsOf(store).includes('confirmed'), false);
  assert.equal(activeCoordinationClaim(store), false);

  const stored = answersOf(store)[0];
  assert.equal(stored?.answer.response, 'rework');
  assert.equal(stored?.answer.requestedOptionId, 'change');
  assert.equal(stored?.answer.rationale, 'Revise this comparison.');
  assert.equal(stored?.answer.answerText, 'I prefer the alternative option.');

  const request = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  ) as ProvisionalDecisionRecord;
  const rework = request.event.reworkRequest as {
    requestedOptionId: string;
    commentUrl: string;
  };
  assert.equal(rework.requestedOptionId, 'change');
  assert.equal(rework.commentUrl, stored?.comment.url);
  const handoff = handoffOf(store);
  assert.match(handoff.handoffId, /^handoff-[0-9a-f]{32}$/);
  assert.match(handoff.authoringSetId, /^set-[0-9a-f-]{36}$/);
  assert.match(handoff.authoringSessionId, /^session-[0-9a-f-]{36}$/);
  assert.equal(handoff.anchor, `${repository}#${issueNumber}`);
  assert.deepEqual(
    handoff.priorResults.map((entry) => entry.decisionGeneration),
    [1],
  );
  assert.match(handoff.priorResults[0]?.reference ?? '', /\/pull\/6000$/);
  assert.deepEqual(handoff.downstreamResults, [
    'https://github.com/kurone-kito/idd-skill/pull/5999',
  ]);
  // The prior choices stay: the selected and completed records are unchanged.
  assert.deepEqual(
    eventsOf(store).filter((type) => type !== 'rework-requested'),
    ['selected', 'work-started', 'work-completed'],
  );
});

test('the handoff identity is stable and grants no publication permission', async () => {
  const first = await pendingStore();
  await answered(first, reworkConversation);
  const second = await pendingStore();
  await answered(second, reworkConversation);
  const one = handoffOf(first);
  const two = handoffOf(second);
  assert.equal(one.handoffId, two.handoffId);
  assert.equal(one.authoringSetId, two.authoringSetId);
  assert.equal(one.authoringSessionId, two.authoringSessionId);
  // The record carries identities only: no authoring owner, label, or child.
  assert.deepEqual(Object.keys(one).sort(), [
    'anchor',
    'authoringSessionId',
    'authoringSetId',
    'downstreamResults',
    'handoffId',
    'priorResults',
  ]);
});

test('the same request cannot produce another handoff, set, or confirmation', async () => {
  const store = await pendingStore();
  await answered(store, reworkConversation);
  const handoff = handoffOf(store);
  const records = eventsOf(store).length;
  const answers = answersOf(store).length;

  // The claim is released, so the same request has nothing to write.
  const same = await runProvisionalResolution(
    resolveRequest({ input: reworkConversation }),
    store,
    { apply: true },
  );
  assert.equal(same.state, 'reconciled', JSON.stringify(same));
  assert.deepEqual(same.steps, []);

  // A new claim that tries to confirm instead cannot erase the choice.
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const writesBefore = store.writes();
  const confirm = await runProvisionalResolution(
    resolveRequest(
      { input: conversationYes, answeredPresentationSha256: 'x' },
      'claim-4536-coord-b',
    ),
    store,
    { apply: true },
  );
  assertRefused(confirm, 'fix-input', /conflicts with it/);
  assert.equal(store.writes(), writesBefore);
  assert.equal(eventsOf(store).length, records);
  assert.equal(answersOf(store).length, answers);
  assert.equal(store.sourceState.state, 'open');

  // Resuming without an input only releases the new claim.
  const resume = await runProvisionalResolution(
    resolveRequest({}, 'claim-4536-coord-b'),
    store,
    { apply: true },
  );
  assert.equal(
    resume.outcome,
    'rework-handoff-recorded',
    JSON.stringify(resume),
  );
  assert.deepEqual(resume.steps, ['release-claim']);
  assert.equal(eventsOf(store).length, records);
  assert.equal(answersOf(store).length, answers);
  assert.deepEqual(handoffOf(store), handoff);
});

test('an alternative that was not recorded is not a rework request', async () => {
  const store = await pendingStore();
  const result = await answered(store, {
    ...reworkConversation,
    interpretation: {
      response: 'rework',
      requestedOptionId: 'invented',
      rationale: 'Because.',
    },
  } as ConfirmationInput);
  assert.equal(result.outcome, 'pending-released', JSON.stringify(result));
  assert.equal(eventsOf(store).includes('rework-requested'), false);
});

test('a failed handoff write keeps the coordination claim and a retry reuses the answer', async () => {
  const store = await pendingStore();
  store.recordFailure = (type) =>
    type === 'rework-requested' ? 'before' : undefined;
  const first = await answered(store, reworkConversation);
  assertRefused(
    first,
    'recovery-hold',
    /append-rework-request write is uncertain/,
  );
  assert.equal(store.releases, 0);
  assert.equal(activeCoordinationClaim(store), true);
  assert.equal(eventsOf(store).includes('rework-requested'), false);
  assert.equal(answersOf(store).length, 1);

  store.recordFailure = undefined;
  const retry = await runProvisionalResolution(resolveRequest(), store, {
    apply: true,
  });
  assert.equal(retry.outcome, 'rework-handoff-recorded', JSON.stringify(retry));
  assert.deepEqual(retry.steps, ['append-rework-request', 'release-claim']);
  assert.equal(answersOf(store).length, 1);
});

test('a persisted handoff with an uncertain unclaim reconciles the same release', async () => {
  const store = await pendingStore();
  store.releaseFailure = 'before';
  const first = await answered(store, reworkConversation);
  assert.equal(first.state, 'reconciled', JSON.stringify(first));
  assert.deepEqual(first.steps, ['append-answer', 'append-rework-request']);
  assert.equal(activeCoordinationClaim(store), true);
  const handoff = handoffOf(store);

  store.releaseFailure = undefined;
  const records = eventsOf(store).length;
  const answers = answersOf(store).length;
  const retry = await runProvisionalResolution(resolveRequest(), store, {
    apply: true,
  });
  assert.equal(retry.state, 'applied', JSON.stringify(retry));
  assert.deepEqual(retry.steps, ['release-claim']);
  assert.equal(eventsOf(store).length, records);
  assert.equal(answersOf(store).length, answers);
  assert.deepEqual(handoffOf(store), handoff);
});

// ---------------------------------------------------------------------------
// Rework authored
// ---------------------------------------------------------------------------

const roadmapBody = `${body}\n\n## Tracks\n\n- [ ] #5001 — first child`;

interface AuthoredFixture {
  readonly store: MemoryStore;
  readonly handoff: ProvisionalReworkHandoff;
  readonly publishedAt: string;
  readonly publishedId: string;
}

async function authoredFixture(): Promise<AuthoredFixture> {
  const store = await pendingStore();
  const result = await answered(store, reworkConversation);
  assert.equal(
    result.outcome,
    'rework-handoff-recorded',
    JSON.stringify(result),
  );
  const handoff = handoffOf(store);
  // The authoring pass rewrites the source and records its publication.
  store.source = { ...store.source, body: roadmapBody };
  const published = store.addComment(() => 'Rework roadmap published.');
  return {
    store,
    handoff,
    publishedAt: published.createdAt,
    publishedId: published.id,
  };
}

function authoring(
  fixture: AuthoredFixture,
  overrides: Partial<ProvisionalReworkAuthoringEvidence> = {},
): ProvisionalReworkAuthoringEvidence {
  return {
    owner: {
      trusted: true,
      fresh: true,
      setId: fixture.handoff.authoringSetId,
      sessionId: fixture.handoff.authoringSessionId,
      anchor: fixture.handoff.anchor,
    },
    roadmap: {
      audited: true,
      issueNumber,
      markerId: 'roadmap-rework-4536',
      url: issueUrl,
      publishedCommentId: fixture.publishedId,
      publishedAt: fixture.publishedAt,
    },
    children: [{ issueNumber: 5001, wired: true }],
    ...overrides,
  };
}

function authoredRequest(
  fixture: AuthoredFixture,
  evidence: ProvisionalReworkAuthoringEvidence = authoring(fixture),
): ProvisionalResolutionRequest {
  return {
    type: 'rework-authored',
    repository,
    issueNumber,
    claimId: 'claim-4536-coord',
    agentId: coordAgent,
    branch: coordBranch,
    verifiedReworkRoadmaps: [],
    authoring: evidence,
  };
}

test('rework-authored records only with verified ownership, roadmap, and children', async () => {
  const fixture = await authoredFixture();
  const { store } = fixture;
  const releasesBefore = store.releases;
  const labelsBefore = store.labelCalls;
  const dry = await runProvisionalResolution(authoredRequest(fixture), store);
  assert.equal(dry.state, 'planned', JSON.stringify(dry));
  assert.equal(dry.nextStep, 'append-rework-authored');
  assert.equal(eventsOf(store).includes('rework-authored'), false);

  const result = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.outcome, 'rework-authored');
  assert.deepEqual(result.steps, ['append-rework-authored']);
  const authored = recordsOf(store).find(
    (item) => item.event.type === 'rework-authored',
  ) as ProvisionalDecisionRecord;
  assert.equal(
    (authored.event.reworkRoadmap as { authoringSetId: string }).authoringSetId,
    fixture.handoff.authoringSetId,
  );
  assert.equal(authored.source.snapshot.bodySha256, sha256(roadmapBody));
  // It never releases the authoring hold or touches a label or the claim.
  assert.equal(store.releases, releasesBefore);
  assert.equal(store.labelCalls, labelsBefore);
  assert.equal(store.closes, 0);
  assert.equal(store.sourceState.state, 'open');

  // A rerun with the same evidence is reconciled and writes nothing.
  const writes = store.writes();
  const rerun = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  assert.equal(rerun.state, 'reconciled', JSON.stringify(rerun));
  assert.equal(rerun.outcome, 'rework-authored');
  assert.equal(store.writes(), writes);
});

test('unknown ownership or wiring refuses the terminal transition', async (t) => {
  const cases: [
    string,
    (fixture: AuthoredFixture) => ProvisionalReworkAuthoringEvidence,
    RegExp,
  ][] = [
    [
      'an untrusted owner',
      (fixture) => {
        const base = authoring(fixture);
        return { ...base, owner: { ...base.owner, trusted: false } };
      },
      /not verified as trusted and fresh/,
    ],
    [
      'a stale owner',
      (fixture) => {
        const base = authoring(fixture);
        return { ...base, owner: { ...base.owner, fresh: false } };
      },
      /not verified as trusted and fresh/,
    ],
    [
      'a different authoring set',
      (fixture) => {
        const base = authoring(fixture);
        return { ...base, owner: { ...base.owner, setId: 'set-another' } };
      },
      /does not match the recorded handoff/,
    ],
    [
      'a different session',
      (fixture) => {
        const base = authoring(fixture);
        return { ...base, owner: { ...base.owner, sessionId: 'session-x' } };
      },
      /does not match the recorded handoff/,
    ],
    [
      'a different anchor',
      (fixture) => {
        const base = authoring(fixture);
        return { ...base, owner: { ...base.owner, anchor: 'a/b#9' } };
      },
      /does not match the recorded handoff/,
    ],
    [
      'an unaudited roadmap',
      (fixture) => {
        const base = authoring(fixture);
        return { ...base, roadmap: { ...base.roadmap, audited: false } };
      },
      /not an audited rework roadmap/,
    ],
    [
      'another issue as the roadmap',
      (fixture) => {
        const base = authoring(fixture);
        return { ...base, roadmap: { ...base.roadmap, issueNumber: 1 } };
      },
      /not an audited rework roadmap/,
    ],
    [
      'no children',
      (fixture) => ({ ...authoring(fixture), children: [] }),
      /children are not real/,
    ],
    [
      'an unwired child',
      (fixture) => ({
        ...authoring(fixture),
        children: [{ issueNumber: 5001, wired: false }],
      }),
      /children are not real/,
    ],
    [
      'the source as its own child',
      (fixture) => ({
        ...authoring(fixture),
        children: [{ issueNumber, wired: true }],
      }),
      /children are not real/,
    ],
    [
      'a duplicated child',
      (fixture) => ({
        ...authoring(fixture),
        children: [
          { issueNumber: 5001, wired: true },
          { issueNumber: 5001, wired: true },
        ],
      }),
      /children are not real/,
    ],
    [
      'a publication comment that does not exist',
      (fixture) => {
        const base = authoring(fixture);
        return {
          ...base,
          roadmap: { ...base.roadmap, publishedCommentId: '424242' },
        };
      },
      /authoring evidence does not verify/,
    ],
  ];
  for (const [name, build, reason] of cases) {
    await t.test(name, async () => {
      const fixture = await authoredFixture();
      const writes = fixture.store.writes();
      const result = await runProvisionalResolution(
        authoredRequest(fixture, build(fixture)),
        fixture.store,
        { apply: true },
      );
      assertRefused(result, 'fix-input', reason);
      assert.equal(fixture.store.writes(), writes);
      assert.equal(eventsOf(fixture.store).includes('rework-authored'), false);
    });
  }
});

test('rework-authored waits for the coordination claim release', async () => {
  const fixture = await authoredFixture();
  postCoordinationClaim(fixture.store, 'claim-4536-coord-b');
  const result = await runProvisionalResolution(
    authoredRequest(fixture),
    fixture.store,
    { apply: true },
  );
  assertRefused(result, 'fix-input', /still active/);
});

test('rework-authored needs a rework request with a recorded handoff', async () => {
  const store = await pendingStore();
  const fixture: AuthoredFixture = {
    store,
    handoff: {
      handoffId: 'h',
      authoringSetId: 'set-x',
      authoringSessionId: 'session-x',
      anchor: `${repository}#${issueNumber}`,
      priorResults: [],
      downstreamResults: [],
    },
    publishedAt: '2026-11-03T11:00:00Z',
    publishedId: '1',
  };
  releaseImplementation(store);
  store.addComment((at) =>
    renderUnclaimedByMarker({
      agentId: coordAgent,
      claimId: 'claim-4536-coord',
      timestamp: at,
    }),
  );
  const result = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  assertRefused(result, 'none', /no rework request is waiting/);
});

// ---------------------------------------------------------------------------
// Handoff replay rules and schemas
// ---------------------------------------------------------------------------

function replayOf(
  store: MemoryStore,
  evidence: VerifiedProvisionalReworkRoadmap[] = [],
) {
  const lineage = store.history.comments.flatMap((comment) => {
    const claim = parseClaimComment(comment.body, comment.createdAt);
    return claim
      ? [
          {
            claimId: claim.claimId,
            agentId: claim.agentId,
            branch: claim.branch,
            claimedAt: comment.createdAt,
            supersedes: 'none',
            commentId: comment.id,
          },
        ]
      : [];
  });
  const work = recordsOf(store)
    .filter((record) => record.event.type === 'work-completed')
    .map((record) => {
      const result = record.event.result as Record<string, string>;
      return {
        source: record.source,
        bundleGeneration: record.bundleGeneration,
        decisionGeneration: record.decisionGeneration,
        reference: result.reference as string,
        verifiedAt: result.verifiedAt as string,
        headSha: result.headSha,
        mergeCommitSha: result.mergeCommitSha,
        executionCriteriaSatisfied: true,
      };
    });
  return replayProvisionalDecisionHistory({
    comments: store.history.comments,
    completeHistory: true,
    currentSource: sourceOf(store),
    verifiedClaimLineage: lineage,
    verifiedWork: work,
    verifiedReworkRoadmaps: evidence,
  });
}

function tamperRework(
  store: MemoryStore,
  edit: (handoff: Record<string, unknown>) => void,
): void {
  const comment = store.history.comments.find((item) => {
    const parsed = parseProvisionalDecisionRecordComment(item.body);
    return parsed.ok && parsed.record.event.type === 'rework-requested';
  });
  assert.ok(comment);
  const record = JSON.parse(
    comment.body.slice(PROVISIONAL_DECISION_RECORD_MARKER.length + 1),
  ) as { event: { reworkRequest: { handoff: Record<string, unknown> } } };
  edit(record.event.reworkRequest.handoff);
  store.replaceComment(comment.id, {
    body: `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(record)}`,
  });
}

test('replay accepts the recorded handoff and refuses a tampered one', async (t) => {
  await t.test('the recorded handoff replays', async () => {
    const store = await pendingStore();
    await answered(store, reworkConversation);
    const replay = replayOf(store);
    assert.equal(replay.valid, true, JSON.stringify(replay.issues));
    assert.equal(replay.status, 'rework-requested');
  });

  const cases: [string, (handoff: Record<string, unknown>) => void, string][] =
    [
      [
        'a wrong anchor',
        (handoff) => {
          handoff.anchor = 'someone/else#1';
        },
        'rework-handoff-anchor-invalid',
      ],
      [
        'prior results that do not match the bundle',
        (handoff) => {
          handoff.priorResults = [
            {
              decisionGeneration: 1,
              workCompletedRecordId: 'prov-other',
              reference: 'https://example.com/pr/1',
            },
          ];
        },
        'rework-handoff-results-mismatch',
      ],
      [
        'a malformed identity',
        (handoff) => {
          handoff.authoringSetId = 'has space';
        },
        'handoff-id-invalid',
      ],
      [
        'a malformed anchor',
        (handoff) => {
          handoff.anchor = 'not-an-anchor';
        },
        'handoff-anchor-invalid',
      ],
      [
        'no prior results',
        (handoff) => {
          handoff.priorResults = [];
        },
        'handoff-prior-results-required',
      ],
      [
        'a bad downstream reference',
        (handoff) => {
          handoff.downstreamResults = ['not a url'];
        },
        'url-required',
      ],
      [
        'an extra field',
        (handoff) => {
          handoff.permissionToPublish = true;
        },
        'unexpected-field',
      ],
    ];
  for (const [name, edit, code] of cases) {
    await t.test(name, async () => {
      const store = await pendingStore();
      await answered(store, reworkConversation);
      tamperRework(store, edit);
      const replay = replayOf(store);
      assert.equal(replay.valid, false);
      assert.ok(
        replay.issues.some((issue) => issue.code === code),
        JSON.stringify(replay.issues),
      );
    });
  }
});

test('every rework request of one bundle carries one handoff identity', async () => {
  // Decision 1 is confirmed in a first review so decision 2 can be reworked
  // under its own answer; a conflicting handoff on a second request is refused.
  const store = await pendingStore(2);
  // Both decisions request rework in two separate answers.
  const first = await answered(store, reworkConversation, {
    decisionGenerations: [1],
  });
  assert.equal(first.outcome, 'rework-handoff-recorded', JSON.stringify(first));
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const second = await answered(
    store,
    reworkConversation,
    { decisionGenerations: [2] },
    'claim-4536-coord-b',
  );
  assert.equal(
    second.outcome,
    'rework-handoff-recorded',
    JSON.stringify(second),
  );
  // The second request reused the first handoff identity.
  const handoffs = recordsOf(store)
    .filter((record) => record.event.type === 'rework-requested')
    .map(
      (record) =>
        (record.event.reworkRequest as { handoff: ProvisionalReworkHandoff })
          .handoff,
    );
  assert.equal(handoffs.length, 2);
  assert.equal(handoffs[0]?.handoffId, handoffs[1]?.handoffId);
  assert.equal(handoffs[0]?.authoringSetId, handoffs[1]?.authoringSetId);
  // A tampered second identity is a conflict.
  const comments = store.history.comments.filter((item) => {
    const parsed = parseProvisionalDecisionRecordComment(item.body);
    return parsed.ok && parsed.record.event.type === 'rework-requested';
  });
  const target = comments[1];
  assert.ok(target);
  const record = JSON.parse(
    target.body.slice(PROVISIONAL_DECISION_RECORD_MARKER.length + 1),
  ) as { event: { reworkRequest: { handoff: Record<string, unknown> } } };
  record.event.reworkRequest.handoff.authoringSetId = 'set-another-identity';
  store.replaceComment(target.id, {
    body: `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(record)}`,
  });
  const replay = replayOf(store);
  assert.equal(replay.valid, false);
  assert.ok(
    replay.issues.some((issue) => issue.code === 'rework-handoff-conflict'),
    JSON.stringify(replay.issues),
  );
});

test('a rework-authored record must use the set preallocated by its handoff', async () => {
  const fixture = await authoredFixture();
  const { store } = fixture;
  // Record authoring with a different set than the handoff preallocated: the
  // command refuses it, and so does replay when a record is forged directly.
  const forgedAuthoring = authoring(fixture, {
    owner: {
      trusted: true,
      fresh: true,
      setId: 'set-not-the-handoff',
      sessionId: fixture.handoff.authoringSessionId,
      anchor: fixture.handoff.anchor,
    },
  });
  const refused = await runProvisionalResolution(
    authoredRequest(fixture, forgedAuthoring),
    store,
    { apply: true },
  );
  assertRefused(refused, 'fix-input', /does not match the recorded handoff/);

  const request = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  ) as ProvisionalDecisionRecord;
  const forged: ProvisionalDecisionRecord = {
    ...request,
    recordId: 'prov-forged-authored',
    source: sourceOf(store),
    claimLineage: request.claimLineage,
    event: {
      type: 'rework-authored',
      reworkRoadmap: {
        roadmapIssueNumber: issueNumber,
        roadmapMarkerId: 'roadmap-rework-4536',
        authoringSetId: 'set-not-the-handoff',
        url: issueUrl,
      },
    },
  } as ProvisionalDecisionRecord;
  const added = store.addComment(
    () => `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(forged)}`,
  );
  const replay = replayOf(store, [
    {
      recordId: forged.recordId,
      sourceBefore: request.source,
      sourceAfter: forged.source,
      roadmapIssueNumber: issueNumber,
      roadmapMarkerId: 'roadmap-rework-4536',
      authoringSetId: 'set-not-the-handoff',
      url: issueUrl,
      publishedCommentId: fixture.publishedId,
      publishedAt: fixture.publishedAt,
    },
  ]);
  assert.equal(replay.valid, false, added.id);
  assert.ok(
    replay.issues.some((issue) => issue.code === 'rework-roadmap-unverified'),
    JSON.stringify(replay.issues),
  );
});

test('the record schema accepts the optional handoff and rejects a malformed one', async () => {
  const schema = loadJson('schemas/provisional-decision-record.schema.json');
  const store = await pendingStore();
  await answered(store, reworkConversation);
  const record = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  ) as ProvisionalDecisionRecord;
  assert.deepEqual(validate(record, schema), []);

  const clone = () =>
    JSON.parse(JSON.stringify(record)) as {
      event: { reworkRequest: { handoff?: Record<string, unknown> } };
    };
  const withoutHandoff = clone();
  delete withoutHandoff.event.reworkRequest.handoff;
  assert.deepEqual(validate(withoutHandoff, schema), []);

  const handoffOf2 = (value: ReturnType<typeof clone>) => {
    assert.ok(value.event.reworkRequest.handoff);
    return value.event.reworkRequest.handoff;
  };
  const mutations: ((value: ReturnType<typeof clone>) => void)[] = [
    (value) => {
      delete value.event.reworkRequest.handoff?.priorResults;
    },
    (value) => {
      delete value.event.reworkRequest.handoff?.downstreamResults;
    },
    (value) => {
      handoffOf2(value).anchor = 'not-an-anchor';
    },
    (value) => {
      handoffOf2(value).authoringSetId = 'has space';
    },
    (value) => {
      handoffOf2(value).priorResults = [];
    },
    (value) => {
      handoffOf2(value).extra = true;
    },
  ];
  for (const mutate of mutations) {
    const value = clone();
    mutate(value);
    assert.ok(validate(value, schema).length > 0);
  }
});

test('a plan that changes before the write writes nothing', async () => {
  const store = await pendingStore();
  const digest = await shownDigest(store);
  const before = store.historyReads;
  store.readHook = (readNumber, target) => {
    // The second fresh read of the apply run sees a source edit.
    if (readNumber === before + 2) {
      target.source = { ...target.source, body: `${body}\nEdited mid-run.` };
    }
  };
  const result = await runProvisionalResolution(
    resolveRequest({
      input: conversationYes,
      answeredPresentationSha256: digest,
    }),
    store,
    { apply: true },
  );
  assertRefused(result, 'recovery-hold', /the plan changed before the write/);
  assert.equal(store.writes(), 0);
});

test('a write that is not visible in the next fresh read is a recovery hold', async () => {
  const store = await pendingStore();
  store.answerFailure = 'silent';
  const result = await answered(store, conversationYes);
  assertRefused(result, 'recovery-hold', /append-answer write is not visible/);
  assert.equal(answersOf(store).length, 0);
  assert.equal(activeCoordinationClaim(store), true);
  assert.equal(store.closes, 0);
});

test('a terminal alternate option runs the same handoff lifecycle', async () => {
  const store = await pendingStore();
  const result = await answered(store, {
    channel: 'terminal',
    origin: 'user',
    interactive: true,
    event: { kind: 'line', text: 'option change keep the data format' },
  });
  assert.equal(
    result.outcome,
    'rework-handoff-recorded',
    JSON.stringify(result),
  );
  assert.equal(answersOf(store)[0]?.answer.rationale, 'keep the data format');
});

test('a malformed downstream reference is refused before any write', async () => {
  const store = await pendingStore();
  const result = await answered(store, reworkConversation, {
    downstreamResults: ['not a url'],
  });
  assertRefused(result, 'fix-input', /url-required/);
  assert.equal(store.writes(), 0);
});

test('an answer scoped to other decisions grants no confirmation here', async () => {
  const store = await pendingStore(2);
  const first = await answered(store, conversationYes, {
    decisionGenerations: [1],
  });
  assert.equal(first.outcome, 'pending-released', JSON.stringify(first));
  const stored = answersOf(store)[0];
  assert.deepEqual(stored?.answer.appliesToDecisionGenerations, [1]);

  // A trusted confirmation record for decision 2 that cites that answer is
  // refused by replay, because the answer applies only to decision 1.
  const completed = recordsOf(store).find(
    (item) =>
      item.event.type === 'work-completed' && item.decisionGeneration === 2,
  ) as ProvisionalDecisionRecord;
  const confirmedOne = recordsOf(store).find(
    (item) => item.event.type === 'confirmed',
  ) as ProvisionalDecisionRecord;
  const forged = {
    ...confirmedOne,
    recordId: 'prov-forged-two',
    decisionGeneration: completed.decisionGeneration,
  };
  assert.ok(stored);
  store.addComment(
    () => `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(forged)}`,
  );
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const result = await runProvisionalResolution(
    resolveRequest({ decisionGenerations: [2] }, 'claim-4536-coord-b'),
    store,
  );
  assertRefused(result, 'recovery-hold', /confirmation-scope-mismatch/);
});

test('an answer scope outside its presented bundle is malformed', async () => {
  const store = await pendingStore();
  const comment = store.addComment(() =>
    craftedAnswer(store, (answer) => {
      answer.appliesToDecisionGenerations = [7];
    }),
  );
  assert.equal(parseProvisionalDecisionAnswerComment(comment.body).ok, false);
  const empty = store.addComment(() =>
    craftedAnswer(store, (answer) => {
      answer.appliesToDecisionGenerations = [];
    }),
  );
  assert.equal(parseProvisionalDecisionAnswerComment(empty.body).ok, false);
  const valid = store.addComment(() =>
    craftedAnswer(store, (answer) => {
      answer.appliesToDecisionGenerations = [1];
      answer.presentedQuestion = PROVISIONAL_CONFIRMATION_QUESTION;
    }),
  );
  assert.equal(parseProvisionalDecisionAnswerComment(valid.body).ok, true);
});

test('a handoff never reuses the set of a completed rework', async () => {
  const fixture = await authoredFixture();
  const { store } = fixture;
  const done = await runProvisionalResolution(authoredRequest(fixture), store, {
    apply: true,
  });
  assert.equal(done.outcome, 'rework-authored', JSON.stringify(done));
  const requestOne = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  ) as ProvisionalDecisionRecord;
  const authored = recordsOf(store).find(
    (item) => item.event.type === 'rework-authored',
  ) as ProvisionalDecisionRecord;
  const roadmap = authored.event.reworkRoadmap as Record<string, unknown>;
  const evidence: VerifiedProvisionalReworkRoadmap[] = [
    {
      recordId: authored.recordId,
      sourceBefore: requestOne.source,
      sourceAfter: authored.source,
      roadmapIssueNumber: issueNumber,
      roadmapMarkerId: String(roadmap.roadmapMarkerId),
      authoringSetId: String(roadmap.authoringSetId),
      url: issueUrl,
      publishedCommentId: fixture.publishedId,
      publishedAt: fixture.publishedAt,
    },
  ];

  // A second bundle on the rewritten source, then its own rework request.
  const secondImpl = 'claim-4536-impl-2';
  const secondBranch = 'issue/4536-feat-decisions-second-round';
  store.addComment((at) =>
    renderClaimedByMarker({
      agentId: implAgent,
      claimId: secondImpl,
      supersedes: 'none',
      timestamp: at,
      branch: secondBranch,
    }),
  );
  const evidenceComment = store.addComment(
    () => 'Evidence for the second round.',
  );
  await completeDecision(store, {
    evidenceId: evidenceComment.id,
    pullNumber: 6100,
    claimId: secondImpl,
    branch: secondBranch,
    verifiedReworkRoadmaps: evidence,
  });
  store.addComment((at) =>
    renderUnclaimedByMarker({
      agentId: implAgent,
      claimId: secondImpl,
      timestamp: at,
    }),
  );
  postCoordinationClaim(store, 'claim-4536-coord-c');
  const second = await answered(
    store,
    reworkConversation,
    { verifiedReworkRoadmaps: evidence },
    'claim-4536-coord-c',
  );
  assert.equal(
    second.outcome,
    'rework-handoff-recorded',
    JSON.stringify(second),
  );
  const handoffs = recordsOf(store)
    .filter((record) => record.event.type === 'rework-requested')
    .map(
      (record) =>
        (record.event.reworkRequest as { handoff: ProvisionalReworkHandoff })
          .handoff,
    );
  assert.equal(handoffs.length, 2);
  assert.notEqual(handoffs[1]?.authoringSetId, handoffs[0]?.authoringSetId);
  assert.notEqual(handoffs[1]?.handoffId, handoffs[0]?.handoffId);
  assert.equal(replayOf(store, evidence).valid, true);

  // Forcing the completed set into the second handoff is refused.
  const comment = store.history.comments.filter((item) => {
    const parsed = parseProvisionalDecisionRecordComment(item.body);
    return parsed.ok && parsed.record.event.type === 'rework-requested';
  })[1];
  assert.ok(comment);
  const record = JSON.parse(
    comment.body.slice(PROVISIONAL_DECISION_RECORD_MARKER.length + 1),
  ) as { event: { reworkRequest: { handoff: Record<string, unknown> } } };
  record.event.reworkRequest.handoff.authoringSetId =
    handoffs[0]?.authoringSetId;
  store.replaceComment(comment.id, {
    body: `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(record)}`,
  });
  const replay = replayOf(store, evidence);
  assert.equal(replay.valid, false);
  assert.ok(
    replay.issues.some((issue) => issue.code === 'rework-handoff-set-reused'),
    JSON.stringify(replay.issues),
  );
});

test('the claim marker must name the agent and branch of the request', async (t) => {
  await t.test('a different agent', async () => {
    const store = await pendingStore();
    const result = await runProvisionalResolution(
      resolveRequest({ input: conversationYes, agentId: 'another-agent' }),
      store,
      { apply: true },
    );
    assertRefused(result, 'fix-input', /different agent or branch/);
    assert.equal(store.writes(), 0);
  });

  await t.test('a different branch', async () => {
    const store = await pendingStore();
    const result = await runProvisionalResolution(
      resolveRequest({ input: conversationYes, branch: 'issue/1-other' }),
      store,
      { apply: true },
    );
    assertRefused(result, 'fix-input', /different agent or branch/);
    assert.equal(store.writes(), 0);
  });
});

test('only a source closed as completed counts as a confirmed close', async () => {
  const store = await pendingStore();
  const result = await answered(store, conversationYes);
  assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
  postCoordinationClaim(store, 'claim-4536-coord-b');
  store.sourceState = { state: 'closed', stateReason: 'not_planned' };
  const hold = await runProvisionalResolution(
    resolveRequest({}, 'claim-4536-coord-b'),
    store,
    { apply: true },
  );
  assertRefused(hold, 'recovery-hold', /closed as not_planned, not completed/);
  store.sourceState = { state: 'closed', stateReason: null };
  const unknown = await runProvisionalResolution(
    resolveRequest({}, 'claim-4536-coord-b'),
    store,
  );
  assertRefused(unknown, 'recovery-hold', /an unknown reason/);
});

test('a write that throws is counted only when a fresh read proves it', async () => {
  const store = await pendingStore();
  store.recordFailure = (type) => {
    if (type === 'confirmed') {
      // The source changes while the write fails, so the fresh read refuses.
      store.source = {
        ...store.source,
        body: `${body}\nEdited during the write.`,
      };
      return 'before';
    }
    return undefined;
  };
  const result = await answered(store, conversationYes);
  // The record is not in the fresh history, so the step is not counted.
  assertRefused(
    result,
    'recovery-hold',
    /append-confirmation write is uncertain/,
  );
  assert.deepEqual(result.steps, ['append-answer']);
  assert.equal(result.warnings, undefined);
  assert.equal(activeCoordinationClaim(store), true);
});

test('a frozen server clock keeps the replay order by comment position', async () => {
  const store = await pendingStore();
  const claim = store.history.comments.find((comment) =>
    comment.body.includes('<!-- claimed-by: codex-coordination-agent'),
  );
  assert.ok(claim);
  // Every later comment shares the second of the coordination claim.
  store.serverMs = Date.parse(claim.createdAt);
  store.frozen = true;
  const result = await answered(store, conversationYes);
  assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
  const times = new Set(
    store.history.comments
      .filter((comment) => Number(comment.id) >= 100)
      .map((comment) => comment.createdAt)
      .filter((createdAt) => createdAt === claim.createdAt),
  );
  assert.equal(times.size, 1);
});

test('the result schema accepts a candidate record that carries a handoff', async () => {
  const schema = loadJson('schemas/provisional-decision.schema.json');
  const fixtures = loadJson(
    'tests/fixtures/provisional-decision-results.json',
  ) as { state: string; plan?: { candidateRecord: unknown } }[];
  const planned = fixtures.find((fixture) => fixture.state === 'planned');
  assert.ok(planned?.plan);
  const store = await pendingStore();
  await answered(store, reworkConversation);
  const record = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  );
  const result = JSON.parse(JSON.stringify(planned)) as typeof planned;
  assert.ok(result.plan);
  result.plan.candidateRecord = record;
  assert.deepEqual(validate(result, schema), []);

  const broken = JSON.parse(JSON.stringify(result)) as typeof result;
  assert.ok(broken.plan);
  const event = (
    broken.plan.candidateRecord as {
      event: { reworkRequest: { handoff: { anchor: string } } };
    }
  ).event;
  event.reworkRequest.handoff.anchor = 'not-an-anchor';
  assert.ok(validate(broken, schema).length > 0);
});

test('rework-authored needs a rewritten source and the requesting coordination claim', async (t) => {
  await t.test('an unchanged source', async () => {
    const fixture = await authoredFixture();
    fixture.store.source = { ...fixture.store.source, body };
    const result = await runProvisionalResolution(
      authoredRequest(fixture),
      fixture.store,
      { apply: true },
    );
    assertRefused(result, 'fix-input', /not been rewritten/);
    assert.equal(eventsOf(fixture.store).includes('rework-authored'), false);
  });

  await t.test(
    'a claim posted and released since does not block it',
    async () => {
      const fixture = await authoredFixture();
      fixture.store.addComment((at) =>
        renderClaimedByMarker({
          agentId: 'another-agent',
          claimId: 'claim-4536-later',
          supersedes: 'none',
          timestamp: at,
          branch: 'issue/4536-later-work',
        }),
      );
      fixture.store.addComment((at) =>
        renderUnclaimedByMarker({
          agentId: 'another-agent',
          claimId: 'claim-4536-later',
          timestamp: at,
        }),
      );
      const result = await runProvisionalResolution(
        authoredRequest(fixture),
        fixture.store,
        { apply: true },
      );
      assert.equal(result.outcome, 'rework-authored', JSON.stringify(result));
      assert.equal(eventsOf(fixture.store).includes('rework-authored'), true);
    },
  );

  await t.test('a different agent or branch for the named claim', async () => {
    const fixture = await authoredFixture();
    const request = {
      ...authoredRequest(fixture),
      agentId: 'another-agent',
    } as ProvisionalResolutionRequest;
    const result = await runProvisionalResolution(request, fixture.store, {
      apply: true,
    });
    assertRefused(result, 'fix-input', /does not name a coordination claim/);
  });
});

test('evidence is derived only for records of the attested authoring set', async () => {
  const fixture = await authoredFixture();
  const { store } = fixture;
  const done = await runProvisionalResolution(authoredRequest(fixture), store, {
    apply: true,
  });
  assert.equal(done.outcome, 'rework-authored', JSON.stringify(done));
  // The same evidence replays; another set's evidence cannot vouch for the
  // recorded rework-authored record, so the run holds instead of reporting it.
  const other = authoring(fixture, {
    owner: {
      trusted: true,
      fresh: true,
      setId: 'set-another-attestation',
      sessionId: fixture.handoff.authoringSessionId,
      anchor: fixture.handoff.anchor,
    },
  });
  const result = await runProvisionalResolution(
    authoredRequest(fixture, other),
    store,
    { apply: true },
  );
  assertRefused(result, 'recovery-hold', /evidence is missing or duplicated/);
});

test('a conversational no, nope, or unclear reply cannot be overridden by a persisted answer', async (t) => {
  const refusals: [string, ConfirmationInput][] = [
    [
      'a conversational no',
      {
        channel: 'conversation',
        origin: 'user',
        message: 'No, not yet.',
        interpretation: { response: 'declined' },
      },
    ],
    [
      'nope at the prompt',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'line', text: 'nope' },
      },
    ],
    [
      'an unclear reply',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'line', text: 'maybe later' },
      },
    ],
  ];
  for (const [name, input] of refusals) {
    await t.test(name, async () => {
      const store = await pendingStore();
      store.addComment(() => craftedAnswer(store, () => {}));
      const result = await runProvisionalResolution(
        resolveRequest({ input }),
        store,
        { apply: true },
      );
      assertRefused(result, 'fix-input', /conflicts with it/);
      assert.equal(store.writes(), 0);
    });
  }
  // A generic request to resolve is the normal trigger, not a refusal.
  const store = await pendingStore();
  store.addComment(() => craftedAnswer(store, () => {}));
  const generic = await runProvisionalResolution(
    resolveRequest({
      input: {
        channel: 'conversation',
        origin: 'user',
        message: 'Please resolve issue 4536.',
        interpretation: { response: 'none' },
      },
    }),
    store,
    { apply: true },
  );
  assert.equal(generic.outcome, 'confirmed-closed', JSON.stringify(generic));
  assert.deepEqual(
    readConfirmationAnswer(
      {
        channel: 'conversation',
        origin: 'user',
        message: 'No.',
        interpretation: { response: 'declined' },
      },
      ['change'],
    ),
    { kind: 'pending', reason: 'declined' },
  );
});

test('a stored confirmation or rework request is not overridden by a conflicting input on resume', async (t) => {
  await t.test('a confirmation whose close failed', async () => {
    const store = await pendingStore();
    store.closeFailure = 'before';
    await answered(store, conversationYes);
    store.closeFailure = undefined;
    for (const input of [terminalNo, reworkConversation]) {
      const result = await runProvisionalResolution(
        resolveRequest({ input }),
        store,
        { apply: true },
      );
      assertRefused(result, 'fix-input', /already persisted/);
    }
    assert.equal(store.sourceState.state, 'open');
    // The same acceptance, or none, resumes the close.
    const agree = await runProvisionalResolution(
      resolveRequest({ input: conversationYes }),
      store,
      { apply: true },
    );
    assert.equal(agree.outcome, 'confirmed-closed', JSON.stringify(agree));
  });

  await t.test('a rework request whose release failed', async () => {
    const store = await pendingStore();
    store.releaseFailure = 'before';
    await answered(store, reworkConversation);
    store.releaseFailure = undefined;
    const conflict = await runProvisionalResolution(
      resolveRequest({ input: conversationYes }),
      store,
      { apply: true },
    );
    assertRefused(conflict, 'fix-input', /already persisted/);
    assert.equal(activeCoordinationClaim(store), true);
    const agree = await runProvisionalResolution(
      resolveRequest({ input: reworkConversation }),
      store,
      { apply: true },
    );
    assert.equal(
      agree.outcome,
      'rework-handoff-recorded',
      JSON.stringify(agree),
    );
  });
});

test('a partially resolved bundle reports the outcome of what was recorded', async () => {
  const store = await pendingStore(2);
  // A persisted rework answer for decision 1, then a run that also targets 2.
  store.addComment(() =>
    craftedAnswer(store, (answer) => {
      answer.response = 'rework';
      answer.requestedOptionId = 'change';
      answer.rationale = 'Revise this comparison.';
      answer.answerText = 'I prefer the alternative.';
      answer.decisionGenerations = [1, 2];
      answer.appliesToDecisionGenerations = [1];
      const bundle = answer.presentedBundle as Record<string, unknown>[];
      const second = recordsOf(store).find(
        (item) =>
          item.event.type === 'work-completed' && item.decisionGeneration === 2,
      ) as ProvisionalDecisionRecord;
      const selection = recordsOf(store).find(
        (item) =>
          item.event.type === 'selected' && item.decisionGeneration === 2,
      ) as ProvisionalDecisionRecord;
      bundle.push({
        decisionGeneration: 2,
        question: selection.event.question,
        selectedOptionId: 'keep',
        feasibleAlternativeIds: ['change'],
        workCompletedRecordId: second.recordId,
        result: second.event.result,
      });
    }),
  );
  const result = await runProvisionalResolution(
    resolveRequest({ decisionGenerations: [1, 2] }),
    store,
    { apply: true },
  );
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.outcome, 'rework-handoff-recorded');
  assert.deepEqual(result.steps, ['append-rework-request', 'release-claim']);
  assert.equal(activeCoordinationClaim(store), false);
});

async function authoredFixtureFor(
  store: MemoryStore,
): Promise<AuthoredFixture> {
  store.source = { ...store.source, body: roadmapBody };
  const published = store.addComment(() => 'Rework roadmap published.');
  const requested = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  ) as ProvisionalDecisionRecord;
  const handoff = (
    requested.event.reworkRequest as { handoff: ProvisionalReworkHandoff }
  ).handoff;
  return {
    store,
    handoff,
    publishedAt: published.createdAt,
    publishedId: published.id,
  };
}

test('one authoring run records every decision that awaits it', async () => {
  const store = await pendingStore(2);
  const first = await answered(store, reworkConversation, {
    decisionGenerations: [1],
  });
  assert.equal(first.outcome, 'rework-handoff-recorded', JSON.stringify(first));
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const second = await answered(
    store,
    reworkConversation,
    { decisionGenerations: [2] },
    'claim-4536-coord-b',
  );
  assert.equal(
    second.outcome,
    'rework-handoff-recorded',
    JSON.stringify(second),
  );
  const fixture = await authoredFixtureFor(store);
  const result = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.outcome, 'rework-authored');
  assert.deepEqual(result.steps, [
    'append-rework-authored',
    'append-rework-authored',
  ]);
  assert.equal(
    eventsOf(store).filter((type) => type === 'rework-authored').length,
    2,
  );
  const rerun = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  assert.equal(rerun.state, 'reconciled', JSON.stringify(rerun));
});

test('rework-authored is not terminal while another decision has no final state', async () => {
  const store = await pendingStore(2);
  const first = await answered(store, reworkConversation, {
    decisionGenerations: [1],
  });
  assert.equal(first.outcome, 'rework-handoff-recorded', JSON.stringify(first));
  const fixture = await authoredFixtureFor(store);
  const result = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  // Decision 1 is recorded, but decision 2 is still pending.
  assert.deepEqual(result.steps, ['append-rework-authored']);
  assertRefused(result, 'none', /decisions without a final state/);
});

test('a coordination claim taken after authoring is released, not stranded', async () => {
  const store = await pendingStore(2);
  await answered(store, reworkConversation, { decisionGenerations: [1] });
  const fixture = await authoredFixtureFor(store);
  const authoredRun = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  assert.deepEqual(authoredRun.steps, ['append-rework-authored']);
  const authored = recordsOf(store).find(
    (item) => item.event.type === 'rework-authored',
  ) as ProvisionalDecisionRecord;
  const requested = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  ) as ProvisionalDecisionRecord;
  const roadmap = authored.event.reworkRoadmap as Record<string, unknown>;
  const evidence: VerifiedProvisionalReworkRoadmap[] = [
    {
      recordId: authored.recordId,
      sourceBefore: requested.source,
      sourceAfter: authored.source,
      roadmapIssueNumber: issueNumber,
      roadmapMarkerId: String(roadmap.roadmapMarkerId),
      authoringSetId: String(roadmap.authoringSetId),
      url: issueUrl,
      publishedCommentId: fixture.publishedId,
      publishedAt: fixture.publishedAt,
    },
  ];
  // Decision 2 is confirmed under a new claim; decision 1 stays reworked.
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const confirm = await answered(
    store,
    conversationYes,
    { decisionGenerations: [2], verifiedReworkRoadmaps: evidence },
    'claim-4536-coord-b',
  );
  assert.equal(confirm.state, 'applied', JSON.stringify(confirm));
  assert.equal(confirm.steps.includes('append-confirmation'), true);
  assert.equal(store.sourceState.state, 'open');
  assert.equal(store.closes, 0);
  const claim = store.history.comments.filter((comment) =>
    comment.body.includes('claim-4536-coord-b'),
  );
  assert.equal(
    claim.some((comment) => comment.body.startsWith('<!-- unclaimed-by')),
    true,
  );
});

test('a plan keyed without the source update time survives an unrelated edit', async () => {
  const store = await pendingStore();
  const digest = await shownDigest(store);
  const before = store.historyReads;
  store.readHook = (readNumber, target) => {
    if (readNumber === before + 2) {
      // A label or comment edit moves updatedAt but not the title or body.
      target.source = { ...target.source, updatedAt: '2026-11-03T11:30:00Z' };
    }
  };
  const result = await runProvisionalResolution(
    resolveRequest({
      input: conversationYes,
      answeredPresentationSha256: digest,
    }),
    store,
    { apply: true },
  );
  assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
});

test('the answer comment escapes an at-sign and needs the canonical note and question', async () => {
  const store = await pendingStore();
  const mention: ConfirmationInput = {
    ...conversationYes,
    message: 'Yes, and thanks @someone for the review.',
  } as ConfirmationInput;
  const result = await answered(store, mention);
  assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
  const stored = answersOf(store)[0];
  assert.ok(stored);
  assert.equal(stored.comment.body.includes('@'), false);
  assert.equal(
    stored.answer.answerText,
    'Yes, and thanks @someone for the review.',
  );

  // Another note or another question is not the canonical answer.
  const json = stored.comment.body.split('\n').slice(2).join('\n');
  const custom = `${PROVISIONAL_DECISION_ANSWER_MARKER}\n_Some other note._\n${json}`;
  assert.equal(parseProvisionalDecisionAnswerComment(custom).ok, false);

  const other = await pendingStore();
  other.addComment(() =>
    craftedAnswer(other, (answer) => {
      answer.presentedQuestion = 'Is this fine?';
    }),
  );
  const pendingRun = await answered(other, null);
  assert.equal(
    pendingRun.outcome,
    'pending-released',
    JSON.stringify(pendingRun),
  );
  assert.equal(eventsOf(other).includes('confirmed'), false);
});

test('a rework request record also keeps an at-sign from notifying anyone', async () => {
  const store = await pendingStore();
  const result = await answered(store, {
    ...reworkConversation,
    interpretation: {
      response: 'rework',
      requestedOptionId: 'change',
      rationale: 'Ask @someone about the migration.',
    },
  } as ConfirmationInput);
  assert.equal(
    result.outcome,
    'rework-handoff-recorded',
    JSON.stringify(result),
  );
  const comment = store.history.comments.find((item) => {
    const parsed = parseProvisionalDecisionRecordComment(item.body);
    return parsed.ok && parsed.record.event.type === 'rework-requested';
  });
  assert.ok(comment);
  assert.equal(comment.body.includes('@'), false);
  const record = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  );
  const request = record?.event.reworkRequest as
    | { rationale: string }
    | undefined;
  assert.equal(request?.rationale, 'Ask @someone about the migration.');
});

test('a conversation reply is stored verbatim, including its whitespace', async () => {
  const store = await pendingStore();
  const verbatim = '  Yes, I accept.  \n';
  const result = await answered(store, {
    ...conversationYes,
    message: verbatim,
  } as ConfirmationInput);
  assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
  assert.equal(answersOf(store)[0]?.answer.answerText, verbatim);
  assert.deepEqual(
    readConfirmationAnswer({ ...conversationYes, message: verbatim }, [
      'change',
    ]),
    { kind: 'accepted', channel: 'conversation', answerText: verbatim },
  );
});

test('downstream results of a rework request are kept and merged, not dropped', async (t) => {
  const first = 'https://github.com/kurone-kito/idd-skill/pull/5901';
  const second = 'https://github.com/kurone-kito/idd-skill/pull/5902';

  await t.test('the answer keeps them for a retry', async () => {
    const store = await pendingStore();
    store.recordFailure = (type) =>
      type === 'rework-requested' ? 'before' : undefined;
    const failed = await answered(store, reworkConversation, {
      downstreamResults: [first],
    });
    assertRefused(failed, 'recovery-hold', /append-rework-request/);
    assert.deepEqual(answersOf(store)[0]?.answer.downstreamResults, [first]);
    // The retry has no input and no downstream list, yet the handoff keeps it.
    store.recordFailure = undefined;
    const retry = await runProvisionalResolution(resolveRequest(), store, {
      apply: true,
    });
    assert.equal(
      retry.outcome,
      'rework-handoff-recorded',
      JSON.stringify(retry),
    );
    assert.deepEqual(handoffOf(store).downstreamResults, [first]);
  });

  await t.test(
    'a later request merges its own into the bundle handoff',
    async () => {
      const store = await pendingStore(2);
      await answered(store, reworkConversation, {
        decisionGenerations: [1],
        downstreamResults: [first],
      });
      postCoordinationClaim(store, 'claim-4536-coord-b');
      const result = await answered(
        store,
        reworkConversation,
        { decisionGenerations: [2], downstreamResults: [second, first] },
        'claim-4536-coord-b',
      );
      assert.equal(
        result.outcome,
        'rework-handoff-recorded',
        JSON.stringify(result),
      );
      const handoffs = recordsOf(store)
        .filter((record) => record.event.type === 'rework-requested')
        .map(
          (record) =>
            (
              record.event.reworkRequest as {
                handoff: ProvisionalReworkHandoff;
              }
            ).handoff,
        );
      assert.deepEqual(handoffs[0]?.downstreamResults, [first]);
      assert.deepEqual(handoffs[1]?.downstreamResults, [first, second]);
      assert.equal(handoffs[0]?.handoffId, handoffs[1]?.handoffId);
      assert.equal(replayOf(store).valid, true);
    },
  );

  await t.test(
    'an adopted answer ignores a different request list, with a warning',
    async () => {
      const store = await pendingStore();
      store.addComment(() =>
        craftedAnswer(store, (answer) => {
          danglingReworkAnswer(answer);
          answer.appliesToDecisionGenerations = [1];
          answer.downstreamResults = [first];
        }),
      );
      const result = await runProvisionalResolution(
        resolveRequest({ downstreamResults: [second] }),
        store,
        { apply: true },
      );
      assert.equal(
        result.outcome,
        'rework-handoff-recorded',
        JSON.stringify(result),
      );
      assert.match(result.warnings?.[0] ?? '', /not added/);
      assert.deepEqual(handoffOf(store).downstreamResults, [first]);
    },
  );

  await t.test('only a rework answer may carry them', async () => {
    const store = await pendingStore();
    const comment = store.addComment(() =>
      craftedAnswer(store, (answer) => {
        answer.downstreamResults = [first];
      }),
    );
    assert.equal(parseProvisionalDecisionAnswerComment(comment.body).ok, false);
    const bad = store.addComment(() =>
      craftedAnswer(store, (answer) => {
        danglingReworkAnswer(answer);
        answer.downstreamResults = ['not a url'];
      }),
    );
    assert.equal(parseProvisionalDecisionAnswerComment(bad.body).ok, false);
  });
});

test('a persisted rework for one decision refuses a conflicting input before any write', async () => {
  const store = await pendingStore(2);
  await answered(store, reworkConversation, { decisionGenerations: [1] });
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const writesBefore = store.writes();
  const digest = await shownDigest(
    store,
    { decisionGenerations: [1, 2] },
    'claim-4536-coord-b',
  );
  const result = await runProvisionalResolution(
    resolveRequest(
      {
        decisionGenerations: [1, 2],
        input: conversationYes,
        answeredPresentationSha256: digest,
      },
      'claim-4536-coord-b',
    ),
    store,
    { apply: true },
  );
  assertRefused(result, 'fix-input', /already persisted/);
  assert.equal(store.writes(), writesBefore);
  assert.equal(eventsOf(store).includes('confirmed'), false);
});

test('a partly authored bundle reports a non-terminal outcome', async () => {
  const store = await pendingStore(2);
  await answered(store, reworkConversation, { decisionGenerations: [1] });
  const fixture = await authoredFixtureFor(store);
  const authored = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  assert.deepEqual(authored.steps, ['append-rework-authored']);
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const evidence = reworkEvidenceFor(store, fixture);
  const result = await runProvisionalResolution(
    resolveRequest({ verifiedReworkRoadmaps: evidence }, 'claim-4536-coord-b'),
    store,
    { apply: true },
  );
  // Decision 2 has no final state, so the bundle is not finished.
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.outcome, 'pending-released');
});

function reworkEvidenceFor(
  store: MemoryStore,
  fixture: AuthoredFixture,
): VerifiedProvisionalReworkRoadmap[] {
  const authored = recordsOf(store).find(
    (item) => item.event.type === 'rework-authored',
  ) as ProvisionalDecisionRecord;
  const requested = recordsOf(store).find(
    (item) => item.event.type === 'rework-requested',
  ) as ProvisionalDecisionRecord;
  const roadmap = authored.event.reworkRoadmap as Record<string, unknown>;
  return [
    {
      recordId: authored.recordId,
      sourceBefore: requested.source,
      sourceAfter: authored.source,
      roadmapIssueNumber: issueNumber,
      roadmapMarkerId: String(roadmap.roadmapMarkerId),
      authoringSetId: String(roadmap.authoringSetId),
      url: issueUrl,
      publishedCommentId: fixture.publishedId,
      publishedAt: fixture.publishedAt,
    },
  ];
}

test('the close is guarded by the source content the plan evaluated', async () => {
  const store = await pendingStore();
  store.beforeClose = (target) => {
    target.source = { ...target.source, body: `${body}\nEdited at close.` };
  };
  const result = await answered(store, conversationYes);
  assertRefused(result, 'recovery-hold', /close-source write is uncertain/);
  assert.match(result.reason ?? '', /the source changed since the plan/);
  assert.equal(store.sourceState.state, 'open');
  assert.equal(activeCoordinationClaim(store), true);

  // A title-only edit is caught the same way.
  const other = await pendingStore();
  other.beforeClose = (target) => {
    target.source = { ...target.source, title: 'A new title' };
  };
  const titled = await answered(other, conversationYes);
  assertRefused(titled, 'recovery-hold', /close-source write is uncertain/);
  assert.equal(other.sourceState.state, 'open');
});

test('a record step is keyed by its whole content, so an edited answer cannot slip through', async () => {
  const store = await pendingStore();
  const first = store.addComment(() => craftedAnswer(store, () => {}));
  store.addComment(() =>
    craftedAnswer(store, (answer) => {
      answer.answerText = 'Yes, the second answer.';
    }),
  );
  const before = store.historyReads;
  store.readHook = (readNumber, target) => {
    // The first answer is edited between the two plans of the apply run.
    if (readNumber === before + 2)
      target.replaceComment(first.id, { edited: true });
  };
  const result = await runProvisionalResolution(resolveRequest(), store, {
    apply: true,
  });
  assertRefused(result, 'recovery-hold', /the plan changed before the write/);
  assert.equal(store.writes(), 0);
  assert.equal(eventsOf(store).includes('confirmed'), false);
});

test('an answer write that throws is held or proven by a fresh read', async (t) => {
  await t.test('before it landed: a hold that keeps the claim', async () => {
    const store = await pendingStore();
    store.answerFailure = 'before';
    const result = await answered(store, conversationYes);
    assertRefused(result, 'recovery-hold', /append-answer write is uncertain/);
    assert.equal(answersOf(store).length, 0);
    assert.equal(eventsOf(store).includes('confirmed'), false);
    assert.equal(store.sourceState.state, 'open');
    assert.equal(activeCoordinationClaim(store), true);
  });

  await t.test('after it landed, with the response lost', async () => {
    const store = await pendingStore();
    store.answerFailure = 'after';
    const result = await answered(store, conversationYes);
    assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
    assert.equal(answersOf(store).length, 1);
    assert.match(result.warnings?.[0] ?? '', /append-answer write threw/);
  });
});

test('an answer recorded before any coordination claim is not adopted', async () => {
  const store = new MemoryStore();
  await completeDecision(store, { evidenceId: '2', pullNumber: 6000 });
  releaseImplementation(store);
  // The implementation session wrote a canonical-looking answer on its own.
  store.addComment(() =>
    craftedAnswer(store, (answer) => {
      answer.claimIds = [implClaim];
    }),
  );
  postCoordinationClaim(store, 'claim-4536-coord');
  store.resetCounters();
  const result = await runProvisionalResolution(
    resolveRequest({
      input: {
        channel: 'conversation',
        origin: 'user',
        message: 'Please resolve issue 4536.',
        interpretation: { response: 'none' },
      },
    }),
    store,
    { apply: true },
  );
  assert.equal(result.outcome, 'pending-released', JSON.stringify(result));
  assert.equal(eventsOf(store).includes('confirmed'), false);
});

test('a dry run says whether the user still has to be asked', async () => {
  const fresh = await pendingStore();
  const ask = await runProvisionalResolution(resolveRequest(), fresh);
  assert.equal(ask.state, 'planned');
  assert.equal(ask.needsUserAnswer, true);
  assert.ok(ask.presentation);

  const resume = await pendingStore();
  resume.addComment(() => craftedAnswer(resume, () => {}));
  const noAsk = await runProvisionalResolution(resolveRequest(), resume);
  assert.equal(noAsk.nextStep, 'append-confirmation');
  assert.equal(noAsk.needsUserAnswer, false);

  const done = await pendingStore();
  await answered(done, conversationYes);
  postCoordinationClaim(done, 'claim-4536-coord-b');
  const finish = await runProvisionalResolution(
    resolveRequest({}, 'claim-4536-coord-b'),
    done,
  );
  assert.equal(finish.nextStep, 'release-claim');
  assert.equal(finish.needsUserAnswer, false);
  const accepted = await runProvisionalResolution(
    resolveRequest({
      input: conversationYes,
      answeredPresentationSha256: ask.presentationSha256,
    }),
    fresh,
  );
  assert.equal(accepted.nextStep, 'append-answer');
  // The user has already answered, so nothing more is asked.
  assert.equal(accepted.needsUserAnswer, false);
  const declined = await runProvisionalResolution(
    resolveRequest({
      input: terminalNo,
      answeredPresentationSha256: ask.presentationSha256,
    }),
    fresh,
  );
  assert.equal(declined.nextStep, 'release-claim');
  assert.equal(declined.needsUserAnswer, false);
  const silent = await runProvisionalResolution(
    resolveRequest({ input: { channel: 'timeout' } }),
    fresh,
  );
  assert.equal(silent.needsUserAnswer, true);
});

test('every record this flow writes escapes an at-sign in a source title', async () => {
  // The title is part of every record's source snapshot, so it is set before
  // the lifecycle starts.
  const store = new MemoryStore();
  store.source = { ...store.source, title: 'Ask @someone first' };
  await completeDecision(store, { evidenceId: '2', pullNumber: 6000 });
  releaseImplementation(store);
  postCoordinationClaim(store, 'claim-4536-coord');
  store.resetCounters();
  const result = await answered(store, conversationYes);
  assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
  const confirmed = store.history.comments.find((comment) => {
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    return parsed.ok && parsed.record.event.type === 'confirmed';
  });
  assert.ok(confirmed);
  assert.equal(confirmed.body.includes('@'), false);
});

test('an N or an abort in a mixed bundle only keeps the pending decision pending', async (t) => {
  const aborts: [string, ConfirmationInput][] = [
    ['an explicit N', terminalNo],
    [
      'Enter',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'line', text: '' },
      },
    ],
    [
      'EOF',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'eof' },
      },
    ],
    [
      'cancellation',
      {
        channel: 'terminal',
        origin: 'user',
        interactive: true,
        event: { kind: 'cancelled' },
      },
    ],
  ];
  for (const [name, input] of aborts) {
    await t.test(
      `${name} with decision 1 confirmed and 2 pending`,
      async () => {
        const store = await pendingStore(2);
        const first = await answered(store, conversationYes, {
          decisionGenerations: [1],
        });
        assert.equal(first.outcome, 'pending-released', JSON.stringify(first));
        postCoordinationClaim(store, 'claim-4536-coord-b');
        const writesBefore = store.writes();
        const result = await answered(
          store,
          input,
          { decisionGenerations: [1, 2] },
          'claim-4536-coord-b',
        );
        assert.equal(result.state, 'applied', JSON.stringify(result));
        assert.equal(result.outcome, 'pending-released');
        assert.deepEqual(result.steps, ['release-claim']);
        assert.equal(store.writes(), writesBefore + 1);
        assert.equal(store.sourceState.state, 'open');
        assert.equal(
          eventsOf(store).filter((type) => type === 'confirmed').length,
          1,
        );
      },
    );
  }

  await t.test('with a rework request persisted for decision 1', async () => {
    const store = await pendingStore(2);
    await answered(store, reworkConversation, { decisionGenerations: [1] });
    postCoordinationClaim(store, 'claim-4536-coord-b');
    const result = await answered(
      store,
      terminalNo,
      { decisionGenerations: [1, 2] },
      'claim-4536-coord-b',
    );
    assert.equal(
      result.outcome,
      'rework-handoff-recorded',
      JSON.stringify(result),
    );
    assert.deepEqual(result.steps, ['release-claim']);
  });
});

test('a conflicting input is also refused once rework authoring is recorded', async () => {
  const store = await pendingStore();
  await answered(store, reworkConversation);
  const fixture = await authoredFixtureFor(store);
  const authored = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  assert.equal(authored.outcome, 'rework-authored', JSON.stringify(authored));
  postCoordinationClaim(store, 'claim-4536-coord-b');
  const evidence = reworkEvidenceFor(store, fixture);
  const result = await runProvisionalResolution(
    resolveRequest(
      {
        input: conversationYes,
        answeredPresentationSha256: 'x',
        verifiedReworkRoadmaps: evidence,
      },
      'claim-4536-coord-b',
    ),
    store,
    { apply: true },
  );
  assertRefused(result, 'fix-input', /already persisted/);
});

test('a thrown write that did not land is held even when the plan moved on', async () => {
  const store = await pendingStore();
  store.recordFailure = (type) => {
    if (type !== 'confirmed') return undefined;
    // The answer is edited while the record write fails, so the next plan
    // chooses another record, but the failed record is not in the history.
    const answer = answersOf(store)[0];
    if (answer) store.replaceComment(answer.comment.id, { edited: true });
    return 'before';
  };
  const result = await answered(store, conversationYes);
  assertRefused(
    result,
    'recovery-hold',
    /append-confirmation write is uncertain/,
  );
  assert.deepEqual(result.steps, ['append-answer']);
  assert.equal(eventsOf(store).includes('confirmed'), false);
  assert.equal(result.warnings, undefined);
});

test('downstream results are warned about only where they are dropped', async () => {
  const link = 'https://github.com/kurone-kito/idd-skill/pull/5903';
  const store = await pendingStore();
  store.addComment(() => craftedAnswer(store, () => {}));
  const accepted = await runProvisionalResolution(
    resolveRequest({ downstreamResults: [link] }),
    store,
    { apply: true },
  );
  assert.equal(accepted.outcome, 'confirmed-closed', JSON.stringify(accepted));
  assert.match(accepted.warnings?.[0] ?? '', /cannot carry|not record/);

  // A reference the bundle handoff already holds is not a drop.
  const rework = await pendingStore();
  rework.addComment(() =>
    craftedAnswer(rework, (answer) => {
      danglingReworkAnswer(answer);
      answer.appliesToDecisionGenerations = [1];
      answer.downstreamResults = [link];
    }),
  );
  const same = await runProvisionalResolution(
    resolveRequest({ downstreamResults: [link] }),
    rework,
    { apply: true },
  );
  assert.equal(same.outcome, 'rework-handoff-recorded', JSON.stringify(same));
  assert.equal(same.warnings, undefined);
});

test('replay requires the handoff to keep every downstream result of its answer', async () => {
  const link = 'https://github.com/kurone-kito/idd-skill/pull/5904';
  const store = await pendingStore();
  await answered(store, reworkConversation, { downstreamResults: [link] });
  assert.equal(replayOf(store).valid, true);
  tamperRework(store, (handoff) => {
    handoff.downstreamResults = [];
  });
  const replay = replayOf(store);
  assert.equal(replay.valid, false);
  assert.ok(
    replay.issues.some(
      (issue) => issue.code === 'rework-handoff-downstream-mismatch',
    ),
    JSON.stringify(replay.issues),
  );
});

test('rework-requested and rework-authored records escape an at-sign in the title', async () => {
  const store = new MemoryStore();
  store.source = { ...store.source, title: 'Ask @someone first' };
  await completeDecision(store, { evidenceId: '2', pullNumber: 6000 });
  releaseImplementation(store);
  postCoordinationClaim(store, 'claim-4536-coord');
  store.resetCounters();
  const requested = await answered(store, reworkConversation);
  assert.equal(
    requested.outcome,
    'rework-handoff-recorded',
    JSON.stringify(requested),
  );
  const fixture = await authoredFixtureFor(store);
  const authored = await runProvisionalResolution(
    authoredRequest(fixture),
    store,
    { apply: true },
  );
  assert.equal(authored.outcome, 'rework-authored', JSON.stringify(authored));
  for (const type of ['rework-requested', 'rework-authored']) {
    const comment = store.history.comments.find((item) => {
      const parsed = parseProvisionalDecisionRecordComment(item.body);
      return parsed.ok && parsed.record.event.type === type;
    });
    assert.ok(comment, type);
    assert.equal(comment.body.includes('@'), false, type);
  }
});

test('a thrown write is not counted for a look-alike that is not its own content', async (t) => {
  await t.test('an untrusted comment with the same record ID', async () => {
    const store = await pendingStore();
    store.recordFailure = (type, text) => {
      if (type !== 'confirmed') return undefined;
      store.addComment(() => text, undefined, {
        authorLogin: 'someone-else',
        trustedAuthor: false,
      });
      return 'before';
    };
    const result = await answered(store, conversationYes);
    assertRefused(
      result,
      'recovery-hold',
      /append-confirmation write is uncertain/,
    );
    assert.deepEqual(result.steps, ['append-answer']);
    assert.deepEqual(result.recordIds, []);
    assert.equal(result.warnings, undefined);
    assert.equal(store.sourceState.state, 'open');
  });

  await t.test('an edited comment with the same record ID', async () => {
    const store = await pendingStore();
    store.recordFailure = (type, text) => {
      if (type !== 'confirmed') return undefined;
      store.addComment(() => text, undefined, { edited: true });
      return 'before';
    };
    const result = await answered(store, conversationYes);
    assertRefused(
      result,
      'recovery-hold',
      /append-confirmation write is uncertain/,
    );
    assert.deepEqual(result.recordIds, []);
  });

  await t.test('a record with the same ID and different content', async () => {
    const store = await pendingStore();
    store.recordFailure = (type, text) => {
      if (type !== 'confirmed') return undefined;
      const record = JSON.parse(
        text.slice(PROVISIONAL_DECISION_RECORD_MARKER.length + 1),
      ) as { evidenceReferences: string[] };
      record.evidenceReferences = ['https://example.com/other'];
      store.addComment(
        () =>
          `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(record)}`,
      );
      return 'before';
    };
    const result = await answered(store, conversationYes);
    assert.equal(result.state, 'refused', JSON.stringify(result));
    assert.deepEqual(result.recordIds, []);
    assert.equal(result.warnings, undefined);
  });

  await t.test('a close that applied under another reason', async () => {
    const store = await pendingStore();
    store.closeFailure = 'after';
    store.closeReason = 'not_planned';
    const result = await answered(store, conversationYes);
    assertRefused(result, 'recovery-hold', /close-source write is uncertain/);
    assert.equal(result.steps.includes('close-source'), false);
    assert.equal(result.warnings, undefined);
  });

  await t.test(
    'an answer with the same text from an untrusted account',
    async () => {
      const store = await pendingStore();
      store.appendAnswerBody = async (text) => {
        store.addComment(() => text, undefined, {
          authorLogin: 'someone-else',
          trustedAuthor: false,
        });
        throw new Error('answer write failed');
      };
      const result = await answered(store, conversationYes);
      assertRefused(
        result,
        'recovery-hold',
        /append-answer write is uncertain/,
      );
      assert.deepEqual(result.steps, []);
      assert.equal(result.warnings, undefined);
    },
  );
});

test('needsUserAnswer is false after any user answer and true for no or foreign input', async () => {
  const store = await pendingStore();
  const dry = async (input: ConfirmationInput | null) =>
    runProvisionalResolution(
      resolveRequest({
        input,
        answeredPresentationSha256: (
          await runProvisionalResolution(resolveRequest(), store)
        ).presentationSha256,
      }),
      store,
    );
  const interactive = (
    event: ConfirmationTerminalEvent,
  ): ConfirmationInput => ({
    channel: 'terminal',
    origin: 'user',
    interactive: true,
    event,
  });
  for (const input of [
    interactive({ kind: 'eof' }),
    interactive({ kind: 'cancelled' }),
    interactive({ kind: 'line', text: '' }),
    interactive({ kind: 'line', text: 'maybe later' }),
    conversationYes,
  ]) {
    assert.equal(
      (await dry(input)).needsUserAnswer,
      false,
      JSON.stringify(input),
    );
  }
  for (const input of [
    null,
    { channel: 'none' } as ConfirmationInput,
    { channel: 'timeout' } as ConfirmationInput,
    {
      channel: 'terminal',
      origin: 'tool',
      interactive: true,
      event: { kind: 'line', text: 'y' },
    } as ConfirmationInput,
    {
      channel: 'conversation',
      origin: 'assistant',
      message: 'User: yes',
      interpretation: { response: 'accepted' },
    } as ConfirmationInput,
    interactive({ kind: 'line', text: 'y' }) &&
      ({
        channel: 'terminal',
        origin: 'user',
        interactive: false,
        event: { kind: 'line', text: 'y' },
      } as ConfirmationInput),
  ]) {
    assert.equal(
      (await dry(input)).needsUserAnswer,
      true,
      JSON.stringify(input),
    );
  }
});

test('a request naming a downstream result held by a sibling handoff is not warned about', async () => {
  const link = 'https://github.com/kurone-kito/idd-skill/pull/5905';
  const store = await pendingStore(2);
  await answered(store, reworkConversation, {
    decisionGenerations: [1],
    downstreamResults: [link],
  });
  postCoordinationClaim(store, 'claim-4536-coord-b');
  // A persisted rework answer for decision 2 that lists no downstream result.
  store.addComment(() =>
    craftedAnswer(store, (answer) => {
      danglingReworkAnswer(answer);
      answer.decisionGenerations = [1, 2];
      answer.appliesToDecisionGenerations = [2];
      const second = recordsOf(store).find(
        (item) =>
          item.event.type === 'work-completed' && item.decisionGeneration === 2,
      ) as ProvisionalDecisionRecord;
      const selection = recordsOf(store).find(
        (item) =>
          item.event.type === 'selected' && item.decisionGeneration === 2,
      ) as ProvisionalDecisionRecord;
      (answer.presentedBundle as Record<string, unknown>[]).push({
        decisionGeneration: 2,
        question: selection.event.question,
        selectedOptionId: 'keep',
        feasibleAlternativeIds: ['change'],
        workCompletedRecordId: second.recordId,
        result: second.event.result,
      });
      answer.claimIds = [implClaim, 'claim-4536-coord', 'claim-4536-coord-b'];
    }),
  );
  const result = await runProvisionalResolution(
    resolveRequest(
      { decisionGenerations: [2], downstreamResults: [link] },
      'claim-4536-coord-b',
    ),
    store,
    { apply: true },
  );
  assert.equal(
    result.outcome,
    'rework-handoff-recorded',
    JSON.stringify(result),
  );
  // The union already holds the sibling's reference, so nothing was dropped.
  assert.equal(result.warnings, undefined);
});

test('the close also needs the source still open and the claim still active', async (t) => {
  await t.test(
    'an intervening close with another reason is not overwritten',
    async () => {
      const store = await pendingStore();
      store.beforeClose = (target) => {
        target.sourceState = { state: 'closed', stateReason: 'not_planned' };
      };
      const result = await answered(store, conversationYes);
      assertRefused(result, 'recovery-hold', /close-source write is uncertain/);
      assert.match(result.reason ?? '', /no longer open/);
      assert.deepEqual(store.sourceState, {
        state: 'closed',
        stateReason: 'not_planned',
      });
      assert.equal(result.steps.includes('close-source'), false);
      assert.equal(activeCoordinationClaim(store), true);
    },
  );

  await t.test(
    'a coordination claim taken over after the final plan read',
    async () => {
      const store = await pendingStore();
      store.beforeClose = (target) => {
        target.addComment((at) =>
          renderUnclaimedByMarker({
            agentId: coordAgent,
            claimId: 'claim-4536-coord',
            timestamp: at,
          }),
        );
        postCoordinationClaim(target, 'claim-4536-takeover');
      };
      const result = await answered(store, conversationYes);
      assertRefused(result, 'recovery-hold', /close-source write is uncertain/);
      assert.match(result.reason ?? '', /no longer active/);
      assert.equal(store.sourceState.state, 'open');
    },
  );

  await t.test(
    'the plan names the open state and the active claim',
    async () => {
      const store = await pendingStore();
      const seen: ProvisionalResolutionCloseExpectation[] = [];
      const original = store.closeSourceIssue.bind(store);
      store.closeSourceIssue = async (expected) => {
        seen.push(expected);
        return original(expected);
      };
      const result = await answered(store, conversationYes);
      assert.equal(result.outcome, 'confirmed-closed', JSON.stringify(result));
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.state, 'open');
      assert.deepEqual(seen[0]?.claim, {
        claimId: 'claim-4536-coord',
        agentId: coordAgent,
        branch: coordBranch,
      });
    },
  );
});
