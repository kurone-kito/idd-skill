import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readAdvisoryConvergenceDeadlineMinutes,
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
} from '../src/scripts/advisory-wait-policy.mts';
import {
  buildTrustedMarkerLogins,
  collectValidWaiverComments,
  deriveGhApiStatusFromError,
  findReusableWaiverComment,
  parseArgs,
  planExternalCheckWaiver,
  resolveActorLogin,
  runExternalCheckWaiver,
} from '../src/scripts/external-check-waiver.mts';
import { operationalMarkerPrefix } from '../src/scripts/marker-helpers.mts';
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
    runId: '',
  });
  assert.match(body, /check:Copilot%20code%20review/);
  assert.match(body, /reason:rate%20limit/);
});

test('renderExternalCheckWaiverComment/parseExternalCheckWaiverComment round-trip an optional run-id (kurone-kito/idd-skill#2657)', () => {
  const body = renderExternalCheckWaiverComment({
    actor: 'github-actions[bot]',
    agentId: 'claude-sonnet5',
    claimId: 'claim-123',
    headSha: 'a'.repeat(40),
    checkSelector: 'idd-advisory-convergence',
    reason: 'self-referential-bootstrap-auto',
    expiresAt: '2026-05-18T00:00:00Z',
    runId: '123456789',
  });

  assert.match(body, / run-id:123456789 -->/);

  const parsed = parseExternalCheckWaiverComment(body, '2026-05-17T00:00:00Z');
  assert.deepEqual(parsed, {
    agentId: 'claude-sonnet5',
    claimId: 'claim-123',
    headSha: 'a'.repeat(40),
    checkSelector: 'idd-advisory-convergence',
    reason: 'self-referential-bootstrap-auto',
    expiresAt: '2026-05-18T00:00:00Z',
    createdAt: '2026-05-17T00:00:00Z',
    runId: '123456789',
  });
});

test('parseExternalCheckWaiverComment ignores a missing run-id (backward compatible)', () => {
  const legacyBody =
    '<!-- idd-external-check-waiver: codex-cli claim-123 ' +
    `${'a'.repeat(40)} check:CodeRabbit reason:rate%20limit ` +
    'expires:2026-05-18T00:00:00Z -->';
  const parsed = parseExternalCheckWaiverComment(
    legacyBody,
    '2026-05-17T00:00:00Z',
  );
  assert.equal(parsed?.runId, '');
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

// --- kurone-kito/idd-skill#2657: --auto-bootstrap self-referential waiver ---

function buildAutoBootstrapInput(): BaseInput {
  const input = buildAdvisoryConvergenceInput();
  input.autoBootstrap = true;
  input.reason = SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON;
  input.runId = '123456789';
  // No human actor/authority for this mode -- the trust model is the
  // consumer-side run-id/event-type check, not a collaborator permission.
  input.actor = '';
  input.authority = {};
  return input;
}

test('planExternalCheckWaiver: --auto-bootstrap skips the authority check entirely', () => {
  const report = planExternalCheckWaiver(buildAutoBootstrapInput(), {
    now: new Date('2026-08-31T03:13:24Z'), // after the deadline, for simplicity
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, true);
  assert.equal(report.actor.known, false); // reported honestly, just never blocked on
});

test('planExternalCheckWaiver: --auto-bootstrap bypasses the closed deadline-hatch precondition', () => {
  const report = planExternalCheckWaiver(buildAutoBootstrapInput(), {
    // Well before the deadline -- the ordinary path (#2328 tests above)
    // blocks here; auto-bootstrap must not.
    now: new Date('2026-08-30T22:02:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.advisoryConvergenceWaiverPrecondition?.open, false);
  assert.equal(report.canApply, true);
});

test('planExternalCheckWaiver: --auto-bootstrap requires the exact dedicated reason token', () => {
  const input = buildAutoBootstrapInput();
  input.reason = 'some-other-reason';

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-08-31T03:13:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(
    report.blockingReasons.join(' | '),
    /requires reason to be exactly "self-referential-bootstrap-auto"/,
  );
});

test('planExternalCheckWaiver: rejects the reserved auto-bootstrap reason outside --auto-bootstrap (Codex review, PR #2895)', () => {
  // summarizeExternalCheckWaivers now deliberately excludes every marker
  // with this exact reason from generic waiver evidence, so an operator
  // who copies the documented command but omits --auto-bootstrap would
  // otherwise get a successful "applied: true" report for a marker no
  // consumer can ever honor, even past any deadline.
  const input = buildBaseInput();
  input.reason = SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON;

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-05-17T00:00:00Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(
    report.blockingReasons.join(' | '),
    /reason "self-referential-bootstrap-auto" is reserved for --auto-bootstrap/,
  );
});

test('planExternalCheckWaiver: --auto-bootstrap requires a run id', () => {
  const input = buildAutoBootstrapInput();
  input.runId = '';

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-08-31T03:13:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join(' | '), /requires a run id/);
});

test('planExternalCheckWaiver: --auto-bootstrap cannot be combined with --claimless', () => {
  const input = buildAutoBootstrapInput();
  input.claimless = true;

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-08-31T03:13:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(
    report.blockingReasons.join(' | '),
    /cannot be combined with --claimless/,
  );
});

test('planExternalCheckWaiver: --auto-bootstrap falls back to a claimless (none) binding when no linked issue resolves (Codex review, PR #2895)', () => {
  // A fully claimless allowlisted PR under the template default
  // `advisoryWait.convergenceScope: "all-prs"` -- no closing issue at all,
  // so `issueCandidates` resolves nothing. The real workflow invocation
  // always sets `actor = 'github-actions[bot]'` for --auto-bootstrap
  // (runExternalCheckWaiver), unlike buildAutoBootstrapInput()'s simplified
  // empty actor used by the authority-skip tests above.
  const input = buildAutoBootstrapInput();
  input.issueCandidates = [];
  input.actor = 'github-actions[bot]';

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-08-31T03:13:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, true);
  assert.equal(report.linkedIssue, null);
  const parsed = parseExternalCheckWaiverComment(
    report.body,
    '2026-08-31T03:13:24Z',
  );
  assert.equal(parsed?.claimId, 'none');
  assert.equal(parsed?.agentId, 'github-actions[bot]');
  assert.equal(parsed?.reason, SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON);
  assert.equal(parsed?.runId, '123456789');
});

test('planExternalCheckWaiver: --auto-bootstrap still blocks on an empty actor when no linked issue resolves (Codex review, PR #2895)', () => {
  // buildAutoBootstrapInput()'s own default actor (''), simulating a direct
  // caller (e.g. a test or a future integration) that constructs the
  // autoBootstrap input by hand without also supplying an actor -- the
  // real CLI path always supplies 'github-actions[bot]' (see above), but
  // the claimless fallback must not silently produce an unbindable marker.
  const input = buildAutoBootstrapInput();
  input.issueCandidates = [];

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-08-31T03:13:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join(' | '), /actor is empty/);
});

test('planExternalCheckWaiver: --auto-bootstrap still blocks an ambiguous multi-issue PR (Codex review, PR #2895)', () => {
  // Two candidates instead of zero -- the OTHER selectLinkedIssueCandidate
  // failure reason. The auto-bootstrap fallback binds claimless whenever no
  // SINGLE claim resolves, ambiguous or absent alike; the consumer-side
  // `none`-sentinel match only ever succeeds on a genuinely claimless PR
  // (protocol-helpers.mts), so this stays safe even though it is a
  // different `selectLinkedIssueCandidate` reason than the fully-absent
  // case above.
  const input = buildAutoBootstrapInput();
  input.actor = 'github-actions[bot]';
  const [issue] = input.issueCandidates;
  input.issueCandidates = [
    issue,
    { ...issue, number: Number(issue.number) + 1 },
  ];

  const report = planExternalCheckWaiver(input, {
    now: new Date('2026-08-31T03:13:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, true);
  assert.equal(report.linkedIssue, null);
  const parsed = parseExternalCheckWaiverComment(
    report.body,
    '2026-08-31T03:13:24Z',
  );
  assert.equal(parsed?.claimId, 'none');
});

test('planExternalCheckWaiver: --auto-bootstrap renders the run-id field into the marker body', () => {
  const report = planExternalCheckWaiver(buildAutoBootstrapInput(), {
    now: new Date('2026-08-31T03:13:24Z'),
    repoOwner: 'kurone-kito',
  });

  assert.equal(report.canApply, true);
  assert.match(report.body, / run-id:123456789 -->/);
  const parsed = parseExternalCheckWaiverComment(
    report.body,
    '2026-08-31T03:13:24Z',
  );
  assert.equal(parsed?.runId, '123456789');
  assert.equal(parsed?.reason, SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON);
  // Binds to the linked issue's REAL active claim, never `none`.
  assert.equal(parsed?.claimId, 'claim-20260517T060713Z-667-7f8f9c0d');
});

test('parseArgs: --auto-bootstrap requires --run-id, the dedicated --reason, and rejects an explicit expiry', () => {
  const base = [
    '--pr',
    '5',
    '--check',
    'idd-advisory-convergence',
    '--reason',
    SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
    '--run-id',
    '999',
  ];
  assert.equal(parseArgs([...base, '--auto-bootstrap']).autoBootstrap, true);
  assert.equal(parseArgs([...base, '--auto-bootstrap']).runId, '999');

  assert.throws(
    () =>
      parseArgs([
        '--pr',
        '5',
        '--check',
        'idd-advisory-convergence',
        '--reason',
        SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        '--auto-bootstrap',
      ]),
    /requires --run-id/,
  );
  assert.throws(
    () =>
      parseArgs([
        '--pr',
        '5',
        '--check',
        'idd-advisory-convergence',
        '--reason',
        'a-different-reason',
        '--run-id',
        '999',
        '--auto-bootstrap',
      ]),
    /requires --reason self-referential-bootstrap-auto/,
  );
  assert.throws(
    () => parseArgs([...base, '--auto-bootstrap', '--expires-in', 'PT2H']),
    /do not pass --expires or --expires-in/,
  );
  assert.throws(
    () => parseArgs([...base, '--auto-bootstrap', '--claimless']),
    /cannot be combined with --claimless/,
  );
});

test('parseArgs: --auto-bootstrap defaults off, and --run-id defaults empty', () => {
  const parsed = parseArgs(['--pr', '5', '--check', 'x', '--reason', 'y']);
  assert.equal(parsed.autoBootstrap, false);
  assert.equal(parsed.runId, '');
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

// --- #2328 review: the check-then-post race ---------------------------------
// The reuse scan and the POST are not one atomic step, and GitHub comments
// have no compare-and-swap. Two concurrent applies can both see no waiver and
// both post, so the duplicate is reconciled after the fact instead.

test('collectValidWaiverComments returns every valid marker, earliest first (#2328 review)', () => {
  const comments = [
    waiverComment({ id: 200, createdAt: '2026-08-30T22:05:13Z' }),
    waiverComment({ id: 100, createdAt: '2026-08-30T22:05:01Z' }),
  ];
  const found = collectValidWaiverComments({
    comments,
    evidence: evidenceWithValid([
      {
        checkSelector: 'idd-advisory-convergence',
        expiresAt: '2026-08-31T10:00:00Z',
        createdAt: '2026-08-30T22:05:01Z',
      },
      {
        checkSelector: 'idd-advisory-convergence',
        expiresAt: '2026-08-31T10:00:00Z',
        createdAt: '2026-08-30T22:05:13Z',
      },
    ]),
    checkSelector: 'idd-advisory-convergence',
  });

  assert.deepEqual(
    found.map((entry) => entry.commentId),
    ['100', '200'],
  );
  // The reuse scan is the first element of this same list, so the two can
  // never disagree about which marker is authoritative.
  assert.equal(
    findReusableWaiverComment({
      comments,
      evidence: evidenceWithValid([
        {
          checkSelector: 'idd-advisory-convergence',
          expiresAt: '2026-08-31T10:00:00Z',
          createdAt: '2026-08-30T22:05:01Z',
        },
      ]),
      checkSelector: 'idd-advisory-convergence',
    })?.commentId,
    '100',
  );
});

test('runExternalCheckWaiver reports a waiver that raced its own post (#2328 review)', async () => {
  let reads = 0;
  const raced = waiverComment({
    id: 300,
    createdAt: '2026-08-30T22:29:00Z',
    claimId: 'claim-20260830T222316Z-2328',
  });
  const mine = waiverComment({
    id: 400,
    createdAt: '2026-08-30T22:30:00Z',
    claimId: 'claim-20260830T222316Z-2328',
  });

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
    // First read: empty, so the reuse scan lets the post through. Later
    // reads: a competitor's marker plus this run's own — the race.
    prComments: () => {
      reads += 1;
      return reads === 1 ? [] : [raced, mine];
    },
    headCommittedAt: '2026-08-30T18:13:24Z',
    now: new Date('2026-08-30T22:30:00Z'),
    isTTY: false,
    postComment: () => ({ html_url: 'https://example.invalid/posted' }),
  });

  assert.equal(report?.applied, true);
  assert.deepEqual(
    report?.concurrentWaivers?.map((entry) => entry.commentId),
    ['300', '400'],
  );
});

test('runExternalCheckWaiver reports no race when its own marker stands alone (#2328 review)', async () => {
  let reads = 0;
  const mine = waiverComment({
    id: 400,
    createdAt: '2026-08-30T22:30:00Z',
    claimId: 'claim-20260830T222316Z-2328',
  });

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
    prComments: () => {
      reads += 1;
      return reads === 1 ? [] : [mine];
    },
    headCommittedAt: '2026-08-30T18:13:24Z',
    now: new Date('2026-08-30T22:30:00Z'),
    isTTY: false,
    postComment: () => ({ html_url: 'https://example.invalid/posted' }),
  });

  assert.equal(report?.applied, true);
  assert.equal(report?.concurrentWaivers, undefined);
});

test('runExternalCheckWaiver: --auto-bootstrap posts end to end with no viewer-identity or collaborator-authority lookup', async () => {
  let posted: { prNumber: number; body: string } | undefined;

  const { report } = await runExternalCheckWaiver({
    args: {
      ...parseArgs([
        '--pr',
        '2325',
        '--check',
        'idd-advisory-convergence',
        '--reason',
        SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        '--run-id',
        '555',
        '--auto-bootstrap',
        '--apply',
        '--yes',
      ]),
      repo: 'kurone-kito/idd-skill',
    },
    // Deliberately NOT supplying options.actor/options.authority: an
    // auto-bootstrap run must never need either, so a bug that reintroduces
    // a `gh api user` or collaborator-permission call would surface as a
    // real subprocess spawn attempt in this test's sandbox instead of
    // silently passing.
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
    prComments: () => [],
    headCommittedAt: '2026-08-30T18:13:24Z',
    now: new Date('2026-08-30T18:20:00Z'), // well before the deadline
    isTTY: false,
    postComment: (prNumber, body) => {
      posted = { prNumber, body };
      return { html_url: 'https://example.invalid/posted' };
    },
  });

  assert.equal(report?.applied, true);
  assert.equal(report?.actor.known, false); // no authority check ever ran
  assert.equal(posted?.prNumber, 2325);
  assert.match(posted?.body ?? '', /reason:self-referential-bootstrap-auto/);
  assert.match(posted?.body ?? '', / run-id:555 -->/);
  const parsed = parseExternalCheckWaiverComment(
    posted?.body ?? '',
    '2026-08-30T18:20:00Z',
  );
  // The fixed PT24H window anchored on the HEAD commit timestamp, not
  // caller-suppliable and independent of advisoryWait.convergenceDeadline.
  assert.equal(parsed?.expiresAt, '2026-08-31T18:13:24Z');
  assert.equal(parsed?.claimId, 'claim-20260830T222316Z-2328');
});

test('runExternalCheckWaiver: --auto-bootstrap never reuses an existing same-reason marker, even one with no verifiable run-id (Codex review, PR #2895, round 2)', async () => {
  // kurone-kito/idd-skill#2657: the generic reuse scan correlates on
  // `reason` but never validates a candidate's `run-id:` against the
  // Actions Runs API. A forged marker with the exact
  // self-referential-bootstrap-auto reason token but no run-id (or an
  // unverifiable one) would previously still be accepted as "reusable",
  // causing this job to skip posting its own valid, run-bound marker --
  // silently leaving the required check red once the consumer correctly
  // rejects the unverifiable reused one. Reuse must be disabled entirely
  // for --auto-bootstrap, so this must always attempt to post regardless
  // of what is already present.
  const forgedMarker = {
    id: 900,
    html_url:
      'https://github.com/kurone-kito/idd-skill/pull/2325#issuecomment-900',
    created_at: '2026-08-30T18:15:00Z',
    user: { login: 'github-actions[bot]' },
    body: renderExternalCheckWaiverComment({
      actor: 'github-actions[bot]',
      agentId: 'github-actions-bot',
      claimId: 'claim-20260830T222316Z-2328',
      headSha: REUSE_HEAD_SHA,
      checkSelector: 'idd-advisory-convergence',
      reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
      expiresAt: '2099-01-01T00:00:00Z',
      // Deliberately no run-id: the forged-marker shape this fix defends
      // against never has a verifiable one.
    }),
  };
  let posted: { prNumber: number; body: string } | undefined;

  const { report } = await runExternalCheckWaiver({
    args: {
      ...parseArgs([
        '--pr',
        '2325',
        '--check',
        'idd-advisory-convergence',
        '--reason',
        SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        '--run-id',
        '555',
        '--auto-bootstrap',
        '--apply',
        '--yes',
      ]),
      repo: 'kurone-kito/idd-skill',
    },
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
    prComments: () => [forgedMarker],
    headCommittedAt: '2026-08-30T18:13:24Z',
    now: new Date('2026-08-30T18:20:00Z'),
    isTTY: false,
    postComment: (prNumber, body) => {
      posted = { prNumber, body };
      return { html_url: 'https://example.invalid/posted' };
    },
  });

  assert.equal(
    report?.applied,
    true,
    'must post its own marker instead of reusing the pre-existing same-reason one',
  );
  assert.equal(report?.reusedWaiver, undefined);
  assert.equal(posted?.prNumber, 2325);
  assert.match(posted?.body ?? '', / run-id:555 -->/);
});

function autoBootstrapWaiverComment({
  id,
  createdAt,
  runId,
}: {
  id: number;
  createdAt: string;
  runId: string;
}) {
  return {
    id,
    html_url: `https://github.com/kurone-kito/idd-skill/pull/2325#issuecomment-${id}`,
    created_at: createdAt,
    user: { login: 'github-actions[bot]' },
    body: renderExternalCheckWaiverComment({
      actor: 'github-actions[bot]',
      agentId: 'github-actions-bot',
      claimId: 'claim-20260830T222316Z-2328',
      headSha: REUSE_HEAD_SHA,
      checkSelector: 'idd-advisory-convergence',
      reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
      // Within the configured PT24H maxValidity of `createdAt`, unlike the
      // deliberately far-future expiry other fixtures in this file use for
      // tests that don't care about `evidence.valid` classification -- this
      // one does, and a maxValidity-violating expiry lands in `expired`
      // instead (summarizeExternalCheckWaivers's own re-enforcement of the
      // configured window at consume time), never reaching `valid` at all.
      expiresAt: '2026-08-31T10:00:00Z',
      runId,
    }),
  };
}

test('runExternalCheckWaiver: --auto-bootstrap detects a concurrent duplicate auto-bootstrap post (Copilot review, PR #2895)', async () => {
  // The pre-write reuse scan is disabled entirely for --auto-bootstrap (see
  // that call site's own doc comment), so the post-write reconcile below is
  // the ONLY concurrent-duplicate detection this mode has. Before this fix,
  // `buildWaiverEvidence`'s summarizeExternalCheckWaivers call left
  // `allowSelfReferentialBootstrapAuto` unset, so it excluded EVERY
  // self-referential-bootstrap-auto-reasoned marker from `evidence.valid`
  // -- including the one this very invocation just posted -- making
  // `concurrentWaivers` always empty for this mode regardless of how many
  // concurrent posts actually raced. Mirrors the ordinary-waiver race test
  // above ("reports a waiver that raced its own post"), scoped to
  // --auto-bootstrap instead.
  let reads = 0;
  const raced = autoBootstrapWaiverComment({
    id: 300,
    createdAt: '2026-08-30T18:19:00Z',
    runId: '111',
  });
  const mine = autoBootstrapWaiverComment({
    id: 400,
    createdAt: '2026-08-30T18:20:00Z',
    runId: '555',
  });

  const { report } = await runExternalCheckWaiver({
    args: {
      ...parseArgs([
        '--pr',
        '2325',
        '--check',
        'idd-advisory-convergence',
        '--reason',
        SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        '--run-id',
        '555',
        '--auto-bootstrap',
        '--apply',
        '--yes',
      ]),
      repo: 'kurone-kito/idd-skill',
    },
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
    // First read: empty (pre-write is skipped for --auto-bootstrap anyway).
    // Post-write reconcile read: the competitor's marker plus this run's
    // own -- the race.
    prComments: () => {
      reads += 1;
      return reads === 1 ? [] : [raced, mine];
    },
    headCommittedAt: '2026-08-30T18:13:24Z',
    now: new Date('2026-08-30T18:20:00Z'),
    isTTY: false,
    postComment: () => ({ html_url: 'https://example.invalid/posted' }),
  });

  assert.equal(report?.applied, true);
  assert.deepEqual(
    report?.concurrentWaivers?.map((entry) => entry.commentId),
    ['300', '400'],
  );
});

test('runExternalCheckWaiver: --auto-bootstrap exits 0 (graceful skip) when the adopter has not opted into the waiver policy (Codex review, PR #2895)', async () => {
  // The distributed template's own shipped .github/idd/config.json omits
  // ciGate entirely, so an adopter who hosts this workflow without ALSO
  // opting into ciGate.externalCheckWaivers.mode: "maintainer-authorized"
  // and registering this selector under ciGate.externalChecks.waivable
  // would otherwise have this job fail on every single
  // allowlisted-touching PR. This must be a graceful no-op, not a
  // thrown error, for --auto-bootstrap specifically.
  const dir = mkdtempSync(join(tmpdir(), 'idd-waiver-auto-bootstrap-skip-'));
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(dir, '.github', 'idd'), { recursive: true });
    // No ciGate key at all -- matches the shipped template default
    // exactly.
    writeFileSync(join(dir, '.github', 'idd', 'config.json'), '{}');
    process.chdir(dir);

    let postCalls = 0;
    const { exitCode, report } = await runExternalCheckWaiver({
      args: {
        ...parseArgs([
          '--pr',
          '2325',
          '--check',
          'idd-advisory-convergence',
          '--reason',
          SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
          '--run-id',
          '555',
          '--auto-bootstrap',
          '--apply',
          '--yes',
        ]),
        repo: 'kurone-kito/idd-skill',
      },
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
      prComments: () => [],
      headCommittedAt: '2026-08-30T18:13:24Z',
      now: new Date('2026-08-30T18:20:00Z'),
      isTTY: false,
      postComment: () => {
        postCalls += 1;
        return { html_url: 'https://example.invalid/posted' };
      },
    });

    assert.equal(
      exitCode,
      0,
      'must exit 0, not throw, for a config-only block',
    );
    assert.equal(report?.applied, false);
    assert.equal(postCalls, 0);
    assert.ok(
      report?.blockingReasons?.includes(
        'external-check waiver mode is disabled',
      ),
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runExternalCheckWaiver: --auto-bootstrap still throws on a genuine blocking reason, not only a config-only one (Codex review, PR #2895)', async () => {
  // The graceful skip above must stay narrowly scoped to the two known
  // adopter-configuration-only reasons -- a REAL problem (here: the PR
  // itself is closed) must still surface as a thrown error, exactly as
  // before.
  const dir = mkdtempSync(join(tmpdir(), 'idd-waiver-auto-bootstrap-real-'));
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(dir, '.github', 'idd'), { recursive: true });
    writeFileSync(join(dir, '.github', 'idd', 'config.json'), '{}');
    process.chdir(dir);

    await assert.rejects(
      () =>
        runExternalCheckWaiver({
          args: {
            ...parseArgs([
              '--pr',
              '2325',
              '--check',
              'idd-advisory-convergence',
              '--reason',
              SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
              '--run-id',
              '555',
              '--auto-bootstrap',
              '--apply',
              '--yes',
            ]),
            repo: 'kurone-kito/idd-skill',
          },
          pr: {
            number: 2325,
            state: 'CLOSED',
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
          prComments: () => [],
          headCommittedAt: '2026-08-30T18:13:24Z',
          now: new Date('2026-08-30T18:20:00Z'),
          isTTY: false,
          postComment: () => ({ html_url: 'https://example.invalid/posted' }),
        }),
      /is not open/,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runExternalCheckWaiver: --auto-bootstrap clamps its fixed expiry to a configured shorter maxValidity (Codex review, PR #2895)', async () => {
  // The fixed PT24H default is anchored on the HEAD commit timestamp
  // independent of `advisoryWait.convergenceDeadline` (see the test above),
  // but `planExternalCheckWaiver`'s own `withinMaxValidity` check compares
  // whatever expiry is computed against the adopter's configured
  // `ciGate.externalCheckWaivers.maxValidity` -- unconditionally, for every
  // waiver kind. An adopter configuring a STRICTER maximum than PT24H (e.g.
  // PT2H) would therefore have every auto-bootstrap marker rejected by its
  // own posting job unless the computation clamps to that configured
  // ceiling instead of always using the fixed default.
  const dir = mkdtempSync(join(tmpdir(), 'idd-waiver-auto-bootstrap-clamp-'));
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(dir, '.github', 'idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'idd', 'config.json'),
      JSON.stringify({
        ciGate: {
          externalCheckWaivers: {
            mode: 'maintainer-authorized',
            maxValidity: 'PT2H',
          },
          externalChecks: {
            waivable: [
              { selector: 'idd-advisory-convergence', matchMode: 'exact' },
            ],
          },
        },
      }),
    );
    process.chdir(dir);

    let posted: { prNumber: number; body: string } | undefined;
    const { report } = await runExternalCheckWaiver({
      args: {
        ...parseArgs([
          '--pr',
          '2325',
          '--check',
          'idd-advisory-convergence',
          '--reason',
          SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
          '--run-id',
          '555',
          '--auto-bootstrap',
          '--apply',
          '--yes',
        ]),
        repo: 'kurone-kito/idd-skill',
      },
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
      prComments: () => [],
      headCommittedAt: '2026-08-30T18:13:24Z',
      now: new Date('2026-08-30T18:20:00Z'),
      isTTY: false,
      postComment: (prNumber, body) => {
        posted = { prNumber, body };
        return { html_url: 'https://example.invalid/posted' };
      },
    });

    assert.equal(
      report?.applied,
      true,
      'a shorter configured maxValidity must not block the clamped auto-bootstrap marker',
    );
    const parsed = parseExternalCheckWaiverComment(
      posted?.body ?? '',
      '2026-08-30T18:20:00Z',
    );
    // Clamped to PT2H from the HEAD commit timestamp, not the fixed PT24H
    // default the un-clamped test above pins.
    assert.equal(parsed?.expiresAt, '2026-08-30T20:13:24Z');
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runExternalCheckWaiver: --auto-bootstrap anchors expiry on "now" when the HEAD commit timestamp is stale (CodeRabbit review, PR #2895)', async () => {
  // A pull_request_target `reopened` trigger can fire with no new commit,
  // so the HEAD commit timestamp can be far older than "now" for a
  // long-stale PR. Anchoring purely on that HEAD timestamp would compute
  // an expiry already in the past, which planExternalCheckWaiver's own
  // "expiry must be in the future" check rejects -- silently blocking the
  // auto-bootstrap post in exactly the stale-reopen scenario the
  // workflow's own trigger list invites.
  let posted: { prNumber: number; body: string } | undefined;
  const { report } = await runExternalCheckWaiver({
    args: {
      ...parseArgs([
        '--pr',
        '2325',
        '--check',
        'idd-advisory-convergence',
        '--reason',
        SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        '--run-id',
        '555',
        '--auto-bootstrap',
        '--apply',
        '--yes',
      ]),
      repo: 'kurone-kito/idd-skill',
    },
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
    prComments: () => [],
    // A week old relative to `now` below -- HEAD + PT24H would be
    // 2026-08-26T18:13:24Z, days in the past relative to `now`.
    headCommittedAt: '2026-08-25T18:13:24Z',
    now: new Date('2026-09-01T12:00:00Z'),
    isTTY: false,
    postComment: (prNumber, body) => {
      posted = { prNumber, body };
      return { html_url: 'https://example.invalid/posted' };
    },
  });

  assert.equal(
    report?.applied,
    true,
    'a stale HEAD commit timestamp must not block the auto-bootstrap marker',
  );
  const parsed = parseExternalCheckWaiverComment(
    posted?.body ?? '',
    '2026-09-01T12:00:00Z',
  );
  // Anchored on "now" (2026-09-01T12:00:00Z) + PT24H, not the stale HEAD
  // commit timestamp.
  assert.equal(parsed?.expiresAt, '2026-09-02T12:00:00Z');
});

test('runExternalCheckWaiver reads one post-write snapshot for the reconcile (#2328 review)', async () => {
  // Two sequential reads would leave `comments` older than `evidence`, and
  // the correlation can only find markers present in `comments` — so a
  // waiver landing between them would be dropped and the duplicate missed.
  // Counting reads pins the single-snapshot contract: one before the post,
  // one after.
  let reads = 0;
  const raced = waiverComment({
    id: 300,
    createdAt: '2026-08-30T22:29:00Z',
    claimId: 'claim-20260830T222316Z-2328',
  });
  const mine = waiverComment({
    id: 400,
    createdAt: '2026-08-30T22:30:00Z',
    claimId: 'claim-20260830T222316Z-2328',
  });

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
    // Read 1 (pre-write): empty. Read 2 (post-write): the race. A third
    // read would mean the reconcile took two snapshots, which is the defect.
    prComments: () => {
      reads += 1;
      if (reads === 1) return [];
      if (reads === 2) return [raced, mine];
      throw new Error(`reconcile took ${reads} snapshots; expected exactly 2`);
    },
    headCommittedAt: '2026-08-30T18:13:24Z',
    now: new Date('2026-08-30T22:30:00Z'),
    isTTY: false,
    postComment: () => ({ html_url: 'https://example.invalid/posted' }),
  });

  assert.equal(reads, 2, 'exactly one pre-write and one post-write read');
  assert.deepEqual(
    report?.concurrentWaivers?.map((entry) => entry.commentId),
    ['300', '400'],
  );
});

test('runExternalCheckWaiver keeps the applied result when the reconcile read fails (#2328 review)', async () => {
  // Fail-closed is correct before the post, where an unreadable list can
  // cause a duplicate. After it the write already happened and is
  // irreversible, so throwing would report a failed apply for successful
  // work and withhold the comment URL.
  let reads = 0;
  const { report, exitCode } = await runExternalCheckWaiver({
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
    // Read 1 (pre-write) succeeds and lets the post through; read 2
    // (post-write reconcile) fails.
    prComments: () => {
      reads += 1;
      if (reads === 1) return [];
      throw new Error('gh api failed');
    },
    headCommittedAt: '2026-08-30T18:13:24Z',
    now: new Date('2026-08-30T22:30:00Z'),
    isTTY: false,
    postComment: () => ({ html_url: 'https://example.invalid/posted' }),
  });

  assert.equal(exitCode, 0);
  assert.equal(report?.applied, true);
  assert.equal(report?.commentUrl, 'https://example.invalid/posted');
  assert.equal(report?.reconcileInconclusive, true);
  assert.equal(report?.concurrentWaivers, undefined);
});

test('collectValidWaiverComments does not correlate a same-second impostor (#2328 review)', () => {
  // `created_at` has second resolution. A valid maintainer waiver and an
  // unauthorized marker posted in the same second share selector, expiry, and
  // timestamp, so correlating on those three alone matches both against the
  // one valid entry: the reuse path could report the impostor as
  // authoritative, and the reconcile could invent a duplicate and point the
  // operator at the genuine marker to minimize.
  const sameSecond = '2026-08-30T22:05:01Z';
  const genuine = {
    ...waiverComment({ id: 100, createdAt: sameSecond }),
    user: { login: 'kurone-kito' },
  };
  const impostor = {
    ...waiverComment({ id: 101, createdAt: sameSecond }),
    user: { login: 'drive-by-contributor' },
  };

  const found = collectValidWaiverComments({
    // The impostor sorts first on a stable sort, so a correlation that
    // ignores the author would return it as the earliest.
    comments: [impostor, genuine],
    evidence: evidenceWithValid([
      {
        checkSelector: 'idd-advisory-convergence',
        expiresAt: '2026-08-31T10:00:00Z',
        createdAt: sameSecond,
      },
    ]),
    checkSelector: 'idd-advisory-convergence',
  });

  assert.deepEqual(
    found.map((entry) => entry.commentId),
    ['100'],
    'only the comment whose author matches the valid entry correlates',
  );
});

test('collectValidWaiverComments distinguishes entries by reason too (#2328 review)', () => {
  // Same author, selector, expiry, and second — different reason. Only the
  // marker whose reason matches the evidence entry is the valid one.
  const sameSecond = '2026-08-30T22:05:01Z';
  const matching = waiverComment({ id: 200, createdAt: sameSecond });
  const other = {
    ...matching,
    id: 201,
    body: renderExternalCheckWaiverComment({
      actor: 'kurone-kito',
      agentId: 'claude-6043e89f',
      claimId: 'claim-abc',
      headSha: REUSE_HEAD_SHA,
      checkSelector: 'idd-advisory-convergence',
      reason: 'a different reason',
      expiresAt: '2026-08-31T10:00:00Z',
    }),
  };

  const found = collectValidWaiverComments({
    comments: [other, matching],
    evidence: evidenceWithValid([
      {
        checkSelector: 'idd-advisory-convergence',
        expiresAt: '2026-08-31T10:00:00Z',
        createdAt: sameSecond,
      },
    ]),
    checkSelector: 'idd-advisory-convergence',
  });

  assert.deepEqual(
    found.map((entry) => entry.commentId),
    ['200'],
  );
});

test('collectValidWaiverComments with expectedReason excludes an otherwise-fully-valid candidate whose own reason does not match it (Codex review, PR #2895)', () => {
  // kurone-kito/idd-skill#2657: `--auto-bootstrap`'s reuse scan trusts
  // `github-actions[bot]` as a marker author (it is the viewer), so
  // WITHOUT `expectedReason` any other `github-actions[bot]`-authored,
  // same-selector marker -- e.g. one a PR-controlled `pull_request`
  // workflow could forge with a different reason -- would still correlate
  // against a genuinely `valid` evidence entry and be reported reusable.
  // `expectedReason` closes that: it is checked against the CANDIDATE
  // COMMENT's own parsed `reason`, independent of what the evidence entry
  // reports.
  const genuineReason = SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON;
  const forgedReason = 'a-forged-different-reason';
  const sameSecond = '2026-08-30T22:05:01Z';
  const forgedBody = renderExternalCheckWaiverComment({
    actor: 'github-actions[bot]',
    agentId: 'github-actions-bot',
    claimId: 'claim-abc',
    headSha: REUSE_HEAD_SHA,
    checkSelector: 'idd-advisory-convergence',
    reason: forgedReason,
    expiresAt: '2026-08-31T10:00:00Z',
  });
  const forged = {
    id: 300,
    html_url:
      'https://github.com/kurone-kito/idd-skill/pull/2325#issuecomment-300',
    created_at: sameSecond,
    user: { login: 'github-actions[bot]' },
    body: forgedBody,
  };
  const evidence = {
    valid: [
      {
        checkSelector: 'idd-advisory-convergence',
        expiresAt: '2026-08-31T10:00:00Z',
        createdAt: sameSecond,
        authorLogin: 'github-actions[bot]',
        // The evidence entry's own `reason` still reflects the forged
        // comment's actual reason -- `expectedReason` must reject this
        // independent of whether the summarizer happened to classify the
        // forged marker `valid` for some other selector/author reason.
        reason: forgedReason,
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
    modeDisabled: [],
  } as never;

  const withoutExpectedReason = collectValidWaiverComments({
    comments: [forged],
    evidence,
    checkSelector: 'idd-advisory-convergence',
  });
  assert.deepEqual(
    withoutExpectedReason.map((entry) => entry.commentId),
    ['300'],
    'sanity check: without expectedReason the forged marker correlates normally',
  );

  const withExpectedReason = collectValidWaiverComments({
    comments: [forged],
    evidence,
    checkSelector: 'idd-advisory-convergence',
    expectedReason: genuineReason,
  });
  assert.deepEqual(
    withExpectedReason,
    [],
    'expectedReason rejects a candidate whose own reason token does not match, even when evidence otherwise classifies it valid',
  );

  assert.equal(
    findReusableWaiverComment({
      comments: [forged],
      evidence,
      checkSelector: 'idd-advisory-convergence',
      expectedReason: genuineReason,
    }),
    null,
  );
});

test('collectValidWaiverComments with expectedReason still includes a candidate whose own reason matches it (Codex review, PR #2895)', () => {
  const reason = SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON;
  const createdAt = '2026-08-30T22:05:01Z';
  const body = renderExternalCheckWaiverComment({
    actor: 'github-actions[bot]',
    agentId: 'github-actions-bot',
    claimId: 'claim-abc',
    headSha: REUSE_HEAD_SHA,
    checkSelector: 'idd-advisory-convergence',
    reason,
    expiresAt: '2026-08-31T10:00:00Z',
  });
  const comment = {
    id: 400,
    html_url:
      'https://github.com/kurone-kito/idd-skill/pull/2325#issuecomment-400',
    created_at: createdAt,
    user: { login: 'github-actions[bot]' },
    body,
  };
  const evidence = {
    valid: [
      {
        checkSelector: 'idd-advisory-convergence',
        expiresAt: '2026-08-31T10:00:00Z',
        createdAt,
        authorLogin: 'github-actions[bot]',
        reason,
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
    modeDisabled: [],
  } as never;

  const found = collectValidWaiverComments({
    comments: [comment],
    evidence,
    checkSelector: 'idd-advisory-convergence',
    expectedReason: reason,
  });
  assert.deepEqual(
    found.map((entry) => entry.commentId),
    ['400'],
  );
});

test('collectValidWaiverComments rejects a wrong-HEAD or wrong-claim twin (#2328 review)', () => {
  // The summarizer keeps a wrong-HEAD or wrong-claim marker out of `valid`,
  // but the entry it produces for a genuine sibling carries no binding of its
  // own. A twin sharing author, reason, expiry, and second would therefore
  // still correlate to that entry unless the binding is checked directly.
  const sameSecond = '2026-08-30T22:05:01Z';
  const genuine = waiverComment({ id: 100, createdAt: sameSecond });
  const wrongHead = {
    ...genuine,
    id: 101,
    body: renderExternalCheckWaiverComment({
      actor: 'kurone-kito',
      agentId: 'claude-6043e89f',
      claimId: 'claim-abc',
      headSha: 'c'.repeat(40),
      checkSelector: 'idd-advisory-convergence',
      reason: 'rate limit',
      expiresAt: '2026-08-31T10:00:00Z',
    }),
  };
  const wrongClaim = {
    ...genuine,
    id: 102,
    body: renderExternalCheckWaiverComment({
      actor: 'kurone-kito',
      agentId: 'claude-6043e89f',
      claimId: 'claim-someone-else',
      headSha: REUSE_HEAD_SHA,
      checkSelector: 'idd-advisory-convergence',
      reason: 'rate limit',
      expiresAt: '2026-08-31T10:00:00Z',
    }),
  };
  const evidence = evidenceWithValid([
    {
      checkSelector: 'idd-advisory-convergence',
      expiresAt: '2026-08-31T10:00:00Z',
      createdAt: sameSecond,
    },
  ]);

  assert.deepEqual(
    collectValidWaiverComments({
      comments: [wrongHead, wrongClaim, genuine],
      evidence,
      checkSelector: 'idd-advisory-convergence',
      expectedHeadSha: REUSE_HEAD_SHA,
      allowedClaimIds: ['claim-abc'],
    }).map((entry) => entry.commentId),
    ['100'],
  );

  // The predecessor claim is accepted, matching the gate's one-hop takeover
  // exception, so a takeover does not append a second marker.
  assert.deepEqual(
    collectValidWaiverComments({
      comments: [wrongClaim, genuine],
      evidence,
      checkSelector: 'idd-advisory-convergence',
      expectedHeadSha: REUSE_HEAD_SHA,
      allowedClaimIds: ['claim-successor', 'claim-abc'],
    }).map((entry) => entry.commentId),
    ['100'],
  );
});

test('runExternalCheckWaiver reconciles against the refreshed claim after a takeover (#2328 review)', async () => {
  // Claim B supersedes A between the initial resolution and the post-write
  // read. The gate resolves B with `supersedes: A` and accepts both waivers,
  // so a summarizer still pinned to A classifies B's as wrongClaim and
  // reports no duplicate — silence exactly where the warning matters.
  let reads = 0;
  let candidateCalls = 0;
  const claimA = 'claim-A';
  const claimB = 'claim-B';
  const mine = waiverComment({
    id: 500,
    createdAt: '2026-08-30T22:29:00Z',
    claimId: claimA,
  });
  const theirs = waiverComment({
    id: 501,
    createdAt: '2026-08-30T22:29:30Z',
    claimId: claimB,
  });
  const candidateFor = (claimId: string, supersedes: string) => [
    {
      number: 2328,
      url: 'https://github.com/kurone-kito/idd-skill/issues/2328',
      activeClaim: {
        agentId: 'claude-6043e89f',
        claimId,
        supersedes,
        branch: 'issue/2328-fix-external-check-waiver-refuse-waiver',
        createdAt: '2026-08-30T22:23:26Z',
      },
    },
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
    // First resolution binds to A; the reconcile re-resolves and sees B
    // superseding A.
    issueCandidates: undefined,
    resolveIssueCandidates: () => {
      candidateCalls += 1;
      return candidateCalls === 1
        ? candidateFor(claimA, 'none')
        : candidateFor(claimB, claimA);
    },
    prComments: () => {
      reads += 1;
      return reads === 1 ? [] : [mine, theirs];
    },
    headCommittedAt: '2026-08-30T18:13:24Z',
    now: new Date('2026-08-30T22:30:00Z'),
    isTTY: false,
    postComment: () => ({ html_url: 'https://example.invalid/posted' }),
  });

  assert.equal(report?.applied, true);
  assert.deepEqual(
    report?.concurrentWaivers?.map((entry) => entry.commentId),
    ['500', '501'],
    'both the A-bound and B-bound waivers are live to the gate after the takeover',
  );
});

test('operationalMarkerPrefix recognizes a run-id-bound external-check-waiver marker (Codex review, PR #2895)', () => {
  // The trailing run-id: field is optional -- only --auto-bootstrap posts
  // it -- and this generic operational-marker shape check must accept it
  // the same way parseExternalCheckWaiverComment's own regex already
  // does. Without this, an auto-bootstrap marker's own comment fails this
  // check, operationalMarkerPrefix returns null for it, and
  // summarizeRegularCommentsForGate/summarizeDispositionEvidenceForGate
  // misclassify the bot's own posted marker as unreplied regular
  // feedback requiring human disposition -- a comment no one will ever
  // reply to, permanently routing F2 back to E1 even after the waiver
  // makes the required check ready.
  const body = renderExternalCheckWaiverComment({
    actor: 'github-actions[bot]',
    agentId: 'github-actions-bot',
    claimId: 'claim-abc',
    headSha: REUSE_HEAD_SHA,
    checkSelector: 'idd-advisory-convergence',
    reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
    expiresAt: '2099-01-01T00:00:00Z',
    runId: '555',
  });

  assert.equal(
    operationalMarkerPrefix(body),
    '<!-- idd-external-check-waiver:',
  );
});

test('operationalMarkerPrefix still recognizes an ordinary external-check-waiver marker with no run-id (non-regression)', () => {
  const body = renderExternalCheckWaiverComment({
    actor: 'kurone-kito',
    agentId: 'claude-6043e89f',
    claimId: 'claim-abc',
    headSha: REUSE_HEAD_SHA,
    checkSelector: 'CodeRabbit',
    reason: 'rate limit',
    expiresAt: '2099-01-01T00:00:00Z',
  });

  assert.equal(
    operationalMarkerPrefix(body),
    '<!-- idd-external-check-waiver:',
  );
});
