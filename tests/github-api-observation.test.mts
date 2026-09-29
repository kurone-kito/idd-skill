import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  resetGithubApiTelemetryPolicyCacheForTests,
  setGithubApiTelemetryPolicyForTests,
  summarizeInjectedExchanges,
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
      extensions: { cost: { actualQueryCost: 4 } },
    },
  });
  assert.equal(graphqlErrors.classification, 'graphql-errors');
  assert.equal(graphqlErrors.graphqlCost, 4);
  assert.equal(graphqlErrors.signals.graphqlErrors, true);
  assert.equal(graphqlErrors.signals.primaryExhaustion, false);

  const graphqlMixed = observeGhSuccess({
    data: {
      errors: [{ message: 'nope' }],
      extensions: {
        cost: { actualQueryCost: 1, throttleStatus: { remaining: 0 } },
      },
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
    data: {
      data: { ok: true },
      extensions: {
        cost: { actualQueryCost: 2, throttleStatus: { remaining: 0 } },
      },
    },
    graphql: true,
    httpObserved: false,
  });
  assert.equal(graphqlPrimary.classification, 'primary-exhaustion');
  assert.equal(graphqlPrimary.signals.secondaryThrottling, false);
  assert.equal(graphqlPrimary.graphqlCost, 2);

  const fractionalCost = observeGhSuccess({
    status: 200,
    graphql: true,
    data: { extensions: { cost: { actualQueryCost: 1.5 } } },
  });
  assert.equal(fractionalCost.graphqlCost, 'unknown');
  assert.equal(fractionalCost.classification, 'ok');

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

  const launcher = 'IDD_TEST_LAUNCHER_NAME_3585';
  const session = 'IDD_TEST_SESSION_NAME_3585';
  const previousLauncher = process.env[launcher];
  const previousSession = process.env[session];
  const failure = { stderr: 'gh: HTTP 404' };
  try {
    process.env[launcher] = 'alpha-launcher';
    process.env[session] = 'session-one';
    const first = observeGhFailure(failure);
    process.env[launcher] = 'beta-launcher';
    process.env[session] = 'session-two';
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
    if (previousLauncher === undefined) delete process.env[launcher];
    else process.env[launcher] = previousLauncher;
    if (previousSession === undefined) delete process.env[session];
    else process.env[session] = previousSession;
  }
});

test('retention keeps a bounded allowlisted file', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-observe-'));
  const telemetryPath = join(tempRoot, 'telemetry.jsonl');
  try {
    writeFileSync(telemetryPath, '{"token":"ghp_OLDPOISON"}\n', {
      mode: 0o644,
    });
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
    writeFileSync(keptPoisonPath, '{"token":"ghp_KEPTPOISON"}\n', {
      mode: 0o644,
    });
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
      '  { path: process.env.TELEMETRY_PATH ?? "", maxRecords: 10 },',
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
} else if (mode === 'rest-errors') {
  envelope(200, 'x-ratelimit-remaining: 8\\nx-ratelimit-resource: core', '{"errors":[{"message":"validation"}],"title":"API rate limit exceeded"}');
} else if (mode === 'rate') {
  process.stderr.write(${JSON.stringify(`token=${token}\nAPI rate limit exceeded (HTTP 403)\n`)});
  process.exit(1);
} else if (mode === 'graphql-errors') {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      data: { [querySecret]: true },
      errors: [{ message: 'secret-graphql-message-zz' }],
      extensions: {
        cost: { actualQueryCost: 7, throttleStatus: { remaining: 4 } },
      },
    }),
  )});
} else if (mode === 'graphql-mixed') {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      errors: [{ message: 'secret-graphql-message-zz' }],
      extensions: {
        cost: { actualQueryCost: 3, throttleStatus: { remaining: 0 } },
      },
    }),
  )});
} else if (mode === 'graphql-primary') {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      data: { ok: true },
      extensions: {
        cost: { actualQueryCost: 2, throttleStatus: { remaining: 0 } },
      },
    }),
  )});
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
