import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeComment,
  normalizeThread,
  parseArgs,
  resolveActivitySnapshotTrustedMarkerLogins,
} from '../src/scripts/review-activity-snapshot.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SNAPSHOT_HEAD = 'b'.repeat(40);
const COURTESY_ACK =
  '`@kurone-kito`, confirmed. Thanks for the fix.\n\n✅ Review thread resolved.\n\n<!-- This is an auto-generated reply by CodeRabbit -->';

// Importing the CLI module directly is only possible now that its top-level
// statements are guarded behind `import.meta.main` (#1210, migrated from
// isCliExecution() by #1447); previously the import parsed process.argv and
// called a `gh` command, aborting the test process when no --pr argument or
// gh binary was available.
test('importing review-activity-snapshot.mts has no import-time side effect', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.doesNotReject(
      import('../src/scripts/review-activity-snapshot.mts'),
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: parses --pr, --owner, --repo, and the login-list flags', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
    '--trusted-marker-logins',
    'a,b',
    '--advisory-bot-logins',
    'c,d',
  ]);
  assert.equal(args.prNumber, 42);
  assert.equal(args.owner, 'kurone-kito');
  assert.equal(args.repo, 'idd-skill');
  assert.equal(args.trustedMarkerLogins, 'a,b');
  assert.equal(args.advisoryBotLogins, 'c,d');
  assert.equal(args.help, false);
});

test('parseArgs: an invalid --pr resolves to null (fails closed at the caller)', () => {
  const args = parseArgs(['--pr', 'not-a-number']);
  assert.equal(args.prNumber, null);
});

test('parseArgs: an absent --pr also resolves to null', () => {
  // CodeRabbit review finding on #1450: only the invalid-value case was
  // covered; --help doesn't assert prNumber, so the absent-value contract
  // was unprotected.
  const args = parseArgs([]);
  assert.equal(args.prNumber, null);
});

test('parseArgs: --pr keeps its pre-#1450 permissive Number.parseInt contract', () => {
  // Regression coverage for a CodeRabbit review finding on #1450: the
  // wrapper migration must not swap in cli-args.mts's stricter
  // canonical-pattern integer parser here, which would reject trailing-
  // garbage and leading-zero tokens the original Number.parseInt-based
  // parser always accepted.
  assert.equal(parseArgs(['--pr', '42abc']).prNumber, 42);
  assert.equal(parseArgs(['--pr', '007']).prNumber, 7);
});

test('parseArgs: a missing --pr value throws', () => {
  assert.throws(() => parseArgs(['--pr']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --owner would greedily accept '--repo' as its literal
  // value, silently leaving --repo unset (the #1082 gap this migration
  // closes structurally for this helper).
  assert.throws(() => parseArgs(['--pr', '42', '--owner', '--repo']));
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: --help is recognized without requiring --pr', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

// --- #3337: viewer-inclusive trusted-marker-login set for digest exclusion -

test('resolveActivitySnapshotTrustedMarkerLogins includes the viewer login when no trusted marker actors are configured', () => {
  const result = resolveActivitySnapshotTrustedMarkerLogins([], {
    viewerLogin: 'idd-bot',
    viewerLoginUnavailable: false,
  });
  assert.deepEqual(result, ['idd-bot']);
});

test('resolveActivitySnapshotTrustedMarkerLogins merges the viewer login with configured trusted actors', () => {
  const result = resolveActivitySnapshotTrustedMarkerLogins(['a-maintainer'], {
    viewerLogin: 'idd-bot',
    viewerLoginUnavailable: false,
  });
  assert.deepEqual(result, ['a-maintainer', 'idd-bot']);
});

test('resolveActivitySnapshotTrustedMarkerLogins excludes the viewer login when it is reported unavailable', () => {
  const result = resolveActivitySnapshotTrustedMarkerLogins(['a-maintainer'], {
    viewerLogin: 'idd-bot',
    viewerLoginUnavailable: true,
  });
  assert.deepEqual(result, ['a-maintainer']);
});

test('resolveActivitySnapshotTrustedMarkerLogins deduplicates a viewer login already in the configured set', () => {
  const result = resolveActivitySnapshotTrustedMarkerLogins(['idd-bot'], {
    viewerLogin: 'idd-bot',
    viewerLoginUnavailable: false,
  });
  assert.deepEqual(result, ['idd-bot']);
});

function courtesyThreadGraphql(replyBody: string): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'PRRT_courtesy',
                isResolved: true,
                path: 'src/a.ts',
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'C1',
                      body: 'please fix this',
                      createdAt: '2026-05-12T00:00:00Z',
                      updatedAt: '2026-05-12T00:00:00Z',
                      lastEditedAt: null,
                      author: { login: 'reviewer-a' },
                      pullRequestReview: { id: 'PRR_1' },
                    },
                    {
                      id: 'C2',
                      body: '**Accepted** — done.',
                      createdAt: '2026-05-12T00:30:00Z',
                      updatedAt: '2026-05-12T00:30:00Z',
                      lastEditedAt: null,
                      author: { login: 'kurone-kito' },
                      pullRequestReview: null,
                    },
                    {
                      id: 'C3',
                      body: replyBody,
                      createdAt: '2026-05-12T02:00:00Z',
                      updatedAt: '2026-05-12T02:00:00Z',
                      lastEditedAt: null,
                      author: { login: 'coderabbitai[bot]' },
                      pullRequestReview: null,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
      nodes: [{ id: 'C_1', lastEditedAt: null }],
    },
  });
}

function snapshotGhStub(graphqlJson: string, commentNdjson: string): string {
  return `const fs = require('node:fs');
const args = process.argv.slice(2);
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
if (args[0] === 'api' && args[1] === 'user') out('kurone-kito\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  out(${JSON.stringify(JSON.stringify({ headRefOid: SNAPSHOT_HEAD, author: { login: 'pr-author' } }))});
}
if (args[0] === 'pr' && args[1] === 'checks') out('[]');
if (args[0] === 'api' && args[1] === 'graphql') out(${JSON.stringify(graphqlJson)});
if (args[0] === 'api' && /\\/reviews$/.test(args[1])) out('');
if (args[0] === 'api' && /\\/comments$/.test(args[1])) out(${JSON.stringify(commentNdjson)});
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`;
}

function runSnapshot(
  graphqlJson: string,
  commentNdjson = '',
): {
  dispositionEvidence: {
    missingRegularCommentCount: number;
    missingThreadCount: number;
    soleCauseAckOnlyPostDisposition: boolean;
  };
} {
  const restore = stubExecutable(
    'gh',
    snapshotGhStub(graphqlJson, commentNdjson),
  );
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/review-activity-snapshot.mjs'),
        '--pr',
        '42',
        '--owner',
        'o',
        '--repo',
        'r',
        '--trusted-marker-logins',
        'kurone-kito',
        '--advisory-bot-logins',
        'coderabbitai[bot]',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    return JSON.parse(output);
  } finally {
    restore();
  }
}

test('review-activity snapshot JSON includes soleCauseAckOnlyPostDisposition for a courtesy ack (#3482)', () => {
  const report = runSnapshot(courtesyThreadGraphql(COURTESY_ACK));
  assert.equal(report.dispositionEvidence.missingRegularCommentCount, 0);
  assert.equal(report.dispositionEvidence.missingThreadCount, 1);
  assert.equal(
    report.dispositionEvidence.soleCauseAckOnlyPostDisposition,
    true,
  );
});

test('review-activity snapshot keeps the courtesy-ack flag false for a substantive bot reply (#3482)', () => {
  const report = runSnapshot(
    courtesyThreadGraphql('please also rename this helper before merging'),
  );
  assert.equal(report.dispositionEvidence.missingThreadCount, 1);
  assert.equal(
    report.dispositionEvidence.soleCauseAckOnlyPostDisposition,
    false,
  );
});

test('review-activity snapshot keeps the courtesy-ack flag false when a regular comment is still missing (#3482)', () => {
  const report = runSnapshot(
    courtesyThreadGraphql(COURTESY_ACK),
    JSON.stringify({
      node_id: 'C_1',
      user: { login: 'someone' },
      body: 'still open',
      created_at: '2026-05-12T03:00:00Z',
      updated_at: '2026-05-12T03:00:00Z',
    }),
  );
  assert.equal(report.dispositionEvidence.missingRegularCommentCount, 1);
  assert.equal(
    report.dispositionEvidence.soleCauseAckOnlyPostDisposition,
    false,
  );
});

// #3249: `normalizeComment` and `normalizeThread` must carry `lastEditedAt`
// through from the provider-port shape, or `summarizeDispositionEvidenceFor-
// Gate` (fed by `port.listWorkItemComments(..., { includeEditState: true })`
// above) would see every comment's edit state as `unknown` and reject
// legitimate unedited dispositions along with edited ones.

test('normalizeComment carries lastEditedAt through from the provider comment', () => {
  assert.equal(
    normalizeComment({
      id: 1,
      nodeId: 'C_1',
      body: 'looks good',
      createdAt: '2026-05-12T00:00:00Z',
      updatedAt: '2026-05-12T00:00:00Z',
      authorLogin: 'reviewer-a',
      lastEditedAt: null,
    }).lastEditedAt,
    null,
  );
  assert.equal(
    normalizeComment({
      id: 2,
      nodeId: 'C_2',
      body: 'edited later',
      createdAt: '2026-05-12T00:00:00Z',
      updatedAt: '2026-05-12T01:00:00Z',
      authorLogin: 'reviewer-a',
      lastEditedAt: '2026-05-12T01:00:00Z',
    }).lastEditedAt,
    '2026-05-12T01:00:00Z',
  );
});

test('normalizeThread carries lastEditedAt through for each nested comment', () => {
  const normalized = normalizeThread({
    id: 'RT_1',
    isResolved: false,
    comments: [
      {
        body: '**Accepted** — done',
        createdAt: '2026-05-12T00:00:00Z',
        updatedAt: '2026-05-12T00:00:00Z',
        authorLogin: 'idd-bot',
        pullRequestReviewId: null,
        lastEditedAt: null,
      },
    ],
  });
  assert.equal(normalized.comments.nodes[0].lastEditedAt, null);
});
