import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { HelperCliResult } from '../src/scripts/helper-cli-runner.mts';
import type {
  IddConfig,
  TrustedAutoDecideReport,
  TrustedAutoDecideSnapshot,
} from '../src/scripts/idd-config.mts';
import {
  renderClaimedByMarker,
  renderUnclaimedByMarker,
} from '../src/scripts/marker-helpers.mts';
import { AUTO_DECIDE_CLASSES } from '../src/scripts/policy-helpers.mts';
import {
  type ProvisionalDecisionCommandRequest,
  type ProvisionalDecisionHistoryComment,
  type ProvisionalDecisionHistoryRead,
  type ProvisionalDecisionPullRequestRead,
  type ProvisionalDecisionSourceIssueRead,
  type ProvisionalDecisionStore,
  type ProvisionalResolutionCloseExpectation,
  runProvisionalDecisionCommand,
} from '../src/scripts/provisional-decision.mts';
import {
  type ProvisionalDecisionCliDeps,
  runProvisionalDecisionCommandCli,
} from '../src/scripts/provisional-decision-command.mts';
import { createGithubProvisionalDecisionStore } from '../src/scripts/provisional-decision-github.mts';
import {
  PROVISIONAL_DECISION_RECORD_MARKER,
  parseProvisionalDecisionAnswerComment,
  parseProvisionalDecisionRecordComment,
} from '../src/scripts/provisional-decision-state.mts';
import { pinLoadControlOff, stubExecutable } from './test-utils.mts';

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
const implAgent = 'codex-impl-agent';
const implClaim = 'claim-4536-impl';
const implBranch = 'issue/4536-feat-decisions-implement-choice';
const coordAgent = 'codex-coordination-agent';
const coordClaim = 'claim-4536-coord';
const coordBranch = 'issue/4536-confirm-choices';
const trustedLogin = 'kurone-kito';
const issueUrl = `https://github.com/${repository}/issues/${issueNumber}`;
const claimAt = '2026-11-03T11:00:00Z';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const policy = { trustedMarkerActors: [trustedLogin] } as IddConfig;

// ---------------------------------------------------------------------------
// A stateful fake of the GitHub CLI. The state lives in a JSON file because
// every `gh` call is a separate process; the test mutates it between calls.
// ---------------------------------------------------------------------------

interface FakeComment {
  id: string;
  body: string;
  user: string | null;
  createdAt: string;
  edited?: boolean;
}

interface FakeState {
  comments: FakeComment[];
  issue: {
    title: string;
    body: string;
    state: 'open' | 'closed';
    stateReason: string | null;
    updatedAt: string;
    pullRequest?: boolean;
  };
  clockMs: number;
  nextId: number;
  /** The login the fake records for a comment the store posts. */
  postAs: string;
  failures: {
    pages?: boolean;
    /** Fail the Nth paginated comment read (1-based), and only that one. */
    failPagesOn?: number;
    /** Serve every row of the Nth paginated read, then fail it (a partial page). */
    partialPagesOn?: number;
    post?: boolean;
    /** A comment POST succeeds but the comment never appears in a read. */
    hidePost?: boolean;
    issue404?: boolean;
  };
  /** Another actor closes the issue with this reason just before gh does. */
  raceOnClose?: string;
  pageCalls?: number;
  /** On this paginated comment read (1-based), these comments appear first. */
  injectOnPage?: { call: number; comments: FakeComment[] };
  /** After the first issue read is served, these comments appear. */
  injectAfterIssueRead?: FakeComment[];
  calls: { args: string[]; input: string }[];
}

const GH_STUB = (statePath: string): string => `
const fs = require('node:fs');
const path = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
state.calls.push({ args, input });
const repoUrl = ${JSON.stringify(issueUrl)};
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const save = () => fs.writeFileSync(path, JSON.stringify(state));
const commentRow = (c) => ({
  id: c.id,
  node_id: 'IC_' + c.id,
  html_url: repoUrl + '#issuecomment-' + c.id,
  body: c.body,
  created_at: c.createdAt,
  user: c.user === null ? null : { login: c.user },
});
const include = args.includes('--include');
const reply = (text) => {
  save();
  process.stdout.write(
    include
      ? 'HTTP/2.0 200 OK\\r\\nDate: ' + new Date(state.clockMs).toUTCString() + '\\r\\n\\r\\n' + text
      : text,
  );
  process.exit(0);
};
const fail = (status, message) => {
  save();
  process.stderr.write('gh: ' + message + ' (HTTP ' + status + ')');
  process.exit(1);
};
const touch = () => {
  state.clockMs += 1000;
  state.issue.updatedAt = iso(state.clockMs);
};
if (args[0] === 'auth') reply(JSON.stringify(['github.com']));
if (args[0] === 'issue' && args[1] === 'close') {
  const reason = args[args.indexOf('--reason') + 1];
  if (state.issue.state === 'open') {
    if (state.raceOnClose) {
      state.issue.state = 'closed';
      state.issue.stateReason = state.raceOnClose;
    } else {
      state.issue.state = 'closed';
      state.issue.stateReason = reason;
    }
    touch();
  }
  reply('closed');
}
if (args[0] === 'issue' && args[1] === 'edit') reply('edited');
if (args[0] !== 'api') fail(2, 'unexpected command ' + args[0]);
const endpoint = args.slice(1).find((arg, i, tail) => !arg.startsWith('-') && tail[i - 1] !== '--hostname');
if (endpoint === 'user') reply(JSON.stringify({ login: state.postAs }));
if (endpoint === 'graphql') {
  const query = args.find((arg) => arg.startsWith('query=')) || '';
  const data = {};
  for (const match of query.matchAll(/c(\\d+): node\\(id: "([^"]+)"/g)) {
    const found = state.comments.find((c) => 'IC_' + c.id === match[2]);
    data['c' + match[1]] = { id: match[2], lastEditedAt: found && found.edited ? '2026-11-03T12:00:00Z' : null };
  }
  reply(JSON.stringify({ data }));
}
if (endpoint.includes('/comments')) {
  if (args.includes('POST')) {
    if (state.failures.post) fail(503, 'unavailable');
    const posted = JSON.parse(input).body;
    const id = String(state.nextId++);
    touch();
    if (!state.failures.hidePost) {
      state.comments.push({ id, body: posted, user: state.postAs, createdAt: iso(state.clockMs) });
    }
    reply(JSON.stringify({ id, html_url: repoUrl + '#issuecomment-' + id }));
  }
  if (args.includes('--paginate')) {
    state.pageCalls = (state.pageCalls || 0) + 1;
    if (state.injectOnPage && state.injectOnPage.call === state.pageCalls) {
      state.comments.push(...state.injectOnPage.comments);
    }
    if (state.failures.pages || state.failures.failPagesOn === state.pageCalls) fail(503, 'unavailable');
    if (state.failures.partialPagesOn === state.pageCalls) {
      process.stdout.write(state.comments.map((c) => JSON.stringify(commentRow(c))).join('\\n'));
      fail(503, 'unavailable');
    }
    reply(state.comments.map((c) => JSON.stringify(commentRow(c))).join('\\n'));
  }
  reply(JSON.stringify(state.comments.slice(0, 1).map(commentRow)));
}
if (state.failures.issue404) fail(404, 'Not Found');
const issue = {
  number: ${issueNumber},
  title: state.issue.title,
  body: state.issue.body,
  state: state.issue.state,
  state_reason: state.issue.stateReason,
  updated_at: state.issue.updatedAt,
  labels: [],
};
if (state.issue.pullRequest) issue.pull_request = { url: 'https://example.test/pr' };
if (state.injectAfterIssueRead) {
  state.comments.push(...state.injectAfterIssueRead);
  state.injectAfterIssueRead = undefined;
}
reply(JSON.stringify(issue));
`;

interface Fake {
  state(): FakeState;
  update(change: (state: FakeState) => void): void;
  addComment(
    text: string,
    options?: {
      user?: string | null;
      at?: string;
      edited?: boolean;
      id?: string;
    },
  ): FakeComment;
  /** The calls that wrote to GitHub, as a short description each. */
  writes(): string[];
}

function emptyState(): FakeState {
  return {
    comments: [],
    issue: {
      title,
      body,
      state: 'open',
      stateReason: null,
      updatedAt: '2026-11-03T10:59:00Z',
    },
    clockMs: Date.parse('2026-11-03T11:00:10Z'),
    nextId: 5000,
    postAs: trustedLogin,
    failures: {},
    calls: [],
  };
}

async function withFake(
  seed: (state: FakeState) => void,
  run: (context: {
    fake: Fake;
    store: ReturnType<typeof createGithubProvisionalDecisionStore>;
    statePath: string;
  }) => Promise<void>,
  options: {
    policy?: IddConfig | null;
    coordinationClaim?: typeof coordinationClaim;
    beforeWrite?: (write: string) => void;
  } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'idd-provisional-fake-'));
  const statePath = join(directory, 'state.json');
  const initial = emptyState();
  seed(initial);
  writeFileSync(statePath, JSON.stringify(initial));
  const previous = {
    GH_HOST: process.env.GH_HOST,
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
  };
  process.env.GH_HOST = 'github.com';
  delete process.env.GITHUB_SERVER_URL;
  const restorePolicy = pinLoadControlOff();
  const restore = stubExecutable('gh', GH_STUB(statePath));
  const read = (): FakeState =>
    JSON.parse(readFileSync(statePath, 'utf8')) as FakeState;
  const fake: Fake = {
    state: read,
    update(change) {
      const state = read();
      change(state);
      writeFileSync(statePath, JSON.stringify(state));
    },
    addComment(text, commentOptions = {}) {
      let added: FakeComment | undefined;
      fake.update((state) => {
        state.clockMs += 1000;
        const id = commentOptions.id ?? String(state.nextId++);
        added = {
          id,
          body: text,
          user:
            commentOptions.user === undefined
              ? trustedLogin
              : commentOptions.user,
          createdAt:
            commentOptions.at ??
            new Date(state.clockMs).toISOString().replace('.000Z', 'Z'),
          ...(commentOptions.edited === true ? { edited: true } : {}),
        };
        state.comments.push(added);
      });
      return added as FakeComment;
    },
    writes() {
      return read()
        .calls.filter(
          ({ args }) =>
            args.includes('POST') ||
            (args[0] === 'issue' && args[1] !== 'view'),
        )
        .map(({ args }) =>
          args.includes('POST') ? 'POST' : args.slice(0, 2).join(' '),
        );
    },
  };
  try {
    const store = createGithubProvisionalDecisionStore({
      repository,
      issueNumber,
      policy: options.policy === undefined ? policy : options.policy,
      ...(options.coordinationClaim
        ? { coordinationClaim: options.coordinationClaim }
        : {}),
      ...(options.beforeWrite ? { beforeWrite: options.beforeWrite } : {}),
    });
    await run({ fake, store, statePath });
  } finally {
    restore();
    restorePolicy();
    for (const name of ['GH_HOST', 'GITHUB_SERVER_URL'] as const) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function claimComment(
  agentId: string,
  claimId: string,
  branch: string,
  at: string,
  supersedes = 'none',
): FakeComment {
  return {
    id: `claim-${claimId}`,
    body: renderClaimedByMarker({
      agentId,
      claimId,
      supersedes,
      timestamp: at,
      branch,
    }),
    user: trustedLogin,
    createdAt: at,
  };
}

function withClaim(state: FakeState): void {
  const claim = claimComment(coordAgent, coordClaim, coordBranch, claimAt);
  state.comments.push({ ...claim, id: '1' });
}

/** The claim was released and another session then took a fresh one. */
function withReplacedClaim(state: FakeState): void {
  withClaim(state);
  state.comments.push(
    {
      id: '2',
      body: renderUnclaimedByMarker({
        agentId: coordAgent,
        claimId: coordClaim,
        timestamp: '2026-11-03T11:30:00Z',
      }),
      user: trustedLogin,
      createdAt: '2026-11-03T11:30:00Z',
    },
    {
      ...claimComment(
        'codex-other-agent',
        'claim-4536-other',
        'issue/4536-other-session',
        '2026-11-03T11:40:00Z',
      ),
      id: '3',
    },
  );
}

/** The claim went stale and another session took it over. */
function withStaleTakeover(state: FakeState): void {
  withClaim(state);
  state.comments.push({
    ...claimComment(
      'codex-other-agent',
      'claim-4536-other',
      'issue/4536-other-session',
      '2026-11-04T12:00:00Z',
      coordClaim,
    ),
    id: '2',
  });
}

const coordinationClaim = {
  claimId: coordClaim,
  agentId: coordAgent,
  branch: coordBranch,
};

function expectedClose(
  overrides: Partial<ProvisionalResolutionCloseExpectation> = {},
): ProvisionalResolutionCloseExpectation {
  return {
    state: 'open',
    title,
    bodySha256: sha256(body),
    claim: coordinationClaim,
    ...overrides,
  };
}

const sourceExpectation = {
  state: 'open',
  title,
  bodySha256: sha256(body),
} as const;

function recordBodyFor(recordId: string): string {
  return `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify({
    schemaVersion: 1,
    recordId,
    source: {
      repository,
      issueNumber,
      snapshot: {
        title,
        bodySha256: sha256(body),
        updatedAt: '2026-11-03T10:59:00Z',
      },
    },
    bundleGeneration: 1,
    decisionGeneration: 1,
    claimLineage: [
      {
        claimId: implClaim,
        agentId: implAgent,
        branch: implBranch,
        claimedAt: claimAt,
      },
    ],
    evidenceReferences: [`${issueUrl}#issuecomment-2`],
    event: {
      type: 'work-started',
      startedAt: '2026-11-03T11:00:05Z',
      planReference: `${issueUrl}#issuecomment-3`,
    },
  })}`;
}

const recordId = `prov-${'a'.repeat(32)}`;
const recordBody = recordBodyFor(recordId);

test('the fixture record parses as a record with its ID', () => {
  const parsed = parseProvisionalDecisionRecordComment(recordBody);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.record.recordId, recordId);
});

// ---------------------------------------------------------------------------
// Record lookup trust (appendRecordBody)
// ---------------------------------------------------------------------------

test('a trusted unedited record is returned as existing and nothing is posted', async () => {
  await withFake(
    (state) => {
      state.comments.push({
        id: '7',
        body: recordBody,
        user: trustedLogin,
        createdAt: '2026-11-03T11:00:05Z',
      });
    },
    async ({ fake, store }) => {
      assert.deepEqual(await store.appendRecordBody(recordId, recordBody), {
        result: 'existed',
        record: { id: '7', url: `${issueUrl}#issuecomment-7` },
      });
      assert.deepEqual(fake.writes(), []);
    },
  );
});

test('a record pre-posted by an untrusted actor is ignored and the record is posted', async () => {
  await withFake(
    (state) => {
      state.comments.push({
        id: '7',
        body: recordBody,
        user: 'mallory',
        createdAt: '2026-11-03T11:00:05Z',
      });
    },
    async ({ fake, store }) => {
      const result = await store.appendRecordBody(recordId, recordBody);
      assert.equal(result.result, 'created');
      assert.notEqual(result.record.id, '7');
      assert.deepEqual(fake.writes(), ['POST']);
      const mine = fake
        .state()
        .comments.find((comment) => comment.id === result.record.id);
      assert.equal(mine?.user, trustedLogin);
    },
  );
});

test('a record from an author GitHub no longer names is ignored', async () => {
  await withFake(
    (state) => {
      state.comments.push({
        id: '7',
        body: recordBody,
        user: null,
        createdAt: '2026-11-03T11:00:05Z',
      });
    },
    async ({ store }) => {
      assert.equal(
        (await store.appendRecordBody(recordId, recordBody)).result,
        'created',
      );
    },
  );
});

test('an edited trusted copy of a record does not count as the record', async () => {
  await withFake(
    (state) => {
      state.comments.push({
        id: '7',
        body: recordBody,
        user: trustedLogin,
        createdAt: '2026-11-03T11:00:05Z',
        edited: true,
      });
    },
    async ({ fake, store }) => {
      assert.equal(
        (await store.appendRecordBody(recordId, recordBody)).result,
        'created',
      );
      assert.deepEqual(fake.writes(), ['POST']);
    },
  );
});

test('a comment this store posted counts even when its author is not a trusted actor', async () => {
  await withFake(
    (state) => {
      state.postAs = 'session-bot';
    },
    async ({ fake, store }) => {
      const first = await store.appendRecordBody(recordId, recordBody);
      assert.equal(first.result, 'created');
      // The author is not in the trusted policy, but this store posted it.
      assert.deepEqual(await store.appendRecordBody(recordId, recordBody), {
        result: 'existed',
        record: first.record,
      });
      assert.deepEqual(fake.writes(), ['POST']);
    },
  );
});

test('an own post is remembered even when the read-back fails', async () => {
  await withFake(
    (state) => {
      state.postAs = 'session-bot';
      // The first read is the lookup, the second is the read-back of the post.
      state.failures.failPagesOn = 2;
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.appendRecordBody(recordId, recordBody),
        /absent from history read-back/,
      );
      assert.deepEqual(fake.writes(), ['POST']);
      // The comment is now visible, from an author the policy does not name,
      // but this store posted it, so it is found and nothing is posted again.
      const result = await store.appendRecordBody(recordId, recordBody);
      assert.equal(result.result, 'existed');
      assert.deepEqual(fake.writes(), ['POST']);
    },
  );
});

test('a post that never becomes visible fails its read-back', async () => {
  await withFake(
    (state) => {
      state.failures.hidePost = true;
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.appendRecordBody(recordId, recordBody),
        /absent from history read-back/,
      );
      assert.deepEqual(fake.writes(), ['POST']);
    },
  );
});

test('an incomplete history prevents every write', async () => {
  await withFake(
    (state) => {
      withClaim(state);
      state.failures.pages = true;
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.appendRecordBody(recordId, recordBody),
        /incomplete/,
      );
      await assert.rejects(store.appendAnswerBody('text'), /incomplete/);
      await assert.rejects(
        store.appendReworkAuthoredBody(recordId, recordBody, sourceExpectation),
        /incomplete/,
      );
      await assert.rejects(
        store.closeSourceIssue(expectedClose()),
        /incomplete/,
      );
      await assert.rejects(
        store.releaseCoordinationClaim(coordinationClaim),
        /incomplete/,
      );
      assert.deepEqual(fake.writes(), []);
    },
  );
});

test('an append under a held coordination claim needs it to be the active claim, unless the comment already landed', async () => {
  // Active claim: the append writes.
  await withFake(
    withClaim,
    async ({ fake, store }) => {
      assert.equal(
        (await store.appendRecordBody(recordId, recordBody)).result,
        'created',
      );
      assert.deepEqual(fake.writes(), ['POST']);
    },
    { coordinationClaim },
  );
  // Another session took the claim: neither append writes.
  await withFake(
    withReplacedClaim,
    async ({ fake, store }) => {
      await assert.rejects(
        store.appendRecordBody(recordId, recordBody),
        /not the active claim/,
      );
      await assert.rejects(
        store.appendAnswerBody('text'),
        /not the active claim/,
      );
      assert.deepEqual(fake.writes(), []);
    },
    { coordinationClaim },
  );
  // The comment already landed: it is returned, and nothing is checked or written.
  await withFake(
    (state) => {
      withReplacedClaim(state);
      state.comments.push({
        id: '7',
        body: recordBody,
        user: trustedLogin,
        createdAt: '2026-11-03T11:50:00Z',
      });
    },
    async ({ fake, store }) => {
      assert.equal(
        (await store.appendRecordBody(recordId, recordBody)).result,
        'existed',
      );
      assert.deepEqual(fake.writes(), []);
    },
    { coordinationClaim },
  );
  // No held claim (the decision transitions): the append is not claim-checked.
  await withFake(withReplacedClaim, async ({ store }) => {
    assert.equal(
      (await store.appendRecordBody(recordId, recordBody)).result,
      'created',
    );
  });
});

test('a read-back from an incomplete history does not confirm a write', async () => {
  // The first read is the lookup, the second the read-back, which here serves
  // every row, the new comment included, and then fails like a later page.
  await withFake(
    (state) => {
      state.failures.partialPagesOn = 2;
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.appendRecordBody(recordId, recordBody),
        /read-back is incomplete/,
      );
      assert.deepEqual(fake.writes(), ['POST']);
    },
  );
  await withFake(
    (state) => {
      withClaim(state);
      state.failures.partialPagesOn = 2;
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.releaseCoordinationClaim(coordinationClaim),
        /read-back is incomplete/,
      );
      assert.deepEqual(fake.writes(), ['POST']);
    },
  );
});

test('in resolution mode every write needs the authenticated account to be a trusted marker actor', async () => {
  await withFake(
    (state) => {
      withClaim(state);
      // Not named by the policy: the planner would ignore what it writes.
      state.postAs = 'session-bot';
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.appendRecordBody(recordId, recordBody),
        /"session-bot" is not a trusted marker actor/,
      );
      await assert.rejects(
        store.appendAnswerBody('text'),
        /not a trusted marker actor/,
      );
      await assert.rejects(
        store.closeSourceIssue(expectedClose()),
        /not a trusted marker actor/,
      );
      await assert.rejects(
        store.releaseCoordinationClaim(coordinationClaim),
        /not a trusted marker actor/,
      );
      assert.deepEqual(fake.writes(), []);
      assert.equal(fake.state().issue.state, 'open');
    },
    { coordinationClaim },
  );
  // A policy actor written with spaces or capitals still counts.
  await withFake(
    withClaim,
    async ({ fake, store }) => {
      await store.releaseCoordinationClaim(coordinationClaim);
      assert.deepEqual(fake.writes(), ['POST']);
    },
    {
      coordinationClaim,
      policy: { trustedMarkerActors: ['  KURONE-kito '] } as IddConfig,
    },
  );
});

test('the beforeWrite hook runs as the last check before each write and can refuse it', async () => {
  const seen: string[] = [];
  await withFake(
    withClaim,
    async ({ fake, store }) => {
      await store.appendAnswerBody('text');
      await store.appendRecordBody(recordId, recordBody);
      await store.closeSourceIssue(expectedClose());
      await store.releaseCoordinationClaim(coordinationClaim);
      assert.deepEqual(seen, [
        'answer append',
        'record append',
        'source close',
        'claim release',
      ]);
      assert.deepEqual(fake.writes(), ['POST', 'POST', 'issue close', 'POST']);
    },
    { coordinationClaim, beforeWrite: (write) => seen.push(write) },
  );
  await withFake(
    withClaim,
    async ({ fake, store }) => {
      await assert.rejects(
        store.appendAnswerBody('text'),
        /refused: answer append/,
      );
      await assert.rejects(
        store.appendReworkAuthoredBody(recordId, recordBody, sourceExpectation),
        /refused: rework record append/,
      );
      await assert.rejects(
        store.closeSourceIssue(expectedClose()),
        /refused: source close/,
      );
      await assert.rejects(
        store.releaseCoordinationClaim(coordinationClaim),
        /refused: claim release/,
      );
      assert.deepEqual(fake.writes(), []);
    },
    {
      coordinationClaim,
      beforeWrite: (write) => {
        throw new Error(`refused: ${write}`);
      },
    },
  );
});

// ---------------------------------------------------------------------------
// readSourceState
// ---------------------------------------------------------------------------

test('the source state maps open, closed reasons, and a reopened issue', async () => {
  await withFake(
    () => {},
    async ({ fake, store }) => {
      assert.deepEqual(await store.readSourceState(), {
        state: 'open',
        stateReason: null,
      });
      fake.update((state) => {
        state.issue.stateReason = 'reopened';
      });
      assert.deepEqual(await store.readSourceState(), {
        state: 'open',
        stateReason: null,
      });
      for (const reason of ['completed', 'not_planned', null]) {
        fake.update((state) => {
          state.issue.state = 'closed';
          state.issue.stateReason = reason;
        });
        assert.deepEqual(await store.readSourceState(), {
          state: 'closed',
          stateReason: reason,
        });
      }
    },
  );
});

test('the source state read fails on a missing issue and refuses a pull request', async () => {
  await withFake(
    (state) => {
      state.failures.issue404 = true;
    },
    async ({ fake, store }) => {
      await assert.rejects(store.readSourceState());
      fake.update((state) => {
        state.failures.issue404 = false;
        state.issue.pullRequest = true;
      });
      await assert.rejects(store.readSourceState(), /pull request/);
    },
  );
});

// ---------------------------------------------------------------------------
// appendReworkAuthoredBody
// ---------------------------------------------------------------------------

test('a rework-authored record is appended while the source is the audited one', async () => {
  await withFake(
    () => {},
    async ({ fake, store }) => {
      const result = await store.appendReworkAuthoredBody(
        recordId,
        recordBody,
        sourceExpectation,
      );
      assert.equal(result.result, 'created');
      assert.deepEqual(fake.writes(), ['POST']);
      // The identical record is returned on a retry, with no second write.
      assert.deepEqual(
        await store.appendReworkAuthoredBody(
          recordId,
          recordBody,
          sourceExpectation,
        ),
        { result: 'existed', record: result.record },
      );
      assert.deepEqual(fake.writes(), ['POST']);
    },
  );
});

test('a rework-authored record is refused, with no write, once the source changed or closed', async () => {
  await withFake(
    () => {},
    async ({ fake, store }) => {
      fake.update((state) => {
        state.issue.title = 'Retitled';
      });
      await assert.rejects(
        store.appendReworkAuthoredBody(recordId, recordBody, sourceExpectation),
        /title or body changed/,
      );
      fake.update((state) => {
        state.issue.title = title;
        state.issue.body = `${body}\nedited`;
      });
      await assert.rejects(
        store.appendReworkAuthoredBody(recordId, recordBody, sourceExpectation),
        /title or body changed/,
      );
      fake.update((state) => {
        state.issue.body = body;
        state.issue.state = 'closed';
        state.issue.stateReason = 'completed';
      });
      await assert.rejects(
        store.appendReworkAuthoredBody(recordId, recordBody, sourceExpectation),
        /no longer open/,
      );
      assert.deepEqual(fake.writes(), []);
    },
  );
});

test('an existing rework-authored record is not returned for a changed source', async () => {
  await withFake(
    (state) => {
      state.comments.push({
        id: '7',
        body: recordBody,
        user: trustedLogin,
        createdAt: '2026-11-03T11:00:05Z',
      });
      state.issue.body = `${body}\nedited`;
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.appendReworkAuthoredBody(recordId, recordBody, sourceExpectation),
        /title or body changed/,
      );
      assert.deepEqual(fake.writes(), []);
    },
  );
});

test('an untrusted pre-posted rework-authored record ID does not stand in for the record', async () => {
  await withFake(
    (state) => {
      state.comments.push({
        id: '7',
        body: recordBody,
        user: 'mallory',
        createdAt: '2026-11-03T11:00:05Z',
      });
    },
    async ({ fake, store }) => {
      const result = await store.appendReworkAuthoredBody(
        recordId,
        recordBody,
        sourceExpectation,
      );
      assert.equal(result.result, 'created');
      assert.deepEqual(fake.writes(), ['POST']);
    },
  );
});

// ---------------------------------------------------------------------------
// closeSourceIssue
// ---------------------------------------------------------------------------

test('the source is closed as completed while it and the claim are as planned', async () => {
  await withFake(withClaim, async ({ fake, store }) => {
    await store.closeSourceIssue(expectedClose());
    const state = fake.state();
    assert.equal(state.issue.state, 'closed');
    assert.equal(state.issue.stateReason, 'completed');
    const close = state.calls.find(({ args }) => args[1] === 'close');
    assert.deepEqual(close?.args.slice(0, 2), ['issue', 'close']);
    assert.equal(close?.args[close.args.indexOf('--reason') + 1], 'completed');
    assert.deepEqual(fake.writes(), ['issue close']);
  });
});

test('the source is not closed once it is closed, retitled, or its body changed', async () => {
  await withFake(withClaim, async ({ fake, store }) => {
    fake.update((state) => {
      state.issue.title = 'Retitled';
    });
    await assert.rejects(store.closeSourceIssue(expectedClose()), /changed/);
    fake.update((state) => {
      state.issue.title = title;
      state.issue.body = `${body}\nedited`;
    });
    await assert.rejects(store.closeSourceIssue(expectedClose()), /changed/);
    fake.update((state) => {
      state.issue.body = body;
      state.issue.state = 'closed';
      state.issue.stateReason = 'not_planned';
    });
    await assert.rejects(
      store.closeSourceIssue(expectedClose()),
      /no longer open/,
    );
    assert.deepEqual(fake.writes(), []);
    // An intervening close with another reason is never overwritten.
    assert.equal(fake.state().issue.stateReason, 'not_planned');
  });
});

test('the source is not closed after another session took the coordination claim', async () => {
  for (const [name, seed, message] of [
    [
      'a fresh claim after the release',
      withReplacedClaim,
      /not the active claim/,
    ],
    [
      'a stale takeover',
      withStaleTakeover,
      /claim lineage could not be verified: takeover-accepted/,
    ],
  ] as const) {
    await withFake(seed, async ({ fake, store }) => {
      await assert.rejects(
        store.closeSourceIssue(expectedClose()),
        message,
        name,
      );
      assert.deepEqual(fake.writes(), [], name);
      assert.equal(fake.state().issue.state, 'open', name);
    });
  }
});

test('the source is not closed once the coordination claim is released or when it names another agent or branch', async () => {
  await withFake(withClaim, async ({ fake, store }) => {
    await assert.rejects(
      store.closeSourceIssue(
        expectedClose({ claim: { ...coordinationClaim, agentId: 'other' } }),
      ),
      /not the active claim/,
    );
    await assert.rejects(
      store.closeSourceIssue(
        expectedClose({ claim: { ...coordinationClaim, branch: 'issue/1-x' } }),
      ),
      /not the active claim/,
    );
    fake.addComment(
      renderUnclaimedByMarker({
        agentId: coordAgent,
        claimId: coordClaim,
        timestamp: '2026-11-03T11:30:00Z',
      }),
    );
    await assert.rejects(
      store.closeSourceIssue(expectedClose()),
      /not the active claim/,
    );
    assert.deepEqual(fake.writes(), []);
  });
});

test('a claim marker from an untrusted actor never makes a claim active', async () => {
  await withFake(
    (state) => {
      state.comments.push({
        ...claimComment(coordAgent, coordClaim, coordBranch, claimAt),
        id: '1',
        user: 'mallory',
      });
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.closeSourceIssue(expectedClose()),
        /claim lineage could not be verified/,
      );
      assert.deepEqual(fake.writes(), []);
    },
  );
});

test('a close another actor made just before is reported, not claimed as ours', async () => {
  await withFake(
    (state) => {
      withClaim(state);
      state.raceOnClose = 'not_planned';
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.closeSourceIssue(expectedClose()),
        /not closed as completed/,
      );
      assert.equal(fake.state().issue.stateReason, 'not_planned');
    },
  );
});

test('the claim is the last check before the close: a takeover after the issue read is caught', async () => {
  await withFake(
    (state) => {
      withClaim(state);
      // The takeover lands right after the store has read the issue.
      state.injectAfterIssueRead = [
        {
          id: '2',
          body: renderUnclaimedByMarker({
            agentId: coordAgent,
            claimId: coordClaim,
            timestamp: '2026-11-03T11:30:00Z',
          }),
          user: trustedLogin,
          createdAt: '2026-11-03T11:30:00Z',
        },
        {
          ...claimComment(
            'codex-other-agent',
            'claim-4536-other',
            'issue/4536-other-session',
            '2026-11-03T11:40:00Z',
          ),
          id: '3',
        },
      ];
    },
    async ({ fake, store }) => {
      await assert.rejects(
        store.closeSourceIssue(expectedClose()),
        /not the active claim/,
      );
      assert.deepEqual(fake.writes(), []);
      assert.equal(fake.state().issue.state, 'open');
    },
  );
});

test('a trusted actor written with spaces or capitals in the policy is trusted, as the planner trusts it', async () => {
  await withFake(
    (state) => {
      state.comments.push({
        id: '7',
        body: recordBody,
        user: trustedLogin,
        createdAt: '2026-11-03T11:00:05Z',
      });
    },
    async ({ fake, store }) => {
      assert.equal(
        (await store.appendRecordBody(recordId, recordBody)).result,
        'existed',
      );
      assert.deepEqual(fake.writes(), []);
    },
    { policy: { trustedMarkerActors: ['  Kurone-KITO '] } as IddConfig },
  );
});

// ---------------------------------------------------------------------------
// releaseCoordinationClaim
// ---------------------------------------------------------------------------

test('the coordination claim is released with a dated unclaim marker', async () => {
  await withFake(withClaim, async ({ fake, store }) => {
    await store.releaseCoordinationClaim(coordinationClaim);
    const posted = fake.state().comments.at(-1);
    assert.ok(posted);
    assert.equal(
      posted.body,
      renderUnclaimedByMarker({
        agentId: coordAgent,
        claimId: coordClaim,
        timestamp: '2026-11-03T11:00:10Z',
      }),
    );
    assert.deepEqual(fake.writes(), ['POST']);
    // The claim is no longer active, so a second release writes nothing.
    await assert.rejects(
      store.releaseCoordinationClaim(coordinationClaim),
      /not the active claim/,
    );
    assert.deepEqual(fake.writes(), ['POST']);
  });
});

test('the coordination claim is not released once another session took it', async () => {
  for (const [name, seed, message] of [
    [
      'a fresh claim after the release',
      withReplacedClaim,
      /not the active claim/,
    ],
    [
      'a stale takeover',
      withStaleTakeover,
      /claim lineage could not be verified: takeover-accepted/,
    ],
  ] as const) {
    await withFake(seed, async ({ fake, store }) => {
      await assert.rejects(
        store.releaseCoordinationClaim(coordinationClaim),
        message,
        name,
      );
      assert.deepEqual(fake.writes(), [], name);
    });
  }
});

test('a release whose marker cannot be read back throws', async () => {
  await withFake(
    (state) => {
      withClaim(state);
      state.failures.hidePost = true;
    },
    async ({ store }) => {
      await assert.rejects(
        store.releaseCoordinationClaim(coordinationClaim),
        /absent from history read-back/,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// End to end: runProvisionalResolution through the command and the real store
// ---------------------------------------------------------------------------

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

/** An in-process issue the decision command drives to build the seed history. */
class SeedStore implements ProvisionalDecisionStore {
  readonly policy = policy;
  comments: ProvisionalDecisionHistoryComment[] = [];
  clockMs = Date.parse('2026-11-03T11:00:10Z');
  nextId = 100;
  readonly pullRequests = new Map<string, ProvisionalDecisionPullRequestRead>();

  add(
    render: (createdAt: string) => string,
    at?: string,
  ): ProvisionalDecisionHistoryComment {
    if (!at) this.clockMs += 1000;
    const createdAt =
      at ?? new Date(this.clockMs).toISOString().replace('.000Z', 'Z');
    const id = at ? String(this.comments.length + 1) : String(this.nextId++);
    const comment: ProvisionalDecisionHistoryComment = {
      id,
      url: `${issueUrl}#issuecomment-${id}`,
      body: render(createdAt),
      authorLogin: trustedLogin,
      createdAt,
      edited: false,
      trustedAuthor: true,
    };
    this.comments.push(comment);
    if (!at) this.clockMs += 1000;
    return comment;
  }

  async readHistory(): Promise<ProvisionalDecisionHistoryRead> {
    return {
      comments: [...this.comments],
      complete: true,
      serverDate: new Date(this.clockMs).toUTCString(),
    };
  }

  async readSourceIssue(): Promise<ProvisionalDecisionSourceIssueRead> {
    return { title, body, updatedAt: '2026-11-03T10:59:00Z' };
  }

  async readPullRequest(
    url: string,
  ): Promise<ProvisionalDecisionPullRequestRead> {
    const found = this.pullRequests.get(url);
    if (!found) throw new Error(`missing pull request ${url}`);
    return found;
  }

  async appendRecordBody(_id: string, text: string) {
    const added = this.add(() => text);
    return {
      result: 'created' as const,
      record: { id: added.id, url: added.url },
    };
  }

  async applyOrReadDecisionLabel(input: {
    readonly labelName: string;
    readonly apply: boolean;
  }) {
    return { present: input.apply };
  }
}

/** A decision-command request by the implementation claim, as the command builds it. */
function decisionRequest(
  overrides: Record<string, unknown>,
): ProvisionalDecisionCommandRequest {
  return {
    repository,
    issueNumber,
    claimId: implClaim,
    worktreeBranch: implBranch,
    evidenceUrl: `${issueUrl}#issuecomment-2`,
    policyTrusted: true,
    optionComparisonValid: true,
    baseline: { title, bodySha256: sha256(body) },
    verifiedReworkRoadmaps: [],
    ...overrides,
  } as unknown as ProvisionalDecisionCommandRequest;
}

const selectedOverrides = {
  type: 'selected',
  selectedOption: option('keep'),
  feasibleAlternatives: [option('change', true)],
  executionCriteria: ['The chosen behavior passes focused validation.'],
};

/** Drive one decision to verified completion, then hand over to a coordination claim. */
async function seedBundle(): Promise<SeedStore> {
  const seed = new SeedStore();
  seed.add(
    (at) =>
      renderClaimedByMarker({
        agentId: implAgent,
        claimId: implClaim,
        supersedes: 'none',
        timestamp: at,
        branch: implBranch,
      }),
    claimAt,
  );
  seed.add(() => 'Option comparison evidence.', '2026-11-03T11:00:01Z');
  const run = async (overrides: Record<string, unknown>) => {
    const result = await runProvisionalDecisionCommand(
      decisionRequest(overrides),
      seed,
      { apply: true },
    );
    assert.ok(
      result.state === 'applied' || result.state === 'reconciled',
      JSON.stringify(result),
    );
  };
  await run(selectedOverrides);
  const plan = seed.add(() => 'Implementation plan.');
  await run({ type: 'work-started', planCommentUrl: plan.url });
  const pullUrl = `https://github.com/${repository}/pull/6000`;
  const head = (6000).toString(16).padStart(40, '0');
  seed.pullRequests.set(pullUrl, {
    state: 'merged',
    headSha: head,
    mergeCommitSha: (7000).toString(16).padStart(40, '0'),
    requiredChecksPassing: true,
  });
  await run({
    type: 'work-completed',
    pullRequestUrl: pullUrl,
    verifiedHeadSha: head,
    executionCriteriaSatisfied: true,
  });
  seed.add((at) =>
    renderUnclaimedByMarker({
      agentId: implAgent,
      claimId: implClaim,
      timestamp: at,
    }),
  );
  seed.add((at) =>
    renderClaimedByMarker({
      agentId: coordAgent,
      claimId: coordClaim,
      supersedes: 'none',
      timestamp: at,
      branch: coordBranch,
    }),
  );
  return seed;
}

function loadSeed(seed: SeedStore): (state: FakeState) => void {
  return (state) => {
    state.comments = seed.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: comment.authorLogin,
      createdAt: comment.createdAt,
    }));
    state.clockMs = seed.clockMs + 5000;
    state.nextId = 5000;
  };
}

function trustSnapshot(
  master: 'enabled' | 'disabled',
  config: IddConfig | null = policy,
  unreadable?: string,
): TrustedAutoDecideSnapshot {
  const classes = Object.fromEntries(
    AUTO_DECIDE_CLASSES.map((cls) => [cls, 'class-off']),
  ) as TrustedAutoDecideReport['classes'];
  if (unreadable !== undefined) {
    return {
      report: {
        status: 'unreadable',
        source: 'repository',
        ref: 'main',
        master: 'unreadable',
        classes: Object.fromEntries(
          AUTO_DECIDE_CLASSES.map((cls) => [cls, 'unreadable']),
        ) as TrustedAutoDecideReport['classes'],
        error: unreadable,
      },
      policyConfig: null,
    };
  }
  return {
    report: {
      status: 'readable',
      source: 'repository',
      ref: 'main',
      master,
      classes,
    },
    policyConfig: config,
  };
}

interface CliRun {
  readonly outcome: HelperCliResult;
  readonly report: Record<string, unknown>;
}

const scratch = mkdtempSync(join(tmpdir(), 'idd-provisional-store-cli-'));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});
let requestCount = 0;

/** Run the real command, with the real GitHub store over the fake, on one request. */
async function runCommand(
  seed: SeedStore,
  request: Record<string, unknown>,
  options: {
    apply?: boolean;
    master?: 'enabled' | 'disabled';
    /** The trusted config the Nth trust read returns (the first read is 1). */
    trustAt?: (read: number) => IddConfig | null;
    /** Make every trust read an unreadable report that carries this error. */
    unreadable?: string;
  } = {},
): Promise<CliRun> {
  requestCount += 1;
  const path = join(scratch, `request-${requestCount}.json`);
  writeFileSync(path, JSON.stringify(request));
  const out: string[] = [];
  let reads = 0;
  const deps: ProvisionalDecisionCliDeps = {
    writeStdout: (text) => {
      out.push(text);
    },
    readTrust: () => {
      reads += 1;
      return trustSnapshot(
        options.master ?? 'enabled',
        options.trustAt ? options.trustAt(reads) : policy,
        options.unreadable,
      );
    },
    createStore: (input) => ({
      ...createGithubProvisionalDecisionStore(input),
      // Pull-request governance reads are not part of this fake.
      readPullRequest: (url) => seed.readPullRequest(url),
    }),
  };
  const outcome = await runProvisionalDecisionCommandCli(
    [
      '--issue',
      String(issueNumber),
      '--repo',
      repository,
      '--request',
      path,
      ...(options.apply ? ['--apply'] : []),
    ],
    deps,
  );
  const line = out.at(-1);
  assert.ok(line, 'expected one stdout JSON line');
  return { outcome, report: JSON.parse(line) as Record<string, unknown> };
}

const resolveRequest = {
  type: 'resolve',
  claimId: coordClaim,
  agentId: coordAgent,
  branch: coordBranch,
  decisionGenerations: [1],
};

const conversationYes = {
  channel: 'conversation',
  origin: 'user',
  message: 'Yes, I accept the presented completed choices.',
  interpretation: { response: 'accepted' },
};

function exitCodeOf(outcome: HelperCliResult): number {
  return typeof outcome === 'number' ? outcome : outcome.exitCode;
}

/** The confirmation record ID is derived from public values, so anyone can compute it. */
function confirmedRecordId(): string {
  const input = `${repository}|${issueNumber}|1|1|confirmed`;
  return `prov-${sha256(input).slice(0, 32)}`;
}

function comments(fake: Fake) {
  return fake.state().comments;
}

function confirmedRecords(fake: Fake) {
  return comments(fake).flatMap((comment) => {
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    return parsed.ok && parsed.record.event.type === 'confirmed'
      ? [{ comment, record: parsed.record }]
      : [];
  });
}

test('the command resolves a pending source end to end through the GitHub store', async () => {
  const seed = await seedBundle();
  await withFake(loadSeed(seed), async ({ fake, store }) => {
    // A claim that is not the active one is a request to fix, not a hold.
    const wrongClaim = await runCommand(seed, {
      ...resolveRequest,
      claimId: 'claim-4536-someone-else',
    });
    assert.equal(exitCodeOf(wrongClaim.outcome), 4);
    assert.equal(wrongClaim.report.state, 'refused');
    assert.equal(wrongClaim.report.action, 'fix-input');
    assert.deepEqual(fake.writes(), []);

    const dry = await runCommand(seed, resolveRequest);
    assert.equal(exitCodeOf(dry.outcome), 0);
    assert.equal(dry.report.state, 'planned');
    assert.equal(typeof dry.report.presentationSha256, 'string');
    assert.equal(dry.report.needsUserAnswer, true);
    assert.equal(dry.report.apply, false);
    assert.deepEqual(fake.writes(), []);

    // A master switch that is off does not stop a resolution.
    const applied = await runCommand(
      seed,
      {
        ...resolveRequest,
        input: conversationYes,
        answeredPresentationSha256: dry.report.presentationSha256,
      },
      { apply: true, master: 'disabled' },
    );
    assert.equal(
      applied.report.state,
      'applied',
      JSON.stringify(applied.report),
    );
    assert.equal(applied.report.outcome, 'confirmed-closed');
    assert.deepEqual(applied.report.steps, [
      'append-answer',
      'append-confirmation',
      'close-source',
      'release-claim',
    ]);
    assert.equal(exitCodeOf(applied.outcome), 0);
    const state = fake.state();
    assert.equal(state.issue.state, 'closed');
    assert.equal(state.issue.stateReason, 'completed');
    assert.equal(confirmedRecords(fake).length, 1);
    assert.ok(
      state.comments.some((comment) =>
        comment.body.startsWith('<!-- unclaimed-by: codex-coordination-agent'),
      ),
    );
    // Running the same request again finds everything done: reconciled, exit 2.
    const writesDone = fake.writes().length;
    const again = await runCommand(
      seed,
      {
        ...resolveRequest,
        input: conversationYes,
        answeredPresentationSha256: dry.report.presentationSha256,
      },
      { apply: true },
    );
    assert.equal(exitCodeOf(again.outcome), 2, JSON.stringify(again.report));
    assert.equal(again.report.state, 'reconciled');
    assert.equal(again.report.action, 'reconcile');
    assert.equal(fake.writes().length, writesDone);

    const answers = state.comments.filter(
      (comment) => parseProvisionalDecisionAnswerComment(comment.body).ok,
    );
    assert.equal(answers.length, 1);
    const answer = answers[0];
    assert.ok(answer);

    // A later append of the same answer finds it even when only the source
    // update time, which any comment moves, differs.
    const moved = answer.body.replace(
      /"updatedAt":"[^"]*"/u,
      '"updatedAt":"2030-01-01T00:00:00Z"',
    );
    assert.notEqual(moved, answer.body);
    const writes = fake.writes().length;
    assert.deepEqual(await store.appendAnswerBody(moved), {
      result: 'existed',
      record: { id: answer.id, url: `${issueUrl}#issuecomment-${answer.id}` },
    });
    assert.equal(fake.writes().length, writes);

    // The same answer from an untrusted author is not the trusted one.
    fake.update((current) => {
      for (const comment of current.comments) {
        if (comment.id === answer.id) comment.user = 'mallory';
      }
    });
    assert.equal((await store.appendAnswerBody(answer.body)).result, 'created');
    assert.equal(fake.writes().length, writes + 1);

    // An edited trusted answer is not one the planner counts either.
    fake.update((current) => {
      for (const comment of current.comments) {
        if (comment.id === answer.id) {
          comment.user = trustedLogin;
          comment.edited = true;
        }
      }
      // The answer the previous check posted is not the one under test.
      current.comments = current.comments.filter(
        (comment) =>
          comment.id === answer.id ||
          !parseProvisionalDecisionAnswerComment(comment.body).ok,
      );
    });
    assert.equal((await store.appendAnswerBody(answer.body)).result, 'created');
  });
});

test('a pre-posted confirmation record ID from an untrusted comment cannot force a recovery hold', async () => {
  const seed = await seedBundle();
  const completed = seed.comments
    .map((comment) => parseProvisionalDecisionRecordComment(comment.body))
    .flatMap((parsed) =>
      parsed.ok && parsed.record.event.type === 'work-completed'
        ? [parsed.record]
        : [],
    )[0];
  assert.ok(completed);
  const preposted = `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify({
    ...completed,
    recordId: confirmedRecordId(),
  })}`;
  assert.equal(parseProvisionalDecisionRecordComment(preposted).ok, true);
  await withFake(
    (state) => {
      loadSeed(seed)(state);
      state.comments.push({
        id: '4999',
        body: preposted,
        user: 'mallory',
        // Before every post the store will make, as a real pre-post would be.
        createdAt: new Date(seed.clockMs + 2000)
          .toISOString()
          .replace('.000Z', 'Z'),
      });
    },
    async ({ fake }) => {
      const dry = await runCommand(seed, resolveRequest);
      assert.equal(dry.report.state, 'planned', JSON.stringify(dry.report));
      const applied = await runCommand(
        seed,
        {
          ...resolveRequest,
          input: conversationYes,
          answeredPresentationSha256: dry.report.presentationSha256,
        },
        { apply: true },
      );
      assert.equal(
        applied.report.state,
        'applied',
        JSON.stringify(applied.report),
      );
      assert.equal(applied.report.outcome, 'confirmed-closed');
      assert.equal(exitCodeOf(applied.outcome), 0);
      // The store wrote its own record beside the untrusted one with the same ID.
      const withId = comments(fake).filter((comment) =>
        comment.body.includes(confirmedRecordId()),
      );
      assert.deepEqual(
        withId.map((comment) => comment.user),
        ['mallory', trustedLogin],
      );
      assert.equal(fake.state().issue.state, 'closed');
    },
  );
});

test('a trusted policy change before any write blocks that write', async () => {
  const seed = await seedBundle();
  // The first trust read is the planning read; each write reads it once more.
  // `unchangedReads` is how many reads still return the original policy.
  const cases = [
    {
      write: 'answer append',
      unchangedReads: 1,
      exit: 3,
      closed: false,
      released: false,
      writes: [],
    },
    {
      write: 'record append',
      unchangedReads: 2,
      exit: 3,
      closed: false,
      released: false,
      writes: ['POST'],
    },
    {
      write: 'source close',
      unchangedReads: 3,
      exit: 3,
      closed: false,
      released: false,
      writes: ['POST', 'POST'],
    },
    {
      write: 'claim release',
      unchangedReads: 4,
      exit: 2,
      closed: true,
      released: false,
      writes: ['POST', 'POST', 'issue close'],
    },
  ] as const;
  for (const item of cases) {
    await withFake(loadSeed(seed), async ({ fake }) => {
      const dry = await runCommand(seed, resolveRequest);
      const blocked = await runCommand(
        seed,
        {
          ...resolveRequest,
          input: conversationYes,
          answeredPresentationSha256: dry.report.presentationSha256,
        },
        {
          apply: true,
          trustAt: (read) =>
            read <= item.unchangedReads
              ? policy
              : ({ trustedMarkerActors: ['someone-else'] } as IddConfig),
        },
      );
      const name = `${item.write}: ${JSON.stringify(blocked.report)}`;
      assert.equal(exitCodeOf(blocked.outcome), item.exit, name);
      assert.match(
        String(blocked.report.reason),
        new RegExp(`trusted policy changed before the ${item.write}`),
        name,
      );
      assert.deepEqual(fake.writes(), item.writes, name);
      const state = fake.state();
      assert.equal(state.issue.state === 'closed', item.closed, name);
      assert.equal(
        state.comments.some((comment) =>
          comment.body.startsWith(`<!-- unclaimed-by: ${coordAgent} `),
        ),
        item.released,
        name,
      );
    });
  }
});

test('a takeover right before an answer or a record append blocks that append', async () => {
  const seed = await seedBundle();
  // Each write reads the history to plan, plans again, and then the store
  // reads it once more right before it posts: that read carries the claim
  // check. The answer is the first write (the third read of the run), and the
  // confirmation record the second (the seventh, after the answer's read-back
  // and the next two plans).
  const cases = [
    { write: 'answer', read: 3, writes: [] },
    { write: 'record', read: 7, writes: ['POST'] },
  ] as const;
  for (const item of cases) {
    await withFake(loadSeed(seed), async ({ fake }) => {
      const dry = await runCommand(seed, resolveRequest);
      fake.update((state) => {
        state.injectOnPage = {
          call: (state.pageCalls ?? 0) + item.read,
          comments: [
            {
              id: '4001',
              body: renderUnclaimedByMarker({
                agentId: coordAgent,
                claimId: coordClaim,
                timestamp: '2026-11-03T11:30:00Z',
              }),
              user: trustedLogin,
              createdAt: '2026-11-03T11:30:00Z',
            },
            {
              ...claimComment(
                'codex-other-agent',
                'claim-4536-other',
                'issue/4536-other-session',
                '2026-11-03T11:40:00Z',
              ),
              id: '4002',
            },
          ],
        };
      });
      const blocked = await runCommand(
        seed,
        {
          ...resolveRequest,
          input: conversationYes,
          answeredPresentationSha256: dry.report.presentationSha256,
        },
        { apply: true },
      );
      const name = `${item.write}: ${JSON.stringify(blocked.report)}`;
      assert.equal(exitCodeOf(blocked.outcome), 3, name);
      assert.match(
        String(blocked.report.reason),
        /coordination claim is not the active claim/,
        name,
      );
      assert.deepEqual(fake.writes(), item.writes, name);
    });
  }
});

test('an unreadable or absent trusted policy is a recovery hold before any read of the issue', async () => {
  const seed = await seedBundle();
  await withFake(loadSeed(seed), async ({ fake }) => {
    for (const options of [
      { trustAt: () => null },
      { unreadable: 'trusted policy fails the schema' },
    ]) {
      const held = await runCommand(seed, resolveRequest, options);
      assert.equal(exitCodeOf(held.outcome), 3);
      assert.equal(held.report.state, 'refused');
      assert.equal(held.report.action, 'recovery-hold');
      assert.match(String(held.report.reason), /trusted repository policy/);
      assert.deepEqual(fake.state().calls, []);
    }
    // An unreadable policy names why; an absent document names no reason.
    const why = await runCommand(seed, resolveRequest, {
      unreadable: 'trusted policy fails the schema',
    });
    assert.match(String(why.report.reason), /fails the schema/);
  });
});

// ---------------------------------------------------------------------------
// The decision command keeps its own fail-closed rule on an untrusted ID
// ---------------------------------------------------------------------------

test('the decision planner still holds on an untrusted same-ID record, before any store write', async () => {
  const seedHistory = (state: FakeState) => {
    state.comments.push(
      { ...claimComment(implAgent, implClaim, implBranch, claimAt), id: '1' },
      {
        id: '2',
        body: 'Option comparison evidence.',
        user: trustedLogin,
        createdAt: '2026-11-03T11:00:01Z',
      },
    );
  };
  // Learn the record ID the request writes, by running it against a seed.
  const seed = new SeedStore();
  seed.add(
    (at) =>
      renderClaimedByMarker({
        agentId: implAgent,
        claimId: implClaim,
        supersedes: 'none',
        timestamp: at,
        branch: implBranch,
      }),
    claimAt,
  );
  seed.add(() => 'Option comparison evidence.', '2026-11-03T11:00:01Z');
  const request = decisionRequest(selectedOverrides);
  const first = await runProvisionalDecisionCommand(request, seed, {
    apply: true,
  });
  assert.equal(first.state, 'applied', JSON.stringify(first));
  const written = seed.comments.at(-1)?.body ?? '';
  assert.equal(parseProvisionalDecisionRecordComment(written).ok, true);
  await withFake(
    (state) => {
      seedHistory(state);
      state.comments.push({
        id: '4999',
        body: written,
        user: 'mallory',
        createdAt: '2026-11-03T11:05:00Z',
      });
    },
    async ({ fake, store }) => {
      const result = await runProvisionalDecisionCommand(request, store, {
        apply: true,
      });
      // This rule lives in the planner and is deliberate: the decision flow
      // never reaches a store write while an untrusted comment holds its ID.
      assert.equal(result.state, 'refused', JSON.stringify(result));
      assert.equal(result.action, 'recovery-hold');
      assert.match(result.reason ?? '', /untrusted or edited/);
      assert.deepEqual(fake.writes(), []);
    },
  );
});
