import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadIddConfig } from '../src/scripts/idd-config.mts';
import {
  buildCodeRabbitEmbeddedFindings,
  buildCopilotOverviewLabels,
  buildCopilotReviewBodyRemarks,
  collectReviewActivitySnapshot,
  normalizeComment,
  normalizeThread,
  parseArgs,
  resolveActivitySnapshotTrustedMarkerLogins,
} from '../src/scripts/review-activity-snapshot.mts';
import { PR_1897_REVIEW_4863787336 } from './coderabbit-pr-1897-review.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
// The CLI reads the policy file at the PR base ref (#3958); the stub answers
// that read with the repository's own file, as the working tree used to.
const POLICY_B64 = Buffer.from(
  readFileSync(join(REPO_ROOT, '.github/idd/config.json'), 'utf8'),
).toString('base64');
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

test('collectReviewActivitySnapshot calls each rich loader once', () => {
  const calls: string[] = [];
  const snapshot = collectReviewActivitySnapshot({
    prNumber: 3592,
    owner: 'o',
    repo: 'r',
    loadTrustedConfig: () => loadIddConfig(),
    trustedMarkerLoginsFlag: '',
    advisoryBotLoginsFlag: '',
    envTrustedMarkerActors: '',
    envAdvisoryBotLogins: '',
    port: {
      resolveViewerLoginSafe: () => {
        calls.push('viewer');
        return { viewerLogin: '', viewerLoginUnavailable: true };
      },
      getChangeRequestHeadShaAndAuthor: () => {
        calls.push('head');
        return {
          headSha: 'c'.repeat(40),
          authorLogin: 'someone',
          baseRefName: 'main',
        };
      },
      getRepositoryDefaultBranch: () => 'main',
      listChangeRequestChecks: () => {
        calls.push('checks');
        return [];
      },
      listReviews: () => {
        calls.push('reviews');
        return [];
      },
      listWorkItemComments: () => {
        calls.push('comments');
        return [];
      },
      listChangeRequestReviewThreadsWithComments: () => {
        calls.push('threads');
        return [];
      },
      getReviewThreadCommentUserContentEdits: () => {
        calls.push('edit-histories');
        return [];
      },
    },
  });
  assert.deepEqual(calls, [
    'head',
    'viewer',
    'checks',
    'reviews',
    'comments',
    'threads',
  ]);
  assert.equal(snapshot.headSha, 'c'.repeat(40));
  assert.equal(
    (snapshot.dispositionEvidence as { missingRegularCommentCount: number })
      .missingRegularCommentCount,
    0,
  );
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

function courtesyThreadGraphql(
  replyBody: string,
  pullRequestReviewId = 'PRR_1',
): string {
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
                      pullRequestReview: { id: pullRequestReviewId },
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

function snapshotGhStub(
  graphqlJson: string,
  commentNdjson: string,
  reviewNdjson: string,
): string {
  return `const fs = require('node:fs');
const args = process.argv.slice(2);
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
if (args[0] === 'api' && args[1] === 'user') out('kurone-kito\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  out(${JSON.stringify(JSON.stringify({ headRefOid: SNAPSHOT_HEAD, author: { login: 'pr-author' }, baseRefName: 'main' }))});
}
if (args[0] === 'api' && String(args[1]).includes('/contents/.github/idd/config.json')) out(${JSON.stringify(POLICY_B64)});
if (args[0] === 'pr' && args[1] === 'checks') out('[]');
if (args[0] === 'api' && args[1] === 'graphql' && args.join(' ').includes('databaseId')) {
  const raw = ${JSON.stringify(commentNdjson)};
  const rows = raw.trim() === ''
    ? []
    : raw.trim().split('\\n').map((line) => JSON.parse(line));
  const nodes = rows.map((row, index) => ({
    id: row.node_id || ('C_rest_' + (index + 1)),
    databaseId: typeof row.id === 'number' ? row.id : index + 1,
    body: row.body || '',
    createdAt: row.created_at || '2026-05-12T03:00:00Z',
    updatedAt: row.updated_at || row.created_at || '2026-05-12T03:00:00Z',
    lastEditedAt: null,
    author: {
      login: (row.user && row.user.login) || '',
      __typename: 'User',
    },
  }));
  out(JSON.stringify({
    data: {
      repository: {
        issue: null,
        pullRequest: {
          comments: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  }));
}
if (args[0] === 'api' && args[1] === 'graphql') out(${JSON.stringify(graphqlJson)});
if (args[0] === 'api' && /\\/reviews$/.test(args[1])) out(${JSON.stringify(reviewNdjson)});
if (args[0] === 'api' && /\\/comments$/.test(args[1])) out(${JSON.stringify(commentNdjson)});
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`;
}

function runSnapshot(
  graphqlJson: string,
  commentNdjson = '',
  reviewNdjson = '',
): {
  dispositionEvidence: {
    missingRegularCommentCount: number;
    missingThreadCount: number;
    soleCauseAckOnlyPostDisposition: boolean;
  };
  embeddedFindings: {
    reviewId: string;
    embeddedFindingCount: number;
    uncoveredCount: number;
  }[];
  reviewBodyRemarks: {
    reviewId: string;
    author: string;
    commitId: string;
    remark: string;
  }[];
  latestPrimaryBotReview?: {
    matchesHead: boolean;
    reviewAckNeeded: boolean;
  } | null;
} {
  const restore = stubExecutable(
    'gh',
    snapshotGhStub(graphqlJson, commentNdjson, reviewNdjson),
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

const PR_1897_REVIEW_ID = 'PRR_kwDO_1897_4863787336';

test('review-activity snapshot serializes CodeRabbit embedded findings from REST and GraphQL data (#3341)', () => {
  const reviewNdjson = `${JSON.stringify({
    node_id: PR_1897_REVIEW_ID,
    user: { login: 'coderabbitai[bot]' },
    body: PR_1897_REVIEW_4863787336,
    state: 'COMMENTED',
  })}\n`;
  const report = runSnapshot(
    courtesyThreadGraphql('embedded finding thread', PR_1897_REVIEW_ID),
    '',
    reviewNdjson,
  );
  assert.deepEqual(report.embeddedFindings, [
    {
      reviewId: PR_1897_REVIEW_ID,
      embeddedFindingCount: 1,
      uncoveredCount: 0,
    },
  ]);
  // #3672: a CodeRabbit-only review list adds no remark row.
  assert.deepEqual(report.reviewBodyRemarks, []);
});

test('embeddedFindings reports uncoveredCount 1 for PR #1897 review 4863787336 when no thread belongs to that review', () => {
  const findings = buildCodeRabbitEmbeddedFindings(
    [
      {
        node_id: PR_1897_REVIEW_ID,
        user: { login: 'coderabbitai[bot]' },
        body: PR_1897_REVIEW_4863787336,
        state: 'COMMENTED',
      },
      {
        node_id: 'PRR_other',
        user: { login: 'copilot' },
        body: PR_1897_REVIEW_4863787336,
        state: 'COMMENTED',
      },
    ],
    [],
  );
  assert.deepEqual(findings, [
    {
      reviewId: PR_1897_REVIEW_ID,
      embeddedFindingCount: 1,
      uncoveredCount: 1,
    },
  ]);
});

test('embeddedFindings reports uncoveredCount 0 when one thread belongs to PR #1897 review 4863787336', () => {
  const findings = buildCodeRabbitEmbeddedFindings(
    [
      {
        node_id: PR_1897_REVIEW_ID,
        user: { login: 'CodeRabbitAI[bot]' },
        body: PR_1897_REVIEW_4863787336,
        state: 'COMMENTED',
      },
    ],
    [
      {
        comments: {
          nodes: [
            {
              pullRequestReview: { id: PR_1897_REVIEW_ID },
            },
          ],
        },
      },
    ],
  );
  assert.equal(findings[0]?.uncoveredCount, 0);
  assert.equal(findings[0]?.embeddedFindingCount, 1);
});

test('embeddedFindings excludes CodeRabbit reviews that are not COMMENTED', () => {
  const findings = buildCodeRabbitEmbeddedFindings(
    [
      {
        node_id: PR_1897_REVIEW_ID,
        user: { login: 'coderabbitai[bot]' },
        body: PR_1897_REVIEW_4863787336,
        state: 'CHANGES_REQUESTED',
      },
    ],
    [],
  );
  assert.deepEqual(findings, []);
});

test('embeddedFindings does not treat a missing node_id as covering threads with no review id', () => {
  const findings = buildCodeRabbitEmbeddedFindings(
    [
      {
        node_id: '',
        user: { login: 'coderabbitai' },
        body: PR_1897_REVIEW_4863787336,
        state: 'COMMENTED',
      },
    ],
    [
      {
        comments: {
          nodes: [{ pullRequestReview: { id: null } }],
        },
      },
    ],
  );
  assert.equal(findings[0]?.uncoveredCount, 1);
});

// --- #3672: Copilot review-body remark as non-gating evidence --------------

const REMARK = 'The unbounded read truncates at 1000 rows.';
const REMARK_ONLY_BODY = `<!-- ccr-overview-v2 -->\n\n## Copilot review overview\n\n### \u{1F535} Needs a closer look\n\n${REMARK}\n\n**Review effort:** Lite  \n**Findings:** None\n`;
const NO_REMARK_BODY =
  '<!-- ccr-overview-v2 -->\n\n## Copilot review overview\n\n**Review effort:** Lite  \n**Findings:** None\n';
const COPILOT_LOGIN = 'copilot-pull-request-reviewer[bot]';

test('reviewBodyRemarks lists a Copilot COMMENTED review with a remark', () => {
  assert.deepEqual(
    buildCopilotReviewBodyRemarks([
      {
        node_id: 'PRR_remark',
        commit_id: 'a'.repeat(40),
        user: { login: COPILOT_LOGIN },
        body: REMARK_ONLY_BODY,
        state: 'COMMENTED',
      },
    ]),
    [
      {
        reviewId: 'PRR_remark',
        author: COPILOT_LOGIN,
        commitId: 'a'.repeat(40),
        remark: REMARK,
      },
    ],
  );
});

test('reviewBodyRemarks omits other states, other authors, and a review with no remark', () => {
  const base = { node_id: 'PRR_x', body: REMARK_ONLY_BODY };
  assert.deepEqual(
    buildCopilotReviewBodyRemarks([
      { ...base, user: { login: COPILOT_LOGIN }, state: 'APPROVED' },
      { ...base, user: { login: COPILOT_LOGIN }, state: 'CHANGES_REQUESTED' },
      { ...base, user: { login: COPILOT_LOGIN }, state: 'DISMISSED' },
      { ...base, user: { login: 'coderabbitai[bot]' }, state: 'COMMENTED' },
      { ...base, user: { login: 'human-reviewer' }, state: 'COMMENTED' },
      // A registrable lookalike of the Copilot login is not Copilot.
      {
        ...base,
        user: { login: 'copilot-pull-request-reviewer1' },
        state: 'COMMENTED',
      },
      {
        node_id: 'PRR_none',
        user: { login: COPILOT_LOGIN },
        body: NO_REMARK_BODY,
        state: 'COMMENTED',
      },
      {
        node_id: 'PRR_empty',
        user: { login: COPILOT_LOGIN },
        state: 'COMMENTED',
      },
    ]),
    [],
  );
});

test('reviewBodyRemarks matches Copilot logins case-insensitively and defaults absent ids to empty', () => {
  assert.deepEqual(
    buildCopilotReviewBodyRemarks([
      {
        user: { login: ' Copilot ' },
        body: `### Needs a closer look\n\n${REMARK}`,
        state: 'COMMENTED',
      },
    ]),
    [{ reviewId: '', author: 'Copilot', commitId: '', remark: REMARK }],
  );
});

test('review-activity snapshot serializes reviewBodyRemarks from REST review data', () => {
  const reviewNdjson = [
    {
      node_id: 'PRR_copilot_remark',
      commit_id: SNAPSHOT_HEAD,
      user: { login: COPILOT_LOGIN },
      body: REMARK_ONLY_BODY,
      state: 'COMMENTED',
    },
    {
      node_id: 'PRR_copilot_clean',
      commit_id: SNAPSHOT_HEAD,
      user: { login: COPILOT_LOGIN },
      body: NO_REMARK_BODY,
      state: 'COMMENTED',
    },
    {
      node_id: 'PRR_coderabbit',
      commit_id: SNAPSHOT_HEAD,
      user: { login: 'coderabbitai[bot]' },
      body: REMARK_ONLY_BODY,
      state: 'COMMENTED',
    },
  ]
    .map((review) => JSON.stringify(review))
    .join('\n');
  const report = runSnapshot(
    courtesyThreadGraphql('embedded finding thread'),
    '',
    `${reviewNdjson}\n`,
  );
  assert.deepEqual(report.reviewBodyRemarks, [
    {
      reviewId: 'PRR_copilot_remark',
      author: COPILOT_LOGIN,
      commitId: SNAPSHOT_HEAD,
      remark: REMARK,
    },
  ]);
  // The CodeRabbit-only field is untouched by the Copilot remark.
  assert.deepEqual(
    report.embeddedFindings.map((finding) => finding.reviewId),
    ['PRR_coderabbit'],
  );
});

// kurone-kito/idd-skill#3907: the opt-in `latestPrimaryBotReview` field.
const LATEST_HEAD = 'c'.repeat(40);
const LATEST_COPILOT = 'copilot-pull-request-reviewer[bot]';

function latestPort(options: {
  fetchReviews?: () => unknown;
  comments?: object[];
  viewerLogin?: string;
}) {
  const port: Record<string, unknown> = {
    resolveViewerLoginSafe: () =>
      options.viewerLogin === undefined
        ? { viewerLogin: '', viewerLoginUnavailable: true }
        : { viewerLogin: options.viewerLogin, viewerLoginUnavailable: false },
    getChangeRequestHeadShaAndAuthor: () => ({
      headSha: LATEST_HEAD,
      authorLogin: 'someone',
      baseRefName: 'main',
    }),
    listChangeRequestChecks: () => [],
    listReviews: () => [],
    listWorkItemComments: () => options.comments ?? [],
    listChangeRequestReviewThreadsWithComments: () => [],
    getReviewThreadCommentUserContentEdits: () => [],
  };
  if (options.fetchReviews) {
    port.getChangeRequestReviewsWithHeadCommitDate = options.fetchReviews;
  }
  return port;
}

function latestSnapshot(
  options: Parameters<typeof latestPort>[0] & {
    include: boolean;
    trustedMarkerLoginsFlag?: string;
    headSha?: string;
    config?: object;
  },
) {
  const port = latestPort(options) as Parameters<
    typeof collectReviewActivitySnapshot
  >[0]['port'];
  if (options.headSha !== undefined) {
    (port as Record<string, unknown>).getChangeRequestHeadShaAndAuthor =
      () => ({
        headSha: options.headSha,
        authorLogin: 'someone',
        baseRefName: 'main',
      });
  }
  return collectReviewActivitySnapshot({
    prNumber: 3907,
    owner: 'o',
    repo: 'r',
    loadTrustedConfig: () => loadIddConfig(),
    trustedMarkerLoginsFlag: options.trustedMarkerLoginsFlag ?? '',
    advisoryBotLoginsFlag: '',
    envTrustedMarkerActors: '',
    envAdvisoryBotLogins: '',
    iddConfig: (options.config ?? {}) as never,
    includeLatestPrimaryBotReview: options.include,
    port,
  });
}

function providerReviewNode(
  id: string,
  body: string,
  overrides: {
    commitId?: string;
    replyOnly?: boolean;
    authorLogin?: string;
  } = {},
) {
  return {
    id,
    authorLogin: overrides.authorLogin ?? LATEST_COPILOT,
    authorTypename: 'Bot',
    submittedAt: '2026-10-09T01:00:00Z',
    commitId: overrides.commitId ?? LATEST_HEAD,
    commentCount: 0,
    body,
    replyOnly: overrides.replyOnly ?? false,
  };
}

test('latestPrimaryBotReview is omitted and no review request is made when the opt-in is off (#3907)', () => {
  const calls: string[] = [];
  const snapshot = latestSnapshot({
    include: false,
    fetchReviews: () => {
      calls.push('reviews');
      return { reviews: [], headCommittedAt: '' };
    },
  });
  assert.equal('latestPrimaryBotReview' in snapshot, false);
  assert.deepEqual(calls, []);
});

test('the opt-in reports the Previously-missed Copilot review with explicit values (#3907)', () => {
  const body = readFileSync(
    join(REPO_ROOT, 'tests/fixtures/bot-comment-corpus/corpus.json'),
    'utf8',
  );
  const entry = (JSON.parse(body) as { id: string; body: string }[]).find(
    (candidate) => candidate.id === 'copilot-v2-previously-missed-3196',
  );
  assert.ok(entry);
  const snapshot = latestSnapshot({
    include: true,
    fetchReviews: () => ({
      headCommittedAt: '',
      reviews: [providerReviewNode('PRR_latest', entry.body)],
    }),
  });
  assert.deepEqual(snapshot.latestPrimaryBotReview, {
    primaryBotLogin: 'copilot',
    reviewId: 'PRR_latest',
    commitId: LATEST_HEAD,
    matchesHead: true,
    bodyShape: 'overview-v2',
    suppressedCount: 1,
    reviewAckNeeded: true,
    reviewAckCovers: false,
  });
});

test('a configured non-default primary bot is followed, not Copilot (#3907)', () => {
  const config = { advisoryWait: { primaryBotLogin: 'acme-review' } };
  const snapshot = latestSnapshot({
    include: true,
    config,
    fetchReviews: () => ({
      headCommittedAt: '',
      reviews: [
        providerReviewNode(
          'PRR_acme',
          'Something the classifier does not know.',
          {
            authorLogin: 'acme-review[bot]',
          },
        ),
        providerReviewNode(
          'PRR_copilot',
          corpusEntryBody('copilot-v2-previously-missed-3196'),
        ),
      ],
    }),
  });
  // The Copilot review is later in the list but is not this bot's review.
  assert.deepEqual(snapshot.latestPrimaryBotReview, {
    primaryBotLogin: 'acme-review',
    reviewId: 'PRR_acme',
    commitId: LATEST_HEAD,
    matchesHead: true,
    bodyShape: 'unrecognized',
    suppressedCount: 0,
    reviewAckNeeded: false,
    reviewAckCovers: false,
  });
});

test('an invalid advisoryWait section falls back to the default Copilot bot (#3907)', () => {
  const snapshot = latestSnapshot({
    include: true,
    config: { advisoryWait: { primaryBotLogin: 123 } },
    fetchReviews: () => ({
      headCommittedAt: '',
      reviews: [
        providerReviewNode(
          'PRR_bad',
          'Something the classifier does not know.',
        ),
      ],
    }),
  });
  const evidence = snapshot.latestPrimaryBotReview as {
    primaryBotLogin: string;
    bodyShape: string | null;
    reviewAckNeeded: boolean;
  } | null;
  assert.equal(evidence?.primaryBotLogin, 'copilot');
  assert.equal(evidence?.bodyShape, 'unrecognized');
  assert.equal(evidence?.reviewAckNeeded, true);
});

test('the opt-in makes exactly one review fetch (#3907)', () => {
  let calls = 0;
  latestSnapshot({
    include: true,
    fetchReviews: () => {
      calls += 1;
      return { headCommittedAt: '', reviews: [] };
    },
  });
  assert.equal(calls, 1);
});

test('a failing fetch yields null and leaves every other key unchanged (#3907)', () => {
  const off = latestSnapshot({ include: false });
  const failing = latestSnapshot({
    include: true,
    fetchReviews: () => {
      throw new Error('graphql unavailable');
    },
  });
  assert.equal(failing.latestPrimaryBotReview, null);
  const { latestPrimaryBotReview: _ignored, ...rest } = failing;
  assert.deepEqual(rest, off);
});

test('an absent review method or a malformed HEAD yields null (#3907)', () => {
  assert.equal(latestSnapshot({ include: true }).latestPrimaryBotReview, null);
  const malformed = latestSnapshot({
    include: true,
    headSha: 'not-a-sha',
    fetchReviews: () => ({
      headCommittedAt: '',
      reviews: [providerReviewNode('PRR_x', 'body')],
    }),
  });
  assert.equal(malformed.latestPrimaryBotReview, null);
});

test('a trusted, unedited review-ack after the review sets reviewAckCovers (#3907)', () => {
  const snapshot = latestSnapshot({
    include: true,
    trustedMarkerLoginsFlag: 'kurone-kito',
    comments: [
      {
        id: 'ACK1',
        authorLogin: 'kurone-kito',
        body: `review-ack: claude-f3ef1280 ${LATEST_HEAD} 2026-10-09T02:00:00Z`,
        createdAt: '2026-10-09T02:00:00Z',
        updatedAt: '2026-10-09T02:00:00Z',
        lastEditedAt: null,
      },
    ],
    fetchReviews: () => ({
      headCommittedAt: '',
      reviews: [
        providerReviewNode(
          'PRR_ack',
          corpusEntryBody('copilot-v2-previously-missed-3196'),
        ),
      ],
    }),
  });
  const evidence = snapshot.latestPrimaryBotReview as {
    reviewAckCovers: boolean | null;
  } | null;
  assert.equal(evidence?.reviewAckCovers, true);
});

test('a review-ack from the viewer login is not a trusted ack (#3907)', () => {
  const snapshot = latestSnapshot({
    include: true,
    trustedMarkerLoginsFlag: 'kurone-kito',
    viewerLogin: 'viewer-bot',
    comments: [
      {
        id: 'ACK2',
        authorLogin: 'viewer-bot',
        body: `review-ack: claude-f3ef1280 ${LATEST_HEAD} 2026-10-09T02:00:00Z`,
        createdAt: '2026-10-09T02:00:00Z',
        updatedAt: '2026-10-09T02:00:00Z',
        lastEditedAt: null,
      },
    ],
    fetchReviews: () => ({
      headCommittedAt: '',
      reviews: [
        providerReviewNode(
          'PRR_viewer',
          corpusEntryBody('copilot-v2-previously-missed-3196'),
        ),
      ],
    }),
  });
  // The reported trust set is the configured one, not the viewer-augmented
  // activity set, so the viewer's ack must not satisfy reviewAckCovers.
  assert.deepEqual(snapshot.trustedMarkerActors, ['kurone-kito']);
  const evidence = snapshot.latestPrimaryBotReview as {
    reviewAckCovers: boolean | null;
  } | null;
  assert.equal(evidence?.reviewAckCovers, false);
});

function latestPrimaryBotGraphql(reviewBody: string): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
          reviews: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'PRR_cli',
                commit: { oid: SNAPSHOT_HEAD },
                submittedAt: '2026-10-09T01:00:00Z',
                author: { login: LATEST_COPILOT, __typename: 'Bot' },
                comments: { totalCount: 0, nodes: [] },
                body: reviewBody,
              },
            ],
          },
          commits: {
            nodes: [{ commit: { committedDate: '2026-10-09T00:00:00Z' } }],
          },
        },
      },
    },
  });
}

test('the CLI prints a non-null latestPrimaryBotReview at E1 (#3907)', () => {
  const report = runSnapshot(
    latestPrimaryBotGraphql(
      corpusEntryBody('copilot-v2-previously-missed-3196'),
    ),
  );
  assert.ok(
    report.latestPrimaryBotReview !== null &&
      typeof report.latestPrimaryBotReview === 'object',
  );
  assert.equal(report.latestPrimaryBotReview?.reviewAckNeeded, true);
  assert.equal(report.latestPrimaryBotReview?.matchesHead, true);
});

function corpusEntryBody(id: string): string {
  const entries = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'tests/fixtures/bot-comment-corpus/corpus.json'),
      'utf8',
    ),
  ) as { id: string; body: string }[];
  const entry = entries.find((candidate) => candidate.id === id);
  assert.ok(entry, `corpus entry ${id} must exist`);
  return entry.body;
}

function snapshotWithReviews(reviews: readonly object[]) {
  return collectReviewActivitySnapshot({
    prNumber: 3672,
    owner: 'o',
    repo: 'r',
    loadTrustedConfig: () => loadIddConfig(),
    trustedMarkerLoginsFlag: '',
    advisoryBotLoginsFlag: '',
    envTrustedMarkerActors: '',
    envAdvisoryBotLogins: '',
    port: {
      resolveViewerLoginSafe: () => ({
        viewerLogin: '',
        viewerLoginUnavailable: true,
      }),
      getChangeRequestHeadShaAndAuthor: () => ({
        headSha: 'c'.repeat(40),
        authorLogin: 'someone',
        baseRefName: 'main',
      }),
      getRepositoryDefaultBranch: () => 'main',
      listChangeRequestChecks: () => [],
      listReviews: () => [...reviews],
      listWorkItemComments: () => [],
      listChangeRequestReviewThreadsWithComments: () => [],
      getReviewThreadCommentUserContentEdits: () => [],
    },
  });
}

test('a remark-only snapshot keeps effective, counters and every other field unchanged', () => {
  const review = {
    node_id: 'PRR_remark',
    commit_id: 'c'.repeat(40),
    user: { login: COPILOT_LOGIN },
    state: 'COMMENTED',
    submitted_at: '2026-10-01T00:00:00Z',
  };
  const withRemark = snapshotWithReviews([
    { ...review, body: REMARK_ONLY_BODY },
  ]);
  const withoutRemark = snapshotWithReviews([
    { ...review, body: '**Findings:** None' },
  ]);
  assert.equal(
    (withRemark.reviewBodyRemarks as unknown[]).length,
    1,
    'the remark is surfaced',
  );
  assert.deepEqual(withoutRemark.reviewBodyRemarks, []);
  // The review still counts as one item either way, and nothing else moves.
  assert.deepEqual(withRemark.counts, { comments: 0, reviews: 1, threads: 0 });
  assert.deepEqual(withRemark.effective, withoutRemark.effective);
  // #3868: the overview-labels key is evidence only too, so it is dropped here
  // as well; the remaining fields must match exactly.
  const {
    reviewBodyRemarks: _withRemark,
    copilotOverviewLabels: _withRemarkLabels,
    ...restWithRemark
  } = withRemark;
  const {
    reviewBodyRemarks: _withoutRemark,
    copilotOverviewLabels: _withoutRemarkLabels,
    ...restWithoutRemark
  } = withoutRemark;
  assert.deepEqual(restWithRemark, restWithoutRemark);
});

// --- #3868: copilotOverviewLabels ------------------------------------------

interface CorpusEntry {
  id: string;
  body: string;
  expectedLabels: Record<string, { shape?: string }>;
}

const CORPUS: CorpusEntry[] = Object.values(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('./fixtures/bot-comment-corpus/corpus.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as Record<string, CorpusEntry>,
);

function corpusBody(id: string): string {
  const entry = CORPUS.find((candidate) => candidate.id === id);
  assert.ok(entry, `corpus entry ${id} exists`);
  return entry.body;
}

function corpusBodyWithShape(shape: string): string {
  const entry = CORPUS.find(
    (candidate) =>
      candidate.expectedLabels['copilot-review-body']?.shape === shape,
  );
  assert.ok(entry, `a corpus entry with shape ${shape} exists`);
  return entry.body;
}

function copilotReview(
  body: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node_id: 'PRR_labels',
    commit_id: 'a'.repeat(40),
    user: { login: COPILOT_LOGIN },
    state: 'COMMENTED',
    submitted_at: '2026-10-01T00:00:00Z',
    body,
    ...overrides,
  };
}

// Two Open items, one carrying `· New`, with the same badge markup the parser
// reads in real bodies (`alt="<Level> severity"` before the discussion link).
const TWO_OPEN_ITEMS_BODY = [
  '<!-- ccr-overview-v2 -->',
  '',
  '## Copilot review overview',
  '',
  '**Findings:** 2 <picture><img alt="High severity"></picture>',
  '',
  '<details>',
  '<summary><strong>Open (2)</strong></summary>',
  '',
  '- <picture><source srcset="h.svg"><img alt="High severity" src="h.svg"></picture> [Fix the parser](#discussion_r111) · New',
  '- <picture><img alt="Low severity" src="l.svg"></picture> [Tidy the docs](#discussion_r222)',
  '',
  '</details>',
  '',
].join('\n');

test('copilotOverviewLabels reads a v2 Open item: severity, discussion id, isNew, shape', () => {
  assert.deepEqual(
    buildCopilotOverviewLabels([
      copilotReview(corpusBody('copilot-v2-clean-3245')),
    ]),
    {
      reviewId: 'PRR_labels',
      commitId: 'a'.repeat(40),
      kind: 'v2',
      items: [{ discussionId: 4086537940, severity: 'medium', isNew: true }],
      previouslyMissed: { high: 0, medium: 0, low: 0 },
      reason: null,
    },
  );
});

test('copilotOverviewLabels yields every Open item of a multi-item body, with `· New` only where present', () => {
  assert.deepEqual(
    buildCopilotOverviewLabels([copilotReview(TWO_OPEN_ITEMS_BODY)]),
    {
      reviewId: 'PRR_labels',
      commitId: 'a'.repeat(40),
      kind: 'v2',
      items: [
        { discussionId: 111, severity: 'high', isNew: true },
        { discussionId: 222, severity: 'low', isNew: false },
      ],
      previouslyMissed: { high: 0, medium: 0, low: 0 },
      reason: null,
    },
  );
});

test('copilotOverviewLabels counts Previously missed per severity and gives no per-item severity', () => {
  const row = buildCopilotOverviewLabels([
    copilotReview(corpusBody('copilot-v2-previously-missed-3196')),
  ]);
  assert.equal(row?.kind, 'v2');
  assert.deepEqual(row?.items, []);
  assert.deepEqual(row?.previouslyMissed, { high: 0, medium: 1, low: 0 });
  assert.equal(row?.reason, null);
});

test('copilotOverviewLabels reports a legacy body as legacy with no items', () => {
  const row = buildCopilotOverviewLabels([
    copilotReview(corpusBodyWithShape('overview-legacy')),
  ]);
  assert.deepEqual(
    {
      kind: row?.kind,
      items: row?.items,
      previouslyMissed: row?.previouslyMissed,
    },
    { kind: 'legacy', items: [], previouslyMissed: null },
  );
});

test('copilotOverviewLabels does not read a v2 marker quoted in a code span as v2', () => {
  const row = buildCopilotOverviewLabels([
    copilotReview(
      'The marker is written as `<!-- ccr-overview-v2 -->` in this review.\n\n**Findings:** None\n',
    ),
  ]);
  assert.equal(row?.kind, 'other');
  assert.deepEqual(row?.items, []);
  assert.equal(row?.previouslyMissed, null);
});

test('copilotOverviewLabels: an Open item with no label is unparsed, keeps the partial list, invents no severity', () => {
  const body = [
    '<!-- ccr-overview-v2 -->',
    '',
    '<details>',
    '<summary><strong>Open (2)</strong></summary>',
    '',
    '- <picture><img alt="Medium severity" src="m.svg"></picture> [Labelled](#discussion_r301)',
    '- Plain item with no badge [Unlabelled](#discussion_r302)',
    '',
    '</details>',
    '',
  ].join('\n');
  assert.deepEqual(buildCopilotOverviewLabels([copilotReview(body)]), {
    reviewId: 'PRR_labels',
    commitId: 'a'.repeat(40),
    kind: 'unparsed',
    items: [{ discussionId: 301, severity: 'medium', isNew: false }],
    previouslyMissed: { high: 0, medium: 0, low: 0 },
    reason: 'Open header declared 2 but 1 were parsed',
  });
});

test('copilotOverviewLabels returns the last listed review, even when an earlier one was submitted later', () => {
  const row = buildCopilotOverviewLabels([
    copilotReview(corpusBody('copilot-v2-clean-3245'), {
      node_id: 'PRR_later_submitted',
      submitted_at: '2026-10-02T00:00:00Z',
    }),
    copilotReview(corpusBody('copilot-v2-previously-missed-3196'), {
      node_id: 'PRR_listed_last',
      submitted_at: '2026-10-01T00:00:00Z',
    }),
  ]);
  assert.equal(row?.reviewId, 'PRR_listed_last');
  assert.equal(row?.kind, 'v2');
});

test('copilotOverviewLabels skips an error-bodied last review and returns the earlier v2 review', () => {
  const row = buildCopilotOverviewLabels([
    copilotReview(corpusBody('copilot-v2-clean-3245'), {
      node_id: 'PRR_v2',
    }),
    copilotReview(corpusBodyWithShape('error'), {
      node_id: 'PRR_error_last',
    }),
  ]);
  assert.equal(row?.reviewId, 'PRR_v2');
  assert.equal(row?.kind, 'v2');
  assert.equal(row?.items.length, 1);
});

test('copilotOverviewLabels is null when no Copilot COMMENTED review exists', () => {
  assert.equal(
    buildCopilotOverviewLabels([
      copilotReview(corpusBody('copilot-v2-clean-3245'), {
        state: 'APPROVED',
      }),
      copilotReview(corpusBody('copilot-v2-clean-3245'), {
        user: { login: 'human-reviewer' },
      }),
    ]),
    null,
  );
  assert.equal(buildCopilotOverviewLabels([]), null);
});

test('copilotOverviewLabels is evidence only: the other fields match the same review with a body that carries no labels', () => {
  for (const id of [
    'copilot-v2-clean-3245',
    'copilot-v2-previously-missed-3196',
  ]) {
    const withLabels = snapshotWithReviews([
      copilotReview(corpusBody(id), { node_id: `PRR_${id}` }),
    ]);
    const withoutLabels = snapshotWithReviews([
      copilotReview('**Findings:** None', { node_id: `PRR_${id}` }),
    ]);
    assert.notEqual(
      withLabels.copilotOverviewLabels,
      null,
      `${id} yields a row`,
    );
    const {
      copilotOverviewLabels: _withLabels,
      reviewBodyRemarks: _withRemarks,
      ...restWithLabels
    } = withLabels;
    const {
      copilotOverviewLabels: _withoutLabels,
      reviewBodyRemarks: _withoutRemarks,
      ...restWithoutLabels
    } = withoutLabels;
    assert.deepEqual(restWithLabels, restWithoutLabels, id);
  }
});

// --- #3958: policy is read at the PR's base ref, never the working tree ----

function policyPort(options: {
  baseRefName?: string;
  defaultBranch?: string | null;
}) {
  return {
    resolveViewerLoginSafe: () => ({
      viewerLogin: '',
      viewerLoginUnavailable: true,
    }),
    getChangeRequestHeadShaAndAuthor: () => ({
      headSha: 'c'.repeat(40),
      authorLogin: 'someone',
      baseRefName: options.baseRefName ?? 'main',
    }),
    getRepositoryDefaultBranch: () =>
      options.defaultBranch === undefined ? 'trunk' : options.defaultBranch,
    listChangeRequestChecks: () => [],
    listReviews: () => [],
    listWorkItemComments: () => [],
    listChangeRequestReviewThreadsWithComments: () => [],
    getReviewThreadCommentUserContentEdits: () => [],
  } as unknown as Parameters<typeof collectReviewActivitySnapshot>[0]['port'];
}

function policyInput(
  port: Parameters<typeof collectReviewActivitySnapshot>[0]['port'],
  loadTrustedConfig: NonNullable<
    Parameters<typeof collectReviewActivitySnapshot>[0]['loadTrustedConfig']
  >,
  extra: { iddConfig?: unknown } = {},
) {
  return {
    prNumber: 3958,
    owner: 'o',
    repo: 'r',
    trustedMarkerLoginsFlag: '',
    advisoryBotLoginsFlag: '',
    envTrustedMarkerActors: '',
    envAdvisoryBotLogins: '',
    port,
    loadTrustedConfig,
    ...extra,
  } as Parameters<typeof collectReviewActivitySnapshot>[0];
}

test('the trusted loader is called with the PR base ref (#3958)', () => {
  const refs: string[] = [];
  collectReviewActivitySnapshot(
    policyInput(policyPort({ baseRefName: 'release/2' }), (_o, _r, ref) => {
      refs.push(ref);
      return null;
    }),
  );
  assert.deepEqual(refs, ['release/2']);
});

test('an empty base ref falls back to the live default branch (#3958)', () => {
  const refs: string[] = [];
  collectReviewActivitySnapshot(
    policyInput(
      policyPort({ baseRefName: '', defaultBranch: 'trunk' }),
      (_o, _r, ref) => {
        refs.push(ref);
        return null;
      },
    ),
  );
  assert.deepEqual(refs, ['trunk']);
});

test('an empty base ref and no default branch throws (#3958)', () => {
  assert.throws(
    () =>
      collectReviewActivitySnapshot(
        policyInput(
          policyPort({ baseRefName: '', defaultBranch: null }),
          () => null,
        ),
      ),
    /cannot resolve a trusted ref for \.github\/idd\/config\.json/,
  );
});

test('a loader error propagates and the working tree is not read (#3958)', () => {
  let calls = 0;
  assert.throws(
    () =>
      collectReviewActivitySnapshot(
        policyInput(policyPort({ baseRefName: 'main' }), () => {
          calls += 1;
          throw new Error('trusted read failed');
        }),
      ),
    /trusted read failed/,
  );
  assert.equal(calls, 1);
});

test('an injected iddConfig bypasses the trusted loader (#3958)', () => {
  let calls = 0;
  collectReviewActivitySnapshot(
    policyInput(
      policyPort({ baseRefName: 'main' }),
      () => {
        calls += 1;
        return null;
      },
      { iddConfig: {} },
    ),
  );
  assert.equal(calls, 0);
});

test('the trusted policy read opts out of the user-global fallback (#3958)', () => {
  const options: unknown[] = [];
  collectReviewActivitySnapshot(
    policyInput(
      policyPort({ baseRefName: 'main' }),
      (_o, _r, _ref, _f, _p, opts) => {
        options.push(opts);
        return null;
      },
    ),
  );
  assert.deepEqual(options, [{ userGlobalFallback: false }]);
});
