import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  readAdvisoryConvergenceDeadlineMinutes,
  readAdvisoryPrimaryBotLogin,
  readAdvisorySecondaryBotLogin,
  readAdvisoryWaitPolicy,
  resolveAdvisoryPrimaryBotLogin,
  resolveAdvisorySecondaryBotLogin,
  resolveAdvisoryWaitPolicy,
} from '../src/scripts/advisory-wait-policy.mts';
import {
  buildAdvisoryWaitSummary,
  classifyCiChecks,
  computeSecondaryRequestedForHead,
  isCopilotReviewerLogin,
  operationalMarkerPrefix,
  unsafeTextReason,
} from '../src/scripts/protocol-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';
import { readJson } from './test-utils.mts';

const ciSuccess = readJson('fixtures/ci/success.json');
const ciPending = readJson('fixtures/ci/pending.json');
const ciFailed = readJson('fixtures/ci/failed.json');
const ciMixed = readJson('fixtures/ci/mixed.json');
const ciSkippedNeutral = readJson('fixtures/ci/skipped-neutral.json');
const advisoryWaitSchema = loadJson('schemas/advisory-wait-state.schema.json');

test('classifies CI check states for advisory wait decisions', () => {
  assert.equal(classifyCiChecks(ciSuccess).status, 'success');
  assert.equal(classifyCiChecks(ciPending).status, 'pending');
  assert.equal(classifyCiChecks(ciFailed).status, 'failed');
  assert.equal(classifyCiChecks(ciMixed).status, 'unknown');
  assert.equal(classifyCiChecks(ciSkippedNeutral).status, 'success');
});

// #1471: `classifyCiChecks` must dedupe multiple check-run instances that
// share the same `name` down to the latest one before classifying, instead
// of letting a stale instance for that name outvote the current one.
test('classifyCiChecks: a stale cancelled-only instance is superseded by a later success for the same name', () => {
  // Without dedup this shape misclassifies as 'unknown' (the stale
  // CANCELLED instance is neither failing nor passing on its own), not
  // 'failed' — a distinct branch from the FAILURE-triggered repro below.
  const checks = [
    {
      name: 'idd-advisory-convergence',
      state: 'CANCELLED',
      completedAt: '2026-07-17T15:59:36Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T16:25:47Z',
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'success');
});

test('classifyCiChecks: a genuinely failing latest instance still fails despite older passing instances', () => {
  // Guards against an over-broad fix that ignores any failure anywhere in
  // the list — this must stay 'failed' because the latest instance for the
  // name is the one that failed.
  const checks = [
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T15:00:00Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T15:30:00Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'FAILURE',
      completedAt: '2026-07-17T16:00:00Z',
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'failed');
});

test('classifyCiChecks: PR #1434 four-instance repro (2 cancelled, 1 failure, 1 success) classifies success', () => {
  const checks = [
    {
      name: 'idd-advisory-convergence',
      state: 'CANCELLED',
      completedAt: '2026-07-17T15:59:36Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'CANCELLED',
      completedAt: '2026-07-17T15:59:51Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'FAILURE',
      completedAt: '2026-07-17T16:00:06Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T16:25:47Z',
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'success');
});

test('classifyCiChecks: an in-progress rerun is not shadowed by an older completed success for the same name', () => {
  // The mirror-image failure mode: a live rerun (no completedAt yet) must
  // win over a stale completed SUCCESS for the same name, matching
  // GitHub's own semantics where an in-progress required check leaves the
  // branch not-clean rather than falling back to an old passing verdict.
  const checks = [
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T16:00:06Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'IN_PROGRESS',
      completedAt: null,
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'pending');
});

test('detects operational marker prefixes', () => {
  assert.equal(
    operationalMarkerPrefix(
      '<!-- review-watermark: agent claim sha 2026-05-09T00:00:00Z 0 none -->\n\n_foo: review triage snapshot — IDD automation marker. Do not edit._',
    ),
    '<!-- review-watermark:',
  );
  assert.equal(
    operationalMarkerPrefix(
      '<!-- review-baseline: agent claim sha -->\n\n_foo: critique baseline — IDD automation marker. Do not edit._',
    ),
    '<!-- review-baseline:',
  );
  assert.equal(
    operationalMarkerPrefix(
      'advisory-wait: agent 0123456789abcdef0123456789abcdef01234567 2026-05-09T00:00:00Z',
    ),
    'advisory-wait:',
  );
  assert.equal(
    operationalMarkerPrefix(
      '  advisory-wait: agent 0123456789abcdef0123456789abcdef01234567 2026-05-09T00:00:00Z',
    ),
    null,
  );
});

test('flags unsafe text reasons for failed states', () => {
  assert.equal(
    unsafeTextReason('CI failure is blocking merge'),
    'contains failed-CI context',
  );
  assert.equal(
    unsafeTextReason('The failed checks need attention'),
    'contains failed-CI context',
  );
  assert.equal(unsafeTextReason('SUCCESS'), null);
});

for (const fixtureName of [
  'satisfied',
  'request-needed',
  'recovery-needed',
  'cap-exhausted',
  'wait',
  'untrusted-marker',
  'pending-covers-head-force-push',
  'recovery-markers-excluded',
]) {
  test(`advisory wait fixture: ${fixtureName}`, () => {
    const fixture = readJson(`fixtures/advisory-wait/${fixtureName}.json`);
    const { input, expected } = fixture;
    const summary = buildAdvisoryWaitSummary(
      {
        prHeadSha: input.prHeadSha,
        reviews: input.reviews,
        requestedReviewers: input.requestedReviewers,
        timelineEvents: input.timelineEvents,
        comments: input.comments,
      },
      {
        now: input.now,
        requestCap: input.requestCap,
        pendingWindowMinutes: input.pendingWindowMinutes,
        settledWindowMinutes: input.settledWindowMinutes,
        trustedMarkerLogins: input.trustedMarkerLogins,
        viewerLogin: input.viewerLogin,
        configuredTrustedActors: input.configuredTrustedActors,
        collaboratorTrustEnabled: input.collaboratorTrustEnabled,
      },
    );

    assert.equal(summary.outcome, expected.outcome);
    assert.equal(summary.lastCopilotCommit, expected.lastCopilotCommit);
    assert.equal(summary.copilotPending, expected.copilotPending);
    assert.equal(
      summary.copilotPendingCoversHead,
      expected.copilotPendingCoversHead,
    );
    assert.equal(summary.sameHeadMarkerPresent, expected.sameHeadMarkerPresent);
    assert.equal(summary.sameHeadMarkerCount, expected.sameHeadMarkerCount);
    assert.equal(summary.requestMarkerCount, expected.requestMarkerCount);
    assert.equal(summary.requestCap, input.requestCap ?? 30);
    assert.equal(
      summary.pendingWindowMinutes,
      input.pendingWindowMinutes ?? 30,
    );
    assert.equal(
      summary.settledWindowMinutes,
      input.settledWindowMinutes ?? 10,
    );
    assert.equal(summary.pollIntervalMinutes, 2);
    assert.equal(summary.capExhaustedRoute, 'phase-specific');
    assert.equal(summary.earliestSameHeadAt, expected.earliestSameHeadAt);
    assert.equal(summary.elapsedMinutes, expected.elapsedMinutes);
    assert.equal(
      summary.trustedMarkerSummary.trustedSameHeadMarkerCount,
      expected.trustedSameHeadMarkerCount,
    );
    assert.equal(
      summary.trustedMarkerSummary.untrustedSameHeadMarkerCount,
      expected.untrustedSameHeadMarkerCount,
    );
    assert.equal(
      summary.trustedMarkerSummary.trustedRequestMarkerCount,
      expected.trustedRequestMarkerCount,
    );
    assert.equal(
      summary.trustedMarkerSummary.untrustedRequestMarkerCount,
      expected.untrustedRequestMarkerCount,
    );
    assert.deepEqual(validate(summary, advisoryWaitSchema), []);
  });
}

test('advisory wait policy resolves defaults, explicit values, and fail-safe fallbacks', () => {
  assert.deepEqual(resolveAdvisoryWaitPolicy({}), {
    requestCap: 30,
    pendingWindowMinutes: 30,
    settledWindowMinutes: 10,
    pollIntervalMinutes: 2,
    capExhaustedRoute: 'phase-specific',
  });

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        requestCap: 12,
        pendingWindow: 'PT45M',
        settledWindow: 'PT15M',
        pollInterval: 'PT3M',
        capExhaustedRoute: 'hold',
      },
    }),
    {
      requestCap: 12,
      pendingWindowMinutes: 45,
      settledWindowMinutes: 15,
      pollIntervalMinutes: 3,
      capExhaustedRoute: 'hold',
    },
  );

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        requestCap: 0,
        pendingWindow: 'P1DT',
        settledWindow: 'PT',
        pollInterval: 'P',
        capExhaustedRoute: 'merge-anyway',
      },
    }),
    {
      requestCap: 30,
      pendingWindowMinutes: 30,
      settledWindowMinutes: 10,
      pollIntervalMinutes: 2,
      capExhaustedRoute: 'phase-specific',
    },
  );

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        requestCap: '1',
        pendingWindow: 'pt1m',
        settledWindow: ' PT5M ',
        pollInterval: 'pt3m',
        capExhaustedRoute: ' hold ',
      },
    }),
    {
      requestCap: 30,
      pendingWindowMinutes: 30,
      settledWindowMinutes: 10,
      pollIntervalMinutes: 2,
      capExhaustedRoute: 'phase-specific',
    },
  );

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        pendingWindow: 'PT0M',
        settledWindow: 'PT60S',
        pollInterval: 'PT90S',
      },
    }),
    {
      requestCap: 30,
      pendingWindowMinutes: 30,
      settledWindowMinutes: 10,
      pollIntervalMinutes: 2,
      capExhaustedRoute: 'phase-specific',
    },
  );

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        pendingWindow: 'PT30S',
        settledWindow: 'PT30S',
        pollInterval: 'PT90S',
      },
    }),
    {
      requestCap: 30,
      pendingWindowMinutes: 30,
      settledWindowMinutes: 10,
      pollIntervalMinutes: 2,
      capExhaustedRoute: 'phase-specific',
    },
  );
});

test('advisory wait policy only applies file overrides from a schema-valid advisoryWait section', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-policy-'));
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );

  validConfig.advisoryWait = {
    requestCap: 12,
    pendingWindow: 'PT45M',
    settledWindow: 'PT15M',
    pollInterval: 'PT3M',
    capExhaustedRoute: 'hold',
  };

  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // The pendingWindow value itself is a genuine advisoryWait schema
  // violation (fails the whole-minute-duration pattern), so the
  // advisoryWait subtree is invalid on its own terms and still reverts.
  writeFileSync(
    invalidPath,
    JSON.stringify({
      advisoryWait: {
        pendingWindow: 'not-a-duration',
      },
    }),
    'utf8',
  );

  assert.deepEqual(readAdvisoryWaitPolicy(validPath), {
    requestCap: 12,
    pendingWindowMinutes: 45,
    settledWindowMinutes: 15,
    pollIntervalMinutes: 3,
    capExhaustedRoute: 'hold',
  });

  assert.deepEqual(readAdvisoryWaitPolicy(invalidPath), {
    requestCap: 30,
    pendingWindowMinutes: 30,
    settledWindowMinutes: 10,
    pollIntervalMinutes: 2,
    capExhaustedRoute: 'phase-specific',
  });
});

test('advisory wait policy still honors advisoryWait when an unrelated top-level field is schema-invalid', () => {
  // #1359 regression: an unknown top-level key trips `additionalProperties:
  // false` at the whole-document level, but must not zero out an otherwise
  // schema-valid advisoryWait section — validation is scoped to
  // advisoryWait's own subtree.
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-policy-scoped-'));
  const configPath = join(root, 'policy.json');
  const config = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );

  config.advisoryWait = {
    requestCap: 12,
    pendingWindow: 'PT45M',
    settledWindow: 'PT15M',
    pollInterval: 'PT3M',
    capExhaustedRoute: 'hold',
  };
  config.unsupportedTopLevelKey = true;

  writeFileSync(configPath, JSON.stringify(config), 'utf8');

  assert.deepEqual(readAdvisoryWaitPolicy(configPath), {
    requestCap: 12,
    pendingWindowMinutes: 45,
    settledWindowMinutes: 15,
    pollIntervalMinutes: 3,
    capExhaustedRoute: 'hold',
  });
});

test('isCopilotReviewerLogin keeps the dual Copilot match by default and matches a configured bot exactly', () => {
  // Default (Copilot): exact `copilot` plus the GitHub App login family.
  assert.equal(isCopilotReviewerLogin('copilot'), true);
  assert.equal(isCopilotReviewerLogin('Copilot'), true);
  assert.equal(
    isCopilotReviewerLogin('copilot-pull-request-reviewer[bot]'),
    true,
  );
  assert.equal(isCopilotReviewerLogin('coderabbitai[bot]'), false);
  assert.equal(isCopilotReviewerLogin(''), false);
  // An explicit Copilot default behaves identically to the implicit default.
  assert.equal(
    isCopilotReviewerLogin('copilot-pull-request-reviewer[bot]', 'copilot'),
    true,
  );

  // A configured non-Copilot bot is matched by exact normalized equality only,
  // and the Copilot prefix family no longer matches.
  assert.equal(
    isCopilotReviewerLogin('coderabbitai[bot]', 'coderabbitai[bot]'),
    true,
  );
  assert.equal(
    isCopilotReviewerLogin('CodeRabbitAI[bot]', 'coderabbitai[bot]'),
    true,
  );
  assert.equal(
    isCopilotReviewerLogin(
      'copilot-pull-request-reviewer[bot]',
      'coderabbitai[bot]',
    ),
    false,
  );
  // A blank configured login falls back to the Copilot default.
  assert.equal(isCopilotReviewerLogin('copilot', '   '), true);
});

test('advisory wait summary resolves coverage against a configured primary bot', () => {
  const headSha = 'b'.repeat(40);
  const input = {
    prHeadSha: headSha,
    reviews: [
      {
        user: { login: 'coderabbitai[bot]' },
        submitted_at: '2026-05-11T17:01:00Z',
        commit_id: headSha,
      },
      // A Copilot review must be ignored when the primary bot is CodeRabbit.
      {
        user: { login: 'copilot-pull-request-reviewer[bot]' },
        submitted_at: '2026-05-11T17:02:00Z',
        commit_id: 'c'.repeat(40),
      },
    ],
    requestedReviewers: [{ login: 'coderabbitai[bot]' }],
    timelineEvents: [],
    comments: [],
  };

  const customBot = buildAdvisoryWaitSummary(input, {
    now: '2026-05-11T17:05:00Z',
    primaryBotLogin: 'coderabbitai[bot]',
  });
  // Coverage is computed against the CodeRabbit review on HEAD, and the
  // CodeRabbit pending request is detected; the Copilot review is ignored.
  assert.equal(customBot.lastCopilotCommit, headSha);
  assert.equal(customBot.copilotPending, true);

  // With the default (Copilot) primary bot, the same payload resolves against
  // the Copilot review (off HEAD) and no Copilot pending request.
  const defaultBot = buildAdvisoryWaitSummary(input, {
    now: '2026-05-11T17:05:00Z',
  });
  assert.equal(defaultBot.lastCopilotCommit, 'c'.repeat(40));
  assert.equal(defaultBot.copilotPending, false);
});

test('primary advisory bot login resolves defaults, overrides, and fail-safe fallbacks', () => {
  assert.equal(DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN, 'copilot');
  assert.equal(resolveAdvisoryPrimaryBotLogin({}), 'copilot');
  assert.equal(resolveAdvisoryPrimaryBotLogin(), 'copilot');
  assert.equal(
    resolveAdvisoryPrimaryBotLogin({
      advisoryWait: { primaryBotLogin: 'CodeRabbitAI[bot]' },
    }),
    'coderabbitai[bot]',
  );
  assert.equal(
    resolveAdvisoryPrimaryBotLogin({ advisoryWait: { primaryBotLogin: '  ' } }),
    'copilot',
  );
  assert.equal(
    resolveAdvisoryPrimaryBotLogin({ advisoryWait: { primaryBotLogin: 42 } }),
    'copilot',
  );
});

test('readAdvisoryPrimaryBotLogin only applies a schema-valid file override', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-primary-bot-'));
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  validConfig.advisoryWait = { primaryBotLogin: 'coderabbitai[bot]' };
  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // A non-string primaryBotLogin violates the schema, so the file is
  // schema-invalid and the reader fails closed to the Copilot default.
  writeFileSync(
    invalidPath,
    JSON.stringify({ advisoryWait: { primaryBotLogin: 5 } }),
    'utf8',
  );

  assert.equal(readAdvisoryPrimaryBotLogin(validPath), 'coderabbitai[bot]');
  assert.equal(readAdvisoryPrimaryBotLogin(invalidPath), 'copilot');
  assert.equal(
    readAdvisoryPrimaryBotLogin(join(root, 'missing.json')),
    'copilot',
  );
});

test('secondary advisory bot login resolves to empty when absent and normalizes when present', () => {
  // The secondary is OPTIONAL — absence resolves to '' (disabled), with no
  // Copilot default, so it never accidentally matches the Copilot family.
  assert.equal(resolveAdvisorySecondaryBotLogin({}), '');
  assert.equal(resolveAdvisorySecondaryBotLogin(), '');
  assert.equal(
    resolveAdvisorySecondaryBotLogin({
      advisoryWait: { secondaryBotLogin: 'CodeRabbitAI[bot]' },
    }),
    'coderabbitai[bot]',
  );
  assert.equal(
    resolveAdvisorySecondaryBotLogin({
      advisoryWait: { secondaryBotLogin: '  ' },
    }),
    '',
  );
  assert.equal(
    resolveAdvisorySecondaryBotLogin({
      advisoryWait: { secondaryBotLogin: 42 },
    }),
    '',
  );
});

test('readAdvisorySecondaryBotLogin only applies a schema-valid file override, else empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-secondary-bot-'));
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  validConfig.advisoryWait = { secondaryBotLogin: 'coderabbitai[bot]' };
  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // A non-string secondaryBotLogin violates the schema, so the reader fails
  // closed to '' (secondary disabled).
  writeFileSync(
    invalidPath,
    JSON.stringify({ advisoryWait: { secondaryBotLogin: 5 } }),
    'utf8',
  );

  assert.equal(readAdvisorySecondaryBotLogin(validPath), 'coderabbitai[bot]');
  assert.equal(readAdvisorySecondaryBotLogin(invalidPath), '');
  assert.equal(readAdvisorySecondaryBotLogin(join(root, 'missing.json')), '');
});

test('readAdvisoryConvergenceDeadlineMinutes applies a schema-valid override and is scoped to advisoryWait', () => {
  const root = mkdtempSync(
    join(tmpdir(), 'idd-advisory-convergence-deadline-'),
  );
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  validConfig.advisoryWait = { convergenceDeadline: 'PT6H' };
  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // A non-string convergenceDeadline violates the advisoryWait schema, so
  // the reader fails closed to the default.
  writeFileSync(
    invalidPath,
    JSON.stringify({ advisoryWait: { convergenceDeadline: 5 } }),
    'utf8',
  );

  assert.equal(readAdvisoryConvergenceDeadlineMinutes(validPath), 6 * 60);
  assert.equal(
    readAdvisoryConvergenceDeadlineMinutes(invalidPath),
    DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  );
  assert.equal(
    readAdvisoryConvergenceDeadlineMinutes(join(root, 'missing.json')),
    DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  );
});

test('computeSecondaryRequestedForHead detects a same-HEAD secondary request and resets per HEAD', () => {
  const head = 'b'.repeat(40);
  // No timeline → not requested.
  assert.equal(
    computeSecondaryRequestedForHead([], head, 'coderabbitai[bot]'),
    false,
  );
  // Empty login short-circuits, even with a matching request event.
  assert.equal(
    computeSecondaryRequestedForHead(
      [
        { event: 'committed', sha: head },
        {
          event: 'review_requested',
          requested_reviewer: { login: 'coderabbitai[bot]' },
        },
      ],
      head,
      '',
    ),
    false,
  );
  // review_requested AFTER the HEAD committed event → requested (case-folded).
  assert.equal(
    computeSecondaryRequestedForHead(
      [
        { event: 'committed', sha: head },
        {
          event: 'review_requested',
          requested_reviewer: { login: 'CodeRabbitAI[bot]' },
        },
      ],
      head,
      'coderabbitai[bot]',
    ),
    true,
  );
  // A request BEFORE the current HEAD committed event does not count — the
  // per-HEAD reset that lets a new HEAD re-request the secondary.
  assert.equal(
    computeSecondaryRequestedForHead(
      [
        {
          event: 'review_requested',
          requested_reviewer: { login: 'coderabbitai[bot]' },
        },
        { event: 'committed', sha: head },
      ],
      head,
      'coderabbitai[bot]',
    ),
    false,
  );
});

test('secondary bot is requested once per HEAD when primary is cap-exhausted, without touching the gate', () => {
  const fixture = readJson('fixtures/advisory-wait/cap-exhausted.json');
  const base = {
    prHeadSha: fixture.input.prHeadSha,
    reviews: fixture.input.reviews,
    requestedReviewers: fixture.input.requestedReviewers,
    timelineEvents: fixture.input.timelineEvents,
    comments: fixture.input.comments,
  };
  const opts = {
    now: fixture.input.now,
    requestCap: fixture.input.requestCap,
    trustedMarkerLogins: fixture.input.trustedMarkerLogins,
  };

  const withoutSecondary = buildAdvisoryWaitSummary(base, opts);
  const withSecondary = buildAdvisoryWaitSummary(base, {
    ...opts,
    secondaryBotLogin: 'coderabbitai[bot]',
  });

  // Trigger: primary cap-exhausted and never reviewed HEAD → request once.
  assert.equal(withoutSecondary.outcome, 'CAP_EXHAUSTED');
  assert.equal(withSecondary.secondaryRequestNeeded, true);
  assert.equal(withSecondary.secondaryBotLogin, 'coderabbitai[bot]');
  // No secondary configured ⇒ identical to the primary-only (#1098) behavior.
  assert.equal(withoutSecondary.secondaryRequestNeeded, false);
  assert.equal(withoutSecondary.secondaryBotLogin, '');

  // Contract (a): the secondary never alters the primary gate.
  assert.equal(withSecondary.outcome, withoutSecondary.outcome);
  assert.equal(withSecondary.f3Outcome, withoutSecondary.f3Outcome);
  assert.equal(withSecondary.copilotPending, withoutSecondary.copilotPending);
  assert.equal(
    withSecondary.lastCopilotCommit,
    withoutSecondary.lastCopilotCommit,
  );
  // Contract (b): no primary advisory-wait marker / cap consumption is added.
  assert.equal(
    withSecondary.requestMarkerCount,
    withoutSecondary.requestMarkerCount,
  );
  assert.equal(
    withSecondary.sameHeadMarkerPresent,
    withoutSecondary.sameHeadMarkerPresent,
  );

  // Once per HEAD: a secondary review_requested after HEAD suppresses re-request.
  const alreadyRequested = buildAdvisoryWaitSummary(
    {
      ...base,
      timelineEvents: [
        { event: 'committed', sha: fixture.input.prHeadSha },
        {
          event: 'review_requested',
          requested_reviewer: { login: 'coderabbitai[bot]' },
        },
      ],
    },
    { ...opts, secondaryBotLogin: 'coderabbitai[bot]' },
  );
  assert.equal(alreadyRequested.secondaryRequestNeeded, false);

  // Misconfiguration: a secondary equal to the primary is treated as absent.
  const samePrimary = buildAdvisoryWaitSummary(base, {
    ...opts,
    primaryBotLogin: 'coderabbitai[bot]',
    secondaryBotLogin: 'coderabbitai[bot]',
  });
  assert.equal(samePrimary.secondaryRequestNeeded, false);
  assert.equal(samePrimary.secondaryBotLogin, '');
});

test('secondary bot fires on a stalled settled-window wait but not on a HEAD-reviewed satisfy', () => {
  // Stalled / rate-limited: SATISFIED via the elapsed settle window with no
  // HEAD review (lastCopilotCommit empty) → request the secondary supplement.
  const waitFixture = readJson('fixtures/advisory-wait/wait.json');
  const stalled = buildAdvisoryWaitSummary(
    {
      prHeadSha: waitFixture.input.prHeadSha,
      reviews: waitFixture.input.reviews,
      requestedReviewers: waitFixture.input.requestedReviewers,
      timelineEvents: waitFixture.input.timelineEvents,
      comments: waitFixture.input.comments,
    },
    {
      now: waitFixture.input.now,
      // elapsed (4 min) >= 1 ⇒ SATISFIED by the window, not by a HEAD review.
      settledWindowMinutes: 1,
      trustedMarkerLogins: waitFixture.input.trustedMarkerLogins,
      secondaryBotLogin: 'coderabbitai[bot]',
    },
  );
  assert.equal(stalled.outcome, 'SATISFIED');
  assert.equal(stalled.lastCopilotCommit, '');
  assert.equal(stalled.secondaryRequestNeeded, true);

  // A genuine HEAD review (SATISFIED with lastCopilotCommit === HEAD) needs no
  // supplement — the follow-up the secondary exists for is not needed.
  const satisfiedFixture = readJson('fixtures/advisory-wait/satisfied.json');
  const headReviewed = buildAdvisoryWaitSummary(
    {
      prHeadSha: satisfiedFixture.input.prHeadSha,
      reviews: satisfiedFixture.input.reviews,
      requestedReviewers: satisfiedFixture.input.requestedReviewers,
      timelineEvents: satisfiedFixture.input.timelineEvents,
      comments: satisfiedFixture.input.comments,
    },
    {
      now: satisfiedFixture.input.now,
      trustedMarkerLogins: satisfiedFixture.input.trustedMarkerLogins,
      secondaryBotLogin: 'coderabbitai[bot]',
    },
  );
  assert.equal(headReviewed.outcome, 'SATISFIED');
  assert.equal(
    headReviewed.lastCopilotCommit,
    satisfiedFixture.input.prHeadSha,
  );
  assert.equal(headReviewed.secondaryRequestNeeded, false);
});

test('advisory wait summary normalizes invalid direct options to defaults', () => {
  const fixture = readJson('fixtures/advisory-wait/request-needed.json');
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: fixture.input.prHeadSha,
      reviews: fixture.input.reviews,
      requestedReviewers: fixture.input.requestedReviewers,
      timelineEvents: fixture.input.timelineEvents,
      comments: fixture.input.comments,
    },
    {
      now: fixture.input.now,
      requestCap: 0,
      pendingWindowMinutes: -45,
      settledWindowMinutes: 0,
      pollIntervalMinutes: -3,
      capExhaustedRoute: 'merge-anyway',
      trustedMarkerLogins: fixture.input.trustedMarkerLogins,
      viewerLogin: fixture.input.viewerLogin,
      configuredTrustedActors: fixture.input.configuredTrustedActors,
      collaboratorTrustEnabled: fixture.input.collaboratorTrustEnabled,
    },
  );

  assert.equal(summary.requestCap, 30);
  assert.equal(summary.pendingWindowMinutes, 30);
  assert.equal(summary.settledWindowMinutes, 10);
  assert.equal(summary.pollIntervalMinutes, 2);
  assert.equal(summary.capExhaustedRoute, 'phase-specific');
});

// Importing the CLI module directly is only possible now that its top-level
// statements are guarded behind `import.meta.main` (#1210, migrated from
// isCliExecution() by #1447); previously the import parsed process.argv and
// called a `gh` command, aborting the test process when no --pr argument or
// gh binary was available.
test('importing advisory-wait-state.mts has no import-time side effect', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.doesNotReject(
      import('../src/scripts/advisory-wait-state.mts'),
    );
  } finally {
    process.env.PATH = originalPath;
  }
});
