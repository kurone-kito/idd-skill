import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeWorkerBudget,
  readOneMinuteLoad,
  type WorkerBudgetReaders,
  type WorkerBudgetRequest,
} from '../src/scripts/idd-worker-budget.mts';

const GIB = 1024 * 1024 * 1024;

function readers(
  overrides: Partial<WorkerBudgetReaders> = {},
): WorkerBudgetReaders {
  return {
    load1m: () => 0.5,
    coreCount: () => 4,
    procMemAvailableBytes: () => 3 * GIB,
    freeMemoryBytes: () => 3 * GIB,
    rateLimit: () => ({
      resources: {
        core: { remaining: 5_000 },
        graphql: { remaining: 5_000 },
      },
    }),
    ...overrides,
  };
}

function request(
  overrides: Partial<WorkerBudgetRequest> = {},
): WorkerBudgetRequest {
  return {
    maxWorkers: 3,
    running: 0,
    startable: 2,
    harnessLimit: null,
    ...overrides,
  };
}

test('worker budget reports each reachable limiting factor', () => {
  const cases: Array<{
    name: string;
    request?: Partial<WorkerBudgetRequest>;
    readers?: Partial<WorkerBudgetReaders>;
    factor: string;
  }> = [
    {
      name: 'host load',
      readers: { load1m: () => 4.01 },
      factor: 'host-load',
    },
    {
      name: 'zero core count',
      readers: { coreCount: () => 0, load1m: () => 0 },
      factor: 'host-load',
    },
    {
      name: 'unavailable host load',
      readers: { load1m: () => Number.NaN },
      factor: 'host-load',
    },
    {
      name: 'Windows unsupported host load',
      readers: { load1m: () => readOneMinuteLoad([0, 0, 0], 'win32') },
      factor: 'host-load',
    },
    {
      name: 'host memory',
      readers: { procMemAvailableBytes: () => 2 * GIB - 1 },
      factor: 'host-memory',
    },
    {
      name: 'unavailable API',
      readers: {
        rateLimit: () => {
          throw new Error('load control refused request');
        },
      },
      factor: 'api-unavailable',
    },
    {
      name: 'API quota',
      readers: {
        rateLimit: () => ({
          resources: {
            core: { remaining: 499 },
            graphql: { remaining: 500 },
          },
        }),
      },
      factor: 'api-rate-limit',
    },
    {
      name: 'GraphQL quota',
      readers: {
        rateLimit: () => ({
          resources: {
            core: { remaining: 500 },
            graphql: { remaining: 499 },
          },
        }),
      },
      factor: 'api-rate-limit',
    },
    {
      name: 'session cap',
      request: { maxWorkers: 1, running: 1, startable: 2 },
      factor: 'cap',
    },
    {
      name: 'harness limit',
      request: { maxWorkers: 3, harnessLimit: 1, startable: 2 },
      factor: 'harness-limit',
    },
    {
      name: 'startable candidates',
      request: { startable: 0 },
      factor: 'candidates',
    },
  ];

  for (const scenario of cases) {
    const result = computeWorkerBudget(
      request(scenario.request),
      readers(scenario.readers),
    );
    assert.equal(result.limitingFactor, scenario.factor, scenario.name);
    if (
      [
        'host-load',
        'host-memory',
        'api-unavailable',
        'api-rate-limit',
      ].includes(scenario.factor)
    ) {
      assert.equal(result.slots, 0, scenario.name);
    }
  }
});

test('worker budget applies the documented limiting-factor precedence', () => {
  const bothHostSignals = computeWorkerBudget(
    request(),
    readers({
      load1m: () => 5,
      procMemAvailableBytes: () => 1,
      rateLimit: () => {
        throw new Error('rate-limit read failed');
      },
    }),
  );
  assert.equal(bothHostSignals.limitingFactor, 'host-load');

  const memoryBeforeApi = computeWorkerBudget(
    request(),
    readers({
      procMemAvailableBytes: () => 1,
      rateLimit: () => {
        throw new Error('rate-limit read failed');
      },
    }),
  );
  assert.equal(memoryBeforeApi.limitingFactor, 'host-memory');

  const unavailableBeforeQuota = computeWorkerBudget(
    request(),
    readers({
      rateLimit: () => ({ resources: { core: { remaining: 1 } } }),
    }),
  );
  assert.equal(unavailableBeforeQuota.limitingFactor, 'api-unavailable');

  const capBeforeHarness = computeWorkerBudget(
    request({ maxWorkers: 2, harnessLimit: 2, running: 2 }),
    readers(),
  );
  assert.equal(capBeforeHarness.limitingFactor, 'cap');

  const rateLimitBeforeCap = computeWorkerBudget(
    request({ maxWorkers: 1, running: 1 }),
    readers({
      rateLimit: () => ({
        resources: {
          core: { remaining: 499 },
          graphql: { remaining: 2_000 },
        },
      }),
    }),
  );
  assert.equal(rateLimitBeforeCap.limitingFactor, 'api-rate-limit');

  const harnessBeforeCandidates = computeWorkerBudget(
    request({ maxWorkers: 3, harnessLimit: 1, startable: 1 }),
    readers(),
  );
  assert.equal(harnessBeforeCandidates.limitingFactor, 'harness-limit');
});

test('running at or above the worker cap returns zero slots', () => {
  const oneWorkerAllowed = computeWorkerBudget(
    request({ maxWorkers: 1, running: 0, startable: 1 }),
    readers(),
  );
  assert.equal(oneWorkerAllowed.slots, 1);
  assert.equal(oneWorkerAllowed.limitingFactor, 'cap');

  for (const running of [1, 2, 8]) {
    const result = computeWorkerBudget(
      request({ maxWorkers: 1, running }),
      readers(),
    );
    assert.equal(result.slots, 0);
    assert.equal(result.limitingFactor, 'cap');
  }
});

test('Windows load averages are treated as unavailable, not zero load', () => {
  assert.equal(readOneMinuteLoad([0, 0, 0], 'win32'), null);
  assert.equal(readOneMinuteLoad([0.5, 0.4, 0.3], 'linux'), 0.5);
  const result = computeWorkerBudget(
    request(),
    readers({ load1m: () => readOneMinuteLoad([0, 0, 0], 'win32') }),
  );
  assert.equal(result.load1m, null);
  assert.equal(result.slots, 0);
  assert.equal(result.limitingFactor, 'host-load');
});

test('a successful rate-limit response missing either resource fails closed', () => {
  for (const rateLimit of [
    { resources: { graphql: { remaining: 2_000 } } },
    { resources: { core: { remaining: 2_000 } } },
  ]) {
    const result = computeWorkerBudget(
      request(),
      readers({ rateLimit: () => rateLimit }),
    );
    assert.equal(result.slots, 0);
    assert.equal(result.limitingFactor, 'api-unavailable');
    assert.equal(
      result.restRemaining,
      rateLimit.resources.core?.remaining ?? null,
    );
    assert.equal(
      result.graphqlRemaining,
      rateLimit.resources.graphql?.remaining ?? null,
    );
  }
});

test('a load-control not-dispatched refusal is treated as API unavailable', () => {
  const refusal = Object.assign(new Error('request was not dispatched'), {
    notDispatched: true,
  });
  const result = computeWorkerBudget(
    request(),
    readers({
      rateLimit: () => {
        throw refusal;
      },
    }),
  );
  assert.equal(result.slots, 0);
  assert.equal(result.limitingFactor, 'api-unavailable');
  assert.equal(result.restRemaining, null);
  assert.equal(result.graphqlRemaining, null);
});

test('--no-network skips the API read without blocking worker dispatch', () => {
  let readCount = 0;
  const result = computeWorkerBudget(
    request({ noNetwork: true }),
    readers({
      rateLimit: () => {
        readCount += 1;
        throw new Error('must not be called');
      },
    }),
  );
  assert.equal(readCount, 0);
  assert.equal(result.slots, 2);
  assert.equal(result.limitingFactor, 'candidates');
  assert.equal(result.restRemaining, null);
  assert.equal(result.graphqlRemaining, null);
});

test('available memory falls back from /proc/meminfo to os.freemem()', () => {
  const result = computeWorkerBudget(
    request(),
    readers({
      procMemAvailableBytes: () => {
        throw new Error('no /proc/meminfo');
      },
      freeMemoryBytes: () => 4 * GIB,
    }),
  );
  assert.equal(result.availableMemoryBytes, 4 * GIB);
  assert.equal(result.limitingFactor, 'candidates');
});

test('worker budget admits slots at each exact threshold', () => {
  const atThreshold = [
    { name: 'load equal to the core count', readers: { load1m: () => 4 } },
    {
      name: 'memory at the floor',
      readers: { procMemAvailableBytes: () => 2 * GIB },
    },
    {
      name: 'quota at the floor',
      readers: {
        rateLimit: () => ({
          resources: {
            core: { remaining: 500 },
            graphql: { remaining: 500 },
          },
        }),
      },
    },
  ];
  for (const scenario of atThreshold) {
    const result = computeWorkerBudget(request(), readers(scenario.readers));
    assert.equal(result.slots, 2, scenario.name);
    assert.equal(result.limitingFactor, 'candidates', scenario.name);
  }
});
