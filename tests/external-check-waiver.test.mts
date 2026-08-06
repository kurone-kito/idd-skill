import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTrustedMarkerLogins,
  deriveGhApiStatusFromError,
  parseArgs,
  planExternalCheckWaiver,
} from '../src/scripts/external-check-waiver.mts';
import { normalizePolicyConfig } from '../src/scripts/policy-helpers.mts';
import {
  parseExternalCheckWaiverComment,
  renderExternalCheckWaiverComment,
} from '../src/scripts/protocol-helpers.mts';

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: parses the required flags and applies defaults', () => {
  const args = parseArgs([
    '--pr',
    '5',
    '--check',
    'CodeRabbit',
    '--reason',
    'flaky',
  ]);
  assert.equal(args.prNumber, 5);
  assert.equal(args.issueNumber, 0);
  assert.equal(args.checkSelector, 'CodeRabbit');
  assert.equal(args.reason, 'flaky');
  assert.equal(args.format, 'json');
  assert.equal(args.apply, false);
  assert.equal(args.help, false);
});

test('parseArgs: --help skips the required-flag checks', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

test('parseArgs: a missing --pr value throws', () => {
  assert.throws(() => parseArgs(['--pr']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --claim-id would greedily accept '--apply' as its literal
  // value, silently leaving --apply unset (the #1082 gap this migration
  // closes structurally for this helper).
  assert.throws(() =>
    parseArgs([
      '--pr',
      '5',
      '--check',
      'x',
      '--reason',
      'y',
      '--claim-id',
      '--apply',
    ]),
  );
});

test('parseArgs: an invalid positive-integer --pr throws', () => {
  assert.throws(
    () => parseArgs(['--pr', 'abc', '--check', 'x', '--reason', 'y']),
    /invalid --pr value: abc/,
  );
});

test('parseArgs: an unsupported --format value throws', () => {
  assert.throws(
    () =>
      parseArgs([
        '--pr',
        '5',
        '--check',
        'x',
        '--reason',
        'y',
        '--format',
        'xml',
      ]),
    /unsupported --format value: xml/,
  );
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

// --- #1905: claimless waiver authoring flag ---------------------------------

test('parseArgs: parses --claimless', () => {
  const args = parseArgs([
    '--pr',
    '5',
    '--check',
    'CodeRabbit',
    '--reason',
    'flaky',
    '--claimless',
  ]);
  assert.equal(args.claimless, true);
});

test('parseArgs: --claimless defaults to false', () => {
  const args = parseArgs([
    '--pr',
    '5',
    '--check',
    'CodeRabbit',
    '--reason',
    'flaky',
  ]);
  assert.equal(args.claimless, false);
});

test('parseArgs: --claimless combined with --issue throws', () => {
  assert.throws(
    () =>
      parseArgs([
        '--pr',
        '5',
        '--check',
        'x',
        '--reason',
        'y',
        '--claimless',
        '--issue',
        '3',
      ]),
    /--claimless cannot be combined with --issue/,
  );
});

test('parseArgs: --claimless combined with --claim-id throws', () => {
  assert.throws(
    () =>
      parseArgs([
        '--pr',
        '5',
        '--check',
        'x',
        '--reason',
        'y',
        '--claimless',
        '--claim-id',
        'claim-1',
      ]),
    /--claimless cannot be combined with --claim-id/,
  );
});

type PlanInput = Parameters<typeof planExternalCheckWaiver>[0];
// The base-input builder always supplies these fields, so the test
// mutations below may dereference them without optional guards.
type BaseInput = PlanInput & {
  pr: NonNullable<PlanInput['pr']>;
  issueCandidates: NonNullable<PlanInput['issueCandidates']>;
};

function buildPolicy() {
  return normalizePolicyConfig({
    ciGate: {
      externalChecks: {
        waivable: [{ selector: 'CodeRabbit*', matchMode: 'glob' }],
      },
      externalCheckWaivers: {
        mode: 'maintainer-authorized',
        authorityPolicy: 'owners-and-maintainers-only',
        maxValidity: 'PT24H',
      },
    },
  });
}

function buildBaseInput(): BaseInput {
  return {
    repository: 'kurone-kito/idd-skill',
    policy: buildPolicy(),
    policySource: '.github/idd/config.json',
    actor: 'kurone-kito',
    authority: {
      known: true,
      permission: 'admin',
      roleName: 'admin',
    },
    pr: {
      number: 671,
      state: 'OPEN',
      url: 'https://github.com/kurone-kito/idd-skill/pull/671',
      headRefName: 'issue/667-add-maintainer-facade-external-check-waivers',
      headRefOid: 'a'.repeat(40),
      statusCheckRollup: [
        {
          __typename: 'StatusContext',
          context: 'CodeRabbit',
          state: 'PENDING',
        },
      ],
    },
    issueCandidates: [
      {
        number: 667,
        url: 'https://github.com/kurone-kito/idd-skill/issues/667',
        activeClaim: {
          agentId: 'codex-cli-7f8f9c0d',
          claimId: 'claim-20260517T060713Z-667-7f8f9c0d',
          branch: 'issue/667-add-maintainer-facade-external-check-waivers',
          createdAt: '2026-05-17T06:07:26Z',
        },
      },
    ],
    requestedSelector: 'CodeRabbit',
    reason: 'rate limit',
    expiresAt: '2026-05-17T12:00:00Z',
    repoOwner: 'kurone-kito',
  } as BaseInput;
}

test('renderExternalCheckWaiverComment round-trips whitespace selectors and reasons', () => {
  const body = renderExternalCheckWaiverComment({
    actor: 'kurone-kito',
    agentId: 'codex-cli',
    claimId: 'claim-123',
    headSha: 'a'.repeat(40),
    checkSelector: 'Copilot code review',
    reason: 'rate limit',
    expiresAt: '2026-05-18T00:00:00Z',
  });

  const parsed = parseExternalCheckWaiverComment(body, '2026-05-17T00:00:00Z');
  assert.deepEqual(parsed, {
    agentId: 'codex-cli',
    claimId: 'claim-123',
    headSha: 'a'.repeat(40),
    checkSelector: 'Copilot code review',
    reason: 'rate limit',
    expiresAt: '2026-05-18T00:00:00Z',
    createdAt: '2026-05-17T00:00:00Z',
  });
  assert.match(body, /check:Copilot%20code%20review/);
  assert.match(body, /reason:rate%20limit/);
});

test('planExternalCheckWaiver allows a configured non-passing waivable check', () => {
  const report = planExternalCheckWaiver(buildBaseInput(), {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, true);
  assert.equal(report.blockingReasons.length, 0);
  assert.equal(report.linkedIssue?.number, 667);
  assert.equal(report.checks.matched.length, 1);
  assert.match(report.body, /idd-external-check-waiver/);
});

test('planExternalCheckWaiver fails closed when no active linked claim is available', () => {
  const input = buildBaseInput();
  input.issueCandidates = [
    { number: 667, url: input.issueCandidates[0].url, activeClaim: null },
  ];

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join('\n'), /active linked issue claim/);
});

// --- #1905: claimless waiver authoring path ---------------------------------

test('planExternalCheckWaiver: claimless renders a none-claim-id waiver without any linked issue claim', () => {
  const input = buildBaseInput();
  input.claimless = true;
  // A genuinely claimless PR (e.g. Dependabot) has no linked issue at all.
  input.issueCandidates = [];

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, true);
  assert.equal(report.blockingReasons.length, 0);
  assert.equal(report.linkedIssue, null);
  assert.match(report.body, /idd-external-check-waiver: kurone-kito none /);
});

test('planExternalCheckWaiver: claimless is blocked when the PR has a resolvable active claim', () => {
  const input = buildBaseInput();
  input.claimless = true;
  // buildBaseInput() already wires a linked issue with an active claim --
  // a claimless (none) waiver would just be rejected wrongClaim at the
  // merge gate for a PR shaped like this, so it must be blocked up front.

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(
    report.blockingReasons.join('\n'),
    /resolvable active IDD claim/,
  );
});

test('planExternalCheckWaiver: claimless with an empty actor blocks with a reason instead of throwing', () => {
  const input = buildBaseInput();
  input.claimless = true;
  input.issueCandidates = [];
  input.actor = '';

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join('\n'), /actor is empty/);
  assert.equal(report.body, '');
});

test('planExternalCheckWaiver fails closed for unauthorized write-only actors', () => {
  const input = buildBaseInput();
  input.actor = 'write-collaborator';
  input.authority = {
    known: true,
    permission: 'write',
    roleName: '',
  };

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join('\n'), /not authorized/);
});

test('planExternalCheckWaiver authorizes a permission:maintain actor with empty role_name under the default policy', () => {
  const input = buildBaseInput();
  // A real maintainer that the collaborator-permission endpoint reports with
  // permission: "maintain" and an absent role_name (e.g. GitHub Enterprise
  // Server / custom org roles). Under owners-and-maintainers-only (the default
  // policy) this must resolve as authorized, mirroring the rest of the file.
  input.actor = 'maintain-collaborator';
  input.authority = {
    known: true,
    permission: 'maintain',
    roleName: '',
  };

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, true);
  assert.equal(report.blockingReasons.length, 0);
});

test('planExternalCheckWaiver fails closed for non-waivable checks', () => {
  const input = buildBaseInput();
  input.requestedSelector = 'lint';
  input.pr.statusCheckRollup = [
    {
      __typename: 'CheckRun',
      name: 'lint',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
    },
  ];

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(
    report.blockingReasons.join('\n'),
    /not configured as waivable external checks/,
  );
});

test('planExternalCheckWaiver fails closed when expiry exceeds max validity', () => {
  const input = buildBaseInput();
  input.expiresAt = '2026-05-19T06:00:01Z';

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join('\n'), /maxValidity/);
});

test('buildTrustedMarkerLogins always trusts the repository owner', () => {
  const trusted = buildTrustedMarkerLogins({
    owner: 'repo-owner',
    repo: 'example',
    rawConfig: normalizePolicyConfig({}),
    viewerLogin: 'maintainer-user',
    issueComments: [],
  });

  assert.ok(trusted.has('repo-owner'));
  assert.ok(trusted.has('maintainer-user'));
});

// #1693: buildTrustedMarkerLogins previously permission-checked every
// unique comment author (not just marker-shaped ones) whenever collaborator
// marker trust is enabled, over-trusting an ordinary write+ commenter who
// never posted an operational marker. Collaborator-marker-trust widening
// requires a live gh collaborator-permission lookup with no injection seam
// here, and #1212 forbids mocking the `gh` subprocess -- so this regresses
// against the disabled-widening path instead: with collaborator marker
// trust left at its default (disabled), no comment author is ever
// permission-checked regardless of shape, proving the widening loop no
// longer runs unconditionally over every comment author the way the prior
// implementation did (the buildTrustedMarkerLogins/resolveTrustedCollaboratorMarkerLogins
// unit coverage in tests/force-handoff.test.mts and
// tests/collaborator-permission.test.mts exercises the enabled marker-shape
// filter itself via cache-seeding).
test('buildTrustedMarkerLogins does not trust a non-marker-shaped comment author (collaborator trust disabled by default)', () => {
  const trusted = buildTrustedMarkerLogins({
    owner: 'repo-owner',
    repo: 'example',
    rawConfig: normalizePolicyConfig({}),
    viewerLogin: 'maintainer-user',
    issueComments: [
      {
        body: 'just an ordinary comment',
        user: { login: 'random-write-actor' },
      },
    ],
  });

  assert.ok(!trusted.has('random-write-actor'));
});

// #1693: exit-code-never-surfaces-as-HTTP-status + JSON-body status
// recovery, proven against the actual wired catch-branch function (not
// just the underlying gh-http-status.mts helper it delegates to -- see
// tests/gh-http-status.test.mts for that direct coverage).
test('deriveGhApiStatusFromError never surfaces a bare process exit code as the HTTP status', () => {
  // gh exits 1 for 401/403/404 alike; the removed extractGhHttpStatus used
  // to fall back to this exit code when no `(HTTP NNN)` text was present,
  // silently reporting e.g. a 404 as "status 1". The fixed function must
  // fail closed to 500 instead.
  assert.equal(
    deriveGhApiStatusFromError({ status: 1, stderr: '', stdout: '' }).status,
    500,
  );
});

test('deriveGhApiStatusFromError recovers a status from a JSON error body on stdout', () => {
  assert.equal(
    deriveGhApiStatusFromError({
      status: 1,
      stderr: '',
      stdout: '{"message":"Not Found","status":"404"}',
    }).status,
    404,
  );
});

test('deriveGhApiStatusFromError still prefers the (HTTP NNN) stderr signal', () => {
  assert.equal(
    deriveGhApiStatusFromError({
      status: 1,
      stderr: 'gh: definitely-not-a-user is not a user (HTTP 404)\n',
      stdout: '',
    }).status,
    404,
  );
});

test('parseExternalCheckWaiverComment returns null for empty or non-marker bodies', () => {
  assert.equal(
    parseExternalCheckWaiverComment('', '2026-05-17T00:00:00Z'),
    null,
  );
  assert.equal(
    parseExternalCheckWaiverComment('some random text', '2026-05-17T00:00:00Z'),
    null,
  );
  assert.equal(
    parseExternalCheckWaiverComment(
      '<!-- idd-external-check-waiver: bad-format -->',
      '2026-05-17T00:00:00Z',
    ),
    null,
  );
});

test('parseExternalCheckWaiverComment returns null when required fields are missing', () => {
  const truncated = `<!-- idd-external-check-waiver: agent claim-id ${'a'.repeat(40)} check:CodeRabbit -->`;
  assert.equal(
    parseExternalCheckWaiverComment(truncated, '2026-05-17T00:00:00Z'),
    null,
  );
});

test('planExternalCheckWaiver fails closed when authority lookup returns unknown', () => {
  const input = buildBaseInput();
  input.authority = { known: false };

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.ok(report.blockingReasons.some((r) => /authority|proven/.test(r)));
});
