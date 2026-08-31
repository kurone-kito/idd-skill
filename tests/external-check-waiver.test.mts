import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAdvisoryConvergenceDeadlineMinutes } from '../src/scripts/advisory-wait-policy.mts';
import {
  buildTrustedMarkerLogins,
  deriveGhApiStatusFromError,
  findReusableWaiverComment,
  parseArgs,
  planExternalCheckWaiver,
  resolveActorLogin,
  runExternalCheckWaiver,
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

// --- #2022: --actor empty-string fallback-chain bug ------------------------

test('resolveActorLogin: no --actor flag falls through to the authenticated viewer', () => {
  const args = parseArgs([
    '--pr',
    '5',
    '--check',
    'CodeRabbit',
    '--reason',
    'flaky',
  ]);
  assert.equal(args.actor, '');
  assert.equal(
    resolveActorLogin(undefined, args.actor, 'maintainer-user'),
    'maintainer-user',
  );
});

test('resolveActorLogin: --actor "" passed explicitly also falls through to the authenticated viewer', () => {
  const args = parseArgs([
    '--pr',
    '5',
    '--check',
    'CodeRabbit',
    '--reason',
    'flaky',
    '--actor',
    '',
  ]);
  assert.equal(args.actor, '');
  assert.equal(
    resolveActorLogin(undefined, args.actor, 'maintainer-user'),
    'maintainer-user',
  );
});

test('resolveActorLogin: a non-empty --actor flag is preserved', () => {
  const args = parseArgs([
    '--pr',
    '5',
    '--check',
    'CodeRabbit',
    '--reason',
    'flaky',
    '--actor',
    'someone-else',
  ]);
  assert.equal(
    resolveActorLogin(undefined, args.actor, 'maintainer-user'),
    'someone-else',
  );
});

test('resolveActorLogin: a programmatic options.actor override wins over the CLI flag and viewer', () => {
  assert.equal(
    resolveActorLogin('override-actor', 'someone-else', 'maintainer-user'),
    'override-actor',
  );
});

test('resolveActorLogin: a whitespace-only options.actor override falls through instead of collapsing to empty', () => {
  assert.equal(
    resolveActorLogin('   ', 'someone-else', 'maintainer-user'),
    'someone-else',
  );
});

test('resolveActorLogin: a whitespace-only argsActor falls through to the viewer', () => {
  assert.equal(
    resolveActorLogin(undefined, '   ', 'maintainer-user'),
    'maintainer-user',
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

// --- #2328: the idd-advisory-convergence waiver precondition ---------------
// The gate never treats a posted waiver as active until its precondition
// opens, so rendering one before then produces a marker the gate ignores.
// Observed live: this helper reported no blocking reasons while
// pre-merge-readiness reported the hatch shut for the same PR and HEAD.

/** Base input aimed at the precondition-gated selector. */
function buildAdvisoryConvergenceInput(): BaseInput {
  const input = buildBaseInput();
  input.policy = normalizePolicyConfig({
    ciGate: {
      externalChecks: {
        waivable: [
          { selector: 'idd-advisory-convergence', matchMode: 'exact' },
        ],
      },
      externalCheckWaivers: {
        mode: 'maintainer-authorized',
        authorityPolicy: 'owners-and-maintainers-only',
        maxValidity: 'PT24H',
      },
    },
  });
  input.pr.statusCheckRollup = [
    {
      __typename: 'CheckRun',
      name: 'idd-advisory-convergence',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
    },
  ];
  input.requestedSelector = 'idd-advisory-convergence';
  input.headCommittedAt = '2026-08-30T18:13:24Z';
  // Supplied by the caller from the RAW config, as pre-merge-readiness
  // receives it: normalizePolicyConfig drops `convergenceDeadline`, so
  // reading it off the normalized policy would silently use the 24h default
  // for this repository's configured PT9H.
  input.advisoryConvergenceDeadlineMinutes = 540;
  // The base fixture's expiry predates every `now` used below; leaving it
  // would add an unrelated expiry blocker and mask what these cases assert.
  input.expiresAt = '2026-08-31T09:00:00Z';
  return input;
}

test('planExternalCheckWaiver blocks an advisory-convergence waiver before its deadline (#2328)', () => {
  const report = planExternalCheckWaiver(buildAdvisoryConvergenceInput(), {
    // 229 of 540 minutes -- the live observation this issue was filed from.
    now: new Date('2026-08-30T22:02:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.deepEqual(report.advisoryConvergenceWaiverPrecondition, {
    checkSelector: 'idd-advisory-convergence',
    deadlineMinutes: 540,
    headCommittedAt: '2026-08-30T18:13:24Z',
    elapsedMinutes: 229,
    deadlinePassed: false,
    terminalUnavailable: false,
    open: false,
    terminalEvaluated: false,
  });
  const blocked = report.blockingReasons.join(' | ');
  assert.match(blocked, /deadline has not passed/);
  assert.match(blocked, /229 of 540 minutes/);
  // The reason must not claim the hatch is shut outright: the terminal
  // opener is never evaluated here, so it may be open unseen.
  assert.match(blocked, /terminal Copilot unavailability was not evaluated/);
});

test('planExternalCheckWaiver allows an advisory-convergence waiver once the deadline passes (#2328)', () => {
  const report = planExternalCheckWaiver(buildAdvisoryConvergenceInput(), {
    now: new Date('2026-08-31T03:13:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.advisoryConvergenceWaiverPrecondition?.open, true);
  assert.equal(report.canApply, true);
  assert.equal(
    report.blockingReasons.filter((entry) =>
      /deadline has not passed/.test(entry),
    ).length,
    0,
  );
});

test('planExternalCheckWaiver honors the closed-precondition opt-in (#2328)', () => {
  const input = buildAdvisoryConvergenceInput();
  input.allowClosedPrecondition = true;

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-08-30T22:02:24Z'),
    repoOwner: 'kurone-kito',
  });

  // The precondition is still reported honestly as closed; only the block
  // is lifted, so the operator sees exactly what they are overriding.
  assert.equal(report.advisoryConvergenceWaiverPrecondition?.open, false);
  assert.equal(report.canApply, true);
});

test('planExternalCheckWaiver keeps the hatch shut without a HEAD commit anchor (#2328)', () => {
  const input = buildAdvisoryConvergenceInput();
  input.headCommittedAt = '';

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-08-31T03:13:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(
    report.advisoryConvergenceWaiverPrecondition?.elapsedMinutes,
    null,
  );
  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join(' | '), /elapsed unknown/);
});

test('planExternalCheckWaiver leaves other selectors unaffected (#2328)', () => {
  // A glob waiver is never treated as covering idd-advisory-convergence by
  // the gate either (#2021), so gating one here would block for the wrong
  // reason; an unrelated selector must be untouched.
  const report = planExternalCheckWaiver(buildBaseInput(), {
    now: new Date('2026-05-17T06:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.advisoryConvergenceWaiverPrecondition, undefined);
  assert.equal(report.canApply, true);
});

test('parseArgs: --allow-closed-precondition defaults off and parses (#2328)', () => {
  const base = ['--pr', '5', '--check', 'x', '--reason', 'y'];
  assert.equal(parseArgs(base).allowClosedPrecondition, false);
  assert.equal(
    parseArgs([...base, '--allow-closed-precondition']).allowClosedPrecondition,
    true,
  );
});

// --- #2328: --apply idempotency ---------------------------------------------
// Re-running the same --apply appended a second identical marker on pull
// request #2325, leaving two live waivers a later session had to
// disambiguate by hand.

const REUSE_HEAD_SHA = 'b'.repeat(40);

function waiverComment({
  id,
  createdAt,
  checkSelector = 'idd-advisory-convergence',
  expiresAt = '2026-08-31T10:00:00Z',
  claimId = 'claim-abc',
  headSha = REUSE_HEAD_SHA,
}: {
  id: number;
  createdAt: string;
  checkSelector?: string;
  expiresAt?: string;
  claimId?: string;
  headSha?: string;
}) {
  return {
    id,
    html_url: `https://github.com/kurone-kito/idd-skill/pull/2325#issuecomment-${id}`,
    created_at: createdAt,
    user: { login: 'kurone-kito' },
    body: renderExternalCheckWaiverComment({
      actor: 'kurone-kito',
      agentId: 'claude-6043e89f',
      claimId,
      headSha,
      checkSelector,
      reason: 'rate limit',
      expiresAt,
    }),
  };
}

/** Evidence in the shape summarizeExternalCheckWaivers returns. */
function evidenceWithValid(
  entries: { checkSelector: string; expiresAt: string; createdAt: string }[],
) {
  return {
    valid: entries.map((entry) => ({
      authorLogin: 'kurone-kito',
      reason: 'rate limit',
      ...entry,
    })),
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
    modeDisabled: [],
  } as never;
}

test('findReusableWaiverComment reuses the earliest valid marker for the selector (#2328)', () => {
  const comments = [
    waiverComment({ id: 5471539677, createdAt: '2026-08-30T22:05:13Z' }),
    waiverComment({ id: 5471538618, createdAt: '2026-08-30T22:05:01Z' }),
  ];
  const found = findReusableWaiverComment({
    comments,
    evidence: evidenceWithValid([
      {
        checkSelector: 'idd-advisory-convergence',
        expiresAt: '2026-08-31T10:00:00Z',
        createdAt: '2026-08-30T22:05:01Z',
      },
    ]),
    checkSelector: 'idd-advisory-convergence',
  });

  // The earliest wins even though the later one is listed first, so a retry
  // converges on one marker instead of picking a different one each pass.
  assert.equal(found?.commentId, '5471538618');
  assert.equal(found?.checkSelector, 'idd-advisory-convergence');
});

test('findReusableWaiverComment never reuses a marker the shared parser rejected (#2328)', () => {
  const comments = [
    waiverComment({ id: 1, createdAt: '2026-08-30T22:05:01Z' }),
  ];
  // An expired, wrong-HEAD, or wrong-claim waiver simply never reaches the
  // `valid` bucket, so an empty bucket must produce no reuse.
  assert.equal(
    findReusableWaiverComment({
      comments,
      evidence: evidenceWithValid([]),
      checkSelector: 'idd-advisory-convergence',
    }),
    null,
  );
});

test('findReusableWaiverComment does not cross selectors (#2328)', () => {
  const comments = [
    waiverComment({
      id: 1,
      createdAt: '2026-08-30T22:05:01Z',
      checkSelector: 'CodeRabbit',
    }),
  ];
  assert.equal(
    findReusableWaiverComment({
      comments,
      evidence: evidenceWithValid([
        {
          checkSelector: 'CodeRabbit',
          expiresAt: '2026-08-31T10:00:00Z',
          createdAt: '2026-08-30T22:05:01Z',
        },
      ]),
      checkSelector: 'idd-advisory-convergence',
    }),
    null,
  );
});

test('findReusableWaiverComment ignores non-waiver comments and empty input (#2328)', () => {
  const evidence = evidenceWithValid([
    {
      checkSelector: 'idd-advisory-convergence',
      expiresAt: '2026-08-31T10:00:00Z',
      createdAt: '2026-08-30T22:05:01Z',
    },
  ]);
  assert.equal(
    findReusableWaiverComment({
      comments: [
        { id: 9, created_at: '2026-08-30T22:00:00Z', body: 'looks good to me' },
      ],
      evidence,
      checkSelector: 'idd-advisory-convergence',
    }),
    null,
  );
  assert.equal(
    findReusableWaiverComment({
      comments: [],
      evidence,
      checkSelector: 'idd-advisory-convergence',
    }),
    null,
  );
  assert.equal(
    findReusableWaiverComment({
      comments: null,
      evidence: null,
      checkSelector: '',
    }),
    null,
  );
});

test('findReusableWaiverComment reuses regardless of a newly requested expiry (#2328)', () => {
  // The reused marker keeps its own expiry: a retry must never append an
  // indistinguishable duplicate carrying a different one, mirroring the
  // release-marker rule. Documented so the discarded request is not a
  // surprise.
  const comments = [
    waiverComment({
      id: 100,
      createdAt: '2026-08-30T22:05:01Z',
      expiresAt: '2026-08-31T10:00:00Z',
    }),
  ];
  const found = findReusableWaiverComment({
    comments,
    evidence: evidenceWithValid([
      {
        checkSelector: 'idd-advisory-convergence',
        expiresAt: '2026-08-31T10:00:00Z',
        createdAt: '2026-08-30T22:05:01Z',
      },
    ]),
    checkSelector: 'idd-advisory-convergence',
  });

  assert.equal(found?.commentId, '100');
  assert.equal(found?.expiresAt, '2026-08-31T10:00:00Z');
});

test('runExternalCheckWaiver posts nothing when it reuses an existing waiver (#2328)', async () => {
  let postCalls = 0;
  const comments = [
    waiverComment({
      id: 100,
      createdAt: '2026-08-30T22:05:01Z',
      checkSelector: 'idd-advisory-convergence',
      claimId: 'claim-20260830T222316Z-2328',
      headSha: REUSE_HEAD_SHA,
    }),
  ];

  const { report } = await runExternalCheckWaiver({
    args: {
      ...parseArgs([
        '--pr',
        '2325',
        '--check',
        'idd-advisory-convergence',
        '--reason',
        'rate limit',
        '--expires-in',
        'PT8H',
        '--apply',
        '--yes',
        '--allow-closed-precondition',
      ]),
      repo: 'kurone-kito/idd-skill',
      issueNumber: 2328,
    },
    actor: 'kurone-kito',
    authority: { known: true, permission: 'admin', roleName: 'admin' },
    pr: {
      number: 2325,
      state: 'OPEN',
      url: 'https://github.com/kurone-kito/idd-skill/pull/2325',
      headRefName: 'issue/2328-fix-external-check-waiver-refuse-waiver',
      headRefOid: REUSE_HEAD_SHA,
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'idd-advisory-convergence',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
        },
      ],
    },
    issueCandidates: [
      {
        number: 2328,
        url: 'https://github.com/kurone-kito/idd-skill/issues/2328',
        activeClaim: {
          agentId: 'claude-6043e89f',
          claimId: 'claim-20260830T222316Z-2328',
          supersedes: 'none',
          branch: 'issue/2328-fix-external-check-waiver-refuse-waiver',
          createdAt: '2026-08-30T22:23:26Z',
        },
      },
    ],
    prComments: comments,
    headCommittedAt: '2026-08-30T18:13:24Z',
    now: new Date('2026-08-30T22:30:00Z'),
    isTTY: false,
    postComment: () => {
      postCalls += 1;
      return { html_url: 'should-not-be-reached' };
    },
  });

  // The AC clause this covers directly: nothing is appended, so the pull
  // request's comment count is unchanged.
  assert.equal(postCalls, 0);
  assert.equal(report?.applied, false);
  assert.equal(report?.reusedWaiver?.commentId, '100');
  assert.match(String(report?.commentUrl), /issuecomment-100$/);
});

test('the deadline reader rejects a schema-invalid advisoryWait section (#2328 review)', () => {
  // The gate validates the whole `advisoryWait` subtree and falls back to the
  // 24h default when any sibling key is invalid. Resolving the deadline
  // without that validation would report 540 where the gate reports 1440,
  // reproducing the disagreement this issue removes.
  const dir = mkdtempSync(join(tmpdir(), 'idd-waiver-deadline-'));
  try {
    const good = join(dir, 'good.json');
    writeFileSync(
      good,
      JSON.stringify({ advisoryWait: { convergenceDeadline: 'PT9H' } }),
    );
    assert.equal(readAdvisoryConvergenceDeadlineMinutes(good), 540);

    const poisoned = join(dir, 'poisoned.json');
    writeFileSync(
      poisoned,
      JSON.stringify({
        advisoryWait: { convergenceDeadline: 'PT9H', requestCap: 'bad' },
      }),
    );
    assert.equal(
      readAdvisoryConvergenceDeadlineMinutes(poisoned),
      1440,
      'an invalid sibling must sink the whole section, as the gate does',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runExternalCheckWaiver fails closed when the comment list cannot be read (#2328 review)', async () => {
  let postCalls = 0;
  await assert.rejects(
    runExternalCheckWaiver({
      args: {
        ...parseArgs([
          '--pr',
          '2325',
          '--check',
          'idd-advisory-convergence',
          '--reason',
          'rate limit',
          '--expires-in',
          'PT8H',
          '--apply',
          '--yes',
          '--allow-closed-precondition',
        ]),
        repo: 'kurone-kito/idd-skill',
        issueNumber: 2328,
      },
      actor: 'kurone-kito',
      authority: { known: true, permission: 'admin', roleName: 'admin' },
      pr: {
        number: 2325,
        state: 'OPEN',
        url: 'https://github.com/kurone-kito/idd-skill/pull/2325',
        headRefName: 'issue/2328-fix-external-check-waiver-refuse-waiver',
        headRefOid: REUSE_HEAD_SHA,
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            name: 'idd-advisory-convergence',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
          },
        ],
      },
      issueCandidates: [
        {
          number: 2328,
          url: 'https://github.com/kurone-kito/idd-skill/issues/2328',
          activeClaim: {
            agentId: 'claude-6043e89f',
            claimId: 'claim-20260830T222316Z-2328',
            supersedes: 'none',
            branch: 'issue/2328-fix-external-check-waiver-refuse-waiver',
            createdAt: '2026-08-30T22:23:26Z',
          },
        },
      ],
      prComments: () => {
        throw new Error('gh api failed');
      },
      headCommittedAt: '2026-08-30T18:13:24Z',
      now: new Date('2026-08-30T22:30:00Z'),
      isTTY: false,
      postComment: () => {
        postCalls += 1;
        return { html_url: 'should-not-be-reached' };
      },
    }),
  );
  // An unreadable list must never be read as "no existing waiver": posting
  // then would recreate the duplicate this change removes.
  assert.equal(postCalls, 0);
});
