import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CollaboratorPermissionCache } from '../src/scripts/collaborator-permission.mts';
import { resolveTrustedCollaboratorMarkerLogins } from '../src/scripts/collaborator-permission.mts';
import {
  buildTrustedMarkerLogins,
  runHandoff,
  SAME_SUCCESSOR_WARNING,
} from '../src/scripts/force-handoff.mts';

type RunHandoffOptions = NonNullable<Parameters<typeof runHandoff>[0]>;

const CLAIM_BODY = [
  '<!-- claimed-by: github-copilot-cli-old claim-497-test supersedes: none 2026-05-13T10:00:00Z branch: issue/497-feat-force-handoff-add-interactive -->',
  '',
  '_github-copilot-cli-old: issue claim — IDD automation marker. Do not edit._',
].join('\n');

const ISSUE_COMMENTS = [
  {
    body: CLAIM_BODY,
    created_at: '2026-05-13T10:00:00Z',
    user: { login: 'kurone-kito' },
  },
];

const TRUSTED_LOGINS = ['kurone-kito', 'github-copilot-cli-old'];

function makeCommonOpts(overrides: RunHandoffOptions = {}): RunHandoffOptions {
  return {
    isTTY: true,
    mode: 'human-gated',
    repo: 'kurone-kito/idd-skill',
    forcedBy: 'kurone-kito',
    trustedMarkerLogins: TRUSTED_LOGINS,
    isAuthorizedForcedHandoff: (actor) => actor === 'kurone-kito',
    fetchIssueComments: async () => ISSUE_COMMENTS,
    fetchLinkedPrs: async () => [],
    postComment: async (_issueNum, body) => ({
      html_url:
        'https://github.com/kurone-kito/idd-skill/issues/497#issuecomment-test',
      body,
    }),
    ...overrides,
  };
}

test('runHandoff throws when not running in a TTY', async () => {
  await assert.rejects(
    () => runHandoff({ isTTY: false }),
    (err) => {
      const message = (err as Error).message;
      assert.ok(
        message.includes('interactive TTY'),
        `unexpected message: ${message}`,
      );
      return true;
    },
  );
});

test('runHandoff completes issue-only flow without PR prompt', async () => {
  const responses = ['497', '', 'y'];
  let callIndex = 0;
  const postedBodies: string[] = [];

  const result = await runHandoff(
    makeCommonOpts({
      prompt: async () => responses[callIndex++],
      postComment: async (_issueNum, body) => {
        postedBodies.push(body);
        return {
          html_url:
            'https://github.com/kurone-kito/idd-skill/issues/497#issuecomment-1',
        };
      },
    }),
  );

  assert.equal(result.posted, true, 'should post the comment');
  assert.equal(result.contextScope, 'issue-only');
  assert.ok(
    result.commentUrl?.includes('issuecomment'),
    'should return comment URL',
  );
  assert.ok(postedBodies.length === 1, 'should post exactly one comment');
  assert.ok(
    postedBodies[0].includes('issue-only'),
    'marker body should contain context scope',
  );
  assert.ok(
    postedBodies[0].includes('kurone-kito'),
    'marker body should contain forcedBy',
  );
  assert.equal(
    callIndex,
    3,
    'should ask for issue number, successor agent-id, and confirmation',
  );
});

test('runHandoff completes issue-plus-pr flow with PR prompt', async () => {
  const responses = ['497', '501', '', 'y'];
  let callIndex = 0;
  const postedBodies: string[] = [];

  const linkedPrs = [
    {
      number: 501,
      headRefName: 'issue/497-feat-force-handoff-add-interactive',
    },
  ];

  const result = await runHandoff(
    makeCommonOpts({
      fetchLinkedPrs: async () => linkedPrs,
      prompt: async () => responses[callIndex++],
      postComment: async (_issueNum, body) => {
        postedBodies.push(body);
        return {
          html_url:
            'https://github.com/kurone-kito/idd-skill/issues/497#issuecomment-2',
        };
      },
    }),
  );

  assert.equal(result.posted, true, 'should post the comment');
  assert.equal(result.contextScope, 'issue-plus-pr');
  assert.ok(
    postedBodies[0].includes('issue-plus-pr'),
    'marker body should contain issue-plus-pr scope',
  );
  assert.ok(
    postedBodies[0].includes('"linked-pr":"501"'),
    'marker body should include linked PR',
  );
  assert.equal(
    callIndex,
    4,
    'should ask for issue number, PR number, successor agent-id, and confirmation',
  );
});

test('runHandoff returns posted: false when operator declines confirmation', async () => {
  const responses = ['497', '', 'N'];
  let callIndex = 0;
  let postCalled = false;

  const result = await runHandoff(
    makeCommonOpts({
      prompt: async () => responses[callIndex++],
      postComment: async () => {
        postCalled = true;
        return { html_url: 'https://example.com' };
      },
    }),
  );

  assert.equal(result.posted, false, 'should not post when operator declines');
  assert.equal(
    postCalled,
    false,
    'postComment should not be called on refusal',
  );
});

test('runHandoff reports posted: true and returns successorIds and commentUrl', async () => {
  const responses = ['497', '', 'y'];
  let callIndex = 0;

  const result = await runHandoff(
    makeCommonOpts({
      prompt: async () => responses[callIndex++],
    }),
  );

  assert.equal(result.posted, true);
  assert.ok(result.commentUrl, 'should return a comment URL');
  assert.ok(
    result.successorIds?.newAgentId,
    'should return successor newAgentId',
  );
  assert.ok(
    result.successorIds?.newClaimId,
    'should return successor newClaimId',
  );
  assert.match(
    result.successorIds.newClaimId,
    /^claim-[0-9a-f]{16}$/,
    'claim ID should match expected format',
  );
});

// --- #3195: interactive successor agent-id prompt -------------------------
//
// Field feedback (gist round 37) reported that idd-force-handoff's
// interactive flow never lets the operator choose the successor's
// agent-id -- it silently reuses the displaced agent's own identity every
// time, with no warning that the "successor" is the same session that
// already failed to finish the claim. These tests cover: leaving the
// prompt blank (same-agent default, warning shown), entering a distinct
// value (that value flows through, no warning), explicitly re-entering the
// displaced agent's own id verbatim (still the same-successor warning, per
// the issue's own "explicit re-entry" clause), and the issue-plus-pr flow
// combined with a distinct successor (the PR-number selection must survive
// the later successor-agent-id prompt).

test('runHandoff blank successor-agent-id prompt keeps the displaced agent-id and prints the same-successor warning', async () => {
  const responses = ['497', '', 'y'];
  let callIndex = 0;
  const postedBodies: string[] = [];
  let output = '';

  const result = await runHandoff(
    makeCommonOpts({
      prompt: async () => responses[callIndex++],
      write: (chunk) => {
        output += chunk;
      },
      postComment: async (_issueNum, body) => {
        postedBodies.push(body);
        return {
          html_url:
            'https://github.com/kurone-kito/idd-skill/issues/497#issuecomment-3',
        };
      },
    }),
  );

  assert.equal(result.posted, true, 'should post the comment');
  assert.equal(
    result.successorIds?.newAgentId,
    'github-copilot-cli-old',
    'blank input should keep the displaced agent-id as successor',
  );
  assert.ok(
    postedBodies[0].includes('"new-agent-id":"github-copilot-cli-old"'),
    'marker body should name the displaced agent-id as successor',
  );
  assert.ok(
    output.includes(SAME_SUCCESSOR_WARNING),
    'should print the same-successor warning before confirmation',
  );
});

test('runHandoff explicit re-entry of the displaced agent-id also prints the same-successor warning', async () => {
  const responses = ['497', 'github-copilot-cli-old', 'y'];
  let callIndex = 0;
  const postedBodies: string[] = [];
  let output = '';

  const result = await runHandoff(
    makeCommonOpts({
      prompt: async () => responses[callIndex++],
      write: (chunk) => {
        output += chunk;
      },
      postComment: async (_issueNum, body) => {
        postedBodies.push(body);
        return {
          html_url:
            'https://github.com/kurone-kito/idd-skill/issues/497#issuecomment-3b',
        };
      },
    }),
  );

  assert.equal(result.posted, true, 'should post the comment');
  assert.equal(
    result.successorIds?.newAgentId,
    'github-copilot-cli-old',
    'explicitly re-entered value should still be the displaced agent-id',
  );
  assert.ok(
    output.includes(SAME_SUCCESSOR_WARNING),
    'should print the same-successor warning even on an explicit re-entry',
  );
});

test('runHandoff entered successor-agent-id flows through to the posted marker without the warning', async () => {
  const responses = ['497', 'distinct-successor-id', 'y'];
  let callIndex = 0;
  const postedBodies: string[] = [];
  let output = '';

  const result = await runHandoff(
    makeCommonOpts({
      prompt: async () => responses[callIndex++],
      write: (chunk) => {
        output += chunk;
      },
      postComment: async (_issueNum, body) => {
        postedBodies.push(body);
        return {
          html_url:
            'https://github.com/kurone-kito/idd-skill/issues/497#issuecomment-4',
        };
      },
    }),
  );

  assert.equal(result.posted, true, 'should post the comment');
  assert.equal(
    result.successorIds?.newAgentId,
    'distinct-successor-id',
    'entered value should become the successor agent-id',
  );
  assert.ok(
    postedBodies[0].includes('"new-agent-id":"distinct-successor-id"'),
    'marker body should name the entered value as successor',
  );
  assert.ok(
    output.includes('Marker preview:'),
    'should still print the plan preview (positive anchor for the negative check below)',
  );
  assert.ok(
    !output.includes(SAME_SUCCESSOR_WARNING),
    'should not print the same-successor warning when successor differs',
  );
});

test('runHandoff preserves the chosen PR number when a distinct successor agent-id is also entered', async () => {
  const responses = ['497', '501', 'distinct-successor-id', 'y'];
  let callIndex = 0;
  const postedBodies: string[] = [];

  const linkedPrs = [
    {
      number: 501,
      headRefName: 'issue/497-feat-force-handoff-add-interactive',
    },
  ];

  const result = await runHandoff(
    makeCommonOpts({
      fetchLinkedPrs: async () => linkedPrs,
      prompt: async () => responses[callIndex++],
      postComment: async (_issueNum, body) => {
        postedBodies.push(body);
        return {
          html_url:
            'https://github.com/kurone-kito/idd-skill/issues/497#issuecomment-5',
        };
      },
    }),
  );

  assert.equal(result.posted, true, 'should post the comment');
  assert.equal(result.contextScope, 'issue-plus-pr');
  assert.equal(
    result.successorIds?.newAgentId,
    'distinct-successor-id',
    'entered successor should still apply in the issue-plus-pr flow',
  );
  assert.ok(
    postedBodies[0].includes('"linked-pr":"501"'),
    'marker body should still include the previously chosen PR number',
  );
  assert.ok(
    postedBodies[0].includes('"new-agent-id":"distinct-successor-id"'),
    'marker body should include the entered successor agent-id',
  );
  assert.equal(
    callIndex,
    4,
    'should ask for issue number, PR number, successor agent-id, and confirmation',
  );
});

// --- #1693: buildTrustedMarkerLogins trusts only operational-marker -------
// authors, matching the sibling filter ------------------------------------
//
// Previously buildTrustedMarkerLogins permission-checked every unique
// issue-comment author (once collaborator marker trust is enabled),
// over-trusting an ordinary write+ commenter who never posted an
// operational marker. It now delegates that widening step to
// resolveTrustedCollaboratorMarkerLogins (collaborator-permission.mts) --
// the same marker-authors-first filter pre-merge-readiness.mts and
// advisory-convergence.mts already use. This test proves parity by calling
// both with the identical comment/permission inputs and asserting matching
// membership, rather than trusting that "delegates to" claim by
// inspection alone.

const MARKER_AUTHORS_FIRST_BODY = [
  '<!-- claimed-by: some-agent claim-marker-parity supersedes: none 2026-05-13T10:00:00Z branch: issue/9001-parity -->',
  '',
  '_some-agent: issue claim — IDD automation marker. Do not edit._',
].join('\n');

test('buildTrustedMarkerLogins trusts only operational-marker-shaped comment authors when collaborator marker trust is enabled', () => {
  const previousEnv = process.env.IDD_TRUST_COLLABORATOR_MARKERS;
  process.env.IDD_TRUST_COLLABORATOR_MARKERS = 'true';
  try {
    const comments = [
      { body: MARKER_AUTHORS_FIRST_BODY, user: { login: 'marker-author' } },
      {
        body: 'just an ordinary comment',
        user: { login: 'ordinary-commenter' },
      },
    ];
    const seed: CollaboratorPermissionCache = new Map([
      ['o/r:marker-author', { permission: 'write', roleName: 'write' }],
      ['o/r:ordinary-commenter', { permission: 'write', roleName: 'write' }],
    ]);

    const trusted = buildTrustedMarkerLogins(
      'o',
      'r',
      'viewer',
      comments,
      new Map(seed),
    );
    const siblingFilterResult = resolveTrustedCollaboratorMarkerLogins(
      'o',
      'r',
      comments,
      { cache: new Map(seed) },
    );

    // Parity, per-login: force-handoff's decision for each comment author
    // exactly matches the sibling filter's own decision for that same
    // author (comparing whole sets directly would also pick up
    // config-sourced base actors this repo's own .github/idd/config.json
    // declares, which are unrelated to the marker-shape filter under
    // test).
    for (const login of ['marker-author', 'ordinary-commenter']) {
      assert.equal(
        trusted.has(login),
        siblingFilterResult.includes(login),
        `parity mismatch for ${login}`,
      );
    }
    assert.ok(trusted.has('marker-author'));
    assert.ok(!trusted.has('ordinary-commenter'));
  } finally {
    if (previousEnv === undefined) {
      delete process.env.IDD_TRUST_COLLABORATOR_MARKERS;
    } else {
      process.env.IDD_TRUST_COLLABORATOR_MARKERS = previousEnv;
    }
  }
});

test('buildTrustedMarkerLogins leaves comment authors untouched when collaborator marker trust is disabled', () => {
  const previousEnv = process.env.IDD_TRUST_COLLABORATOR_MARKERS;
  delete process.env.IDD_TRUST_COLLABORATOR_MARKERS;
  try {
    const trusted = buildTrustedMarkerLogins('o', 'r', 'viewer', [
      { body: MARKER_AUTHORS_FIRST_BODY, user: { login: 'marker-author' } },
    ]);
    assert.ok(!trusted.has('marker-author'));
  } finally {
    if (previousEnv === undefined) {
      delete process.env.IDD_TRUST_COLLABORATOR_MARKERS;
    } else {
      process.env.IDD_TRUST_COLLABORATOR_MARKERS = previousEnv;
    }
  }
});
