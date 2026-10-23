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
  type VerifiedProvisionalReworkRoadmap,
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
  claimedAt: '2026-10-20T00:00:01.500Z',
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
    verifiedAt: dateAt(2),
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
  recordSource: ProvisionalDecisionSource = source,
): ProvisionalDecisionRecord {
  return {
    schemaVersion: 1,
    recordId,
    source: recordSource,
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

function workEvidence(
  decisionGeneration = 1,
  bundleGeneration = 1,
  evidenceSource: ProvisionalDecisionSource = source,
) {
  const result = completionResult(decisionGeneration);
  return {
    source: evidenceSource,
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
  answerSource: ProvisionalDecisionSource = source,
  bundleGeneration = 1,
): Event {
  const completedByGeneration = new Map(
    completed.map((item) => [item.decisionGeneration, item]),
  );
  const ordered = [...selected].sort(
    (left, right) => left.decisionGeneration - right.decisionGeneration,
  );
  return {
    schemaVersion: 1,
    source: answerSource,
    bundleGeneration,
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
    verifiedReworkRoadmaps: [],
    ...extra,
  };
}

function reworkEvidence(
  recordId: string,
  sourceBefore: ProvisionalDecisionSource = source,
  sourceAfter: ProvisionalDecisionSource = source,
  publishedAt = dateAt(5),
): VerifiedProvisionalReworkRoadmap {
  return {
    recordId,
    sourceBefore,
    sourceAfter,
    roadmapIssueNumber: source.issueNumber,
    roadmapMarkerId: 'same-source-rework',
    authoringSetId: 'set-4599-rework',
    url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
    publishedCommentId: `${recordId}-publication`,
    publishedAt,
  };
}

function reworkPublicationComment(
  recordId: string,
  createdAt = dateAt(5),
): ProvisionalDecisionComment {
  return comment(
    `${recordId}-publication`,
    '<!-- idd-skill-authoring-publication: rework -->',
    5,
    { createdAt },
  );
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

test('rejects URLs containing whitespace that URL would silently trim', () => {
  const started = record('start-1', {
    ...workStartedEvent(),
    planReference:
      ' https://github.com/kurone-kito/idd-skill/issues/4599#issuecomment-1 ',
  });
  const parsed = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(started)}`,
  );
  assert.equal(parsed.ok, false);
  if (!parsed.ok)
    assert.ok(parsed.issues.some((issue) => issue.code === 'url-required'));
});

test('rejects duplicate JSON object keys, including escaped duplicates', () => {
  const serialized = JSON.stringify(record('select-1', selectedEvent()));
  const duplicateVersion = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${serialized.replace(
      '"schemaVersion":1',
      '"schema\\u0056ersion":2,"schemaVersion":1',
    )}`,
  );
  assert.equal(duplicateVersion.ok, false);
  if (!duplicateVersion.ok)
    assert.ok(
      duplicateVersion.issues.some(
        (issue) => issue.code === 'json-duplicate-key',
      ),
    );

  const duplicateNestedKey = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${serialized.replace(
      '"repository":"kurone-kito/idd-skill"',
      '"repository":"other/repo","repository":"kurone-kito/idd-skill"',
    )}`,
  );
  assert.equal(duplicateNestedKey.ok, false);
  if (!duplicateNestedKey.ok)
    assert.ok(
      duplicateNestedKey.issues.some(
        (issue) => issue.code === 'json-duplicate-key',
      ),
    );
});

test('rejects impossible calendar dates and out-of-range clock fields', () => {
  const base = record('select-1', selectedEvent());
  const invalidDates = [
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-01-01T24:00:00Z',
  ];
  for (const updatedAt of invalidDates) {
    const parsed = parseProvisionalDecisionRecordComment(
      `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify({
        ...base,
        source: {
          ...source,
          snapshot: { ...source.snapshot, updatedAt },
        },
      })}`,
    );
    assert.equal(parsed.ok, false, updatedAt);
    if (!parsed.ok)
      assert.ok(
        parsed.issues.some((issue) => issue.code === 'date-time-required'),
        updatedAt,
      );
  }

  const leapDay = parseProvisionalDecisionRecordComment(
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify({
      ...base,
      source: {
        ...source,
        snapshot: {
          ...source.snapshot,
          updatedAt: '2024-02-29T23:59:59Z',
        },
      },
    })}`,
  );
  assert.equal(leapDay.ok, true);

  const invalidCommentDate = replayProvisionalDecisionHistory(
    input([
      recordComment('invalid-created-at', base, 1, {
        createdAt: '2026-02-30T00:00:00Z',
      }),
    ]),
  );
  assert.equal(invalidCommentDate.valid, false);
  assert.ok(
    invalidCommentDate.issues.some(
      (issue) =>
        issue.code === 'date-time-required' &&
        issue.path === 'comments[invalid-created-at].createdAt',
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

test('repository identity and issue URLs ignore GitHub capitalization', () => {
  const currentSource = { ...source, repository: 'Kurone-Kito/IDD-Skill' };
  const result = replayProvisionalDecisionHistory(
    input([recordComment('1', record('select-1', selectedEvent()), 1)], {
      currentSource,
    }),
  );
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'selected');
});

test('answer references resolve when GitHub owner and repository casing differs', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const acceptedAnswer = answerComment(
    '4',
    buildAnswer([selected], [completed]),
    4,
  );
  const confirmation = record('confirm-1', {
    type: 'confirmed',
    confirmation: {
      commentUrl: acceptedAnswer.url.replace(
        '/kurone-kito/idd-skill/',
        '/Kurone-Kito/IDD-Skill/',
      ),
      response: 'accepted',
      confirmedAt: acceptedAnswer.createdAt,
      confirmedBy: 'Operator',
    },
  });
  const confirmed = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      recordComment('3', completed, 3),
      acceptedAnswer,
      recordComment('5', confirmation, 5),
    ]),
  );
  assert.equal(confirmed.valid, true, JSON.stringify(confirmed.issues));
  assert.equal(confirmed.status, 'confirmed');

  const rationale = 'The alternate better fits the current need.';
  const reworkAnswer = answerComment(
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
      commentUrl: reworkAnswer.url.replace(
        '/kurone-kito/idd-skill/',
        '/Kurone-Kito/IDD-Skill/',
      ),
      requestedAt: reworkAnswer.createdAt,
      requestedOptionId: 'change',
      rationale,
    },
  });
  const reworkRequested = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      recordComment('3', completed, 3),
      reworkAnswer,
      recordComment('5', request, 5),
    ]),
  );
  assert.equal(
    reworkRequested.valid,
    true,
    JSON.stringify(reworkRequested.issues),
  );
  assert.equal(reworkRequested.status, 'rework-requested');
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

test('unchanged source content remains bound after issue activity timestamps move', () => {
  const currentSource = {
    ...source,
    snapshot: { ...source.snapshot, updatedAt: dateAt(2) },
  };
  const result = replayProvisionalDecisionHistory(
    input([recordComment('1', record('select-1', selectedEvent()), 1)], {
      currentSource,
    }),
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, 'selected');
});

test('work evidence remains bound when only issue activity timestamps move', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const currentSource = {
    ...source,
    snapshot: { ...source.snapshot, updatedAt: dateAt(4) },
  };
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
      ],
      {
        currentSource,
        verifiedWork: [workEvidence(1, 1, currentSource)],
      },
    ),
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, 'confirmation-pending');
});

test('confirmation rejects an answer posted before a completed-work record', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const answer = answerComment('3', buildAnswer([selected], [completed]), 2);
  const confirmation = record('confirm-1', confirmedEvent(answer));
  const result = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      answer,
      recordComment('4', completed, 3),
      recordComment('5', confirmation, 5),
    ]),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'confirmation-time-mismatch'),
  );
});

test('server order settles an answer and completion with equal timestamps', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const answer = answerComment('4', buildAnswer([selected], [completed]), 3);
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
  assert.equal(result.valid, true);
  assert.equal(result.status, 'confirmed');
});

test('server order rejects an equal-timestamp answer before a completion', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const answer = answerComment(
    'answer',
    buildAnswer([selected], [completed]),
    3,
  );
  const confirmation = record('confirm-1', confirmedEvent(answer));
  const result = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      answer,
      recordComment('4', completed, 3),
      recordComment('5', confirmation, 5),
    ]),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'confirmation-time-mismatch'),
  );
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

test('completion cannot precede the verification timestamp it records', () => {
  const { selected, started } = oneCompletedDecision();
  const futureReference = 'https://example.invalid/deliverable';
  const futureResult = {
    kind: 'other',
    reference: futureReference,
    verifiedAt: dateAt(4),
  };
  const completed = record('complete-before-verification', {
    type: 'work-completed',
    result: futureResult,
  });
  const answer = answerComment(
    'answer-after-premature-completion',
    buildAnswer([selected], [completed]),
    5,
  );
  const confirmation = record(
    'confirm-premature-completion',
    confirmedEvent(answer),
  );
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
        answer,
        recordComment('6', confirmation, 6),
      ],
      {
        verifiedWork: [
          {
            ...workEvidence(),
            reference: futureReference,
            verifiedAt: dateAt(4),
          },
        ],
      },
    ),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === 'work-verification-order-invalid',
    ),
  );
  assert.deepEqual(result.decisions, []);
});

test('timestamp comparisons preserve sub-millisecond precision', () => {
  const { selected, started } = oneCompletedDecision();
  const completionTime = '2026-10-20T00:00:03.0001Z';
  const verifiedAt = '2026-10-20T00:00:03.0009Z';
  const reference = 'https://example.invalid/sub-millisecond-deliverable';
  const completed = record('complete-sub-millisecond', {
    type: 'work-completed',
    result: { kind: 'other', reference, verifiedAt },
  });
  const completionOrder = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3, { createdAt: completionTime }),
      ],
      {
        verifiedWork: [
          {
            ...workEvidence(),
            reference,
            verifiedAt,
          },
        ],
      },
    ),
  );
  assert.equal(completionOrder.valid, false);
  assert.ok(
    completionOrder.issues.some(
      (issue) => issue.code === 'work-verification-order-invalid',
    ),
  );

  const {
    selected: confirmedSelection,
    started: confirmedStart,
    completed: confirmedWork,
  } = oneCompletedDecision();
  const answer = answerComment(
    'answer-sub-millisecond',
    buildAnswer([confirmedSelection], [confirmedWork]),
    4,
    { createdAt: '2026-10-20T00:00:04.0009Z' },
  );
  const confirmationEvent = confirmedEvent(answer);
  const confirmation = record('confirm-sub-millisecond', {
    ...confirmationEvent,
    confirmation: {
      ...(confirmationEvent.confirmation as Event),
      confirmedAt: '2026-10-20T00:00:04.0001Z',
    },
  });
  const confirmationOrder = replayProvisionalDecisionHistory(
    input([
      recordComment('1', confirmedSelection, 1),
      recordComment('2', confirmedStart, 2),
      recordComment('3', confirmedWork, 3),
      answer,
      recordComment('5', confirmation, 5),
    ]),
  );
  assert.equal(confirmationOrder.valid, false);
  assert.ok(
    confirmationOrder.issues.some(
      (issue) => issue.code === 'confirmation-time-mismatch',
    ),
  );

  const rationale = 'The alternate option is preferable.';
  const reworkAnswer = answerComment(
    'rework-answer-sub-millisecond',
    buildAnswer(
      [confirmedSelection],
      [confirmedWork],
      [firstClaim],
      'rework',
      'change',
      rationale,
    ),
    4,
    { createdAt: '2026-10-20T00:00:04.0009Z' },
  );
  const reworkRequest = record('rework-request-sub-millisecond', {
    type: 'rework-requested',
    reworkRequest: {
      commentUrl: reworkAnswer.url,
      requestedAt: '2026-10-20T00:00:04.0001Z',
      requestedOptionId: 'change',
      rationale,
    },
  });
  const reworkOrder = replayProvisionalDecisionHistory(
    input([
      recordComment('1', confirmedSelection, 1),
      recordComment('2', confirmedStart, 2),
      recordComment('3', confirmedWork, 3),
      reworkAnswer,
      recordComment('5', reworkRequest, 5),
    ]),
  );
  assert.equal(reworkOrder.valid, false);
  assert.ok(
    reworkOrder.issues.some(
      (issue) => issue.code === 'rework-answer-scope-mismatch',
    ),
  );
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

test('a confirmed answer keeps its event-time claim lineage after a later takeover', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const answer = answerComment(
    '4',
    buildAnswer([selected], [completed], [firstClaim]),
    4,
  );
  const confirmation = record('confirm-1', confirmedEvent(answer), 1, 1, [
    firstClaim,
  ]);
  const laterClaim = { ...secondClaim, claimedAt: dateAt(6) };
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
        answer,
        recordComment('5', confirmation, 5),
      ],
      { verifiedClaimLineage: [firstClaim, laterClaim] },
    ),
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, 'confirmed');
});

test('a confirmation after takeover keeps the answer claim lineage from its own event time', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const takeover = {
    ...secondClaim,
    claimedAt: dateAt(4),
    commentId: 'takeover-marker',
  };
  const takeoverRecordClaim = {
    ...secondClaim,
    claimedAt: dateAt(4),
  };
  const answer = answerComment(
    'answer-before-takeover',
    buildAnswer([selected], [completed], [firstClaim]),
    4,
  );
  const confirmation = record(
    'confirm-after-takeover',
    confirmedEvent(answer),
    1,
    1,
    [firstClaim, takeoverRecordClaim],
  );
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
        answer,
        comment('takeover-marker', 'verified takeover marker', 4),
        recordComment('5', confirmation, 5),
      ],
      { verifiedClaimLineage: [firstClaim, takeover] },
    ),
  );
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'confirmed');
});

test('an answer cannot cite a claim that starts later in server order', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const takeover = {
    ...secondClaim,
    claimedAt: dateAt(4),
    commentId: 'takeover-marker',
  };
  const takeoverRecordClaim = {
    ...secondClaim,
    claimedAt: dateAt(4),
  };
  const answer = answerComment(
    'answer-before-takeover',
    buildAnswer([selected], [completed], [firstClaim, takeoverRecordClaim]),
    4,
  );
  const confirmation = record(
    'confirm-after-takeover',
    confirmedEvent(answer),
    1,
    1,
    [firstClaim, takeoverRecordClaim],
  );
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
        answer,
        comment('takeover-marker', 'verified takeover marker', 4),
        recordComment('5', confirmation, 5),
      ],
      { verifiedClaimLineage: [firstClaim, takeover] },
    ),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'confirmation-scope-mismatch'),
  );
});

test('a new record cannot use a superseded claim after takeover', () => {
  const selected = recordComment('1', record('select-1', selectedEvent()), 1);
  const started = recordComment(
    '2',
    record('start-2', workStartedEvent(), 1, 1, [firstClaim]),
    2,
  );
  const result = replayProvisionalDecisionHistory(
    input([selected, started], {
      verifiedClaimLineage: [firstClaim, secondClaim],
    }),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'claim-binding-mismatch'),
  );
});

test('a claim and record in the same second use server comment order', () => {
  const claim = { ...firstClaim, claimedAt: dateAt(1) };
  const verifiedClaim = { ...claim, commentId: 'claim-marker' };
  const claimComment = comment('claim-marker', 'verified claim marker', 1);
  const selection = recordComment(
    'selection',
    record('select-1', selectedEvent(), 1, 1, [claim]),
    1,
  );
  const result = replayProvisionalDecisionHistory(
    input([claimComment, selection], {
      verifiedClaimLineage: [verifiedClaim],
    }),
  );
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'selected');

  const recordBeforeClaim = replayProvisionalDecisionHistory(
    input([selection, claimComment], {
      verifiedClaimLineage: [verifiedClaim],
    }),
  );
  assert.equal(recordBeforeClaim.valid, false);
  assert.ok(
    recordBeforeClaim.issues.some(
      (issue) => issue.code === 'claim-binding-mismatch',
    ),
  );
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
    input(
      [
        ...base,
        recordComment('5', request, 5),
        reworkPublicationComment('rework-2'),
        recordComment('6', authored, 6),
      ],
      {
        verifiedReworkRoadmaps: [reworkEvidence('rework-2')],
      },
    ),
  );
  assert.equal(authoredResult.status, 'rework-authored');
  assert.equal(
    authoredResult.decisions[0]?.workCompleted?.recordId,
    'complete-1',
  );
});

test('a rework-authored decision rejects later work and rework lifecycle events', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const rationale = 'The alternate choice better fits the current need.';
  const answer = answerComment(
    'terminal-answer',
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
  const request = record('terminal-request', {
    type: 'rework-requested',
    reworkRequest: {
      commentUrl: answer.url,
      requestedAt: answer.createdAt,
      requestedOptionId: 'change',
      rationale,
    },
  });
  const authored = record('terminal-authored', {
    type: 'rework-authored',
    reworkRoadmap: {
      roadmapIssueNumber: source.issueNumber,
      roadmapMarkerId: 'same-source-rework',
      authoringSetId: 'set-4599-rework',
      url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
    },
  });
  const history = [
    recordComment('1', selected, 1),
    recordComment('2', started, 2),
    recordComment('3', completed, 3),
    answer,
    recordComment('5', request, 5),
    reworkPublicationComment('terminal-authored'),
    recordComment('6', authored, 6),
  ];
  const lateEvents: readonly [string, Event, string][] = [
    ['late-start', workStartedEvent(), 'work-started-conflict'],
    ['late-completion', workCompletedEvent(1), 'work-completion-order-invalid'],
    [
      'late-request',
      {
        type: 'rework-requested',
        reworkRequest: {
          commentUrl: answer.url,
          requestedAt: answer.createdAt,
          requestedOptionId: 'change',
          rationale,
        },
      },
      'rework-request-order-invalid',
    ],
  ];
  for (const [recordId, event, issueCode] of lateEvents) {
    const result = replayProvisionalDecisionHistory(
      input([...history, recordComment(recordId, record(recordId, event), 7)], {
        verifiedReworkRoadmaps: [reworkEvidence('terminal-authored')],
      }),
    );
    assert.equal(result.valid, false, recordId);
    assert.ok(
      result.issues.some((issue) => issue.code === issueCode),
      recordId,
    );
  }
});

test('rework authoring validates a same-issue source rewrite against independent evidence', () => {
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
  const sourceAfter = {
    ...source,
    snapshot: {
      ...source.snapshot,
      bodySha256: 'c'.repeat(64),
      updatedAt: dateAt(6),
    },
  };
  const authored = {
    ...record('rework-2', {
      type: 'rework-authored',
      reworkRoadmap: {
        roadmapIssueNumber: source.issueNumber,
        roadmapMarkerId: 'same-source-rework',
        authoringSetId: 'set-4599-rework',
        url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
      },
    }),
    source: sourceAfter,
  };
  const requestComment = recordComment('5', request, 5);
  const authoredComment = recordComment('6', authored, 6);
  const comments = [
    recordComment('1', selected, 1),
    recordComment('2', started, 2),
    recordComment('3', completed, 3),
    answer,
    requestComment,
    reworkPublicationComment('rework-2'),
    authoredComment,
  ];
  const withoutEvidence = replayProvisionalDecisionHistory(
    input(comments, { currentSource: sourceAfter }),
  );
  assert.equal(withoutEvidence.valid, false);
  assert.ok(
    withoutEvidence.issues.some(
      (issue) => issue.code === 'source-binding-mismatch',
    ),
  );

  const withEvidence = replayProvisionalDecisionHistory(
    input(comments, {
      currentSource: sourceAfter,
      verifiedReworkRoadmaps: [
        {
          ...reworkEvidence('rework-2', source, sourceAfter),
          url: 'https://github.com/Kurone-Kito/IDD-Skill/issues/4599',
        },
      ],
    }),
  );
  assert.equal(withEvidence.valid, true);
  assert.equal(withEvidence.status, 'rework-authored');

  for (const publishedAt of [dateAt(5), dateAt(6)]) {
    const publicationComment = reworkPublicationComment(
      'rework-2',
      publishedAt,
    );
    const publicationHistory =
      publishedAt === dateAt(5)
        ? [
            ...comments.slice(0, 4),
            publicationComment,
            requestComment,
            authoredComment,
          ]
        : [...comments.slice(0, 5), authoredComment, publicationComment];
    const afterPublication = replayProvisionalDecisionHistory(
      input(publicationHistory, {
        currentSource: sourceAfter,
        verifiedReworkRoadmaps: [
          {
            ...reworkEvidence('rework-2', source, sourceAfter),
            publishedAt,
          },
        ],
      }),
    );
    assert.equal(afterPublication.valid, false);
    assert.ok(
      afterPublication.issues.some(
        (issue) =>
          issue.code === 'rework-roadmap-unverified' ||
          issue.code === 'source-binding-mismatch',
      ),
      JSON.stringify(afterPublication.issues),
    );
  }
});

test('rework authoring cannot transition between different source issues', () => {
  const foreignSource = { ...source, issueNumber: source.issueNumber + 1 };
  const selected = record(
    'select-foreign',
    selectedEvent(),
    1,
    1,
    [firstClaim],
    foreignSource,
  );
  const started = record(
    'start-foreign',
    workStartedEvent(),
    1,
    1,
    [firstClaim],
    foreignSource,
  );
  const completed = record(
    'complete-foreign',
    workCompletedEvent(1),
    1,
    1,
    [firstClaim],
    foreignSource,
  );
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
      foreignSource,
    ),
    4,
  );
  const request = record(
    'rework-foreign',
    {
      type: 'rework-requested',
      reworkRequest: {
        commentUrl: answer.url,
        requestedAt: answer.createdAt,
        requestedOptionId: 'change',
        rationale,
      },
    },
    1,
    1,
    [firstClaim],
    foreignSource,
  );
  const authored = record('rework-authored-foreign', {
    type: 'rework-authored',
    reworkRoadmap: {
      roadmapIssueNumber: source.issueNumber,
      roadmapMarkerId: 'same-source-rework',
      authoringSetId: 'set-4599-rework',
      url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
    },
  });

  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
        answer,
        recordComment('5', request, 5),
        recordComment('6', authored, 6),
      ],
      {
        verifiedWork: [workEvidence(1, 1, foreignSource)],
        verifiedReworkRoadmaps: [
          reworkEvidence('rework-authored-foreign', foreignSource, source),
        ],
      },
    ),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'source-binding-mismatch'),
  );
});

test('rework rejects answers posted before completed work', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const rationale = 'The alternate choice better fits the current need.';
  const answer = answerComment(
    '3',
    buildAnswer(
      [selected],
      [completed],
      [firstClaim],
      'rework',
      'change',
      rationale,
    ),
    2,
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
  const result = replayProvisionalDecisionHistory(
    input([
      recordComment('1', selected, 1),
      recordComment('2', started, 2),
      answer,
      recordComment('4', completed, 3),
      recordComment('5', request, 5),
    ]),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === 'rework-answer-scope-mismatch',
    ),
  );
});

test('rework answers bind to the claim lineage of the citing record', () => {
  const { selected, started, completed } = oneCompletedDecision();
  const laterClaim = { ...secondClaim, claimedAt: dateAt(4) };
  const rationale = 'The alternate choice better fits the current need.';
  const answer = answerComment(
    'answer',
    buildAnswer(
      [selected],
      [completed],
      [firstClaim, laterClaim],
      'rework',
      'change',
      rationale,
    ),
    5,
  );
  const request = record(
    'rework-1',
    {
      type: 'rework-requested',
      reworkRequest: {
        commentUrl: answer.url,
        requestedAt: answer.createdAt,
        requestedOptionId: 'change',
        rationale,
      },
    },
    1,
    1,
    [firstClaim, laterClaim],
  );
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
        answer,
        recordComment('6', request, 6),
      ],
      { verifiedClaimLineage: [firstClaim, laterClaim] },
    ),
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, 'rework-requested');
});

test('one authored rework does not close an incomplete multi-decision bundle', () => {
  const selectedOne = record('select-one', selectedEvent(), 1, 1);
  const selectedTwo = record(
    'select-two',
    selectedEvent('Question two?'),
    2,
    1,
  );
  const startedOne = record('start-one', workStartedEvent(), 1, 1);
  const startedTwo = record('start-two', workStartedEvent(), 2, 1);
  const completedOne = record('complete-one', workCompletedEvent(1), 1, 1);
  const completedTwo = record('complete-two', workCompletedEvent(2), 2, 1);
  const rationale = 'The alternate better fits the updated need.';
  const answer = answerComment(
    '7',
    buildAnswer(
      [selectedOne, selectedTwo],
      [completedOne, completedTwo],
      [firstClaim],
      'rework',
      'change',
      rationale,
    ),
    4,
  );
  const request = record('rework-one', {
    type: 'rework-requested',
    reworkRequest: {
      commentUrl: answer.url,
      requestedAt: answer.createdAt,
      requestedOptionId: 'change',
      rationale,
    },
  });
  const authored = record('rework-authored-one', {
    type: 'rework-authored',
    reworkRoadmap: {
      roadmapIssueNumber: source.issueNumber,
      roadmapMarkerId: 'same-source-rework',
      authoringSetId: 'set-4599-rework',
      url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
    },
  });
  const nextSelection = record('select-next-bundle', selectedEvent(), 1, 2);
  const priorHistory = [
    recordComment('1', selectedOne, 1),
    recordComment('2', selectedTwo, 1),
    recordComment('3', startedOne, 2),
    recordComment('4', startedTwo, 2),
    recordComment('5', completedOne, 3),
    recordComment('6', completedTwo, 3),
    answer,
    recordComment('8', request, 5),
    reworkPublicationComment('rework-authored-one'),
    recordComment('9', authored, 6),
  ];
  const partialRework = replayProvisionalDecisionHistory(
    input(priorHistory, {
      verifiedWork: [workEvidence(1), workEvidence(2)],
      verifiedReworkRoadmaps: [reworkEvidence('rework-authored-one')],
    }),
  );
  assert.equal(partialRework.valid, true);
  assert.equal(partialRework.status, 'rework-requested');

  const result = replayProvisionalDecisionHistory(
    input([...priorHistory, recordComment('10', nextSelection, 7)], {
      verifiedWork: [workEvidence(1), workEvidence(2)],
      verifiedReworkRoadmaps: [reworkEvidence('rework-authored-one')],
    }),
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === 'bundle-generation-overlap'),
  );
});

test('confirmation and rework can settle separate decisions in one bundle', () => {
  for (const scenario of [
    'rework-first',
    'confirmation-first',
    'rework-authored-first',
  ] as const) {
    const sourceAfterRework =
      scenario === 'rework-authored-first'
        ? {
            ...source,
            snapshot: {
              ...source.snapshot,
              bodySha256: 'b'.repeat(64),
              updatedAt: dateAt(6),
            },
          }
        : source;
    const selectedOne = record(
      `${scenario}-select-one`,
      selectedEvent('Question one?'),
      1,
      1,
    );
    const selectedTwo = record(
      `${scenario}-select-two`,
      selectedEvent('Question two?'),
      2,
      1,
    );
    const startedOne = record(
      `${scenario}-start-one`,
      workStartedEvent(),
      1,
      1,
    );
    const startedTwo = record(
      `${scenario}-start-two`,
      workStartedEvent(),
      2,
      1,
    );
    const completedOne = record(
      `${scenario}-complete-one`,
      workCompletedEvent(1),
      1,
      1,
    );
    const completedTwo = record(
      `${scenario}-complete-two`,
      workCompletedEvent(2),
      2,
      1,
    );
    const acceptedAnswer = answerComment(
      `${scenario}-accepted-answer`,
      {
        ...buildAnswer(
          [selectedOne, selectedTwo],
          [completedOne, completedTwo],
          [firstClaim],
          'accepted',
          undefined,
          undefined,
          sourceAfterRework,
        ),
        answerText: 'I accept the completed choice for decision one.',
      },
      scenario === 'confirmation-first' ? 4 : 7,
    );
    const confirmation = record(
      `${scenario}-confirmation-one`,
      confirmedEvent(acceptedAnswer),
      1,
      1,
      [firstClaim],
      sourceAfterRework,
    );
    const rationale = 'The alternate better fits this decision.';
    const publicationAt =
      scenario === 'confirmation-first'
        ? '2026-10-20T00:00:07Z'
        : '2026-10-20T00:00:05Z';
    const reworkAnswer = answerComment(
      `${scenario}-rework-answer`,
      {
        ...buildAnswer(
          [selectedOne, selectedTwo],
          [completedOne, completedTwo],
          [firstClaim],
          'rework',
          'change',
          rationale,
        ),
        answerText: 'I prefer the alternate option for decision two.',
      },
      scenario === 'confirmation-first' ? 6 : 4,
    );
    const request = record(
      `${scenario}-rework-request-two`,
      {
        type: 'rework-requested',
        reworkRequest: {
          commentUrl: reworkAnswer.url,
          requestedAt: reworkAnswer.createdAt,
          requestedOptionId: 'change',
          rationale,
        },
      },
      2,
      1,
    );
    const authored = record(
      `${scenario}-rework-authored-two`,
      {
        type: 'rework-authored',
        reworkRoadmap: {
          roadmapIssueNumber: source.issueNumber,
          roadmapMarkerId: 'same-source-rework',
          authoringSetId: 'set-4599-rework',
          url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
        },
      },
      2,
      1,
      [firstClaim],
      sourceAfterRework,
    );
    const nextSelection = record(
      `${scenario}-select-next-bundle`,
      selectedEvent('Next bundle question?'),
      1,
      2,
      [firstClaim],
      sourceAfterRework,
    );
    const history = [
      recordComment('1', selectedOne, 1),
      recordComment('2', selectedTwo, 1),
      recordComment('3', startedOne, 2),
      recordComment('4', startedTwo, 2),
      recordComment('5', completedOne, 3),
      recordComment('6', completedTwo, 3),
    ];
    if (scenario === 'rework-first') {
      history.push(
        reworkAnswer,
        recordComment('8', request, 5),
        reworkPublicationComment(
          `${scenario}-rework-authored-two`,
          publicationAt,
        ),
        acceptedAnswer,
        recordComment('10', confirmation, 7),
      );
    } else if (scenario === 'confirmation-first') {
      history.push(
        acceptedAnswer,
        recordComment('8', confirmation, 5),
        reworkAnswer,
        recordComment('10', request, 7),
        reworkPublicationComment(
          `${scenario}-rework-authored-two`,
          publicationAt,
        ),
      );
    } else {
      history.push(
        reworkAnswer,
        recordComment('8', request, 5),
        reworkPublicationComment(
          `${scenario}-rework-authored-two`,
          publicationAt,
        ),
        recordComment('10', authored, 6),
        acceptedAnswer,
        recordComment('13', confirmation, 8),
      );
    }
    if (scenario !== 'rework-authored-first')
      history.push(recordComment('11', authored, 8));
    history.push(recordComment('14', nextSelection, 9));
    const result = replayProvisionalDecisionHistory(
      input(history, {
        currentSource: sourceAfterRework,
        verifiedWork: [workEvidence(1), workEvidence(2)],
        verifiedReworkRoadmaps: [
          reworkEvidence(
            `${scenario}-rework-authored-two`,
            source,
            sourceAfterRework,
            publicationAt,
          ),
        ],
      }),
    );
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.equal(result.status, 'selected');
    assert.deepEqual(
      result.decisions
        .filter((decision) => decision.bundleGeneration === 1)
        .map((decision) => decision.status),
      ['confirmed', 'rework-authored'],
    );
  }
});

test('every decision can finish rework before the next bundle starts', () => {
  const selectedOne = record('select-one', selectedEvent(), 1, 1);
  const selectedTwo = record(
    'select-two',
    selectedEvent('Question two?'),
    2,
    1,
  );
  const startedOne = record('start-one', workStartedEvent(), 1, 1);
  const startedTwo = record('start-two', workStartedEvent(), 2, 1);
  const completedOne = record('complete-one', workCompletedEvent(1), 1, 1);
  const completedTwo = record('complete-two', workCompletedEvent(2), 2, 1);
  const rationale = 'The alternate better fits the updated need.';
  const answer = answerComment(
    'answer',
    buildAnswer(
      [selectedOne, selectedTwo],
      [completedOne, completedTwo],
      [firstClaim],
      'rework',
      'change',
      rationale,
    ),
    4,
  );
  const requestOne = record('rework-one', {
    type: 'rework-requested',
    reworkRequest: {
      commentUrl: answer.url,
      requestedAt: answer.createdAt,
      requestedOptionId: 'change',
      rationale,
    },
  });
  const requestTwo = record(
    'rework-two',
    {
      type: 'rework-requested',
      reworkRequest: {
        commentUrl: answer.url,
        requestedAt: answer.createdAt,
        requestedOptionId: 'change',
        rationale,
      },
    },
    2,
  );
  const authoredOne = record('authored-one', {
    type: 'rework-authored',
    reworkRoadmap: {
      roadmapIssueNumber: source.issueNumber,
      roadmapMarkerId: 'same-source-rework',
      authoringSetId: 'set-4599-rework',
      url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
    },
  });
  const authoredTwo = record(
    'authored-two',
    {
      type: 'rework-authored',
      reworkRoadmap: {
        roadmapIssueNumber: source.issueNumber,
        roadmapMarkerId: 'same-source-rework',
        authoringSetId: 'set-4599-rework',
        url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
      },
    },
    2,
  );
  const nextSelection = record('select-next-bundle', selectedEvent(), 1, 2);
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selectedOne, 1),
        recordComment('2', selectedTwo, 1),
        recordComment('3', startedOne, 2),
        recordComment('4', startedTwo, 2),
        recordComment('5', completedOne, 3),
        recordComment('6', completedTwo, 3),
        answer,
        recordComment('8', requestOne, 5),
        reworkPublicationComment('authored-one'),
        recordComment('9', requestTwo, 6),
        reworkPublicationComment('authored-two', dateAt(6)),
        recordComment('10', authoredOne, 7),
        recordComment('11', authoredTwo, 8),
        recordComment('12', nextSelection, 9),
      ],
      {
        verifiedWork: [workEvidence(1), workEvidence(2)],
        verifiedReworkRoadmaps: [
          reworkEvidence('authored-one'),
          reworkEvidence('authored-two', source, source, dateAt(6)),
        ],
      },
    ),
  );
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'selected');
  assert.equal(result.decisions.length, 3);
});

test('source rewrites chain across rework bundles and permit a later generation', () => {
  const firstSourceAfter = {
    ...source,
    snapshot: {
      ...source.snapshot,
      bodySha256: 'b'.repeat(64),
      updatedAt: dateAt(6),
    },
  };
  const secondSourceAfter = {
    ...source,
    snapshot: {
      ...source.snapshot,
      bodySha256: 'c'.repeat(64),
      updatedAt: dateAt(12),
    },
  };
  const { selected, started, completed } = oneCompletedDecision();
  const firstRationale = 'The alternate choice better fits the current need.';
  const firstAnswer = answerComment(
    'answer-one',
    buildAnswer(
      [selected],
      [completed],
      [firstClaim],
      'rework',
      'change',
      firstRationale,
    ),
    4,
  );
  const firstRequest = record('request-one', {
    type: 'rework-requested',
    reworkRequest: {
      commentUrl: firstAnswer.url,
      requestedAt: firstAnswer.createdAt,
      requestedOptionId: 'change',
      rationale: firstRationale,
    },
  });
  const firstAuthored = {
    ...record('authored-one', {
      type: 'rework-authored',
      reworkRoadmap: {
        roadmapIssueNumber: source.issueNumber,
        roadmapMarkerId: 'same-source-rework',
        authoringSetId: 'set-4599-rework',
        url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
      },
    }),
    source: firstSourceAfter,
  };
  const selectedTwo = record(
    'select-two',
    selectedEvent('Question for the second bundle?'),
    1,
    2,
    [firstClaim],
    firstSourceAfter,
  );
  const startedTwo = record(
    'start-two',
    workStartedEvent(),
    1,
    2,
    [firstClaim],
    firstSourceAfter,
  );
  const completedTwo = record(
    'complete-two',
    workCompletedEvent(1),
    1,
    2,
    [firstClaim],
    firstSourceAfter,
  );
  const secondRationale = 'A different alternative better fits the new need.';
  const secondAnswer = answerComment(
    'answer-two',
    buildAnswer(
      [selectedTwo],
      [completedTwo],
      [firstClaim],
      'rework',
      'change',
      secondRationale,
      firstSourceAfter,
      2,
    ),
    10,
  );
  const secondRequest = record(
    'request-two',
    {
      type: 'rework-requested',
      reworkRequest: {
        commentUrl: secondAnswer.url,
        requestedAt: secondAnswer.createdAt,
        requestedOptionId: 'change',
        rationale: secondRationale,
      },
    },
    1,
    2,
    [firstClaim],
    firstSourceAfter,
  );
  const secondAuthored = {
    ...record(
      'authored-two',
      {
        type: 'rework-authored',
        reworkRoadmap: {
          roadmapIssueNumber: source.issueNumber,
          roadmapMarkerId: 'same-source-rework',
          authoringSetId: 'set-4599-rework',
          url: `https://github.com/${source.repository}/issues/${source.issueNumber}`,
        },
      },
      1,
      2,
      [firstClaim],
      secondSourceAfter,
    ),
    source: secondSourceAfter,
  };
  const selectedThree = record(
    'select-three',
    selectedEvent('Question for the third bundle?'),
    1,
    3,
    [firstClaim],
    secondSourceAfter,
  );
  const result = replayProvisionalDecisionHistory(
    input(
      [
        recordComment('1', selected, 1),
        recordComment('2', started, 2),
        recordComment('3', completed, 3),
        firstAnswer,
        recordComment('5', firstRequest, 5),
        reworkPublicationComment('authored-one'),
        recordComment('6', firstAuthored, 6),
        recordComment('7', selectedTwo, 7),
        recordComment('8', startedTwo, 8),
        recordComment('9', completedTwo, 9),
        secondAnswer,
        recordComment('11', secondRequest, 11),
        reworkPublicationComment('authored-two', dateAt(11)),
        recordComment('12', secondAuthored, 12),
        recordComment('13', selectedThree, 13),
      ],
      {
        currentSource: secondSourceAfter,
        verifiedWork: [workEvidence(1), workEvidence(1, 2, firstSourceAfter)],
        verifiedReworkRoadmaps: [
          reworkEvidence('authored-one', source, firstSourceAfter),
          reworkEvidence(
            'authored-two',
            firstSourceAfter,
            secondSourceAfter,
            dateAt(11),
          ),
        ],
      },
    ),
  );
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'selected');
  assert.equal(result.decisions.length, 3);
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
