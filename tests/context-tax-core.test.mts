import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertContextTaxSample,
  CONTEXT_TAX_STAGE_IDS,
  type ContextTaxSample,
  type ContextTaxVendorAdapter,
  inferIssueNumberFromBasename,
  redactContextTaxRecord,
} from '../src/scripts/context-tax-core.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

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
