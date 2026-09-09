import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CommentLike,
  evaluateLocalValidationEvidenceRecovery,
  findSupersededLocalValidationEvidenceSubjects,
  hideSupersededLocalValidationEvidenceMarkers,
  parseArgs,
  renderText,
  resolveLocalValidationEvidence,
} from '../src/scripts/local-validation-evidence.mts';
import { normalizePolicyConfig } from '../src/scripts/policy-helpers.mts';
import {
  parseLocalValidationEvidenceComment,
  renderLocalValidationEvidenceComment,
} from '../src/scripts/protocol-helpers.mts';

const NOW = new Date('2026-09-01T06:00:00Z');
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function evidenceComment(overrides: {
  actor?: string;
  headSha?: string;
  commandSet?: string;
  covers?: string[];
  outcome?: string;
  createdAt?: string;
  authorLogin?: string;
  nodeId?: string;
}): CommentLike {
  const body = renderLocalValidationEvidenceComment({
    actor: overrides.actor ?? 'kurone-kito',
    headSha: overrides.headSha ?? HEAD,
    commandSet: overrides.commandSet ?? 'pre-push-validate',
    covers: overrides.covers ?? ['idd-doctor', 'lint', 'pnpm-boundary'],
    outcome: overrides.outcome ?? 'pass',
  });
  return {
    body,
    created_at: overrides.createdAt ?? '2026-09-01T05:00:00Z',
    author: {
      login: overrides.authorLogin ?? overrides.actor ?? 'kurone-kito',
    },
    node_id: overrides.nodeId ?? 'IC_default',
  };
}

const REQUIRED_CHECKS = ['idd-doctor', 'lint', 'pnpm-boundary'];
const TRUSTED = ['kurone-kito'];
const basePolicy = normalizePolicyConfig({
  localValidationEvidence: { maxAge: 'PT4H' },
});

test('renderLocalValidationEvidenceComment / parseLocalValidationEvidenceComment round-trip', () => {
  const body = renderLocalValidationEvidenceComment({
    actor: 'kurone-kito',
    headSha: HEAD,
    commandSet: 'pre-push-validate',
    covers: ['idd-doctor', 'lint', 'pnpm-boundary'],
    outcome: 'pass',
  });
  const parsed = parseLocalValidationEvidenceComment(
    body,
    '2026-09-01T05:00:00Z',
  );
  assert.deepEqual(parsed, {
    actor: 'kurone-kito',
    headSha: HEAD,
    commandSet: 'pre-push-validate',
    covers: ['idd-doctor', 'lint', 'pnpm-boundary'],
    outcome: 'pass',
    createdAt: '2026-09-01T05:00:00Z',
  });
});

test('renderLocalValidationEvidenceComment rejects an incomplete payload', () => {
  assert.throws(() =>
    renderLocalValidationEvidenceComment({
      actor: 'kurone-kito',
      headSha: HEAD,
      commandSet: 'pre-push-validate',
      covers: [],
      outcome: 'pass',
    }),
  );
  assert.throws(() =>
    renderLocalValidationEvidenceComment({
      actor: 'kurone-kito',
      headSha: HEAD,
      commandSet: 'pre-push-validate',
      covers: ['lint'],
      outcome: 'unknown',
    }),
  );
});

test('parseLocalValidationEvidenceComment rejects a malformed body', () => {
  assert.equal(
    parseLocalValidationEvidenceComment(
      '<!-- idd-local-validation-evidence: kurone-kito head:not-a-sha commands:x covers:y outcome:pass -->',
      '2026-09-01T05:00:00Z',
    ),
    null,
  );
});

test('resolveLocalValidationEvidence: valid evidence under an active declaration reports present', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({})],
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, true);
  assert.equal(result.evidence?.headSha, HEAD);
  assert.equal(result.valid.length, 1);
});

test('resolveLocalValidationEvidence: no relief without an active outage declaration', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({})],
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: false,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  assert.match(result.reason, /no active provider outage declaration/);
  // The marker itself still parses as valid evidence -- only the missing
  // declaration blocks `present`, matching the issue's "only while ... is
  // active" acceptance criterion.
  assert.equal(result.valid.length, 1);
});

test('resolveLocalValidationEvidence: no relief for evidence bound to a different HEAD', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({ headSha: OTHER_HEAD })],
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  assert.equal(result.wrongHead.length, 1);
  assert.match(result.reason, /different HEAD/);
});

test('resolveLocalValidationEvidence: no relief for evidence from an untrusted actor', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({ actor: 'mallory', authorLogin: 'mallory' })],
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  assert.equal(result.untrusted.length, 1);
  assert.match(result.reason, /not a trusted marker actor/);
});

test('resolveLocalValidationEvidence: no relief for evidence past its maxAge expiry', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({ createdAt: '2026-09-01T01:00:00Z' })], // 5h before NOW, maxAge PT4H
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  assert.equal(result.expired.length, 1);
  assert.match(result.reason, /older than the configured/);
});

test('resolveLocalValidationEvidence: evidence exactly at the maxAge boundary is still fresh', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({ createdAt: '2026-09-01T02:00:00Z' })], // exactly 4h before NOW
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, true);
});

test('resolveLocalValidationEvidence: no relief when evidence covers only a subset of required checks', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({ covers: ['idd-doctor', 'lint'] })],
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  assert.equal(result.partialCoverage.length, 1);
  assert.match(result.reason, /subset of the required checks/);
  assert.match(result.reason, /pnpm-boundary/);
});

test('resolveLocalValidationEvidence: an empty requiredCheckNames list never vacuously reports present (#2355 review)', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({})],
    prHeadSha: HEAD,
    requiredCheckNames: [],
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  assert.equal(result.partialCoverage.length, 1);
  assert.match(result.reason, /no required check names were given/);
});

test('resolveLocalValidationEvidence: the missing-check diagnostic trims whitespace like coversAll does (#2355 review)', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({ covers: ['idd-doctor', 'lint'] })],
    prHeadSha: HEAD,
    requiredCheckNames: ['idd-doctor', ' lint ', 'pnpm-boundary'],
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  // "lint" (with surrounding whitespace in the required list) is actually
  // covered; only "pnpm-boundary" should report as missing.
  assert.match(result.reason, /missing: pnpm-boundary\)/);
  assert.doesNotMatch(result.reason, /lint/);
});

test('renderLocalValidationEvidenceComment / parseLocalValidationEvidenceComment round-trip a comma-containing check name (#2355 review)', () => {
  const body = renderLocalValidationEvidenceComment({
    actor: 'kurone-kito',
    headSha: HEAD,
    commandSet: 'pre-push-validate',
    covers: ['lint, security', 'idd-doctor'],
    outcome: 'pass',
  });
  const parsed = parseLocalValidationEvidenceComment(
    body,
    '2026-09-01T05:00:00Z',
  );
  assert.deepEqual(parsed?.covers, ['lint, security', 'idd-doctor']);
});

test('resolveLocalValidationEvidence: no relief for a failing outcome', () => {
  const result = resolveLocalValidationEvidence({
    comments: [evidenceComment({ outcome: 'fail' })],
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  assert.equal(result.outcomeFail.length, 1);
});

test('resolveLocalValidationEvidence: picks the latest of several valid records', () => {
  const result = resolveLocalValidationEvidence({
    comments: [
      evidenceComment({ createdAt: '2026-09-01T04:00:00Z' }),
      evidenceComment({ createdAt: '2026-09-01T05:30:00Z' }),
    ],
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, true);
  assert.equal(result.evidence?.createdAt, '2026-09-01T05:30:00Z');
});

test('resolveLocalValidationEvidence: no evidence found reports the empty-set reason', () => {
  const result = resolveLocalValidationEvidence({
    comments: [],
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  assert.match(result.reason, /no local validation evidence found/);
});

test('resolveLocalValidationEvidence: ignores marker-shaped comments that fail to parse', () => {
  const result = resolveLocalValidationEvidence({
    comments: [
      {
        body: '<!-- idd-local-validation-evidence: kurone-kito head:zzz commands:x covers:y outcome:pass -->',
        created_at: '2026-09-01T05:00:00Z',
        author: { login: 'kurone-kito' },
      },
    ],
    prHeadSha: HEAD,
    requiredCheckNames: REQUIRED_CHECKS,
    trustedMarkerLogins: TRUSTED,
    outageDeclarationActive: true,
    policy: basePolicy,
    now: NOW,
  });
  assert.equal(result.present, false);
  assert.equal(result.malformed.length, 1);
});

test('evaluateLocalValidationEvidenceRecovery: re-validates a PR whose HEAD advanced past the evidence', () => {
  const result = evaluateLocalValidationEvidenceRecovery({
    evidence: { headSha: HEAD },
    livePrHeadSha: OTHER_HEAD,
  });
  assert.equal(result.needsRevalidation, true);
  assert.match(result.reason, /HEAD advanced/);
});

test('evaluateLocalValidationEvidenceRecovery: does not require revalidation when HEAD still matches', () => {
  const result = evaluateLocalValidationEvidenceRecovery({
    evidence: { headSha: HEAD },
    livePrHeadSha: HEAD,
  });
  assert.equal(result.needsRevalidation, false);
});

test('evaluateLocalValidationEvidenceRecovery: no evidence record always requires revalidation', () => {
  const result = evaluateLocalValidationEvidenceRecovery({
    evidence: null,
    livePrHeadSha: HEAD,
  });
  assert.equal(result.needsRevalidation, true);
});

test('renderText renders one key: value line per top-level field', () => {
  const rendered = renderText({ present: true, reason: '' });
  assert.equal(rendered, 'present: true\nreason: ');
});

test('parseArgs: resolve mode requires --pr and --head-sha', () => {
  assert.throws(() => parseArgs(['--head-sha', HEAD]), /--pr/);
  assert.throws(() => parseArgs(['--pr', '123']), /--head-sha/);
});

test('parseArgs: --record requires --covers and a valid --outcome', () => {
  assert.throws(
    () => parseArgs(['--record', '--pr', '123', '--head-sha', HEAD]),
    /--covers/,
  );
  assert.throws(
    () =>
      parseArgs([
        '--record',
        '--pr',
        '123',
        '--head-sha',
        HEAD,
        '--covers',
        'lint',
        '--outcome',
        'maybe',
      ]),
    /--outcome/,
  );
});

test('parseArgs: --record with valid arguments parses covers and required-checks as lists', () => {
  const parsed = parseArgs([
    '--record',
    '--pr',
    '123',
    '--head-sha',
    HEAD,
    '--command-set',
    'pre-push-validate',
    '--covers',
    'idd-doctor, lint , pnpm-boundary',
    '--outcome',
    'pass',
  ]);
  assert.equal(parsed.mode, 'record');
  assert.deepEqual(parsed.covers, ['idd-doctor', 'lint', 'pnpm-boundary']);
  assert.equal(parsed.outcome, 'pass');
});

test('parseArgs: default mode is resolve', () => {
  const parsed = parseArgs(['--pr', '123', '--head-sha', HEAD]);
  assert.equal(parsed.mode, 'resolve');
  assert.equal(parsed.service, 'ci-actions');
});

// --- #2755: hide-at-post-time for idd-local-validation-evidence ----------

test('findSupersededLocalValidationEvidenceSubjects hides a prior marker whose HEAD SHA differs from the new one', () => {
  const stale = evidenceComment({ headSha: OTHER_HEAD, nodeId: 'IC_stale' });
  assert.deepEqual(
    findSupersededLocalValidationEvidenceSubjects([stale], HEAD),
    ['IC_stale'],
  );
});

test('findSupersededLocalValidationEvidenceSubjects never hides a marker matching the new HEAD SHA (current-HEAD protection)', () => {
  const current = evidenceComment({ headSha: HEAD, nodeId: 'IC_current' });
  assert.deepEqual(
    findSupersededLocalValidationEvidenceSubjects([current], HEAD),
    [],
  );
});

test('findSupersededLocalValidationEvidenceSubjects ignores a non-marker comment and one with no node id', () => {
  const unrelated: CommentLike = {
    body: 'just a regular comment',
    created_at: '2026-09-01T05:00:00Z',
    node_id: 'IC_unrelated',
  };
  const noNodeId = evidenceComment({ headSha: OTHER_HEAD, nodeId: '' });
  assert.deepEqual(
    findSupersededLocalValidationEvidenceSubjects([unrelated, noNodeId], HEAD),
    [],
  );
});

const HIDE_TARGET = { owner: 'kurone-kito', repo: 'idd-skill', prNumber: 123 };
const POSTED_ID = 1000;

function baseHideOptions(
  overrides: Partial<
    Parameters<typeof hideSupersededLocalValidationEvidenceMarkers>[0]
  > = {},
) {
  return {
    ...HIDE_TARGET,
    newHeadSha: HEAD,
    postedCommentId: POSTED_ID,
    trustedMarkerLoginsFlag: 'kurone-kito',
    rawConfig: {},
    fetchLiveHeadSha: () => HEAD,
    fetchPriorComments: () => [],
    resolveTrustedActorsFn: () => ({
      actors: TRUSTED,
      source: 'flag' as const,
    }),
    ...overrides,
  };
}

test('hideSupersededLocalValidationEvidenceMarkers calls runMinimizeFn with every superseded subject id', () => {
  const stale = evidenceComment({
    headSha: OTHER_HEAD,
    nodeId: 'IC_stale',
  });
  const current = evidenceComment({ headSha: HEAD, nodeId: 'IC_current' });
  const calls: unknown[] = [];
  hideSupersededLocalValidationEvidenceMarkers(
    baseHideOptions({
      fetchPriorComments: () => [
        { ...stale, id: 1 },
        { ...current, id: 2 },
      ],
      runMinimizeFn: (input) => {
        calls.push(input);
        return {
          mode: 'apply',
          classifier: 'OUTDATED',
          counts: {
            eligible: 1,
            alreadyMinimized: 0,
            cannotMinimize: 0,
            untrusted: 0,
            unsupportedType: 0,
            applied: 1,
            failed: 0,
          },
          items: [],
        };
      },
    }),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { subjectIds: string[] }).subjectIds, [
    'IC_stale',
  ]);
});

test('hideSupersededLocalValidationEvidenceMarkers never calls runMinimizeFn when nothing is superseded', () => {
  const current = evidenceComment({ headSha: HEAD, nodeId: 'IC_current' });
  let called = false;
  hideSupersededLocalValidationEvidenceMarkers(
    baseHideOptions({
      fetchPriorComments: () => [{ ...current, id: 1 }],
      runMinimizeFn: () => {
        called = true;
        throw new Error('should never be called');
      },
    }),
  );
  assert.equal(called, false);
});

test("hideSupersededLocalValidationEvidenceMarkers passes an already-minimized-reporting runMinimizeFn call through unmodified (the skip itself is runMinimize's own pre-existing, unmodified logic; this wrapper never inspects the report)", () => {
  const stale = evidenceComment({ headSha: OTHER_HEAD, nodeId: 'IC_stale' });
  assert.doesNotThrow(() => {
    hideSupersededLocalValidationEvidenceMarkers(
      baseHideOptions({
        fetchPriorComments: () => [{ ...stale, id: 1 }],
        runMinimizeFn: () => ({
          mode: 'apply',
          classifier: 'OUTDATED',
          counts: {
            eligible: 1,
            alreadyMinimized: 1,
            cannotMinimize: 0,
            untrusted: 0,
            unsupportedType: 0,
            applied: 0,
            failed: 0,
          },
          items: [
            {
              subjectId: 'IC_stale',
              status: 'skipped',
              reason: 'already-minimized',
            },
          ],
        }),
      }),
    );
  });
});

test('hideSupersededLocalValidationEvidenceMarkers swallows a runMinimizeFn failure (permission error) without throwing or blocking', () => {
  const stale = evidenceComment({ headSha: OTHER_HEAD, nodeId: 'IC_stale' });
  assert.doesNotThrow(() => {
    hideSupersededLocalValidationEvidenceMarkers(
      baseHideOptions({
        fetchPriorComments: () => [{ ...stale, id: 1 }],
        runMinimizeFn: () => {
          throw new Error('gh: permission denied');
        },
      }),
    );
  });
});

test('hideSupersededLocalValidationEvidenceMarkers swallows a resolveTrustedActorsFn failure without throwing', () => {
  const stale = evidenceComment({ headSha: OTHER_HEAD, nodeId: 'IC_stale' });
  assert.doesNotThrow(() => {
    hideSupersededLocalValidationEvidenceMarkers(
      baseHideOptions({
        fetchPriorComments: () => [{ ...stale, id: 1 }],
        resolveTrustedActorsFn: () => {
          throw new Error('config read failed');
        },
      }),
    );
  });
});

test('hideSupersededLocalValidationEvidenceMarkers bails out (no fetch, no mutation) when the live HEAD no longer matches the just-recorded HEAD (#2755, Codex review on PR #2792)', () => {
  let fetchedComments = false;
  let minimized = false;
  hideSupersededLocalValidationEvidenceMarkers(
    baseHideOptions({
      fetchLiveHeadSha: () => OTHER_HEAD,
      fetchPriorComments: () => {
        fetchedComments = true;
        return [];
      },
      runMinimizeFn: () => {
        minimized = true;
        throw new Error('should never be called');
      },
    }),
  );
  assert.equal(fetchedComments, false);
  assert.equal(minimized, false);
});

test('hideSupersededLocalValidationEvidenceMarkers excludes a re-fetched comment whose id is not strictly older than postedCommentId (#2755, Codex review on PR #2792)', () => {
  const staleOlder = evidenceComment({
    headSha: OTHER_HEAD,
    nodeId: 'IC_older',
  });
  const staleConcurrentNewer = evidenceComment({
    headSha: OTHER_HEAD,
    nodeId: 'IC_newer_concurrent',
  });
  const calls: unknown[] = [];
  hideSupersededLocalValidationEvidenceMarkers(
    baseHideOptions({
      fetchPriorComments: () => [
        { ...staleOlder, id: POSTED_ID - 1 },
        { ...staleConcurrentNewer, id: POSTED_ID + 1 },
      ],
      runMinimizeFn: (input) => {
        calls.push(input);
        return {
          mode: 'apply',
          classifier: 'OUTDATED',
          counts: {
            eligible: 1,
            alreadyMinimized: 0,
            cannotMinimize: 0,
            untrusted: 0,
            unsupportedType: 0,
            applied: 1,
            failed: 0,
          },
          items: [],
        };
      },
    }),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { subjectIds: string[] }).subjectIds, [
    'IC_older',
  ]);
});

test('hideSupersededLocalValidationEvidenceMarkers never calls runMinimizeFn when no trusted actor resolves (#2755, Copilot review on PR #2792)', () => {
  const stale = evidenceComment({ headSha: OTHER_HEAD, nodeId: 'IC_stale' });
  let called = false;
  hideSupersededLocalValidationEvidenceMarkers(
    baseHideOptions({
      fetchPriorComments: () => [{ ...stale, id: 1 }],
      resolveTrustedActorsFn: () => ({ actors: [], source: 'none' as const }),
      runMinimizeFn: () => {
        called = true;
        throw new Error('should never be called');
      },
    }),
  );
  assert.equal(called, false);
});
