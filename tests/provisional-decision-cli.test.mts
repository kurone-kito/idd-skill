import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { HelperCliResult } from '../src/scripts/helper-cli-runner.mts';
import type {
  TrustedAutoDecideReport,
  TrustedAutoDecideSnapshot,
} from '../src/scripts/idd-config.mts';
import { renderClaimedByMarker } from '../src/scripts/marker-helpers.mts';
import { AUTO_DECIDE_CLASSES } from '../src/scripts/policy-helpers.mts';
import type {
  ProvisionalDecisionHistoryComment,
  ProvisionalDecisionHistoryRead,
  ProvisionalDecisionPullRequestRead,
  ProvisionalDecisionSourceIssueRead,
  ProvisionalDecisionStore,
} from '../src/scripts/provisional-decision.mts';
import {
  type ProvisionalDecisionCliDeps,
  runProvisionalDecisionCommandCli,
} from '../src/scripts/provisional-decision-command.mts';
import { PROVISIONAL_DECISION_RECORD_MARKER } from '../src/scripts/provisional-decision-state.mts';

const repository = 'kurone-kito/idd-skill';
const issueNumber = 4799;
const title = 'Provisional decision CLI fixture';
// The planner reads the decision question from the decision section, so the
// fixture body needs one (as the planner's own fixture does).
const body = [
  '## Decision needed',
  'Question: Which safe behavior should be used?',
  '',
  '## Acceptance criteria',
  'The selected behavior is verified.',
].join('\n');
const bodySha256 = createHash('sha256').update(body).digest('hex');
const branch = `issue/${issueNumber}-feat-provider-add-provisional-decision`;
const claimId = 'claim-4799-cli';
const claimAt = '2026-11-16T10:00:00Z';
const serverDate = 'Mon, 16 Nov 2026 10:00:10 GMT';
const evidenceUrl = `https://github.com/${repository}/issues/${issueNumber}#issuecomment-2`;

const sourceRead: ProvisionalDecisionSourceIssueRead = {
  title,
  body,
  updatedAt: '2026-11-16T09:59:00Z',
};

const scratch = mkdtempSync(join(tmpdir(), 'provisional-decision-cli-'));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function comment(
  id: string,
  text: string,
  createdAt: string,
  overrides: Partial<ProvisionalDecisionHistoryComment> = {},
): ProvisionalDecisionHistoryComment {
  return {
    id,
    url: `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${id}`,
    body: text,
    authorLogin: 'kurone-kito',
    createdAt,
    edited: false,
    trustedAuthor: true,
    ...overrides,
  };
}

/** A claim marker and option-comparison evidence: the planner's minimum. */
function baseComments(): ProvisionalDecisionHistoryComment[] {
  return [
    comment(
      '1',
      renderClaimedByMarker({
        agentId: 'cli-test-agent',
        claimId,
        supersedes: 'none',
        timestamp: claimAt,
        branch,
      }),
      claimAt,
    ),
    comment('2', 'Option comparison evidence.', '2026-11-16T10:00:01Z'),
  ];
}

/** A history store that keeps appended records, so the read-back sees them. */
class StubStore implements ProvisionalDecisionStore {
  readonly appended: string[] = [];
  readonly labelRequests: boolean[] = [];
  private readonly comments: ProvisionalDecisionHistoryComment[];
  private readonly hideAppends: boolean;
  private readonly failRead: boolean;

  constructor(
    comments: readonly ProvisionalDecisionHistoryComment[],
    options: {
      readonly hideAppends?: boolean;
      readonly failRead?: boolean;
    } = {},
  ) {
    this.comments = [...comments];
    this.hideAppends = options.hideAppends === true;
    this.failRead = options.failRead === true;
  }

  async readHistory(): Promise<ProvisionalDecisionHistoryRead> {
    if (this.failRead) throw new Error('gh transport failure (simulated)');
    return { comments: [...this.comments], complete: true, serverDate };
  }

  async readSourceIssue(): Promise<ProvisionalDecisionSourceIssueRead> {
    return sourceRead;
  }

  async readPullRequest(): Promise<ProvisionalDecisionPullRequestRead> {
    throw new Error('selected requests read no pull request');
  }

  async appendRecordBody(
    _recordId: string,
    text: string,
  ): Promise<{
    readonly result: 'created';
    readonly record: { readonly id: string; readonly url: string };
  }> {
    this.appended.push(text);
    const id = String(900 + this.appended.length);
    if (!this.hideAppends) {
      this.comments.push(comment(id, text, '2026-11-16T10:00:05Z'));
    }
    return {
      result: 'created',
      record: {
        id,
        url: `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${id}`,
      },
    };
  }

  async applyOrReadDecisionLabel(input: {
    readonly labelName: string;
    readonly apply: boolean;
  }): Promise<{ readonly present: boolean }> {
    this.labelRequests.push(input.apply);
    return { present: false };
  }
}

function trustSnapshot(
  master: 'enabled' | 'disabled',
): TrustedAutoDecideSnapshot {
  const classes = Object.fromEntries(
    AUTO_DECIDE_CLASSES.map((cls) => [cls, 'class-off']),
  ) as TrustedAutoDecideReport['classes'];
  return {
    report: {
      status: 'readable',
      source: 'repository',
      ref: 'main',
      master,
      classes,
    },
    policyConfig: null,
  };
}

/** Capture stdout, the store factory's inputs, and the trust reads. */
function harness(options: {
  master?: 'enabled' | 'disabled';
  store?: StubStore;
}) {
  const out: string[] = [];
  const created: Array<{ repository: string; issueNumber: number }> = [];
  const trustReads: Array<{ owner: string; repo: string }> = [];
  const store = options.store ?? new StubStore(baseComments());
  const deps: ProvisionalDecisionCliDeps = {
    writeStdout: (text) => {
      out.push(text);
    },
    readTrust: (input) => {
      trustReads.push({ owner: input.owner, repo: input.repo });
      return trustSnapshot(options.master ?? 'enabled');
    },
    createStore: (input) => {
      created.push({
        repository: input.repository,
        issueNumber: input.issueNumber,
      });
      return store;
    },
  };
  return { deps, out, created, trustReads, store };
}

const selectedRequest = {
  type: 'selected',
  claimId,
  worktreeBranch: branch,
  evidenceUrl,
  baseline: { title, bodySha256 },
  selectedOption: option('keep'),
  feasibleAlternatives: [option('drop', true)],
  executionCriteria: ['Run the focused tests.'],
};

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

let requestCount = 0;

/** Write a request file in the scratch directory and return its path. */
function requestFile(content: unknown): string {
  requestCount += 1;
  const path = join(scratch, `request-${requestCount}.json`);
  writeFileSync(
    path,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  return path;
}

function argv(requestPath: string, extra: readonly string[] = []): string[] {
  return [
    '--issue',
    String(issueNumber),
    '--repo',
    repository,
    '--request',
    requestPath,
    ...extra,
  ];
}

function exitCodeOf(result: HelperCliResult): number {
  return typeof result === 'number' ? result : result.exitCode;
}

function kindOf(result: HelperCliResult): string | null {
  return typeof result === 'number' ? null : result.kind;
}

function lastReport(out: readonly string[]): Record<string, unknown> {
  const line = out.at(-1);
  assert.ok(line, 'expected one stdout JSON line');
  return JSON.parse(line) as Record<string, unknown>;
}

test('no arguments is a usage error with nothing on stdout', async () => {
  const h = harness({});
  const outcome = await runProvisionalDecisionCommandCli([], h.deps);
  assert.deepEqual(outcome, {
    exitCode: 2,
    kind: 'usage',
    message: '--issue and --repo are required',
  });
  assert.deepEqual(h.out, []);
  assert.deepEqual(h.trustReads, []);
});

test('an unknown flag and a malformed repository are usage errors', async () => {
  const h = harness({});
  // An unknown flag is thrown by the flag parser, so the runner reports it as
  // exit 1 with kind usage (the contract table's unknownFlag row).
  await assert.rejects(
    runProvisionalDecisionCommandCli(['--bogus-flag'], h.deps),
    /unknown argument/u,
  );
  const badRepo = await runProvisionalDecisionCommandCli(
    ['--issue', '1', '--repo', 'not-a-repo', '--request', 'x.json'],
    h.deps,
  );
  assert.equal(kindOf(badRepo), 'usage');
  assert.deepEqual(h.out, []);
});

test('--help prints usage and exits 0 without reading trust', async () => {
  const h = harness({});
  const outcome = await runProvisionalDecisionCommandCli(['--help'], h.deps);
  assert.equal(outcome, 0);
  assert.match(h.out.join(''), /Usage:/u);
  assert.deepEqual(h.trustReads, []);
});

test('invalid JSON in the request is a fix-input refusal (exit 4)', async () => {
  const h = harness({});
  const outcome = await runProvisionalDecisionCommandCli(
    argv(requestFile('{not json')),
    h.deps,
  );
  assert.equal(exitCodeOf(outcome), 4);
  const report = lastReport(h.out);
  assert.equal(report.state, 'refused');
  assert.equal(report.action, 'fix-input');
  assert.equal(report.apply, false);
});

test('trust fields in the request file are refused, not read', async () => {
  const h = harness({});
  const outcome = await runProvisionalDecisionCommandCli(
    argv(requestFile({ ...selectedRequest, policyTrusted: true })),
    h.deps,
  );
  assert.equal(exitCodeOf(outcome), 4);
  assert.match(String(lastReport(h.out).reason), /derives trust fields/u);
  assert.deepEqual(h.trustReads, []);
  assert.deepEqual(h.created, []);
});

test('a malformed option is a fix-input refusal naming its field', async () => {
  const h = harness({});
  const broken = {
    ...selectedRequest,
    selectedOption: { ...option('keep'), verification: '' },
  };
  const outcome = await runProvisionalDecisionCommandCli(
    argv(requestFile(broken)),
    h.deps,
  );
  assert.equal(exitCodeOf(outcome), 4);
  assert.match(
    String(lastReport(h.out).reason),
    /selectedOption\.verification" must be a non-empty string/u,
  );
  assert.deepEqual(h.store.appended, []);
});

test('a work transition with no stored record is a fix-input refusal', async () => {
  const h = harness({});
  const outcome = await runProvisionalDecisionCommandCli(
    argv(
      requestFile({
        type: 'work-started',
        claimId,
        worktreeBranch: branch,
        planCommentUrl: evidenceUrl,
      }),
    ),
    h.deps,
  );
  assert.equal(exitCodeOf(outcome), 4);
  assert.match(
    String(lastReport(h.out).reason),
    /no trusted provisional-decision record/u,
  );
});

test('a dry run plans the selection with trust read from the trusted source', async () => {
  const h = harness({ master: 'enabled' });
  const outcome = await runProvisionalDecisionCommandCli(
    argv(requestFile(selectedRequest)),
    h.deps,
  );
  assert.equal(outcome, 0);
  assert.deepEqual(h.trustReads, [{ owner: 'kurone-kito', repo: 'idd-skill' }]);
  assert.deepEqual(h.created, [{ repository, issueNumber }]);
  assert.deepEqual(h.store.appended, [], 'a dry run must not append');
  assert.deepEqual(h.store.labelRequests, []);
  const report = lastReport(h.out);
  assert.equal(report.state, 'planned');
  assert.equal(report.apply, false);
  assert.equal(
    (report.plan as Record<string, unknown>).historyComments,
    baseComments().length,
  );
  assert.equal('history' in (report.plan as object), false);
});

test('a disabled master switch refuses the selection with no write', async () => {
  const h = harness({ master: 'disabled' });
  const outcome = await runProvisionalDecisionCommandCli(
    argv(requestFile(selectedRequest), ['--apply']),
    h.deps,
  );
  assert.equal(exitCodeOf(outcome), 4);
  const report = lastReport(h.out);
  assert.equal(report.state, 'refused');
  assert.equal(report.action, 'fix-input');
  assert.match(
    String(report.reason),
    /trusted dangerouslyAutoDecide policy is not enabled/u,
  );
  assert.deepEqual(h.store.appended, []);
});

test('--apply appends one record and reports it applied', async () => {
  const h = harness({ master: 'enabled' });
  const outcome = await runProvisionalDecisionCommandCli(
    argv(requestFile(selectedRequest), ['--apply']),
    h.deps,
  );
  assert.equal(outcome, 0);
  assert.equal(h.store.appended.length, 1);
  assert.match(
    h.store.appended[0] ?? '',
    new RegExp(
      PROVISIONAL_DECISION_RECORD_MARKER.replace(
        /[.*+?^${}()|[\]\\]/gu,
        '\\$&',
      ),
      'u',
    ),
  );
  const report = lastReport(h.out);
  assert.equal(report.state, 'applied');
  assert.equal(report.apply, true);
  assert.equal(
    report.commentUrl,
    `https://github.com/${repository}/issues/${issueNumber}#issuecomment-901`,
  );
});

test('a read-back that cannot see the append is a recovery hold (exit 3)', async () => {
  const store = new StubStore(baseComments(), { hideAppends: true });
  const h = harness({ store });
  const outcome = await runProvisionalDecisionCommandCli(
    argv(requestFile(selectedRequest), ['--apply']),
    h.deps,
  );
  assert.equal(exitCodeOf(outcome), 3);
  assert.equal(kindOf(outcome), 'gate');
  const report = lastReport(h.out);
  assert.equal(report.state, 'refused');
  assert.equal(report.action, 'recovery-hold');
  assert.equal(
    h.store.appended.length,
    1,
    'the append happened before the hold',
  );
});

test('a selection already recorded is reconciled, not appended again (exit 2)', async () => {
  const dryRun = harness({});
  const first = await runProvisionalDecisionCommandCli(
    argv(requestFile(selectedRequest)),
    dryRun.deps,
  );
  assert.equal(first, 0);
  const plan = lastReport(dryRun.out).plan as { candidateRecord: unknown };
  const recorded = comment(
    '3',
    `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(plan.candidateRecord)}`,
    '2026-11-16T10:00:02Z',
  );
  const store = new StubStore([...baseComments(), recorded]);
  const h = harness({ store });
  const outcome = await runProvisionalDecisionCommandCli(
    argv(requestFile(selectedRequest), ['--apply']),
    h.deps,
  );
  assert.equal(outcome, 2);
  const report = lastReport(h.out);
  assert.equal(report.state, 'reconciled');
  assert.equal(report.action, 'reconcile');
  assert.deepEqual(h.store.appended, []);
});

test('a failed history read for a work transition is a recovery hold (exit 3)', async () => {
  const store = new StubStore(baseComments(), { failRead: true });
  const h = harness({ store });
  const outcome = await runProvisionalDecisionCommandCli(
    argv(
      requestFile({
        type: 'work-started',
        claimId,
        worktreeBranch: branch,
        planCommentUrl: evidenceUrl,
      }),
    ),
    h.deps,
  );
  assert.equal(exitCodeOf(outcome), 3);
  assert.equal(kindOf(outcome), 'gate');
  const report = lastReport(h.out);
  assert.equal(report.state, 'refused');
  assert.equal(report.action, 'recovery-hold');
  assert.match(String(report.reason), /gh transport failure \(simulated\)/u);
  assert.deepEqual(h.store.appended, []);
});
