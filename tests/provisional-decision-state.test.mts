import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROVISIONAL_DECISION_ANSWER_MARKER,
  PROVISIONAL_DECISION_RECORD_MARKER,
  type ProvisionalDecisionClaim,
  type ProvisionalDecisionComment,
  type ProvisionalDecisionRecord,
  type ProvisionalDecisionReplayInput,
  type ProvisionalDecisionSource,
  parseProvisionalDecisionRecordComment,
  replayProvisionalDecisionHistory,
} from '../src/scripts/provisional-decision-state.mts';

type Event = Record<string, unknown>;

const source: ProvisionalDecisionSource = {
  repository: 'kurone-kito/idd-skill',
  issueNumber: 4599,
  snapshot: {
    title: 'Example decision source',
    bodySha256: 'a'.repeat(64),
    updatedAt: '2026-10-20T00:00:00Z',
  },
};

const firstClaim: ProvisionalDecisionClaim = {
  claimId: 'claim-4599-1',
  agentId: 'codex-example',
  branch: 'issue/4599-feat-decision-replay',
  claimedAt: '2026-10-20T00:00:00Z',
};

const secondClaim: ProvisionalDecisionClaim = {
  claimId: 'claim-4599-2',
  agentId: 'codex-takeover',
  branch: 'issue/4599-feat-decision-replay',
  claimedAt: '2026-10-20T00:01:00Z',
  supersedes: firstClaim.claimId,
};

function dateAt(second: number): string {
  return new Date(Date.UTC(2026, 9, 20, 0, 0, second)).toISOString();
}

function selectedEvent(
  question = 'Which behavior should be used?',
  id = 'keep',
): Event {
  return {
    type: 'selected',
    question,
    selectedOption: {
      id,
      description: 'Keep the existing behavior',
      feasibilityRationale: 'The current implementation supports this option.',
      requirementFit: 'It meets the verified requirement.',
      consequences: 'No migration is needed.',
      verification: 'Run the focused replay tests.',
      reversalOrMigration: 'No migration is required.',
      rationale: 'It matches the current evidence.',
    },
    feasibleAlternatives: [
      {
        id: 'change',
        description: 'Adopt the alternate behavior',
        feasibilityRationale: 'The repository can implement it.',
        requirementFit: 'It also meets the requirement.',
        consequences: 'It requires a migration.',
        verification: 'Validate migrated records.',
        reversalOrMigration: 'Existing records require migration.',
        comparison: 'It adds migration without improving the fit.',
        rejectionReason: 'The selected option better fits the evidence.',
      },
    ],
    executionCriteria: ['The selected behavior passes focused validation.'],
  };
}

function workStartedEvent(): Event {
  return {
    type: 'work-started',
    startedAt: dateAt(2),
    planReference:
      'https://github.com/kurone-kito/idd-skill/issues/4599#issuecomment-1',
  };
}

function completionResult(decisionGeneration: number): Event {
  return {
    kind: 'merged-pull-request',
    reference: `https://github.com/kurone-kito/idd-skill/pull/${4600 + decisionGeneration}`,
    verifiedAt: dateAt(2 + decisionGeneration),
    headSha: String(4600 + decisionGeneration).padStart(40, '0'),
    mergeCommitSha: String(4700 + decisionGeneration).padStart(40, '0'),
  };
}

function workCompletedEvent(decisionGeneration: number): Event {
  return {
    type: 'work-completed',
    result: completionResult(decisionGeneration),
  };
}

function record(
  recordId: string,
  event: Event,
  decisionGeneration = 1,
  bundleGeneration = 1,
  claimLineage: readonly ProvisionalDecisionClaim[] = [firstClaim],
): ProvisionalDecisionRecord {
  return {
    schemaVersion: 1,
    recordId,
    source,
    bundleGeneration,
    decisionGeneration,
    claimLineage,
    evidenceReferences: [
      'https://github.com/kurone-kito/idd-skill/issues/4599',
    ],
    event,
  } as unknown as ProvisionalDecisionRecord;
}

function comment(
  id: string,
  body: string,
  second: number,
  overrides: Partial<ProvisionalDecisionComment> = {},
): ProvisionalDecisionComment {
  return {
    id,
    url: `https://github.com/${source.repository}/issues/${source.issueNumber}#issuecomment-${id}`,
    body,
    authorLogin: 'kurone-kito',
    createdAt: dateAt(second),
    edited: false,
    trustedAuthor: true,
    ...overrides,
  };
}

function recordComment(
  id: string,
  value: ProvisionalDecisionRecord,
  second: number,
  overrides: Partial<ProvisionalDecisionComment> = {},
): ProvisionalDecisionComment {
  return comment(
    id,
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(value)}`,
    second,
    overrides,
  );
}

function answerComment(
  id: string,
  answer: Event,
  second: number,
  overrides: Partial<ProvisionalDecisionComment> = {},
): ProvisionalDecisionComment {
  return comment(
    id,
    `${PROVISIONAL_DECISION_ANSWER_MARKER}\n${JSON.stringify(answer)}`,
    second,
    overrides,
  );
}

function confirmedEvent(answer: ProvisionalDecisionComment): Event {
  return {
    type: 'confirmed',
    confirmation: {
      commentUrl: answer.url,
      response: 'accepted',
      confirmedAt: answer.createdAt,
      confirmedBy: 'Operator',
    },
  };
}

function workEvidence(decisionGeneration = 1, bundleGeneration = 1) {
  const result = completionResult(decisionGeneration);
  return {
    source,
    bundleGeneration,
    decisionGeneration,
    reference: result.reference as string,
    verifiedAt: result.verifiedAt as string,
    headSha: result.headSha as string,
    mergeCommitSha: result.mergeCommitSha as string,
    executionCriteriaSatisfied: true,
  };
}

function buildAnswer(
  selected: readonly ProvisionalDecisionRecord[],
  completed: readonly ProvisionalDecisionRecord[],
  claims: readonly ProvisionalDecisionClaim[] = [firstClaim],
  response: 'accepted' | 'rework' = 'accepted',
  requestedOptionId?: string,
  rationale?: string,
): Event {
  const completedByGeneration = new Map(
    completed.map((item) => [item.decisionGeneration, item]),
  );
  const ordered = [...selected].sort(
    (left, right) => left.decisionGeneration - right.decisionGeneration,
  );
  return {
    schemaVersion: 1,
    source,
    bundleGeneration: 1,
    decisionGenerations: ordered.map((item) => item.decisionGeneration),
    claimIds: claims.map((claim) => claim.claimId),
    presentedBundle: ordered.map((item) => {
      const event = item.event;
      const selectedOption = event.selectedOption as Event;
      const alternatives = event.feasibleAlternatives as Event[];
      const work = completedByGeneration.get(item.decisionGeneration);
      if (!work)
        throw new Error(
          `Missing work completion for generation ${item.decisionGeneration}.`,
        );
      return {
        decisionGeneration: item.decisionGeneration,
        question: event.question,
        selectedOptionId: selectedOption.id,
        feasibleAlternativeIds: alternatives.map((option) => option.id).sort(),
        workCompletedRecordId: work.recordId,
        result: work.event.result,
      };
    }),
    response,
    ...(requestedOptionId ? { requestedOptionId } : {}),
    ...(rationale ? { rationale } : {}),
    answerText:
      response === 'accepted'
        ? 'Yes, I accept the presented completed choices.'
        : 'I prefer the alternate option.',
  };
}

function input(
  comments: readonly ProvisionalDecisionComment[],
  extra: Partial<ProvisionalDecisionReplayInput> = {},
): ProvisionalDecisionReplayInput {
  return {
    comments,
    completeHistory: true,
    currentSource: source,
    verifiedClaimLineage: [firstClaim],
    verifiedWork: [workEvidence()],
    ...extra,
  };
}

function oneCompletedDecision(
  claims: readonly ProvisionalDecisionClaim[] = [firstClaim],
) {
  const selected = record('select-1', selectedEvent(), 1, 1, claims);
  const started = record('start-1', workStartedEvent(), 1, 1, claims);
  const completed = record('complete-1', workCompletedEvent(1), 1, 1, claims);
  return { selected, started, completed };
}

test('parses the canonical record marker and closed event shape', () => {
  const parsed = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(record('select-1', selectedEvent()))}`,
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.record.event.type, 'selected');
});

test('rejects malformed JSON, unsupported versions, and unknown event shapes', () => {
  const malformed = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n{nope`,
  );
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.issues[0]?.code, 'json-invalid');

  const unsupported = {
    ...record('select-1', selectedEvent()),
    schemaVersion: 2,
  };
  const versionResult = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(unsupported)}`,
  );
  assert.equal(versionResult.ok, false);
  if (!versionResult.ok)
    assert.ok(
      versionResult.issues.some(
        (issue) => issue.code === 'schema-version-unsupported',
      ),
    );

  const unknown = record('unknown-1', { type: 'approved' });
  const eventResult = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(unknown)}`,
  );
  assert.equal(eventResult.ok, false);
  if (!eventResult.ok)
    assert.ok(
      eventResult.issues.some(
        (issue) => issue.code === 'event-type-unsupported',
      ),
    );
});

test('checks integer JSON tokens before IEEE-754 rounding', () => {
  const unsafeJson = JSON.stringify(
    record('select-1', selectedEvent()),
  ).replace('"bundleGeneration":1', '"bundleGeneration":9007199254740991.4');
  const unsafe = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${unsafeJson}`,
  );
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok)
    assert.ok(
      unsafe.issues.some((issue) => issue.code === 'integer-token-unsafe'),
    );

  const safeJson = JSON.stringify({
    ...record('select-2', selectedEvent()),
    bundleGeneration: Number.MAX_SAFE_INTEGER,
  });
  const safe = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${safeJson}`,
  );
  assert.equal(safe.ok, true);
});

test('a quoted marker example and an untrusted marker do not create a decision', () => {
  const quoted = comment(
    '1',
    `> ${PROVISIONAL_DECISION_RECORD_MARKER}\n> ${JSON.stringify(record('select-1', selectedEvent()))}`,
    1,
  );
  const untrusted = recordComment('2', record('select-2', selectedEvent()), 2, {
    trustedAuthor: false,
    authorLogin: 'outside-user',
  });
  const result = replayProvisionalDecisionHistory(input([quoted, untrusted]));
  assert.equal(result.valid, true);
  assert.equal(result.status, 'none');
  assert.deepEqual(result.decisions, []);
});

test('a canonical record URL must belong to the GitHub source issue', () => {
  const forgedHost = recordComment(
    '1',
    record('select-1', selectedEvent()),
    1,
    {
      url: 'https://example.invalid/kurone-kito/idd-skill/issues/4599#issuecomment-1',
    },
  );
  const result = replayProvisionalDecisionHistory(input([forgedHost]));
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'record-authority-invalid'),
  );
});

test('rejects duplicate record IDs and edited records', () => {
  const first = recordComment('1', record('same-id', selectedEvent()), 1);
  const duplicate = recordComment(
    '2',
    record('same-id', workStartedEvent()),
    2,
  );
  const duplicateResult = replayProvisionalDecisionHistory(
    input([first, duplicate]),
  );
  assert.equal(duplicateResult.valid, false);
  assert.ok(
    duplicateResult.issues.some(
      (issue) => issue.code === 'duplicate-record-id',
    ),
  );

  const edited = recordComment('3', record('edited', selectedEvent()), 1, {
    edited: true,
  });
  const editedResult = replayProvisionalDecisionHistory(input([edited]));
  assert.equal(editedResult.valid, false);
  assert.ok(
    editedResult.issues.some(
      (issue) => issue.code === 'record-authority-invalid',
    ),
  );
});

test('selected and started work remain distinct from verified completion', () => {
  const selected = recordComment('1', record('select-1', selectedEvent()), 1);
  const selectedResult = replayProvisionalDecisionHistory(input([selected]));
  assert.equal(selectedResult.status, 'selected');

  const started = recordComment('2', record('start-1', workStartedEvent()), 2);
  const startedResult = replayProvisionalDecisionHistory(
    input([selected, started]),
  );
  assert.equal(startedResult.status, 'in-progress');

  const completed = recordComment(
    '3',
    record('complete-1', workCompletedEvent(1)),
    3,
  );
  const completedResult = replayProvisionalDecisionHistory(
    input([selected, started, completed]),
  );
  assert.equal(completedResult.status, 'confirmation-pending');
  assert.equal(completedResult.decisions[0]?.confirmation, undefined);
});

test('a shared-account answer from an authorized recorder confirms a complete bundle and replays without new input', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const answer = answerComment('4', buildAnswer([selected], [completed]), 4);
  const confirmation = record('confirm-1', confirmedEvent(answer));
  const comments = [
    recordComment('1', selected, 1),
    recordComment('2', started, 2),
    recordComment('3', completed, 3),
    answer,
    recordComment('5', confirmation, 5),
  ];
  const replayInput = input(comments);
  const firstReplay = replayProvisionalDecisionHistory(replayInput);
  const laterReplay = replayProvisionalDecisionHistory(replayInput);
  assert.deepEqual(firstReplay, laterReplay);
  assert.equal(firstReplay.valid, true);
  assert.equal(firstReplay.status, 'confirmed');
  assert.equal(firstReplay.decisions[0]?.status, 'confirmed');
});

test('a completed bundle with no new answer remains pending and never prompts during replay', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const result = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      recordComment('3', completed, 3),
    ]),
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, 'confirmation-pending');
});

test('confirmation rejects an ordinary trusted comment without the answer watermark', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const ordinary = comment('4', 'Yes, I accept.', 4);
  const confirmation = record('confirm-1', confirmedEvent(ordinary));
  const result = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      recordComment('3', completed, 3),
      ordinary,
      recordComment('5', confirmation, 5),
    ]),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === 'confirmation-answer-untrusted',
    ),
  );
});

test('confirmation rejects an untrusted or edited answer marker', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const answer = answerComment('4', buildAnswer([selected], [completed]), 4, {
    trustedAuthor: false,
    authorLogin: 'stranger',
  });
  const confirmation = record('confirm-1', confirmedEvent(answer));
  const comments = [
    recordComment('1', selected, 1),
    recordComment('2', started, 2),
    recordComment('3', completed, 3),
    answer,
    recordComment('5', confirmation, 5),
  ];
  const untrustedResult = replayProvisionalDecisionHistory(input(comments));
  assert.equal(untrustedResult.valid, false);

  const edited = {
    ...answer,
    trustedAuthor: true,
    authorLogin: 'kurone-kito',
    edited: true,
  };
  const confirmationComment = comments[4];
  assert.ok(confirmationComment);
  const editedResult = replayProvisionalDecisionHistory(
    input([...comments.slice(0, 3), edited, confirmationComment]),
  );
  assert.equal(editedResult.valid, false);
});

test('confirmation rejects answer scope that does not match the current source and bundle', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const wrongAnswer = {
    ...buildAnswer([selected], [completed]),
    bundleGeneration: 2,
  };
  const answer = answerComment('4', wrongAnswer, 4);
  const confirmation = record('confirm-1', confirmedEvent(answer));
  const result = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      recordComment('3', completed, 3),
      answer,
      recordComment('5', confirmation, 5),
    ]),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'confirmation-scope-mismatch'),
  );
});

test('confirmation requires every decision in a bundle to have verified completion', () => {
  const first = record('select-1', selectedEvent('Question one?', 'keep-1'), 1);
  const second = record(
    'select-2',
    selectedEvent('Question two?', 'keep-2'),
    2,
    1,
  );
  const started = record('start-1', workStartedEvent(), 1);
  const completed = record('complete-1', workCompletedEvent(1), 1);
  const answer = answerComment('6', buildAnswer([first], [completed]), 6);
  const confirmation = record('confirm-1', confirmedEvent(answer));
  const result = replayProvisionalDecisionHistory(
    input([
      recordComment('1', first, 1),
      recordComment('2', second, 2),
      recordComment('3', started, 3),
      recordComment('4', completed, 4),
      answer,
      recordComment('7', confirmation, 7),
    ]),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === 'confirmation-bundle-incomplete',
    ),
  );
});

test('a single scoped answer can confirm every completed decision in a bundle', () => {
  const selectedOne = record(
    'select-1',
    selectedEvent('Question one?', 'keep-1'),
    1,
  );
  const selectedTwo = record(
    'select-2',
    selectedEvent('Question two?', 'keep-2'),
    2,
    1,
  );
  const startedOne = record('start-1', workStartedEvent(), 1);
  const startedTwo = record('start-2', workStartedEvent(), 2, 1);
  const completedOne = record('complete-1', workCompletedEvent(1), 1);
  const completedTwo = record('complete-2', workCompletedEvent(2), 2, 1);
  const answer = answerComment(
    '7',
    buildAnswer([selectedOne, selectedTwo], [completedOne, completedTwo]),
    7,
  );
  const confirmedOne = record('confirm-1', confirmedEvent(answer), 1);
  const confirmedTwo = record('confirm-2', confirmedEvent(answer), 2, 1);
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selectedOne, 1),
        recordComment('2', selectedTwo, 2),
        recordComment('3', startedOne, 3),
        recordComment('4', startedTwo, 4),
        recordComment('5', completedOne, 5),
        recordComment('6', completedTwo, 6),
        answer,
        recordComment('8', confirmedOne, 8),
        recordComment('9', confirmedTwo, 9),
      ],
      { verifiedWork: [workEvidence(1), workEvidence(2)] },
    ),
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, 'confirmed');
  assert.equal(
    result.decisions.filter((decision) => decision.status === 'confirmed')
      .length,
    2,
  );
});

test('completion evidence cannot be reused across decision generations', () => {
  const selectedOne = record('select-1', selectedEvent('Question one?'), 1);
  const selectedTwo = record('select-2', selectedEvent('Question two?'), 2, 1);
  const startedOne = record('start-1', workStartedEvent(), 1);
  const startedTwo = record('start-2', workStartedEvent(), 2, 1);
  const sharedResult = completionResult(1);
  const completedOne = record(
    'complete-1',
    { type: 'work-completed', result: sharedResult },
    1,
  );
  const completedTwo = record(
    'complete-2',
    { type: 'work-completed', result: sharedResult },
    2,
    1,
  );
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selectedOne, 1),
        recordComment('2', selectedTwo, 2),
        recordComment('3', startedOne, 3),
        recordComment('4', startedTwo, 4),
        recordComment('5', completedOne, 5),
        recordComment('6', completedTwo, 6),
      ],
      { verifiedWork: [workEvidence(1)] },
    ),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'work-evidence-insufficient'),
  );
  assert.deepEqual(result.decisions, []);
});

test('a confirmed bundle generation cannot accept a later decision', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const answer = answerComment('4', buildAnswer([selected], [completed]), 4);
  const confirmation = recordComment(
    '5',
    record('confirm-1', confirmedEvent(answer)),
    5,
  );
  const lateSelection = recordComment(
    '6',
    record('select-2', selectedEvent('A later question?'), 2, 1),
    6,
  );
  const result = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      recordComment('3', completed, 3),
      answer,
      confirmation,
      lateSelection,
    ]),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'bundle-generation-closed'),
  );
  assert.deepEqual(result.decisions, []);

  const nextGeneration = recordComment(
    '7',
    record('select-3', selectedEvent('A later question?'), 1, 2),
    7,
  );
  const nextGenerationResult = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      recordComment('3', completed, 3),
      answer,
      confirmation,
      nextGeneration,
    ]),
  );
  assert.equal(nextGenerationResult.valid, true);
  assert.equal(nextGenerationResult.status, 'selected');
  assert.equal(nextGenerationResult.decisions.length, 2);
});

test('a new bundle generation cannot replace an unresolved current bundle', () => {
  const selectedOne = recordComment(
    '1',
    record('select-1', selectedEvent('Question one?'), 1, 1),
    1,
  );
  const selectedTwo = recordComment(
    '2',
    record('select-2', selectedEvent('Question two?'), 1, 2),
    2,
  );
  const result = replayProvisionalDecisionHistory(
    input([selectedOne, selectedTwo]),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'bundle-generation-overlap'),
  );
  assert.deepEqual(result.decisions, []);
});

test('claim takeover can continue a selected decision without duplicating prior transitions', () => {
  const selected = record('select-1', selectedEvent(), 1, 1, [firstClaim]);
  const started = record('start-2', workStartedEvent(), 1, 1, [
    firstClaim,
    secondClaim,
  ]);
  const completed = record('complete-2', workCompletedEvent(1), 1, 1, [
    firstClaim,
    secondClaim,
  ]);
  const answer = answerComment(
    '4',
    buildAnswer([selected], [completed], [firstClaim, secondClaim]),
    4,
  );
  const confirmation = record('confirm-2', confirmedEvent(answer), 1, 1, [
    firstClaim,
    secondClaim,
  ]);
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
        answer,
        recordComment('5', confirmation, 5),
      ],
      {
        verifiedClaimLineage: [firstClaim, secondClaim],
        verifiedWork: [workEvidence()],
      },
    ),
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, 'confirmed');
});

test('alternate-choice rework preserves the completed work link and same source', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const rationale = 'The alternate choice better fits the current need.';
  const answer = answerComment(
    '4',
    buildAnswer(
      [selected],
      [completed],
      [firstClaim],
      'rework',
      'change',
      rationale,
    ),
    4,
  );
  const request = record('rework-1', {
    type: 'rework-requested',
    reworkRequest: {
      commentUrl: answer.url,
      requestedAt: answer.createdAt,
      requestedOptionId: 'change',
      rationale,
    },
  });
  const authored = record('rework-2', {
    type: 'rework-authored',
    reworkRoadmap: {
      roadmapIssueNumber: source.issueNumber,
      roadmapMarkerId: 'same-source-rework',
      authoringSetId: 'set-4599-rework',
      url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
    },
  });
  const base = [
    recordComment('1', selected, 1),
    recordComment('2', started, 2),
    recordComment('3', completed, 3),
    answer,
  ];
  const requested = replayProvisionalDecisionHistory(
    input([...base, recordComment('5', request, 5)]),
  );
  assert.equal(requested.status, 'rework-requested');
  assert.equal(requested.decisions[0]?.workCompleted?.recordId, 'complete-1');

  const authoredResult = replayProvisionalDecisionHistory(
    input([
      ...base,
      recordComment('5', request, 5),
      recordComment('6', authored, 6),
    ]),
  );
  assert.equal(authoredResult.status, 'rework-authored');
  assert.equal(
    authoredResult.decisions[0]?.workCompleted?.recordId,
    'complete-1',
  );
});

test('incomplete or stale evidence grants no replay authority', () => {
  const selected = recordComment('1', record('select-1', selectedEvent()), 1);
  const incomplete = replayProvisionalDecisionHistory(
    input([selected], { completeHistory: false }),
  );
  assert.equal(incomplete.valid, false);

  const staleSource = {
    ...source,
    snapshot: { ...source.snapshot, bodySha256: 'b'.repeat(64) },
  };
  const stale = replayProvisionalDecisionHistory(
    input([selected], { currentSource: staleSource }),
  );
  assert.equal(stale.valid, false);
  assert.deepEqual(stale.decisions, []);

  const { selected: selection, started, completed } = oneCompletedDecision();
  const noEvidence = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selection, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
      ],
      { verifiedWork: [] },
    ),
  );
  assert.equal(noEvidence.valid, false);
  assert.deepEqual(noEvidence.decisions, []);
});

test('replay is deterministic for the same complete server-ordered pages', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const answer = answerComment('4', buildAnswer([selected], [completed]), 4);
  const confirmation = record('confirm-1', confirmedEvent(answer));
  const firstPage = [
    recordComment('1', selected, 1),
    recordComment('2', started, 2),
  ];
  const secondPage = [
    recordComment('3', completed, 3),
    answer,
    recordComment('5', confirmation, 5),
  ];
  const flattened = [...firstPage, ...secondPage];
  assert.deepEqual(
    replayProvisionalDecisionHistory(input([...firstPage, ...secondPage])),
    replayProvisionalDecisionHistory(input(flattened)),
  );
});
