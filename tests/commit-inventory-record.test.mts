import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type CommitInventoryCommentInput,
  parseCommitInventoryComment,
  renderCommitInventoryComment,
  selectCommitInventoryForHead,
} from '../src/scripts/marker-helpers.mts';

// kurone-kito/idd-skill#5213: the machine-readable commit inventory record.
// Each must-keep shape from the issue has its own assertion below.

const ISSUE = 5213;
const PREFIX = 'idd-skill';
const BASE = 'c'.repeat(40);
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const TRUSTED = ['kurone-kito'];

function entries(
  overrides: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  return [
    {
      sha: HEAD,
      paths: ['src/z.mts', 'src/a.mts'],
      disposition: 'child',
      reach: 'pushed',
      ...overrides,
    },
  ];
}

function record(head = HEAD, list = entries()): string {
  return renderCommitInventoryComment({
    markerPrefix: PREFIX,
    agentId: 'worker-1',
    issueNumber: ISSUE,
    branch: 'issue/5213-feat-commit-inventory',
    baseSha: BASE,
    headSha: head,
    entries: list,
  });
}

function trustedUnedited(body: string): CommitInventoryCommentInput {
  return { body, authorLogin: 'kurone-kito', lastEditedAt: null };
}

function select(comments: CommitInventoryCommentInput[], head = HEAD) {
  return selectCommitInventoryForHead(comments, {
    markerPrefix: PREFIX,
    headSha: head,
    issueNumber: ISSUE,
    trustedLogins: TRUSTED,
  });
}

test('a commit inventory record round-trips every field the cleanup reads', () => {
  const body = record();
  const parsed = parseCommitInventoryComment(body, PREFIX);
  assert.ok(parsed, 'the canonical record parses');
  assert.equal(parsed.branch, 'issue/5213-feat-commit-inventory');
  assert.equal(parsed.baseSha, BASE);
  assert.equal(parsed.headSha, HEAD);
  assert.deepEqual(parsed.entries, [
    {
      sha: HEAD,
      paths: ['src/z.mts', 'src/a.mts'],
      disposition: 'child',
      reach: 'pushed',
    },
  ]);
});

test('an entry that omits reach does not count, so the record does not parse', () => {
  // Built by hand: the renderer refuses an entry without reach, and the
  // parser must refuse the same shape when it is posted anyway.
  const body =
    `<!-- ${PREFIX}-commit-inventory: v1 agent=worker-1 issue=${ISSUE} ` +
    `branch=issue%2F5213-x base=${BASE} head=${HEAD} ` +
    `entries=${encodeURIComponent(JSON.stringify([{ sha: HEAD, paths: ['src/a.mts'], disposition: 'child' }]))} -->\n\n_note_`;
  assert.equal(parseCommitInventoryComment(body, PREFIX), null);
  assert.throws(() =>
    renderCommitInventoryComment({
      markerPrefix: PREFIX,
      agentId: 'worker-1',
      issueNumber: ISSUE,
      branch: 'issue/5213-x',
      baseSha: BASE,
      headSha: HEAD,
      entries: [{ sha: HEAD, paths: ['src/a.mts'], disposition: 'child' }],
    }),
  );
});

test('a disposition outside child, in-base, and not-reusable is rejected', () => {
  assert.throws(() =>
    renderCommitInventoryComment({
      markerPrefix: PREFIX,
      agentId: 'worker-1',
      issueNumber: ISSUE,
      branch: 'issue/5213-x',
      baseSha: BASE,
      headSha: HEAD,
      entries: entries({ disposition: 'discard' }),
    }),
  );
});

test('an entry path containing --> cannot end the marker early', () => {
  const body = record(HEAD, entries({ paths: ['docs/a-->b.md'] }));
  const parsed = parseCommitInventoryComment(body, PREFIX);
  assert.ok(parsed, 'the encoded path still round-trips');
  assert.deepEqual(parsed.entries[0].paths, ['docs/a-->b.md']);
});

test('a single trusted, unedited record for the live head is accepted', () => {
  const result = select([trustedUnedited(record())]);
  assert.equal(result.status, 'accepted');
});

test('an empty entry list is a valid record, so an overrun with no branch-only commits can post one', () => {
  // The source branch can equal the development branch before the first
  // implementation commit, so the inventory is legitimately empty (Codex P2
  // on PR #5241). The empty record must parse and govern the live head.
  const body = record(HEAD, []);
  const parsed = parseCommitInventoryComment(body, PREFIX);
  assert.ok(parsed, 'the empty record parses');
  assert.deepEqual(parsed.entries, []);
  const result = select([trustedUnedited(body)]);
  assert.equal(result.status, 'accepted');
});

test('no record-shaped comment for this issue is absent, so prose applies', () => {
  assert.deepEqual(select([]), { status: 'absent' });
});

test('a trusted, unedited record for an older head stops, so a fresh record must be posted', () => {
  assert.deepEqual(select([trustedUnedited(record(OTHER_HEAD))], HEAD), {
    status: 'stop',
    reason: 'stale-record',
  });
});

test('a live record beside an older record is accepted, and the older one is ignored', () => {
  const result = select([
    trustedUnedited(record(OTHER_HEAD)),
    trustedUnedited(record(HEAD)),
  ]);
  assert.equal(result.status, 'accepted');
});

test('a record that names another issue stops, even when its head is live', () => {
  // A record that is well formed for another issue, copied onto this one.
  const copied = renderCommitInventoryComment({
    markerPrefix: PREFIX,
    agentId: 'worker-1',
    issueNumber: 9999,
    branch: 'issue/9999-x',
    baseSha: BASE,
    headSha: HEAD,
    entries: entries(),
  });
  assert.deepEqual(select([trustedUnedited(copied)]), {
    status: 'stop',
    reason: 'wrong-issue',
  });
});
test('an edited live record stops', () => {
  const result = select([
    {
      body: record(),
      authorLogin: 'kurone-kito',
      lastEditedAt: '2026-11-15T12:00:00Z',
    },
  ]);
  assert.deepEqual(result, { status: 'stop', reason: 'edited' });
});

test('a live record with an unknown edit state stops', () => {
  const result = select([{ body: record(), authorLogin: 'kurone-kito' }]);
  assert.deepEqual(result, { status: 'stop', reason: 'unknown-edit-state' });
});

test('a live record from an untrusted author stops', () => {
  const result = select([
    { body: record(), authorLogin: 'someone-else', lastEditedAt: null },
  ]);
  assert.deepEqual(result, { status: 'stop', reason: 'untrusted-author' });
  const anonymous = select([
    { body: record(), authorLogin: null, lastEditedAt: null },
  ]);
  assert.deepEqual(anonymous, { status: 'stop', reason: 'untrusted-author' });
});

test('two trusted, unedited records for the same head stop as duplicates', () => {
  const result = select([trustedUnedited(record()), trustedUnedited(record())]);
  assert.deepEqual(result, { status: 'stop', reason: 'duplicate' });
});

test('a live record with an entry that omits reach stops as malformed', () => {
  const malformed =
    `<!-- ${PREFIX}-commit-inventory: v1 agent=worker-1 issue=${ISSUE} ` +
    `branch=issue%2F5213-x base=${BASE} head=${HEAD} ` +
    `entries=${encodeURIComponent(JSON.stringify([{ sha: HEAD, paths: ['a'], disposition: 'child' }]))} -->\n\n_note_`;
  assert.deepEqual(select([trustedUnedited(malformed)]), {
    status: 'stop',
    reason: 'malformed',
  });
});

test('a record-shaped comment whose head cannot be read is checked and stops', () => {
  const broken = `<!-- ${PREFIX}-commit-inventory: v1 agent=worker-1 issue=${ISSUE} entries=%5B%5D -->\n\n_note_`;
  assert.deepEqual(select([trustedUnedited(broken)]), {
    status: 'stop',
    reason: 'malformed',
  });
});

test('a machine record does not depend on a prose comment, and the prose rule is not consulted when it governs', () => {
  const prose = {
    body: `Commit inventory for ${HEAD}: child ${HEAD}`,
    authorLogin: 'kurone-kito',
    lastEditedAt: null,
  };
  // The prose comment is not record-shaped, so the selector ignores it.
  assert.equal(select([prose, trustedUnedited(record())]).status, 'accepted');
});

test('the instructions and both rationale copies state the record rule and keep the stale-record follow-up', async () => {
  const { readFileSync } = await import('node:fs');
  for (const path of [
    'idd-template/docs/idd-design-rationale.md',
    'docs/idd-design-rationale.md',
  ]) {
    const text = readFileSync(path, 'utf8').replace(/\s+/gu, ' ');
    assert.equal(
      text.includes('The durable record contract (a marker type and a helper'),
      false,
      `${path} no longer calls the durable record a follow-up`,
    );
    assert.ok(
      text.includes('The durable record is the `commit-inventory` marker'),
      `${path} names the commit-inventory marker`,
    );
    assert.ok(
      /Superseding a stale record[^.]*follow-up/u.test(text),
      `${path} still calls superseding a stale record a follow-up`,
    );
  }
  for (const path of [
    'idd-template/.github/instructions/idd-work.instructions.md',
    '.github/instructions/idd-work.instructions.md',
  ]) {
    const text = readFileSync(path, 'utf8').replace(/\s+/gu, ' ');
    assert.ok(
      text.includes(
        'exactly one trusted, unedited inventory record for the live head',
      ),
      `${path} states the record rule`,
    );
  }
});

test('a head token that cannot be read stops even when later prose names a valid head', () => {
  const body =
    `<!-- ${PREFIX}-commit-inventory: v1 agent=worker-1 issue=${ISSUE} ` +
    `branch=issue%2F5213-x base=${BASE} head=ZZZ ` +
    `entries=${encodeURIComponent(JSON.stringify([{ sha: HEAD, paths: ['a'], disposition: 'child', reach: 'pushed' }]))} -->\n\n` +
    `_note_ see head=${OTHER_HEAD} below`;
  assert.deepEqual(select([trustedUnedited(body)]), {
    status: 'stop',
    reason: 'malformed',
  });
});

test('an edited live-trusted record that names another head still stops, and is not skipped', () => {
  const result = select([
    {
      body: record(OTHER_HEAD),
      authorLogin: 'kurone-kito',
      lastEditedAt: '2026-11-15T12:00:00Z',
    },
  ]);
  assert.deepEqual(result, { status: 'stop', reason: 'edited' });
});

test('an untrusted record for another head stops, because author checks run before the head check', () => {
  const result = select([
    {
      body: record(OTHER_HEAD),
      authorLogin: 'someone-else',
      lastEditedAt: null,
    },
  ]);
  assert.deepEqual(result, { status: 'stop', reason: 'untrusted-author' });
});

test('the CLI refuses --pull-request for commit-inventory', async () => {
  const { spawnSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const result = spawnSync(
    process.execPath,
    [
      resolve('scripts/post-idd-marker.mjs'),
      '--type',
      'commit-inventory',
      '--target',
      'issue',
      '4674',
      '--agent-id',
      'worker-1',
      '--branch',
      'issue/4674-x',
      '--base-sha',
      BASE,
      '--head-sha',
      HEAD,
      '--entries',
      JSON.stringify([
        { sha: HEAD, paths: ['a'], disposition: 'child', reach: 'pushed' },
      ]),
      '--pull-request',
      '9',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /--pull-request does not apply to --type commit-inventory/u,
  );
});
