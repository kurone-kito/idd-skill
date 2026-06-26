import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  readAdvisoryPrimaryBotLogin,
  readAdvisoryWaitPolicy,
  resolveAdvisoryPrimaryBotLogin,
  resolveAdvisoryWaitPolicy,
} from '../src/scripts/advisory-wait-policy.mts';
import {
  buildAdvisoryWaitSummary,
  classifyCiChecks,
  isCopilotReviewerLogin,
  operationalMarkerPrefix,
  unsafeTextReason,
} from '../src/scripts/protocol-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

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

test('advisory wait policy only applies file overrides from schema-valid policy config', () => {
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
  writeFileSync(
    invalidPath,
    JSON.stringify({
      advisoryWait: {
        pendingWindow: 'PT1M',
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

function readJson(relativePath: string) {
  return JSON.parse(
    readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
  );
}
