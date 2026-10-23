import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  ProviderComment,
  ProviderWorkItem,
} from '../src/scripts/provider-port.mts';
import {
  type ProvisionalDecisionDependencies,
  type ProvisionalDecisionInput,
  type ProvisionalDecisionPullRequestEvidence,
  postProvisionalDecisionCommentOnce,
  resolveTrustedProvisionalDecisionCollaboratorMarkerLogins,
  runProvisionalDecision,
} from '../src/scripts/provisional-decision.mts';
import {
  PROVISIONAL_DECISION_ANSWER_MARKER,
  PROVISIONAL_DECISION_RECORD_MARKER,
  parseProvisionalDecisionRecordComment,
} from '../src/scripts/provisional-decision-state.mts';
import {
  checkSchemaKeywords,
  loadJson,
  validate,
} from '../src/scripts/validate-schemas.mts';
import { stubExecutable } from './test-utils.mts';

const ISSUE_NUMBER = 8101;
const REPOSITORY = 'example/project';
const ISSUE_URL = `https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}`;
const CREATED_AT = '2026-10-24T00:00:00Z';
const NOW = '2026-10-24T00:05:00Z';
const COMPLETION_VERIFIED_AT = '2026-10-24T00:02:30Z';
const HEAD_SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);
const CLAIM_ID = 'claim-8101-current';
const AGENT_ID = 'test-agent';
const NONCE = '0123456789abcdef0123456789abcdef';
const CLI = fileURLToPath(
  new URL('../bin/idd-provisional-decision.mjs', import.meta.url),
);

test('CLI help exposes the production entry point without provider access', () => {
  const result = spawnSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--action <select\|start\|complete>/u);
});

test('CLI and GitHub provider fixture refuse a closed source without writing', () => {
  const restoreGh = stubExecutable(
    'gh',
    [
      'const args = process.argv.slice(2);',
      'if (!args.includes("repos/kurone-kito/idd-skill/issues/8101")) {',
      '  process.stderr.write("unexpected gh request: " + args.join(" "));',
      '  process.exitCode = 2;',
      '} else {',
      '  process.stdout.write(JSON.stringify({',
      '    number: 8101, title: "Closed source", body: "No mutation allowed.",',
      '    state: "closed", labels: [],',
      '    html_url: "https://github.com/kurone-kito/idd-skill/issues/8101",',
      '    updated_at: "2026-10-24T00:00:00Z"',
      '  }));',
      '}',
    ].join('\n'),
  );
  const root = mkdtempSync(join(tmpdir(), 'idd-provisional-decision-cli-'));
  const inputPath = join(root, 'selection.json');
  writeFileSync(
    inputPath,
    JSON.stringify({
      question: 'Which option should be selected?',
      selectedOption: { id: 'one' },
      feasibleAlternatives: [{ id: 'two', rejectionReason: 'Not selected.' }],
      executionCriteria: ['A passing check is required.'],
      evidenceReferences: ['https://example.com/decision'],
    }),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        '--issue',
        '8101',
        '--action',
        'select',
        '--claim-id',
        CLAIM_ID,
        '--agent-id',
        AGENT_ID,
        '--nonce',
        NONCE,
        '--input',
        inputPath,
      ],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'kurone-kito/idd-skill',
          GH_REPO: '',
        },
      },
    );
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /"outcome": "refused"/u);
    assert.match(result.stdout, /issue #8101 is not open/u);
    assert.doesNotMatch(result.stderr, /unexpected gh request/u);
  } finally {
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('collaborator marker trust is opt-in and checks only operational marker authors', () => {
  const claim = { ...claimComment(), authorLogin: 'admin-user' };
  const selection = { ...existingSelection(), authorLogin: 'maintainer-user' };
  const ordinary = {
    ...claimComment(),
    id: 9,
    authorLogin: 'ordinary-user',
    body: 'A human comment without an operational marker.',
  };
  const comments = [claim, selection, ordinary];
  const calls: string[] = [];
  const permission = (login: string) => {
    calls.push(login);
    if (login === 'admin-user') {
      return {
        outcome: 'found' as const,
        permission: 'admin',
        roleName: 'admin',
      };
    }
    if (login === 'new-writer') {
      return {
        outcome: 'found' as const,
        permission: 'write',
        roleName: 'write',
      };
    }
    return {
      outcome: 'found' as const,
      permission: 'read',
      roleName: 'maintain',
    };
  };
  assert.deepEqual(
    resolveTrustedProvisionalDecisionCollaboratorMarkerLogins(
      comments,
      false,
      permission,
    ),
    [],
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(
    resolveTrustedProvisionalDecisionCollaboratorMarkerLogins(
      comments,
      true,
      permission,
      ['new-writer'],
    ),
    ['admin-user', 'maintainer-user', 'new-writer'],
  );
  assert.deepEqual(calls, ['admin-user', 'maintainer-user', 'new-writer']);
});

function sourceDigest(
  body = 'An issue requiring an operator decision.',
): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function claimComment(): ProviderComment {
  return {
    id: 1,
    body: `<!-- claimed-by: ${AGENT_ID} ${CLAIM_ID} supersedes: none ${CREATED_AT} branch: issue/${ISSUE_NUMBER}-decision-work -->`,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    lastEditedAt: null,
    authorLogin: 'trusted-bot',
  };
}

function selectedEvent(
  executionCriteria = [
    'The retry count is bounded and covered by a passing focused check.',
  ],
): Record<string, unknown> {
  return {
    type: 'selected',
    question: 'Which behavior should be implemented?',
    selectedOption: {
      id: 'bounded',
      description: 'Use bounded retries.',
      feasibilityRationale: 'The existing transport supports bounded retries.',
      requirementFit: 'It meets the issue acceptance criteria.',
      consequences: 'A retry has a fixed upper bound.',
      verification: 'Check the retry count in the focused test.',
      reversalOrMigration: 'No migration is required.',
      rationale: 'This option satisfies the requirements with a bounded cost.',
    },
    feasibleAlternatives: [
      {
        id: 'unbounded',
        description: 'Retry until success.',
        feasibilityRationale: 'The transport can retry repeatedly.',
        requirementFit: 'It might eventually satisfy the requirement.',
        consequences: 'A request could remain active indefinitely.',
        verification: 'Inspect request termination.',
        reversalOrMigration: 'No migration is required.',
        comparison: 'It gives up a finite runtime bound.',
        rejectionReason:
          'The bounded option meets the requirement without unbounded work.',
      },
    ],
    executionCriteria,
  };
}

function markerRecord(
  recordId: string,
  event: Record<string, unknown>,
  createdAt: string,
  evidenceReferences = [ISSUE_URL],
): ProviderComment {
  const claim = {
    claimId: CLAIM_ID,
    agentId: AGENT_ID,
    branch: `issue/${ISSUE_NUMBER}-decision-work`,
    claimedAt: new Date(CREATED_AT).toISOString(),
  };
  const record = {
    schemaVersion: 1,
    recordId,
    source: {
      repository: REPOSITORY,
      issueNumber: ISSUE_NUMBER,
      snapshot: {
        title: 'Operator decision task',
        bodySha256: sourceDigest(),
        updatedAt: CREATED_AT,
      },
    },
    bundleGeneration: 1,
    decisionGeneration: 1,
    claimLineage: [claim],
    evidenceReferences,
    event,
  };
  return {
    id:
      recordId === 'selection-record'
        ? 2
        : recordId === 'start-record'
          ? 3
          : recordId === 'completion-record'
            ? 4
            : recordId === 'confirmation-record'
              ? 6
              : 5,
    body: `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(record)}`,
    createdAt,
    updatedAt: createdAt,
    lastEditedAt: null,
    authorLogin: 'trusted-bot',
  };
}

function existingSelection(executionCriteria?: string[]): ProviderComment {
  return markerRecord(
    'selection-record',
    selectedEvent(executionCriteria),
    '2026-10-24T00:01:00Z',
  );
}

function existingWorkStart(): ProviderComment {
  return markerRecord(
    'start-record',
    {
      type: 'work-started',
      startedAt: '2026-10-24T00:02:00Z',
      planReference: `${ISSUE_URL}#issuecomment-2`,
    },
    '2026-10-24T00:02:00Z',
    [`${ISSUE_URL}#issuecomment-2`],
  );
}

function existingWorkCompletion(): ProviderComment {
  const pullRequestReference = `https://github.com/${REPOSITORY}/pull/8120`;
  const checkReference = `${pullRequestReference}/checks`;
  const criterionReference = 'https://example.com/evidence/criterion';
  return markerRecord(
    'completion-record',
    {
      type: 'work-completed',
      result: {
        kind: 'merged-pull-request',
        reference: pullRequestReference,
        verifiedAt: COMPLETION_VERIFIED_AT,
        headSha: HEAD_SHA,
        mergeCommitSha: MERGE_SHA,
      },
    },
    '2026-10-24T00:03:00Z',
    [pullRequestReference, checkReference, criterionReference],
  );
}

function existingConfirmationComments(): ProviderComment[] {
  const answerId = 5;
  const answerCreatedAt = '2026-10-24T00:04:00Z';
  const answer = {
    schemaVersion: 1,
    source: {
      repository: REPOSITORY,
      issueNumber: ISSUE_NUMBER,
      snapshot: {
        title: 'Operator decision task',
        bodySha256: sourceDigest(),
        updatedAt: CREATED_AT,
      },
    },
    bundleGeneration: 1,
    decisionGenerations: [1],
    claimIds: [CLAIM_ID],
    presentedBundle: [
      {
        decisionGeneration: 1,
        question: 'Which behavior should be implemented?',
        selectedOptionId: 'bounded',
        feasibleAlternativeIds: ['unbounded'],
        workCompletedRecordId: 'completion-record',
        result: {
          kind: 'merged-pull-request',
          reference: `https://github.com/${REPOSITORY}/pull/8120`,
          verifiedAt: COMPLETION_VERIFIED_AT,
          headSha: HEAD_SHA,
          mergeCommitSha: MERGE_SHA,
        },
      },
    ],
    response: 'accepted',
    answerText: 'Yes, I accept the presented completed choices.',
  };
  const answerComment: ProviderComment = {
    id: answerId,
    body: `${PROVISIONAL_DECISION_ANSWER_MARKER}\n${JSON.stringify(answer)}`,
    createdAt: answerCreatedAt,
    updatedAt: answerCreatedAt,
    lastEditedAt: null,
    authorLogin: 'trusted-bot',
  };
  const confirmation = markerRecord(
    'confirmation-record',
    {
      type: 'confirmed',
      confirmation: {
        commentUrl: `${ISSUE_URL}#issuecomment-${answerId}`,
        response: 'accepted',
        confirmedAt: answerCreatedAt,
      },
    },
    '2026-10-24T00:05:00Z',
  );
  return [answerComment, confirmation];
}

interface FixtureOptions {
  optIn?: boolean;
  viewerLogin?: string;
  viewerLoginAfterInitial?: string;
  trustedMarkerActors?: string[];
  closedInitially?: boolean;
  claimLost?: boolean;
  postMode?: 'normal' | 'throw-after-write' | 'throw-before-write';
  reopenMode?: 'normal' | 'throw-after-write' | 'throw-before-write';
  labelMode?: 'normal' | 'throw-once';
  pullRequestEvidence?: ProvisionalDecisionPullRequestEvidence;
  bodyChangesOnRead?: number;
  historyAddsOnRead?: number;
  injectCommentsOnVerify?: number;
  injectedComments?: ProviderComment[];
  executionCriteria?: string[];
  hiddenRecordType?: 'work-started' | 'work-completed';
}

function fixture(options: FixtureOptions = {}) {
  const comments: ProviderComment[] = [claimComment()];
  const labels = new Set<string>();
  const counters = {
    post: 0,
    label: 0,
    assert: 0,
    itemRead: 0,
    reopen: 0,
    verifyPullRequest: 0,
    viewerLogin: 0,
  };
  let labelFailed = false;
  const body = 'An issue requiring an operator decision.';
  const item: ProviderWorkItem = {
    number: ISSUE_NUMBER,
    title: 'Operator decision task',
    body,
    state: options.closedInitially ? 'CLOSED' : 'OPEN',
    labels: [],
    htmlUrl: ISSUE_URL,
    updatedAt: CREATED_AT,
  };
  const deps: ProvisionalDecisionDependencies = {
    owner: 'example',
    repo: 'project',
    cwd: '/worktrees/issue-8101',
    getWorkItem: () => {
      counters.itemRead += 1;
      if (options.historyAddsOnRead === counters.itemRead) {
        comments.push(...(options.injectedComments ?? []));
      }
      const value = { ...item, labels: [...labels].map((name) => ({ name })) };
      if (options.bodyChangesOnRead === counters.itemRead) {
        value.body = `${body} changed`;
      }
      return value;
    },
    listComments: () =>
      comments.filter((comment) => {
        if (
          !options.hiddenRecordType ||
          !comment.body.startsWith(PROVISIONAL_DECISION_RECORD_MARKER)
        ) {
          return true;
        }
        const parsed = parseProvisionalDecisionRecordComment(comment.body);
        return (
          !parsed.ok || parsed.record.event.type !== options.hiddenRecordType
        );
      }),
    postComment: (_issueNumber, commentBody) => {
      counters.post += 1;
      if (options.postMode === 'throw-before-write') {
        throw new Error('simulated POST failure before dispatch');
      }
      const id = Math.max(...comments.map((comment) => comment.id)) + 1;
      comments.push({
        id,
        body: commentBody,
        createdAt: NOW,
        updatedAt: NOW,
        lastEditedAt: null,
        authorLogin: 'trusted-bot',
      });
      if (options.postMode === 'throw-after-write') {
        throw new Error('simulated ambiguous POST response');
      }
      return { id, htmlUrl: `${ISSUE_URL}#issuecomment-${id}` };
    },
    reopenWorkItem: () => {
      counters.reopen += 1;
      if (options.reopenMode === 'throw-before-write') {
        throw new Error('simulated reopen failure before dispatch');
      }
      item.state = 'OPEN';
      if (options.reopenMode === 'throw-after-write') {
        throw new Error('simulated ambiguous reopen response');
      }
    },
    readAuthority: () => ({
      status: 'enabled',
      enabled: options.optIn !== false,
      ref: 'main',
      trustedMarkerActors: options.trustedMarkerActors ?? ['trusted-bot'],
      needsDecisionLabelName: 'status:needs-decision',
    }),
    viewerLogin: () => {
      counters.viewerLogin += 1;
      if (counters.viewerLogin > 1 && options.viewerLoginAfterInitial) {
        return options.viewerLoginAfterInitial;
      }
      return options.viewerLogin ?? 'trusted-bot';
    },
    assertClaim: () => {
      counters.assert += 1;
      if (options.claimLost) throw new Error('claim assertion lost ownership');
    },
    verifyPullRequest: (request) => {
      counters.verifyPullRequest += 1;
      if (options.injectCommentsOnVerify === counters.verifyPullRequest) {
        comments.push(...(options.injectedComments ?? []));
      }
      if (options.pullRequestEvidence) return options.pullRequestEvidence;
      if (
        (request.expectedHeadSha && request.expectedHeadSha !== HEAD_SHA) ||
        (request.expectedMergeCommitSha &&
          request.expectedMergeCommitSha !== MERGE_SHA)
      ) {
        return { verified: false, reason: 'pull request head is stale' };
      }
      return {
        verified: true,
        reason: 'PR is merged with passing required checks.',
        reference: `https://github.com/${REPOSITORY}/pull/8120`,
        verifiedAt: request.verifiedAt || NOW,
        headSha: HEAD_SHA,
        mergeCommitSha: MERGE_SHA,
        checkReferences: [`https://github.com/${REPOSITORY}/pull/8120/checks`],
      };
    },
    addLabel: (_issueNumber, name) => {
      counters.label += 1;
      if (options.labelMode === 'throw-once' && !labelFailed) {
        labelFailed = true;
        throw new Error('simulated label write failure');
      }
      labels.add(name);
    },
    now: () => NOW,
  };
  return { deps, comments, labels, counters, item, options };
}

function selectionInput(
  overrides: Partial<ProvisionalDecisionInput> = {},
): ProvisionalDecisionInput {
  return {
    issueNumber: ISSUE_NUMBER,
    action: 'select',
    apply: false,
    claimId: CLAIM_ID,
    agentId: AGENT_ID,
    nonce: NONCE,
    payload: {
      ...selectedEvent(),
      evidenceReferences: [ISSUE_URL],
    },
    ...overrides,
  };
}

function startInput(
  overrides: Partial<ProvisionalDecisionInput> = {},
): ProvisionalDecisionInput {
  return {
    issueNumber: ISSUE_NUMBER,
    action: 'start',
    apply: false,
    claimId: CLAIM_ID,
    agentId: AGENT_ID,
    nonce: NONCE,
    bundleGeneration: 1,
    decisionGeneration: 1,
    payload: { planReference: `${ISSUE_URL}#issuecomment-99` },
    ...overrides,
  };
}

function completeInput(
  overrides: Partial<ProvisionalDecisionInput> = {},
): ProvisionalDecisionInput {
  return {
    issueNumber: ISSUE_NUMBER,
    action: 'complete',
    apply: false,
    claimId: CLAIM_ID,
    agentId: AGENT_ID,
    nonce: NONCE,
    bundleGeneration: 1,
    decisionGeneration: 1,
    pullRequest: 8120,
    payload: {
      criteriaEvidence: [
        {
          criterion: String((selectedEvent().executionCriteria as string[])[0]),
          passed: true,
          reference: `https://github.com/${REPOSITORY}/pull/8120/checks`,
        },
      ],
    },
    ...overrides,
  };
}

function seededWorkFixture(options: FixtureOptions = {}) {
  const result = fixture(options);
  result.comments.push(
    existingSelection(options.executionCriteria),
    existingWorkStart(),
  );
  return result;
}

test('selection dry-run is non-mutating and its report matches the schema', () => {
  const { deps, counters } = fixture();
  const report = runProvisionalDecision(selectionInput(), deps);
  const schema = loadJson('schemas/provisional-decision.schema.json');
  assert.deepEqual(checkSchemaKeywords(schema), []);
  assert.deepEqual(validate(report, schema), [], JSON.stringify(report));
  assert.equal(report.outcome, 'planned');
  assert.equal(report.decisionStatus, 'none');
  assert.equal(report.target?.bundleGeneration, 1);
  assert.equal(report.target?.decisionGeneration, 1);
  assert.equal(counters.post, 0);
});

test('production comment POST validates one response and never retries an ambiguous error', () => {
  const body = 'one append-only transition';
  let calls = 0;
  const posted = postProvisionalDecisionCommentOnce(
    'example',
    'project',
    ISSUE_NUMBER,
    body,
    (path, options) => {
      calls += 1;
      assert.equal(
        path,
        `repos/example/project/issues/${ISSUE_NUMBER}/comments`,
      );
      assert.deepEqual(options.extraArgs, ['--method', 'POST', '--input', '-']);
      assert.equal(options.input, JSON.stringify({ body }));
      return {
        id: 42,
        html_url: `${ISSUE_URL}#issuecomment-42`,
        body,
      };
    },
  );
  assert.deepEqual(posted, { id: 42, htmlUrl: `${ISSUE_URL}#issuecomment-42` });
  assert.equal(calls, 1);

  calls = 0;
  assert.throws(
    () =>
      postProvisionalDecisionCommentOnce(
        'example',
        'project',
        ISSUE_NUMBER,
        body,
        () => {
          calls += 1;
          throw new Error('ambiguous transport failure');
        },
      ),
    /ambiguous transport failure/u,
  );
  assert.equal(calls, 1);
});

test('selection refuses without trusted opt-in, a valid comparison, or the current claim', () => {
  const disabled = fixture({ optIn: false });
  assert.equal(
    runProvisionalDecision(selectionInput(), disabled.deps).outcome,
    'refused',
  );
  assert.equal(disabled.counters.post, 0);

  const missingComparison = fixture();
  const invalid = selectionInput({
    payload: {
      ...(selectionInput().payload as Record<string, unknown>),
      feasibleAlternatives: [
        {
          id: 'alternative',
          description: 'Alternative without comparison.',
          feasibilityRationale: 'Feasible.',
          requirementFit: 'Fits.',
          consequences: 'Different consequences.',
          verification: 'Run a test.',
          reversalOrMigration: 'None.',
          rejectionReason: 'Rejected.',
        },
      ],
    },
  });
  assert.equal(
    runProvisionalDecision(invalid, missingComparison.deps).outcome,
    'refused',
  );
  assert.equal(missingComparison.counters.post, 0);

  const lost = fixture({ claimLost: true });
  assert.equal(
    runProvisionalDecision(selectionInput(), lost.deps).outcome,
    'refused',
  );
  assert.equal(lost.counters.post, 0);

  const untrusted = fixture({ viewerLogin: 'untrusted-user' });
  const untrustedReport = runProvisionalDecision(
    selectionInput({ apply: true }),
    untrusted.deps,
  );
  assert.equal(untrustedReport.outcome, 'refused');
  assert.equal(
    untrustedReport.checks.find((check) => check.name === 'record-author')
      ?.passed,
    false,
  );
  assert.equal(untrusted.counters.post, 0);
});

test('selection apply reads back the exact operation and reconciles an ambiguous POST once', () => {
  const { deps, counters } = fixture({ postMode: 'throw-after-write' });
  const report = runProvisionalDecision(selectionInput({ apply: true }), deps);
  assert.equal(report.outcome, 'reconciled');
  assert.equal(report.decisionStatus, 'selected');
  assert.equal(counters.post, 1);
  assert.equal(counters.assert, 2);
});

test('selection retry replays its stable generation after opt-out without a duplicate write', () => {
  let optedIn = true;
  const state = fixture();
  const deps = {
    ...state.deps,
    readAuthority: () => ({
      status: optedIn ? ('enabled' as const) : ('disabled' as const),
      enabled: optedIn,
      ref: 'main',
      trustedMarkerActors: ['trusted-bot'],
      needsDecisionLabelName: 'status:needs-decision',
    }),
  } satisfies ProvisionalDecisionDependencies;
  const first = runProvisionalDecision(selectionInput({ apply: true }), deps);
  assert.equal(first.outcome, 'applied');
  optedIn = false;
  const retry = runProvisionalDecision(
    selectionInput({
      bundleGeneration: first.target?.bundleGeneration,
      decisionGeneration: first.target?.decisionGeneration,
    }),
    deps,
  );
  assert.equal(retry.outcome, 'reconciled', JSON.stringify(retry));
  assert.equal(state.counters.post, 1);
});

test('source drift and uncertain pre-dispatch failure send no selection', () => {
  const changed = fixture({ bodyChangesOnRead: 2 });
  const changedReport = runProvisionalDecision(
    selectionInput({ apply: true }),
    changed.deps,
  );
  assert.equal(changedReport.outcome, 'refused');
  assert.equal(changed.counters.post, 0);

  const beforeDispatch = fixture({ postMode: 'throw-before-write' });
  const report = runProvisionalDecision(
    selectionInput({ apply: true }),
    beforeDispatch.deps,
  );
  assert.equal(report.outcome, 'partial');
  assert.equal(beforeDispatch.comments.length, 1);
});

test('a selection generation that changes before POST is refused without writing', () => {
  const raced = fixture({
    historyAddsOnRead: 2,
    injectedComments: [existingSelection()],
  });
  const report = runProvisionalDecision(
    selectionInput({ apply: true }),
    raced.deps,
  );
  assert.equal(report.outcome, 'refused');
  assert.equal(raced.counters.post, 0);
});

test('work-start retry replays an existing start after opt-out and refuses a new start', () => {
  const existing = seededWorkFixture({ optIn: false });
  const retry = runProvisionalDecision(
    startInput({
      apply: true,
      payload: { planReference: `${ISSUE_URL}#issuecomment-2` },
    }),
    existing.deps,
  );
  assert.equal(retry.outcome, 'reconciled');
  assert.equal(retry.decisionStatus, 'in-progress');
  assert.equal(existing.counters.post, 0);

  const noStart = fixture({ optIn: false });
  noStart.comments.push(existingSelection());
  const refused = runProvisionalDecision(
    startInput({ apply: true }),
    noStart.deps,
  );
  assert.equal(refused.outcome, 'refused');
  assert.equal(noStart.counters.post, 0);
});

test('uncertain work-start POST is reconcile-only until its exact record appears', () => {
  const state = fixture({
    hiddenRecordType: 'work-started',
    postMode: 'throw-after-write',
  });
  state.comments.push(existingSelection());
  const first = runProvisionalDecision(startInput({ apply: true }), state.deps);
  assert.equal(first.outcome, 'partial', JSON.stringify(first));
  assert.equal(state.counters.post, 1);

  const held = runProvisionalDecision(startInput({ apply: true }), state.deps);
  assert.equal(held.outcome, 'partial', JSON.stringify(held));
  assert.equal(state.counters.post, 1);

  state.options.hiddenRecordType = undefined;
  const reconciled = runProvisionalDecision(
    startInput({ apply: true }),
    state.deps,
  );
  assert.equal(reconciled.outcome, 'reconciled', JSON.stringify(reconciled));
  assert.equal(state.counters.post, 1);
});

test('completion refuses unmerged, stale-head, failed-check, and incomplete criteria evidence', () => {
  const unmerged = seededWorkFixture({
    pullRequestEvidence: {
      verified: false,
      reason: 'pull request is not merged',
    },
  });
  assert.equal(
    runProvisionalDecision(completeInput({ apply: true }), unmerged.deps)
      .outcome,
    'refused',
  );
  assert.equal(unmerged.counters.post, 0);

  const stale = seededWorkFixture({
    pullRequestEvidence: {
      verified: false,
      reason: 'pull request head is stale',
    },
  });
  assert.equal(
    runProvisionalDecision(completeInput({ apply: true }), stale.deps).outcome,
    'refused',
  );
  assert.equal(stale.counters.post, 0);

  const failing = seededWorkFixture({
    pullRequestEvidence: {
      verified: false,
      reason: 'required validation is failing: unit=FAILURE',
    },
  });
  assert.equal(
    runProvisionalDecision(completeInput({ apply: true }), failing.deps)
      .outcome,
    'refused',
  );
  assert.equal(failing.counters.post, 0);

  const missingCriteria = seededWorkFixture();
  assert.equal(
    runProvisionalDecision(
      completeInput({ apply: true, payload: { criteriaEvidence: [] } }),
      missingCriteria.deps,
    ).outcome,
    'refused',
  );
  assert.equal(missingCriteria.counters.post, 0);
});

test('verified completion remains allowed after opt-out and leaves the issue open with its label', () => {
  const { deps, counters, labels } = seededWorkFixture({ optIn: false });
  const report = runProvisionalDecision(completeInput({ apply: true }), deps);
  assert.equal(report.outcome, 'applied', JSON.stringify(report));
  assert.equal(report.decisionStatus, 'confirmation-pending');
  assert.equal(report.finalized, true);
  assert.equal(report.label.present, true);
  assert.equal(labels.has('status:needs-decision'), true);
  assert.equal(counters.post, 1);
  assert.equal(counters.label, 1);
});

test('completion reopens a closed source only after merged-deliverable verification', () => {
  const dryRun = seededWorkFixture({ closedInitially: true });
  const planned = runProvisionalDecision(completeInput(), dryRun.deps);
  assert.equal(planned.outcome, 'planned', JSON.stringify(planned));
  assert.match(planned.nextAction, /reopen/u);
  assert.equal(dryRun.item.state, 'CLOSED');
  assert.equal(dryRun.counters.reopen, 0);
  assert.equal(dryRun.counters.post, 0);

  const unmerged = seededWorkFixture({
    closedInitially: true,
    pullRequestEvidence: {
      verified: false,
      reason: 'pull request is not merged',
    },
  });
  const refused = runProvisionalDecision(
    completeInput({ apply: true }),
    unmerged.deps,
  );
  assert.equal(refused.outcome, 'refused');
  assert.equal(unmerged.item.state, 'CLOSED');
  assert.equal(unmerged.counters.reopen, 0);
  assert.equal(unmerged.counters.post, 0);

  const applied = seededWorkFixture({ closedInitially: true });
  const report = runProvisionalDecision(
    completeInput({ apply: true }),
    applied.deps,
  );
  assert.equal(report.outcome, 'applied', JSON.stringify(report));
  assert.equal(report.decisionStatus, 'confirmation-pending');
  assert.equal(applied.item.state, 'OPEN');
  assert.equal(applied.labels.has('status:needs-decision'), true);
  assert.equal(applied.counters.reopen, 1);
  assert.equal(applied.counters.post, 1);
});

test('ambiguous source reopen and closed-source completion retries reconcile safely', () => {
  const ambiguous = seededWorkFixture({
    closedInitially: true,
    reopenMode: 'throw-after-write',
  });
  const report = runProvisionalDecision(
    completeInput({ apply: true }),
    ambiguous.deps,
  );
  assert.equal(report.outcome, 'applied', JSON.stringify(report));
  assert.equal(ambiguous.item.state, 'OPEN');
  assert.equal(ambiguous.counters.reopen, 1);
  assert.equal(ambiguous.counters.post, 1);

  const retry = seededWorkFixture();
  assert.equal(
    runProvisionalDecision(completeInput({ apply: true }), retry.deps).outcome,
    'applied',
  );
  retry.item.state = 'CLOSED';
  const reconciled = runProvisionalDecision(
    completeInput({ apply: true }),
    retry.deps,
  );
  assert.equal(reconciled.outcome, 'reconciled', JSON.stringify(reconciled));
  assert.equal(reconciled.decisionStatus, 'confirmation-pending');
  assert.equal(retry.item.state, 'OPEN');
  assert.equal(retry.counters.reopen, 1);
  assert.equal(retry.counters.post, 1);
});

test('completion requires a trusted marker author before reopening or writing', () => {
  const initiallyUntrusted = seededWorkFixture({
    closedInitially: true,
    viewerLogin: 'untrusted-user',
  });
  const refused = runProvisionalDecision(
    completeInput({ apply: true }),
    initiallyUntrusted.deps,
  );
  assert.equal(refused.outcome, 'refused', JSON.stringify(refused));
  assert.equal(
    refused.checks.find((check) => check.name === 'record-author')?.passed,
    false,
  );
  assert.equal(initiallyUntrusted.item.state, 'CLOSED');
  assert.equal(initiallyUntrusted.counters.reopen, 0);
  assert.equal(initiallyUntrusted.counters.post, 0);
  assert.equal(initiallyUntrusted.counters.label, 0);

  const actorChangesBeforeReopen = seededWorkFixture({
    closedInitially: true,
    viewerLoginAfterInitial: 'untrusted-user',
  });
  const reopenRefused = runProvisionalDecision(
    completeInput({ apply: true }),
    actorChangesBeforeReopen.deps,
  );
  assert.equal(reopenRefused.outcome, 'refused', JSON.stringify(reopenRefused));
  assert.equal(
    reopenRefused.checks
      .filter((check) => check.name === 'record-author')
      .at(-1)?.passed,
    false,
  );
  assert.equal(actorChangesBeforeReopen.item.state, 'CLOSED');
  assert.equal(actorChangesBeforeReopen.counters.reopen, 0);
  assert.equal(actorChangesBeforeReopen.counters.post, 0);

  const actorChangesBeforePost = seededWorkFixture({
    viewerLoginAfterInitial: 'untrusted-user',
  });
  const postRefused = runProvisionalDecision(
    completeInput({ apply: true }),
    actorChangesBeforePost.deps,
  );
  assert.equal(postRefused.outcome, 'refused', JSON.stringify(postRefused));
  assert.equal(
    postRefused.checks.filter((check) => check.name === 'record-author').at(-1)
      ?.passed,
    false,
  );
  assert.equal(actorChangesBeforePost.counters.post, 0);
  assert.equal(actorChangesBeforePost.counters.label, 0);
});

test('completion neither reopens nor finalizes after a concurrent confirmation', () => {
  const closed = seededWorkFixture({
    closedInitially: true,
    historyAddsOnRead: 2,
    injectedComments: existingConfirmationComments(),
  });
  closed.comments.push(existingWorkCompletion());
  const reopenRace = runProvisionalDecision(
    completeInput({ apply: true }),
    closed.deps,
  );
  assert.equal(reopenRace.outcome, 'refused', JSON.stringify(reopenRace));
  assert.equal(reopenRace.decisionStatus, 'confirmed');
  assert.equal(closed.item.state, 'CLOSED');
  assert.equal(closed.counters.reopen, 0);
  assert.equal(closed.counters.post, 0);

  const labeled = seededWorkFixture({
    injectCommentsOnVerify: 2,
    injectedComments: existingConfirmationComments(),
  });
  labeled.comments.push(existingWorkCompletion());
  labeled.labels.add('status:needs-decision');
  const finalizationRace = runProvisionalDecision(
    completeInput({ apply: true }),
    labeled.deps,
  );
  assert.equal(
    finalizationRace.outcome,
    'partial',
    JSON.stringify(finalizationRace),
  );
  assert.equal(finalizationRace.decisionStatus, 'confirmed');
  assert.equal(finalizationRace.finalized, false);
  assert.equal(finalizationRace.label.present, true);
  assert.equal(labeled.counters.post, 0);
  assert.equal(labeled.counters.label, 0);
});

test('completion preserves criterion evidence in selected order, including duplicates', () => {
  const criteria = ['First criterion.', 'Second criterion.'];
  const firstReference = 'https://example.com/evidence/first';
  const secondReference = 'https://example.com/evidence/second';
  const state = seededWorkFixture({ executionCriteria: criteria });
  const report = runProvisionalDecision(
    completeInput({
      apply: true,
      payload: {
        criteriaEvidence: [
          {
            criterion: criteria[1],
            passed: true,
            reference: secondReference,
          },
          {
            criterion: criteria[0],
            passed: true,
            reference: firstReference,
          },
        ],
      },
    }),
    state.deps,
  );
  assert.equal(report.outcome, 'applied', JSON.stringify(report));
  const completion = state.comments.find(
    (comment) =>
      comment.body.startsWith(PROVISIONAL_DECISION_RECORD_MARKER) &&
      comment.body.includes('"type":"work-completed"'),
  );
  assert.ok(completion);
  const record = JSON.parse(
    completion.body.slice(PROVISIONAL_DECISION_RECORD_MARKER.length + 1),
  ) as { evidenceReferences: string[] };
  assert.deepEqual(record.evidenceReferences, [
    `https://github.com/${REPOSITORY}/pull/8120`,
    `https://github.com/${REPOSITORY}/pull/8120/checks`,
    firstReference,
    secondReference,
  ]);
});

test('retrying the exact selection after completion blocks implementation continuation', () => {
  const state = fixture();
  assert.equal(
    runProvisionalDecision(selectionInput({ apply: true }), state.deps).outcome,
    'applied',
  );
  assert.equal(
    runProvisionalDecision(
      startInput({
        apply: true,
        payload: { planReference: `${ISSUE_URL}#issuecomment-2` },
      }),
      state.deps,
    ).outcome,
    'applied',
  );
  assert.equal(
    runProvisionalDecision(completeInput({ apply: true }), state.deps).outcome,
    'applied',
  );
  const retry = runProvisionalDecision(
    selectionInput({
      apply: true,
      bundleGeneration: 1,
      decisionGeneration: 1,
    }),
    state.deps,
  );
  assert.equal(retry.outcome, 'reconciled', JSON.stringify(retry));
  assert.equal(retry.decisionStatus, 'confirmation-pending');
  assert.match(retry.nextAction, /do not continue implementation/u);
});

test('label partial-write recovery reconciles the same completion without another record', () => {
  const { deps, counters, labels } = seededWorkFixture({
    labelMode: 'throw-once',
  });
  const first = runProvisionalDecision(completeInput({ apply: true }), deps);
  assert.equal(first.outcome, 'partial', JSON.stringify(first));
  assert.equal(first.decisionStatus, 'confirmation-pending');
  assert.equal(first.finalized, false);
  assert.equal(labels.has('status:needs-decision'), false);
  assert.equal(counters.post, 1);

  const retry = runProvisionalDecision(completeInput({ apply: true }), deps);
  assert.equal(retry.outcome, 'reconciled');
  assert.equal(retry.finalized, true);
  assert.equal(labels.has('status:needs-decision'), true);
  assert.equal(counters.post, 1);
});

test('uncertain completion POST is reconcile-only until its exact record appears', () => {
  const state = seededWorkFixture({
    hiddenRecordType: 'work-completed',
    postMode: 'throw-after-write',
  });
  const first = runProvisionalDecision(
    completeInput({ apply: true }),
    state.deps,
  );
  assert.equal(first.outcome, 'partial', JSON.stringify(first));
  assert.equal(state.counters.post, 1);

  const held = runProvisionalDecision(
    completeInput({ apply: true }),
    state.deps,
  );
  assert.equal(held.outcome, 'partial', JSON.stringify(held));
  assert.equal(state.counters.post, 1);

  state.options.hiddenRecordType = undefined;
  const reconciled = runProvisionalDecision(
    completeInput({ apply: true }),
    state.deps,
  );
  assert.equal(reconciled.outcome, 'reconciled', JSON.stringify(reconciled));
  assert.equal(reconciled.finalized, true);
  assert.equal(state.counters.post, 1);
});
