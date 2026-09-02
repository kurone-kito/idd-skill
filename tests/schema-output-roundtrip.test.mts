import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  type AdvisoryConvergenceInputs,
  type AdvisoryConvergenceOptions,
  computeAdvisoryConvergenceVerdict,
} from '../src/scripts/advisory-convergence.mts';
import { classifyBranchConflictState } from '../src/scripts/branch-conflict-state.mts';
import {
  enumerateAllRoadmapsGraph,
  type RoadmapGraphReport,
} from '../src/scripts/discover-roadmap-graph.mts';
import {
  buildDispositionPlan,
  type NoticeComment,
} from '../src/scripts/disposition-non-review-notices.mts';
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
// SCHEMA_OUTPUT_COVERAGE is the single source of truth for which schemas are
// covered this way and which are not; the exhaustiveness test below fails
// closed the moment a new schemas/*.schema.json file appears without an
// entry, mirroring discoverSchemaCases's fixture-coverage guard in
// schema-validation.test.mts.
// ---------------------------------------------------------------------------

interface CoveredEntry {
  schema: string;
  status: 'covered';
  /** Where the real output comes from: `functionName (source-file.mts)`. */
  builder: string;
}

interface UncoveredEntry {
  schema: string;
  status: 'uncovered';
  /** Why no real-output roundtrip exists yet for this schema. */
  reason: string;
}

type CoverageEntry = CoveredEntry | UncoveredEntry;

const SCHEMA_OUTPUT_COVERAGE: CoverageEntry[] = [
  {
    schema: 'advisory-convergence.schema.json',
    status: 'covered',
    builder: 'computeAdvisoryConvergenceVerdict (advisory-convergence.mts)',
  },
  {
    schema: 'advisory-wait-state.schema.json',
    status: 'uncovered',
    reason:
      'advisory-wait-state.mts has no exported function that builds the ' +
      'full envelope -- the exported helpers (buildCopilotRecoverySummary, ' +
      'evaluateStaleRequestRecoveryAction, ...) each build only a nested ' +
      'sub-object, and the root envelope is assembled inline inside the ' +
      "CLI's own non-exported main path. Extracting a pure builder is out " +
      'of scope for this test-only change (#1723 proposed change #2).',
  },
  {
    schema: 'branch-conflict-state.schema.json',
    status: 'covered',
    builder: 'classifyBranchConflictState (branch-conflict-state.mts)',
  },
  {
    schema: 'claim-marker.schema.json',
    status: 'covered',
    builder:
      'parseClaimComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'token-cost-event.schema.json',
    status: 'uncovered',
    reason:
      'token-cost-event.schema.json is a source-repo measurement contract, ' +
      'not a helper stdout envelope -- fixture coverage lives in ' +
      'discoverSchemaCases / scripts/validate-schemas.mjs.',
  },
  {
    schema: 'token-cost-sample.schema.json',
    status: 'uncovered',
    reason:
      'token-cost-sample.schema.json is a source-repo measurement contract, ' +
      'not a helper stdout envelope -- fixture coverage lives in ' +
      'discoverSchemaCases / scripts/validate-schemas.mjs.',
  },
  {
    schema: 'token-cost-snapshot.schema.json',
    status: 'uncovered',
    reason:
      'token-cost-snapshot.schema.json is a source-repo measurement ' +
      'contract, not a helper stdout envelope -- fixture coverage lives in ' +
      'discoverSchemaCases / scripts/validate-schemas.mjs.',
  },
  {
    schema: 'discover-roadmap-union.schema.json',
    status: 'covered',
    builder: 'enumerateAllRoadmapsGraph (discover-roadmap-graph.mts)',
  },
  {
    schema: 'disposition-non-review-notices.schema.json',
    status: 'covered',
    builder: 'buildDispositionPlan (disposition-non-review-notices.mts)',
  },
  {
    schema: 'forced-handoff-marker.schema.json',
    status: 'covered',
    builder:
      'parseForcedHandoffComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'idd-merge-execute.schema.json',
    status: 'covered',
    builder: 'runMergeExecute (idd-merge-execute.mts)',
  },
  {
    schema: 'idd-roadmap-audit-execute.schema.json',
    status: 'covered',
    builder: 'runRoadmapAuditExecute (idd-roadmap-audit-execute.mts)',
  },
  {
    schema: 'live-status-digest.schema.json',
    status: 'uncovered',
    reason:
      'live-status-digest.mts builds the report entirely inside its ' +
      'non-exported main() using direct gh network calls (fetchIssueComments, ' +
      'createIssueComment, updateIssueComment); no exported pure builder ' +
      'produces the full envelope. Extraction is out of scope for this ' +
      'test-only change (#1723 proposed change #2).',
  },
  {
    schema: 'onboarding-hearing-catalog.schema.json',
    status: 'uncovered',
    reason:
      'onboarding-hearing-catalog.schema.json describes the static ' +
      'idd-template/docs/onboarding/hearing-catalog.json source artifact, ' +
      'not a helper stdout envelope -- it is already validated by ' +
      'schema-validation.test.mts and tests/onboarding-hearing.test.mts.',
  },
  {
    schema: 'onboarding-hearing-transcript.schema.json',
    status: 'uncovered',
    reason:
      'onboarding-hearing-transcript.schema.json describes a confirmed ' +
      'hearing transcript document later CLI stages will write, not a ' +
      'current helper stdout envelope -- the valid/invalid fixture pair is ' +
      'exercised by discoverSchemaCases / scripts/validate-schemas.mjs, ' +
      'which enumerates schemas/*.schema.json against ' +
      'fixtures/schemas/*.{valid,invalid}.json.',
  },
  {
    schema: 'phase-graph.schema.json',
    status: 'uncovered',
    reason:
      'schemas/phase-graph.json is a static generated data file, not a ' +
      "helper's stdout envelope -- it is already validated directly by " +
      'schema-validation.test.mts\'s "phase-graph.json data validates ' +
      'against phase-graph schema" test.',
  },
  {
    schema: 'policy.schema.json',
    status: 'uncovered',
    reason:
      'policy.schema.json describes the input config document ' +
      '(.github/idd/config.json), not a helper stdout output -- it is ' +
      "already validated directly by schema-validation.test.mts's " +
      '".github/idd/config.json validates against policy schema" test.',
  },
  {
    schema: 'post-idd-marker.schema.json',
    status: 'uncovered',
    reason:
      'post-idd-marker.mts assembles PostIddMarkerResult only inside its ' +
      'non-exported postMarker()/runReviewActivitySnapshot() CLI paths, ' +
      'both of which perform direct gh network calls; no exported pure ' +
      'builder produces the full envelope. Extraction is out of scope for ' +
      'this test-only change (#1723 proposed change #2).',
  },
  {
    schema: 'pre-merge-readiness.schema.json',
    status: 'covered',
    builder: 'buildPreMergeReadinessSummary (protocol-helpers.mts)',
  },
  {
    schema: 'provider-health.schema.json',
    status: 'uncovered',
    reason:
      'buildProviderHealthReport (provider-health.mts) assembles the full ' +
      'envelope but calls collectAdvisoryReviewEvidence/' +
      'collectCiActionsEvidence internally (live gh network reads); the ' +
      'pure per-service builder classifyProviderHealth is exercised ' +
      "directly against the schema by tests/provider-health.test.mts's " +
      'own fixture-driven tests instead.',
  },
  {
    schema: 'provider-outage-declaration.schema.json',
    status: 'covered',
    builder:
      'parseProviderOutageDeclarationComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'provider-outage-park.schema.json',
    status: 'covered',
    builder:
      'parseProviderOutageParkComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'local-validation-evidence.schema.json',
    status: 'covered',
    builder:
      'parseLocalValidationEvidenceComment (marker-helpers.mts, re-exported by protocol-helpers.mts)',
  },
  {
    schema: 'resolve-review-thread.schema.json',
    status: 'covered',
    builder: 'applyResolveReviewThread (resolve-review-thread.mts)',
  },
  {
    schema: 'stalled-session-quiet-check.schema.json',
    status: 'covered',
    builder: 'evaluateQuietWindow (stalled-session-quiet-check.mts)',
  },
];

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
// Exhaustiveness: every schemas/*.schema.json appears exactly once above.
// ---------------------------------------------------------------------------

test('SCHEMA_OUTPUT_COVERAGE covers every schemas/*.schema.json exactly once', () => {
  const schemaFiles = readdirSync(new URL('../schemas/', import.meta.url))
    .filter((file) => file.endsWith('.schema.json'))
    .sort();
  const ledgerSchemas = SCHEMA_OUTPUT_COVERAGE.map(
    (entry) => entry.schema,
  ).sort();
  assert.deepEqual(
    ledgerSchemas,
    schemaFiles,
    'every schemas/*.schema.json must appear exactly once in ' +
      'SCHEMA_OUTPUT_COVERAGE (add a covered or uncovered-with-reason entry)',
  );
  assert.equal(
    new Set(SCHEMA_OUTPUT_COVERAGE.map((entry) => entry.schema)).size,
    SCHEMA_OUTPUT_COVERAGE.length,
    'SCHEMA_OUTPUT_COVERAGE must not list the same schema twice',
  );
});

test('every covered entry names a builder and every uncovered entry names a reason', () => {
  for (const entry of SCHEMA_OUTPUT_COVERAGE) {
    if (entry.status === 'covered') {
      assert.ok(
        entry.builder.trim().length > 0,
        `${entry.schema}: covered entry must name a builder`,
      );
    } else {
      assert.ok(
        entry.reason.trim().length > 0,
        `${entry.schema}: uncovered entry must give a one-line reason`,
      );
    }
  }
});

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
