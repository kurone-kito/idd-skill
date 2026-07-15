import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CI_WAIT_POLICY,
  normalizeCiWaitPolicy,
  parseDurationToMs,
  readCiWaitPolicy,
  resolveCiRerunDecision,
} from '../src/scripts/ci-wait-policy.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('parseDurationToMs parses CI wait durations', () => {
  assert.equal(parseDurationToMs('PT30M'), 30 * 60 * 1000);
  assert.equal(parseDurationToMs('PT10M'), 10 * 60 * 1000);
  assert.equal(parseDurationToMs('PT1H15M'), 75 * 60 * 1000);
  assert.equal(parseDurationToMs('invalid'), null);
});

test('parseDurationToMs rejects empty ISO duration tokens', () => {
  assert.equal(parseDurationToMs('P'), null);
  assert.equal(parseDurationToMs('PT'), null);
  assert.equal(parseDurationToMs('P1DT'), null);
});

test('normalizeCiWaitPolicy preserves distributed defaults when keys are omitted', () => {
  assert.deepEqual(normalizeCiWaitPolicy(), { ...DEFAULT_CI_WAIT_POLICY });
});

test('normalizeCiWaitPolicy accepts explicit ciWait overrides', () => {
  assert.deepEqual(
    normalizeCiWaitPolicy({
      runningTimeout: 'PT45M',
      generationTimeout: 'PT12M',
      rerunPolicy: 'hold',
    }),
    {
      runningTimeout: 'PT45M',
      runningTimeoutMs: 45 * 60 * 1000,
      generationTimeout: 'PT12M',
      generationTimeoutMs: 12 * 60 * 1000,
      rerunPolicy: 'hold',
    },
  );
});

test('normalizeCiWaitPolicy falls back when override values are invalid', () => {
  assert.deepEqual(
    normalizeCiWaitPolicy({
      runningTimeout: '45 minutes',
      generationTimeout: 'soon',
      rerunPolicy: 'rerun-forever',
    }),
    { ...DEFAULT_CI_WAIT_POLICY },
  );
});

test('normalizeCiWaitPolicy rejects empty ISO duration tokens', () => {
  assert.deepEqual(
    normalizeCiWaitPolicy({
      runningTimeout: 'P',
      generationTimeout: 'PT',
    }),
    { ...DEFAULT_CI_WAIT_POLICY },
  );
});

test('resolveCiRerunDecision allows only one automatic rerun by default', () => {
  assert.deepEqual(
    resolveCiRerunDecision({ rerunPolicy: 'rerun-once', rerunCount: 0 }),
    {
      action: 'rerun',
      reason: 'rerun-budget-available',
      rerunPolicy: 'rerun-once',
      rerunCount: 0,
    },
  );

  assert.deepEqual(
    resolveCiRerunDecision({ rerunPolicy: 'rerun-once', rerunCount: 1 }),
    {
      action: 'hold',
      reason: 'rerun-budget-exhausted',
      rerunPolicy: 'rerun-once',
      rerunCount: 1,
    },
  );
});

test('resolveCiRerunDecision honors hold policy', () => {
  assert.deepEqual(
    resolveCiRerunDecision({ rerunPolicy: 'hold', rerunCount: 0 }),
    {
      action: 'hold',
      reason: 'policy-hold',
      rerunPolicy: 'hold',
      rerunCount: 0,
    },
  );
});

test('readCiWaitPolicy reads nested ciWait config and CLI emits the same resolution', (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-ci-wait-policy-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const configPath = join(sandbox, '.github', 'idd', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        iddVersion: '0.1.0',
        markerPrefix: 'idd-skill',
        mergePolicy: 'fully_autonomous_merge',
        reviewPolicy: 'copilot-advisory',
        threadResolutionPolicy: 'fast-agent-resolve',
        claimTiming: {
          staleAge: 'PT24H',
          heartbeatInterval: 'PT12H',
        },
        trustedMarkerActors: ['kurone-kito'],
        commands: {
          'install-deps': 'true',
          'fix-validate': 'true',
          'pre-push-validate': 'true',
          'post-fix-validate': 'true',
        },
        ciWait: {
          runningTimeout: 'PT40M',
          generationTimeout: 'PT15M',
          rerunPolicy: 'hold',
        },
      },
      null,
      2,
    )}\n`,
  );

  assert.deepEqual(readCiWaitPolicy(configPath), {
    runningTimeout: 'PT40M',
    runningTimeoutMs: 40 * 60 * 1000,
    generationTimeout: 'PT15M',
    generationTimeoutMs: 15 * 60 * 1000,
    rerunPolicy: 'hold',
  });

  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
        '--policy',
        configPath,
        '--rerun-count',
        '0',
      ],
      { encoding: 'utf8' },
    ),
  );

  assert.deepEqual(output, {
    policy: {
      runningTimeout: 'PT40M',
      runningTimeoutMs: 40 * 60 * 1000,
      generationTimeout: 'PT15M',
      generationTimeoutMs: 15 * 60 * 1000,
      rerunPolicy: 'hold',
    },
    rerunDecision: {
      action: 'hold',
      reason: 'policy-hold',
      rerunPolicy: 'hold',
      rerunCount: 0,
    },
  });
});

test('readCiWaitPolicy still honors ciWait when an unrelated top-level field is schema-invalid', (t) => {
  // #1359 regression: an unknown top-level key like `unsupportedTopLevelKey`
  // trips `additionalProperties: false` at the whole-document level, but
  // must not zero out an otherwise schema-valid ciWait section — validation
  // is scoped to ciWait's own subtree.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-ci-wait-policy-invalid-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const configPath = join(sandbox, '.github', 'idd', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        iddVersion: '0.1.0',
        markerPrefix: 'idd-skill',
        mergePolicy: 'fully_autonomous_merge',
        reviewPolicy: 'copilot-advisory',
        threadResolutionPolicy: 'fast-agent-resolve',
        claimTiming: {
          staleAge: 'PT24H',
          heartbeatInterval: 'PT12H',
        },
        trustedMarkerActors: ['kurone-kito'],
        commands: {
          'install-deps': 'true',
          'fix-validate': 'true',
          'pre-push-validate': 'true',
          'post-fix-validate': 'true',
        },
        ciWait: {
          runningTimeout: 'PT40M',
          generationTimeout: 'PT15M',
          rerunPolicy: 'hold',
        },
        unsupportedTopLevelKey: true,
      },
      null,
      2,
    )}\n`,
  );

  assert.deepEqual(readCiWaitPolicy(configPath), {
    runningTimeout: 'PT40M',
    runningTimeoutMs: 40 * 60 * 1000,
    generationTimeout: 'PT15M',
    generationTimeoutMs: 15 * 60 * 1000,
    rerunPolicy: 'hold',
  });
});

test('readCiWaitPolicy falls back to defaults when its own ciWait section is schema-invalid', (t) => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-ci-wait-policy-own-invalid-'),
  );
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const configPath = join(sandbox, '.github', 'idd', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        iddVersion: '0.1.0',
        markerPrefix: 'idd-skill',
        mergePolicy: 'fully_autonomous_merge',
        reviewPolicy: 'copilot-advisory',
        threadResolutionPolicy: 'fast-agent-resolve',
        claimTiming: {
          staleAge: 'PT24H',
          heartbeatInterval: 'PT12H',
        },
        trustedMarkerActors: ['kurone-kito'],
        commands: {
          'install-deps': 'true',
          'fix-validate': 'true',
          'pre-push-validate': 'true',
          'post-fix-validate': 'true',
        },
        // Not in the ciWait.rerunPolicy schema enum (rerun-once | hold):
        // the ciWait subtree is itself invalid, so this still reverts.
        ciWait: {
          runningTimeout: 'PT40M',
          generationTimeout: 'PT15M',
          rerunPolicy: 'rerun-forever',
        },
      },
      null,
      2,
    )}\n`,
  );

  assert.deepEqual(readCiWaitPolicy(configPath), { ...DEFAULT_CI_WAIT_POLICY });
});
