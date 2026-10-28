import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
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
  computeAdvisoryConvergenceVerdict,
  formatAssertNextActions,
} from '../src/scripts/advisory-convergence.mts';
import { extractPreviouslyMissedItemTitles } from '../src/scripts/copilot-review-body.mts';
import { tagGhCommandError } from '../src/scripts/gh-exec.mts';
import { classifyHelperError } from '../src/scripts/helper-cli-runner.mts';
import { renderOutOfLoopMarker } from '../src/scripts/marker-helpers.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';
import type {
  ProviderComment,
  ProviderPort,
} from '../src/scripts/provider-port.mts';
import {
  activeOwnedClaim,
  applyResolveReviewThread,
  assertNoGraphqlErrors,
  buildTriageReplyBody,
  evaluateClaimless,
  findBodyItem,
  findThreadForComment,
  hasBodyItemDispositionPrefix,
  hasKnownDispositionMarkerPrefix,
  parseArgs,
  type ResolveReviewThreadReport,
  type ReviewThreadNode,
  runBodyItemDisposition,
  type TriageFlags,
  TriageReadError,
  TriageRefusedError,
  TriageUsageError,
  validateTriageFlags,
} from '../src/scripts/resolve-review-thread.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';
import { buildReviewThreadNode, stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const resultSchema = loadJson('schemas/resolve-review-thread.schema.json');

test('parseArgs defaults a missing --body to an empty string for dry-run', () => {
  const args = parseArgs(['--pr', '42', '--comment-id', '1001']);
  assert.equal(args.body, '');
  assert.equal(args.body.trim(), '');
});

test('parseArgs reads the call shape and defaults to dry-run', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--comment-id',
    '1001',
    '--body',
    '**Accepted** — fixed in abc1234',
  ]);
  assert.equal(args.pr, 42);
  assert.equal(args.commentId, 1001);
  assert.equal(args.body, '**Accepted** — fixed in abc1234');
  assert.equal(args.apply, false);
});

test('parseArgs reads the apply-mode claim inputs', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--comment-id',
    '1001',
    '--body',
    'x',
    '--apply',
    '--claim-issue',
    '7',
    '--claim-id',
    'deadbeef',
    '--trusted-marker-logins',
    'kurone-kito, second-user',
  ]);
  assert.equal(args.apply, true);
  assert.equal(args.claimIssue, 7);
  assert.equal(args.claimId, 'deadbeef');
  assert.deepEqual(args.trustedMarkerLogins, ['kurone-kito', 'second-user']);
});

test('parseArgs reads --claimless, defaulting to false', () => {
  assert.equal(
    parseArgs(['--pr', '42', '--comment-id', '1001']).claimless,
    false,
  );
  assert.equal(
    parseArgs(['--pr', '42', '--comment-id', '1001', '--claimless']).claimless,
    true,
  );
});

/** The boolean verdict of the claimless gate, which these tests assert on. */
function isClaimlessEligible(
  port: ProviderPort,
  pr: number,
  options: {
    owner?: string;
    repo?: string;
    trustedMarkerLogins?: string[];
  } = {},
): boolean {
  return evaluateClaimless(port, pr, options).eligible;
}

test('isClaimlessEligible reflects live closingIssuesReferences on every call, not a cached snapshot (#2616, Codex P2)', () => {
  let refs: unknown[] = [];
  const port = {
    getChangeRequestConvergenceView: () => ({
      closingIssuesReferences: refs,
      headRefName: 'feature/no-issue',
    }),
  } as unknown as ProviderPort;
  assert.equal(isClaimlessEligible(port, 42), true);
  // A closing issue gets linked between two calls -- the second call must
  // see it, not reuse the first call's answer. This minimal stub does not
  // implement listWorkItemComments/resolveViewerLogin either, so the
  // #3328 non-empty-refs branch below fails closed (caught internally)
  // to the same `false` this test already expected before that branch
  // existed.
  refs = [{ number: 5 }];
  assert.equal(isClaimlessEligible(port, 42), false);
});

// --- kurone-kito/idd-skill#3328: out-of-loop-authorized adoption ---------

const OUT_OF_LOOP_VIEWER_LOGIN = 'claude-ad242b1f';

function outOfLoopEligibilityPort(
  overrides: {
    prComments?: ProviderComment[];
    closingIssueComments?: ProviderComment[];
  } = {},
): ProviderPort {
  return createFakeProviderAdapter({
    viewerLogin: OUT_OF_LOOP_VIEWER_LOGIN,
    changeRequestConvergenceViews: {
      42: {
        headSha: 'a'.repeat(40),
        headRefName: 'issue/5-linked',
        authorLogin: 'author-user',
        url: 'https://example.invalid/pr/42',
        closingIssuesReferences: [{ number: 5 }],
      },
    },
    comments: {
      42: overrides.prComments ?? [],
      5: overrides.closingIssueComments ?? [],
    },
  });
}

test('isClaimlessEligible accepts a PR with a closing reference, no active claim, and a valid trusted out-of-loop marker (#3328)', () => {
  const markerBody = renderOutOfLoopMarker({
    agentId: OUT_OF_LOOP_VIEWER_LOGIN,
    prNumber: 42,
    reason: 'bootstrap',
    at: '2026-07-01T00:00:00Z',
  });
  const port = outOfLoopEligibilityPort({
    prComments: [
      {
        id: 1,
        body: markerBody,
        createdAt: '2026-07-01T00:00:01Z',
        updatedAt: '2026-07-01T00:00:01Z',
        authorLogin: OUT_OF_LOOP_VIEWER_LOGIN,
        lastEditedAt: null,
      },
    ],
  });
  assert.equal(isClaimlessEligible(port, 42, { owner: 'o', repo: 'r' }), true);
});

test('isClaimlessEligible still refuses the same PR without a valid out-of-loop marker (#2017 regression)', () => {
  const port = outOfLoopEligibilityPort();
  assert.equal(isClaimlessEligible(port, 42, { owner: 'o', repo: 'r' }), false);
});

test('isClaimlessEligible refuses a closing reference whose issue has an active claim, even with a valid marker (#3328)', () => {
  const markerBody = renderOutOfLoopMarker({
    agentId: OUT_OF_LOOP_VIEWER_LOGIN,
    prNumber: 42,
    reason: 'bootstrap',
    at: '2026-07-01T00:00:00Z',
  });
  const port = outOfLoopEligibilityPort({
    prComments: [
      {
        id: 1,
        body: markerBody,
        createdAt: '2026-07-01T00:00:01Z',
        updatedAt: '2026-07-01T00:00:01Z',
        authorLogin: OUT_OF_LOOP_VIEWER_LOGIN,
        lastEditedAt: null,
      },
    ],
    closingIssueComments: [
      {
        id: 2,
        body: '<!-- claimed-by: other-agent clm-1 supersedes: none 2026-07-01T00:00:00Z branch: issue/5-x -->\n\n_other-agent: issue claim — IDD automation marker. Do not edit._',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-01T00:00:00Z',
        authorLogin: OUT_OF_LOOP_VIEWER_LOGIN,
      },
    ],
  });
  assert.equal(isClaimlessEligible(port, 42, { owner: 'o', repo: 'r' }), false);
});

// --- kurone-kito/idd-skill#4735: an empty closing set does not bypass an issue claim ---

const BRANCH_CLAIM_ID = 'f2275963-a829-42cf-9593-5e002d7378a6';

function branchClaimComment(issue: number, id: number): ProviderComment {
  return {
    id,
    body: `<!-- claimed-by: claude-code-fb560b17 ${BRANCH_CLAIM_ID} supersedes: none 2026-07-01T00:00:00Z branch: issue/${issue}-fix-review-thread -->\n\n_claude-code-fb560b17: issue claim — IDD automation marker. Do not edit._`,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    authorLogin: OUT_OF_LOOP_VIEWER_LOGIN,
    lastEditedAt: null,
  };
}

/** A PR with an empty closing set whose head branch is `headRefName`. */
function emptyClosingPort(
  headRefName: string,
  overrides: {
    prComments?: ProviderComment[];
    issueComments?: ProviderComment[];
  } = {},
): ProviderPort {
  return createFakeProviderAdapter({
    viewerLogin: OUT_OF_LOOP_VIEWER_LOGIN,
    changeRequestConvergenceViews: {
      42: {
        headSha: 'a'.repeat(40),
        headRefName,
        authorLogin: 'author-user',
        url: 'https://example.invalid/pr/42',
        closingIssuesReferences: [],
      },
    },
    comments: {
      42: overrides.prComments ?? [],
      4735: overrides.issueComments ?? [],
    },
  });
}

test('isClaimlessEligible keeps the genuine no-issue route for an empty closing set and reads no viewer identity (#4735, #2616)', () => {
  const base = emptyClosingPort('feature/unrelated-branch');
  const port = new Proxy(base, {
    get: (target, prop, receiver) =>
      prop === 'resolveViewerLogin'
        ? () => {
            throw new Error('viewer identity must not be read here');
          }
        : Reflect.get(target, prop, receiver),
  });
  assert.equal(isClaimlessEligible(port, 42, { owner: 'o', repo: 'r' }), true);
});

test('evaluateClaimless refuses an empty closing set when the issue branch has an active claim, and names the claim-bound route (#4735)', () => {
  const port = emptyClosingPort('issue/4735-fix-review-thread-verify-claims', {
    issueComments: [branchClaimComment(4735, 2)],
  });
  const verdict = evaluateClaimless(port, 42, { owner: 'o', repo: 'r' });
  assert.equal(verdict.eligible, false);
  assert.match(verdict.refusal ?? '', /^--claimless refused: /);
  assert.match(
    verdict.refusal ?? '',
    /names issue #4735, which has an active claim/,
  );
  assert.match(
    verdict.refusal ?? '',
    /--claim-issue 4735 --claim-id <claim-id>/,
  );
  assert.equal(isClaimlessEligible(port, 42, { owner: 'o', repo: 'r' }), false);
});

test('evaluateClaimless refuses an empty closing set on an unclaimed issue branch without a valid out-of-loop marker (#4735)', () => {
  const port = emptyClosingPort('issue/4735-fix-review-thread-verify-claims');
  const verdict = evaluateClaimless(port, 42, { owner: 'o', repo: 'r' });
  assert.equal(verdict.eligible, false);
  assert.match(
    verdict.refusal ?? '',
    /no active claim and no valid out-of-loop marker/,
  );
});

test('evaluateClaimless accepts an unclaimed issue branch with a valid trusted bootstrap marker (#4735, #3328 exception)', () => {
  const markerBody = renderOutOfLoopMarker({
    agentId: OUT_OF_LOOP_VIEWER_LOGIN,
    prNumber: 42,
    reason: 'bootstrap',
    at: '2026-07-01T00:00:00Z',
  });
  const port = emptyClosingPort('issue/4735-fix-review-thread-verify-claims', {
    prComments: [
      {
        id: 1,
        body: markerBody,
        createdAt: '2026-07-01T00:00:01Z',
        updatedAt: '2026-07-01T00:00:01Z',
        authorLogin: OUT_OF_LOOP_VIEWER_LOGIN,
        lastEditedAt: null,
      },
    ],
  });
  assert.deepEqual(evaluateClaimless(port, 42, { owner: 'o', repo: 'r' }), {
    eligible: true,
  });
});

for (const headRefName of [
  '',
  'issue/4735',
  'issue/abc-x',
  'issue/0-x',
  'issue/9007199254740993-task',
  'issue/4735-fix..review',
  'issue/4735-x.lock',
  'issue/4735-x/',
  'issue/4735-fix review',
  '[object Object]',
]) {
  test(`evaluateClaimless fails closed on an empty closing set with an unreadable or malformed head name ${JSON.stringify(headRefName)} (#4735)`, () => {
    const port = emptyClosingPort(headRefName);
    const verdict = evaluateClaimless(port, 42, { owner: 'o', repo: 'r' });
    assert.equal(verdict.eligible, false);
    assert.match(verdict.refusal ?? '', /^--claimless refused: PR #42/);
    assert.match(verdict.refusal ?? '', /--claim-issue <n> --claim-id/);
  });
}

test('evaluateClaimless refuses a non-string head name instead of reading it as a no-issue branch (#4735)', () => {
  // A numeric head name from malformed provider data must not become the
  // valid-looking branch "123" on the no-issue route.
  const port = emptyClosingPort('placeholder');
  const malformed = new Proxy(port, {
    get: (target, prop, receiver) =>
      prop === 'getChangeRequestConvergenceView'
        ? () => ({
            headSha: 'a'.repeat(40),
            headRefName: 123,
            authorLogin: 'author-user',
            url: 'https://example.invalid/pr/42',
            closingIssuesReferences: [],
          })
        : Reflect.get(target, prop, receiver),
  });
  const verdict = evaluateClaimless(malformed, 42, { owner: 'o', repo: 'r' });
  assert.equal(verdict.eligible, false);
  assert.match(verdict.refusal ?? '', /^--claimless refused: PR #42/);
});

test('isClaimlessEligible fails closed when the branch issue claim evidence cannot be read (#4735)', () => {
  const base = emptyClosingPort('issue/4735-fix-review-thread-verify-claims');
  const port = new Proxy(base, {
    get: (target, prop, receiver) =>
      prop === 'listWorkItemComments'
        ? () => {
            throw new Error('comment list unavailable');
          }
        : Reflect.get(target, prop, receiver),
  });
  assert.equal(isClaimlessEligible(port, 42, { owner: 'o', repo: 'r' }), false);
});

test('isClaimlessEligible refuses a PR whose only closing reference is cross-repo, even with a valid marker (C1 critique regression guard)', () => {
  // A same-repo-only extraction fed straight to the classifier would
  // otherwise silently read this as "no closing references" (the #2017
  // claimless case), returning eligible with no marker required -- the
  // pre-#3328 code always refused ANY non-empty raw
  // closingIssuesReferences regardless of repo.
  const markerBody = renderOutOfLoopMarker({
    agentId: OUT_OF_LOOP_VIEWER_LOGIN,
    prNumber: 42,
    reason: 'bootstrap',
    at: '2026-07-01T00:00:00Z',
  });
  const port = createFakeProviderAdapter({
    viewerLogin: OUT_OF_LOOP_VIEWER_LOGIN,
    changeRequestConvergenceViews: {
      42: {
        headSha: 'a'.repeat(40),
        headRefName: 'issue/5-linked',
        authorLogin: 'author-user',
        url: 'https://example.invalid/pr/42',
        closingIssuesReferences: [
          {
            number: 5,
            repository: { name: 'other-repo', owner: { login: 'other-owner' } },
          },
        ],
      },
    },
    comments: {
      42: [
        {
          id: 1,
          body: markerBody,
          createdAt: '2026-07-01T00:00:01Z',
          updatedAt: '2026-07-01T00:00:01Z',
          authorLogin: OUT_OF_LOOP_VIEWER_LOGIN,
          lastEditedAt: null,
        },
      ],
    },
  });
  assert.equal(isClaimlessEligible(port, 42, { owner: 'o', repo: 'r' }), false);
});

test('isClaimlessEligible refuses a PR whose closingIssuesReferences field is unreadable (non-array), even with a valid marker (Copilot review, PR #3421)', () => {
  const markerBody = renderOutOfLoopMarker({
    agentId: OUT_OF_LOOP_VIEWER_LOGIN,
    prNumber: 42,
    reason: 'bootstrap',
    at: '2026-07-01T00:00:00Z',
  });
  const port = createFakeProviderAdapter({
    viewerLogin: OUT_OF_LOOP_VIEWER_LOGIN,
    changeRequestConvergenceViews: {
      42: {
        headSha: 'a'.repeat(40),
        headRefName: 'issue/5-linked',
        authorLogin: 'author-user',
        url: 'https://example.invalid/pr/42',
        closingIssuesReferences: null as unknown as unknown[],
      },
    },
    comments: {
      42: [
        {
          id: 1,
          body: markerBody,
          createdAt: '2026-07-01T00:00:01Z',
          updatedAt: '2026-07-01T00:00:01Z',
          authorLogin: OUT_OF_LOOP_VIEWER_LOGIN,
          lastEditedAt: null,
        },
      ],
    },
  });
  assert.equal(isClaimlessEligible(port, 42, { owner: 'o', repo: 'r' }), false);
});

test('isClaimlessEligible refuses a PR with a mix of same-repo and cross-repo closing references, even with a valid marker (Copilot review, PR #3421)', () => {
  const markerBody = renderOutOfLoopMarker({
    agentId: OUT_OF_LOOP_VIEWER_LOGIN,
    prNumber: 42,
    reason: 'bootstrap',
    at: '2026-07-01T00:00:00Z',
  });
  const port = createFakeProviderAdapter({
    viewerLogin: OUT_OF_LOOP_VIEWER_LOGIN,
    changeRequestConvergenceViews: {
      42: {
        headSha: 'a'.repeat(40),
        headRefName: 'issue/5-linked',
        authorLogin: 'author-user',
        url: 'https://example.invalid/pr/42',
        closingIssuesReferences: [
          { number: 7 },
          {
            number: 5,
            repository: { name: 'other-repo', owner: { login: 'other-owner' } },
          },
        ],
      },
    },
    comments: {
      42: [
        {
          id: 1,
          body: markerBody,
          createdAt: '2026-07-01T00:00:01Z',
          updatedAt: '2026-07-01T00:00:01Z',
          authorLogin: OUT_OF_LOOP_VIEWER_LOGIN,
          lastEditedAt: null,
        },
      ],
      7: [],
    },
  });
  assert.equal(isClaimlessEligible(port, 42, { owner: 'o', repo: 'r' }), false);
});

// #3270: WG_OLD_CLAIM is created at 2026-05-12T09:00:00Z; the takeover
// below lands 20h later (2026-05-13T05:00:00Z) -- squarely in the 18-24h
// gap the issue describes: stale under an 18h configured age, not stale
// under the old hardcoded 24h `resolveActiveClaimForWriteGate` silently
// fell back to when a write-gate caller (like this file's `activeOwnedClaim`)
// omitted `staleAgeMs`.
function activeOwnedClaimEvents(): { body: string; createdAt: string }[] {
  return [
    {
      body: [
        '<!-- claimed-by: cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat -->',
        '',
        '_cli-old: issue claim — IDD automation marker._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
    },
    {
      body: [
        '<!-- claimed-by: cli-new claim-20260513T050000Z-337-new supersedes: claim-20260512T090000Z-337-old 2026-05-13T05:00:00Z branch: issue/337-feat -->',
        '',
        '_cli-new: issue claim — IDD automation marker._',
      ].join('\n'),
      createdAt: '2026-05-13T05:00:00Z',
    },
  ];
}

function fakePortWithComments(
  events: { body: string; createdAt: string }[],
): ProviderPort {
  return {
    listWorkItemComments: () =>
      events.map((event) => ({
        body: event.body,
        createdAt: event.createdAt,
        authorLogin: event.body.includes('cli-new') ? 'cli-new' : 'cli-old',
        lastEditedAt: null,
      })),
  } as unknown as ProviderPort;
}

test('activeOwnedClaim (#3270) recognizes a takeover claim inside a configured 18h staleAge', () => {
  const port = fakePortWithComments(activeOwnedClaimEvents());
  const active = activeOwnedClaim(
    port,
    337,
    'cli-new',
    'claim-20260513T050000Z-337-new',
    (login) => ['cli-old', 'cli-new'].includes(login),
    { forcedHandoffEnabled: false, isAuthorizedForcedHandoff: () => false },
    18 * 60 * 60 * 1000,
  );
  assert.equal(active?.claimId, 'claim-20260513T050000Z-337-new');
  assert.equal(active?.agentId, 'cli-new');
});

test('activeOwnedClaim (#3270) keeps the old claim active for the same 20h gap when staleAgeMs is explicitly the 24h default', () => {
  const port = fakePortWithComments(activeOwnedClaimEvents());
  const active = activeOwnedClaim(
    port,
    337,
    'cli-new',
    'claim-20260513T050000Z-337-new',
    (login) => ['cli-old', 'cli-new'].includes(login),
    { forcedHandoffEnabled: false, isAuthorizedForcedHandoff: () => false },
    24 * 60 * 60 * 1000,
  );
  // The takeover does not activate under the 24h default (20h < 24h), so the
  // caller's expected claim-id ("claim-20260513T050000Z-337-new") no longer
  // matches the still-active old claim -- activeOwnedClaim returns null.
  assert.equal(active, null);
});

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: a present-but-invalid --pr resolves to NaN, matching the pre-#1450 contract', () => {
  // This file's original hand-rolled parser assigned the raw (possibly
  // NaN) Number.parseInt result directly -- it never coerced an invalid
  // value to null inside parseArgs itself. The caller's own
  // `!Number.isInteger(args.pr) || (args.pr ?? 0) <= 0` guard (outside
  // parseArgs) treats NaN as invalid the same way it treats null.
  const args = parseArgs(['--pr', 'not-a-number']);
  assert.ok(Number.isNaN(args.pr));
});

test('parseArgs: an absent --pr resolves to null', () => {
  const args = parseArgs(['--comment-id', '1001']);
  assert.equal(args.pr, null);
});

test('parseArgs: --pr/--comment-id/--claim-issue keep their pre-#1450 permissive Number.parseInt contract', () => {
  // Regression coverage for a CodeRabbit review finding on #1450: the
  // wrapper migration must not swap in cli-args.mts's stricter
  // canonical-pattern integer parser here, which would reject trailing-
  // garbage and leading-zero tokens the original Number.parseInt-based
  // parser always accepted.
  const args = parseArgs([
    '--pr',
    '42abc',
    '--comment-id',
    '007',
    '--body',
    'x',
    '--claim-issue',
    '9xyz',
  ]);
  assert.equal(args.pr, 42);
  assert.equal(args.commentId, 7);
  assert.equal(args.claimIssue, 9);
});

test('parseArgs: a missing --comment-id value throws', () => {
  assert.throws(() => parseArgs(['--pr', '42', '--comment-id']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --claim-id would greedily accept '--apply' as its literal
  // value, silently leaving --apply unset (this file's own flavor of the
  // #1082 gap the shared wrapper closes structurally).
  assert.throws(() =>
    parseArgs(['--pr', '42', '--comment-id', '1', '--claim-id', '--apply']),
  );
});

test('parseArgs: rejects an unknown flag instead of silently ignoring it', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: --help is recognized without requiring --pr', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

test('findThreadForComment maps a REST comment id to its owning thread and root comment', () => {
  const threads = [
    buildReviewThreadNode('thread-a', false, [900, 901]),
    buildReviewThreadNode('thread-b', true, [1001, 1002]),
  ];
  const match = findThreadForComment(threads, 1002);
  assert.deepEqual(match, {
    threadId: 'thread-b',
    isResolved: true,
    rootCommentId: 1001,
  });
});

test('findThreadForComment returns the top-level comment id when a later reply matches', () => {
  // The reply must target the thread's first (top-level) comment, since GitHub
  // does not support replies to replies; matching a later reply still resolves
  // to the root comment id.
  const threads = [buildReviewThreadNode('thread-x', false, [500, 777])];
  assert.deepEqual(findThreadForComment(threads, 777), {
    threadId: 'thread-x',
    isResolved: false,
    rootCommentId: 500,
  });
});

test('findThreadForComment returns null when no thread owns the comment', () => {
  const threads = [buildReviewThreadNode('thread-a', false, [900])];
  assert.equal(findThreadForComment(threads, 999), null);
});

test('findThreadForComment ignores missing databaseId nodes safely', () => {
  const threads: ReviewThreadNode[] = [
    {
      id: 'thread-a',
      isResolved: false,
      comments: { nodes: [{ databaseId: null }] },
    },
    { id: 'thread-b', isResolved: false, comments: { nodes: null } },
    buildReviewThreadNode('thread-c', false, [1001]),
  ];
  assert.deepEqual(findThreadForComment(threads, 1001), {
    threadId: 'thread-c',
    isResolved: false,
    rootCommentId: 1001,
  });
});

test('assertNoGraphqlErrors throws on a response carrying errors', () => {
  assert.throws(
    () =>
      assertNoGraphqlErrors(
        { errors: [{ message: 'Could not resolve to a Repository' }] },
        'review thread lookup',
      ),
    /review thread lookup failed: Could not resolve to a Repository/,
  );
});

test('assertNoGraphqlErrors passes a clean response so a real not-found is not masked', () => {
  assert.doesNotThrow(() =>
    assertNoGraphqlErrors(
      {
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      },
      'review thread lookup',
    ),
  );
});

test('applyResolveReviewThread revalidates the claim before each mutation (reply then resolve)', () => {
  const calls: string[] = [];
  const result = applyResolveReviewThread({
    assertClaim: () => {
      calls.push('claim');
    },
    postReply: () => {
      calls.push('reply');
      return { id: 555 };
    },
    resolveThread: () => {
      calls.push('resolve');
    },
  });
  assert.deepEqual(calls, ['claim', 'reply', 'claim', 'resolve']);
  assert.equal(result.replyId, 555);
});

test('applyResolveReviewThread still posts the reply and resolves the thread when assertClaim is a --claimless no-op (#2616)', () => {
  // --claimless's own `assertClaim` wiring is exactly this: a no-op that
  // never fetches or validates a claim. This documents that the shared
  // orchestration function still runs the full reply-then-resolve
  // sequence around it.
  const calls: string[] = [];
  const result = applyResolveReviewThread({
    assertClaim: () => {},
    postReply: () => {
      calls.push('reply');
      return { id: 777 };
    },
    resolveThread: () => {
      calls.push('resolve');
    },
  });
  assert.deepEqual(calls, ['reply', 'resolve']);
  assert.equal(result.replyId, 777);
});

test('applyResolveReviewThread does not resolve when the second claim check fails after the reply', () => {
  const calls: string[] = [];
  let claimChecks = 0;
  assert.throws(
    () =>
      applyResolveReviewThread({
        assertClaim: () => {
          claimChecks += 1;
          calls.push('claim');
          if (claimChecks === 2) {
            throw new Error('claim handed off mid-flight');
          }
        },
        postReply: () => {
          calls.push('reply');
          return { id: 1 };
        },
        resolveThread: () => {
          calls.push('resolve');
        },
      }),
    /claim handed off mid-flight/,
  );
  assert.deepEqual(calls, ['claim', 'reply', 'claim']);
});

test('applyResolveReviewThread aborts before any mutation when the claim check throws', () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      applyResolveReviewThread({
        assertClaim: () => {
          throw new Error('claim lost');
        },
        postReply: () => {
          calls.push('reply');
          return { id: 1 };
        },
        resolveThread: () => {
          calls.push('resolve');
        },
      }),
    /claim lost/,
  );
  assert.deepEqual(calls, []);
});

test('applyResolveReviewThread posts the reply before a resolve failure surfaces (id observable for the partial-failure report)', () => {
  const calls: string[] = [];
  let observedReplyId: number | undefined;
  assert.throws(
    () =>
      applyResolveReviewThread({
        assertClaim: () => {
          calls.push('claim');
        },
        postReply: () => {
          calls.push('reply');
          observedReplyId = 999;
          return { id: 999 };
        },
        resolveThread: () => {
          calls.push('resolve');
          throw new Error('resolve failed');
        },
      }),
    /resolve failed/,
  );
  assert.deepEqual(calls, ['claim', 'reply', 'claim', 'resolve']);
  // The reply id is observable before the resolve throws, so the CLI can retain
  // it in the failed report instead of looking like nothing was posted.
  assert.equal(observedReplyId, 999);
});

test('applyResolveReviewThread does not resolve the thread when the reply fails', () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      applyResolveReviewThread({
        assertClaim: () => {
          calls.push('claim');
        },
        postReply: () => {
          throw new Error('reply failed');
        },
        resolveThread: () => {
          calls.push('resolve');
        },
      }),
    /reply failed/,
  );
  assert.deepEqual(calls, ['claim']);
});

// --- #2005: validate the disposition marker prefix before posting ----------

test('hasKnownDispositionMarkerPrefix accepts each of the three forms hasFreshDisposition recognizes', () => {
  assert.equal(
    hasKnownDispositionMarkerPrefix('**Accepted** — fixed in abc1234: ...'),
    true,
  );
  assert.equal(
    hasKnownDispositionMarkerPrefix(
      '**Rejected** — verified placeholders-only',
    ),
    true,
  );
  assert.equal(
    hasKnownDispositionMarkerPrefix(
      '**Rejection confirmed by maintainer** — agreed, no action needed',
    ),
    true,
  );
});

test('hasKnownDispositionMarkerPrefix rejects a non-conforming body before any network call', () => {
  // This predicate has no network dependency at all -- the CLI calls it
  // before resolving owner/repo or looking up the review thread, so a body
  // like this is rejected before any gh/GraphQL call is made.
  assert.equal(
    hasKnownDispositionMarkerPrefix('**Fixed** — cleaned up the stray import'),
    false,
  );
});

// The predicate test above proves `hasKnownDispositionMarkerPrefix` itself
// rejects a non-conforming body, but not that the compiled CLI actually
// calls it before any `gh` invocation -- a regression that moved or dropped
// the `--apply` guard in `main()` would still leave that pure-function test
// green. Run the real compiled entry point (docs/typescript-sources.md's
// "never hand-edit scripts/*.mjs" source of truth) with `gh` scrubbed from
// `PATH` (the tests/post-idd-marker.test.mts `runCliExpectingFailure`
// pattern): if the guard fired, the process exits 1 with the documented
// stderr message before ever shelling out; if it didn't, `gh` would be
// invoked and fail with an unrelated ENOENT-style spawn error instead.
test('--apply rejects a non-conforming --body before any gh call (compiled CLI)', () => {
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'),
        '--pr',
        '42',
        '--comment-id',
        '1001',
        '--claim-issue',
        '2005',
        '--claim-id',
        'test-claim-id',
        '--apply',
        '--body',
        '**Fixed** — cleaned up the stray import',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(
      failure.stderr ?? '',
      /--apply requires --body to start with one of the accepted disposition markers/,
    );
    return;
  }
  throw new Error('expected the CLI to exit non-zero');
});

test('--claimless rejects --claim-issue before any gh call (compiled CLI, #2616)', () => {
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'),
        '--pr',
        '42',
        '--comment-id',
        '1001',
        '--claimless',
        '--claim-issue',
        '2005',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(
      failure.stderr ?? '',
      /--claimless cannot be combined with --claim-issue or --claim-id/,
    );
    return;
  }
  throw new Error('expected the CLI to exit non-zero');
});

test('--claimless rejects --claim-id before any gh call (compiled CLI, #2616)', () => {
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'),
        '--pr',
        '42',
        '--comment-id',
        '1001',
        '--claimless',
        '--claim-id',
        'deadbeef',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(
      failure.stderr ?? '',
      /--claimless cannot be combined with --claim-issue or --claim-id/,
    );
    return;
  }
  throw new Error('expected the CLI to exit non-zero');
});

test('--claimless rejects a malformed --claim-issue value too (compiled CLI, #2616, Codex P2)', () => {
  // `--claim-issue nope` parses to NaN, not the parseArgs default of null
  // for an omitted flag -- the mutual-exclusion check must key off "was
  // the flag supplied" (claimIssue !== null), not "did it parse to a
  // valid positive integer", or this combination silently falls through
  // to the claimless path instead of being rejected.
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'),
        '--pr',
        '42',
        '--comment-id',
        '1001',
        '--claimless',
        '--claim-issue',
        'nope',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(
      failure.stderr ?? '',
      /--claimless cannot be combined with --claim-issue or --claim-id/,
    );
    return;
  }
  throw new Error('expected the CLI to exit non-zero');
});

test('--apply --claimless does not require --claim-issue / --claim-id (compiled CLI, #2616)', () => {
  // Empty PATH keeps the intentional missing-CLI fixture from resolving any
  // executable. The test-only guard records and blocks the probe before
  // dispatch, then fails the child process from its isolated ledger.
  //
  // The helper runs from a scratch working directory, not the repository
  // root: it reads this repository's config through its working directory,
  // which enables load control, so with a token variable exported it would
  // write a slot file under the per-user state directory before `gh` fails
  // to spawn (#3725).
  const scratch = mkdtempSync(join(tmpdir(), 'idd-claimless-cli-'));
  const ledgerPath = join(scratch, 'gh-attempts.jsonl');
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'),
        '--pr',
        '42',
        '--comment-id',
        '1001',
        '--claimless',
        '--apply',
        '--body',
        '**Accepted** — operator-authorized, no linked issue',
      ],
      {
        cwd: scratch,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: '',
          HOME: scratch,
          XDG_CONFIG_HOME: scratch,
          IDD_TEST_GH_GUARD_LEDGER: ledgerPath,
          IDD_TEST_GH_GUARD_SELF_CHECK: '1',
        },
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    throw new Error('expected the CLI to exit non-zero');
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.doesNotMatch(failure.stderr ?? '', /requires the --claim-issue/);
    const [attempt] = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(attempt?.api, 'execFileSync');
    assert.equal(attempt?.executable, 'gh');
    assert.deepEqual(attempt?.args, ['repo', 'view', '--json', '[redacted]']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('--claimless refuses a PR with closingIssuesReferences and no out-of-loop marker (compiled CLI, #2616, #3328)', () => {
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  fs.writeSync(1, JSON.stringify({
    headRefOid: 'deadbeef',
    headRefName: 'issue/5-linked',
    author: { login: 'someone' },
    url: 'https://example.invalid/pr/42',
    closingIssuesReferences: [{ number: 5 }],
  }));
  process.exit(0);
}
// kurone-kito/idd-skill#4721: the closing-reference read is GraphQL.
if (args[0] === 'api' && args[1] === 'graphql' && args.join(' ').includes('closingIssuesReferences')) {
  fs.writeSync(1, JSON.stringify({ data: { repository: { pullRequest: { headRefOid: 'deadbeef', closingIssuesReferences: { nodes: [{ number: 5, repository: { name: 'r', owner: { login: 'o' } } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
  process.exit(0);
}
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'),
        '--pr',
        '42',
        '--comment-id',
        '1001',
        '--owner',
        'o',
        '--repo',
        'r',
        '--claimless',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    throw new Error('expected the CLI to exit non-zero');
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    // #3328: a non-empty closingIssuesReferences with no out-of-loop
    // marker evidence still fails closed -- the stub `gh` above answers
    // only `pr view` and the closing-reference GraphQL read, so isClaimlessEligible's own attempts to read
    // closing issue #5's comments and this PR's comments both fail
    // (caught internally), landing on the same refusal as before.
    assert.match(
      failure.stderr ?? '',
      /--claimless requires a PR with no closingIssuesReferences, or a valid out-of-loop marker; pass --claim-issue instead/,
    );
  } finally {
    restore();
  }
});

test('--apply --claimless posts the reply and resolves the thread without ever resolving a viewer identity or claimed branch (compiled CLI, #2616, Codex P2)', () => {
  // End-to-end success path over a stubbed `gh`. The stub answers every
  // call a --claimless --apply run legitimately needs (the
  // closingIssuesReferences scoping check -- called once up front and
  // again before each mutation, per #2616's Codex P2 recheck fix -- the
  // thread lookup, the reply POST, and the resolve mutation) and fails
  // loudly for `gh api user` / `gh api .../pulls/<n> --jq .head.ref`,
  // which only the non-claimless claim-binding path needs.
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
const joined = args.join(' ');
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
const fail = (msg) => { fs.writeSync(2, msg); process.exit(1); };
if (args[0] === 'pr' && args[1] === 'view') {
  out(JSON.stringify({
    headRefOid: 'deadbeef',
    headRefName: 'main',
    author: { login: 'someone' },
    url: 'https://example.invalid/pr/42',
    closingIssuesReferences: [],
  }));
}
if (args[0] === 'api' && args[1] === 'graphql' && joined.includes('closingIssuesReferences')) {
  out(JSON.stringify({ data: { repository: { pullRequest: { headRefOid: 'deadbeef', closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
}
if (args[0] === 'api' && args[1] === 'graphql') {
  if (joined.includes('reviewThreads')) {
    out(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [{ id: 'THREAD1', isResolved: false, path: 'x',
        comments: { nodes: [{ databaseId: 1001 }], pageInfo: { hasNextPage: false, endCursor: null } } }],
      pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
  }
  if (joined.includes('resolveReviewThread')) {
    out(JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }));
  }
  fail('unexpected graphql call: ' + joined);
}
if (args[0] === 'api' && args.includes('--method') && args.includes('POST') && joined.includes('replies')) {
  out(JSON.stringify({ id: 4242 }));
}
if (args[0] === 'api' && args[1] === 'user') {
  fail('FORBIDDEN: resolveViewerLogin was called in --claimless mode');
}
if (args[0] === 'api' && joined.includes('.head.ref')) {
  fail('FORBIDDEN: getChangeRequestHeadRef was called in --claimless mode');
}
fail('unexpected gh invocation: ' + joined);
`,
  );
  // Run from a scratch cwd whose fixture config has no critiqueLoop, so a
  // later repository opt-in (for example a triageRecord mode) cannot change
  // this operator-authorized reply. HOME and XDG_CONFIG_HOME point at the
  // same scratch directory so no user-global policy layer applies either.
  let scratch = '';
  let decoy = '';
  const savedXdg = process.env.XDG_CONFIG_HOME;
  try {
    // A user-global triage mode in the parent environment. The child's own
    // HOME and XDG_CONFIG_HOME must hide it, so removing those overrides
    // would make the child read it and fail this test.
    decoy = mkdtempSync(join(tmpdir(), 'idd-operator-decoy-'));
    mkdirSync(join(decoy, 'idd-skill'), { recursive: true });
    writeFileSync(
      join(decoy, 'idd-skill', 'config.json'),
      `${JSON.stringify({ critiqueLoop: { triageRecord: 'record' } })}\n`,
    );
    process.env.XDG_CONFIG_HOME = decoy;
    scratch = mkdtempSync(join(tmpdir(), 'idd-operator-apply-'));
    mkdirSync(join(scratch, '.github', 'idd'), { recursive: true });
    writeFileSync(join(scratch, '.github', 'idd', 'config.json'), '{}\n');
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'),
        '--pr',
        '42',
        '--comment-id',
        '1001',
        '--owner',
        'o',
        '--repo',
        'r',
        '--claimless',
        '--apply',
        '--body',
        '**Accepted** — operator-authorized, no linked issue',
      ],
      {
        cwd: scratch,
        encoding: 'utf8',
        env: {
          ...process.env,
          // Inherited on a GitHub runner, where it would skip the user-global
          // layer the decoy relies on.
          GITHUB_ACTIONS: '',
          HOME: scratch,
          XDG_CONFIG_HOME: scratch,
        },
      },
    );
    const report = JSON.parse(output) as ResolveReviewThreadReport;
    assert.equal(report.status, 'applied');
    assert.equal(report.replyId, 4242);
    assert.equal(report.threadId, 'THREAD1');
  } finally {
    try {
      restore();
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = savedXdg;
      }
      if (decoy) {
        rmSync(decoy, { recursive: true, force: true });
      }
      if (scratch) {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
});

test('hasKnownDispositionMarkerPrefix accepts "Rejection confirmed by maintainer" regardless of thread resolution state', () => {
  // Regression coverage for a Codex review finding on this PR: an earlier
  // revision of this check required the target thread to already be
  // resolved before accepting this marker. That broke the documented AMD
  // "maintainer agrees" transition (idd-review-triage.instructions.md),
  // which posts exactly this marker on a thread that is still
  // *unresolved* at call time -- resolve-review-thread.mjs's own --apply
  // path is what resolves it, in the same call. This predicate has no
  // thread-state input at all, so it can never re-introduce that bug.
  const body =
    '**Rejection confirmed by maintainer** — agreed, no action needed';
  assert.equal(hasKnownDispositionMarkerPrefix(body), true);
});

test('the dry-run and apply output envelopes validate against the schema', () => {
  const dryRun: ResolveReviewThreadReport = {
    mode: 'dry-run',
    prNumber: 7,
    commentId: 1001,
    threadId: 'thread-b',
    alreadyResolved: false,
  };
  assert.equal(validate(dryRun, resultSchema).length, 0, 'dry-run output');

  const notFound: ResolveReviewThreadReport = {
    mode: 'dry-run',
    prNumber: 7,
    commentId: 999,
    alreadyResolved: false,
    error: 'no review thread found for comment 999 on PR #7',
  };
  assert.equal(validate(notFound, resultSchema).length, 0, 'not-found output');

  const apply: ResolveReviewThreadReport = {
    mode: 'apply',
    prNumber: 7,
    commentId: 1001,
    threadId: 'thread-b',
    alreadyResolved: false,
    status: 'applied',
    replyId: 4242,
    body: '**Accepted** — fixed in abc\n\n<!-- idd-skill-review-reply -->',
  };
  assert.equal(validate(apply, resultSchema).length, 0, 'apply output');
});

// --- #4012: body-item target ------------------------------------------------

/** A Copilot `ccr-overview-v2` review body whose Previously missed section
 * lists four items, shaped like PR #4000's review 5480454002. */
const BODY_ITEM_REVIEW_BODY = [
  '<!-- ccr-overview-v2 -->',
  '',
  '### 🟡 Changes recommended',
  '',
  '<details>',
  '<summary><strong>Previously missed (4)</strong></summary>',
  '',
  "In code that hasn't changed since last review",
  '',
  '<details>',
  '<summary><picture><img src="x.png" alt="Medium severity"></picture> Accept punctuation variants in cited-item dispositions</summary>',
  '',
  '`src/​scripts/​review-clause.mts:447`',
  '',
  'The predicate only accepts the bare prefix.',
  '</details>',
  '<details>',
  '<summary><picture><img src="y.png" alt="Low severity"></picture> Keep R&amp;D notes  short</summary>',
  '',
  'A citation-free remark.',
  '</details>',
  '<details>',
  '<summary><picture><img src="z.png" alt="Low severity"></picture> Use &lt;T&gt; in the generic signature</summary>',
  '',
  'Another citation-free remark.',
  '</details>',
  '<details>',
  '<summary><picture><img src="w.png" alt="Low severity"></picture> Don&apos;t drop the caller&#x27;s &#8220;quoted&#8221; text &mdash; or its &ndash; dashes&hellip;</summary>',
  '',
  'A third citation-free remark.',
  '</details>',
  '</details>',
  '',
  '🧠 **Review effort:** Lite',
].join('\n');

const BODY_ITEM_REVIEW_ID = 5480454002;
const BODY_ITEM_TITLE =
  'Accept punctuation variants in cited-item dispositions';
const BODY_ITEM_STAMPED =
  '**Accepted**: the shared prefix grammar is used, in commit abc.\n\n<!-- idd-skill-review-reply -->';

function bodyItemPort(claimComments: ProviderComment[] = []): ReturnType<
  typeof createFakeProviderAdapter
> & {
  fixture: Parameters<typeof createFakeProviderAdapter>[0];
} {
  const fixture: Parameters<typeof createFakeProviderAdapter>[0] = {
    viewerLogin: 'kurone-kito',
    reviews: {
      42: [
        { id: 111, body: 'unrelated review' },
        { id: BODY_ITEM_REVIEW_ID, body: BODY_ITEM_REVIEW_BODY },
      ],
    },
    comments: { 5: claimComments },
    changeRequestHeadRefs: { 42: 'issue/5-feat' },
  };
  const port = createFakeProviderAdapter(fixture);
  return Object.assign(port, { fixture });
}

const BODY_ITEM_CLAIM: ProviderComment = {
  id: 1,
  body: [
    '<!-- claimed-by: claude-a claim-a supersedes: none 2026-10-11T10:00:00Z branch: issue/5-feat -->',
    '',
    '_claude-a: issue claim — IDD automation marker. Do not edit._',
  ].join('\n'),
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
  authorLogin: 'kurone-kito',
  lastEditedAt: null,
};

/** The CLI's claim check, reduced to the fake port: revalidate the claim on
 * issue 5 and bind it to PR 42's head branch. */
function bodyItemAssertClaim(port: ProviderPort, claimId: string): () => void {
  return () => {
    const active = activeOwnedClaim(
      port,
      5,
      '',
      claimId,
      (login) => login === 'kurone-kito',
      { forcedHandoffEnabled: false, isAuthorizedForcedHandoff: () => false },
      24 * 60 * 60 * 1000,
    );
    if (!active) {
      throw new Error(
        `claim revalidation failed: "${claimId}" is no longer the active claim on issue #5`,
      );
    }
    if (active.branch !== port.getChangeRequestHeadRef(42)) {
      throw new Error('claim/PR mismatch');
    }
  };
}

test('parseArgs reads the body-item target flags (#4012)', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--review-id',
    String(BODY_ITEM_REVIEW_ID),
    '--item-title',
    BODY_ITEM_TITLE,
  ]);
  assert.equal(args.reviewId, BODY_ITEM_REVIEW_ID);
  assert.equal(args.itemTitle, BODY_ITEM_TITLE);
  assert.equal(args.commentId, null);
});

test('findBodyItem matches a Previously missed title exactly after normalization (#4012)', () => {
  const reviews = [{ id: BODY_ITEM_REVIEW_ID, body: BODY_ITEM_REVIEW_BODY }];
  assert.deepEqual(
    findBodyItem(reviews, BODY_ITEM_REVIEW_ID, BODY_ITEM_TITLE, 42),
    { found: true, title: BODY_ITEM_TITLE, index: 1 },
  );
  // Entities decode and whitespace runs collapse on both sides.
  assert.deepEqual(
    findBodyItem(reviews, BODY_ITEM_REVIEW_ID, 'Keep R&D notes short', 42),
    { found: true, title: 'Keep R&D notes short', index: 2 },
  );
});

test('findBodyItem keeps literal angle-bracket text in the given title (#4012)', () => {
  const reviews = [{ id: BODY_ITEM_REVIEW_ID, body: BODY_ITEM_REVIEW_BODY }];
  // The summary escapes the brackets; the rendered title shows them.
  assert.deepEqual(
    findBodyItem(
      reviews,
      BODY_ITEM_REVIEW_ID,
      'Use <T> in the generic signature',
      42,
    ),
    { found: true, title: 'Use <T> in the generic signature', index: 3 },
  );
  // The escaped form a caller may copy from the raw body matches too.
  assert.equal(
    findBodyItem(
      reviews,
      BODY_ITEM_REVIEW_ID,
      'Use &lt;T&gt; in the generic signature',
      42,
    ).found,
    true,
  );
  // Dropping the bracketed text is not the same title.
  assert.equal(
    findBodyItem(
      reviews,
      BODY_ITEM_REVIEW_ID,
      'Use in the generic signature',
      42,
    ).found,
    false,
  );
});

test('findBodyItem decodes named and numeric character references in the summary (#4012)', () => {
  const reviews = [{ id: BODY_ITEM_REVIEW_ID, body: BODY_ITEM_REVIEW_BODY }];
  // &apos;, a hex reference, decimal references, and the typographic
  // &mdash; / &ndash; / &hellip; names all decode, so the rendered title
  // matches.
  const rendered =
    "Don't drop the caller's \u201Cquoted\u201D text \u2014 or its \u2013 dashes\u2026";
  assert.deepEqual(findBodyItem(reviews, BODY_ITEM_REVIEW_ID, rendered, 42), {
    found: true,
    title: rendered,
    index: 4,
  });
});

test('findBodyItem refuses a title two items share unless --item-index picks one (#4012)', () => {
  // The PR #3925 corpus review lists two different file-cited items with the
  // same title.
  const corpus = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'tests/fixtures/copilot-review-body-cited/corpus.json'),
      'utf8',
    ),
  ) as { id: string; body: string }[];
  const sample = corpus.find(
    (entry) => entry.id === 'pr-3925-previously-missed-cited',
  );
  assert.ok(sample, 'corpus sample pr-3925-previously-missed-cited');
  const reviews = [{ id: 3925, body: sample.body }];
  const title = 'Preserve reviewer type in bot removal-proof matching';
  const titles = extractPreviouslyMissedItemTitles(sample.body) ?? [];
  const positions = titles.flatMap((t, i) => (t === title ? [i + 1] : []));
  assert.equal(positions.length, 2, 'the fixture repeats the title');

  const ambiguous = findBodyItem(reviews, 3925, title, 42);
  assert.equal(ambiguous.found, false);
  assert.match(
    (ambiguous as { error: string }).error,
    /lists 2 Previously missed items titled .*pass --item-index/,
  );

  for (const index of positions) {
    assert.deepEqual(findBodyItem(reviews, 3925, title, 42, index), {
      found: true,
      title,
      index,
    });
  }
  const other = titles.findIndex((t) => t !== title) + 1;
  assert.ok(other > 0);
  const wrong = findBodyItem(reviews, 3925, title, 42, other);
  assert.equal(wrong.found, false);
  assert.match((wrong as { error: string }).error, /is not titled/);
});

test('findBodyItem refuses a title that the review does not list (#4012)', () => {
  const reviews = [{ id: BODY_ITEM_REVIEW_ID, body: BODY_ITEM_REVIEW_BODY }];
  for (const title of ['Accept punctuation variants', 'Something else', '']) {
    const lookup = findBodyItem(reviews, BODY_ITEM_REVIEW_ID, title, 42);
    assert.equal(lookup.found, false, title);
  }
  // A title from the "open findings" list or plain prose is not an item.
  const lookup = findBodyItem(reviews, BODY_ITEM_REVIEW_ID, 'Lite', 42);
  assert.equal(lookup.found, false);
});

test('findBodyItem refuses an unknown review and a body with no Previously missed section (#4012)', () => {
  const missing = findBodyItem([], BODY_ITEM_REVIEW_ID, BODY_ITEM_TITLE, 42);
  assert.deepEqual(missing, {
    found: false,
    error: `no review ${BODY_ITEM_REVIEW_ID} found on PR #42`,
  });
  const plain = findBodyItem([{ id: 7, body: 'LGTM' }], 7, BODY_ITEM_TITLE, 42);
  assert.equal(plain.found, false);
  assert.match(
    (plain as { error: string }).error,
    /no readable Previously missed section/,
  );
});

/** A real Copilot review body from the bot-comment corpus, by entry id. */
function botCorpusBody(id: string): string {
  const corpus = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'tests/fixtures/bot-comment-corpus/corpus.json'),
      'utf8',
    ),
  ) as { id: string; body: string }[];
  const entry = corpus.find((candidate) => candidate.id === id);
  assert.ok(entry, `bot-comment corpus entry ${id}`);
  return entry.body;
}

test('findBodyItem reads a section titled "1 previously missed issue" (#4526)', () => {
  // PR #4514 review 5563781160: the title Copilot uses since 2026-10-16.
  const reviews = [
    {
      id: 5563781160,
      body: botCorpusBody('copilot-v2-new-title-previously-missed-4514'),
    },
  ];
  assert.deepEqual(
    findBodyItem(
      reviews,
      5563781160,
      'Recognize Setext headings when validating section boundaries',
      4514,
    ),
    {
      found: true,
      title: 'Recognize Setext headings when validating section boundaries',
      index: 1,
    },
  );
});

test('findBodyItem reads a section titled "2 previously missed issues" with a shared title (#4526)', () => {
  // PR #4452 review 5554498936: two items with the same title, one per file.
  const reviews = [
    {
      id: 5554498936,
      body: botCorpusBody('copilot-v2-new-title-previously-missed-4452'),
    },
  ];
  const title = 'Distinguish claim loss from unreadable claim failures';
  const ambiguous = findBodyItem(reviews, 5554498936, title, 4452);
  assert.equal(ambiguous.found, false);
  assert.match(
    (ambiguous as { error: string }).error,
    /lists 2 Previously missed items titled .*pass --item-index/,
  );
  assert.deepEqual(findBodyItem(reviews, 5554498936, title, 4452, 2), {
    found: true,
    title,
    index: 2,
  });
});

test('runBodyItemDisposition dry-run prints the stamped body and posts nothing (#4012)', () => {
  const port = bodyItemPort([BODY_ITEM_CLAIM]);
  let claimChecks = 0;
  const { report, exitCode } = runBodyItemDisposition(port, {
    pr: 42,
    reviewId: BODY_ITEM_REVIEW_ID,
    itemTitle: BODY_ITEM_TITLE,
    stampedBody: BODY_ITEM_STAMPED,
    apply: false,
    assertClaim: () => {
      claimChecks += 1;
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(report, {
    mode: 'dry-run',
    prNumber: 42,
    reviewId: BODY_ITEM_REVIEW_ID,
    itemTitle: BODY_ITEM_TITLE,
    itemIndex: 1,
    body: BODY_ITEM_STAMPED,
  });
  assert.equal(claimChecks, 0);
  assert.deepEqual(port.fixture.postedComments, []);
  assert.equal(port.fixture.resolvedReviewThreadIds, undefined);
  assert.equal(validate(report, resultSchema).length, 0);
});

test('runBodyItemDisposition apply posts exactly one stamped top-level comment and resolves no thread (#4012)', () => {
  const port = bodyItemPort([BODY_ITEM_CLAIM]);
  const { report, exitCode } = runBodyItemDisposition(port, {
    pr: 42,
    reviewId: BODY_ITEM_REVIEW_ID,
    itemTitle: BODY_ITEM_TITLE,
    stampedBody: BODY_ITEM_STAMPED,
    apply: true,
    assertClaim: bodyItemAssertClaim(port, 'claim-a'),
    refreshBody: () => BODY_ITEM_STAMPED,
  });
  assert.equal(exitCode, 0);
  assert.equal(report.status, 'applied');
  assert.deepEqual(port.fixture.postedComments, [
    { number: 42, body: BODY_ITEM_STAMPED },
  ]);
  assert.match(
    port.fixture.postedComments?.[0]?.body ?? '',
    /<!-- idd-skill-review-reply -->$/,
  );
  assert.equal(report.replyId, 1);
  assert.equal(port.fixture.resolvedReviewThreadIds, undefined);
  assert.equal(validate(report, resultSchema).length, 0);
});

test('runBodyItemDisposition apply refuses an unknown title before the claim check or any post (#4012)', () => {
  const port = bodyItemPort([BODY_ITEM_CLAIM]);
  let claimChecks = 0;
  const { report, exitCode } = runBodyItemDisposition(port, {
    pr: 42,
    reviewId: BODY_ITEM_REVIEW_ID,
    itemTitle: 'Not an item in this review',
    stampedBody: BODY_ITEM_STAMPED,
    apply: true,
    assertClaim: () => {
      claimChecks += 1;
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(report.status, 'failed');
  assert.match(report.error ?? '', /lists no Previously missed item titled/);
  // Nothing was posted, so the report carries no body (#4187).
  assert.equal(report.body, undefined);
  assert.equal(claimChecks, 0);
  assert.deepEqual(port.fixture.postedComments, []);
  assert.equal(validate(report, resultSchema).length, 0);
});

test('runBodyItemDisposition apply refuses a missing or stale claim before any post (#4012)', () => {
  // No claim at all on the issue.
  const unclaimed = bodyItemPort([]);
  assert.throws(
    () =>
      runBodyItemDisposition(unclaimed, {
        pr: 42,
        reviewId: BODY_ITEM_REVIEW_ID,
        itemTitle: BODY_ITEM_TITLE,
        stampedBody: BODY_ITEM_STAMPED,
        apply: true,
        assertClaim: bodyItemAssertClaim(unclaimed, 'claim-a'),
      }),
    /claim revalidation failed/,
  );
  assert.deepEqual(unclaimed.fixture.postedComments, []);

  // The issue's active claim belongs to another claim id.
  const other = bodyItemPort([BODY_ITEM_CLAIM]);
  assert.throws(
    () =>
      runBodyItemDisposition(other, {
        pr: 42,
        reviewId: BODY_ITEM_REVIEW_ID,
        itemTitle: BODY_ITEM_TITLE,
        stampedBody: BODY_ITEM_STAMPED,
        apply: true,
        assertClaim: bodyItemAssertClaim(other, 'claim-stale'),
      }),
    /claim revalidation failed/,
  );
  assert.deepEqual(other.fixture.postedComments, []);
});

test('hasBodyItemDispositionPrefix accepts Accepted, Rejected, and the recorded deferral only (#4012)', () => {
  for (const body of [
    '**Accepted** — fixed in abc',
    '**Accepted**: fixed in abc',
    '**Rejected** — `src/a.mts:3` already guards this',
    '**Rejected** — deferred to follow-up issue #12 (round-count): out of scope',
  ]) {
    assert.equal(hasBodyItemDispositionPrefix(body), true, body);
  }
  for (const body of [
    '**Rejection confirmed by maintainer** — agreed',
    '**Fixed** — cleaned up',
    ' **Accepted** — leading space breaks the first-bytes rule',
  ]) {
    assert.equal(hasBodyItemDispositionPrefix(body), false, body);
  }
});

function runCliExpectingUsageFailure(cliArgs: string[]): string {
  try {
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'), ...cliArgs],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    return failure.stderr ?? '';
  }
  throw new Error('expected the CLI to exit non-zero');
}

test('body-item --apply refuses a non-conforming --body before any gh call (compiled CLI, #4012)', () => {
  for (const body of [
    '**Fixed** — cleaned up the stray import',
    '**Rejection confirmed by maintainer** — agreed',
  ]) {
    const stderr = runCliExpectingUsageFailure([
      '--pr',
      '42',
      '--review-id',
      String(BODY_ITEM_REVIEW_ID),
      '--item-title',
      BODY_ITEM_TITLE,
      '--claim-issue',
      '5',
      '--claim-id',
      'claim-a',
      '--apply',
      '--body',
      body,
    ]);
    assert.match(
      stderr,
      /--apply requires --body to start with one of the accepted body-item disposition markers/,
    );
  }
});

test('--apply refuses a --body that carries the pending-decision marker before any gh call, for a thread and a body item (compiled CLI, #4306)', () => {
  const pendingBodies = [
    '**Accepted** (part), fixed in abc1234.\n\n**Awaiting maintainer decision** — the rest is open.',
    '**Rejected** — see `src/a.mts:3`.\n\n**Awaiting maintainer decision** — one question remains.',
  ];
  for (const body of pendingBodies) {
    for (const target of [
      ['--comment-id', '1001'],
      [
        '--review-id',
        String(BODY_ITEM_REVIEW_ID),
        '--item-title',
        BODY_ITEM_TITLE,
      ],
    ]) {
      const stderr = runCliExpectingUsageFailure([
        '--pr',
        '42',
        ...target,
        '--claim-issue',
        '5',
        '--claim-id',
        'claim-a',
        '--apply',
        '--body',
        body,
      ]);
      assert.match(
        stderr,
        /--apply refuses a --body that carries "\*\*Awaiting maintainer decision\*\*"/,
      );
    }
  }
});

test('--apply names the next step for each target in its pending-body refusal (compiled CLI, #4332)', () => {
  const body =
    '**Accepted** (part), fixed in abc1234.\n\n**Awaiting maintainer decision** — the rest is open.';
  const sharedPrefix =
    '--apply refuses a --body that carries "**Awaiting maintainer decision**" at the start of a line: ';
  const targets = [
    {
      // A thread target resolves the thread, so the caller keeps it open.
      target: ['--comment-id', '1001'],
      refusal: `${sharedPrefix}this helper resolves the thread, and a pending decision keeps it open. Post that reply by hand and leave the thread unresolved (E6)`,
    },
    {
      // A body-item target resolves no thread: wait, then settle the item.
      target: [
        '--review-id',
        String(BODY_ITEM_REVIEW_ID),
        '--item-title',
        BODY_ITEM_TITLE,
      ],
      refusal: `${sharedPrefix}this helper posts a top-level reply that settles the item, and a pending decision settles nothing. Wait for the maintainer's decision, then post a settled disposition (E6)`,
    },
  ];
  for (const { target, refusal } of targets) {
    const stderr = runCliExpectingUsageFailure([
      '--pr',
      '42',
      ...target,
      '--claim-issue',
      '5',
      '--claim-id',
      'claim-a',
      '--apply',
      '--body',
      body,
    ]);
    assert.equal(stderr.trimEnd(), refusal);
  }
});

test('--comment-id cannot be combined with the body-item target (compiled CLI, #4012)', () => {
  const stderr = runCliExpectingUsageFailure([
    '--pr',
    '42',
    '--comment-id',
    '1001',
    '--review-id',
    String(BODY_ITEM_REVIEW_ID),
    '--item-title',
    BODY_ITEM_TITLE,
  ]);
  assert.match(
    stderr,
    /--comment-id cannot be combined with --review-id, --item-title, or --item-index/,
  );
});

test('body-item dry-run reads the review and prints the stamped body without posting (compiled CLI, #4012)', () => {
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
const joined = args.join(' ');
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
const fail = (msg) => { fs.writeSync(2, msg); process.exit(1); };
if (args[0] === 'api' && joined.includes('repos/o/r/pulls/42/reviews') && !args.includes('POST')) {
  out(JSON.stringify({ id: ${BODY_ITEM_REVIEW_ID}, body: ${JSON.stringify(BODY_ITEM_REVIEW_BODY)} }) + '\\n');
}
fail('unexpected gh invocation: ' + joined);
`,
  );
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'),
        '--pr',
        '42',
        '--owner',
        'o',
        '--repo',
        'r',
        '--review-id',
        String(BODY_ITEM_REVIEW_ID),
        '--item-title',
        BODY_ITEM_TITLE,
        '--body',
        '**Accepted** — fixed in abc',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const report = JSON.parse(output) as ResolveReviewThreadReport;
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.reviewId, BODY_ITEM_REVIEW_ID);
    assert.equal(report.itemTitle, BODY_ITEM_TITLE);
    assert.equal(report.status, undefined);
    assert.match(report.body ?? '', /<!-- idd-skill-review-reply -->$/);
    assert.equal(validate(report, resultSchema).length, 0);
  } finally {
    restore();
  }
});

// Triage line (#4186). The fake port answers the Copilot review count and the
// head SHA from fixtures; `throwingReviewsPort` proves a path makes no read.
const TRIAGE_PR = 42;
const TRIAGE_HEAD = 'deadbeefcafe0123456789abcdef0123456789ab';
const TRIAGE_LOGIN = 'copilot-pull-request-reviewer[bot]';
const TRIAGE_STAMP = '<!-- idd-skill-review-reply -->';

function triageFlags(overrides: Partial<TriageFlags> = {}): TriageFlags {
  return {
    tier: '',
    urgency: '',
    copilotLabel: '',
    safetyClass: false,
    lite: false,
    advisoryConverged: '',
    pathB: false,
    scopeFence: false,
    protectedAuthority: false,
    acceptedMidFix: false,
    adoptNow: false,
    override: null,
    ...overrides,
  };
}

function triagePort(reviewCount: number): ProviderPort {
  return createFakeProviderAdapter({
    reviews: {
      [TRIAGE_PR]: Array.from({ length: reviewCount }, (_, index) => ({
        id: index + 1,
        user: { login: TRIAGE_LOGIN },
        state: 'COMMENTED',
        body: '',
      })),
    },
    changeRequestHeadShas: { [TRIAGE_PR]: TRIAGE_HEAD },
  });
}

function throwingReviewsPort(): ProviderPort {
  return {
    ...triagePort(0),
    listReviews: () => {
      throw new Error('listReviews must not be called on this path');
    },
  };
}

function buildTriage(
  port: ProviderPort,
  rawBody: string,
  flags: Partial<TriageFlags>,
  policy: {
    deferByUrgency?: 'off' | 'low' | 'low-and-medium' | 'severity-tiered';
    markerPrefix?: string;
    deferAllAfterRounds?: number;
  } = {},
) {
  return buildTriageReplyBody({
    port,
    pr: TRIAGE_PR,
    rawBody,
    markerPrefix: policy.markerPrefix,
    deferByUrgency: policy.deferByUrgency ?? 'severity-tiered',
    deferRelaxAtRounds: [4, 7],
    deferAllAfterRounds: policy.deferAllAfterRounds,
    flags: triageFlags(flags),
  });
}

test('buildTriageReplyBody writes step 0 with a blank line before the stamp (#4186)', () => {
  const { body, record } = buildTriage(
    triagePort(2),
    '**Accepted** — fixed in abc',
    {
      tier: 'high',
      urgency: 'high',
    },
  );
  assert.equal(record?.step, 0);
  assert.equal(
    body,
    `**Accepted** — fixed in abc\nTriage: tier high; urgency high; step 0; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  );
});

test('buildTriageReplyBody wraps a failed head read so a 404 still reads as a read failure (#4186)', () => {
  const port = {
    ...triagePort(4),
    getChangeRequestHeadSha: () => {
      throw tagGhCommandError(new Error('gh: Not Found (HTTP 404)'));
    },
  };
  assert.throws(
    () =>
      buildTriage(port, '**Accepted** — x', {
        tier: 'high',
        urgency: 'high',
        advisoryConverged: TRIAGE_HEAD,
      }),
    (error: unknown) =>
      error instanceof TriageReadError &&
      classifyHelperError(error.original).kind === 'not-found',
  );
});

test('buildTriageReplyBody relax step follows the Copilot review count at 4 and 7 (#4186)', () => {
  const four = buildTriage(triagePort(4), '**Accepted** — x', {
    tier: 'high',
    urgency: 'high',
  });
  assert.equal(four.record?.step, 1);
  const seven = buildTriage(triagePort(7), '**Accepted** — x', {
    tier: 'high',
    urgency: 'high',
  });
  assert.equal(seven.record?.step, 2);
});

test('buildTriageReplyBody keeps step 0 under --lite at nine reviews (#4186)', () => {
  const { record } = buildTriage(triagePort(9), '**Accepted** — x', {
    tier: 'high',
    urgency: 'high',
    lite: true,
  });
  assert.equal(record?.step, 0);
});

test('buildTriageReplyBody reads no review under lite or a non-severity-tiered mode (#4186)', () => {
  const lite = buildTriage(throwingReviewsPort(), '**Accepted** — x', {
    tier: 'high',
    urgency: 'high',
    lite: true,
  });
  assert.equal(lite.record?.step, 0);
  const low = buildTriage(
    throwingReviewsPort(),
    '**Accepted** — x',
    { tier: 'high', urgency: 'high' },
    { deferByUrgency: 'low' },
  );
  assert.equal(low.record?.step, 0);
});

test('buildTriageReplyBody converged head raises the step only with the matching SHA (#4186)', () => {
  const four = buildTriage(triagePort(4), '**Accepted** — x', {
    tier: 'high',
    urgency: 'high',
    advisoryConverged: TRIAGE_HEAD,
  });
  assert.equal(four.record?.step, 2);
  assert.equal(four.record?.convergedHead, 'deadbee');
  assert.equal(
    four.body,
    `**Accepted** — x\nTriage: tier high; urgency high; step 2; converged deadbee; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  );
  const seven = buildTriage(triagePort(7), '**Accepted** — x', {
    tier: 'high',
    urgency: 'high',
    advisoryConverged: TRIAGE_HEAD,
  });
  assert.equal(seven.record?.step, 2);
  assert.equal(seven.record?.convergedHead, null);
  assert.equal(
    seven.body,
    `**Accepted** — x\nTriage: tier high; urgency high; step 2; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  );
  assert.throws(
    () =>
      buildTriage(triagePort(4), '**Accepted** — x', {
        tier: 'high',
        urgency: 'high',
        advisoryConverged: 'f00dfeed',
      }),
    (error: unknown) =>
      error instanceof TriageUsageError &&
      error.message.includes('f00dfeed') &&
      error.message.includes(TRIAGE_HEAD),
  );
});

test('buildTriageReplyBody writes the Copilot label and safety class in order (#4186)', () => {
  const { body } = buildTriage(triagePort(4), '**Accepted** — x', {
    tier: 'medium',
    urgency: 'low',
    copilotLabel: 'low',
    safetyClass: true,
  });
  assert.equal(
    body,
    `**Accepted** — x\nTriage: tier medium; urgency low; step 1; Copilot low; safety; verdict keep; blocked safety-class\n\n${TRIAGE_STAMP}`,
  );
});

test('buildTriageReplyBody inserts the line directly before an existing stamp (#4186)', () => {
  const { body } = buildTriage(
    triagePort(2),
    `**Accepted** — x\n${TRIAGE_STAMP}`,
    {
      tier: 'high',
      urgency: 'high',
    },
  );
  assert.equal(
    body,
    `**Accepted** — x\nTriage: tier high; urgency high; step 0; verdict keep; blocked matrix\n${TRIAGE_STAMP}`,
  );
});

test('buildTriageReplyBody leaves a body without a Triage line exactly as before (#4186)', () => {
  const { body, record } = buildTriage(
    throwingReviewsPort(),
    '**Accepted** — x',
    {},
  );
  assert.equal(record, null);
  assert.equal(body, `**Accepted** — x\n\n${TRIAGE_STAMP}`);
});

test('buildTriageReplyBody writes nothing and reads nothing for a blank body (#4186)', () => {
  const { body, record } = buildTriage(throwingReviewsPort(), '  ', {
    tier: 'high',
    urgency: 'high',
  });
  assert.equal(body, '');
  assert.equal(record, null);
});

test('buildTriageReplyBody carries the line to a review-body item unchanged (#4186)', () => {
  const { body } = buildTriage(bodyItemPort(), '**Accepted** — fixed in abc', {
    tier: 'high',
    urgency: 'high',
  });
  const report = runBodyItemDisposition(bodyItemPort(), {
    pr: 42,
    reviewId: BODY_ITEM_REVIEW_ID,
    itemTitle: BODY_ITEM_TITLE,
    stampedBody: body,
    apply: false,
    assertClaim: () => {},
  }).report;
  assert.equal(
    report.body,
    `**Accepted** — fixed in abc\nTriage: tier high; urgency high; step 0; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  );
});

test('buildTriageReplyBody propagates a failed review read as a transport error (#4186)', () => {
  const port = {
    ...triagePort(0),
    listReviews: () => {
      throw tagGhCommandError(new Error('gh command failed: gh: HTTP 500'));
    },
  };
  assert.throws(
    () =>
      buildTriage(port, '**Accepted** — x', { tier: 'high', urgency: 'high' }),
    (error: unknown) =>
      error instanceof TriageReadError &&
      classifyHelperError(error.original).kind === 'transport',
  );
});

test('validateTriageFlags refuses an Accepted reply without both scores under record and enforce (#4186)', () => {
  for (const triageRecord of ['record', 'enforce'] as const) {
    const record = {
      apply: true,
      body: '**Accepted** — x',
      triageRecord,
      reviewPolicy: undefined,
    };
    // With no score the record requirement itself refuses, under this mode.
    assert.throws(
      () => validateTriageFlags({ ...record, flags: triageFlags() }),
      (error: unknown) =>
        error instanceof TriageUsageError &&
        error.message.includes(`triageRecord ${triageRecord} requires`),
      triageRecord,
    );
    // A lone score fails the pair check first, which names --urgency.
    for (const flags of [{ tier: 'high' }, { urgency: 'high' }]) {
      assert.throws(
        () => validateTriageFlags({ ...record, flags: triageFlags(flags) }),
        (error: unknown) =>
          error instanceof TriageUsageError &&
          error.message.includes('--urgency'),
        `${triageRecord} ${JSON.stringify(flags)}`,
      );
    }
  }
});

test('buildTriageReplyBody counts only Copilot reviews toward the relax step (#4186)', () => {
  // Four Copilot reviews (one dismissed, which still counts: the issue says
  // any state) and seven others. Counting every review gives 11 (step 2), an
  // inverted filter gives 7 (step 2), and dropping the dismissed one gives 3
  // (step 0). Only the correct count, 4, gives step 1.
  const others = Array.from({ length: 7 }, (_, index) => ({
    id: 20 + index,
    user: { login: index % 2 === 0 ? 'octocat' : 'coderabbitai[bot]' },
    state: 'COMMENTED',
    body: '',
  }));
  const rows = [
    ...triageReviewRows(3),
    { id: 9, user: { login: TRIAGE_LOGIN }, state: 'DISMISSED', body: '' },
    ...others,
  ];
  const port = createFakeProviderAdapter({
    reviews: { [TRIAGE_PR]: rows },
    changeRequestHeadShas: { [TRIAGE_PR]: TRIAGE_HEAD },
  });
  const { record } = buildTriage(port, '**Accepted** — x', {
    tier: 'high',
    urgency: 'high',
  });
  assert.equal(record?.step, 1);
});

test('buildTriageReplyBody honours a custom reply-identity marker prefix (#4186)', () => {
  const { body } = buildTriage(
    triagePort(2),
    '**Accepted** — x\n<!-- acme-review-reply -->',
    { tier: 'high', urgency: 'high' },
    { markerPrefix: 'acme' },
  );
  assert.equal(
    body,
    '**Accepted** — x\nTriage: tier high; urgency high; step 0; verdict keep; blocked matrix\n<!-- acme-review-reply -->',
  );
});

test('validateTriageFlags applies the record requirement to every disposition prefix the gate admits (#4186)', () => {
  for (const body of [
    '**Accepted:** fixed in abc',
    '**Rejected.** not needed',
    '**Rejected** — deferred to follow-up issue #5',
  ]) {
    assert.throws(
      () =>
        validateTriageFlags({
          flags: triageFlags(),
          apply: true,
          body,
          triageRecord: 'record',
          reviewPolicy: undefined,
        }),
      (error: unknown) =>
        error instanceof TriageUsageError && error.message.includes('--tier'),
      body,
    );
  }
});

test('validateTriageFlags refuses an invalid --urgency value (#4186)', () => {
  assert.throws(
    () =>
      validateTriageFlags({
        flags: triageFlags({ tier: 'high', urgency: 'urgent' }),
        apply: false,
        body: '',
        triageRecord: 'off',
        reviewPolicy: undefined,
      }),
    (error: unknown) =>
      error instanceof TriageUsageError &&
      error.message.includes('--urgency must be one of'),
  );
});

test('validateTriageFlags refuses an invalid --copilot-label value (#4186)', () => {
  assert.throws(
    () =>
      validateTriageFlags({
        flags: triageFlags({ copilotLabel: 'bogus' }),
        apply: false,
        body: '',
        triageRecord: 'off',
        reviewPolicy: undefined,
      }),
    (error: unknown) =>
      error instanceof TriageUsageError &&
      error.message.includes('--copilot-label must be one of'),
  );
});

test('an optional triage flag with no line is a no-op, not an error (#4186)', () => {
  for (const flags of [
    { lite: true },
    { safetyClass: true },
    { copilotLabel: 'low' },
    { advisoryConverged: TRIAGE_HEAD },
  ]) {
    assert.doesNotThrow(() =>
      validateTriageFlags({
        flags: triageFlags(flags),
        apply: false,
        body: '',
        triageRecord: 'off',
        reviewPolicy: 'human-required',
      }),
    );
    const { body, record } = buildTriage(
      throwingReviewsPort(),
      '**Accepted** — x',
      flags,
    );
    assert.equal(record, null);
    assert.equal(body, `**Accepted** — x\n\n${TRIAGE_STAMP}`);
  }
});

test('validateTriageFlags allows the record-mode exemptions and the off and dry-run paths (#4186)', () => {
  const flags = triageFlags();
  assert.doesNotThrow(() =>
    validateTriageFlags({
      flags,
      apply: true,
      body: '**Rejection confirmed by maintainer** — x',
      triageRecord: 'record',
      reviewPolicy: undefined,
    }),
  );
  assert.doesNotThrow(() =>
    validateTriageFlags({
      flags: triageFlags({ pathB: true }),
      apply: true,
      body: '**Accepted** — x',
      triageRecord: 'record',
      reviewPolicy: undefined,
    }),
  );
  assert.doesNotThrow(() =>
    validateTriageFlags({
      flags,
      apply: true,
      body: '**Accepted** — x',
      triageRecord: 'off',
      reviewPolicy: undefined,
    }),
  );
  assert.doesNotThrow(() =>
    validateTriageFlags({
      flags,
      apply: false,
      body: '**Accepted** — x',
      triageRecord: 'record',
      reviewPolicy: undefined,
    }),
  );
});

test('validateTriageFlags refuses --path-b with a triage flag and a lone tier or urgency (#4186)', () => {
  assert.throws(
    () =>
      validateTriageFlags({
        flags: triageFlags({ tier: 'low', urgency: 'low', pathB: true }),
        apply: false,
        body: '',
        triageRecord: 'off',
        reviewPolicy: undefined,
      }),
    /--path-b/u,
  );
  assert.throws(
    () =>
      validateTriageFlags({
        flags: triageFlags({ pathB: true, lite: true }),
        apply: false,
        body: '',
        triageRecord: 'off',
        reviewPolicy: undefined,
      }),
    /--path-b/u,
  );
  assert.throws(
    () =>
      validateTriageFlags({
        flags: triageFlags({ tier: 'low' }),
        apply: false,
        body: '',
        triageRecord: 'off',
        reviewPolicy: undefined,
      }),
    /--urgency/u,
  );
});

test('validateTriageFlags refuses --advisory-converged under a reviewPolicy other than copilot-advisory (#4186)', () => {
  const flags = triageFlags({
    tier: 'high',
    urgency: 'high',
    advisoryConverged: TRIAGE_HEAD,
  });
  assert.throws(
    () =>
      validateTriageFlags({
        flags,
        apply: false,
        body: '',
        triageRecord: 'off',
        reviewPolicy: 'human-required',
      }),
    /copilot-advisory/u,
  );
  assert.doesNotThrow(() =>
    validateTriageFlags({
      flags,
      apply: false,
      body: '',
      triageRecord: 'off',
      reviewPolicy: 'copilot-advisory',
    }),
  );
});

test('--help lists the triage flags, including the verdict flags (#4186, #4187)', () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'), '--help'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  for (const flag of [
    '--tier',
    '--urgency',
    '--copilot-label',
    '--safety-class',
    '--lite',
    '--advisory-converged',
    '--path-b',
    '--scope-fence',
    '--protected-authority',
    '--accepted-mid-fix',
    '--adopt-now',
    '--override',
  ]) {
    assert.match(output, new RegExp(`^ {2}${flag}[ <]`, 'mu'), flag);
  }
});

/**
 * Run the compiled CLI from a scratch cwd whose only policy layer is a
 * fixture config, with `PATH` empty so any `gh` call would fail to spawn.
 */
function runCliWithPolicy(
  cliArgs: string[],
  config: Record<string, unknown>,
): { status: number; stderr: string } {
  let scratch = '';
  try {
    scratch = mkdtempSync(join(tmpdir(), 'idd-triage-cli-'));
    mkdirSync(join(scratch, '.github', 'idd'), { recursive: true });
    writeFileSync(
      join(scratch, '.github', 'idd', 'config.json'),
      `${JSON.stringify(config)}\n`,
    );
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'), ...cliArgs],
      {
        cwd: scratch,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: '',
          HOME: scratch,
          XDG_CONFIG_HOME: scratch,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    throw new Error('expected the CLI to exit non-zero');
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    if (failure.status === undefined) {
      throw error;
    }
    return { status: failure.status, stderr: failure.stderr ?? '' };
  } finally {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

const CLI_ACCEPTED_BODY = '**Accepted** — operator-authorized, no linked issue';

test('the compiled CLI refuses a record-mode Accepted reply without --urgency (#4186)', () => {
  const failure = runCliWithPolicy(
    [
      '--pr',
      '42',
      '--owner',
      'o',
      '--repo',
      'r',
      '--comment-id',
      '1001',
      '--claimless',
      '--apply',
      '--body',
      CLI_ACCEPTED_BODY,
    ],
    { critiqueLoop: { triageRecord: 'record' } },
  );
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /--urgency/u);
});

test('the compiled CLI refuses --path-b with a triage flag (#4186)', () => {
  const failure = runCliWithPolicy(
    [
      '--pr',
      '42',
      '--owner',
      'o',
      '--repo',
      'r',
      '--comment-id',
      '1001',
      '--path-b',
      '--tier',
      'low',
      '--urgency',
      'low',
      '--body',
      CLI_ACCEPTED_BODY,
    ],
    { critiqueLoop: { triageRecord: 'record' } },
  );
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /--path-b/u);
});

test('the compiled CLI refuses an unknown --urgency value (#4186)', () => {
  const failure = runCliWithPolicy(
    [
      '--pr',
      '42',
      '--owner',
      'o',
      '--repo',
      'r',
      '--comment-id',
      '1001',
      '--tier',
      'high',
      '--urgency',
      'urgent',
      '--body',
      CLI_ACCEPTED_BODY,
    ],
    {},
  );
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /--urgency must be one of/u);
});

/** Copilot review rows for the first `count` reviews, for the stubbed `gh`. */
function triageReviewRows(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    user: { login: TRIAGE_LOGIN },
    state: 'COMMENTED',
    body: '',
  }));
}

/**
 * A stubbed `gh` for the apply-mode triage tests. It answers the pull request
 * view, the review list, the head SHA, the thread lookup and resolve, and the
 * work-item duplicate read, and it appends each POST body to the ledger.
 */
function triageGhStub(
  reviews: unknown[] | string | { status: number } | null,
): string {
  let reviewsRoute: string;
  if (reviews === null) {
    reviewsRoute = "fail('gh: HTTP 500 for pulls/42/reviews');";
  } else if (typeof reviews === 'string') {
    reviewsRoute = `out(${JSON.stringify(reviews)});`;
  } else if (Array.isArray(reviews)) {
    reviewsRoute = `out(JSON.stringify(${JSON.stringify(reviews)}));`;
  } else {
    reviewsRoute = `fail('gh: Not Found (HTTP ${reviews.status}) for pulls/42/reviews');`;
  }
  return `const fs = require('node:fs');
const args = process.argv.slice(2);
const joined = args.join(' ');
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
const fail = (msg) => { fs.writeSync(2, msg); process.exit(1); };
if (process.env.TRIAGE_CALLS) fs.appendFileSync(process.env.TRIAGE_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  if (process.env.TRIAGE_HEAD_FAIL) fail('gh: HTTP 500 for pulls/42');
  if (joined.includes('--jq')) out('${TRIAGE_HEAD}\\n');
  out(JSON.stringify({ headRefOid: '${TRIAGE_HEAD}', headRefName: 'main', author: { login: 'someone' }, url: 'https://example.invalid/pr/42', closingIssuesReferences: [] }));
}
if (args[0] === 'api' && joined.includes('/pulls/42/reviews')) {
  if (process.env.TRIAGE_REVIEW_SEQUENCE) {
    // One review list per read, in order; the last list repeats (#4187).
    const seq = JSON.parse(process.env.TRIAGE_REVIEW_SEQUENCE);
    const reads = fs.readFileSync(process.env.TRIAGE_CALLS, 'utf8').split('\\n').filter((line) => line.includes('/pulls/42/reviews')).length;
    const entry = seq[Math.min(reads, seq.length) - 1];
    if (entry === null) fail('gh: HTTP 500 for pulls/42/reviews');
    out(JSON.stringify(entry));
  }
  ${reviewsRoute}
}
if (args[0] === 'api' && args[1] === 'user') out('kurone-kito\\n');
if (args[0] === 'api' && joined.includes('/pulls/42') && joined.includes('.head.ref')) out('issue/5-triage-fixture\\n');
if (args[0] === 'api' && args[1] === 'graphql' && joined.includes('closingIssuesReferences')) {
  out(JSON.stringify({ data: { repository: { pullRequest: { headRefOid: '${TRIAGE_HEAD}', closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
}
if (args[0] === 'api' && args[1] === 'graphql' && joined.includes('issue(number:$number)')) {
  const createdAt = new Date(Date.now() - 60000).toISOString();
  const markerTime = createdAt.replace(/\\.\\d{3}Z$/u, 'Z');
  const body = '<!-- claimed-by: fixture-agent fixture-claim supersedes: none ' + markerTime + ' branch: issue/5-triage-fixture -->\\n\\n_fixture-agent: issue claim — IDD automation marker. Do not edit._';
  out(JSON.stringify({ data: { repository: { issue: { comments: { nodes: [{ id: 'IC_fixture', databaseId: 5001, body, createdAt, updatedAt: createdAt, lastEditedAt: null, author: { login: 'kurone-kito', __typename: 'User' } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
}
if (args[0] === 'api' && joined.includes('/issues/42/comments') && !args.includes('POST')) {
  out('[]\\n');
}
if (args[0] === 'api' && args.includes('POST')) {
  const body = JSON.parse(fs.readFileSync(0, 'utf8')).body;
  fs.appendFileSync(process.env.TRIAGE_LEDGER, JSON.stringify({ posted: body }) + '\\n');
  out(JSON.stringify({ id: 4242, html_url: 'https://example.invalid/comment/4242', body }));
}
if (args[0] === 'api' && args[1] === 'graphql') {
  if (joined.includes('reviewThreads')) {
    out(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'THREAD1', isResolved: false, path: 'x', comments: { nodes: [{ databaseId: 1001 }], pageInfo: { hasNextPage: false, endCursor: null } } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
  }
  if (joined.includes('resolveReviewThread')) {
    out(JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }));
  }
}
fail('unexpected gh invocation: ' + joined);
`;
}

/** One compiled-CLI run against the stubbed `gh` (#4187). */
interface TriageRun {
  status: number;
  stdout: string;
  stderr: string;
  /** Each POST body the stub received, in order. */
  posted: string[];
  /** The argv of every `gh` call the CLI made, in order. */
  calls: string[][];
}

/**
 * Run the compiled CLI, apply or dry run, from a scratch cwd whose only policy
 * layer is `config`, against the stubbed `gh`. Returns the status, stdout,
 * stderr, each POST body, and every `gh` argv the stub received, in order.
 */
function runTriageApply(
  cliArgs: string[],
  config: Record<string, unknown>,
  reviews: unknown[] | string | { status: number } | null,
  extraEnv: Record<string, string> = {},
): TriageRun {
  let scratch = '';
  let restore: (() => void) | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'idd-triage-apply-'));
    mkdirSync(join(scratch, '.github', 'idd'), { recursive: true });
    writeFileSync(
      join(scratch, '.github', 'idd', 'config.json'),
      `${JSON.stringify(config)}\n`,
    );
    const ledger = join(scratch, 'posted.jsonl');
    const callLog = join(scratch, 'calls.jsonl');
    restore = stubExecutable('gh', triageGhStub(reviews));
    // spawnSync, not execFileSync, so stdout and stderr come back on every
    // exit, including the success path a dry run and a warning take (#4187).
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'), ...cliArgs],
      {
        cwd: scratch,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: scratch,
          XDG_CONFIG_HOME: scratch,
          TRIAGE_LEDGER: ledger,
          TRIAGE_CALLS: callLog,
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const posted = existsSync(ledger)
      ? readFileSync(ledger, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => (JSON.parse(line) as { posted: string }).posted)
      : [];
    const calls = existsSync(callLog)
      ? readFileSync(callLog, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as string[])
      : [];
    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      posted,
      calls,
    };
  } finally {
    restore?.();
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

const TRIAGE_THREAD_ARGS = [
  '--pr',
  '42',
  '--comment-id',
  '1001',
  '--owner',
  'o',
  '--repo',
  'r',
  '--claimless',
  '--apply',
];
const TRIAGE_TIERED_CONFIG = {
  critiqueLoop: {
    triageRecord: 'record',
    deferByUrgency: 'severity-tiered',
    deferRelaxAtRounds: [4, 7],
  },
};

test('the compiled CLI posts the Triage line before the stamp on a record-mode thread reply (#4186)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      '**Accepted** — fixed in abc',
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(2),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    `**Accepted** — fixed in abc\nTriage: tier high; urgency high; step 0; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  ]);
});

test('the advisory-convergence record pointer applies with a valid claim and resolves its thread', () => {
  const now = new Date().toISOString();
  const head = 'a'.repeat(40);
  const verdict = computeAdvisoryConvergenceVerdict(
    {
      prNumber: 42,
      prHeadSha: head,
      reviews: [
        {
          author: { login: TRIAGE_LOGIN },
          submittedAt: now,
          commitId: head,
          itemCount: 1,
          body: '<!-- ccr-overview-v2 -->\n\n## Copilot review overview\n\n**Findings:** One\n',
        },
      ],
      claimMarkerHistoryPresent: false,
      claimCandidateAmbiguous: false,
    },
    {
      now,
      primaryBotLogin: 'copilot',
      triageRecord: 'record',
      trustedMarkerLogins: ['kurone-kito'],
    },
  );
  const pointer = verdict.nextActions.find((action) =>
    action.pointer.startsWith(
      'node scripts/resolve-review-thread.mjs --pr 42 --comment-id',
    ),
  )?.pointer;
  assert.ok(
    pointer,
    formatAssertNextActions(verdict, { triageRecord: 'record' }),
  );
  assert.match(pointer, /--tier <tier> --urgency <urgency> --apply$/u);

  const tokens = pointer
    .match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/gu)
    ?.map((token) =>
      token.startsWith('"') ? (JSON.parse(token) as string) : token,
    );
  assert.ok(tokens);
  assert.deepEqual(tokens.slice(0, 2), [
    'node',
    'scripts/resolve-review-thread.mjs',
  ]);
  const cliArgs = tokens.slice(2);
  for (let index = 0; index < cliArgs.length; index += 1) {
    if (cliArgs[index] === '--comment-id') cliArgs[index + 1] = '1001';
    if (cliArgs[index] === '--body') {
      cliArgs[index + 1] =
        '**Accepted** — fixed in 0123456789abcdef0123456789abcdef01234567';
    }
    if (cliArgs[index] === '--claim-issue') cliArgs[index + 1] = '5';
    if (cliArgs[index] === '--claim-id') cliArgs[index + 1] = 'fixture-claim';
    if (cliArgs[index] === '--tier') cliArgs[index + 1] = 'high';
    if (cliArgs[index] === '--urgency') cliArgs[index + 1] = 'medium';
  }
  cliArgs.push('--owner', 'o', '--repo', 'r');

  const config = {
    trustedMarkerActors: ['kurone-kito'],
    critiqueLoop: {
      triageRecord: 'record',
      deferByUrgency: 'severity-tiered',
      deferRelaxAtRounds: [4, 7],
    },
  };
  const applied = runTriageApply(cliArgs, config, triageReviewRows(2));
  assert.equal(
    applied.status,
    0,
    `${applied.stderr}\n${applied.stdout}\n${JSON.stringify(applied.calls)}`,
  );
  assert.equal(applied.posted.length, 1);
  assert.match(
    applied.posted[0] ?? '',
    /^\*\*Accepted\*\* — fixed in 0123456789abcdef0123456789abcdef01234567\nTriage: tier high; urgency medium/u,
  );
  assert.ok(
    applied.calls.some((call) =>
      call.some((argument) => argument.includes('resolveReviewThread')),
    ),
    JSON.stringify(applied.calls),
  );

  const missingTriageArgs = cliArgs.filter(
    (argument, index, all) =>
      argument !== '--tier' &&
      argument !== '--urgency' &&
      all[index - 1] !== '--tier' &&
      all[index - 1] !== '--urgency',
  );
  const missing = runTriageApply(
    missingTriageArgs,
    config,
    triageReviewRows(2),
  );
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(
    missing.stderr,
    /triageRecord record requires --tier and --urgency/u,
  );
  assert.deepEqual(missing.posted, []);
});

test('validateTriageFlags names --path-b when a lone urgency is given with it (#4186)', () => {
  assert.throws(
    () =>
      validateTriageFlags({
        flags: triageFlags({ pathB: true, urgency: 'low' }),
        apply: false,
        body: '',
        triageRecord: 'off',
        reviewPolicy: undefined,
      }),
    /--path-b/u,
  );
});

test('the compiled CLI writes a converged step 2 when --advisory-converged names the head (#4186)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--advisory-converged',
      TRIAGE_HEAD,
      '--body',
      '**Accepted** — fixed in abc',
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(4),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    `**Accepted** — fixed in abc\nTriage: tier high; urgency high; step 2; converged deadbee; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  ]);
});

test('a review read that returns non-JSON reports kind transport in the error envelope (#4186)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      '**Accepted** — fixed in abc',
    ],
    TRIAGE_TIERED_CONFIG,
    'not json',
    { IDD_HELPER_ERROR_ENVELOPE: '1' },
  );
  assert.equal(run.status, 1);
  assert.deepEqual(run.posted, []);
  const envelope = JSON.parse(run.stderr.trim().split('\n').at(-1) ?? '{}') as {
    iddHelperError?: { kind?: string };
  };
  assert.equal(envelope.iddHelperError?.kind, 'transport');
});

/** The `kind` of the helper error envelope printed as the last stderr line. */
function envelopeKind(stderr: string): string | undefined {
  const envelope = JSON.parse(stderr.trim().split('\n').at(-1) ?? '{}') as {
    iddHelperError?: { kind?: string };
  };
  return envelope.iddHelperError?.kind;
}

test('a 404 on the review list reports kind transport in the error envelope (#4186)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      '**Accepted** — fixed in abc',
    ],
    TRIAGE_TIERED_CONFIG,
    { status: 404 },
    { IDD_HELPER_ERROR_ENVELOPE: '1' },
  );
  assert.equal(run.status, 1);
  assert.deepEqual(run.posted, []);
  assert.equal(envelopeKind(run.stderr), 'transport');
});

test('a mismatched --advisory-converged reports kind usage in the error envelope (#4186)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--advisory-converged',
      'f00dfeed',
      '--body',
      '**Accepted** — fixed in abc',
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(4),
    { IDD_HELPER_ERROR_ENVELOPE: '1' },
  );
  assert.equal(run.status, 1);
  assert.deepEqual(run.posted, []);
  assert.equal(envelopeKind(run.stderr), 'usage');
});

test('the compiled CLI stamps a record-mode reply with the configured marker prefix (#4186)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      '**Accepted** — fixed in abc',
    ],
    { ...TRIAGE_TIERED_CONFIG, markerPrefix: 'acme' },
    triageReviewRows(2),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    '**Accepted** — fixed in abc\nTriage: tier high; urgency high; step 0; verdict keep; blocked matrix\n\n<!-- acme-review-reply -->',
  ]);
});

test('the compiled CLI writes step 1 for four Copilot reviews on a record-mode thread reply (#4186)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      '**Accepted** — fixed in abc',
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(4),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    `**Accepted** — fixed in abc\nTriage: tier high; urgency high; step 1; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  ]);
});

test('the compiled CLI exits 1 with a message and posts nothing when the review read fails (#4186)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      '**Accepted** — fixed in abc',
    ],
    TRIAGE_TIERED_CONFIG,
    null,
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /reply not posted: .*gh: HTTP 500/u);
  assert.deepEqual(run.posted, []);
});

test('the compiled CLI posts the reply body unchanged with no triage flag (#4186)', () => {
  const run = runTriageApply(
    [...TRIAGE_THREAD_ARGS, '--body', '**Accepted** — fixed in abc'],
    {},
    triageReviewRows(2),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    `**Accepted** — fixed in abc\n\n${TRIAGE_STAMP}`,
  ]);
});

test('the compiled CLI posts nothing when --advisory-converged names another head (#4186)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--advisory-converged',
      'f00dfeed',
      '--body',
      '**Accepted** — fixed in abc',
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(4),
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /f00dfeed/u);
  assert.deepEqual(run.posted, []);
});

test('the compiled CLI posts a Rejection confirmed reply under record with no triage flag (#4186)', () => {
  const body = '**Rejection confirmed by maintainer** — x';
  const run = runTriageApply(
    [...TRIAGE_THREAD_ARGS, '--body', body],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(2),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [`${body}\n\n${TRIAGE_STAMP}`]);
});

test('the compiled CLI posts a path B reply under record with no triage line (#4186)', () => {
  const body = '**Accepted** — advisory remark';
  const run = runTriageApply(
    [...TRIAGE_THREAD_ARGS, '--path-b', '--body', body],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(2),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [`${body}\n\n${TRIAGE_STAMP}`]);
});

test('the compiled CLI puts the Triage line before the stamp on a review-body item (#4186)', () => {
  const run = runTriageApply(
    [
      '--pr',
      '42',
      '--owner',
      'o',
      '--repo',
      'r',
      '--review-id',
      String(BODY_ITEM_REVIEW_ID),
      '--item-title',
      BODY_ITEM_TITLE,
      '--claimless',
      '--apply',
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      '**Accepted** — fixed in abc',
    ],
    TRIAGE_TIERED_CONFIG,
    [
      {
        id: BODY_ITEM_REVIEW_ID,
        user: { login: TRIAGE_LOGIN },
        state: 'COMMENTED',
        body: BODY_ITEM_REVIEW_BODY,
      },
    ],
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    `**Accepted** — fixed in abc\nTriage: tier high; urgency high; step 0; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  ]);
});

test('the schema refuses an envelope that names both targets or neither (#4012)', () => {
  // A complete target plus one field of the other target is refused too.
  const threadPlusReviewId = {
    mode: 'dry-run',
    prNumber: 7,
    commentId: 1001,
    alreadyResolved: false,
    reviewId: 9,
  };
  assert.notEqual(
    validate(threadPlusReviewId, resultSchema).length,
    0,
    'thread target with a stray reviewId',
  );
  const bodyItemPlusThreadId = {
    mode: 'dry-run',
    prNumber: 7,
    reviewId: 9,
    itemTitle: 'x',
    threadId: 'thread-b',
  };
  assert.notEqual(
    validate(bodyItemPlusThreadId, resultSchema).length,
    0,
    'body-item target with a stray threadId',
  );
  const both = {
    mode: 'dry-run',
    prNumber: 7,
    commentId: 1001,
    alreadyResolved: false,
    reviewId: 9,
    itemTitle: 'x',
  };
  assert.notEqual(validate(both, resultSchema).length, 0, 'both targets');
  const neither = { mode: 'dry-run', prNumber: 7 };
  assert.notEqual(validate(neither, resultSchema).length, 0, 'no target');
});

// ---------------------------------------------------------------------------
// The E5 defer-matrix verdict and the --override reason (#4187)
// ---------------------------------------------------------------------------

const TRIAGE_ENFORCE_CONFIG = {
  critiqueLoop: {
    triageRecord: 'enforce',
    deferByUrgency: 'severity-tiered',
    deferRelaxAtRounds: [4, 7],
  },
};
const TRIAGE_THREAD_DRY_ARGS = TRIAGE_THREAD_ARGS.filter(
  (arg) => arg !== '--apply',
);
const ACCEPTED_FIXED = '**Accepted** — fixed in abc';
const DEFERRAL_BODY =
  '**Rejected** — deferred to follow-up issue #4300 (needs decision): wider scope';

/** True when a `gh` call the CLI made would change GitHub state (#4187). */
function madeWriteCall(calls: string[][]): boolean {
  return calls.some(
    (call) =>
      call.includes('POST') ||
      call.some((arg) => arg.includes('resolveReviewThread')),
  );
}

/**
 * Asserts the stub logged the CLI's `gh` calls and that none of them wrote.
 * The log must be non-empty first, so a broken log cannot pass vacuously
 * (#4187).
 */
function assertNoWrite(run: TriageRun): void {
  assert.ok(run.calls.length > 0, 'the stub logged the CLI gh calls');
  assert.equal(madeWriteCall(run.calls), false);
}

/** The usage message for an `--override` the static check refuses, or null (#4187). */
function overrideError(
  flags: Partial<TriageFlags>,
  body: string,
  triageRecord: 'off' | 'record' | 'enforce' = 'record',
  deferByUrgency:
    | 'off'
    | 'low'
    | 'low-and-medium'
    | 'severity-tiered' = 'severity-tiered',
): string | null {
  try {
    validateTriageFlags({
      flags: triageFlags({
        tier: 'low',
        urgency: 'medium',
        override: 'why',
        ...flags,
      }),
      apply: false,
      body,
      triageRecord,
      reviewPolicy: undefined,
      deferByUrgency,
    });
    return null;
  } catch (error) {
    assert.ok(error instanceof TriageUsageError, String(error));
    return (error as Error).message;
  }
}

test('enforce refuses an Accepted defer on apply and posts nothing; the dry run shows the verdict (#4187)', () => {
  const applied = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(applied.status, 1, applied.stderr);
  assert.match(
    applied.stderr,
    /triage verdict: defer \(eligibility low, blocked by none\); pass --override "<reason>" to post anyway/u,
  );
  assert.deepEqual(applied.posted, []);
  assertNoWrite(applied);

  const dry = runTriageApply(
    [
      ...TRIAGE_THREAD_DRY_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(
    dry.stderr,
    /^triage verdict: defer \(eligibility low, blocked by none\)$/mu,
  );
  assert.equal(
    JSON.parse(dry.stdout).body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency medium; step 2; verdict defer\n\n${TRIAGE_STAMP}`,
  );
});

test('enforce posts an Accepted keep at step 1 and writes the matrix block (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(4),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier high; urgency high; step 1; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  ]);
});

test('enforce posts an Accepted keep blocked by accepted-mid-fix and reports eligibility none (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'low',
      '--urgency',
      'very-low',
      '--accepted-mid-fix',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stderr,
    /triage verdict: keep \(eligibility none, blocked by accepted-mid-fix\)/u,
  );
  assert.deepEqual(run.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency very-low; step 2; verdict keep; blocked accepted-mid-fix\n\n${TRIAGE_STAMP}`,
  ]);
});

test('a safety-class finding at step 1 is blocked by the safety class (#4187)', () => {
  const { body, verdict } = buildTriage(triagePort(4), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'low',
    safetyClass: true,
  });
  assert.equal(verdict?.verdict, 'keep');
  assert.equal(verdict?.eligibility, 'low');
  assert.equal(
    body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency low; step 1; safety; verdict keep; blocked safety-class\n\n${TRIAGE_STAMP}`,
  );
});

test('the Copilot label raises eligibility to high, so a medium finding at step 1 defers (#4187)', () => {
  const { body, verdict } = buildTriage(triagePort(4), ACCEPTED_FIXED, {
    tier: 'medium',
    urgency: 'low',
    copilotLabel: 'high',
  });
  assert.equal(verdict?.verdict, 'defer');
  assert.equal(verdict?.eligibility, 'high');
  assert.equal(
    body,
    `${ACCEPTED_FIXED}\nTriage: tier medium; urgency low; step 1; Copilot high; verdict defer\n\n${TRIAGE_STAMP}`,
  );
});

test('--scope-fence and --protected-authority block a deferral with eligibility none (#4187)', () => {
  const scoped = buildTriage(triagePort(0), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'low',
    scopeFence: true,
  });
  assert.equal(scoped.verdict?.eligibility, null);
  assert.equal(
    scoped.body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency low; step 0; verdict keep; blocked scope-fence\n\n${TRIAGE_STAMP}`,
  );
  const authority = buildTriage(triagePort(0), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'low',
    protectedAuthority: true,
  });
  assert.equal(authority.verdict?.eligibility, null);
  assert.equal(
    authority.body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency low; step 0; verdict keep; blocked protected-authority\n\n${TRIAGE_STAMP}`,
  );
});

test('enforce posts a refused Accepted defer when --override gives a reason, which ends the line (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--override',
      'verdict keep at E5',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency medium; step 2; verdict defer; override: verdict keep at E5\n\n${TRIAGE_STAMP}`,
  ]);
});

test('a dry run accepts --override and shows the line the apply would post (#4187)', () => {
  const dry = runTriageApply(
    [
      ...TRIAGE_THREAD_DRY_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--override',
      'needed now',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(
    JSON.parse(dry.stdout).body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency medium; step 2; verdict defer; override: needed now\n\n${TRIAGE_STAMP}`,
  );
});

test('a deferral (Rejected) posts under enforce at defer and at keep, with its verdict (#4187)', () => {
  const deferred = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--body',
      DEFERRAL_BODY,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(deferred.status, 0, deferred.stderr);
  assert.deepEqual(deferred.posted, [
    `${DEFERRAL_BODY}\nTriage: tier low; urgency medium; step 2; verdict defer\n\n${TRIAGE_STAMP}`,
  ]);
  const kept = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      DEFERRAL_BODY,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(4),
  );
  assert.equal(kept.status, 0, kept.stderr);
  assert.deepEqual(kept.posted, [
    `${DEFERRAL_BODY}\nTriage: tier high; urgency high; step 1; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  ]);
});

test('enforce refuses an Accepted: variant, which the apply gate also admits (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--body',
      '**Accepted:** fixed in abc',
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /triage verdict: defer/u);
  assert.deepEqual(run.posted, []);
  assertNoWrite(run);
});

test('record mode posts a defer with no override, and --override adds its reason (#4187)', () => {
  const plain = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(plain.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency medium; step 2; verdict defer\n\n${TRIAGE_STAMP}`,
  ]);
  const overridden = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--override',
      'needed now',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.deepEqual(overridden.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency medium; step 2; verdict defer; override: needed now\n\n${TRIAGE_STAMP}`,
  ]);
});

test('the off mode still computes the verdict on a dry run (#4187)', () => {
  const dry = runTriageApply(
    [
      ...TRIAGE_THREAD_DRY_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    {
      critiqueLoop: {
        triageRecord: 'off',
        deferByUrgency: 'severity-tiered',
        deferRelaxAtRounds: [4, 7],
      },
    },
    triageReviewRows(7),
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /triage verdict: defer/u);
  assert.equal(
    JSON.parse(dry.stdout).body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency medium; step 2; verdict defer\n\n${TRIAGE_STAMP}`,
  );
});

test('enforce under a non-severity-tiered mode warns, computes no verdict, and posts (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      ACCEPTED_FIXED,
    ],
    { critiqueLoop: { triageRecord: 'enforce', deferByUrgency: 'low' } },
    triageReviewRows(0),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stderr,
    /^warning: triageRecord enforce refuses only under deferByUrgency severity-tiered/mu,
  );
  assert.doesNotMatch(run.stderr, /triage verdict/u);
  assert.deepEqual(run.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier high; urgency high; step 0\n\n${TRIAGE_STAMP}`,
  ]);
});

test('--lite with a keep verdict refuses --override as a usage error (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_DRY_ARGS,
      '--lite',
      '--tier',
      'high',
      '--urgency',
      'high',
      '--override',
      'why',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--override requires a defer verdict/u);
  assert.equal(run.stdout, '');
});

test('apply with --override on a keep verdict exits 1 and posts nothing (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--override',
      'why',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(4),
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /--override requires a defer verdict/u);
  assert.deepEqual(run.posted, []);
  assertNoWrite(run);
});

test('the compiled CLI refuses --override under triageRecord off (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_DRY_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--override',
      'why',
      '--body',
      ACCEPTED_FIXED,
    ],
    {
      critiqueLoop: {
        triageRecord: 'off',
        deferByUrgency: 'severity-tiered',
        deferRelaxAtRounds: [4, 7],
      },
    },
    triageReviewRows(7),
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /--override requires triageRecord record or enforce/u,
  );
  assert.equal(run.stdout, '');
});

test('enforce refuses a body-item Accepted defer before any write (#4187)', () => {
  const run = runTriageApply(
    [
      '--pr',
      '42',
      '--review-id',
      '9',
      '--item-title',
      'Previously missed title',
      '--owner',
      'o',
      '--repo',
      'r',
      '--claimless',
      '--apply',
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /triage verdict: defer \(eligibility low, blocked by none\); pass --override "<reason>" to post anyway/u,
  );
  assert.deepEqual(run.posted, []);
  assertNoWrite(run);
});

test('validateTriageFlags refuses each static --override condition before any read (#4187)', () => {
  assert.match(
    overrideError({ override: '' }, ACCEPTED_FIXED) ?? '',
    /non-empty reason/u,
  );
  assert.match(
    overrideError({ override: '   ' }, ACCEPTED_FIXED) ?? '',
    /non-empty reason/u,
  );
  assert.match(
    overrideError({ override: 'a\nb' }, ACCEPTED_FIXED) ?? '',
    /one line/u,
  );
  assert.match(
    overrideError({}, ACCEPTED_FIXED, 'off') ?? '',
    /triageRecord record or enforce/u,
  );
  assert.match(
    overrideError({}, ACCEPTED_FIXED, 'record', 'low') ?? '',
    /severity-tiered/u,
  );
  assert.match(
    overrideError({ tier: '', urgency: '' }, ACCEPTED_FIXED) ?? '',
    /--tier and --urgency/u,
  );
  assert.match(
    overrideError({}, '**Rejected** — x') ?? '',
    /Accepted reply body/u,
  );
  assert.equal(overrideError({}, '**Accepted:** x'), null);
  assert.equal(overrideError({}, ACCEPTED_FIXED), null);
});

test('buildTriageReplyBody refuses --override on a keep verdict, trims the reason, and refuses a line break (#4187)', () => {
  assert.throws(
    () =>
      buildTriage(triagePort(4), ACCEPTED_FIXED, {
        tier: 'high',
        urgency: 'high',
        override: 'why',
      }),
    (error: unknown) =>
      error instanceof TriageUsageError &&
      /requires a defer verdict/u.test(error.message),
  );
  assert.throws(
    () =>
      buildTriage(triagePort(0), ACCEPTED_FIXED, {
        tier: 'low',
        urgency: 'medium',
        override: 'a\nb',
      }),
    (error: unknown) =>
      error instanceof TriageUsageError && /one line/u.test(error.message),
  );
  const { body } = buildTriage(triagePort(0), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'medium',
    override: '  needed now  ',
  });
  assert.equal(
    body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency medium; step 0; verdict defer; override: needed now\n\n${TRIAGE_STAMP}`,
  );
});

test('parseArgs reads the verdict flags, with --override null when absent (#4187)', () => {
  const absent = parseArgs(['--pr', '42', '--comment-id', '1001']);
  assert.equal(absent.override, null);
  assert.equal(absent.scopeFence, false);
  const empty = parseArgs([
    '--pr',
    '42',
    '--comment-id',
    '1001',
    '--override',
    '',
  ]);
  assert.equal(empty.override, '');
  const flags = parseArgs([
    '--pr',
    '42',
    '--comment-id',
    '1001',
    '--scope-fence',
    '--protected-authority',
    '--accepted-mid-fix',
  ]);
  assert.equal(flags.scopeFence, true);
  assert.equal(flags.protectedAuthority, true);
  assert.equal(flags.acceptedMidFix, true);
});

test('validateTriageFlags refuses --path-b with each verdict input (#4187)', () => {
  for (const flag of [
    { scopeFence: true },
    { protectedAuthority: true },
    { acceptedMidFix: true },
    { override: 'why' },
  ]) {
    assert.throws(
      () =>
        validateTriageFlags({
          flags: triageFlags({ pathB: true, ...flag }),
          apply: false,
          body: ACCEPTED_FIXED,
          triageRecord: 'off',
          reviewPolicy: undefined,
        }),
      /--path-b/u,
    );
  }
});

test('validateTriageFlags refuses a body that already carries a Triage line when a line is built (#4187)', () => {
  const carrying = `${ACCEPTED_FIXED}\nTriage: tier low; urgency low; step 0`;
  assert.throws(
    () =>
      validateTriageFlags({
        flags: triageFlags({ tier: 'low', urgency: 'low' }),
        apply: false,
        body: carrying,
        triageRecord: 'record',
        reviewPolicy: undefined,
        deferByUrgency: 'severity-tiered',
      }),
    /already carries a Triage line/u,
  );
  // With no tier and urgency no line is built, so the body is left alone.
  assert.doesNotThrow(() =>
    validateTriageFlags({
      flags: triageFlags({}),
      apply: false,
      body: carrying,
      triageRecord: 'record',
      reviewPolicy: undefined,
      deferByUrgency: 'severity-tiered',
    }),
  );
});

test('an apply judges the verdict again right before the post, so a count that crossed the threshold refuses (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(4),
    {
      // The early read sees four reviews (step 1: keep). The read right before
      // the post sees seven (step 2: defer), so the post must be refused.
      TRIAGE_REVIEW_SEQUENCE: JSON.stringify([
        triageReviewRows(4),
        triageReviewRows(7),
      ]),
    },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /triage verdict: defer \(eligibility high, blocked by none\); pass --override "<reason>" to post anyway/u,
  );
  assert.deepEqual(run.posted, []);
  assertNoWrite(run);
  // The early line, then the refusal line.
  assert.equal((run.stderr.match(/^triage verdict:/gmu) ?? []).length, 2);
  // Nothing was posted, so the report carries no body.
  assert.equal(JSON.parse(run.stdout).body, undefined);
  // The post waits for the claim check: a pr view call falls between the reads.
  const readIndexes = run.calls.flatMap((call, index) =>
    call.some((arg) => arg.includes('/pulls/42/reviews')) ? [index] : [],
  );
  assert.ok(
    run.calls
      .slice(readIndexes[0] + 1, readIndexes[1])
      .some((call) => call[0] === 'pr' && call[1] === 'view'),
  );
  // Both the early read and the late read reached GitHub.
  assert.equal(
    run.calls.filter((call) =>
      call.some((arg) => arg.includes('/pulls/42/reviews')),
    ).length,
    2,
  );
});

test('runBodyItemDisposition refreshes the body after the claim check and posts nothing when it refuses (#4187)', () => {
  const port = bodyItemPort([BODY_ITEM_CLAIM]);
  assert.throws(
    () =>
      runBodyItemDisposition(port, {
        pr: 42,
        reviewId: BODY_ITEM_REVIEW_ID,
        itemTitle: BODY_ITEM_TITLE,
        stampedBody: BODY_ITEM_STAMPED,
        apply: true,
        assertClaim: bodyItemAssertClaim(port, 'claim-a'),
        refreshBody: () => {
          throw new TriageRefusedError('refused by the late verdict');
        },
      }),
    (error: unknown) => error instanceof TriageRefusedError,
  );
  assert.equal((port.fixture.postedComments ?? []).length, 0);
});

test('runBodyItemDisposition posts the body refreshBody returns, not the early one (#4187)', () => {
  const port = bodyItemPort([BODY_ITEM_CLAIM]);
  const refreshed =
    '**Rejected** — refreshed on the late read\n\n<!-- idd-skill-review-reply -->';
  const { report } = runBodyItemDisposition(port, {
    pr: 42,
    reviewId: BODY_ITEM_REVIEW_ID,
    itemTitle: BODY_ITEM_TITLE,
    stampedBody: BODY_ITEM_STAMPED,
    apply: true,
    assertClaim: bodyItemAssertClaim(port, 'claim-a'),
    refreshBody: () => refreshed,
  });
  assert.deepEqual(port.fixture.postedComments, [
    { number: 42, body: refreshed },
  ]);
  assert.equal(report.body, refreshed);
});

test('runBodyItemDisposition checks the claim before it refreshes the body (#4187)', () => {
  const port = bodyItemPort([BODY_ITEM_CLAIM]);
  const order: string[] = [];
  const claim = bodyItemAssertClaim(port, 'claim-a');
  runBodyItemDisposition(port, {
    pr: 42,
    reviewId: BODY_ITEM_REVIEW_ID,
    itemTitle: BODY_ITEM_TITLE,
    stampedBody: BODY_ITEM_STAMPED,
    apply: true,
    assertClaim: () => {
      order.push('claim');
      claim();
    },
    refreshBody: () => {
      order.push('refresh');
      return BODY_ITEM_STAMPED;
    },
  });
  // The claim is checked, the body refreshed, and the claim checked again
  // right before the post, so a handoff during the read cannot reach it.
  assert.deepEqual(order, ['claim', 'refresh', 'claim']);
});

test('runBodyItemDisposition refuses an apply without refreshBody, so no stale body is posted (#4187)', () => {
  const port = bodyItemPort([BODY_ITEM_CLAIM]);
  assert.throws(
    () =>
      runBodyItemDisposition(port, {
        pr: 42,
        reviewId: BODY_ITEM_REVIEW_ID,
        itemTitle: BODY_ITEM_TITLE,
        stampedBody: BODY_ITEM_STAMPED,
        apply: true,
        assertClaim: bodyItemAssertClaim(port, 'claim-a'),
      }),
    /needs refreshBody/u,
  );
  assert.equal((port.fixture.postedComments ?? []).length, 0);
});

test('an apply whose late verdict read fails posts nothing and reports the read failure (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(4),
    // The early read succeeds (step 1: keep); the read right before the post fails.
    {
      TRIAGE_REVIEW_SEQUENCE: JSON.stringify([triageReviewRows(4), null]),
      IDD_HELPER_ERROR_ENVELOPE: '1',
    },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(run.posted, []);
  assertNoWrite(run);
  const report = JSON.parse(run.stdout) as { status?: string; error?: string };
  assert.equal(report.status, 'failed');
  assert.match(report.error ?? '', /500/u);
  assert.equal(JSON.parse(run.stdout).body, undefined);
  assert.equal(envelopeKind(run.stderr), 'transport');
});

test('a body-item apply refused by the late verdict check posts nothing and reports no body (#4187)', () => {
  const itemReview = {
    id: BODY_ITEM_REVIEW_ID,
    user: { login: TRIAGE_LOGIN },
    state: 'COMMENTED',
    body: BODY_ITEM_REVIEW_BODY,
  };
  // The early read sees four Copilot reviews including the item's (step 1:
  // keep). The item lookup reads again, and the read right before the post
  // sees seven (step 2: defer).
  const run = runTriageApply(
    [
      '--pr',
      '42',
      '--review-id',
      String(BODY_ITEM_REVIEW_ID),
      '--item-title',
      BODY_ITEM_TITLE,
      '--owner',
      'o',
      '--repo',
      'r',
      '--claimless',
      '--apply',
      '--tier',
      'high',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    [...triageReviewRows(3), itemReview],
    {
      TRIAGE_REVIEW_SEQUENCE: JSON.stringify([
        [...triageReviewRows(3), itemReview],
        [...triageReviewRows(3), itemReview],
        [...triageReviewRows(6), itemReview],
      ]),
    },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /triage verdict: defer \(eligibility high, blocked by none\); pass --override "<reason>" to post anyway/u,
  );
  assert.deepEqual(run.posted, []);
  assertNoWrite(run);
  assert.equal(JSON.parse(run.stdout).body, undefined);
});

test('a late read that turns keep under --override reports kind usage in the envelope (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'medium',
      '--override',
      'why',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(7),
    {
      // The early read sees seven reviews (step 2: defer, so the override is
      // accepted). The late read sees three (step 0: keep).
      TRIAGE_REVIEW_SEQUENCE: JSON.stringify([
        triageReviewRows(7),
        triageReviewRows(3),
      ]),
      IDD_HELPER_ERROR_ENVELOPE: '1',
    },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(run.posted, []);
  assertNoWrite(run);
  assert.equal(envelopeKind(run.stderr), 'usage');
});

test('an apply with no matching thread fails with no body and posts nothing (#4187)', () => {
  const run = runTriageApply(
    [
      '--pr',
      '42',
      '--comment-id',
      '999',
      '--owner',
      'o',
      '--repo',
      'r',
      '--claimless',
      '--apply',
      '--tier',
      'low',
      '--urgency',
      'low',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(0),
  );
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(run.posted, []);
  assertNoWrite(run);
  const report = JSON.parse(run.stdout) as { status?: string; body?: string };
  assert.equal(report.status, 'failed');
  assert.equal(report.body, undefined);
});

test('an apply re-checks the claim after the late read and before the post (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(4),
    // Both reads keep (step 1), so the post goes through.
    {
      TRIAGE_REVIEW_SEQUENCE: JSON.stringify([
        triageReviewRows(4),
        triageReviewRows(4),
      ]),
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier high; urgency medium; step 1; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  ]);
  const reads = run.calls.flatMap((call, index) =>
    call.some((arg) => arg.includes('/pulls/42/reviews')) ? [index] : [],
  );
  assert.equal(reads.length, 2);
  // A claim check (a pr view call) falls after the late read, before the post.
  assert.ok(
    run.calls
      .slice(reads[1] + 1)
      .some((call) => call[0] === 'pr' && call[1] === 'view'),
  );
});

test('record mode prints one verdict line on an apply and posts it (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal((run.stderr.match(/^triage verdict:/gmu) ?? []).length, 1);
  assert.equal(JSON.parse(run.stdout).body, run.posted[0]);
});

// #4188: the compute-only triage mode, run through the compiled CLI with a
// valid --pr and a score flag, and no target, no --body, and no --apply.
const COMPUTE_ONLY_ARGS = ['--pr', '42', '--owner', 'o', '--repo', 'r'];

/**
 * Assert a compute-only run posted nothing and made only the expected `gh`
 * calls. `routes` lists the substrings that may appear, so an empty list means
 * the run made no call at all.
 */
function assertComputeOnlyCalls(run: TriageRun, routes: string[]): void {
  assert.deepEqual(run.posted, []);
  for (const call of run.calls) {
    const joined = call.join(' ');
    assert.equal(call.includes('POST'), false, joined);
    assert.equal(joined.includes('graphql'), false, joined);
    assert.equal(joined.includes('/issues/'), false, joined);
    assert.equal(joined.includes('/comments'), false, joined);
    assert.ok(
      routes.some((route) => joined.includes(route)),
      `unexpected gh call: ${joined}`,
    );
  }
}

test('compute-only triage prints the value a reply would carry and posts nothing (#4188)', () => {
  const run = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'low', '--urgency', 'medium'],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.deepEqual(JSON.parse(run.stdout), {
    mode: 'triage',
    prNumber: 42,
    triage: 'Triage: tier low; urgency medium; step 2; verdict defer',
  });
  assertComputeOnlyCalls(run, ['/pulls/42/reviews']);
  assert.equal(run.calls.length, 1);
});

test('compute-only triage keeps a high finding at step 0 with the matrix block (#4188)', () => {
  const run = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'high', '--urgency', 'high'],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(2),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    JSON.parse(run.stdout).triage,
    'Triage: tier high; urgency high; step 0; verdict keep; blocked matrix',
  );
  assertComputeOnlyCalls(run, ['/pulls/42/reviews']);
});

test('compute-only triage under deferByUrgency low has step 0, no verdict, and reads no reviews (#4188)', () => {
  const run = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'low', '--urgency', 'medium'],
    { critiqueLoop: { deferByUrgency: 'low', deferRelaxAtRounds: [4, 7] } },
    triageReviewRows(7),
  );
  assert.equal(run.status, 0, run.stderr);
  const { triage } = JSON.parse(run.stdout) as { triage: string };
  assert.equal(triage, 'Triage: tier low; urgency medium; step 0');
  assertComputeOnlyCalls(run, []);
});

test('compute-only triage with --lite has step 0 and reads no reviews (#4188)', () => {
  const run = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'low', '--urgency', 'medium', '--lite'],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(9),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    JSON.parse(run.stdout).triage,
    'Triage: tier low; urgency medium; step 0; verdict defer',
  );
  assertComputeOnlyCalls(run, []);
});

test('compute-only triage refuses --override as a usage error and posts nothing (#4188)', () => {
  const run = runTriageApply(
    [
      ...COMPUTE_ONLY_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--override',
      'why',
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
    { IDD_HELPER_ERROR_ENVELOPE: '1' },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(envelopeKind(run.stderr), 'usage');
  assert.equal(run.stdout, '');
  assertComputeOnlyCalls(run, []);
});

test('compute-only triage names a lone --tier as a usage error (#4188)', () => {
  const run = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'low'],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
    { IDD_HELPER_ERROR_ENVELOPE: '1' },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(envelopeKind(run.stderr), 'usage');
  assert.match(run.stderr, /--tier and --urgency must be given together/u);
  assert.equal(run.stdout, '');
  assert.deepEqual(run.calls, []);
});

test('compute-only triage refuses --path-b with a score as a usage error (#4188)', () => {
  const run = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'low', '--urgency', 'medium', '--path-b'],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
    { IDD_HELPER_ERROR_ENVELOPE: '1' },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(envelopeKind(run.stderr), 'usage');
  assert.equal(run.stdout, '');
  assertComputeOnlyCalls(run, []);
});

test('compute-only triage refuses an --advisory-converged sha that is not the head (#4188)', () => {
  const run = runTriageApply(
    [
      ...COMPUTE_ONLY_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--advisory-converged',
      '0000000',
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
    { IDD_HELPER_ERROR_ENVELOPE: '1' },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(envelopeKind(run.stderr), 'usage');
  assert.equal(run.stdout, '');
  assert.equal(run.posted.length, 0);
});

test('a target-less call with no score flag still prints the usage (#4188)', () => {
  const run = runTriageApply(
    COMPUTE_ONLY_ARGS,
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /^usage: node scripts\/resolve-review-thread/u);
  assert.deepEqual(run.calls, []);
});

test('the compute-only output validates against the result schema, and a bare triage object does not (#4188)', () => {
  const run = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'low', '--urgency', 'medium'],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(validate(JSON.parse(run.stdout), resultSchema).length, 0);
  assert.equal(
    validate(
      {
        mode: 'dry-run',
        prNumber: 42,
        commentId: 1001,
        alreadyResolved: false,
      },
      resultSchema,
    ).length,
    0,
    'dry-run output',
  );
  assert.ok(
    validate({ mode: 'triage', prNumber: 42 }, resultSchema).length > 0,
    'a triage object with no triage value',
  );
  assert.ok(
    validate(
      { mode: 'triage', prNumber: 42, triage: 'Triage: x', commentId: 1001 },
      resultSchema,
    ).length > 0,
    'a triage object that names a thread target',
  );
});

test('the schema refuses a cross-mode object in either direction (#4188)', () => {
  const crossMode = [
    // A target-branch object that names the triage mode.
    { mode: 'triage', prNumber: 42, commentId: 1001, alreadyResolved: false },
    { mode: 'triage', prNumber: 42, reviewId: 7, itemTitle: 'x' },
    // A compute-only object that names a write mode.
    {
      mode: 'dry-run',
      prNumber: 42,
      triage: 'Triage: tier low; urgency medium; step 2',
    },
    {
      mode: 'apply',
      prNumber: 42,
      triage: 'Triage: tier low; urgency medium; step 2',
    },
  ];
  for (const report of crossMode) {
    assert.ok(
      validate(report, resultSchema).length > 0,
      `cross-mode object should fail: ${JSON.stringify(report)}`,
    );
  }
  assert.equal(
    validate(
      {
        mode: 'dry-run',
        prNumber: 42,
        commentId: 1001,
        alreadyResolved: false,
      },
      resultSchema,
    ).length,
    0,
  );
  assert.equal(
    validate(
      { mode: 'apply', prNumber: 42, reviewId: 7, itemTitle: 'x' },
      resultSchema,
    ).length,
    0,
  );
});

test('compute-only triage reports a failed review-list read as kind transport and posts nothing (#4188)', () => {
  const run = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'low', '--urgency', 'medium'],
    TRIAGE_TIERED_CONFIG,
    null,
    { IDD_HELPER_ERROR_ENVELOPE: '1' },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(envelopeKind(run.stderr), 'transport');
  assert.equal(run.stdout, '');
  assertComputeOnlyCalls(run, ['/pulls/42/reviews']);
});

test('compute-only triage reports a failed head read as kind transport and posts nothing (#4188)', () => {
  const run = runTriageApply(
    [
      ...COMPUTE_ONLY_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--advisory-converged',
      TRIAGE_HEAD.slice(0, 7),
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
    { IDD_HELPER_ERROR_ENVELOPE: '1', TRIAGE_HEAD_FAIL: '1' },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(envelopeKind(run.stderr), 'transport');
  assert.equal(run.stdout, '');
  assertComputeOnlyCalls(run, ['/pulls/42/reviews', 'pr view']);
});

test('compute-only triage without repository flags does no lookup when it reads no reviews (#4188)', () => {
  // The stub fails any call it does not route, so a `gh repo view` lookup
  // would exit 1 here. Exit 0 with no calls shows the lookup did not run.
  const low = runTriageApply(
    ['--pr', '42', '--tier', 'low', '--urgency', 'medium'],
    { critiqueLoop: { deferByUrgency: 'low', deferRelaxAtRounds: [4, 7] } },
    null,
  );
  assert.equal(low.status, 0, low.stderr);
  assert.equal(
    JSON.parse(low.stdout).triage,
    'Triage: tier low; urgency medium; step 0',
  );
  assertComputeOnlyCalls(low, []);

  const lite = runTriageApply(
    ['--pr', '42', '--tier', 'low', '--urgency', 'medium', '--lite'],
    TRIAGE_TIERED_CONFIG,
    null,
  );
  assert.equal(lite.status, 0, lite.stderr);
  assert.equal(
    JSON.parse(lite.stdout).triage,
    'Triage: tier low; urgency medium; step 0; verdict defer',
  );
  assertComputeOnlyCalls(lite, []);
});

test('record mode reads the reviews once on an apply, since only enforce refuses (#4187)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'low',
      '--urgency',
      'medium',
      '--body',
      ACCEPTED_FIXED,
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(7),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency medium; step 2; verdict defer\n\n${TRIAGE_STAMP}`,
  ]);
  assert.equal(
    run.calls.filter((call) =>
      call.some((arg) => arg.includes('/pulls/42/reviews')),
    ).length,
    1,
  );
});

// #4436: `--adopt-now` reports adopt-now condition (d) under `severity-tiered`.
// It turns a defer verdict into `keep` blocked by `adopt-now` and leaves every
// other verdict as it is.

test('parseArgs reads --adopt-now as off by default and on when given (#4436)', () => {
  assert.equal(
    parseArgs(['--pr', '42', '--comment-id', '1001']).adoptNow,
    false,
  );
  assert.equal(
    parseArgs(['--pr', '42', '--comment-id', '1001', '--adopt-now']).adoptNow,
    true,
  );
});

test('--adopt-now turns a step-0 defer into keep blocked by adopt-now; without it the verdict stays defer (#4436)', () => {
  const adopted = buildTriage(triagePort(0), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'very-low',
    adoptNow: true,
  });
  assert.deepEqual(adopted.verdict, {
    verdict: 'keep',
    eligibility: 'low',
    blocked: 'adopt-now',
  });
  assert.equal(
    adopted.body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency very-low; step 0; verdict keep; blocked adopt-now\n\n${TRIAGE_STAMP}`,
  );
  const plain = buildTriage(triagePort(0), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'very-low',
  });
  assert.deepEqual(plain.verdict, {
    verdict: 'defer',
    eligibility: 'low',
    blocked: null,
  });
  assert.equal(
    plain.body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency very-low; step 0; verdict defer\n\n${TRIAGE_STAMP}`,
  );
});

test('compute-only triage prints keep blocked by adopt-now with --adopt-now and defer without it (#4436)', () => {
  const adopted = runTriageApply(
    [
      ...COMPUTE_ONLY_ARGS,
      '--tier',
      'low',
      '--urgency',
      'very-low',
      '--adopt-now',
    ],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(0),
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(
    JSON.parse(adopted.stdout).triage,
    'Triage: tier low; urgency very-low; step 0; verdict keep; blocked adopt-now',
  );
  assertComputeOnlyCalls(adopted, ['/pulls/42/reviews']);

  const plain = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'low', '--urgency', 'very-low'],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(0),
  );
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(
    JSON.parse(plain.stdout).triage,
    'Triage: tier low; urgency very-low; step 0; verdict defer',
  );
  assertComputeOnlyCalls(plain, ['/pulls/42/reviews']);
});

test('--adopt-now leaves a keep verdict with its own reason: a scope fence and the matrix (#4436)', () => {
  const scoped = buildTriage(triagePort(0), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'very-low',
    scopeFence: true,
    adoptNow: true,
  });
  assert.deepEqual(scoped.verdict, {
    verdict: 'keep',
    eligibility: null,
    blocked: 'scope-fence',
  });
  assert.equal(
    scoped.body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency very-low; step 0; verdict keep; blocked scope-fence\n\n${TRIAGE_STAMP}`,
  );
  const matrix = buildTriage(triagePort(0), ACCEPTED_FIXED, {
    tier: 'high',
    urgency: 'high',
    adoptNow: true,
  });
  assert.deepEqual(matrix.verdict, {
    verdict: 'keep',
    eligibility: 'high',
    blocked: 'matrix',
  });
});

test('enforce posts an Accepted reply with --adopt-now that it would refuse at defer (#4436)', () => {
  const args = [
    ...TRIAGE_THREAD_ARGS,
    '--tier',
    'low',
    '--urgency',
    'very-low',
    '--body',
    ACCEPTED_FIXED,
  ];
  const refused = runTriageApply(
    args,
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(0),
  );
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(refused.posted, []);

  const adopted = runTriageApply(
    [...args, '--adopt-now'],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(0),
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.match(
    adopted.stderr,
    /triage verdict: keep \(eligibility low, blocked by adopt-now\)/u,
  );
  assert.deepEqual(adopted.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency very-low; step 0; verdict keep; blocked adopt-now\n\n${TRIAGE_STAMP}`,
  ]);
});

test('validateTriageFlags accepts --adopt-now under severity-tiered with both scores (#4436)', () => {
  assert.doesNotThrow(() =>
    validateTriageFlags({
      flags: triageFlags({ tier: 'low', urgency: 'very-low', adoptNow: true }),
      apply: false,
      body: ACCEPTED_FIXED,
      triageRecord: 'record',
      reviewPolicy: undefined,
      deferByUrgency: 'severity-tiered',
    }),
  );
});

/**
 * Run the compiled CLI with `--adopt-now` and assert a usage refusal that
 * names the flag, with nothing printed on stdout and no `gh` call (#4436).
 */
function assertAdoptNowRefused(
  cliArgs: string[],
  config: Record<string, unknown>,
  message: RegExp,
): void {
  const run = runTriageApply(cliArgs, config, triageReviewRows(0), {
    IDD_HELPER_ERROR_ENVELOPE: '1',
  });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(envelopeKind(run.stderr), 'usage');
  assert.match(run.stderr, /--adopt-now/u);
  assert.match(run.stderr, message);
  assert.equal(run.stdout, '');
  assert.deepEqual(run.calls, []);
  assert.deepEqual(run.posted, []);
}

test('--adopt-now is refused when deferByUrgency is not severity-tiered, with and without --lite (#4436, #4519)', () => {
  const args = [
    ...COMPUTE_ONLY_ARGS,
    '--tier',
    'low',
    '--urgency',
    'very-low',
    '--adopt-now',
  ];
  for (const cliArgs of [args, [...args, '--lite']]) {
    assertAdoptNowRefused(
      cliArgs,
      { critiqueLoop: { deferByUrgency: 'low-and-medium' } },
      /--adopt-now requires critiqueLoop\.deferByUrgency severity-tiered/u,
    );
  }
});

test('--adopt-now is refused with --path-b, with and without --lite, and the refusal names it (#4436, #4519)', () => {
  for (const cliArgs of [
    [...TRIAGE_THREAD_DRY_ARGS, '--path-b', '--adopt-now'],
    [...TRIAGE_THREAD_DRY_ARGS, '--path-b', '--lite', '--adopt-now'],
  ]) {
    assertAdoptNowRefused(
      cliArgs,
      TRIAGE_TIERED_CONFIG,
      /--path-b cannot be combined with .*--adopt-now/u,
    );
  }
});

test('--adopt-now is refused without both --tier and --urgency, with and without --lite (#4436, #4519)', () => {
  for (const lite of [[], ['--lite']]) {
    assertAdoptNowRefused(
      [...COMPUTE_ONLY_ARGS, '--tier', 'low', ...lite, '--adopt-now'],
      TRIAGE_TIERED_CONFIG,
      /--adopt-now requires --tier and --urgency/u,
    );
    assertAdoptNowRefused(
      [...COMPUTE_ONLY_ARGS, '--urgency', 'very-low', ...lite, '--adopt-now'],
      TRIAGE_TIERED_CONFIG,
      /--adopt-now requires --tier and --urgency/u,
    );
    // Compute-only mode needs a score flag, so the no-score case is a thread
    // dry run.
    assertAdoptNowRefused(
      [...TRIAGE_THREAD_DRY_ARGS, ...lite, '--adopt-now'],
      TRIAGE_TIERED_CONFIG,
      /--adopt-now requires --tier and --urgency/u,
    );
  }
});

// #4519: `--adopt-now` is accepted with `--lite`. Once one item is Accepted in
// an E5 pass, the push is certain under the lite profile too, so condition (d)
// applies the same way. `--lite` keeps the relax step at 0 and reads no review.

test('validateTriageFlags accepts --adopt-now with --lite under severity-tiered (#4519)', () => {
  assert.doesNotThrow(() =>
    validateTriageFlags({
      flags: triageFlags({
        tier: 'low',
        urgency: 'very-low',
        lite: true,
        adoptNow: true,
      }),
      apply: true,
      body: ACCEPTED_FIXED,
      triageRecord: 'enforce',
      reviewPolicy: undefined,
      deferByUrgency: 'severity-tiered',
    }),
  );
});

test('--lite --adopt-now turns a step-0 defer into keep blocked by adopt-now and reads no review (#4519)', () => {
  const adopted = buildTriage(throwingReviewsPort(), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'very-low',
    lite: true,
    adoptNow: true,
  });
  assert.deepEqual(adopted.verdict, {
    verdict: 'keep',
    eligibility: 'low',
    blocked: 'adopt-now',
  });
  assert.equal(
    adopted.body,
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency very-low; step 0; verdict keep; blocked adopt-now\n\n${TRIAGE_STAMP}`,
  );
  const plain = buildTriage(throwingReviewsPort(), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'very-low',
    lite: true,
  });
  assert.deepEqual(plain.verdict, {
    verdict: 'defer',
    eligibility: 'low',
    blocked: null,
  });
});

test('compute-only triage with --lite --adopt-now prints keep blocked by adopt-now and makes no gh call (#4519)', () => {
  const args = [
    ...COMPUTE_ONLY_ARGS,
    '--tier',
    'low',
    '--urgency',
    'very-low',
    '--lite',
  ];
  const adopted = runTriageApply(
    [...args, '--adopt-now'],
    TRIAGE_TIERED_CONFIG,
    triageReviewRows(9),
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(
    JSON.parse(adopted.stdout).triage,
    'Triage: tier low; urgency very-low; step 0; verdict keep; blocked adopt-now',
  );
  assertComputeOnlyCalls(adopted, []);

  const plain = runTriageApply(args, TRIAGE_TIERED_CONFIG, triageReviewRows(9));
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(
    JSON.parse(plain.stdout).triage,
    'Triage: tier low; urgency very-low; step 0; verdict defer',
  );
  assertComputeOnlyCalls(plain, []);
});

test('enforce posts an Accepted --lite reply with --adopt-now that it would refuse at defer (#4519)', () => {
  const args = [
    ...TRIAGE_THREAD_ARGS,
    '--tier',
    'low',
    '--urgency',
    'very-low',
    '--lite',
    '--body',
    ACCEPTED_FIXED,
  ];
  const refused = runTriageApply(
    args,
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(0),
  );
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(refused.posted, []);

  const adopted = runTriageApply(
    [...args, '--adopt-now'],
    TRIAGE_ENFORCE_CONFIG,
    triageReviewRows(0),
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.match(
    adopted.stderr,
    /triage verdict: keep \(eligibility low, blocked by adopt-now\)/u,
  );
  assert.deepEqual(adopted.posted, [
    `${ACCEPTED_FIXED}\nTriage: tier low; urgency very-low; step 0; verdict keep; blocked adopt-now\n\n${TRIAGE_STAMP}`,
  ]);
  assert.equal(
    adopted.calls.some((call) =>
      call.some((arg) => arg.includes('/pulls/42/reviews')),
    ),
    false,
  );
});

test('--lite --adopt-now leaves a keep verdict with its own reason: the matrix and a scope fence (#4519)', () => {
  const matrix = buildTriage(throwingReviewsPort(), ACCEPTED_FIXED, {
    tier: 'high',
    urgency: 'high',
    lite: true,
    adoptNow: true,
  });
  assert.deepEqual(matrix.verdict, {
    verdict: 'keep',
    eligibility: 'high',
    blocked: 'matrix',
  });
  assert.equal(
    matrix.body,
    `${ACCEPTED_FIXED}\nTriage: tier high; urgency high; step 0; verdict keep; blocked matrix\n\n${TRIAGE_STAMP}`,
  );
  const scoped = buildTriage(throwingReviewsPort(), ACCEPTED_FIXED, {
    tier: 'low',
    urgency: 'very-low',
    scopeFence: true,
    lite: true,
    adoptNow: true,
  });
  assert.deepEqual(scoped.verdict, {
    verdict: 'keep',
    eligibility: null,
    blocked: 'scope-fence',
  });
});

test('--help names --path-b but not --lite in the --adopt-now entry (#4519)', () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/resolve-review-thread.mjs'), '--help'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const entry = /^ {2}--adopt-now .*?(?=^ {2}--)/msu.exec(output)?.[0] ?? '';
  assert.match(entry, /--path-b/u);
  assert.doesNotMatch(entry, /--lite/u);
});

// #4750: the review-count cap (critiqueLoop.deferAllAfterRounds). Pure rows go
// through buildTriageReplyBody; the config and enforce rows go through the CLI.
function capTriageLine(body: string): string {
  const match = /Triage: [^\n]*/u.exec(body);
  assert.ok(match, `no Triage line in: ${body}`);
  return match[0];
}

test('the review-count cap defers at or above deferAllAfterRounds and keeps the rest (#4750)', () => {
  const line = (
    port: ProviderPort,
    flags: Partial<TriageFlags>,
    cap: number | undefined,
  ) =>
    capTriageLine(
      buildTriage(port, ACCEPTED_FIXED, flags, { deferAllAfterRounds: cap })
        .body,
    );
  // Unset: the cap is off and the matrix decides.
  assert.equal(
    line(triagePort(9), { tier: 'high', urgency: 'high' }, undefined),
    'Triage: tier high; urgency high; step 2; verdict keep; blocked matrix',
  );
  // Below the cap: unchanged, including adopt-now condition (d).
  assert.equal(
    line(
      triagePort(2),
      { tier: 'low', urgency: 'very-low', adoptNow: true },
      3,
    ),
    'Triage: tier low; urgency very-low; step 0; verdict keep; blocked adopt-now',
  );
  assert.equal(
    line(
      triagePort(2),
      { tier: 'low', urgency: 'medium', safetyClass: true },
      3,
    ),
    'Triage: tier low; urgency medium; step 0; safety; verdict defer',
  );
  // At the cap: every non-safety finding defers at step 0.
  assert.equal(
    line(triagePort(3), { tier: 'high', urgency: 'high' }, 3),
    'Triage: tier high; urgency high; step 0; verdict defer',
  );
  assert.equal(
    line(
      triagePort(3),
      { tier: 'low', urgency: 'very-low', adoptNow: true },
      3,
    ),
    'Triage: tier low; urgency very-low; step 0; verdict defer',
  );
  // At the cap the safety class is excepted at step 0.
  assert.equal(
    line(
      triagePort(3),
      { tier: 'low', urgency: 'medium', safetyClass: true },
      3,
    ),
    'Triage: tier low; urgency medium; step 0; safety; verdict keep; blocked safety-class',
  );
  const deferred = buildTriage(
    triagePort(3),
    ACCEPTED_FIXED,
    { tier: 'high', urgency: 'high' },
    { deferAllAfterRounds: 3 },
  );
  assert.equal(deferred.verdict?.eligibility, 'high');
  assert.equal(deferred.verdict?.blocked, null);
  // Existing exclusions keep their block reasons at the cap.
  assert.equal(
    line(
      triagePort(4),
      { tier: 'medium', urgency: 'high', scopeFence: true },
      3,
    ),
    'Triage: tier medium; urgency high; step 1; verdict keep; blocked scope-fence',
  );
  assert.equal(
    buildTriage(
      triagePort(4),
      ACCEPTED_FIXED,
      { tier: 'medium', urgency: 'high', scopeFence: true },
      { deferAllAfterRounds: 3 },
    ).verdict?.eligibility,
    null,
  );
  assert.equal(
    line(
      triagePort(4),
      { tier: 'high', urgency: 'high', acceptedMidFix: true },
      3,
    ),
    'Triage: tier high; urgency high; step 1; verdict keep; blocked accepted-mid-fix',
  );
  assert.equal(
    line(
      triagePort(4),
      { tier: 'high', urgency: 'high', protectedAuthority: true },
      3,
    ),
    'Triage: tier high; urgency high; step 1; verdict keep; blocked protected-authority',
  );
  // A cap of 2 applies from count 2 even though the relax thresholds are [4, 7].
  assert.equal(
    line(triagePort(2), { tier: 'high', urgency: 'high' }, 2),
    'Triage: tier high; urgency high; step 0; verdict defer',
  );
  // Convergence raises the relax step only; the cap is count-based and still defers.
  const converged = buildTriage(
    triagePort(3),
    ACCEPTED_FIXED,
    { tier: 'high', urgency: 'high', advisoryConverged: TRIAGE_HEAD },
    { deferAllAfterRounds: 3 },
  );
  assert.equal(converged.verdict?.verdict, 'defer');
  assert.equal(converged.record?.step, 1);
});

test('the review-count cap does not read reviews under --lite or other modes (#4750)', () => {
  const lite = buildTriage(
    throwingReviewsPort(),
    ACCEPTED_FIXED,
    { tier: 'high', urgency: 'high', lite: true },
    { deferAllAfterRounds: 3 },
  );
  assert.equal(
    capTriageLine(lite.body),
    'Triage: tier high; urgency high; step 0; verdict keep; blocked matrix',
  );
  const lowAndMedium = buildTriage(
    throwingReviewsPort(),
    ACCEPTED_FIXED,
    { tier: 'high', urgency: 'high' },
    { deferByUrgency: 'low-and-medium', deferAllAfterRounds: 3 },
  );
  assert.equal(lowAndMedium.verdict, null);
  assert.equal(
    capTriageLine(lowAndMedium.body),
    'Triage: tier high; urgency high; step 0',
  );
});

test('compute-only triage applies the cap from config and ignores invalid values (#4750)', () => {
  for (const value of [0, -1, 1.5, '3', null]) {
    const run = runTriageApply(
      [...COMPUTE_ONLY_ARGS, '--tier', 'high', '--urgency', 'high'],
      {
        critiqueLoop: {
          ...TRIAGE_TIERED_CONFIG.critiqueLoop,
          deferAllAfterRounds: value,
        },
      },
      triageReviewRows(5),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      JSON.parse(run.stdout).triage,
      'Triage: tier high; urgency high; step 1; verdict keep; blocked matrix',
      `invalid deferAllAfterRounds ${JSON.stringify(value)} must leave the cap off`,
    );
  }
  const capped = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'high', '--urgency', 'high'],
    {
      critiqueLoop: {
        ...TRIAGE_TIERED_CONFIG.critiqueLoop,
        deferAllAfterRounds: 3,
      },
    },
    triageReviewRows(3),
  );
  assert.equal(capped.status, 0, capped.stderr);
  assert.equal(
    JSON.parse(capped.stdout).triage,
    'Triage: tier high; urgency high; step 0; verdict defer',
  );
  assertComputeOnlyCalls(capped, ['/pulls/42/reviews']);
  const lite = runTriageApply(
    [...COMPUTE_ONLY_ARGS, '--tier', 'high', '--urgency', 'high', '--lite'],
    {
      critiqueLoop: {
        ...TRIAGE_TIERED_CONFIG.critiqueLoop,
        deferAllAfterRounds: 3,
      },
    },
    triageReviewRows(7),
  );
  assert.equal(lite.status, 0, lite.stderr);
  assert.equal(
    JSON.parse(lite.stdout).triage,
    'Triage: tier high; urgency high; step 0; verdict keep; blocked matrix',
  );
  assertComputeOnlyCalls(lite, []);
});

test('enforce refuses a capped defer without --override and posts it with one (#4750)', () => {
  const refused = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      ACCEPTED_FIXED,
    ],
    {
      critiqueLoop: {
        ...TRIAGE_ENFORCE_CONFIG.critiqueLoop,
        deferAllAfterRounds: 3,
      },
    },
    triageReviewRows(3),
  );
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(
    refused.stderr,
    /triage verdict: defer \(eligibility high, blocked by none\); pass --override "<reason>" to post anyway/u,
  );
  assert.deepEqual(refused.posted, []);
  assertNoWrite(refused);
  const overridden = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      ACCEPTED_FIXED,
      '--override',
      'capped at three reviews',
    ],
    {
      critiqueLoop: {
        ...TRIAGE_ENFORCE_CONFIG.critiqueLoop,
        deferAllAfterRounds: 3,
      },
    },
    triageReviewRows(3),
  );
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(overridden.posted.length, 1);
  assert.match(overridden.posted[0], /; override: capped at three reviews$/mu);
});

test('enforce judges the cap at post time, so a count that reaches the cap before the post is refused (#4750)', () => {
  const run = runTriageApply(
    [
      ...TRIAGE_THREAD_ARGS,
      '--tier',
      'high',
      '--urgency',
      'high',
      '--body',
      ACCEPTED_FIXED,
    ],
    {
      critiqueLoop: {
        ...TRIAGE_ENFORCE_CONFIG.critiqueLoop,
        deferAllAfterRounds: 3,
      },
    },
    triageReviewRows(2),
    {
      // The early read sees two reviews (keep at step 0). The read right before
      // the post sees three, which reaches the cap, so the post must be refused.
      TRIAGE_REVIEW_SEQUENCE: JSON.stringify([
        triageReviewRows(2),
        triageReviewRows(3),
      ]),
    },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /triage verdict: defer \(eligibility high, blocked by none\)/u,
  );
  assert.deepEqual(run.posted, []);
  assertNoWrite(run);
});
