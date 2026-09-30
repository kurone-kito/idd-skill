// idd-generated-from: src/scripts/github-api-observation.mts
//
// The scripts/github-api-observation.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Shared request-lifecycle observations for the owned GitHub transport
// wrappers (issue #3585). Records are allowlisted: a failure's raw
// stderr, body, token, query, or environment is never copied through.
// Telemetry defaults off. A read or write failure here must not change
// the caller's return value or thrown error.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  classifyInaccessibleIssueLookup,
  deriveGhHttpStatus,
} from './gh-http-status.mjs';
import { normalizePolicyConfig } from './policy-helpers.mjs';
export const OBSERVATION_UNKNOWN = 'unknown';
export const DEFAULT_GITHUB_API_TELEMETRY_MAX_RECORDS = 100;
export const DEFAULT_GITHUB_API_TELEMETRY = Object.freeze({
  enabled: false,
  maxRecords: DEFAULT_GITHUB_API_TELEMETRY_MAX_RECORDS,
  path: null,
});
const RESOURCE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const INTEGER_TOKEN = /^\d{1,12}$/;
const PRIMARY_WORDING = /API rate limit exceeded/i;
const SECONDARY_WORDING = /secondary rate limit/i;
const EMPTY_SIGNALS = Object.freeze({
  graphqlErrors: false,
  primaryExhaustion: false,
  secondaryThrottling: false,
  accessDenied: false,
});
function unknownObservation(counts) {
  return {
    status: OBSERVATION_UNKNOWN,
    resource: OBSERVATION_UNKNOWN,
    remaining: OBSERVATION_UNKNOWN,
    reset: OBSERVATION_UNKNOWN,
    retryAfter: OBSERVATION_UNKNOWN,
    graphqlCost: OBSERVATION_UNKNOWN,
    classification: 'unknown',
    signals: { ...EMPTY_SIGNALS },
    ...counts,
  };
}
function finiteInteger(value) {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000_000
    ? value
    : null;
}
function integerToken(value) {
  if (!value || !INTEGER_TOKEN.test(value)) return null;
  return finiteInteger(Number(value));
}
function headerValue(headers, name) {
  if (!headers) return undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct.trim();
  const found = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  );
  return found?.[1]?.trim();
}
function readHeaderLine(text, name) {
  const match = text.match(new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'im'));
  return match?.[1];
}
function graphqlRoot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value;
}
function parseJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}
function classifyFields(input) {
  const root = input.interpretGraphql
    ? (graphqlRoot(input.graphqlBody) ??
      graphqlRoot(parseJsonObject(input.bodyText)))
    : null;
  const graphqlErrors =
    input.interpretGraphql &&
    Array.isArray(root?.errors) &&
    root.errors.length > 0;
  // Cost stays unknown unless the query selected `rateLimit { cost }`.
  const cost = input.interpretGraphql
    ? finiteInteger(root?.data?.rateLimit?.cost)
    : null;
  // A selected `rateLimit { remaining }` of 0 is primary quota evidence.
  // It is not a secondary-throttling subtype (issue #3585, #3560).
  const throttleRemaining = input.interpretGraphql
    ? finiteInteger(root?.data?.rateLimit?.remaining)
    : null;
  const primaryExhaustion =
    input.remaining === 0 ||
    throttleRemaining === 0 ||
    (input.scanWording && PRIMARY_WORDING.test(input.bodyText));
  const secondaryThrottling =
    input.scanWording && SECONDARY_WORDING.test(input.bodyText);
  const accessDenied =
    input.status === 401 ||
    (input.status === 403 &&
      classifyInaccessibleIssueLookup({
        stderr: `(HTTP 403)\n${input.bodyText}`,
      }) === 'inaccessible');
  const signals = {
    graphqlErrors,
    primaryExhaustion,
    secondaryThrottling,
    accessDenied,
  };
  const positive = [
    graphqlErrors,
    primaryExhaustion,
    secondaryThrottling,
    accessDenied,
  ].filter(Boolean).length;
  let classification = 'unknown';
  if (positive > 1) {
    classification = 'unknown';
  } else if (graphqlErrors) {
    classification = 'graphql-errors';
  } else if (primaryExhaustion) {
    classification = 'primary-exhaustion';
  } else if (secondaryThrottling) {
    classification = 'secondary-throttling';
  } else if (accessDenied) {
    classification = 'access-denied';
  } else if (
    input.transportSucceeded ||
    (input.status !== null && input.status >= 200 && input.status < 300)
  ) {
    classification = 'ok';
  }
  const resource =
    input.resourceToken && RESOURCE_TOKEN.test(input.resourceToken)
      ? input.resourceToken
      : OBSERVATION_UNKNOWN;
  return {
    status: input.status === null ? OBSERVATION_UNKNOWN : input.status,
    resource,
    remaining: input.remaining === null ? OBSERVATION_UNKNOWN : input.remaining,
    reset: input.reset === null ? OBSERVATION_UNKNOWN : input.reset,
    retryAfter:
      input.retryAfter === null ? OBSERVATION_UNKNOWN : input.retryAfter,
    graphqlCost: cost === null ? OBSERVATION_UNKNOWN : cost,
    classification,
    signals,
  };
}
function fieldsFromResponse(response) {
  const headers = response.headers;
  const status =
    typeof response.status === 'number' && response.status >= 100
      ? response.status
      : null;
  // Match observeGhSuccess: scan rate-limit phrases only on an explicit
  // non-2xx. A 2xx issue title must not become quota exhaustion, and a
  // missing status is not guessed into a failure scan.
  const transportSucceeded = status !== null && status >= 200 && status < 300;
  return classifyFields({
    status,
    resourceToken: headerValue(headers, 'x-ratelimit-resource'),
    remaining: integerToken(headerValue(headers, 'x-ratelimit-remaining')),
    reset: integerToken(headerValue(headers, 'x-ratelimit-reset')),
    retryAfter: integerToken(headerValue(headers, 'retry-after')),
    bodyText: response.bodyText ?? '',
    graphqlBody: response.graphqlBody,
    interpretGraphql: response.graphqlBody !== undefined,
    scanWording: status !== null && !transportSucceeded,
    transportSucceeded,
  });
}
function mergeSignals(parts) {
  return {
    graphqlErrors: parts.some((part) => part.graphqlErrors),
    primaryExhaustion: parts.some((part) => part.primaryExhaustion),
    secondaryThrottling: parts.some((part) => part.secondaryThrottling),
    accessDenied: parts.some((part) => part.accessDenied),
  };
}
function classificationFromSignals(signals, transportSucceeded) {
  const positive = [
    signals.graphqlErrors,
    signals.primaryExhaustion,
    signals.secondaryThrottling,
    signals.accessDenied,
  ].filter(Boolean).length;
  if (positive > 1) return 'unknown';
  if (signals.graphqlErrors) return 'graphql-errors';
  if (signals.primaryExhaustion) return 'primary-exhaustion';
  if (signals.secondaryThrottling) return 'secondary-throttling';
  if (signals.accessDenied) return 'access-denied';
  return transportSucceeded ? 'ok' : 'unknown';
}
function lastObserved(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== OBSERVATION_UNKNOWN) return values[index];
  }
  return OBSERVATION_UNKNOWN;
}
/**
 * Sum injected exchanges. HTTP and page counts are exact only when every
 * exchange supplies `responses`; otherwise those two fields are
 * `unknown`. Command invocations and retry attempts stay their own sums.
 */
// audit:ignore-dead-export: injected per-response exchanges have no production caller; gh --paginate cannot observe them (issue #3585)
export function summarizeInjectedExchanges(exchanges) {
  let commands = 0;
  let retries = 0;
  let http = 0;
  let pages = 0;
  let httpKnown = true;
  const fields = [];
  for (const exchange of exchanges) {
    commands += finiteInteger(exchange.commandInvocations) ?? 1;
    retries += finiteInteger(exchange.retryAttempts) ?? 0;
    if (exchange.responses === undefined) {
      httpKnown = false;
      continue;
    }
    http += exchange.responses.length;
    pages += exchange.responses.length;
    for (const response of exchange.responses) {
      fields.push(fieldsFromResponse(response));
    }
  }
  if (!httpKnown || fields.length === 0) {
    return unknownObservation({
      httpRequestCount: httpKnown ? http : OBSERVATION_UNKNOWN,
      pageCount: httpKnown ? pages : OBSERVATION_UNKNOWN,
      commandInvocationCount: commands,
      retryAttempts: retries,
    });
  }
  const signals = mergeSignals(fields.map((field) => field.signals));
  const transportSucceeded = fields.every(
    (field) =>
      field.classification === 'ok' || field.status === OBSERVATION_UNKNOWN,
  );
  return {
    status: lastObserved(fields.map((field) => field.status)),
    resource: lastObserved(fields.map((field) => field.resource)),
    remaining: lastObserved(fields.map((field) => field.remaining)),
    reset: lastObserved(fields.map((field) => field.reset)),
    retryAfter: lastObserved(fields.map((field) => field.retryAfter)),
    graphqlCost: lastObserved(fields.map((field) => field.graphqlCost)),
    httpRequestCount: http,
    pageCount: pages,
    commandInvocationCount: commands,
    retryAttempts: retries,
    classification: classificationFromSignals(signals, transportSucceeded),
    signals,
  };
}
/** Observe one captured failure without retaining its raw text. */
export function observeGhFailure(error, counts = {}) {
  const candidate = error;
  const stderrText = candidate?.stderr == null ? '' : String(candidate.stderr);
  const stdoutText = candidate?.stdout == null ? '' : String(candidate.stdout);
  // Only the captured streams are evidence. `error.message` embeds the
  // full argv (`-f body=...`, `-f query=...`), so request text must not
  // drive the recorded status or classification.
  const scanned = [stderrText, stdoutText]
    .filter((value) => value.length > 0)
    .join('\n');
  const fields = classifyFields({
    status: deriveGhHttpStatus({ stderr: stderrText, stdout: stdoutText }),
    resourceToken: readHeaderLine(scanned, 'x-ratelimit-resource'),
    remaining: integerToken(readHeaderLine(scanned, 'x-ratelimit-remaining')),
    reset: integerToken(readHeaderLine(scanned, 'x-ratelimit-reset')),
    retryAfter: integerToken(readHeaderLine(scanned, 'retry-after')),
    bodyText: scanned,
    // The JSON body is on stdout; gh's own stderr text can hold a `{`.
    graphqlBody:
      counts.graphql === true
        ? (parseJsonObject(stdoutText) ?? parseJsonObject(scanned))
        : undefined,
    interpretGraphql: counts.graphql === true,
    scanWording: true,
    transportSucceeded: false,
  });
  // A request is counted only when an HTTP status proves one happened. A
  // spawn error, a timeout, or an auth failure before any request stays
  // unknown, the same as a GraphQL success that saw no status.
  const httpObserved = fields.status !== OBSERVATION_UNKNOWN;
  const paginated = counts.paginated === true;
  const requestCount = paginated || !httpObserved ? OBSERVATION_UNKNOWN : 1;
  return {
    ...fields,
    httpRequestCount: requestCount,
    pageCount: requestCount,
    commandInvocationCount: counts.commandInvocationCount ?? 1,
    retryAttempts: counts.retryAttempts ?? 0,
  };
}
/** Observe one successful wrapper result. `data` is not stored. */
export function observeGhSuccess(input) {
  let dataText = '';
  if (input.data !== undefined) {
    try {
      dataText = JSON.stringify(input.data);
    } catch {
      dataText = '';
    }
  }
  const status = typeof input.status === 'number' ? input.status : null;
  // A missing status is not treated as HTTP 200. Null still counts as a
  // successful wrapper exit (GraphQL never sees a status line). An
  // explicit 4xx/5xx does not. Rate-limit phrases are scanned only on
  // that explicit failure status: a 2xx issue title must not become
  // quota exhaustion, and a tolerated 403/429 must not lose its
  // secondary or primary wording.
  const transportSucceeded = status === null || (status >= 200 && status < 300);
  const fields = classifyFields({
    status,
    resourceToken: headerValue(input.headers, 'x-ratelimit-resource'),
    remaining: integerToken(
      headerValue(input.headers, 'x-ratelimit-remaining'),
    ),
    reset: integerToken(headerValue(input.headers, 'x-ratelimit-reset')),
    retryAfter: integerToken(headerValue(input.headers, 'retry-after')),
    bodyText: dataText,
    graphqlBody: input.graphql === true ? input.data : undefined,
    interpretGraphql: input.graphql === true,
    scanWording: status !== null && !transportSucceeded,
    transportSucceeded,
  });
  const httpKnown = input.paginated !== true && input.httpObserved !== false;
  return {
    ...fields,
    httpRequestCount: httpKnown ? 1 : OBSERVATION_UNKNOWN,
    pageCount: httpKnown ? 1 : OBSERVATION_UNKNOWN,
    commandInvocationCount: input.commandInvocationCount ?? 1,
    retryAttempts: 0,
  };
}
export function defaultGithubApiTelemetryPath() {
  return join(
    homedir(),
    '.local',
    'state',
    'idd-skill',
    'github-api-telemetry.jsonl',
  );
}
/**
 * Resolve the configured retention path. A leading `~/` is the home
 * directory, which Node does not expand. Any other non-absolute path would
 * resolve against the current directory, normally the repository checkout,
 * and put the file and its lock in the working tree, so it resolves to
 * null and telemetry stays off. A null configuration uses the default.
 */
// audit:ignore-dead-export: reached in production through recordRequestObservation; exported so its cases are unit-tested (issue #3585)
export function resolveGithubApiTelemetryPath(configured) {
  if (configured === null) return defaultGithubApiTelemetryPath();
  const expanded = configured.startsWith('~/')
    ? join(homedir(), configured.slice(2))
    : configured;
  return isAbsolute(expanded) ? expanded : null;
}
/** Copy only the allowlisted observation fields, in a stable order. */
export function allowlistObservation(observation) {
  return {
    status: observation.status,
    resource: observation.resource,
    remaining: observation.remaining,
    reset: observation.reset,
    retryAfter: observation.retryAfter,
    httpRequestCount: observation.httpRequestCount,
    pageCount: observation.pageCount,
    commandInvocationCount: observation.commandInvocationCount,
    retryAttempts: observation.retryAttempts,
    graphqlCost: observation.graphqlCost,
    classification: observation.classification,
    signals: {
      graphqlErrors: observation.signals.graphqlErrors === true,
      primaryExhaustion: observation.signals.primaryExhaustion === true,
      secondaryThrottling: observation.signals.secondaryThrottling === true,
      accessDenied: observation.signals.accessDenied === true,
    },
  };
}
const TELEMETRY_LOCK_WAIT_MS = 2000;
const TELEMETRY_LOCK_STALE_MS = 10_000;
const CLASSIFICATIONS = new Set([
  'ok',
  'graphql-errors',
  'primary-exhaustion',
  'secondary-throttling',
  'access-denied',
  'unknown',
]);
function storedMaybeNumber(value) {
  if (value === OBSERVATION_UNKNOWN) return OBSERVATION_UNKNOWN;
  const parsed = finiteInteger(value);
  return parsed === null ? OBSERVATION_UNKNOWN : parsed;
}
function storedResource(value) {
  return typeof value === 'string' && RESOURCE_TOKEN.test(value)
    ? value
    : OBSERVATION_UNKNOWN;
}
function storedClassification(value) {
  return typeof value === 'string' && CLASSIFICATIONS.has(value)
    ? value
    : 'unknown';
}
/** Every field a record written by this module carries. */
const RECORD_KEYS = [
  'status',
  'resource',
  'remaining',
  'reset',
  'retryAfter',
  'httpRequestCount',
  'pageCount',
  'commandInvocationCount',
  'retryAttempts',
  'graphqlCost',
  'classification',
  'signals',
];
/**
 * Re-read one retained line as an allowlisted observation, dropping any
 * field outside the allowlist. Returns null when the line is not one of
 * this module's own records, so a caller can tell a foreign file from a
 * retained one. A record is recognized by carrying every field this module
 * writes (and an object `signals`), not by the vocabulary of one field: a
 * newer version's unknown `classification` still reads back as `unknown`,
 * while another tool's JSON object is not mistaken for a record.
 */
function observationFromStoredLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed;
  if (
    !RECORD_KEYS.every((key) => Object.hasOwn(record, key)) ||
    !record.signals ||
    typeof record.signals !== 'object' ||
    Array.isArray(record.signals)
  ) {
    return null;
  }
  const signals = record.signals;
  return allowlistObservation({
    status: storedMaybeNumber(record.status),
    resource: storedResource(record.resource),
    remaining: storedMaybeNumber(record.remaining),
    reset: storedMaybeNumber(record.reset),
    retryAfter: storedMaybeNumber(record.retryAfter),
    httpRequestCount: storedMaybeNumber(record.httpRequestCount),
    pageCount: storedMaybeNumber(record.pageCount),
    commandInvocationCount: storedMaybeNumber(record.commandInvocationCount),
    retryAttempts: storedMaybeNumber(record.retryAttempts),
    graphqlCost: storedMaybeNumber(record.graphqlCost),
    classification: storedClassification(record.classification),
    signals: {
      graphqlErrors: signals.graphqlErrors === true,
      primaryExhaustion: signals.primaryExhaustion === true,
      secondaryThrottling: signals.secondaryThrottling === true,
      accessDenied: signals.accessDenied === true,
    },
  });
}
function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
/**
 * Exclusive create of a sibling lock file. A crash leaves the lock;
 * a stale file is removed and the create is retried. Callers swallow
 * a timeout so a contended write cannot change the gh result.
 */
function withTelemetryFileLock(lockPath, body) {
  const deadline = Date.now() + TELEMETRY_LOCK_WAIT_MS;
  let fd;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      const code = error?.code;
      if (code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > TELEMETRY_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error('github api telemetry lock timed out');
      }
      sleepMs(20);
    }
  }
  try {
    chmodSync(lockPath, 0o600);
    body();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // The next writer removes a stale lock after TELEMETRY_LOCK_STALE_MS.
    }
  }
}
/**
 * Read the retained lines of a telemetry file, re-serialized through the
 * allowlist. A missing file has none. The rewrite replaces the whole file,
 * so a file holding anything but this module's own records (a misdirected
 * `path`) is refused instead of rewritten.
 */
function readRetainedLines(path) {
  let existing = '';
  try {
    existing = readFileSync(path, 'utf8');
  } catch (error) {
    const code = error?.code;
    if (code !== 'ENOENT') throw error;
  }
  const lines = [];
  for (const raw of existing.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const retained = observationFromStoredLine(line);
    if (retained === null) {
      throw new Error(
        'github api telemetry path holds content that is not a retained observation',
      );
    }
    lines.push(JSON.stringify(retained));
  }
  return lines;
}
export function appendRequestObservation(observation, options) {
  const maxRecords =
    Number.isInteger(options.maxRecords) && options.maxRecords >= 1
      ? options.maxRecords
      : DEFAULT_GITHUB_API_TELEMETRY_MAX_RECORDS;
  // Refuse a foreign file before a sibling lock file is created next to
  // it; the read is repeated under the lock below.
  readRetainedLines(options.path);
  mkdirSync(dirname(options.path), { recursive: true });
  withTelemetryFileLock(`${options.path}.lock`, () => {
    const lines = readRetainedLines(options.path);
    lines.push(JSON.stringify(allowlistObservation(observation)));
    const kept = lines.slice(-maxRecords);
    const temporary = `${options.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${kept.join('\n')}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    try {
      renameSync(temporary, options.path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The original file is unchanged when the replace fails.
      }
      throw error;
    }
    chmodSync(options.path, 0o600);
  });
}
let policyOverride = null;
let policyCache = null;
/** Test seam. Pass null to resume reading config. */
// audit:ignore-dead-export: test seam; production reads config and must not toggle telemetry through process.env (issue #3585)
export function setGithubApiTelemetryPolicyForTests(policy) {
  policyOverride = policy;
  policyCache = null;
}
// audit:ignore-dead-export: test seam paired with setGithubApiTelemetryPolicyForTests (issue #3585)
export function resetGithubApiTelemetryPolicyCacheForTests() {
  policyCache = null;
}
function policyFromConfig(config) {
  const normalized = normalizePolicyConfig(config);
  return normalized.githubApi?.telemetry ?? DEFAULT_GITHUB_API_TELEMETRY;
}
/** Enabled only when config says so. Any read failure stays disabled. */
export function readGithubApiTelemetryPolicy(configText) {
  if (policyOverride) return policyOverride;
  if (policyCache) return policyCache;
  if (configText !== undefined) {
    try {
      policyCache = policyFromConfig(JSON.parse(configText));
    } catch {
      policyCache = DEFAULT_GITHUB_API_TELEMETRY;
    }
    return policyCache;
  }
  try {
    const raw = readFileSync('.github/idd/config.json', 'utf8');
    policyCache = policyFromConfig(JSON.parse(raw));
  } catch {
    policyCache = DEFAULT_GITHUB_API_TELEMETRY;
  }
  return policyCache;
}
export function telemetryIsEnabled() {
  return readGithubApiTelemetryPolicy().enabled === true;
}
/**
 * Record when telemetry is enabled. IO and parse failures are swallowed
 * so the transport wrapper's own result is unchanged.
 */
export function recordRequestObservation(observation) {
  try {
    const policy = readGithubApiTelemetryPolicy();
    if (!policy.enabled) return;
    const path = resolveGithubApiTelemetryPath(policy.path);
    if (path === null) return;
    appendRequestObservation(observation, {
      path,
      maxRecords: policy.maxRecords,
    });
  } catch {
    // Retention is optional. Never replace the original gh outcome.
  }
}
