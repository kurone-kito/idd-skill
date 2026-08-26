import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertContextTaxSample,
  assertContextTaxSnapshot,
  CONTEXT_TAX_STAGE_IDS,
  type ContextTaxSample,
  type ContextTaxSnapshot,
  type ContextTaxVendorAdapter,
  inferIssueNumberFromBasename,
  redactContextTaxRecord,
} from '../src/scripts/context-tax-core.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const ZERO_PERCENTILES = { p25: 0, p50: 0, p75: 0 };
const ZERO_USAGE_PERCENTILES = {
  inputUncached: ZERO_PERCENTILES,
  cacheRead: ZERO_PERCENTILES,
  cacheCreation: ZERO_PERCENTILES,
  output: ZERO_PERCENTILES,
  reasoning: ZERO_PERCENTILES,
};
const SNAPSHOT_BASE_FIELDS = {
  asOf: '2026-08-25',
  totalUsage: ZERO_USAGE_PERCENTILES,
  stageUsage: [],
  compactionCount: ZERO_PERCENTILES,
  cacheHitRatio: 0,
  successRateByModel: {},
  successRateByVendor: {},
};

test('stage id list is the seven IDD stages', () => {
  assert.deepEqual(
    [...CONTEXT_TAX_STAGE_IDS],
    ['discover', 'claim', 'work', 'submit-pr', 'review', 'merge', 'cleanup'],
  );
});

test('redaction drops a home path and a prompt string', () => {
  const dirty = {
    schemaVersion: 1,
    vendor: 'grok',
    cwd: '/home/kurone-kito/ghq/github.com/kurone-kito/idd-skill',
    prompt: 'please merge this PR with these secrets',
    model: 'grok-4.6',
    usage: {
      inputUncached: 1,
      cacheRead: 0,
      cacheCreation: 0,
      output: 1,
      reasoning: 0,
    },
  };
  const clean = redactContextTaxRecord(dirty) as Record<string, unknown>;
  const serialized = JSON.stringify(clean);
  assert.equal(clean.cwd, undefined);
  assert.equal(clean.prompt, undefined);
  assert.equal(clean.vendor, 'grok');
  assert.equal(clean.model, 'grok-4.6');
  assert.doesNotMatch(serialized, /\/home\//);
  assert.doesNotMatch(serialized, /please merge this PR/);
});

test('redaction strips path-like and secret-shaped strings in nested values', () => {
  const dirty = {
    vendorSessionId: 'sess_ok',
    notes: 'cloned under /Users/me/ghq/github.com/acme/app',
    token: 'ghp_abcdefghijklmnopqrstuvwx',
    nested: { filePath: '/tmp/worktree/issue-12-foo', keep: 2 },
  };
  const clean = redactContextTaxRecord(dirty) as Record<string, unknown>;
  const serialized = JSON.stringify(clean);
  assert.equal(clean.vendorSessionId, 'sess_ok');
  assert.equal(clean.notes, undefined);
  assert.equal(clean.token, undefined);
  assert.equal((clean.nested as Record<string, unknown>).filePath, undefined);
  assert.equal((clean.nested as Record<string, unknown>).keep, 2);
  assert.doesNotMatch(serialized, /ghq/);
  assert.doesNotMatch(serialized, /ghp_/);
});

test('inferIssueNumberFromBasename accepts only a basename, never a path', () => {
  assert.equal(
    inferIssueNumberFromBasename(
      'issue-2288-feat-context-tax-define-sample-snapshot',
    ),
    2288,
  );
  assert.equal(
    inferIssueNumberFromBasename(
      '.issue-2288-feat-context-tax-define-sample-snapshot',
    ),
    2288,
  );
  assert.equal(
    inferIssueNumberFromBasename(
      'idd-skill.issue-2288-feat-context-tax-define-sample-snapshot',
    ),
    2288,
  );
  assert.equal(
    inferIssueNumberFromBasename(
      '/home/me/ghq/github.com/acme/idd-skill.issue-2288-feat',
    ),
    undefined,
  );
  assert.equal(
    inferIssueNumberFromBasename('nonissue-123-unrelated'),
    undefined,
  );
});

test('redaction drops unlisted POSIX absolute paths', () => {
  const dirty = { leaked: '/workspace/acme/private.ts', keep: 'ok' };
  const clean = redactContextTaxRecord(dirty) as Record<string, unknown>;
  assert.equal(clean.leaked, undefined);
  assert.equal(clean.keep, 'ok');
});

test('redaction drops absolute paths preceded by a delimiter other than whitespace/quote', () => {
  const dirty = {
    cwdNote: 'cwd:/workspace/acme/private.ts',
    fileUrl: 'file:///etc/passwd',
    uncPath: String.raw`\\server\share\private.txt`,
    winNote: 'path:C:\\Users\\me',
    keep: 'ok',
  };
  const clean = redactContextTaxRecord(dirty) as Record<string, unknown>;
  assert.equal(clean.cwdNote, undefined);
  assert.equal(clean.fileUrl, undefined);
  assert.equal(clean.uncPath, undefined);
  assert.equal(clean.winNote, undefined);
  assert.equal(clean.keep, 'ok');
});

test('redaction drops absolute paths after any delimiter, not just a whitelisted set', () => {
  const dirty = {
    csvNote: 'note,/etc/shadow',
    semicolonNote: 'a;/etc/shadow',
    keep: 'ok',
  };
  const clean = redactContextTaxRecord(dirty) as Record<string, unknown>;
  assert.equal(clean.csvNote, undefined);
  assert.equal(clean.semicolonNote, undefined);
  assert.equal(clean.keep, 'ok');
});

test('redaction drops compound prompt/assistant/tool-input field names', () => {
  const dirty = {
    systemPrompt: 'you are a helpful assistant',
    assistantMessage: 'sure, here is the answer',
    toolInput: '{"query": "secret"}',
    inputUncached: 5,
  };
  const clean = redactContextTaxRecord(dirty) as Record<string, unknown>;
  assert.equal(clean.systemPrompt, undefined);
  assert.equal(clean.assistantMessage, undefined);
  assert.equal(clean.toolInput, undefined);
  assert.equal(clean.inputUncached, 5);
});

test('redaction drops path-like and secret-shaped object keys', () => {
  const dirty = {
    '/workspace/acme/private.ts': 3,
    'C:\\Users\\alice\\secret.ts': 1,
    keep: 'ok',
  };
  const clean = redactContextTaxRecord(dirty) as Record<string, unknown>;
  assert.equal(Object.keys(clean).length, 1);
  assert.equal(clean.keep, 'ok');
});

test('redaction drops single-leading-backslash Windows-root-relative paths', () => {
  const dirty = {
    rooted: String.raw`\Users\alice\private.ts`,
    system: String.raw`\Windows\System32\config\SAM`,
    keep: 'ok',
  };
  const clean = redactContextTaxRecord(dirty) as Record<string, unknown>;
  assert.equal(clean.rooted, undefined);
  assert.equal(clean.system, undefined);
  assert.equal(clean.keep, 'ok');
});

test('assertContextTaxSample couples attribution to kind', () => {
  const issueLoop: ContextTaxSample = {
    schemaVersion: 1,
    kind: 'issue-loop',
    vendor: 'codex',
    model: 'gpt-test',
    attribution: 'marker-join',
    outcome: 'unknown',
    usage: {
      inputUncached: 0,
      cacheRead: 0,
      cacheCreation: 0,
      output: 0,
      reasoning: 0,
    },
    compactionCount: 0,
    startedAt: '2026-08-25T00:00:00Z',
    endedAt: '2026-08-25T00:01:00Z',
    vendorSessionId: 'sess',
    issueNumber: 2288,
    stages: [],
  };
  assert.doesNotThrow(() => assertContextTaxSample(issueLoop));
  assert.throws(
    () =>
      assertContextTaxSample({
        ...issueLoop,
        attribution: 'session-unscoped',
      }),
    /issue-loop sample cannot use session-unscoped attribution/,
  );
  const session: ContextTaxSample = {
    ...issueLoop,
    kind: 'session',
    issueNumber: undefined,
    stages: undefined,
    attribution: 'session-unscoped',
  };
  assert.doesNotThrow(() => assertContextTaxSample(session));
  assert.throws(
    () => assertContextTaxSample({ ...session, attribution: 'marker-join' }),
    /session sample must use session-unscoped attribution/,
  );
});

test('assertContextTaxSample rejects endedAt preceding startedAt', () => {
  const session: ContextTaxSample = {
    schemaVersion: 1,
    kind: 'session',
    vendor: 'codex',
    model: 'gpt-test',
    attribution: 'session-unscoped',
    outcome: 'unknown',
    usage: {
      inputUncached: 0,
      cacheRead: 0,
      cacheCreation: 0,
      output: 0,
      reasoning: 0,
    },
    compactionCount: 0,
    startedAt: '2026-08-25T00:01:00Z',
    endedAt: '2026-08-25T00:00:00Z',
    vendorSessionId: 'sess',
  };
  assert.throws(
    () => assertContextTaxSample(session),
    /sample endedAt must not precede startedAt/,
  );
  assert.doesNotThrow(() =>
    assertContextTaxSample({
      ...session,
      startedAt: '2026-08-25T00:00:00Z',
      endedAt: '2026-08-25T00:01:00Z',
    }),
  );
  assert.throws(
    () => assertContextTaxSample({ ...session, startedAt: 'not-a-date' }),
    /sample startedAt\/endedAt must be valid timestamps/,
  );
  assert.throws(
    () => assertContextTaxSample({ ...session, endedAt: 'not-a-date' }),
    /sample startedAt\/endedAt must be valid timestamps/,
  );
});

test('assertContextTaxSnapshot rejects duplicate vendors', () => {
  const snapshot: ContextTaxSnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-08-25T00:00:00Z',
    minPublishableSamples: 10,
    minPublishableVendors: 2,
    publishable: false,
    sampleCount: 3,
    vendors: ['grok', 'claude'],
    ...SNAPSHOT_BASE_FIELDS,
  };
  assert.doesNotThrow(() => assertContextTaxSnapshot(snapshot));
  assert.throws(
    () => assertContextTaxSnapshot({ ...snapshot, vendors: ['grok', 'grok'] }),
    /snapshot vendors must be distinct/,
  );
});

test('assertContextTaxSnapshot requires publishable to match the sample/vendor gate', () => {
  const eligible: ContextTaxSnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-08-25T00:00:00Z',
    minPublishableSamples: 10,
    minPublishableVendors: 2,
    publishable: true,
    sampleCount: 10,
    vendors: ['grok', 'claude'],
    ...SNAPSHOT_BASE_FIELDS,
  };
  assert.doesNotThrow(() => assertContextTaxSnapshot(eligible));
  assert.throws(
    () =>
      assertContextTaxSnapshot({
        ...eligible,
        publishable: true,
        sampleCount: 3,
      }),
    /snapshot publishable must match the sampleCount\/vendors gate/,
  );
  assert.throws(
    () => assertContextTaxSnapshot({ ...eligible, publishable: false }),
    /snapshot publishable must match the sampleCount\/vendors gate/,
  );
});

test('assertContextTaxSample rejects a non-integer issueNumber', () => {
  const base: ContextTaxSample = {
    schemaVersion: 1,
    kind: 'issue-loop',
    vendor: 'codex',
    model: 'gpt-test',
    attribution: 'marker-join',
    outcome: 'unknown',
    usage: {
      inputUncached: 0,
      cacheRead: 0,
      cacheCreation: 0,
      output: 0,
      reasoning: 0,
    },
    compactionCount: 0,
    startedAt: '2026-08-25T00:00:00Z',
    endedAt: '2026-08-25T00:01:00Z',
    vendorSessionId: 'sess',
    issueNumber: 2288,
    stages: [],
  };
  assert.doesNotThrow(() => assertContextTaxSample(base));
  for (const issueNumber of [0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => assertContextTaxSample({ ...base, issueNumber }),
      /issue-loop sample requires a positive issueNumber/,
    );
  }
});

test('assertContextTaxSample requires join fields on issue-loop samples', () => {
  const session: ContextTaxSample = {
    schemaVersion: 1,
    kind: 'session',
    vendor: 'codex',
    model: 'gpt-test',
    attribution: 'session-unscoped',
    outcome: 'unknown',
    usage: {
      inputUncached: 0,
      cacheRead: 0,
      cacheCreation: 0,
      output: 0,
      reasoning: 0,
    },
    compactionCount: 0,
    startedAt: '2026-08-25T00:00:00Z',
    endedAt: '2026-08-25T00:01:00Z',
    vendorSessionId: 'sess',
  };
  assert.doesNotThrow(() => assertContextTaxSample(session));
  const incomplete = {
    ...session,
    kind: 'issue-loop',
  } as ContextTaxSample;
  assert.throws(
    () => assertContextTaxSample(incomplete),
    /issue-loop sample requires a positive issueNumber/,
  );
});

test('adapter interface is implementable without a CLI', () => {
  const adapter: ContextTaxVendorAdapter = {
    harvest() {
      return {
        sample: {
          schemaVersion: 1,
          kind: 'session',
          vendor: 'codex',
          model: 'gpt-test',
          attribution: 'session-unscoped',
          outcome: 'unknown',
          usage: {
            inputUncached: 0,
            cacheRead: 0,
            cacheCreation: 0,
            output: 0,
            reasoning: 0,
          },
          compactionCount: 0,
          startedAt: '2026-08-25T00:00:00Z',
          endedAt: '2026-08-25T00:01:00Z',
          vendorSessionId: 'sess',
        },
        joinHints: { issueNumber: 2288 },
      };
    },
  };
  const result = adapter.harvest({});
  assert.equal(result.sample.kind, 'session');
  assert.equal(result.joinHints?.issueNumber, 2288);
  assert.equal(Object.hasOwn(result.joinHints ?? {}, 'path'), false);
});

test('committed sample fixture validates against the sample schema', () => {
  const errors = validate(
    loadJson('fixtures/schemas/context-tax-sample.valid.json'),
    loadJson('schemas/context-tax-sample.schema.json'),
  );
  assert.deepEqual(errors, []);
});

test('committed snapshot fixture validates against the snapshot schema', () => {
  const errors = validate(
    loadJson('fixtures/schemas/context-tax-snapshot.valid.json'),
    loadJson('schemas/context-tax-snapshot.schema.json'),
  );
  assert.deepEqual(errors, []);
});

test('assertContextTaxSnapshot rejects an out-of-order percentile triple', () => {
  const snapshot: ContextTaxSnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-08-25T00:00:00Z',
    minPublishableSamples: 10,
    minPublishableVendors: 2,
    publishable: false,
    sampleCount: 3,
    vendors: ['grok'],
    ...SNAPSHOT_BASE_FIELDS,
  };
  assert.doesNotThrow(() => assertContextTaxSnapshot(snapshot));
  assert.throws(
    () =>
      assertContextTaxSnapshot({
        ...snapshot,
        totalUsage: {
          ...ZERO_USAGE_PERCENTILES,
          inputUncached: { p25: 100, p50: 50, p75: 200 },
        },
      }),
    /totalUsage\.inputUncached percentiles must satisfy p25 <= p50 <= p75/,
  );
  assert.throws(
    () =>
      assertContextTaxSnapshot({
        ...snapshot,
        compactionCount: { p25: 5, p50: 4, p75: 6 },
      }),
    /compactionCount percentiles must satisfy p25 <= p50 <= p75/,
  );
  assert.throws(
    () =>
      assertContextTaxSnapshot({
        ...snapshot,
        stageUsage: [
          {
            id: 'work',
            usage: {
              ...ZERO_USAGE_PERCENTILES,
              output: { p25: 10, p50: 20, p75: 15 },
            },
          },
        ],
      }),
    /stageUsage\[work\]\.usage\.output percentiles must satisfy p25 <= p50 <= p75/,
  );
});

test('assertContextTaxSnapshot rejects cacheHitRatio outside [0, 1]', () => {
  const snapshot: ContextTaxSnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-08-25T00:00:00Z',
    minPublishableSamples: 10,
    minPublishableVendors: 2,
    publishable: false,
    sampleCount: 3,
    vendors: ['grok'],
    ...SNAPSHOT_BASE_FIELDS,
  };
  assert.throws(
    () => assertContextTaxSnapshot({ ...snapshot, cacheHitRatio: 1.1 }),
    /snapshot cacheHitRatio must be in \[0, 1\]/,
  );
  assert.throws(
    () => assertContextTaxSnapshot({ ...snapshot, cacheHitRatio: -0.1 }),
    /snapshot cacheHitRatio must be in \[0, 1\]/,
  );
});

test('assertContextTaxSnapshot rejects a success rate that disagrees with its own counts', () => {
  const snapshot: ContextTaxSnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-08-25T00:00:00Z',
    minPublishableSamples: 10,
    minPublishableVendors: 2,
    publishable: false,
    sampleCount: 3,
    vendors: ['grok'],
    ...SNAPSHOT_BASE_FIELDS,
  };
  assert.doesNotThrow(() =>
    assertContextTaxSnapshot({
      ...snapshot,
      successRateByModel: {
        'grok-4.6': {
          merged: 3,
          aborted: 1,
          unclaimed: 0,
          humanHandoff: 0,
          rate: 0.75,
        },
      },
    }),
  );
  assert.throws(
    () =>
      assertContextTaxSnapshot({
        ...snapshot,
        successRateByModel: {
          'grok-4.6': {
            merged: 3,
            aborted: 1,
            unclaimed: 0,
            humanHandoff: 0,
            rate: 0.5,
          },
        },
      }),
    /successRateByModel\[grok-4\.6\] rate must equal merged \/ \(merged \+ aborted \+ unclaimed \+ humanHandoff\)/,
  );
  assert.throws(
    () =>
      assertContextTaxSnapshot({
        ...snapshot,
        successRateByVendor: {
          grok: {
            merged: 3,
            aborted: 1,
            unclaimed: 0,
            humanHandoff: 0,
            rate: 1.2,
          },
        },
      }),
    /successRateByVendor\[grok\] rate must be in \[0, 1\]/,
  );
});
