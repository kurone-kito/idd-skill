import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateResumeClaimRouting } from '../scripts/resume-claim-routing.mjs';

function trusted(logins) {
  const set = new Set(logins);
  return (login) => set.has(login);
}

test('returns unclaimed when no trusted markers exist', () => {
  const result = evaluateResumeClaimRouting(
    { events: [], now: '2026-05-12T10:00:00Z' },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'unclaimed');
  assert.equal(result.action, 're_claim');
  assert.equal(result.reason, 'legacy-absent');
  assert.equal(result.active_claim, null);
});

test('returns already_owned when active claim id matches --claim-id', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
});

test('returns non_inheritable for non-stale active claim from another session', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-mine',
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:30:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-other supersedes: none 2026-05-12T09:30:00Z branch: issue/2-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'active-claim-non-stale');
});

test('returns stale for stale active claim from another session', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-mine',
      now: '2026-05-13T10:00:01Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-other supersedes: none 2026-05-12T10:00:00Z branch: issue/3-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'stale');
  assert.equal(result.action, 'takeover');
  assert.equal(result.reason, 'active-claim-stale');
});

test('detects same-second tie-break loss as disputed', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-z',
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-z supersedes: none 2026-05-12T10:00:00Z branch: issue/4-task -->',
        },
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-a supersedes: none 2026-05-12T10:00:00Z branch: issue/4-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'disputed');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'same-second-claim-tie-break-loss');
  assert.equal(result.active_claim?.claim_id, 'claim-a');
});

test('ignores heartbeat with mismatched branch and records warning', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-branch',
      now: '2026-05-12T10:30:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-branch supersedes: none 2026-05-12T10:00:00Z branch: issue/5-task -->',
        },
        {
          createdAt: '2026-05-12T10:10:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-branch supersedes: none 2026-05-12T10:10:00Z branch: issue/5-wrong -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.active_claim?.branch, 'issue/5-task');
  assert.equal(result.active_claim?.created_at, '2026-05-12T10:00:00Z');
  assert.equal(result.warnings.length, 1);
});

test('returns disputed when a later competing claim appears after active claim', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-owned',
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-owned supersedes: none 2026-05-12T10:00:00Z branch: issue/10-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: other claim-race supersedes: none 2026-05-12T10:05:00Z branch: issue/10-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'disputed');
  assert.equal(result.reason, 'later-competing-claim');
  assert.equal(result.evidence.later_competing_claim.claim_id, 'claim-race');
});

test('legacy claim released by matching legacy unclaim returns unclaimed', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T08:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T08:00:00Z branch: issue/6-task -->',
        },
        {
          createdAt: '2026-05-12T08:30:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: old-agent 2026-05-12T08:30:00Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'unclaimed');
  assert.equal(result.reason, 'legacy-released');
  assert.equal(result.active_claim, null);
});

test('legacy non-stale claim is non_inheritable', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T09:00:00Z branch: issue/7-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'legacy-claim-non-stale');
});

test('legacy stale claim routes to takeover', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-13T09:00:01Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T09:00:00Z branch: issue/8-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'stale');
  assert.equal(result.action, 'takeover');
  assert.equal(result.reason, 'legacy-claim-stale');
});

const FORCED_HANDOFF_EVENTS = [
  {
    createdAt: '2026-05-12T10:00:00Z',
    author: { login: 'maintainer' },
    body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/11-task -->',
  },
  {
    createdAt: '2026-05-12T10:01:00Z',
    author: { login: 'maintainer' },
    body: '<!-- forced-handoff: {"oldAgentId":"copilot","oldClaimId":"claim-old","newAgentId":"copilot","newClaimId":"claim-new","branch":"issue/11-task","forcedBy":"maintainer","reason":"handoff","timestamp":"2026-05-12T10:01:00Z","contextScope":"issue-only"} -->\n\n_maintainer: forced handoff — IDD automation marker. Do not edit._',
  },
];

test('authorized forced-handoff marker promotes successor claim before routing', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      now: '2026-05-12T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
    },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.active_claim?.claim_id, 'claim-new');
});

test('forced-handoff is ignored when forced-handoff mode is disabled', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      now: '2026-05-12T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      // isForcedHandoffEnabled omitted -> defaults to () => false
      isAuthorizedForcedHandoff: () => true,
    },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'active-claim-non-stale');
  assert.equal(result.active_claim?.claim_id, 'claim-old');
  assert.ok(
    result.warnings.some((message) =>
      message.includes('forced-handoff mode is not enabled'),
    ),
    'expected a warning naming the disabled forced-handoff mode',
  );
});

test('forced-handoff is ignored when forcedBy is not an authorized maintainer', () => {
  // Reproduces the same-identity self-signed hijack scenario: a second
  // session running under the trusted marker login posts a forged
  // forced-handoff naming itself as the forcing authority. The
  // authorization callback rejects unauthorized forcedBy actors.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      now: '2026-05-12T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'owner-account',
    },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'active-claim-non-stale');
  assert.equal(result.active_claim?.claim_id, 'claim-old');
  assert.ok(
    result.warnings.some((message) =>
      message.includes('forcedBy maintainer is not an authorized maintainer'),
    ),
    'expected a warning naming the unauthorized forcedBy actor',
  );
});

test('forced-handoff is ignored when comment author does not match forcedBy', () => {
  // A trusted-marker actor (here `copilot`) posts a forged handoff that
  // names a real maintainer as the forcing authority. Without the
  // author-vs-forcedBy binding, the downstream collaborator-permission
  // lookup would happily authorize "real-maintainer". The library must
  // reject the marker before reaching that lookup.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-B',
      now: '2026-05-23T10:05:00Z',
      events: [
        {
          createdAt: '2026-05-23T10:00:00Z',
          author: { login: 'copilot' },
          body: '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->',
        },
        {
          createdAt: '2026-05-23T10:02:00Z',
          author: { login: 'copilot' },
          body: '<!-- forced-handoff: {"oldAgentId":"copilot","oldClaimId":"claim-A","newAgentId":"copilot","newClaimId":"claim-B","branch":"issue/100-task","forcedBy":"real-maintainer","reason":"forged","timestamp":"2026-05-23T10:02:00Z","contextScope":"issue-only"} -->\n\n_copilot: forced handoff — IDD automation marker. Do not edit._',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['copilot']),
      isForcedHandoffEnabled: () => true,
      // The forcedBy string passes a naive collaborator-permission lookup
      // but the author binding inside the library must reject the marker
      // before this callback is even consulted.
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'real-maintainer',
    },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.active_claim?.claim_id, 'claim-A');
  assert.ok(
    result.warnings.some((message) =>
      message.includes(
        'comment author copilot does not match forcedBy real-maintainer',
      ),
    ),
    'expected a warning naming the author/forcedBy mismatch',
  );
});

test('self-signed forced-handoff from same identity does not transfer ownership', () => {
  // The PoC scenario: Session B running under the same GitHub login as
  // Session A posts a forced-handoff with `forcedBy: copilot` (its own
  // login). Even though the comment author is trusted (auto-trusted as
  // viewer in the CLI path), `copilot` is not an authorized maintainer,
  // so the handoff must be ignored.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-B',
      now: '2026-05-23T10:05:00Z',
      events: [
        {
          createdAt: '2026-05-23T10:00:00Z',
          author: { login: 'copilot' },
          body: '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->',
        },
        {
          createdAt: '2026-05-23T10:02:00Z',
          author: { login: 'copilot' },
          body: '<!-- forced-handoff: {"oldAgentId":"copilot","oldClaimId":"claim-A","newAgentId":"copilot","newClaimId":"claim-B","branch":"issue/100-task","forcedBy":"copilot","reason":"unilateral","timestamp":"2026-05-23T10:02:00Z","contextScope":"issue-only"} -->\n\n_copilot: forced handoff — IDD automation marker. Do not edit._',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['copilot']),
      isForcedHandoffEnabled: () => true,
      // The shipped CLI builds this from the collaborator permission
      // policy. Here we hard-code: only `maintainer-account` is
      // authorized. The self-signed `copilot` actor is rejected.
      isAuthorizedForcedHandoff: (forcedBy) =>
        forcedBy === 'maintainer-account',
    },
  );

  assert.notEqual(result.state, 'already_owned');
  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.active_claim?.claim_id, 'claim-A');
});

test('legacy freshness uses marker timestamp over comment metadata timestamp', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-13T10:00:01Z',
      events: [
        {
          createdAt: '2026-05-13T09:59:59Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T09:00:00Z branch: issue/9-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'stale');
  assert.equal(result.reason, 'legacy-claim-stale');
});

test('legacy matching release remains valid after unrelated later unclaim', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T12:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T08:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T08:00:00Z branch: issue/12-task -->',
        },
        {
          createdAt: '2026-05-12T08:10:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: old-agent 2026-05-12T08:10:00Z -->',
        },
        {
          createdAt: '2026-05-12T08:20:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: someone-else 2026-05-12T08:20:00Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'unclaimed');
  assert.equal(result.reason, 'legacy-released');
  assert.equal(result.active_claim, null);
});
