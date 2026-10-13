import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildLintArgs,
  checkReviewResult,
  generatePublicationIds,
  injectPublicationLine,
  parseJournalReference,
  requestsChildShape,
  resolvePublishLabels,
} from '../src/scripts/publish-authoring-hold.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts/publish-authoring-hold.mjs');
const TITLE = 'Add a sample orphan feature';
const NEW_ISSUE = 5000;

function draftBody(bucket = 'ready'): string {
  return [
    ...(bucket === 'ready'
      ? []
      : [`<!-- idd-skill-authoring-bucket: ${bucket} -->`, '']),
    '## Background',
    '',
    'Some background text.',
    '',
    '## Proposed change',
    '',
    'Do the thing.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] `node --test tests/example.test.mts` passes with the new case covered',
    '',
    '---',
    '',
    '_Autopilot suitability: 4 / 5 -- higher is more autopilot-suitable;',
    'below the configured floor is human-oriented._',
    '',
    '<!-- idd-skill-autopilot-suitability: 4 -->',
    '',
    '_Effort: M -- author-estimated size; a soft autopilot',
    'selection tie-breaker only._',
    '',
    '<!-- idd-skill-effort: M -->',
  ].join('\n');
}

/**
 * A stateful fake `gh`. Every call is appended to `log.jsonl`; issues,
 * labels and comments live in `state.json`, so the sibling helpers the
 * command spawns (post-idd-marker, authoring-owner-provenance) read back
 * what an earlier call wrote.
 */
const GH_STUB = String.raw`
const fs = require('node:fs');
const dir = process.env.PUBLISH_STUB_DIR;
const statePath = dir + '/state.json';
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
let stdin = '';
if (args.includes('--input')) stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(dir + '/log.jsonl', JSON.stringify({ args, stdin }) + '\n');
const fail = (message) => { process.stderr.write(message + '\n'); process.exit(1); };
const out = (value) => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
const user = 'kurone-kito';
if (args[0] === 'label' && args[1] === 'create') {
  if (state.failLabelCreate) fail('HTTP 422: could not create label');
  state.labels.push(args[2]);
  save();
  out('');
}
if (args[0] === 'issue' && args[1] === 'create') {
  const body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  const labels = [];
  args.forEach((arg, index) => { if (arg === '--label') labels.push(args[index + 1]); });
  state.issues[${NEW_ISSUE}] = { body, labels: state.dropLabels ? [] : labels };
  if (state.claimOnCreate) {
    state.comments.push({ id: 6990, issue: ${NEW_ISSUE}, body: '<!-- claimed-by: claude-other 0f2c9a4e-1b7d-4c3a-9e8f-2d6b5a4c3e21 supersedes: none 2026-10-13T00:00:00Z branch: issue/${NEW_ISSUE}-x -->', user, createdAt: '2026-10-13T00:00:00Z' });
    if (state.claimOnCreate === 'released') {
      state.comments.push({ id: 6991, issue: ${NEW_ISSUE}, body: '<!-- unclaimed-by: claude-other 0f2c9a4e-1b7d-4c3a-9e8f-2d6b5a4c3e21 2026-10-13T00:01:00Z -->', user, createdAt: '2026-10-13T00:01:00Z' });
    }
  }
  save();
  out('https://github.com/o/r/issues/${NEW_ISSUE}\n');
}
if (args[0] === 'issue' && args[1] === 'edit') {
  const issue = state.issues[Number(args[2])];
  args.forEach((arg, index) => { if (arg === '--add-label') issue.labels.push(args[index + 1]); });
  save();
  out('');
}
if (args[0] !== 'api') fail('unexpected gh call: ' + args.join(' '));
if (args.includes('graphql')) {
  const numberArg = args.find((arg) => arg.startsWith('number='));
  const number = Number(numberArg.slice('number='.length));
  const queryArg = args.find((arg) => arg.startsWith('query=')) || '';
  const page = (key, nodes) => out({ data: { repository: { issue: { [key]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  if (queryArg.includes('closedByPullRequestsReferences')) {
    page('closedByPullRequestsReferences', state.openPr ? [{ state: 'OPEN', number: 9, repository: { nameWithOwner: 'o/r' } }] : []);
  }
  if (queryArg.includes('timelineItems')) page('timelineItems', []);
  state.commentReads = (state.commentReads || 0) + 1;
  if (state.foreignOwnerOnRead && state.commentReads === state.foreignOwnerOnRead) {
    state.comments.push({ id: 6998, issue: number, body: '<!-- idd-skill-authoring-owner: target=o/r#' + number + '; anchor=o/r#' + number + '; mode=acquire; owner=owner-other; set=set-other; session=session-other; body-sha256=none; snapshot-sha256=none; supersedes=none -->', user, createdAt: '2026-10-13T00:10:00Z' });
  }
  save();
  const nodes = state.comments.filter((c) => c.issue === number).map((c) => ({
    databaseId: c.id,
    lastEditedAt: state.editedComments ? '2026-10-13T00:00:01Z' : null,
    createdAt: c.createdAt,
    updatedAt: c.createdAt,
    body: c.body,
    author: { login: c.user },
    isMinimized: false,
    minimizedReason: null,
  }));
  out({ data: { repository: { issue: { comments: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
}
const path = args.find((arg) => arg === 'user' || arg.startsWith('repos/'));
if (path === 'user') out(user + '\n');
let match;
if ((match = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path))) {
  const number = Number(match[1]);
  if (args.includes('POST')) {
    if (number === 2674) {
      if (state.journalListFails) fail('gh: HTTP 502');
      state.journalPosts = (state.journalPosts || 0) + 1;
      save();
      if (state.journalPosts === state.ambiguousPostAt) {
        // The POST lands, but the reply is lost and every later read fails.
        const body = JSON.parse(stdin).body;
        state.comments.push({ id: 7000 + state.comments.length, issue: 2674, journalIndex: state.journalPosts, body, user, createdAt: '2026-10-13T00:20:00Z' });
        state.journalListFails = true;
        save();
        fail('gh: HTTP 502');
      }
      if (state.journalPosts === state.failJournalPostAt) fail('gh: Validation Failed (HTTP 422)');
      if (state.journalPosts === state.mutateBodyAt) {
        state.issues[${NEW_ISSUE}].body += '\nedited by someone else';
        save();
      }
    }
    const body = JSON.parse(stdin).body;
    const id = 7000 + state.comments.length;
    state.comments.push({ id, issue: number, journalIndex: number === 2674 ? state.journalPosts : 0, body, user, createdAt: new Date(Date.UTC(2026, 9, 13, 0, 0, state.comments.length)).toISOString() });
    save();
    out({ id, html_url: 'https://github.com/o/r/issues/' + number + '#issuecomment-' + id, body });
  }
  if (number === 2674 && state.journalListFails) fail('gh: HTTP 502');
  const rows = state.comments.filter((c) => c.issue === number).map((c) => JSON.stringify({ id: c.id, body: c.body, user: { login: c.user }, created_at: c.createdAt }));
  out(rows.join('\n') + (rows.length ? '\n' : ''));
}
if ((match = /^repos\/o\/r\/issues\/comments\/(\d+)$/.exec(path))) {
  const comment = state.comments.find((c) => c.id === Number(match[1]));
  if (!comment) fail('gh: Not Found (HTTP 404)');
  const corrupt = comment.journalIndex > 0 && comment.journalIndex === state.corruptReadbackAt;
  out({ id: comment.id, body: corrupt ? comment.body + ' ' : comment.body, user: { login: comment.user } });
}
if ((match = /^repos\/o\/r\/issues\/(\d+)$/.exec(path))) {
  const number = Number(match[1]);
  if (number === 2674) out({ number, title: 'journal', state: 'closed', body: 'journal', labels: [], html_url: 'https://github.com/o/r/issues/2674' });
  const issue = state.issues[number];
  if (!issue) fail('gh: Not Found (HTTP 404)');
  out({ number, title: 'x', state: 'open', body: issue.body, labels: issue.labels.map((name) => ({ name })), html_url: 'https://github.com/o/r/issues/' + number });
}
if ((match = /^repos\/o\/r\/collaborators\/([^/]+)\/permission$/.exec(path))) {
  const level = state.permission || 'admin';
  out({ permission: level === 'maintain' ? 'write' : level, role_name: level, user: { login: decodeURIComponent(match[1]) } });
}
if ((match = /^repos\/o\/r\/labels\/(.+)$/.exec(path))) {
  const name = decodeURIComponent(match[1]);
  if (state.labels.includes(name)) out({ name });
  fail('gh: Not Found (HTTP 404)');
}
fail('unexpected gh api call: ' + args.join(' '));
`;

interface Fixture {
  dir: string;
  run: (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  log: () => { args: string[]; stdin: string }[];
  state: () => {
    comments: { issue: number; body: string }[];
    issues: Record<string, unknown>;
  };
  restore: () => void;
}

function setup(
  options: {
    journal?: string | null;
    labels?: string[];
    failLabelCreate?: boolean;
    editedComments?: boolean;
    dropLabels?: boolean;
    failJournalPostAt?: number;
    corruptReadbackAt?: number;
    mutateBodyAt?: number;
    ambiguousPostAt?: number;
    claimOnCreate?: boolean | 'released';
    openPr?: boolean;
    foreignOwnerOnRead?: number;
    trusted?: string[];
    permission?: string;
  } = {},
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'idd-publish-authoring-hold-test-'));
  const work = join(dir, 'work');
  mkdirSync(join(work, '.github/idd'), { recursive: true });
  const config: Record<string, unknown> = {
    markerPrefix: 'idd-skill',
    trustedMarkerActors: options.trusted ?? ['kurone-kito'],
    claim: { verifySettleDelay: 'PT0S' },
  };
  if (options.journal !== null) {
    config.issueAuthoring = { journalIssue: options.journal ?? 'o/r#2674' };
  }
  writeFileSync(
    join(work, '.github/idd/config.json'),
    JSON.stringify(config, null, 2),
  );
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      labels: options.labels ?? ['status:authoring'],
      failLabelCreate: options.failLabelCreate === true,
      editedComments: options.editedComments === true,
      dropLabels: options.dropLabels === true,
      failJournalPostAt: options.failJournalPostAt ?? 0,
      corruptReadbackAt: options.corruptReadbackAt ?? 0,
      mutateBodyAt: options.mutateBodyAt ?? 0,
      ambiguousPostAt: options.ambiguousPostAt ?? 0,
      permission: options.permission ?? 'admin',
      claimOnCreate: options.claimOnCreate ?? false,
      openPr: options.openPr === true,
      foreignOwnerOnRead: options.foreignOwnerOnRead ?? 0,
      issues: {},
      comments: [],
    }),
  );
  writeFileSync(join(dir, 'log.jsonl'), '');
  const restore = stubExecutable('gh', GH_STUB);
  const home = join(dir, 'home');
  mkdirSync(home);
  return {
    dir,
    run: (args) => {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: work,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          PUBLISH_STUB_DIR: dir,
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_CACHE_HOME: join(home, '.cache'),
          XDG_STATE_HOME: join(home, '.state'),
          IDD_TRUSTED_MARKER_ACTORS: '',
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    log: () =>
      readFileSync(join(dir, 'log.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
    restore: () => {
      restore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function files(
  fixture: Fixture,
  bucket = 'ready',
  review: unknown = { completed: true },
): string[] {
  const body = join(fixture.dir, 'body.md');
  const result = join(fixture.dir, 'review.json');
  writeFileSync(body, draftBody(bucket));
  writeFileSync(result, JSON.stringify(review));
  return [
    '--title',
    TITLE,
    '--body-file',
    body,
    '--review-result',
    result,
    '--owner',
    'o',
    '--repo',
    'r',
    '--marker-prefix',
    'idd-skill',
    ...(bucket === 'ready' ? [] : ['--bucket', bucket]),
  ];
}

/** The write calls in the gh log, in order. */
function writes(log: { args: string[] }[]): string[] {
  return log
    .filter(
      (entry) =>
        entry.args.includes('--method') ||
        entry.args.includes('-X') ||
        (['label', 'issue'].includes(entry.args[0] ?? '') &&
          !['view', 'list'].includes(entry.args[1] ?? '')),
    )
    .map((entry) => entry.args.slice(0, 4).join(' '));
}

/** The kind of one gh call, for the mutation-order check. */
function kindOf(entry: { args: string[]; stdin: string }): string | null {
  const args = entry.args;
  if (args[0] === 'label') return 'label';
  if (args[0] === 'issue' && args[1] === 'create') return 'create';
  if (args.includes('graphql')) return 'provenance';
  const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
  if (path === 'repos/o/r/issues/2674' && !args.includes('POST')) {
    return 'journal-check';
  }
  if (path.startsWith('repos/o/r/labels/')) return 'label';
  if (path === 'repos/o/r/issues/2674/comments' && args.includes('POST')) {
    const body = JSON.parse(entry.stdin).body as string;
    if (body.includes('state=member')) return 'member';
    return body.includes('issue=none') ? 'journal-pending' : 'identity-attach';
  }
  if (
    path === `repos/o/r/issues/${NEW_ISSUE}/comments` &&
    args.includes('POST')
  ) {
    return 'owner-marker';
  }
  return null;
}

test('ids: orphan anchor equals target, and the line round-trips', () => {
  let counter = 0;
  const ids = generatePublicationIds(() => {
    counter += 1;
    return `u${counter}`;
  });
  assert.equal(ids.anchor, ids.target);
  assert.equal(ids.target, 'target-u1');
  const body = injectPublicationLine('## Background\n', 'idd-skill', ids);
  assert.equal(
    body.split('\n')[0],
    '<!-- idd-skill-authoring-publication: target=target-u1; anchor=target-u1; set=set-u2; session=session-u3; token=token-u4 -->',
  );
  assert.throws(() => injectPublicationLine(body, 'idd-skill', ids));
});

test('review result: only a completed review with no open finding passes', () => {
  assert.equal(checkReviewResult('{"completed": true}'), null);
  assert.equal(
    checkReviewResult(
      '{"completed": true, "findings": [{"disposition": "fixed"}, {"disposition": "rejected"}]}',
    ),
    null,
  );
  assert.notEqual(checkReviewResult('{"completed": false}'), null);
  assert.notEqual(checkReviewResult('{}'), null);
  assert.notEqual(checkReviewResult('not json'), null);
  assert.notEqual(
    checkReviewResult(
      '{"completed": true, "findings": [{"disposition": "deferred"}]}',
    ),
    null,
  );
});

test('lint args: a ready publish passes no bucket or label, a needs-decision publish passes both labels', () => {
  const common = {
    shape: 'orphan',
    title: 't',
    bodyFile: 'b.md',
    markerPrefix: 'idd-skill',
    currentRepo: 'o/r',
  };
  const ready = buildLintArgs({
    ...common,
    bucket: 'ready',
    labels: resolvePublishLabels({}, 'ready'),
  });
  assert.ok(ready.includes('--new-issue'));
  assert.ok(!ready.includes('--expect-bucket'));
  assert.ok(!ready.includes('--label'));
  const decision = buildLintArgs({
    ...common,
    bucket: 'needs-decision',
    labels: resolvePublishLabels(
      { labels: { needsDecisionLabelName: 'decide' } },
      'needs-decision',
    ),
  });
  assert.deepEqual(decision.slice(-6), [
    '--expect-bucket',
    'needs-decision',
    '--label',
    'status:authoring',
    '--label',
    'decide',
  ]);
});

test('journal reference and child shape parsing', () => {
  assert.deepEqual(parseJournalReference('o/r#2674'), {
    owner: 'o',
    repo: 'r',
    number: 2674,
    ref: 'o/r#2674',
  });
  assert.equal(parseJournalReference(undefined), null);
  assert.equal(parseJournalReference('o/r#0'), null);
  assert.equal(requestsChildShape(['--shape', 'child']), true);
  assert.equal(requestsChildShape(['--shape=child']), true);
  assert.equal(requestsChildShape(['--shape', 'orphan']), false);
});

test('CLI: --shape child exits 2 and makes no gh call, even with a bad flag', () => {
  const fixture = setup();
  try {
    const result = fixture.run(['--shape', 'child', '--bogus']);
    assert.equal(result.status, 2);
    assert.deepEqual(fixture.log(), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a missing or incomplete review result exits non-zero before any write', () => {
  const fixture = setup();
  try {
    const args = files(fixture);
    const without = args.filter(
      (_, index) =>
        args[index] !== '--review-result' &&
        args[index - 1] !== '--review-result',
    );
    assert.equal(fixture.run(without).status, 2);
    assert.equal(
      fixture.run(files(fixture, 'ready', { completed: false })).status,
      1,
    );
    assert.equal(
      fixture.run(
        files(fixture, 'ready', {
          completed: true,
          findings: [{ disposition: 'deferred' }],
        }),
      ).status,
      1,
    );
    assert.deepEqual(fixture.log(), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an unset journal exits 2 with no label, journal record or issue', () => {
  const fixture = setup({ journal: null, labels: [] });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).outcome, 'blocked-by-human');
    assert.deepEqual(writes(fixture.log()), []);
    assert.deepEqual(fixture.state().comments, []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a dry run lints the injected body with --new-issue and writes nothing', () => {
  const fixture = setup({ labels: [] });
  try {
    const result = fixture.run(files(fixture));
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry-run');
    const lint = report.steps.find((s: { step: string }) => s.step === 'lint');
    assert.ok(lint.detail.args.includes('--new-issue'));
    assert.ok(!lint.detail.args.includes('--expect-bucket'));
    assert.ok(!lint.detail.args.includes('--label'));
    const labels = report.steps.find(
      (s: { step: string }) => s.step === 'labels',
    );
    assert.deepEqual(labels.detail.create, ['status:authoring']);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a needs-decision dry run passes the bucket and both labels to the linter', () => {
  const fixture = setup({ labels: ['status:authoring'] });
  try {
    const result = fixture.run(files(fixture, 'needs-decision'));
    const report = JSON.parse(result.stdout);
    const lint =
      report.lint ??
      report.steps.find((s: { step: string }) => s.step === 'lint').detail;
    assert.deepEqual(lint.args.slice(-6), [
      '--expect-bucket',
      'needs-decision',
      '--label',
      'status:authoring',
      '--label',
      'status:needs-decision',
    ]);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a label that cannot be created refuses before the journal write', () => {
  const fixture = setup({ labels: [], failLabelCreate: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    assert.deepEqual(writes(fixture.log()), [
      'label create status:authoring --repo',
    ]);
    assert.deepEqual(fixture.state().comments, []);
    assert.deepEqual(fixture.state().issues, {});
  } finally {
    fixture.restore();
  }
});

test('CLI: --apply runs the mutations in the contract order and ends at member', () => {
  const fixture = setup({ labels: [] });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'published');
    assert.equal(report.issue, `o/r#${NEW_ISSUE}`);
    const order: string[] = [];
    for (const entry of fixture.log()) {
      const kind = kindOf(entry);
      if (kind !== null && order[order.length - 1] !== kind) order.push(kind);
    }
    assert.deepEqual(order, [
      'journal-check',
      'label',
      'journal-pending',
      'create',
      'identity-attach',
      'owner-marker',
      'provenance',
      'member',
    ]);
    const created = fixture.state().issues[String(NEW_ISSUE)] as {
      body: string;
      labels: string[];
    };
    assert.match(created.body, /^<!-- idd-skill-authoring-publication: /);
    assert.deepEqual(created.labels, ['status:authoring']);
  } finally {
    fixture.restore();
  }
});

test('CLI: a failure after the create leaves the journal pending and prints the issue', () => {
  const fixture = setup({ editedComments: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'recovery-hold');
    assert.equal(report.failedStep, 'provenance');
    assert.equal(report.journalState, 'pending');
    assert.equal(report.number, NEW_ISSUE);
    assert.match(result.stderr, new RegExp(`o/r#${NEW_ISSUE}`));
    const journal = fixture
      .state()
      .comments.filter((comment) => comment.issue === 2674);
    assert.equal(journal.length, 2);
    assert.ok(
      journal.every((comment) => comment.body.includes('state=pending')),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: an issue created without its label gets the label back as a safe hold and exits 1', () => {
  const fixture = setup({ dropLabels: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'create-verify');
    assert.equal(report.journalState, 'pending');
    const issue = fixture.state().issues[String(NEW_ISSUE)] as {
      labels: string[];
    };
    assert.deepEqual(issue.labels, ['status:authoring']);
    assert.ok(
      !fixture.state().comments.some((comment) => comment.issue === NEW_ISSUE),
    );
  } finally {
    fixture.restore();
  }
});

/** The journal records the stub stored, in order. */
function journalRecords(fixture: Fixture): string[] {
  return fixture
    .state()
    .comments.filter((comment) => comment.issue === 2674)
    .map((comment) => comment.body);
}

test('CLI: a failed identity attach stops before the owner marker and keeps the record pending', () => {
  const fixture = setup({ failJournalPostAt: 2 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'identity-attach');
    assert.equal(report.number, NEW_ISSUE);
    const records = journalRecords(fixture);
    assert.equal(records.length, 1);
    assert.match(
      records[0] ?? '',
      /issue=none; actor=kurone-kito; state=pending/,
    );
    assert.ok(
      !fixture.state().comments.some((comment) => comment.issue === NEW_ISSUE),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a claim that appears during acquisition stops before member', () => {
  const fixture = setup({ claimOnCreate: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /active claim/);
    const records = journalRecords(fixture);
    assert.equal(records.length, 2);
    assert.ok(records.every((body) => body.includes('state=pending')));
  } finally {
    fixture.restore();
  }
});

test('CLI: with no trusted marker actor configured, --apply writes nothing', () => {
  const fixture = setup({ trusted: [] });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no trusted marker actor/);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: a member record that posts but fails its read-back reports an uncertain journal state', () => {
  const fixture = setup({ corruptReadbackAt: 3 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.equal(report.journalState, 'uncertain: replay the journal');
    assert.match(journalRecords(fixture)[2] ?? '', /state=member/);
  } finally {
    fixture.restore();
  }
});

test('CLI: a released claim does not block member', () => {
  const fixture = setup({ claimOnCreate: 'released' });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).outcome, 'published');
  } finally {
    fixture.restore();
  }
});

test('CLI: an open linked pull request stops before member', () => {
  const fixture = setup({ openPr: true });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /open linked pull request/);
    assert.ok(
      journalRecords(fixture).every((body) => body.includes('state=pending')),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a foreign owner marker that lands after provenance stops before member', () => {
  // The first GraphQL comment read is the provenance run; the second is the
  // final owner-log replay.
  const fixture = setup({ foreignOwnerOnRead: 2 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /owner-marker replay/);
    assert.ok(
      journalRecords(fixture).every((body) => body.includes('state=pending')),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a pending record that posts but fails its read-back refuses with an uncertain journal state', () => {
  const fixture = setup({ corruptReadbackAt: 1 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'refused');
    assert.equal(report.journalState, 'uncertain: replay the journal');
    assert.deepEqual(fixture.state().issues, {});
  } finally {
    fixture.restore();
  }
});

test('CLI: a body edited before the owner marker stops before member', () => {
  // The edit lands with the identity-attach record, so the owner marker
  // hashes the edited body and only the created-body comparison catches it.
  const fixture = setup({ mutateBodyAt: 2 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /not the body this run created/);
  } finally {
    fixture.restore();
  }
});

test('CLI: an unlabeled issue that already carries another owner marker is left untouched', () => {
  // The recovery read is the first GraphQL comment read of this run.
  const fixture = setup({ dropLabels: true, foreignOwnerOnRead: 1 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'create-verify');
    assert.match(report.reason, /another owner marker is present/);
    const issue = fixture.state().issues[String(NEW_ISSUE)] as {
      labels: string[];
    };
    assert.deepEqual(issue.labels, []);
    assert.ok(
      !fixture
        .log()
        .some((entry) => entry.args[0] === 'issue' && entry.args[1] === 'edit'),
    );
  } finally {
    fixture.restore();
  }
});

test('CLI: a member post that may have landed without a reply reports an uncertain journal state', () => {
  const fixture = setup({ ambiguousPostAt: 3 });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.failedStep, 'member');
    assert.match(report.reason, /may have been posted/);
    assert.equal(report.journalState, 'uncertain: replay the journal');
    assert.match(journalRecords(fixture)[2] ?? '', /state=member/);
  } finally {
    fixture.restore();
  }
});

test('CLI: a trusted login without write permission writes nothing', () => {
  const fixture = setup({ permission: 'read' });
  try {
    const result = fixture.run([...files(fixture), '--apply']);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /does not have Write, Maintain or Admin permission/,
    );
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});

test('CLI: an explicit repository outside this checkout needs --marker-prefix', () => {
  const fixture = setup();
  try {
    const args = files(fixture);
    const index = args.indexOf('--marker-prefix');
    args.splice(index, 2);
    const result = fixture.run([...args, '--apply']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--marker-prefix is required/);
    assert.deepEqual(writes(fixture.log()), []);
  } finally {
    fixture.restore();
  }
});
