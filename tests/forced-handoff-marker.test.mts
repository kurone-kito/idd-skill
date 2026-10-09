import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

import type { CollaboratorPermissionCache } from '../src/scripts/collaborator-permission.mts';
import { resolveTrustedCollaboratorMarkerLogins } from '../src/scripts/collaborator-permission.mts';
import {
  buildTrustedMarkerLogins,
  currentIsoTimestamp,
  generateSuccessorIds,
  main,
  parseArgs,
  parsePositiveInteger,
  planHandoff as planHandoffImpl,
  resolveHelperActiveClaim as resolveHelperActiveClaimImpl,
} from '../src/scripts/forced-handoff-marker.mts';
import {
  applyClaimEvent,
  DEFAULT_STALE_AGE_MS,
  normalizeForcedHandoffPayload,
  operationalMarkerPrefix,
  operationalMarkerPrefixByStart,
  parseForcedHandoffComment,
  renderForcedHandoffComment,
  renderForcedHandoffConsentNote,
} from '../src/scripts/protocol-helpers.mts';
import { type FixtureGhRule, useFixtureGh } from './test-utils.mts';

// #3745: `main` below reads GitHub (the issue comments, their edit state, the
// viewer and the `--forced-by` actor's permission). Serve those reads from the
// fixture `gh` so a run never depends on the operator's login, and so an API
// failure fails a test instead of being swallowed. The file's `main` runs use
// a sandbox cwd without a load-control config, so no `pinLoadControlOff` here.
const fixtureGh = useFixtureGh({ viewer: 'kurone-kito' });

const withUneditedClaimState = <T extends { lastEditedAt?: string | null }>(
  comments: T[],
): (T & { lastEditedAt: string | null })[] =>
  comments.map((comment) => ({
    ...comment,
    lastEditedAt: comment.lastEditedAt ?? null,
  }));

const resolveHelperActiveClaim = (
  comments: Parameters<typeof resolveHelperActiveClaimImpl>[0],
  ...rest: Tail<Parameters<typeof resolveHelperActiveClaimImpl>>
) => resolveHelperActiveClaimImpl(withUneditedClaimState(comments), ...rest);

const planHandoff = (
  comments: Parameters<typeof planHandoffImpl>[0],
  ...rest: Tail<Parameters<typeof planHandoffImpl>>
) => planHandoffImpl(withUneditedClaimState(comments), ...rest);

type Tail<T extends readonly unknown[]> = T extends readonly [
  unknown,
  ...infer R,
]
  ? R
  : never;

const activeClaim = {
  agentId: 'github-copilot-cli-old',
  claimId: 'claim-20260512T090000Z-337-old',
  supersedes: 'none',
  branch: 'issue/337-feat-protocol-add-auditable-forced',
  createdAt: '2026-05-12T09:00:00Z',
};

const payload = {
  oldAgentId: activeClaim.agentId,
  oldClaimId: activeClaim.claimId,
  newAgentId: 'github-copilot-cli-new',
  newClaimId: 'claim-20260512T110000Z-337-new',
  branch: activeClaim.branch,
  linkedPr: '341',
  forcedBy: 'kurone-kito',
  reason: 'operator-approved-recovery',
  timestamp: '2026-05-12T11:00:00Z',
  contextScope: 'issue-plus-pr',
};

test('forced handoff marker render/parse round-trips through the normalized payload', () => {
  const body = renderForcedHandoffComment(payload);
  const parsed = parseForcedHandoffComment(body, '2026-05-12T11:00:05Z');

  assert.deepEqual(parsed, {
    ...payload,
    createdAt: '2026-05-12T11:00:05Z',
  });
});

test('forced handoff parsing accepts flexible marker spacing and casing', () => {
  const body = [
    '<!--   FORCED-HANDOFF: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","linked-pr":"341","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-plus-pr"} -->',
    '',
    'Forced handoff approved by kurone-kito. I verified that the current',
    'owning session or agent is unavailable. This transfers ownership away',
    'from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced` for PR #341.',
    'If the prior session resumes, it must stop immediately and must not',
    'push, comment, resolve review state, or merge until a maintainer',
    'reassigns ownership.',
  ].join('\n');

  assert.deepEqual(parseForcedHandoffComment(body, '2026-05-12T11:00:05Z'), {
    ...payload,
    createdAt: '2026-05-12T11:00:05Z',
  });
});

test('forced handoff parsing accepts leading whitespace before marker', () => {
  const body = [
    '   ',
    '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","linked-pr":"341","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-plus-pr"} -->',
    '',
    'Forced handoff approved by kurone-kito. I verified that the current',
    'owning session or agent is unavailable. This transfers ownership away',
    'from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced` for PR #341.',
    'If the prior session resumes, it must stop immediately and must not',
    'push, comment, resolve review state, or merge until a maintainer',
    'reassigns ownership.',
  ].join('\n');

  assert.deepEqual(parseForcedHandoffComment(body, '2026-05-12T11:00:05Z'), {
    ...payload,
    createdAt: '2026-05-12T11:00:05Z',
  });
  assert.equal(operationalMarkerPrefix(body), '<!-- forced-handoff:');
});

test('forced handoff rejects markers without visible consent text', () => {
  const body = [
    '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-only"} -->',
    '',
    '<!-- hidden only -->',
  ].join('\n');

  assert.equal(parseForcedHandoffComment(body, '2026-05-12T11:00:05Z'), null);
});

test('forced handoff rejects notes hidden by unterminated html comment openers', () => {
  const body = [
    '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-only"} -->',
    '',
    '<!-- hidden',
  ].join('\n');

  assert.equal(parseForcedHandoffComment(body, '2026-05-12T11:00:05Z'), null);
});

test('forced handoff start-prefix detection matches flexible marker spelling', () => {
  assert.equal(
    operationalMarkerPrefixByStart(`  ${renderForcedHandoffComment(payload)}`),
    '<!-- forced-handoff:',
  );
  assert.equal(
    operationalMarkerPrefixByStart(
      '  <!--   FORCED-HANDOFF: {"old-agent-id":"a"} -->',
    ),
    null,
  );
});

test('forced handoff normalization omits createdAt when comment metadata is unavailable', () => {
  const normalized = normalizeForcedHandoffPayload(payload);

  assert.deepEqual(normalized, payload);
});

test('forced handoff helper timestamps stay on whole seconds', () => {
  assert.match(currentIsoTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('forced handoff helper rejects malformed positive integers', () => {
  assert.equal(parsePositiveInteger('123', '--issue'), 123);
  assert.throws(
    () => parsePositiveInteger('123abc', '--issue'),
    /invalid --issue value: 123abc/,
  );
});

test('forced handoff helper reports missing numeric flag values clearly', () => {
  // #1450: parseArgs now goes through the shared cli-args.mts wrapper,
  // which re-wraps Node's native parseArgs error into this repository's
  // established idiom ("missing value for argument: --x") -- see
  // cli-args.mts's module header. Same shape the branch-name.mjs /
  // ci-wait-policy.mjs / advisory-convergence.mjs pilots already use.
  assert.throws(() => main(['--issue']), /missing value for argument: --issue/);
  assert.throws(
    () => main(['--issue', '337', '--pr']),
    /missing value for argument: --pr/,
  );
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --forced-by would greedily accept '--plan' as its literal
  // value, silently leaving --plan unset (the #1082 gap this migration
  // closes structurally for this helper).
  assert.throws(() => parseArgs(['--forced-by', '--plan']));
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: an absent --issue/--pr stays undefined, not a throw', () => {
  const args = parseArgs(['--forced-by', 'kurone-kito']);
  assert.equal(args.issueNumber, undefined);
  assert.equal(args.prNumber, undefined);
});

test('forced handoff helper validates --repo format before API calls', () => {
  assert.throws(
    () =>
      main([
        '--issue',
        '337',
        '--new-agent-id',
        'github-copilot-cli-new',
        '--new-claim-id',
        'claim-20260512T110000Z-337-new',
        '--forced-by',
        'kurone-kito',
        '--reason',
        'operator-approved-recovery',
        '--repo',
        'invalid-repo-format',
      ]),
    /invalid --repo value: invalid-repo-format \(expected owner\/name\)/,
  );
});

test('forced handoff helper replays prior handoffs when resolving the active claim', () => {
  const trustedLogins = [
    'github-copilot-cli-old',
    'github-copilot-cli-mid',
    'github-copilot-cli-new',
    'kurone-kito',
  ];
  const claimBody = [
    '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
    '',
    '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
  ].join('\n');
  const firstHandoff = renderForcedHandoffComment({
    ...payload,
    newAgentId: 'github-copilot-cli-mid',
    newClaimId: 'claim-20260512T110000Z-337-mid',
  });
  const secondHandoff = renderForcedHandoffComment({
    ...payload,
    oldAgentId: 'github-copilot-cli-mid',
    oldClaimId: 'claim-20260512T110000Z-337-mid',
    newAgentId: 'github-copilot-cli-new',
    newClaimId: 'claim-20260512T120000Z-337-next',
    timestamp: '2026-05-12T12:00:00Z',
  });

  const active = resolveHelperActiveClaim(
    [
      {
        body: claimBody,
        created_at: '2026-05-12T09:00:00Z',
        user: { login: 'github-copilot-cli-old' },
      },
      {
        body: firstHandoff,
        created_at: '2026-05-12T11:00:05Z',
        user: { login: 'github-copilot-cli-mid' },
      },
      {
        body: secondHandoff,
        created_at: '2026-05-12T12:00:05Z',
        user: { login: 'github-copilot-cli-new' },
      },
    ],
    trustedLogins,
    {
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
      staleAgeMs: DEFAULT_STALE_AGE_MS,
    },
  );

  assert.deepEqual(active, {
    agentId: 'github-copilot-cli-new',
    claimId: 'claim-20260512T120000Z-337-next',
    supersedes: 'claim-20260512T110000Z-337-mid',
    branch: 'issue/337-feat-protocol-add-auditable-forced',
    createdAt: '2026-05-12T12:00:05Z',
  });
});

// #3270: WG_OLD_CLAIM is created at 2026-05-12T09:00:00Z; the plain
// (non-forced-handoff) takeover below lands 20h later
// (2026-05-13T05:00:00Z) -- squarely in the 18-24h gap the issue describes:
// stale under an 18h configured age, not stale under the old hardcoded 24h
// `summarizeClaimValidation` silently fell back to when
// `resolveHelperActiveClaim` omitted `staleAgeMs`.
test('resolveHelperActiveClaim (#3270) recognizes a takeover claim inside a configured 18h staleAge', () => {
  const trustedLogins = ['cli-old', 'cli-new'];
  const oldClaim = {
    body: [
      '<!-- claimed-by: cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat -->',
      '',
      '_cli-old: issue claim — IDD automation marker._',
    ].join('\n'),
    created_at: '2026-05-12T09:00:00Z',
    user: { login: 'cli-old' },
  };
  const takeover = {
    body: [
      '<!-- claimed-by: cli-new claim-20260513T050000Z-337-new supersedes: claim-20260512T090000Z-337-old 2026-05-13T05:00:00Z branch: issue/337-feat -->',
      '',
      '_cli-new: issue claim — IDD automation marker._',
    ].join('\n'),
    created_at: '2026-05-13T05:00:00Z',
    user: { login: 'cli-new' },
  };

  const withConfiguredWindow = resolveHelperActiveClaim(
    [oldClaim, takeover],
    trustedLogins,
    { staleAgeMs: 18 * 60 * 60 * 1000 },
  );
  assert.equal(withConfiguredWindow?.claimId, 'claim-20260513T050000Z-337-new');

  const withDefaultWindow = resolveHelperActiveClaim(
    [oldClaim, takeover],
    trustedLogins,
    { staleAgeMs: 24 * 60 * 60 * 1000 },
  );
  assert.equal(withDefaultWindow?.claimId, 'claim-20260512T090000Z-337-old');
});

test('forced handoff helper keeps PR-scoped active claim when issue-only handoff exists', () => {
  const trustedLogins = [
    'github-copilot-cli-old',
    'github-copilot-cli-mid',
    'github-copilot-cli-new',
    'kurone-kito',
  ];
  const claimBody = [
    '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
    '',
    '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
  ].join('\n');
  const issueOnlyHandoff = renderForcedHandoffComment({
    oldAgentId: 'github-copilot-cli-old',
    oldClaimId: 'claim-20260512T090000Z-337-old',
    newAgentId: 'github-copilot-cli-mid',
    newClaimId: 'claim-20260512T110000Z-337-mid',
    branch: 'issue/337-feat-protocol-add-auditable-forced',
    forcedBy: 'kurone-kito',
    reason: 'operator-approved-recovery',
    timestamp: '2026-05-12T11:00:00Z',
    contextScope: 'issue-only',
  });

  const active = resolveHelperActiveClaim(
    [
      {
        body: claimBody,
        created_at: '2026-05-12T09:00:00Z',
        user: { login: 'github-copilot-cli-old' },
      },
      {
        body: issueOnlyHandoff,
        created_at: '2026-05-12T11:00:05Z',
        user: { login: 'github-copilot-cli-mid' },
      },
    ],
    trustedLogins,
    {
      expectedLinkedPrs: [
        '359',
        'https://github.com/kurone-kito/idd-skill/pull/359',
      ],
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
      staleAgeMs: DEFAULT_STALE_AGE_MS,
    },
  );

  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
  assert.equal(active?.agentId, 'github-copilot-cli-old');
});

// #3675: the merge-side Part B allowance (#1058) for a PR-scoped resolution.
function resolveIssueOnlyHandoffForPr(prFirstCommitAt?: string | null) {
  const claimBody = [
    '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
    '',
    '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
  ].join('\n');
  const issueOnlyHandoff = renderForcedHandoffComment({
    oldAgentId: 'github-copilot-cli-old',
    oldClaimId: 'claim-20260512T090000Z-337-old',
    newAgentId: 'github-copilot-cli-mid',
    newClaimId: 'claim-20260512T110000Z-337-mid',
    branch: 'issue/337-feat-protocol-add-auditable-forced',
    forcedBy: 'kurone-kito',
    reason: 'operator-approved-recovery',
    timestamp: '2026-05-12T11:00:00Z',
    contextScope: 'issue-only',
  });
  return resolveHelperActiveClaim(
    [
      {
        body: claimBody,
        created_at: '2026-05-12T09:00:00Z',
        user: { login: 'github-copilot-cli-old' },
      },
      {
        body: issueOnlyHandoff,
        created_at: '2026-05-12T11:00:05Z',
        user: { login: 'kurone-kito' },
      },
    ],
    ['github-copilot-cli-old', 'kurone-kito'],
    {
      expectedLinkedPrs: ['359'],
      ...(prFirstCommitAt === undefined ? {} : { prFirstCommitAt }),
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
      staleAgeMs: DEFAULT_STALE_AGE_MS,
    },
  );
}

test('resolveHelperActiveClaim accepts an issue-only handoff that predates the PR first commit (#3675)', () => {
  const active = resolveIssueOnlyHandoffForPr('2026-05-12T12:00:00Z');

  assert.equal(active?.claimId, 'claim-20260512T110000Z-337-mid');
  assert.equal(active?.agentId, 'github-copilot-cli-mid');
});

test('resolveHelperActiveClaim rejects an issue-only handoff posted after the PR first commit (#3675)', () => {
  const active = resolveIssueOnlyHandoffForPr('2026-05-12T10:00:00Z');

  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
});

test('resolveHelperActiveClaim keeps rejecting an issue-only handoff for a PR when prFirstCommitAt is omitted or null (#3675)', () => {
  for (const prFirstCommitAt of [undefined, null]) {
    const active = resolveIssueOnlyHandoffForPr(prFirstCommitAt);

    assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
  }
});

test('forced handoff helper refuses output when forced-handoff mode is disabled', () => {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-forced-handoff-marker-'));
  mkdirSync(join(sandbox, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(sandbox, '.github', 'idd', 'config.json'),
    JSON.stringify({ forcedHandoff: 'disabled' }),
  );

  process.chdir(sandbox);
  try {
    assert.throws(
      () =>
        main([
          '--issue',
          '337',
          '--new-agent-id',
          'github-copilot-cli-new',
          '--new-claim-id',
          'claim-20260512T110000Z-337-new',
          '--forced-by',
          'kurone-kito',
          '--reason',
          'operator-approved-recovery',
          '--repo',
          'kurone-kito/idd-skill',
        ]),
      /forced-handoff mode is not human-gated; marker generation is disabled/,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test('forced handoff markers are ignored by default when the feature is not enabled', () => {
  const body = renderForcedHandoffComment(payload);
  const next = applyClaimEvent(activeClaim, {
    author: { login: 'kurone-kito' },
    body,
    createdAt: '2026-05-12T11:00:05Z',
    lastEditedAt: null,
  });

  assert.deepEqual(next, activeClaim);
});

test('forced handoff transfers the active claim when trusted, enabled, and authorized', () => {
  const body = renderForcedHandoffComment(payload);
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: 'trusted-relay[bot]' },
      body,
      createdAt: '2026-05-12T11:00:05Z',
      lastEditedAt: null,
    },
    {
      isTrustedAuthor: (login) => login === 'trusted-relay[bot]',
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );

  assert.deepEqual(next, {
    agentId: 'github-copilot-cli-new',
    claimId: 'claim-20260512T110000Z-337-new',
    supersedes: 'claim-20260512T090000Z-337-old',
    branch: 'issue/337-feat-protocol-add-auditable-forced',
    createdAt: '2026-05-12T11:00:05Z',
  });
});

test('forced handoff falls back to the active claim timestamp when event metadata is missing', () => {
  const body = renderForcedHandoffComment(payload);
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: 'trusted-relay[bot]' },
      body,
      createdAt: '',
      lastEditedAt: null,
    },
    {
      isTrustedAuthor: (login) => login === 'trusted-relay[bot]',
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );

  assert.deepEqual(next, {
    agentId: 'github-copilot-cli-new',
    claimId: 'claim-20260512T110000Z-337-new',
    supersedes: 'claim-20260512T090000Z-337-old',
    branch: 'issue/337-feat-protocol-add-auditable-forced',
    createdAt: '2026-05-12T09:00:00Z',
  });
});

test('forced handoff is rejected when the approving actor is unauthorized', () => {
  const body = renderForcedHandoffComment({
    ...payload,
    forcedBy: 'unauthorized-user',
  });
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: 'trusted-relay[bot]' },
      body,
      createdAt: '2026-05-12T11:00:05Z',
      lastEditedAt: null,
    },
    {
      isTrustedAuthor: (login) => login === 'trusted-relay[bot]',
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );

  assert.deepEqual(next, activeClaim);
});

test('forced handoff is rejected when the marker author is untrusted', () => {
  const body = renderForcedHandoffComment(payload);
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: 'untrusted-user' },
      body,
      createdAt: '2026-05-12T11:00:05Z',
      lastEditedAt: null,
    },
    {
      isTrustedAuthor: (login) => login === 'trusted-relay[bot]',
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );

  assert.deepEqual(next, activeClaim);
});

test('forced handoff requires an exact old-claim match before transferring ownership', () => {
  const body = renderForcedHandoffComment({
    ...payload,
    oldClaimId: 'claim-20260512T090000Z-337-other',
  });
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: 'trusted-relay[bot]' },
      body,
      createdAt: '2026-05-12T11:00:05Z',
      lastEditedAt: null,
    },
    {
      isTrustedAuthor: (login) => login === 'trusted-relay[bot]',
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );

  assert.deepEqual(next, activeClaim);
});

test('forced handoff requires an exact old-agent match before transferring ownership', () => {
  const body = renderForcedHandoffComment({
    ...payload,
    oldAgentId: 'github-copilot-cli-other',
  });
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: 'trusted-relay[bot]' },
      body,
      createdAt: '2026-05-12T11:00:05Z',
      lastEditedAt: null,
    },
    {
      isTrustedAuthor: (login) => login === 'trusted-relay[bot]',
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );

  assert.deepEqual(next, activeClaim);
});

test('forced handoff truncates a millisecond-precision timestamp instead of rejecting it (#2592)', () => {
  const body = renderForcedHandoffComment({
    ...payload,
    timestamp: '2026-05-12T11:00:00.123Z',
  });
  const parsed = parseForcedHandoffComment(body, '2026-05-12T11:00:05Z');
  assert.deepEqual(parsed, {
    ...payload,
    createdAt: '2026-05-12T11:00:05Z',
  });
});

test('forced handoff rejects a non-UTC-offset timestamp', () => {
  assert.throws(
    () =>
      renderForcedHandoffComment({
        ...payload,
        timestamp: '2026-05-12T11:00:00.123+09:00',
      }),
    /invalid forced handoff payload/,
  );
});

test('forced handoff rejects marker-breaking token values', () => {
  assert.throws(
    () =>
      renderForcedHandoffComment({
        ...payload,
        forcedBy: 'kurone-kito-->',
      }),
    /invalid forced handoff payload/,
  );
});

test('forced handoff rejects multiline reason values', () => {
  const body = [
    '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","linked-pr":"341","forced-by":"kurone-kito","reason":"line1\\nline2","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-plus-pr"} -->',
    '',
    'Forced handoff approved by kurone-kito. I verified that the current',
    'owning session or agent is unavailable. This transfers ownership away',
    'from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced` for PR #341.',
    'If the prior session resumes, it must stop immediately and must not',
    'push, comment, resolve review state, or merge until a maintainer',
    'reassigns ownership.',
  ].join('\n');

  assert.equal(parseForcedHandoffComment(body, '2026-05-12T11:00:05Z'), null);
});

test('forced handoff rejects invalid linked PR tokens', () => {
  for (const linkedPr of [
    '0',
    '-1',
    '1.5',
    'not-a-pr',
    'ftp://example.test/pr/341',
    'HTTP://github.com/kurone-kito/idd-skill/pull/359',
    '<!--hidden',
  ]) {
    assert.throws(
      () =>
        renderForcedHandoffComment({
          ...payload,
          linkedPr,
        }),
      /invalid forced handoff payload/,
      linkedPr,
    );
  }
});

test('forced handoff accepts PR URLs in linked PR scope', () => {
  for (const linkedPr of [
    'https://github.com/kurone-kito/idd-skill/pull/359',
    'http://github.com/kurone-kito/idd-skill/pull/359',
  ]) {
    const body = renderForcedHandoffComment({
      ...payload,
      linkedPr,
    });

    assert.deepEqual(parseForcedHandoffComment(body, '2026-05-12T11:00:05Z'), {
      ...payload,
      linkedPr,
      createdAt: '2026-05-12T11:00:05Z',
    });
  }
});

test('forced handoff consent note keeps URL PR references unprefixed', () => {
  assert.match(
    renderForcedHandoffConsentNote({
      ...payload,
      linkedPr: 'https://github.com/kurone-kito/idd-skill/pull/359',
    }),
    /for PR https:\/\/github\.com\/kurone-kito\/idd-skill\/pull\/359\./,
  );
});

test('forced handoff rejects conflicting alias keys', () => {
  const body = [
    '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","oldAgentId":"github-copilot-cli-other","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","linked-pr":"341","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-plus-pr"} -->',
    '',
    'Forced handoff approved by kurone-kito. I verified that the current',
    'owning session or agent is unavailable. This transfers ownership away',
    'from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced` for PR #341.',
    'If the prior session resumes, it must stop immediately and must not',
    'push, comment, resolve review state, or merge until a maintainer',
    'reassigns ownership.',
  ].join('\n');

  assert.equal(parseForcedHandoffComment(body, '2026-05-12T11:00:05Z'), null);
});

const HANDOFF_REPO = 'kurone-kito/idd-skill';
const HANDOFF_COMMENTS_ARGS = [
  'api',
  '--jq',
  '.[]',
  '--paginate',
  `repos/${HANDOFF_REPO}/issues/337/comments`,
];
const HANDOFF_PERMISSION_ARGS = [
  'api',
  `repos/${HANDOFF_REPO}/collaborators/kurone-kito/permission`,
];
const HANDOFF_CLAIM_BODY = [
  '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
  '',
  '_github-copilot-cli-old: issue claim — IDD automation marker. Do not edit._',
].join('\n');

interface FixtureComment {
  id: number;
  node_id: string;
  created_at: string;
  user: { login: string };
  body: string;
}

const fixtureComment = (
  id: number,
  login: string,
  body: string,
): FixtureComment => ({
  id,
  node_id: `IC_fixture_${id}`,
  created_at: '2026-05-12T09:00:00Z',
  user: { login },
  body,
});

/** Claim branch of the handoff fixtures (issue #337), and the PR the --pr runs name. */
const HANDOFF_BRANCH = 'issue/337-feat-protocol-add-auditable-forced';
const HANDOFF_PR_VIEW_ARGS = [
  'pr',
  'view',
  '501',
  '-R',
  HANDOFF_REPO,
  '--json',
  'headRefName,url,baseRefName,state',
  '--jq',
  '.',
];

/** `gh pr view 501` answering with the claim branch as its head. */
function prViewRule(): FixtureGhRule {
  return {
    args: HANDOFF_PR_VIEW_ARGS,
    stdout: JSON.stringify({
      headRefName: HANDOFF_BRANCH,
      baseRefName: 'main',
      state: 'OPEN',
      url: `https://github.com/${HANDOFF_REPO}/pull/501`,
    }),
  };
}

/**
 * The reads the successor preflight makes (#3872) as canned answers. By default
 * the claim branch has no open PR, the live default branch is `main`, the claim
 * branch is absent on the remote (a 404), and every trusted copy confirms
 * human-gated. A test overrides any of these by listing its own rules first.
 */
function preflightRules(
  options: {
    openPrs?: { number: number; headRefName: string; baseRefName: string }[];
    defaultBranch?: string;
    claimBranchPresent?: boolean;
    probeFailure?: string;
    /** Mode the trusted copy at each ref sets; absent refs are human-gated. */
    configs?: Record<string, string>;
  } = {},
): FixtureGhRule[] {
  const openPrs = options.openPrs ?? [];
  const defaultBranch = options.defaultBranch ?? 'main';
  const probeArgs = [
    'api',
    `repos/${HANDOFF_REPO}/branches/${encodeURIComponent(HANDOFF_BRANCH)}`,
    '--jq',
    '.name',
  ];
  const rules: FixtureGhRule[] = [
    {
      args: ['pr', 'list'],
      match: 'prefix',
      includes: ['number,headRefName,baseRefName'],
      stdout: JSON.stringify(openPrs),
    },
    {
      args: [
        'api',
        `repos/${HANDOFF_REPO}`,
        '--jq',
        '.default_branch // empty',
      ],
      stdout: `${defaultBranch}\n`,
    },
  ];
  if (options.probeFailure !== undefined) {
    rules.push({ args: probeArgs, stderr: options.probeFailure, status: 1 });
  } else if (options.claimBranchPresent) {
    rules.push({ args: probeArgs, stdout: `${HANDOFF_BRANCH}\n` });
  } else {
    rules.push({
      args: probeArgs,
      stderr: 'gh: Not Found (HTTP 404)\n',
      status: 1,
    });
  }
  const refs = new Set<string>([
    defaultBranch,
    HANDOFF_BRANCH,
    ...openPrs.map((pr) => pr.baseRefName),
  ]);
  for (const ref of refs) {
    const mode = options.configs?.[ref] ?? 'human-gated';
    const content = Buffer.from(
      JSON.stringify({ forcedHandoff: { mode } }),
      'utf8',
    ).toString('base64');
    rules.push({
      args: [
        'api',
        `repos/${HANDOFF_REPO}/contents/.github/idd/config.json`,
        '--method',
        'GET',
        '-f',
        `ref=${ref}`,
        '--jq',
        '.content',
      ],
      stdout: content,
    });
  }
  return rules;
}

/**
 * The four reads a human-gated `main` run makes, as canned answers: the comment
 * list (NDJSON via `--jq .[]`), the GraphQL edit-state read for those comments,
 * and the `--forced-by` actor's permission. The viewer is the fixture's own.
 */
function handoffRules(
  comments: FixtureComment[],
  permission: Partial<FixtureGhRule> = {
    stdout: '{"permission":"admin","role_name":"admin"}',
  },
): FixtureGhRule[] {
  return [
    {
      args: HANDOFF_COMMENTS_ARGS,
      stdout: comments.map((comment) => JSON.stringify(comment)).join('\n'),
    },
    {
      args: ['api', 'graphql'],
      match: 'prefix',
      includes: ['lastEditedAt'],
      stdout: JSON.stringify({
        data: {
          nodes: comments.map((comment) => ({
            id: comment.node_id,
            lastEditedAt: null,
          })),
        },
      }),
    },
    { args: HANDOFF_PERMISSION_ARGS, ...permission },
    // #3872: the successor preflight's reads, served by default (no open PR,
    // human-gated copies) so the existing human-gated runs keep their meaning.
    ...preflightRules(),
  ];
}

const HANDOFF_ARGS = [
  '--issue',
  '337',
  '--new-agent-id',
  'github-copilot-cli-new',
  '--new-claim-id',
  'claim-20260512T110000Z-337-new',
  '--forced-by',
  'kurone-kito',
  '--reason',
  'operator-approved-recovery',
  '--timestamp',
  '2026-05-12T11:00:00Z',
  '--repo',
  HANDOFF_REPO,
];

/**
 * Runs `body` from a sandbox cwd whose config enables human-gated forced
 * handoff, with the trust-widening environment variables cleared, and with
 * `console.log` captured. Restores the cwd, the environment and `console.log`.
 */
function inHumanGatedSandbox<T>(
  rules: FixtureGhRule[],
  body: (output: () => string) => T,
): T {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-forced-handoff-marker-'));
  mkdirSync(join(sandbox, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(sandbox, '.github', 'idd', 'config.json'),
    JSON.stringify({ forcedHandoff: { mode: 'human-gated' } }),
  );
  const envNames = [
    'IDD_TRUSTED_MARKER_ACTORS',
    'IDD_TRUST_COLLABORATOR_MARKERS',
  ] as const;
  const savedEnv = envNames.map((name) => process.env[name]);
  for (const name of envNames) {
    delete process.env[name];
  }
  const lines: string[] = [];
  const log = mock.method(console, 'log', (message?: unknown) => {
    lines.push(String(message));
  });
  fixtureGh.setResponses(rules);
  process.chdir(sandbox);
  try {
    return body(() => lines.join('\n'));
  } finally {
    process.chdir(originalCwd);
    log.mock.restore();
    fixtureGh.setResponses([]);
    envNames.forEach((name, index) => {
      const saved = savedEnv[index];
      if (saved === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved;
      }
    });
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test('nested forcedHandoff.mode key enables human-gated mode and renders the marker from served GitHub data', () => {
  const comments = [
    fixtureComment(1001, 'kurone-kito', HANDOFF_CLAIM_BODY),
    fixtureComment(1002, 'someone-else', 'Is this still being worked on?'),
  ];
  const callsBefore = fixtureGh.calls().length;
  inHumanGatedSandbox(handoffRules(comments), (output) => {
    assert.equal(main(HANDOFF_ARGS), 0);
    const rendered = output();
    assert.match(rendered, /^<!-- forced-handoff: \{/);
    // The rendered marker is the contract: the old claim comes from the served
    // comments and every other field from the command line.
    assert.deepEqual(
      parseForcedHandoffComment(rendered, '2026-05-12T11:00:05Z'),
      {
        oldAgentId: 'github-copilot-cli-old',
        oldClaimId: 'claim-20260512T090000Z-337-old',
        newAgentId: 'github-copilot-cli-new',
        newClaimId: 'claim-20260512T110000Z-337-new',
        branch: 'issue/337-feat-protocol-add-auditable-forced',
        forcedBy: 'kurone-kito',
        reason: 'operator-approved-recovery',
        timestamp: '2026-05-12T11:00:00Z',
        contextScope: 'issue-only',
        createdAt: '2026-05-12T11:00:05Z',
      },
    );
  });
  // Every read the run made was a served one, none fell through.
  assert.deepEqual(fixtureGh.unexpectedCalls(), []);
  const reads = fixtureGh
    .calls()
    .slice(callsBefore)
    .map((call) => call.join(' '));
  assert.ok(
    reads.some((read) => read.includes(HANDOFF_PERMISSION_ARGS[1] as string)),
    reads.join('\n'),
  );
});

// #3872: the successor preflight in the marker helper. A refusal prints
// nothing, and --plan reports the preflight without refusing.
const HANDOFF_CLAIM = [fixtureComment(1001, 'kurone-kito', HANDOFF_CLAIM_BODY)];
const HANDOFF_OPEN_PR_ON_MAIN = [
  { number: 501, headRefName: HANDOFF_BRANCH, baseRefName: 'main' },
];
const HANDOFF_PLAN_ARGS = [
  '--issue',
  '337',
  '--forced-by',
  'kurone-kito',
  '--reason',
  'operator-approved-recovery',
  '--repo',
  HANDOFF_REPO,
  '--plan',
];

test('forced handoff helper names --pr and prints nothing when the claim branch has an open PR (#3872)', () => {
  inHumanGatedSandbox(
    [
      ...preflightRules({ openPrs: HANDOFF_OPEN_PR_ON_MAIN }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.throws(
        () => main(HANDOFF_ARGS),
        /open PR on claim branch issue\/337-feat-protocol-add-auditable-forced \(#501\); rerun with --pr <number>/,
      );
      assert.equal(output(), '');
    },
  );
});

test('forced handoff helper refuses --pr when the base copy lacks the opt-in and prints nothing (#3872)', () => {
  inHumanGatedSandbox(
    [
      prViewRule(),
      ...preflightRules({
        openPrs: HANDOFF_OPEN_PR_ON_MAIN,
        configs: { main: 'disabled' },
      }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.throws(
        () => main([...HANDOFF_ARGS, '--pr', '501']),
        /the base branch main sets forcedHandoff\.mode to disabled/,
      );
      assert.equal(output(), '');
    },
  );
});

test('forced handoff helper renders issue-plus-pr when every trusted copy confirms the opt-in (#3872)', () => {
  inHumanGatedSandbox(
    [
      prViewRule(),
      ...preflightRules({ openPrs: HANDOFF_OPEN_PR_ON_MAIN }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.equal(main([...HANDOFF_ARGS, '--pr', '501']), 0);
      assert.equal(
        parseForcedHandoffComment(output(), '2026-05-12T11:00:05Z')
          ?.contextScope,
        'issue-plus-pr',
      );
    },
  );
});

test('forced handoff helper checks only the PR it names, not an unrelated open PR (#3872)', () => {
  inHumanGatedSandbox(
    [
      prViewRule(),
      ...preflightRules({
        openPrs: [
          ...HANDOFF_OPEN_PR_ON_MAIN,
          {
            number: 502,
            headRefName: HANDOFF_BRANCH,
            baseRefName: 'release/1',
          },
        ],
        configs: { 'release/1': 'disabled' },
      }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.equal(main([...HANDOFF_ARGS, '--pr', '501']), 0);
      assert.equal(
        parseForcedHandoffComment(output(), '2026-05-12T11:00:05Z')
          ?.contextScope,
        'issue-plus-pr',
      );
    },
  );
});

test('forced handoff helper refuses a claim-branch probe failure that is not a 404 (#3872)', () => {
  inHumanGatedSandbox(
    [
      ...preflightRules({
        probeFailure: 'gh: API rate limit exceeded (HTTP 500)\n',
      }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.throws(
        () => main(HANDOFF_ARGS),
        /the claim branch issue\/337-feat-protocol-add-auditable-forced could not be read/,
      );
      assert.equal(output(), '');
    },
  );
});

test('forced handoff --plan reports a refused preflight, omits markerBody, and exits 0 (#3872)', () => {
  inHumanGatedSandbox(
    [
      ...preflightRules({ configs: { main: 'disabled' } }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.equal(main(HANDOFF_PLAN_ARGS), 0);
      const plan = JSON.parse(output());
      assert.equal(plan.preflight.status, 'refused');
      assert.match(
        plan.preflight.refusal,
        /the default branch main sets forcedHandoff\.mode to disabled/,
      );
      assert.equal('markerBody' in plan, false);
    },
  );
});

test('forced handoff --plan keeps markerBody and reports an ok preflight when every copy confirms (#3872)', () => {
  inHumanGatedSandbox(
    [...preflightRules(), ...handoffRules(HANDOFF_CLAIM)],
    (output) => {
      assert.equal(main(HANDOFF_PLAN_ARGS), 0);
      const plan = JSON.parse(output());
      assert.equal(plan.preflight.status, 'ok');
      assert.equal(typeof plan.markerBody, 'string');
    },
  );
});

test('forced handoff --plan with local mode disabled reports not-evaluated and reads no trusted copy (#3872)', () => {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-forced-handoff-marker-'));
  mkdirSync(join(sandbox, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(sandbox, '.github', 'idd', 'config.json'),
    JSON.stringify({ forcedHandoff: 'disabled' }),
  );
  const lines: string[] = [];
  const log = mock.method(console, 'log', (message?: unknown) => {
    lines.push(String(message));
  });
  fixtureGh.setResponses(handoffRules(HANDOFF_CLAIM));
  const callsBefore = fixtureGh.calls().length;
  process.chdir(sandbox);
  try {
    assert.equal(main(HANDOFF_PLAN_ARGS), 0);
  } finally {
    process.chdir(originalCwd);
    log.mock.restore();
    fixtureGh.setResponses([]);
  }
  const plan = JSON.parse(lines.join('\n'));
  assert.equal(plan.preflight.status, 'not-evaluated');
  const reads = fixtureGh
    .calls()
    .slice(callsBefore)
    .map((call) => call.join(' '));
  assert.equal(
    reads.some((read) => read.includes('contents/.github/idd/config.json')),
    false,
    reads.join('\n'),
  );
});

test('forced handoff helper refuses --pr naming a PR that is not open, printing nothing (#3872)', () => {
  const closedPrView: FixtureGhRule = {
    args: HANDOFF_PR_VIEW_ARGS,
    stdout: JSON.stringify({
      headRefName: HANDOFF_BRANCH,
      baseRefName: 'main',
      state: 'CLOSED',
      url: `https://github.com/${HANDOFF_REPO}/pull/501`,
    }),
  };
  inHumanGatedSandbox(
    [
      closedPrView,
      ...preflightRules({ openPrs: HANDOFF_OPEN_PR_ON_MAIN }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.throws(
        () => main([...HANDOFF_ARGS, '--pr', '501']),
        /PR #501 is not open/,
      );
      assert.equal(output(), '');
    },
  );
});

test('forced handoff --plan --pr checks the PR it names, not an unrelated open PR (#3872)', () => {
  inHumanGatedSandbox(
    [
      ...preflightRules({
        openPrs: [
          ...HANDOFF_OPEN_PR_ON_MAIN,
          {
            number: 502,
            headRefName: HANDOFF_BRANCH,
            baseRefName: 'release/1',
          },
        ],
        configs: { 'release/1': 'disabled' },
      }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.equal(main([...HANDOFF_PLAN_ARGS, '--pr', '501']), 0);
      const plan = JSON.parse(output());
      assert.equal(plan.preflight.status, 'ok');
      assert.equal(typeof plan.markerBody, 'string');
    },
  );
});

test('forced handoff --plan without --pr checks every open PR base and reports refused (#3872)', () => {
  inHumanGatedSandbox(
    [
      ...preflightRules({
        openPrs: [
          ...HANDOFF_OPEN_PR_ON_MAIN,
          {
            number: 502,
            headRefName: HANDOFF_BRANCH,
            baseRefName: 'release/1',
          },
        ],
        configs: { 'release/1': 'disabled' },
      }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.equal(main(HANDOFF_PLAN_ARGS), 0);
      const plan = JSON.parse(output());
      assert.equal(plan.preflight.status, 'refused');
      assert.match(
        plan.preflight.refusal,
        /the base branch release\/1 sets forcedHandoff\.mode to disabled/,
      );
      assert.equal('markerBody' in plan, false);
    },
  );
});

test('forced handoff helper refuses --pr for a merged PR or one with no state, printing nothing (#3872)', () => {
  const prViewWithState = (state: string | null): FixtureGhRule => ({
    args: HANDOFF_PR_VIEW_ARGS,
    stdout: JSON.stringify({
      headRefName: HANDOFF_BRANCH,
      baseRefName: 'main',
      ...(state === null ? {} : { state }),
      url: `https://github.com/${HANDOFF_REPO}/pull/501`,
    }),
  });
  for (const state of ['MERGED', null]) {
    inHumanGatedSandbox(
      [
        prViewWithState(state),
        ...preflightRules({ openPrs: HANDOFF_OPEN_PR_ON_MAIN }),
        ...handoffRules(HANDOFF_CLAIM),
      ],
      (output) => {
        assert.throws(
          () => main([...HANDOFF_ARGS, '--pr', '501']),
          /PR #501 is not open/,
        );
        assert.equal(output(), '');
      },
    );
  }
});

test('forced handoff --plan --pr refuses a PR that is not among the open PRs (#3872)', () => {
  inHumanGatedSandbox(
    [...preflightRules(), ...handoffRules(HANDOFF_CLAIM)],
    () => {
      assert.throws(
        () => main([...HANDOFF_PLAN_ARGS, '--pr', '501']),
        /does not match any open PR/,
      );
    },
  );
});

test('forced handoff --plan --pr refuses on the named PR own base, not on the default branch (#3872)', () => {
  inHumanGatedSandbox(
    [
      ...preflightRules({
        openPrs: [
          {
            number: 501,
            headRefName: HANDOFF_BRANCH,
            baseRefName: 'release/1',
          },
        ],
        configs: { 'release/1': 'disabled' },
      }),
      ...handoffRules(HANDOFF_CLAIM),
    ],
    (output) => {
      assert.equal(main([...HANDOFF_PLAN_ARGS, '--pr', '501']), 0);
      const plan = JSON.parse(output());
      assert.equal(plan.preflight.status, 'refused');
      assert.match(
        plan.preflight.refusal,
        /the base branch release\/1 sets forcedHandoff\.mode to disabled/,
      );
      assert.equal('markerBody' in plan, false);
    },
  );
});

test('forced handoff helper --help says explicit successor ids stay accepted with --plan (#3872)', () => {
  const lines: string[] = [];
  const log = mock.method(console, 'log', (message?: unknown) => {
    lines.push(String(message));
  });
  try {
    assert.equal(main(['--help']), 0);
  } finally {
    log.mock.restore();
  }
  assert.match(
    lines.join('\n'),
    /explicit --new-agent-id and --new-claim-id stay accepted with --plan/,
  );
});

test('human-gated forced handoff refuses a --forced-by actor the served permission does not authorize', () => {
  const claim = [fixtureComment(1001, 'kurone-kito', HANDOFF_CLAIM_BODY)];
  const refusal =
    /--forced-by actor kurone-kito is not authorized under owners-and-maintainers-only/;
  for (const permission of [
    { stdout: '{"permission":"read","role_name":"read"}' },
    { stderr: 'gh: Not Found (HTTP 404)\n', status: 1 },
  ]) {
    inHumanGatedSandbox(handoffRules(claim, permission), (output) => {
      assert.throws(
        () => main(HANDOFF_ARGS),
        refusal,
        JSON.stringify(permission),
      );
      assert.equal(output(), '', 'no marker is rendered on a refusal');
    });
  }
});

test('human-gated forced handoff needs an active claim from a trusted author', () => {
  const noClaim = /issue #337 has no active trusted claim/;
  // No claim marker at all.
  inHumanGatedSandbox(
    handoffRules([fixtureComment(1001, 'kurone-kito', 'Working on it.')]),
    (output) => {
      assert.throws(() => main(HANDOFF_ARGS), noClaim);
      assert.equal(output(), '');
    },
  );
  // A claim marker an untrusted author posted does not count.
  inHumanGatedSandbox(
    handoffRules([fixtureComment(1001, 'someone-else', HANDOFF_CLAIM_BODY)]),
    (output) => {
      assert.throws(() => main(HANDOFF_ARGS), noClaim);
      assert.equal(output(), '');
    },
  );
});

test('nested forcedHandoff.mode=disabled refuses output', () => {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-forced-handoff-marker-'));
  mkdirSync(join(sandbox, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(sandbox, '.github', 'idd', 'config.json'),
    JSON.stringify({ forcedHandoff: { mode: 'disabled' } }),
  );

  process.chdir(sandbox);
  try {
    assert.throws(
      () =>
        main([
          '--issue',
          '337',
          '--new-agent-id',
          'github-copilot-cli-new',
          '--new-claim-id',
          'claim-20260512T110000Z-337-new',
          '--forced-by',
          'kurone-kito',
          '--reason',
          'operator-approved-recovery',
          '--repo',
          'kurone-kito/idd-skill',
        ]),
      /forced-handoff mode is not human-gated; marker generation is disabled/,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test('planHandoff and generateSuccessorIds — integration fixture', () => {
  const planClaimBody = [
    '<!-- claimed-by: github-copilot-cli-old claim-plan-test-old supersedes: none 2026-05-13T10:00:00Z branch: issue/496-feat-force-handoff-derive-live-pr -->',
    '',
    '_github-copilot-cli-old: issue claim — IDD automation marker. Do not edit._',
  ].join('\n');

  const issueComments = [
    {
      body: planClaimBody,
      created_at: '2026-05-13T10:00:00Z',
      user: { login: 'kurone-kito' },
    },
  ];

  const trustedLogins = ['kurone-kito', 'github-copilot-cli-old'];
  const authorizeKuroneKito = (actor: string) => actor === 'kurone-kito';

  const resultIssueOnly = planHandoff(issueComments, [], {
    trustedMarkerLogins: trustedLogins,
    forcedBy: 'kurone-kito',
    reason: 'operator-approved-recovery',
    isAuthorizedForcedHandoff: authorizeKuroneKito,
    staleAgeMs: DEFAULT_STALE_AGE_MS,
  });

  assert.equal(resultIssueOnly.contextScope, 'issue-only');
  assert.deepEqual(resultIssueOnly.prReferences, []);
  assert.equal(
    resultIssueOnly.branch,
    'issue/496-feat-force-handoff-derive-live-pr',
  );
  assert.ok(
    resultIssueOnly.markerBody?.includes('issue-only'),
    'marker body should contain context scope',
  );
  assert.ok(
    resultIssueOnly.successorIds.newAgentId,
    'newAgentId should be non-empty',
  );
  assert.ok(
    resultIssueOnly.successorIds.newClaimId,
    'newClaimId should be non-empty',
  );

  const linkedPrs = [
    { number: 501, headRefName: 'issue/496-feat-force-handoff-derive-live-pr' },
  ];

  const resultWithPr = planHandoff(issueComments, linkedPrs, {
    trustedMarkerLogins: trustedLogins,
    forcedBy: 'kurone-kito',
    reason: 'operator-approved-recovery',
    isAuthorizedForcedHandoff: authorizeKuroneKito,
    staleAgeMs: DEFAULT_STALE_AGE_MS,
  });

  assert.equal(resultWithPr.contextScope, 'issue-plus-pr');
  assert.deepEqual(resultWithPr.prReferences, ['501']);
  assert.ok(
    resultWithPr.markerBody?.includes('issue-plus-pr'),
    'marker body should contain context scope',
  );
  assert.ok(
    resultWithPr.markerBody?.includes('"linked-pr":"501"'),
    'marker body should contain linked PR',
  );

  assert.throws(
    () =>
      planHandoff(issueComments, linkedPrs, {
        prNumber: 999,
        trustedMarkerLogins: trustedLogins,
        forcedBy: 'kurone-kito',
        reason: 'operator-approved-recovery',
        isAuthorizedForcedHandoff: authorizeKuroneKito,
        staleAgeMs: DEFAULT_STALE_AGE_MS,
      }),
    /PR #999 does not match any open PR on claim branch issue\/496-feat-force-handoff-derive-live-pr/,
  );

  const ids1 = generateSuccessorIds('test-agent');
  const ids2 = generateSuccessorIds('test-agent');

  assert.ok(ids1.newAgentId, 'newAgentId should be non-empty');
  assert.ok(ids1.newClaimId, 'newClaimId should be non-empty');
  assert.notEqual(
    ids1.newClaimId,
    ids2.newClaimId,
    'claim IDs should differ across calls',
  );
  assert.equal(ids1.newAgentId, 'test-agent');
  assert.match(ids1.newClaimId, /^claim-[0-9a-f]{16}$/);
});

test('planHandoff omits markerBody when forcedBy actor is not authorized', () => {
  const planClaimBody = [
    '<!-- claimed-by: github-copilot-cli-old claim-plan-test-old supersedes: none 2026-05-13T10:00:00Z branch: issue/496-feat-force-handoff-derive-live-pr -->',
    '',
    '_github-copilot-cli-old: issue claim — IDD automation marker. Do not edit._',
  ].join('\n');

  const issueComments = [
    {
      body: planClaimBody,
      created_at: '2026-05-13T10:00:00Z',
      user: { login: 'kurone-kito' },
    },
  ];

  const result = planHandoff(issueComments, [], {
    trustedMarkerLogins: ['kurone-kito', 'github-copilot-cli-old'],
    forcedBy: 'unauthorized-actor',
    reason: 'operator-approved-recovery',
    isAuthorizedForcedHandoff: (actor) => actor === 'kurone-kito',
    staleAgeMs: DEFAULT_STALE_AGE_MS,
  });

  assert.equal(
    result.markerBody,
    null,
    'markerBody should be null for unauthorized forcedBy',
  );
  assert.equal(result.contextScope, 'issue-only');
  assert.ok(
    result.successorIds.newAgentId,
    'successorIds should still be generated',
  );
});

test('planHandoff fails closed for the marker preview when no authorizer callback is supplied', () => {
  const planClaimBody = [
    '<!-- claimed-by: github-copilot-cli-old claim-plan-test-old supersedes: none 2026-05-13T10:00:00Z branch: issue/496-feat-force-handoff-derive-live-pr -->',
    '',
    '_github-copilot-cli-old: issue claim — IDD automation marker. Do not edit._',
  ].join('\n');

  const issueComments = [
    {
      body: planClaimBody,
      created_at: '2026-05-13T10:00:00Z',
      user: { login: 'kurone-kito' },
    },
  ];

  const baseOptions = {
    trustedMarkerLogins: ['kurone-kito', 'github-copilot-cli-old'],
    forcedBy: 'kurone-kito',
    reason: 'operator-approved-recovery',
    staleAgeMs: DEFAULT_STALE_AGE_MS,
  };

  // Missing callback must be treated as unauthorized for the preview,
  // matching the fail-closed default used during claim resolution.
  const withoutCallback = planHandoff(issueComments, [], baseOptions);
  assert.equal(
    withoutCallback.markerBody,
    null,
    'markerBody should be null when no authorizer callback is supplied',
  );

  // An authorizing callback leaves the rendering behavior unchanged.
  const withCallback = planHandoff(issueComments, [], {
    ...baseOptions,
    isAuthorizedForcedHandoff: (actor) => actor === 'kurone-kito',
  });
  assert.ok(
    withCallback.markerBody,
    'markerBody should render when the forcedBy actor is authorized',
  );
});

test('planHandoff rejects prior issue-only handoff when PR is present (PR-scoped claim replay)', () => {
  const claimBody = [
    '<!-- claimed-by: agent-a claim-a-original supersedes: none 2026-05-13T09:00:00Z branch: issue/496-feat-force-handoff-derive-live-pr -->',
    '',
    '_agent-a: issue claim — IDD automation marker. Do not edit._',
  ].join('\n');
  const issueOnlyHandoff = renderForcedHandoffComment({
    oldAgentId: 'agent-a',
    oldClaimId: 'claim-a-original',
    newAgentId: 'agent-b',
    newClaimId: 'claim-b-handoff',
    branch: 'issue/496-feat-force-handoff-derive-live-pr',
    forcedBy: 'kurone-kito',
    reason: 'operator-approved-recovery',
    timestamp: '2026-05-13T11:00:00Z',
    contextScope: 'issue-only',
  });

  const issueComments = [
    {
      body: claimBody,
      created_at: '2026-05-13T09:00:00Z',
      user: { login: 'kurone-kito' },
    },
    {
      body: issueOnlyHandoff,
      created_at: '2026-05-13T11:00:05Z',
      user: { login: 'kurone-kito' },
    },
  ];

  const linkedPrs = [
    { number: 501, headRefName: 'issue/496-feat-force-handoff-derive-live-pr' },
  ];

  const result = planHandoff(issueComments, linkedPrs, {
    trustedMarkerLogins: ['kurone-kito', 'agent-a', 'agent-b'],
    isAuthorizedForcedHandoff: (actor) => actor === 'kurone-kito',
    forcedBy: 'kurone-kito',
    reason: 'operator-approved-recovery',
    staleAgeMs: DEFAULT_STALE_AGE_MS,
  });

  assert.equal(result.contextScope, 'issue-plus-pr');
  // With PR-scoped second pass, the issue-only handoff is rejected and
  // the original claim (agent-a) remains the active PR-scope authority.
  assert.equal(result.activeClaim.agentId, 'agent-a');
  assert.equal(result.activeClaim.claimId, 'claim-a-original');
});

test('forcedHandoff.mode defaults to disabled when key is absent', () => {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-forced-handoff-marker-'));
  mkdirSync(join(sandbox, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(sandbox, '.github', 'idd', 'config.json'),
    JSON.stringify({ iddVersion: '1.0.0' }),
  );

  process.chdir(sandbox);
  try {
    assert.throws(
      () =>
        main([
          '--issue',
          '337',
          '--new-agent-id',
          'github-copilot-cli-new',
          '--new-claim-id',
          'claim-20260512T110000Z-337-new',
          '--forced-by',
          'kurone-kito',
          '--reason',
          'operator-approved-recovery',
          '--repo',
          'kurone-kito/idd-skill',
        ]),
      /forced-handoff mode is not human-gated; marker generation is disabled/,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

// --- kurone-kito/idd-skill#3340: buildTrustedMarkerLogins delegates its ----
// collaborator-widening step to resolveTrustedCollaboratorMarkerLogins ------
//
// Mirrors force-handoff.test.mts's own #1693 parity test: previously this
// file's buildTrustedMarkerLogins permission-checked every unique
// issue-comment author (once collaborator marker trust is enabled),
// over-trusting an ordinary write+ collaborator who never posted an
// operational marker. It now delegates that widening step to
// resolveTrustedCollaboratorMarkerLogins (collaborator-permission.mts) --
// the same marker-authors-first filter force-handoff.mts already uses.

const CLAIM_MARKER_BODY = [
  '<!-- claimed-by: some-agent claim-3340-parity supersedes: none 2026-09-24T00:00:00Z branch: issue/3340-parity -->',
  '',
  '_some-agent: issue claim — IDD automation marker. Do not edit._',
].join('\n');

test('buildTrustedMarkerLogins trusts only operational-marker-shaped comment authors when collaborator marker trust is enabled', () => {
  const previousEnv = process.env.IDD_TRUST_COLLABORATOR_MARKERS;
  process.env.IDD_TRUST_COLLABORATOR_MARKERS = 'true';
  try {
    const comments = [
      {
        body: CLAIM_MARKER_BODY,
        created_at: '2026-09-24T00:00:00Z',
        user: { login: 'marker-author' },
      },
      {
        body: 'just an ordinary comment, no marker here',
        created_at: '2026-09-24T00:00:01Z',
        user: { login: 'ordinary-commenter' },
      },
    ];
    const seed: CollaboratorPermissionCache = new Map([
      ['o/r:marker-author', { permission: 'write', roleName: 'write' }],
      ['o/r:ordinary-commenter', { permission: 'write', roleName: 'write' }],
    ]);

    const { logins: trusted, sources } = buildTrustedMarkerLogins(
      'o',
      'r',
      'viewer',
      '',
      comments,
      new Map(seed),
    );
    const siblingFilterResult = resolveTrustedCollaboratorMarkerLogins(
      'o',
      'r',
      comments,
      { cache: new Map(seed) },
    );

    // Parity, per-login: the same decision resolveTrustedCollaboratorMarkerLogins
    // makes for each comment author is reflected in buildTrustedMarkerLogins's
    // own trusted set.
    for (const login of ['marker-author', 'ordinary-commenter']) {
      assert.equal(
        trusted.has(login),
        siblingFilterResult.includes(login),
        `parity mismatch for ${login}`,
      );
    }
    assert.ok(trusted.has('marker-author'));
    assert.ok(!trusted.has('ordinary-commenter'));
    assert.ok(sources.includes('collaborators'));
  } finally {
    if (previousEnv === undefined) {
      delete process.env.IDD_TRUST_COLLABORATOR_MARKERS;
    } else {
      process.env.IDD_TRUST_COLLABORATOR_MARKERS = previousEnv;
    }
  }
});

test('buildTrustedMarkerLogins reports no collaborators source when no collaborator posted a marker', () => {
  const previousEnv = process.env.IDD_TRUST_COLLABORATOR_MARKERS;
  process.env.IDD_TRUST_COLLABORATOR_MARKERS = 'true';
  try {
    const comments = [
      {
        body: 'just an ordinary comment, no marker here',
        created_at: '2026-09-24T00:00:01Z',
        user: { login: 'ordinary-commenter' },
      },
    ];
    const seed: CollaboratorPermissionCache = new Map([
      ['o/r:ordinary-commenter', { permission: 'write', roleName: 'write' }],
    ]);

    const { logins: trusted, sources } = buildTrustedMarkerLogins(
      'o',
      'r',
      'viewer',
      '',
      comments,
      new Map(seed),
    );

    assert.ok(!trusted.has('ordinary-commenter'));
    assert.ok(!sources.includes('collaborators'));
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
    const { logins: trusted } = buildTrustedMarkerLogins(
      'o',
      'r',
      'viewer',
      '',
      [
        {
          body: CLAIM_MARKER_BODY,
          created_at: '2026-09-24T00:00:00Z',
          user: { login: 'marker-author' },
        },
      ],
    );
    assert.ok(!trusted.has('marker-author'));
  } finally {
    if (previousEnv === undefined) {
      delete process.env.IDD_TRUST_COLLABORATOR_MARKERS;
    } else {
      process.env.IDD_TRUST_COLLABORATOR_MARKERS = previousEnv;
    }
  }
});
