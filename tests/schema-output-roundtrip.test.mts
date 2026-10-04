import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  type AdvisoryConvergenceInputs,
  type AdvisoryConvergenceOptions,
  computeAdvisoryConvergenceVerdict,
} from '../src/scripts/advisory-convergence.mts';
import { classifyBranchConflictState } from '../src/scripts/branch-conflict-state.mts';
import { createDiscoverProgress } from '../src/scripts/discover-progress.mts';
import {
  enumerateAllRoadmapsGraph,
  enumerateAllRoadmapsGraphWithRecovery,
  type RoadmapGraphReport,
} from '../src/scripts/discover-roadmap-graph.mts';
import {
  buildDispositionPlan,
  type NoticeComment,
} from '../src/scripts/disposition-non-review-notices.mts';
import { createLoadControlRefusal } from '../src/scripts/github-api-refusal.mts';
import {
  type MergeExecuteDeps,
  runMergeExecute,
} from '../src/scripts/idd-merge-execute.mts';
import {
  type RoadmapAuditExecuteDeps,
  runRoadmapAuditExecute,
} from '../src/scripts/idd-roadmap-audit-execute.mts';
import {
  buildPreMergeReadinessSummary,
  parseClaimComment,
  parseForcedHandoffComment,
  parseLocalValidationEvidenceComment,
  parseProviderOutageDeclarationComment,
  parseProviderOutageParkComment,
  renderLocalValidationEvidenceComment,
  renderProviderOutageParkComment,
  summarizeDispositionEvidenceForGate,
} from '../src/scripts/protocol-helpers.mts';
import { applyResolveReviewThread } from '../src/scripts/resolve-review-thread.mts';
import { evaluateQuietWindow } from '../src/scripts/stalled-session-quiet-check.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';
import { readJson } from './test-utils.mts';

// ---------------------------------------------------------------------------
// #1723: validate REAL helper-produced output against each output schema.
//
// tests/schema-validation.test.mts already proves every schemas/*.schema.json
// accepts its own hand-written fixtures/schemas/*.valid.json and rejects its
// *.invalid.json — but both sides of that check are authored by hand, so a
// fixture written from the same wrong mental model as the schema agrees with
// it perfectly. This file closes that gap: for every schema that describes a
// helper's stdout envelope, it invokes the helper's own output-building
// function with fixture inputs (never a hand-written expected JSON) and
// validates the REAL result against the schema, in both directions:
//   1. the produced output validates against the schema (validate() below);
//   2. every root field the output actually emits is declared in the schema
//      (rootFieldDriftErrors() below) -- so a helper that starts emitting a
//      new root field cannot slip past silently even on a schema that has
//      not (yet) declared `additionalProperties: false` at its root.
//
// SCHEMA_OUTPUT_COVERAGE (src/scripts/repository-schema-audit.mts, #3751) is
// the single source of truth for which schemas are covered this way and which
// are not; the SCHEMA-OUTPUT-COVERAGE rule of `audit-docs --check` fails closed
// the moment a new schemas/*.schema.json file appears without an entry. The
// behavioral builders named there still execute below.
// ---------------------------------------------------------------------------

/**
 * Root-only reverse-direction check (#1723 acceptance criterion #2): every
 * top-level key the real output object carries must be declared in the
 * schema's `properties`. Deliberately root-only -- recursing into nested
 * objects would flag legitimate optional sub-fields the schema already
 * permits and is not what the acceptance criterion asks for. Independent of
 * whether the schema itself declares `additionalProperties: false` at its
 * root, so this still does real work on a schema that does not.
 */
function rootFieldDriftErrors(output: unknown, schema: unknown): string[] {
  if (typeof output !== 'object' || output === null) {
    return [];
  }
  const declared = new Set(
    Object.keys(
      (schema as { properties?: Record<string, unknown> }).properties ?? {},
    ),
  );
  const errors: string[] = [];
  for (const key of Object.keys(output as Record<string, unknown>)) {
    if (!declared.has(key)) {
      errors.push(
        `root field "${key}" is present in output but not declared in schema.properties`,
      );
    }
  }
  return errors;
}

/** Validate a real captured output against its schema, in both directions. */
function assertRoundtrip(output: unknown, schema: unknown): void {
  assert.deepEqual(validate(output, schema), []);
  assert.deepEqual(rootFieldDriftErrors(output, schema), []);
}

// ---------------------------------------------------------------------------
// Meta self-test (#1723 AC #2): prove the reverse-direction check actually
// fails when a root field is undeclared, using a real captured output.
// ---------------------------------------------------------------------------

test('rootFieldDriftErrors and validate() both catch an undeclared root field on real output', () => {
  const schema = loadJson('schemas/stalled-session-quiet-check.schema.json');
  const quiet = evaluateQuietWindow({
    now: '2026-05-13T12:00:00Z',
    activities: [],
  });
  const output = {
    ...quiet,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    pr: {
      number: 42,
      title: 'test PR',
      head_sha: '1111111111111111111111111111111111111111',
      html_url: 'https://github.com/kurone-kito/idd-skill/pull/42',
    },
    policy: { quiet_window_ms: quiet.quiet_window_ms, claim_created_at: null },
  };
  // The unmodified real output must roundtrip cleanly first.
  assertRoundtrip(output, schema);

  // Simulate the drift class #1723 exists to catch: the helper starts
  // emitting a root field the schema never learned about.
  const drifted = { ...output, __driftProbe: true };
  const driftErrors = rootFieldDriftErrors(drifted, schema);
  assert.ok(
    driftErrors.some((error) => error.includes('__driftProbe')),
    `expected rootFieldDriftErrors to report __driftProbe: ${driftErrors.join('; ')}`,
  );
  // This schema already declares additionalProperties:false at its root, so
  // validate() independently reports the same drift.
  const schemaErrors = validate(drifted, schema);
  assert.ok(
    schemaErrors.some((error) => error.includes('__driftProbe')),
    `expected validate() to report __driftProbe: ${schemaErrors.join('; ')}`,
  );
});

// ---------------------------------------------------------------------------
// Covered schemas -- one real-output roundtrip per entry.
// ---------------------------------------------------------------------------

test('claim-marker: parseClaimComment output validates against schema', () => {
  const body = readFileSync(
    new URL('../fixtures/issue-comments/active-claim.md', import.meta.url),
    'utf8',
  );
  const parsed = parseClaimComment(body, '2026-05-09T10:00:00Z');
  assert.ok(parsed !== null, 'parseClaimComment returned null');
  assertRoundtrip(parsed, loadJson('schemas/claim-marker.schema.json'));
});

test('forced-handoff-marker: parseForcedHandoffComment output validates against schema', () => {
  const body = [
    '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","linked-pr":"341","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-plus-pr"} -->',
    '',
    'Forced handoff approved by kurone-kito.',
  ].join('\n');
  const parsed = parseForcedHandoffComment(body, '2026-05-12T11:00:05Z');
  assert.ok(parsed !== null, 'parseForcedHandoffComment returned null');
  assertRoundtrip(
    parsed,
    loadJson('schemas/forced-handoff-marker.schema.json'),
  );
});

test('provider-outage-declaration: parseProviderOutageDeclarationComment output validates against schema', () => {
  const body = [
    '<!-- idd-provider-outage-declaration: kurone-kito service:idd-advisory-convergence started:2026-09-01T05:00:00Z expires:2026-09-02T05:00:00Z -->',
    '',
    '_kurone-kito: provider outage declaration for `idd-advisory-convergence` until `2026-09-02T05:00:00Z` — IDD automation marker. Do not edit._',
  ].join('\n');
  const parsed = parseProviderOutageDeclarationComment(
    body,
    '2026-09-01T05:00:01Z',
  );
  assert.ok(
    parsed !== null,
    'parseProviderOutageDeclarationComment returned null',
  );
  assertRoundtrip(
    parsed,
    loadJson('schemas/provider-outage-declaration.schema.json'),
  );
});

test('provider-outage-park: parseProviderOutageParkComment output validates against schema', () => {
  const body = renderProviderOutageParkComment({
    actor: 'claude-29738796',
    issueNumber: 2321,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'f22dd6db-83f8-4e92-aaa9-23db47d10650',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait'],
  });
  const parsed = parseProviderOutageParkComment(body, '2026-09-02T00:00:05Z');
  assert.ok(parsed !== null, 'parseProviderOutageParkComment returned null');
  assertRoundtrip(parsed, loadJson('schemas/provider-outage-park.schema.json'));
});

test('local-validation-evidence: parseLocalValidationEvidenceComment output validates against schema', () => {
  const body = renderLocalValidationEvidenceComment({
    actor: 'kurone-kito',
    headSha: 'a'.repeat(40),
    commandSet: 'pre-push-validate',
    covers: ['idd-doctor', 'lint', 'pnpm-boundary'],
    outcome: 'pass',
  });
  const parsed = parseLocalValidationEvidenceComment(
    body,
    '2026-09-01T05:00:01Z',
  );
  assert.ok(
    parsed !== null,
    'parseLocalValidationEvidenceComment returned null',
  );
  assertRoundtrip(
    parsed,
    loadJson('schemas/local-validation-evidence.schema.json'),
  );
});

test('advisory-convergence: computeAdvisoryConvergenceVerdict output validates against schema', () => {
  const HEAD = '1111111111111111111111111111111111111111';
  const NOW = '2026-07-11T12:00:00Z';
  const inputs: AdvisoryConvergenceInputs = {
    prNumber: 1234,
    prHeadSha: HEAD,
    reviews: [
      {
        author: { login: 'copilot-pull-request-reviewer' },
        submittedAt: NOW,
        commitId: HEAD,
        itemCount: 0,
      },
    ],
    threads: [],
    comments: [],
    claimEvents: [],
    claimMarkerHistoryPresent: false,
    claimCandidateAmbiguous: false,
  };
  const options: AdvisoryConvergenceOptions = {
    now: NOW,
    primaryBotLogin: 'copilot',
    trustedMarkerLogins: ['kurone-kito'],
    advisoryBotLogins: [],
    prAuthorLogin: '',
    headCommittedAt: NOW,
    deadlineMinutes: 1440,
    waiverMode: 'disabled',
    waiverMaxValidity: 'PT24H',
    waiverCheckSelector: 'idd-advisory-convergence',
  };
  const verdict = computeAdvisoryConvergenceVerdict(inputs, options);
  assertRoundtrip(
    verdict,
    loadJson('schemas/advisory-convergence.schema.json'),
  );
});

test('branch-conflict-state: classifyBranchConflictState output validates against schema', async () => {
  const fixture = loadJson('fixtures/branch-conflict-state/clean.json') as {
    prData: Record<string, unknown> & { number: number };
  };
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData as never,
    // Fixture SHAs are placeholders, not real git objects -- skip the git
    // probe so this stays fast and offline, matching
    // branch-conflict-state.test.mts's own precedent for this fixture.
    _skipGitProbe: true,
  });
  assertRoundtrip(
    result,
    loadJson('schemas/branch-conflict-state.schema.json'),
  );
});

test('discover-roadmap-union: enumerateAllRoadmapsGraph output validates against schema', async () => {
  const issues = new Map<number, unknown>([
    [
      700,
      {
        number: 700,
        title: 'roadmap 700',
        state: 'open',
        body: '<!-- idd-skill-roadmap-id: epic -->\n- [ ] #701',
        labels: [{ name: 'roadmap' }],
      },
    ],
    [
      701,
      {
        number: 701,
        title: 'issue 701',
        state: 'open',
        body: 'task 701\n<!-- idd-skill-autopilot-suitability: 4 -->',
        labels: [],
      },
    ],
  ]);
  const report = await enumerateAllRoadmapsGraph({
    loadOpenRoadmapRoots: async () => [700],
    loadIssue: async (issueNumber: number) => issues.get(issueNumber) ?? null,
  });
  assertRoundtrip(
    report,
    loadJson('schemas/discover-roadmap-union.schema.json'),
  );
});

test('discover-roadmap-incomplete: an interrupted scan result validates against schema', async () => {
  const result = await enumerateAllRoadmapsGraphWithRecovery(
    {
      loadOpenRoadmapRoots: async () => [700],
      loadIssue: async (issueNumber: number) =>
        issueNumber === 700
          ? {
              number: 700,
              title: 'roadmap 700',
              state: 'open',
              body: '<!-- idd-skill-roadmap-id: epic -->\n- [ ] #701',
              labels: [{ name: 'roadmap' }],
            }
          : {
              number: 701,
              title: 'issue 701',
              state: 'open',
              body: 'task 701',
              labels: [],
            },
      claimState: {
        loadComments: async () => {
          throw createLoadControlRefusal({
            outcome: 'deadline-expired',
            reason: 'cooldown',
            retryAt: '2026-10-01T03:15:00.000Z',
            retryAtSource: 'server',
          });
        },
        isTrustedAuthor: () => true,
        staleAgeMs: 86_400_000,
        heartbeatIntervalMs: 43_200_000,
        nowIso: '2026-10-01T00:00:00.000Z',
        currentClaimId: '',
        currentSessionAgentId: null,
        currentSessionWorktreePath: null,
        currentSessionBranch: null,
        currentSessionOwnsClaimEvidence: false,
      },
    },
    {
      progress: createDiscoverProgress(),
      rerunArguments: [
        '--all-roadmaps',
        '--with-claim-state',
        '--with-progress',
      ],
    },
  );
  assertRoundtrip(
    result,
    loadJson('schemas/discover-roadmap-incomplete.schema.json'),
  );
});

test('disposition-non-review-notices: buildDispositionPlan output validates against schema', () => {
  const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
  const comment: NoticeComment = {
    id: 1,
    login: 'chatgpt-codex-connector[bot]',
    body: 'You have reached your Codex usage limits for code reviews.',
    createdAt: '2026-05-12T00:00:00Z',
  };
  const plan = buildDispositionPlan(
    { headSha: HEAD_SHA, comments: [comment] },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  const output = { mode: 'dry-run', prNumber: 7, ...plan };
  assertRoundtrip(
    output,
    loadJson('schemas/disposition-non-review-notices.schema.json'),
  );
});

test('idd-merge-execute: runMergeExecute output validates against schema', () => {
  const HEAD = '1111111111111111111111111111111111111111';
  const report: Record<string, unknown> = {
    prHeadSha: HEAD,
    reviewCurrency: { comparisonRoute: 'proceed', comparisonReason: 'match' },
    threads: { actionableCount: 0 },
    advisoryWait: { f3Outcome: 'SATISFIED' },
    ci: {
      status: 'success',
      requiredChecksPassing: true,
      noRequiredChecksConfigured: false,
      presentRunConclusion: 'all-passing',
    },
    reviewerStates: {
      requiredApprovalsSatisfied: true,
      codeownerApprovalSatisfied: true,
      codeownerSelfApproval: { status: 'not_applicable' },
    },
    claim: { matchesExpectedClaim: true, reason: 'match' },
    dispositionEvidence: { route: 'proceed', blockingCount: 0 },
    branchCurrency: {
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      requiresUpToDateHead: false,
      requiresUpToDateHeadSource: 'none',
    },
  };
  const deps: MergeExecuteDeps = {
    collect: () => report,
    fetchHeadSha: () => HEAD,
    fetchMergeState: () => ({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    }),
    mergePr: () => 'Merged PR.',
    mergePrAdmin: () => 'Merged PR (admin).',
    resolveSoloCodeownerAdminFallbackMode: () => 'auto-admin-retry',
    getLocalHeadState: () => ({ branch: null, headSha: null }),
    fetchHeadRefName: () => '',
  };
  const { verdict } = runMergeExecute(
    ['--pr', '994', '--claim-issue', '309', '--claim-id', 'c-1'],
    deps,
  );
  assertRoundtrip(verdict, loadJson('schemas/idd-merge-execute.schema.json'));
});

test('idd-merge-execute: a non-null localHeadDrift verdict validates against schema (#2453)', () => {
  const HEAD = '1111111111111111111111111111111111111111';
  const DRIFTED = '2222222222222222222222222222222222222222';
  const report: Record<string, unknown> = {
    prHeadSha: HEAD,
    reviewCurrency: { comparisonRoute: 'proceed', comparisonReason: 'match' },
    threads: { actionableCount: 0 },
    advisoryWait: { f3Outcome: 'SATISFIED' },
    ci: {
      status: 'success',
      requiredChecksPassing: true,
      noRequiredChecksConfigured: false,
      presentRunConclusion: 'all-passing',
    },
    reviewerStates: {
      requiredApprovalsSatisfied: true,
      codeownerApprovalSatisfied: true,
      codeownerSelfApproval: { status: 'not_applicable' },
    },
    claim: { matchesExpectedClaim: true, reason: 'match' },
    dispositionEvidence: { route: 'proceed', blockingCount: 0 },
    branchCurrency: {
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      requiresUpToDateHead: false,
      requiresUpToDateHeadSource: 'none',
    },
  };
  const deps: MergeExecuteDeps = {
    collect: () => report,
    fetchHeadSha: () => HEAD,
    fetchMergeState: () => ({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    }),
    mergePr: () => 'Merged PR.',
    mergePrAdmin: () => 'Merged PR (admin).',
    resolveSoloCodeownerAdminFallbackMode: () => 'auto-admin-retry',
    getLocalHeadState: () => ({
      branch: 'issue/994-fix-thing',
      headSha: DRIFTED,
    }),
    fetchHeadRefName: () => 'issue/994-fix-thing',
  };
  const { verdict } = runMergeExecute(
    ['--pr', '994', '--claim-issue', '309', '--claim-id', 'c-1'],
    deps,
  );
  assert.deepEqual(verdict.localHeadDrift, {
    localHeadSha: DRIFTED,
    remoteHeadSha: HEAD,
  });
  assertRoundtrip(verdict, loadJson('schemas/idd-merge-execute.schema.json'));
});

test('idd-merge-execute: a verdict with and without postFailureState validates against schema (#3681)', () => {
  const HEAD = '1111111111111111111111111111111111111111';
  const report: Record<string, unknown> = {
    prHeadSha: HEAD,
    reviewCurrency: { comparisonRoute: 'proceed', comparisonReason: 'match' },
    threads: { actionableCount: 0 },
    advisoryWait: { f3Outcome: 'SATISFIED' },
    ci: {
      status: 'success',
      requiredChecksPassing: true,
      noRequiredChecksConfigured: false,
      presentRunConclusion: 'all-passing',
    },
    reviewerStates: {
      requiredApprovalsSatisfied: true,
      codeownerApprovalSatisfied: true,
      codeownerSelfApproval: { status: 'not_applicable' },
    },
    claim: { matchesExpectedClaim: true, reason: 'match' },
    dispositionEvidence: { route: 'proceed', blockingCount: 0 },
    branchCurrency: {
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      requiresUpToDateHead: false,
      requiresUpToDateHeadSource: 'none',
    },
  };
  const deps: MergeExecuteDeps = {
    collect: () => report,
    fetchHeadSha: () => HEAD,
    fetchMergeState: () => ({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    }),
    mergePr: () => {
      throw new Error('merge transport closed');
    },
    mergePrAdmin: () => 'Merged PR (admin).',
    resolveSoloCodeownerAdminFallbackMode: () => 'auto-admin-retry',
    getLocalHeadState: () => ({ branch: null, headSha: null }),
    fetchHeadRefName: () => '',
  };
  const schema = loadJson('schemas/idd-merge-execute.schema.json');
  const args = [
    '--pr',
    '994',
    '--claim-issue',
    '309',
    '--claim-id',
    'c-1',
    '--apply',
  ];

  // No fetchPrOutcome dep: the failed verdict carries no postFailureState.
  const without = runMergeExecute(args, deps).verdict;
  assert.equal('postFailureState' in without, false);
  assertRoundtrip(without, schema);

  // A merged read-back and a never-merged (null mergedAt) read-back.
  for (const mergedAt of ['2026-10-01T03:04:05Z', null]) {
    const { verdict } = runMergeExecute(args, {
      ...deps,
      fetchPrOutcome: () => ({
        state: mergedAt ? 'MERGED' : 'OPEN',
        mergedAt,
        headRefOid: HEAD,
      }),
    });
    assert.ok(verdict.postFailureState);
    assertRoundtrip(verdict, schema);
  }
});

test('idd-roadmap-audit-execute: runRoadmapAuditExecute output validates against schema', async () => {
  const ROADMAP = 995;
  const report: RoadmapGraphReport = {
    root: {
      number: ROADMAP,
      title: 'completed roadmap',
      state: 'OPEN',
      classification: 'roadmap',
      roadmapMarkerId: 'epic',
    },
    nodes: [
      {
        number: ROADMAP,
        title: `issue ${ROADMAP}`,
        state: 'OPEN',
        labels: [],
        classification: 'roadmap',
        roadmapMarkerId: 'epic',
        autopilotSuitability: null,
        effort: null,
        depth: 0,
      },
      {
        number: 1047,
        title: 'issue 1047',
        state: 'CLOSED',
        labels: [],
        classification: 'execution',
        roadmapMarkerId: '',
        autopilotSuitability: null,
        effort: null,
        depth: 1,
      },
    ],
    edges: [
      {
        source: ROADMAP,
        target: 1047,
        relationship: 'task-list',
        evidence: '- [x] #1047',
      },
    ],
    provenancePaths: [
      { target: ROADMAP, path: [ROADMAP] },
      { target: 1047, path: [ROADMAP, 1047] },
    ],
    roadmapNodes: [],
    executionCandidates: [],
    diagnostics: {
      duplicateReferences: [],
      cycles: [],
      inaccessibleReferences: [],
      unresolvedReferences: [],
    },
    summary: {
      rootNumber: ROADMAP,
      nodeCount: 2,
      edgeCount: 1,
      roadmapNodeCount: 0,
      executionCandidateCount: 0,
      duplicateReferenceCount: 0,
      cycleCount: 0,
      inaccessibleReferenceCount: 0,
      unresolvedReferenceCount: 0,
      maxDepth: 1,
    },
  } as unknown as RoadmapGraphReport;
  const deps: RoadmapAuditExecuteDeps = {
    collect: async () => report,
    resolveOpenLinkedPrIssues: () => [],
    revalidateClaim: () => ({
      owned: true,
      reason: 'match',
      stale: false,
      activeClaim: {
        agentId: 'github-copilot-cli',
        claimId: 'claim-20260626T000000Z-995',
        supersedes: 'none',
        branch: 'roadmap-audit/995-completed-roadmap',
        createdAt: '2026-06-26T00:00:00Z',
      },
    }),
    hasTrustedCompletionEvidence: () => false,
    postEvidenceComment: () => {},
    closeRoadmap: () => {},
    releaseClaim: () => {},
    now: () => '2026-06-26T01:00:00Z',
  };
  const { verdict } = await runRoadmapAuditExecute(
    ['--roadmap', String(ROADMAP)],
    deps,
  );
  assertRoundtrip(
    verdict,
    loadJson('schemas/idd-roadmap-audit-execute.schema.json'),
  );
});

test('pre-merge-readiness: buildPreMergeReadinessSummary output validates against schema', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json') as {
    input: Record<string, unknown>;
    options: Record<string, unknown>;
  };
  const summary = buildPreMergeReadinessSummary(
    fixture.input as never,
    fixture.options as never,
  );
  assertRoundtrip(summary, loadJson('schemas/pre-merge-readiness.schema.json'));
});

test('pre-merge-readiness: a stale-thread dispositionEvidence entry with a hint round-trips the schema (#3670)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json') as {
    input: Record<string, unknown>;
    options: Record<string, unknown>;
  };
  const summary = JSON.parse(
    JSON.stringify(
      buildPreMergeReadinessSummary(
        fixture.input as never,
        {
          ...fixture.options,
          includeDispositionEvidence: true,
        } as never,
      ),
    ),
  ) as { dispositionEvidence: unknown };
  // A resolved thread whose last marker-first reply is followed by a plain-
  // prose correction: reported stale, with the optional next-step hint.
  summary.dispositionEvidence = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-stale',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please reconsider this',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:30:00Z',
                body: '**Accepted** — fixed in abc1234',
                lastEditedAt: null,
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T01:00:00Z',
                body: 'Correction: the fix is actually in def5678.',
                lastEditedAt: null,
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'] },
  );
  const entry = (
    summary.dispositionEvidence as { missingThreads: { hint?: string }[] }
  ).missingThreads[0];
  assert.equal(typeof entry.hint, 'string');
  assertRoundtrip(summary, loadJson('schemas/pre-merge-readiness.schema.json'));
});

test('resolve-review-thread: applyResolveReviewThread output validates against schema', () => {
  const { replyId } = applyResolveReviewThread({
    assertClaim: () => {},
    postReply: () => ({ id: 4242 }),
    resolveThread: () => {},
  });
  const output = {
    mode: 'apply',
    prNumber: 7,
    commentId: 1001,
    threadId: 'thread-b',
    alreadyResolved: false,
    status: 'applied',
    replyId,
  };
  assertRoundtrip(
    output,
    loadJson('schemas/resolve-review-thread.schema.json'),
  );
});

test('stalled-session-quiet-check: evaluateQuietWindow output validates against schema', () => {
  const quiet = evaluateQuietWindow({
    now: '2026-05-13T12:00:00Z',
    activities: [{ type: 'comment', timestamp: '2026-05-13T11:45:00Z' }],
  });
  const output = {
    ...quiet,
    repository: { owner: 'kurone-kito', repo: 'idd-skill' },
    pr: {
      number: 42,
      title: 'test PR',
      head_sha: '1111111111111111111111111111111111111111',
      html_url: 'https://github.com/kurone-kito/idd-skill/pull/42',
    },
    policy: { quiet_window_ms: quiet.quiet_window_ms, claim_created_at: null },
  };
  assertRoundtrip(
    output,
    loadJson('schemas/stalled-session-quiet-check.schema.json'),
  );
});
