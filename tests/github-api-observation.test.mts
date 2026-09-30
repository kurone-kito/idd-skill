import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  ghApiJson,
  ghApiJsonWithHeaders,
  ghGraphql,
} from '../src/scripts/gh-exec.mts';
import {
  appendRequestObservation,
  defaultGithubApiTelemetryPath,
  observeGhFailure,
  observeGhSuccess,
  type RequestObservation,
  readGithubApiTelemetryPolicy,
  recordRequestObservation,
  resetGithubApiTelemetryPolicyCacheForTests,
  resolveGithubApiTelemetryPath,
  setGithubApiTelemetryPolicyForTests,
  summarizeInjectedExchanges,
  withTelemetryFileLock,
} from '../src/scripts/github-api-observation.mts';
import { classifyHelperError } from '../src/scripts/helper-cli-runner.mts';
import { normalizePolicyConfig } from '../src/scripts/policy-helpers.mts';
import { stubExecutable } from './test-utils.mts';

const SECONDARY_STDERR =
  'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again (HTTP 403)';
const SAML_STDERR =
  'gh: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (HTTP 403)';
const INTEGRATION_STDERR =
  'gh: Resource not accessible by integration (HTTP 403)';

test('injected exchanges keep exact HTTP, page, command, and retry counts', () => {
  const mixed = summarizeInjectedExchanges([
    {
      commandInvocations: 1,
      retryAttempts: 2,
      responses: [
        {
          status: 403,
          headers: { 'retry-after': '8' },
          bodyText: SECONDARY_STDERR,
        },
        {
          status: 200,
          headers: {
            'x-ratelimit-remaining': '3',
            'x-ratelimit-resource': 'graphql',
          },
        },
        { status: 200 },
      ],
    },
  ]);
  assert.equal(mixed.httpRequestCount, 3);
  assert.equal(mixed.pageCount, 3);
  assert.equal(mixed.commandInvocationCount, 1);
  assert.equal(mixed.retryAttempts, 2);
  assert.equal(mixed.classification, 'secondary-throttling');
  assert.equal(mixed.signals.secondaryThrottling, true);
  assert.equal(mixed.signals.primaryExhaustion, false);
  assert.equal(mixed.retryAfter, 8);
  assert.equal(mixed.remaining, 3);
  assert.equal(mixed.resource, 'graphql');
  assert.equal(mixed.status, 200);

  const paginated = summarizeInjectedExchanges([{ commandInvocations: 1 }]);
  assert.equal(paginated.httpRequestCount, 'unknown');
  assert.equal(paginated.pageCount, 'unknown');
  assert.equal(paginated.commandInvocationCount, 1);
  assert.equal(paginated.retryAttempts, 0);

  const empty = summarizeInjectedExchanges([{ responses: [] }]);
  assert.equal(empty.httpRequestCount, 0);
  assert.equal(empty.pageCount, 0);
  assert.equal(empty.commandInvocationCount, 1);
  assert.equal(empty.classification, 'unknown');

  const separate = summarizeInjectedExchanges([
    { retryAttempts: 1, responses: [{ status: 200 }] },
    { responses: [{ status: 200 }] },
  ]);
  assert.equal(separate.commandInvocationCount, 2);
  assert.equal(separate.retryAttempts, 1);
  assert.equal(separate.httpRequestCount, 2);
  assert.equal(separate.classification, 'ok');
});

test('injected 2xx bodies do not become quota observations', () => {
  const titled = summarizeInjectedExchanges([
    {
      responses: [
        { status: 200, bodyText: '{"title":"API rate limit exceeded"}' },
      ],
    },
  ]);
  assert.equal(titled.classification, 'ok');
  assert.equal(titled.signals.primaryExhaustion, false);
  assert.equal(titled.signals.secondaryThrottling, false);

  const secondaryPhrase = summarizeInjectedExchanges([
    { responses: [{ status: 200, bodyText: 'secondary rate limit' }] },
  ]);
  assert.equal(secondaryPhrase.classification, 'ok');
  assert.equal(secondaryPhrase.signals.secondaryThrottling, false);

  const headerStillCounts = summarizeInjectedExchanges([
    {
      responses: [
        {
          status: 200,
          headers: { 'x-ratelimit-remaining': '0' },
          bodyText: 'API rate limit exceeded',
        },
      ],
    },
  ]);
  assert.equal(headerStillCounts.classification, 'primary-exhaustion');
  assert.equal(headerStillCounts.signals.primaryExhaustion, true);
  assert.equal(headerStillCounts.signals.secondaryThrottling, false);

  const explicitFailure = summarizeInjectedExchanges([
    {
      responses: [
        {
          status: 403,
          bodyText: 'You have exceeded a secondary rate limit.',
        },
      ],
    },
  ]);
  assert.equal(explicitFailure.classification, 'secondary-throttling');
  assert.equal(explicitFailure.signals.secondaryThrottling, true);
  assert.equal(explicitFailure.signals.primaryExhaustion, false);

  const missingStatus = summarizeInjectedExchanges([
    { responses: [{ bodyText: 'API rate limit exceeded' }] },
  ]);
  assert.equal(missingStatus.status, 'unknown');
  assert.equal(missingStatus.signals.primaryExhaustion, false);
  assert.equal(missingStatus.classification, 'ok');
});

test('request signals stay independent and do not guess a subtype', () => {
  const primary = observeGhFailure({
    stderr: 'gh: API rate limit exceeded for user (HTTP 403)',
  });
  assert.equal(primary.classification, 'primary-exhaustion');
  assert.equal(primary.status, 403);
  assert.equal(primary.signals.primaryExhaustion, true);
  assert.equal(primary.signals.secondaryThrottling, false);

  const secondary = observeGhFailure({ stderr: SECONDARY_STDERR });
  assert.equal(secondary.classification, 'secondary-throttling');
  assert.equal(secondary.signals.primaryExhaustion, false);
  assert.equal(secondary.signals.accessDenied, false);

  const both = observeGhFailure({
    stderr: 'API rate limit exceeded and a secondary rate limit (HTTP 403)',
  });
  assert.equal(both.classification, 'unknown');
  assert.equal(both.signals.primaryExhaustion, true);
  assert.equal(both.signals.secondaryThrottling, true);

  const graphqlErrors = observeGhSuccess({
    status: 200,
    graphql: true,
    data: {
      errors: [{ message: 'nope' }],
      data: { rateLimit: { cost: 4 } },
    },
  });
  assert.equal(graphqlErrors.classification, 'graphql-errors');
  assert.equal(graphqlErrors.graphqlCost, 4);
  assert.equal(graphqlErrors.signals.graphqlErrors, true);
  assert.equal(graphqlErrors.signals.primaryExhaustion, false);

  const graphqlMixed = observeGhSuccess({
    data: {
      errors: [{ message: 'nope' }],
      data: { rateLimit: { cost: 1, remaining: 0 } },
    },
    graphql: true,
    httpObserved: false,
  });
  assert.equal(graphqlMixed.classification, 'unknown');
  assert.equal(graphqlMixed.signals.graphqlErrors, true);
  assert.equal(graphqlMixed.signals.primaryExhaustion, true);
  assert.equal(graphqlMixed.signals.secondaryThrottling, false);
  assert.equal(graphqlMixed.status, 'unknown');
  assert.equal(graphqlMixed.httpRequestCount, 'unknown');
  assert.equal(graphqlMixed.pageCount, 'unknown');
  assert.equal(graphqlMixed.graphqlCost, 1);

  const graphqlPrimary = observeGhSuccess({
    data: { data: { ok: true, rateLimit: { cost: 2, remaining: 0 } } },
    graphql: true,
    httpObserved: false,
  });
  assert.equal(graphqlPrimary.classification, 'primary-exhaustion');
  assert.equal(graphqlPrimary.signals.secondaryThrottling, false);
  assert.equal(graphqlPrimary.graphqlCost, 2);

  const fractionalCost = observeGhSuccess({
    status: 200,
    graphql: true,
    data: { data: { rateLimit: { cost: 1.5 } } },
  });
  assert.equal(fractionalCost.graphqlCost, 'unknown');
  assert.equal(fractionalCost.classification, 'ok');

  // GitHub returns cost only as `data.rateLimit` when the query selects it.
  // A query that does not, or an `extensions` cost envelope GitHub never
  // sends, leaves cost unknown.
  const unselectedCost = observeGhSuccess({
    status: 200,
    graphql: true,
    data: {
      data: { ok: true },
      extensions: { cost: { actualQueryCost: 9 } },
    },
  });
  assert.equal(unselectedCost.graphqlCost, 'unknown');
  assert.equal(unselectedCost.classification, 'ok');

  const restPayload = observeGhSuccess({
    status: 200,
    data: {
      errors: [{ message: 'validation' }],
      title: 'API rate limit exceeded',
    },
  });
  assert.equal(restPayload.classification, 'ok');
  assert.equal(restPayload.signals.graphqlErrors, false);
  assert.equal(restPayload.signals.primaryExhaustion, false);
  assert.equal(restPayload.graphqlCost, 'unknown');

  const toleratedSecondary = observeGhSuccess({
    status: 403,
    data: {
      message: 'You have exceeded a secondary rate limit. Please wait.',
    },
  });
  assert.equal(toleratedSecondary.classification, 'secondary-throttling');
  assert.equal(toleratedSecondary.signals.accessDenied, false);
  assert.equal(toleratedSecondary.signals.primaryExhaustion, false);

  const toleratedPrimary = observeGhSuccess({
    status: 403,
    data: { message: 'API rate limit exceeded for user' },
  });
  assert.equal(toleratedPrimary.classification, 'primary-exhaustion');
  assert.equal(toleratedPrimary.signals.secondaryThrottling, false);

  const headerPrimary = observeGhSuccess({
    status: 200,
    headers: { 'x-ratelimit-remaining': '0' },
    data: {},
  });
  assert.equal(headerPrimary.classification, 'primary-exhaustion');
  assert.equal(headerPrimary.signals.secondaryThrottling, false);

  const saml = observeGhFailure({ stderr: SAML_STDERR });
  assert.equal(saml.classification, 'access-denied');
  assert.equal(saml.status, 403);
  const integration = observeGhFailure({ stderr: INTEGRATION_STDERR });
  assert.equal(integration.classification, 'access-denied');

  const unrelated = observeGhFailure({
    stderr: 'gh: Forbidden (HTTP 403)',
  });
  assert.equal(unrelated.status, 403);
  assert.equal(unrelated.signals.accessDenied, false);
  assert.notEqual(unrelated.classification, 'access-denied');

  const missing = observeGhFailure({ stderr: 'gh: HTTP 404' });
  assert.equal(missing.status, 404);
  assert.equal(missing.signals.accessDenied, false);
  assert.notEqual(missing.classification, 'access-denied');

  const unauthorized = observeGhFailure({
    stderr: 'gh: Bad credentials (HTTP 401)',
  });
  assert.equal(unauthorized.classification, 'access-denied');
  assert.equal(unauthorized.status, 401);

  const looseResource = observeGhSuccess({
    status: 200,
    headers: {
      'x-ratelimit-resource': 'not a token',
      'retry-after': 'soon',
    },
    data: {},
  });
  assert.equal(looseResource.resource, 'unknown');
  assert.equal(looseResource.retryAfter, 'unknown');
  assert.equal(looseResource.classification, 'ok');
});

test('failure counts stay unknown without an observed HTTP status', () => {
  const spawnError = observeGhFailure({
    code: 'ENOENT',
    message: 'spawnSync gh ENOENT',
  });
  assert.equal(spawnError.status, 'unknown');
  assert.equal(spawnError.httpRequestCount, 'unknown');
  assert.equal(spawnError.pageCount, 'unknown');
  assert.equal(spawnError.commandInvocationCount, 1);

  const noResponse = observeGhFailure({
    stderr: 'gh: connection timed out',
  });
  assert.equal(noResponse.httpRequestCount, 'unknown');
  assert.equal(noResponse.pageCount, 'unknown');

  const withStatus = observeGhFailure({ stderr: 'gh: HTTP 404' });
  assert.equal(withStatus.status, 404);
  assert.equal(withStatus.httpRequestCount, 1);
  assert.equal(withStatus.pageCount, 1);

  const graphqlNoStatus = observeGhFailure(
    { stderr: 'gh: could not reach the server' },
    { graphql: true },
  );
  assert.equal(graphqlNoStatus.httpRequestCount, 'unknown');
  const graphqlStatus = observeGhFailure(
    { stderr: 'gh: Bad Gateway (HTTP 502)' },
    { graphql: true },
  );
  assert.equal(graphqlStatus.httpRequestCount, 1);

  const paginated = observeGhFailure(
    { stderr: 'gh: HTTP 404' },
    { paginated: true },
  );
  assert.equal(paginated.httpRequestCount, 'unknown');
});

test('failure classification reads the captured streams, not the argv', () => {
  const argvOnly = observeGhFailure(
    {
      stderr: 'gh: Something went wrong',
      message:
        'Command failed: gh api graphql -f body=see {"status": 401} (HTTP 401)',
    },
    { graphql: true },
  );
  assert.equal(argvOnly.status, 'unknown');
  assert.equal(argvOnly.classification, 'unknown');
  assert.equal(argvOnly.signals.accessDenied, false);
  assert.equal(argvOnly.httpRequestCount, 'unknown');

  const messageWording = observeGhFailure({
    message:
      'Command failed: gh api -f body=API rate limit exceeded (HTTP 403)',
  });
  assert.equal(messageWording.status, 'unknown');
  assert.equal(messageWording.signals.primaryExhaustion, false);
});

test('GraphQL failure evidence excludes the response data', () => {
  const quoted = observeGhFailure(
    {
      stderr: 'gh: Could not resolve to a User with the login of nobody.\n',
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              comments: {
                nodes: [
                  { body: 'we hit a secondary rate limit before (HTTP 403)' },
                ],
              },
            },
          },
        },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a User' }],
      }),
    },
    { graphql: true },
  );
  assert.equal(quoted.status, 'unknown');
  assert.equal(quoted.httpRequestCount, 'unknown');
  assert.equal(quoted.signals.secondaryThrottling, false);
  assert.equal(quoted.signals.primaryExhaustion, false);
  assert.equal(quoted.classification, 'graphql-errors');

  const statusInData = observeGhFailure(
    {
      stderr: 'gh: boom\n',
      stdout: '{"data":{"x":{"status":"404"}},"errors":[{"message":"boom"}]}',
    },
    { graphql: true },
  );
  assert.equal(statusInData.status, 'unknown');
  assert.equal(statusInData.httpRequestCount, 'unknown');

  // The error messages themselves are still evidence.
  const messageWording = observeGhFailure(
    {
      stderr: 'gh: request failed\n',
      stdout:
        '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded for user ID 1."}]}',
    },
    { graphql: true },
  );
  assert.equal(messageWording.signals.primaryExhaustion, true);
  assert.equal(messageWording.signals.graphqlErrors, true);
});

test('a GraphQL errors body on stdout survives a brace in stderr', () => {
  const observed = observeGhFailure(
    {
      stderr: 'gh: Parse error on "{" at [1, 8]\n',
      stdout: '{"errors":[{"message":"Parse error"}]}',
    },
    { graphql: true },
  );
  assert.equal(observed.signals.graphqlErrors, true);
  assert.equal(observed.classification, 'graphql-errors');
  assert.equal(JSON.stringify(observed).includes('Parse error'), false);
});

test('failure observations redact secrets and ignore launcher names', () => {
  const token = 'ghp_SUPERSECRETBODYTOKEN';
  const query = 'private-search-term-zz';
  const issueBody = 'ISSUE_BODY_SHOULD_NOT_LEAK_ZZ';
  const envDump = 'AWS_SECRET_ACCESS_KEY=should-not-leak-zz';
  const observed = observeGhFailure({
    stderr: [
      'x-ratelimit-resource: core',
      'x-ratelimit-remaining: 12',
      'x-ratelimit-reset: 1700000000',
      'retry-after: 30',
      `token=${token}`,
      issueBody,
      envDump,
      'API rate limit exceeded (HTTP 403)',
    ].join('\n'),
    stdout: `query=${query}`,
  });
  const encoded = JSON.stringify(observed);
  assert.equal(encoded.includes(token), false);
  assert.equal(encoded.includes(query), false);
  assert.equal(encoded.includes(issueBody), false);
  assert.equal(encoded.includes(envDump), false);
  assert.equal(observed.resource, 'core');
  assert.equal(observed.remaining, 12);
  assert.equal(observed.reset, 1700000000);
  assert.equal(observed.retryAfter, 30);
  assert.equal(observed.classification, 'primary-exhaustion');

  // Well-known launcher and multiplexer variables are set as well, so a
  // future read of any of them would change the record and fail here.
  const launcher = 'IDD_TEST_LAUNCHER_NAME_3585';
  const session = 'IDD_TEST_SESSION_NAME_3585';
  const launcherVars = [
    launcher,
    session,
    'TMUX',
    'TERM_PROGRAM',
    'TERM_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_SESSION_ID',
  ];
  const previous = new Map(
    launcherVars.map((name) => [name, process.env[name]] as const),
  );
  const failure = { stderr: 'gh: HTTP 404' };
  const setLauncher = (launcherName: string, sessionName: string): void => {
    for (const name of launcherVars) {
      process.env[name] = name === session ? sessionName : launcherName;
    }
  };
  try {
    setLauncher('alpha-launcher', 'session-one');
    const first = observeGhFailure(failure);
    setLauncher('beta-launcher', 'session-two');
    const second = observeGhFailure(failure);
    assert.deepEqual(first, second);
    const stable = JSON.stringify(first);
    assert.equal(stable.includes('alpha-launcher'), false);
    assert.equal(stable.includes('session-one'), false);
    const telemetryPath = defaultGithubApiTelemetryPath();
    assert.equal(
      telemetryPath,
      join(
        homedir(),
        '.local',
        'state',
        'idd-skill',
        'github-api-telemetry.jsonl',
      ),
    );
    assert.equal(telemetryPath.includes('alpha-launcher'), false);
    assert.equal(telemetryPath.includes('session-one'), false);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('retention keeps a bounded allowlisted file', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-observe-'));
  const telemetryPath = join(tempRoot, 'telemetry.jsonl');
  try {
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({
        ...observeGhSuccess({ status: 199, data: { ok: true } }),
        token: 'ghp_OLDPOISON',
      })}\n`,
      { mode: 0o644 },
    );
    chmodSync(telemetryPath, 0o644);
    const poisoned = {
      ...observeGhSuccess({ status: 200, data: { ok: true } }),
      token: 'ghp_NEWPOISON',
    };
    appendRequestObservation(poisoned, { path: telemetryPath, maxRecords: 2 });
    appendRequestObservation(
      observeGhSuccess({ status: 201, data: { ok: true } }),
      { path: telemetryPath, maxRecords: 2 },
    );
    const text = readFileSync(telemetryPath, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2);
    assert.equal(text.includes('ghp_OLDPOISON'), false);
    assert.equal(text.includes('ghp_NEWPOISON'), false);
    assert.equal(text.includes('token'), false);
    assert.equal((statSync(telemetryPath).mode & 0o777) === 0o600, true);
    const kept = lines.map((line) => JSON.parse(line) as RequestObservation);
    assert.deepEqual(
      kept.map((record) => record.status),
      [200, 201],
    );

    const keptPoisonPath = join(tempRoot, 'kept.jsonl');
    writeFileSync(
      keptPoisonPath,
      `${JSON.stringify({
        ...observeGhSuccess({ status: 201, data: { ok: true } }),
        token: 'ghp_KEPTPOISON',
      })}\n`,
      { mode: 0o644 },
    );
    chmodSync(keptPoisonPath, 0o644);
    appendRequestObservation(
      observeGhSuccess({ status: 202, data: { ok: true } }),
      { path: keptPoisonPath, maxRecords: 5 },
    );
    const keptText = readFileSync(keptPoisonPath, 'utf8');
    assert.equal(keptText.includes('ghp_KEPTPOISON'), false);
    assert.equal(keptText.includes('token'), false);
    const keptLines = keptText
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RequestObservation);
    assert.equal(keptLines.length, 2);
    assert.equal(keptLines[1]?.status, 202);
    assert.equal((statSync(keptPoisonPath).mode & 0o777) === 0o600, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a path holding foreign content is left untouched', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-observe-foreign-'));
  const observation = observeGhSuccess({ status: 200, data: { ok: true } });
  try {
    const withoutKey = (key: keyof RequestObservation): string => {
      const copy: Record<string, unknown> = { ...observation };
      delete copy[key];
      return JSON.stringify(copy);
    };
    const foreignBodies = [
      '[user]\n\tname = someone\n',
      '{"token":"ghp_FOREIGN"}\n',
      `${JSON.stringify(observation)}\nnot a record\n`,
      // Another tool's JSONL that only shares two field names.
      '{"classification":"ok","signals":{},"note":"x"}\n',
      // A record missing one of this module's own fields is not ours.
      `${withoutKey('signals')}\n`,
      `${withoutKey('classification')}\n`,
      `${withoutKey('retryAttempts')}\n`,
      `${JSON.stringify({ ...observation, signals: 'no' })}\n`,
    ];
    for (const [index, content] of foreignBodies.entries()) {
      const target = join(tempRoot, `foreign-${index}.jsonl`);
      writeFileSync(target, content, { mode: 0o644 });
      assert.throws(
        () =>
          appendRequestObservation(observation, {
            path: target,
            maxRecords: 5,
          }),
        /not a retained observation/,
      );
      assert.equal(readFileSync(target, 'utf8'), content);
      assert.equal(existsSync(`${target}.lock`), false);
    }

    // A newer version's unknown classification is still this module's
    // record: it reads back as `unknown` and does not block writing.
    const newer = join(tempRoot, 'newer.jsonl');
    writeFileSync(
      newer,
      `${JSON.stringify({ ...observation, classification: 'timeout-v2', extra: 'x' })}\n`,
    );
    appendRequestObservation(observation, { path: newer, maxRecords: 5 });
    const newerRecords = readFileSync(newer, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(newerRecords.length, 2);
    assert.equal(newerRecords[0]?.classification, 'unknown');
    assert.equal('extra' in (newerRecords[0] ?? {}), false);

    const missing = join(tempRoot, 'new.jsonl');
    appendRequestObservation(observation, { path: missing, maxRecords: 5 });
    assert.deepEqual(
      JSON.parse(readFileSync(missing, 'utf8').trim()),
      observation,
    );
    const empty = join(tempRoot, 'empty.jsonl');
    writeFileSync(empty, '\n\n');
    appendRequestObservation(observation, { path: empty, maxRecords: 5 });
    assert.deepEqual(
      JSON.parse(readFileSync(empty, 'utf8').trim()),
      observation,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a held lock is never taken over, even when it looks old', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-observe-lock-'));
  const target = join(tempRoot, 'telemetry.jsonl');
  const lock = `${target}.lock`;
  const observation = observeGhSuccess({ status: 200, data: { ok: true } });
  try {
    appendRequestObservation(observation, { path: target, maxRecords: 5 });
    const before = readFileSync(target, 'utf8');

    // A lock an hour old may still belong to a paused writer that will
    // rename its older snapshot, so no other writer removes it.
    writeFileSync(lock, '4242\n');
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lock, anHourAgo, anHourAgo);
    assert.throws(
      () =>
        appendRequestObservation(observation, {
          path: target,
          maxRecords: 5,
          lockWaitMs: 60,
        }),
      /lock is held/,
    );
    assert.equal(readFileSync(lock, 'utf8'), '4242\n');
    assert.equal(readFileSync(target, 'utf8'), before);

    // A link planted at the lock path is a held lock too, not a file to
    // write through.
    rmSync(lock);
    const victim = join(tempRoot, 'victim.txt');
    writeFileSync(victim, 'keep me\n');
    let linked = true;
    try {
      symlinkSync(victim, lock);
    } catch {
      linked = false;
    }
    if (linked) {
      assert.throws(
        () =>
          appendRequestObservation(observation, {
            path: target,
            maxRecords: 5,
            lockWaitMs: 60,
          }),
        /lock is held/,
      );
      assert.equal(readFileSync(victim, 'utf8'), 'keep me\n');
      assert.equal(readFileSync(target, 'utf8'), before);
      rmSync(lock);
    }

    // Removing the lock by hand restores recording.
    appendRequestObservation(observation, { path: target, maxRecords: 5 });
    const lines = readFileSync(target, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a writer removes a lock only while it still holds its own token', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-observe-token-'));
  const lock = join(tempRoot, 'telemetry.jsonl.lock');
  try {
    // The lock names the holder's process id and a random token, and is
    // removed when the writer is done.
    let seen = '';
    withTelemetryFileLock(lock, 60, () => {
      seen = readFileSync(lock, 'utf8');
    });
    assert.match(seen, new RegExp(`^${process.pid}:[0-9a-f]{12}\\n$`));
    assert.equal(existsSync(lock), false);

    // A lock that was deleted and re-created by someone else while this
    // writer ran belongs to that writer, so it is left in place. Windows
    // does not let a file that is open be deleted, so this part is POSIX-only.
    if (process.platform !== 'win32') {
      withTelemetryFileLock(lock, 60, () => {
        rmSync(lock);
        writeFileSync(lock, 'other-writer\n');
      });
      assert.equal(readFileSync(lock, 'utf8'), 'other-writer\n');
      rmSync(lock);
    }

    // A failing body still releases the lock it owns.
    assert.throws(
      () =>
        withTelemetryFileLock(lock, 60, () => {
          throw new Error('body failed');
        }),
      /body failed/,
    );
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('the temporary file is created exclusively under an unpredictable name', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-observe-tmp-'));
  const victim = join(tempRoot, 'victim.txt');
  const target = join(tempRoot, 'telemetry.jsonl');
  const guessable = `${target}.${process.pid}.tmp`;
  const observation = observeGhSuccess({ status: 200, data: { ok: true } });
  try {
    writeFileSync(victim, 'keep me\n');
    try {
      // The former temporary name was this guessable one; a link planted
      // there must not be followed by the write.
      symlinkSync(victim, guessable);
    } catch {
      t.skip('symbolic links are unavailable here');
      return;
    }
    appendRequestObservation(observation, { path: target, maxRecords: 5 });
    assert.equal(readFileSync(victim, 'utf8'), 'keep me\n');
    assert.equal(existsSync(`${target}.lock`), false);
    const leftovers = readdirSync(tempRoot).filter(
      (name) => name.endsWith('.tmp') && join(tempRoot, name) !== guessable,
    );
    assert.deepEqual(leftovers, []);
    assert.equal(
      readFileSync(target, 'utf8').split('\n').filter(Boolean).length,
      1,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('concurrent appends keep every observation', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-observe-race-'));
  const telemetryPath = join(tempRoot, 'telemetry.jsonl');
  const workerPath = join(tempRoot, 'append-observation.mts');
  const moduleUrl = pathToFileURL(
    join(import.meta.dirname, '../src/scripts/github-api-observation.mts'),
  ).href;
  writeFileSync(
    workerPath,
    [
      `import { appendRequestObservation, observeGhSuccess } from ${JSON.stringify(moduleUrl)};`,
      'const status = Number(process.env.OBSERVATION_STATUS);',
      'appendRequestObservation(',
      '  observeGhSuccess({ status, data: { ok: true } }),',
      // A long wait keeps the test from depending on the short production
      // lock wait when the runner is loaded.
      '  { path: process.env.TELEMETRY_PATH ?? "", maxRecords: 10, lockWaitMs: 10000 },',
      ');',
      '',
    ].join('\n'),
  );
  const run = (status: number) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', workerPath],
        {
          env: {
            ...process.env,
            OBSERVATION_STATUS: String(status),
            TELEMETRY_PATH: telemetryPath,
          },
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(status);
        else
          reject(new Error(stderr || `append child ${status} exited ${code}`));
      });
    });
  try {
    await Promise.all([run(200), run(201), run(202), run(203)]);
    const lines = readFileSync(telemetryPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RequestObservation);
    assert.deepEqual(
      lines.map((record) => record.status).sort(),
      [200, 201, 202, 203],
    );
    assert.equal((statSync(telemetryPath).mode & 0o777) === 0o600, true);
    assert.equal(existsSync(`${telemetryPath}.lock`), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('githubApi telemetry defaults off and trims an enabled path', () => {
  const defaults = normalizePolicyConfig({});
  assert.equal(defaults.githubApi.telemetry.enabled, false);
  assert.equal(defaults.githubApi.telemetry.maxRecords, 100);
  assert.equal(defaults.githubApi.telemetry.path, null);

  const enabled = normalizePolicyConfig({
    githubApi: {
      telemetry: { enabled: true, maxRecords: 3, path: ' /tmp/x ' },
    },
  });
  assert.equal(enabled.githubApi.telemetry.enabled, true);
  assert.equal(enabled.githubApi.telemetry.maxRecords, 3);
  assert.equal(enabled.githubApi.telemetry.path, '/tmp/x');

  const ignored = normalizePolicyConfig({
    githubApi: { telemetry: { enabled: 'true', maxRecords: 0, path: '   ' } },
  });
  assert.equal(ignored.githubApi.telemetry.enabled, false);
  assert.equal(ignored.githubApi.telemetry.maxRecords, 100);
  assert.equal(ignored.githubApi.telemetry.path, null);
});

test('a configured telemetry path is expanded or rejected', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-path-'));
  const relative = 'idd-relative-telemetry-3585.jsonl';
  const strayFiles = [
    join(process.cwd(), relative),
    join(process.cwd(), `${relative}.lock`),
  ];
  try {
    assert.equal(
      resolveGithubApiTelemetryPath(null),
      defaultGithubApiTelemetryPath(),
    );
    assert.equal(
      resolveGithubApiTelemetryPath('~/state/x.jsonl'),
      join(homedir(), 'state', 'x.jsonl'),
    );
    const absolute = join(tempRoot, 'x.jsonl');
    assert.equal(resolveGithubApiTelemetryPath(absolute), absolute);
    for (const rejected of [
      'x.jsonl',
      './x.jsonl',
      '../x.jsonl',
      '~',
      '~/',
      '~other/x.jsonl',
      'state/~/x.jsonl',
    ]) {
      assert.equal(resolveGithubApiTelemetryPath(rejected), null, rejected);
    }

    // A rejected path records nothing, not even a file in the working tree.
    setGithubApiTelemetryPolicyForTests({
      enabled: true,
      maxRecords: 5,
      path: relative,
    });
    recordRequestObservation(
      observeGhSuccess({ status: 200, data: { ok: true } }),
    );
    for (const stray of strayFiles) assert.equal(existsSync(stray), false);

    // An absolute path in the same policy still records.
    setGithubApiTelemetryPolicyForTests({
      enabled: true,
      maxRecords: 5,
      path: absolute,
    });
    recordRequestObservation(
      observeGhSuccess({ status: 200, data: { ok: true } }),
    );
    assert.equal(existsSync(absolute), true);
  } finally {
    for (const stray of strayFiles) rmSync(stray, { force: true });
    setGithubApiTelemetryPolicyForTests(null);
    resetGithubApiTelemetryPolicyCacheForTests();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a paginated read records a failure only when the gh run itself failed (#3597)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-telemetry-'));
  const telemetryPath = join(tempRoot, 'telemetry.jsonl');
  const readCount = (): number =>
    existsSync(telemetryPath)
      ? readFileSync(telemetryPath, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0).length
      : 0;
  let restore: (() => void) | undefined;
  try {
    setGithubApiTelemetryPolicyForTests({
      enabled: true,
      maxRecords: 10,
      path: telemetryPath,
    });
    // A clean exit whose body does not parse is not a GitHub request
    // failure, and gh's own exit status is not to blame for it.
    restore = stubExecutable('gh', `process.stdout.write('not json\\n');`);
    assert.throws(() =>
      ghApiJson('repos/o/r/issues', { paginate: true, timeout: 30_000 }),
    );
    restore();
    assert.equal(readCount(), 0);
    // A gh that exits non-zero is recorded, once.
    restore = stubExecutable(
      'gh',
      `process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1);`,
    );
    assert.throws(() =>
      ghApiJson('repos/o/r/issues', { paginate: true, timeout: 30_000 }),
    );
    assert.equal(readCount(), 1);
  } finally {
    restore?.();
    setGithubApiTelemetryPolicyForTests(null);
    resetGithubApiTelemetryPolicyCacheForTests();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('opt-in telemetry does not change gh results or error classification', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-telemetry-'));
  const telemetryPath = join(tempRoot, 'telemetry.jsonl');
  const modePath = join(tempRoot, 'mode.txt');
  const argsPath = join(tempRoot, 'args.json');
  const token = 'placeholder-credential';
  const querySecret = 'secretFieldNameZz';
  const pageSecret = 'pageSecretZz';
  let restore: (() => void) | undefined;
  const readArgs = (): string[] =>
    JSON.parse(readFileSync(argsPath, 'utf8')) as string[];
  const readRecords = (): RequestObservation[] => {
    if (!existsSync(telemetryPath)) return [];
    return readFileSync(telemetryPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RequestObservation);
  };
  const setMode = (mode: string): void => {
    writeFileSync(modePath, `${mode}\n`);
  };
  try {
    setGithubApiTelemetryPolicyForTests(null);
    resetGithubApiTelemetryPolicyCacheForTests();
    assert.equal(readGithubApiTelemetryPolicy('{').enabled, false);
    resetGithubApiTelemetryPolicyCacheForTests();
    assert.equal(readGithubApiTelemetryPolicy('not-json').enabled, false);
    resetGithubApiTelemetryPolicyCacheForTests();
    const fromText = readGithubApiTelemetryPolicy(
      JSON.stringify({
        githubApi: {
          telemetry: { enabled: true, maxRecords: 4, path: '/tmp/x' },
        },
      }),
    );
    assert.equal(fromText.enabled, true);
    assert.equal(fromText.maxRecords, 4);
    assert.equal(fromText.path, '/tmp/x');

    setGithubApiTelemetryPolicyForTests({
      enabled: false,
      maxRecords: 100,
      path: null,
    });
    restore = stubExecutable(
      'gh',
      `
const fs = require('node:fs');
const mode = fs.readFileSync(${JSON.stringify(modePath)}, 'utf8').trim();
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
function envelope(status, extra, body) {
  process.stdout.write('HTTP/2 ' + status + '\\n' + extra + '\\n\\n' + body);
}
if (mode === 'plain-ok') {
  process.stdout.write('{"n":1}\\n');
} else if (mode === 'envelope-ok') {
  envelope(200, 'x-ratelimit-remaining: 40\\nx-ratelimit-resource: core\\nx-ratelimit-reset: 1700000100', '{"n":2}');
} else if (mode === 'plain-despite-include') {
  process.stdout.write('{"n":3}\\n');
} else if (mode === 'allow') {
  envelope(404, 'x-ratelimit-remaining: 9', '{"message":"missing"}');
  process.exit(1);
} else if (mode === 'allow-plain') {
  process.stdout.write('{"message":"missing-plain"}\\n');
  process.stderr.write('gh: Not Found (HTTP 404)\\n');
  process.exit(1);
} else if (mode === 'allow-secondary') {
  envelope(403, 'x-ratelimit-remaining: 3', '{"message":"You have exceeded a secondary rate limit. Please wait."}');
  process.exit(1);
} else if (mode === 'allow-empty') {
  envelope(404, 'x-ratelimit-remaining: 9', '');
  process.exit(1);
} else if (mode === 'empty-ok') {
  process.stdout.write('');
} else if (mode === 'rest-errors') {
  envelope(200, 'x-ratelimit-remaining: 8\\nx-ratelimit-resource: core', '{"errors":[{"message":"validation"}],"title":"API rate limit exceeded"}');
} else if (mode === 'rate') {
  process.stderr.write(${JSON.stringify(`token=${token}\nAPI rate limit exceeded (HTTP 403)\n`)});
  process.exit(1);
} else if (mode === 'graphql-errors') {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      data: { [querySecret]: true, rateLimit: { cost: 7, remaining: 4 } },
      errors: [{ message: 'secret-graphql-message-zz' }],
    }),
  )});
} else if (mode === 'graphql-mixed') {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      data: { rateLimit: { cost: 3, remaining: 0 } },
      errors: [{ message: 'secret-graphql-message-zz' }],
    }),
  )});
} else if (mode === 'graphql-primary') {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      data: { ok: true, rateLimit: { cost: 2, remaining: 0 } },
    }),
  )});
} else if (mode === 'graphql-fail-body') {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      data: { note: 'quoted secondary rate limit text (HTTP 403)' },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }],
    }),
  )});
  process.stderr.write('gh: Could not resolve\\n');
  process.exit(1);
} else if (mode === 'rate-envelope') {
  envelope(403, 'x-ratelimit-remaining: 0\\nx-ratelimit-resource: core\\nx-ratelimit-reset: 1700000200', '{"message":"API rate limit exceeded"}');
  process.stderr.write('gh: API rate limit exceeded (HTTP 403)\\n');
  process.exit(1);
} else if (mode === 'graphql-no-cost') {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      data: { ok: true },
      extensions: { cost: { actualQueryCost: 9 } },
    }),
  )});
} else if (mode === 'allow-paginated') {
  process.stdout.write('{"partial":1}\\n');
  process.stderr.write('gh: API rate limit exceeded (HTTP 403)\\n');
  process.exit(1);
} else if (mode === 'paginated-fail-body') {
  process.stdout.write('{"body":"hit API rate limit exceeded"}\\n');
  process.stderr.write('gh: Server Error (HTTP 500)\\n');
  process.exit(1);
} else if (mode === 'allow-paginated-body') {
  process.stdout.write('{"body":"hit API rate limit exceeded"}\\n');
  process.stderr.write('gh: Server Error (HTTP 500)\\n');
  process.exit(1);
} else if (mode === 'paginate') {
  process.stdout.write(${JSON.stringify(`{"${pageSecret}":1}\n{"${pageSecret}":2}\n`)});
} else {
  process.stderr.write('unexpected mode ' + mode);
  process.exit(2);
}
`,
    );

    const apiPath = 'repos/secret-owner-zz/secret-repo-zz/issues/1';
    setMode('plain-ok');
    assert.deepEqual(ghApiJson(apiPath), { n: 1 });
    assert.equal(readArgs().includes('--include'), false);
    assert.equal(existsSync(telemetryPath), false);

    setMode('envelope-ok');
    const withHeaders = ghApiJsonWithHeaders(apiPath);
    assert.deepEqual(withHeaders.data, { n: 2 });
    assert.equal(readArgs().includes('--include'), true);
    assert.equal(existsSync(telemetryPath), false);

    // A rejected path keeps the wrappers unobserved: no `--include` and no
    // file, the same as the disabled policy above.
    setGithubApiTelemetryPolicyForTests({
      enabled: true,
      maxRecords: 20,
      path: 'rejected-relative-telemetry-3585.jsonl',
    });
    setMode('plain-ok');
    assert.deepEqual(ghApiJson(apiPath), { n: 1 });
    assert.equal(readArgs().includes('--include'), false);
    assert.equal(existsSync(telemetryPath), false);

    setGithubApiTelemetryPolicyForTests({
      enabled: true,
      maxRecords: 20,
      path: telemetryPath,
    });
    setMode('envelope-ok');
    assert.deepEqual(ghApiJson(apiPath), { n: 2 });
    const includedArgs = readArgs();
    assert.equal(includedArgs.filter((arg) => arg === '--include').length, 1);
    assert.equal(includedArgs.includes(apiPath), true);
    let last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.status, 200);
    assert.equal(last.remaining, 40);
    assert.equal(last.resource, 'core');
    assert.equal(last.classification, 'ok');
    assert.equal(last.commandInvocationCount, 1);
    assert.equal(last.retryAttempts, 0);
    assert.equal(readFileSync(telemetryPath, 'utf8').includes(apiPath), false);

    setMode('plain-despite-include');
    assert.deepEqual(ghApiJson(apiPath), { n: 3 });
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.status, 'unknown');
    assert.equal(last.classification, 'ok');
    assert.equal(last.httpRequestCount, 1);

    setMode('allow');
    assert.deepEqual(ghApiJson(apiPath, { allowStatuses: [1] }), {
      message: 'missing',
    });
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.status, 404);
    assert.equal(last.classification, 'unknown');
    assert.equal(last.signals.accessDenied, false);

    setMode('allow-plain');
    assert.deepEqual(ghApiJson(apiPath, { allowStatuses: [1] }), {
      message: 'missing-plain',
    });
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.status, 404);
    assert.equal(last.classification, 'unknown');
    assert.equal(last.signals.accessDenied, false);

    setMode('allow-secondary');
    assert.deepEqual(ghApiJson(apiPath, { allowStatuses: [1] }), {
      message: 'You have exceeded a secondary rate limit. Please wait.',
    });
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.status, 403);
    assert.equal(last.classification, 'secondary-throttling');
    assert.equal(last.signals.accessDenied, false);
    assert.equal(last.signals.primaryExhaustion, false);

    setMode('allow-empty');
    assert.throws(() => ghApiJson(apiPath, { allowStatuses: [1] }));
    last = readRecords().at(-1);
    assert.ok(last);
    assert.notEqual(last.classification, 'ok');

    setMode('empty-ok');
    assert.deepEqual(ghApiJson(apiPath), {});
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.classification, 'ok');
    assert.equal(last.status, 'unknown');

    setMode('rest-errors');
    assert.deepEqual(ghApiJson(apiPath), {
      errors: [{ message: 'validation' }],
      title: 'API rate limit exceeded',
    });
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.classification, 'ok');
    assert.equal(last.signals.graphqlErrors, false);
    assert.equal(last.signals.primaryExhaustion, false);
    assert.equal(
      readFileSync(telemetryPath, 'utf8').includes('API rate limit exceeded'),
      false,
    );

    setMode('rate');
    let enabledError: unknown;
    try {
      ghApiJson(apiPath);
      assert.fail('expected the rate-limit stub to throw');
    } catch (error) {
      enabledError = error;
    }
    const enabledClass = classifyHelperError(enabledError);
    const enabledText = readFileSync(telemetryPath, 'utf8');
    assert.equal(enabledText.includes(token), false);
    assert.equal(enabledText.includes(apiPath), false);
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.classification, 'primary-exhaustion');
    assert.equal(
      String((enabledError as { stderr?: unknown }).stderr ?? '').includes(
        token,
      ),
      true,
    );
    // A non-tolerated REST failure keeps its stdout envelope, so the rate
    // limit headers printed there are captured next to the stderr status.
    setMode('rate-envelope');
    assert.throws(() => ghApiJson(apiPath));
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.status, 403);
    assert.equal(last.remaining, 0);
    assert.equal(last.resource, 'core');
    assert.equal(last.reset, 1700000200);
    assert.equal(last.classification, 'primary-exhaustion');
    const linesBeforeDisabled = readRecords().length;

    setGithubApiTelemetryPolicyForTests({
      enabled: false,
      maxRecords: 20,
      path: telemetryPath,
    });
    let disabledError: unknown;
    try {
      ghApiJson(apiPath);
      assert.fail('expected the disabled rate-limit stub to throw');
    } catch (error) {
      disabledError = error;
    }
    const disabledClass = classifyHelperError(disabledError);
    assert.equal(disabledClass.kind, enabledClass.kind);
    assert.equal(disabledClass.httpStatus, enabledClass.httpStatus);
    assert.equal(disabledClass.kind, 'transport');
    assert.equal(disabledClass.httpStatus, 403);
    assert.equal(readArgs().includes('--include'), false);
    assert.equal(readRecords().length, linesBeforeDisabled);

    setGithubApiTelemetryPolicyForTests({
      enabled: true,
      maxRecords: 20,
      path: telemetryPath,
    });
    setMode('graphql-errors');
    const graphqlQuery = `query { ${querySecret} }`;
    ghGraphql(graphqlQuery, { owner: 'secret-owner-zz' });
    const graphqlArgs = readArgs();
    assert.equal(graphqlArgs.includes('--include'), false);
    assert.equal(graphqlArgs.includes('graphql'), true);
    assert.equal(
      graphqlArgs.some((arg) => arg.includes(querySecret)),
      true,
    );
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.classification, 'graphql-errors');
    assert.equal(last.graphqlCost, 7);
    assert.equal(last.status, 'unknown');
    assert.equal(last.httpRequestCount, 'unknown');
    assert.equal(last.pageCount, 'unknown');
    assert.equal(last.signals.primaryExhaustion, false);
    const graphqlText = readFileSync(telemetryPath, 'utf8');
    assert.equal(graphqlText.includes(querySecret), false);
    assert.equal(graphqlText.includes('secret-graphql-message-zz'), false);
    assert.equal(graphqlText.includes('secret-owner-zz'), false);

    setMode('graphql-mixed');
    ghGraphql(graphqlQuery, {});
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.classification, 'unknown');
    assert.equal(last.signals.graphqlErrors, true);
    assert.equal(last.signals.primaryExhaustion, true);
    assert.equal(last.signals.secondaryThrottling, false);

    setMode('graphql-primary');
    ghGraphql(graphqlQuery, {});
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.classification, 'primary-exhaustion');
    assert.equal(last.signals.secondaryThrottling, false);
    assert.equal(last.graphqlCost, 2);
    assert.equal(last.httpRequestCount, 'unknown');

    // Real gh exits non-zero with the response body on stdout. User content
    // under `data` must not classify the failure.
    setMode('graphql-fail-body');
    assert.throws(() => ghGraphql(graphqlQuery, {}));
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.classification, 'graphql-errors');
    assert.equal(last.status, 'unknown');
    assert.equal(last.signals.secondaryThrottling, false);
    assert.equal(last.httpRequestCount, 'unknown');

    setMode('graphql-no-cost');
    ghGraphql(graphqlQuery, {});
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.classification, 'ok');
    assert.equal(last.graphqlCost, 'unknown');

    setMode('allow-paginated');
    assert.deepEqual(
      ghApiJson(apiPath, { paginate: true, allowStatuses: [1] }),
      [{ partial: 1 }],
    );
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.status, 403);
    assert.equal(last.classification, 'primary-exhaustion');
    assert.equal(last.httpRequestCount, 'unknown');

    // Page data on stdout is not failure evidence, so quota wording inside
    // it must not classify the record, whether or not the exit is tolerated.
    setMode('paginated-fail-body');
    assert.throws(() => ghApiJson(apiPath, { paginate: true }));
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.status, 500);
    assert.equal(last.signals.primaryExhaustion, false);
    assert.equal(last.classification, 'unknown');

    setMode('allow-paginated-body');
    assert.deepEqual(
      ghApiJson(apiPath, { paginate: true, allowStatuses: [1] }),
      [{ body: 'hit API rate limit exceeded' }],
    );
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.status, 500);
    assert.equal(last.signals.primaryExhaustion, false);
    assert.equal(last.classification, 'unknown');

    setMode('paginate');
    assert.deepEqual(ghApiJson(apiPath, { paginate: true }), [
      { [pageSecret]: 1 },
      { [pageSecret]: 2 },
    ]);
    const pageArgs = readArgs();
    assert.equal(pageArgs.includes('--paginate'), true);
    assert.equal(pageArgs.includes('--include'), false);
    last = readRecords().at(-1);
    assert.ok(last);
    assert.equal(last.httpRequestCount, 'unknown');
    assert.equal(last.pageCount, 'unknown');
    assert.equal(last.commandInvocationCount, 1);
    assert.equal(last.retryAttempts, 0);
    assert.equal(
      readFileSync(telemetryPath, 'utf8').includes(pageSecret),
      false,
    );
    assert.equal(readFileSync(telemetryPath, 'utf8').includes(apiPath), false);
  } finally {
    restore?.();
    setGithubApiTelemetryPolicyForTests(null);
    resetGithubApiTelemetryPolicyCacheForTests();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
