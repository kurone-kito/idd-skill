import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  renderClaimedByMarker,
  renderForcedHandoffComment,
  renderUnclaimedByMarker,
} from '../src/scripts/marker-helpers.mts';
import {
  type BuildVerifiedClaimLineageInput,
  buildVerifiedClaimLineage,
  type ProvisionalClaimLineageComment,
} from '../src/scripts/provisional-claim-lineage.mts';
import {
  PROVISIONAL_DECISION_RECORD_MARKER,
  type ProvisionalDecisionClaim,
  type ProvisionalDecisionComment,
  type ProvisionalDecisionRecord,
  type ProvisionalDecisionSource,
  replayProvisionalDecisionHistory,
} from '../src/scripts/provisional-decision-state.mts';

const repository = 'kurone-kito/idd-skill';
const issueNumber = 4599;
const source: ProvisionalDecisionSource = {
  repository,
  issueNumber,
  snapshot: {
    title: 'Example decision source',
    bodySha256: 'a'.repeat(64),
    updatedAt: '2026-10-20T00:00:00Z',
  },
};
const trustedLogins = ['Kurone-Kito'];

function comment(
  id: string,
  body: string,
  createdAt: string,
  overrides: Partial<ProvisionalClaimLineageComment> = {},
): ProvisionalClaimLineageComment {
  return {
    id,
    url: `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${id}`,
    body,
    createdAt,
    authorLogin: 'kurone-kito',
    lastEditedAt: null,
    trustedAuthor: true,
    ...overrides,
  };
}

function claimComment(
  id: string,
  claimId: string,
  createdAt: string,
  options: {
    agentId?: string;
    branch?: string;
    supersedes?: string;
  } = {},
): ProvisionalClaimLineageComment {
  return comment(
    id,
    renderClaimedByMarker({
      agentId: options.agentId ?? `agent-${claimId}`,
      claimId,
      supersedes: options.supersedes ?? 'none',
      timestamp: createdAt,
      branch: options.branch ?? `issue/${issueNumber}-feat-lineage`,
    }),
    createdAt,
  );
}

function input(
  comments: readonly ProvisionalClaimLineageComment[],
  overrides: Partial<BuildVerifiedClaimLineageInput> = {},
): BuildVerifiedClaimLineageInput {
  return {
    comments,
    completeHistory: true,
    staleAgeMs: 24 * 60 * 60 * 1000,
    trustedMarkerLogins: trustedLogins,
    ...overrides,
  };
}

function reason(
  comments: readonly ProvisionalClaimLineageComment[],
  expected: string,
  overrides: Partial<BuildVerifiedClaimLineageInput> = {},
): void {
  assert.deepEqual(buildVerifiedClaimLineage(input(comments, overrides)), {
    status: 'recovery-hold',
    reason: expected,
  });
}

function selectedEvent() {
  return {
    type: 'selected',
    question: 'Which behavior should be used?',
    selectedOption: {
      id: 'keep',
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

function decisionRecord(
  claimLineage: readonly ProvisionalDecisionClaim[],
): ProvisionalDecisionRecord {
  return {
    schemaVersion: 1,
    recordId: 'select-1',
    source,
    bundleGeneration: 1,
    decisionGeneration: 1,
    claimLineage,
    evidenceReferences: [
      `https://github.com/${repository}/issues/${issueNumber}`,
    ],
    event: selectedEvent(),
  } as unknown as ProvisionalDecisionRecord;
}

function replayComment(
  value: ProvisionalClaimLineageComment,
): ProvisionalDecisionComment {
  return {
    id: value.id,
    url: value.url,
    body: value.body,
    authorLogin: value.authorLogin,
    createdAt: value.createdAt,
    edited: value.lastEditedAt !== null,
    trustedAuthor: value.trustedAuthor,
  };
}

test('builds active verified lineage with source comment timestamps and IDs', () => {
  const first = claimComment('101', 'claim-4599-1', '2026-10-20T00:00:00.100Z');
  const release = comment(
    '102',
    renderUnclaimedByMarker({
      agentId: 'agent-claim-4599-1',
      claimId: 'claim-4599-1',
      timestamp: '2026-10-20T00:00:01Z',
    }),
    '2026-10-20T00:00:01.200Z',
  );
  const second = claimComment(
    '103',
    'claim-4599-2',
    '2026-10-20T00:00:02.300Z',
  );

  assert.deepEqual(buildVerifiedClaimLineage(input([first, release, second])), {
    status: 'ok',
    claims: [
      {
        claimId: 'claim-4599-1',
        agentId: 'agent-claim-4599-1',
        branch: `issue/${issueNumber}-feat-lineage`,
        claimedAt: first.createdAt,
        supersedes: 'none',
        commentId: first.id,
      },
      {
        claimId: 'claim-4599-2',
        agentId: 'agent-claim-4599-2',
        branch: `issue/${issueNumber}-feat-lineage`,
        claimedAt: second.createdAt,
        supersedes: 'none',
        commentId: second.id,
      },
    ],
    active: {
      claimId: 'claim-4599-2',
      agentId: 'agent-claim-4599-2',
      branch: `issue/${issueNumber}-feat-lineage`,
      claimedAt: second.createdAt,
    },
    activeSince: second.createdAt,
  });
});

test('filters untrusted claim markers before folding and normalizes trusted logins', () => {
  const ignored = claimComment(
    '201',
    'claim-4599-forged',
    '2026-10-20T00:00:00Z',
    { agentId: 'forged-agent' },
  );
  const trusted = claimComment(
    '202',
    'claim-4599-real',
    '2026-10-20T00:00:01Z',
  );
  const result = buildVerifiedClaimLineage(
    input([
      { ...ignored, authorLogin: 'untrusted', trustedAuthor: false },
      trusted,
    ]),
  );
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.deepEqual(
      result.claims.map(({ claimId }) => claimId),
      ['claim-4599-real'],
    );
    assert.equal(result.active?.claimId, 'claim-4599-real');
  }
});

test('replay accepts the verified lineage at every source-history prefix', () => {
  const first = claimComment('301', 'claim-4599-1', '2026-10-20T00:00:00.100Z');
  const selectionTime = '2026-10-20T00:00:01.200Z';
  const selectionId = '302';
  const selectionUrl = `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${selectionId}`;
  const recordClaims: ProvisionalDecisionClaim[] = [
    {
      claimId: 'claim-4599-1',
      agentId: 'agent-claim-4599-1',
      branch: `issue/${issueNumber}-feat-lineage`,
      claimedAt: first.createdAt,
      supersedes: 'none',
    },
  ];
  const selection = comment(
    selectionId,
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(decisionRecord(recordClaims))}`,
    selectionTime,
  );
  const release = comment(
    '303',
    renderUnclaimedByMarker({
      agentId: 'agent-claim-4599-1',
      claimId: 'claim-4599-1',
      timestamp: '2026-10-20T00:00:02Z',
    }),
    '2026-10-20T00:00:02.300Z',
  );
  const second = claimComment(
    '304',
    'claim-4599-2',
    '2026-10-20T00:00:03.400Z',
  );
  const history = [first, selection, release, second];

  for (let length = 1; length <= history.length; length += 1) {
    const prefix = history.slice(0, length);
    const lineage = buildVerifiedClaimLineage(input(prefix));
    assert.equal(lineage.status, 'ok');
    if (lineage.status !== 'ok') continue;
    const replay = replayProvisionalDecisionHistory({
      comments: prefix.map(replayComment),
      completeHistory: true,
      currentSource: source,
      verifiedClaimLineage: lineage.claims,
      verifiedWork: [],
      verifiedReworkRoadmaps: [],
    });
    assert.equal(replay.valid, true, JSON.stringify(replay.issues));
    assert.deepEqual(replay.issues, []);
  }

  const completeLineage = buildVerifiedClaimLineage(input(history));
  assert.equal(completeLineage.status, 'ok');
  if (completeLineage.status === 'ok') {
    const claimsWithoutCommentIds = completeLineage.claims.map(
      ({ commentId: _commentId, ...claim }) => claim,
    );
    assert.deepEqual(claimsWithoutCommentIds, [
      recordClaims[0],
      {
        claimId: 'claim-4599-2',
        agentId: 'agent-claim-4599-2',
        branch: `issue/${issueNumber}-feat-lineage`,
        claimedAt: second.createdAt,
        supersedes: 'none',
      },
    ]);
    assert.equal(selection.url, selectionUrl);
  }
});

test('refuses incomplete, unordered, duplicate, and invalid-time histories in order', () => {
  const earlier = comment('401', 'plain', '2026-10-20T00:00:00Z');
  const later = comment('402', 'plain', '2026-10-20T00:00:01Z');
  reason([later, earlier], 'history-order-invalid');
  reason([later, earlier], 'history-incomplete', { completeHistory: false });
  reason([earlier, { ...later, id: earlier.id }], 'duplicate-comment');
  reason(
    [
      earlier,
      {
        ...later,
        url: `https://GITHUB.com/KURONE-KITO/IDD-SKILL/issues/${issueNumber}#issuecomment-${earlier.id}`,
      },
    ],
    'duplicate-comment',
  );
  reason([comment('403', 'plain', 'invalid-date')], 'date-time-required');
  reason(
    [comment('404', '<!-- claimed-by: malformed', 'invalid-date')],
    'date-time-required',
  );
});

test('refuses unknown or edited claim marker history before parsing it', () => {
  const marker = claimComment('501', 'claim-4599-1', '2026-10-20T00:00:00Z');
  reason([{ ...marker, lastEditedAt: undefined }], 'unknown-edit-state');
  reason(
    [{ ...marker, lastEditedAt: '2026-10-20T00:00:01Z' }],
    'edited-claim-marker',
  );
});

test('refuses legacy and malformed recognized claim markers', () => {
  reason(
    [
      comment(
        '601',
        '<!-- claimed-by: old-agent 2026-10-20T00:00:00Z branch: issue/4599-old -->',
        '2026-10-20T00:00:00Z',
      ),
    ],
    'legacy-claim-marker',
  );
  reason(
    [
      comment(
        '602',
        '<!-- claimed-by: agent claim-4599-1 supersedes: none 2026-02-30T00:00:00Z branch: issue/4599-valid -->',
        '2026-10-20T00:00:00Z',
      ),
    ],
    'malformed-claim-marker',
  );
});

test('refuses two claim starts in one UTC second despite release and fractions', () => {
  const first = claimComment('701', 'claim-4599-2', '2026-10-20T00:00:00.100Z');
  const release = comment(
    '702',
    renderUnclaimedByMarker({
      agentId: 'agent-claim-4599-2',
      claimId: 'claim-4599-2',
      timestamp: '2026-10-20T00:00:00Z',
    }),
    '2026-10-20T00:00:00.500Z',
  );
  const second = claimComment(
    '703',
    'claim-4599-1',
    '2026-10-20T00:00:00.900Z',
  );
  reason([first, release, second], 'same-second-claims');
});

test('refuses an accepted stale takeover and repeated claim IDs', () => {
  const first = claimComment('801', 'claim-4599-1', '2026-10-20T00:00:00Z');
  const takeover = claimComment('802', 'claim-4599-2', '2026-10-20T00:00:01Z', {
    agentId: 'takeover-agent',
    supersedes: 'claim-4599-1',
  });
  reason([first, takeover], 'takeover-accepted', { staleAgeMs: 1000 });

  const release = comment(
    '803',
    renderUnclaimedByMarker({
      agentId: 'agent-claim-4599-1',
      claimId: 'claim-4599-1',
      timestamp: '2026-10-20T00:00:01Z',
    }),
    '2026-10-20T00:00:01Z',
  );
  const reused = claimComment('804', 'claim-4599-1', '2026-10-20T00:00:02Z', {
    agentId: 'different-agent',
  });
  reason([first, release, reused], 'duplicate-claim-id');
});

test('keeps a fresh takeover out of lineage and uses the configured stale age', () => {
  const first = claimComment('805', 'claim-4599-1', '2026-10-20T00:00:00Z');
  const freshTakeover = claimComment(
    '806',
    'claim-4599-2',
    '2026-10-20T00:30:00Z',
    { agentId: 'fresh-takeover-agent', supersedes: 'claim-4599-1' },
  );
  const ignored = buildVerifiedClaimLineage(input([first, freshTakeover]));
  assert.equal(ignored.status, 'ok');
  if (ignored.status === 'ok') {
    assert.deepEqual(
      ignored.claims.map(({ claimId }) => claimId),
      ['claim-4599-1'],
    );
    assert.equal(ignored.active?.claimId, 'claim-4599-1');
  }

  const thresholdTakeover = claimComment(
    '807',
    'claim-4599-3',
    '2026-10-20T01:00:00Z',
    { agentId: 'threshold-takeover-agent', supersedes: 'claim-4599-1' },
  );
  reason([first, thresholdTakeover], 'takeover-accepted', {
    staleAgeMs: 60 * 60 * 1000,
  });
});

test('refuses noncanonical branches, late forced handoffs, and empty lineage', () => {
  const noncanonical = comment(
    '901',
    '<!-- claimed-by: agent-a claim-a supersedes: none 2026-10-20T00:00:00Z branch: main -->',
    '2026-10-20T00:00:00Z',
  );
  reason([noncanonical], 'non-canonical-branch');

  const claim = claimComment('902', 'claim-4599-1', '2026-10-20T00:00:00Z');
  const handoff = comment(
    '903',
    renderForcedHandoffComment({
      oldAgentId: 'agent-claim-4599-1',
      oldClaimId: 'claim-4599-1',
      newAgentId: 'agent-next',
      newClaimId: 'claim-next',
      branch: `issue/${issueNumber}-feat-lineage`,
      forcedBy: 'maintainer',
      reason: 'The prior agent is unavailable.',
      timestamp: '2026-10-20T00:00:01Z',
      contextScope: 'issue-only',
    }),
    '2026-10-20T00:00:01Z',
  );
  reason([claim, handoff], 'forced-handoff-after-last-claim');
  reason(
    [comment('904', 'ordinary note', '2026-10-20T00:00:00Z')],
    'empty-lineage',
  );
});

test('keeps the lineage builder independent of gh-exec', () => {
  const sourceText = readFileSync(
    new URL('../src/scripts/provisional-claim-lineage.mts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(sourceText, /gh-exec\.mts/u);
});
