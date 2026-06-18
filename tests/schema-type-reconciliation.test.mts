import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AdvisoryWaitStateReport } from '../src/scripts/advisory-wait-state.mts';
import type { BranchConflictResult } from '../src/scripts/branch-conflict-state.mts';
import type { PreMergeReadinessReport } from '../src/scripts/pre-merge-readiness.mts';
import type {
  LiveStatusDigestFields,
  ParsedClaimMarker,
  ParsedForcedHandoffMarker,
} from '../src/scripts/protocol-helpers.mts';
import type { StalledSessionQuietCheckReport } from '../src/scripts/stalled-session-quiet-check.mts';
import {
  checkSchemaKeywords,
  loadJson,
  validate,
  validatePhaseGraph,
} from '../src/scripts/validate-schemas.mts';

// ---------------------------------------------------------------------------
// Schema ⇄ exported-type reconciliation (#874).
//
// Every JSON Schema shipped in schemas/*.schema.json is reconciled with
// the TypeScript type that describes the same document at runtime:
//
//   1. The SCHEMA_TYPE_MAP table below is the single source of truth for
//      the schema-file ⇄ exported-type ⇄ owning-module mapping. A schema
//      file on disk that is missing from the table fails the suite.
//   2. Each entry carries a canonical fixture declared `satisfies` the
//      exported type (compile-time side) and validated against the
//      schema by the dependency-free validator from validate-schemas.mts
//      (runtime side).
//   3. Each entry carries an explicit top-level key list checked both
//      ways: at compile time the list must cover `keyof` the exported
//      type (see exhaustivenessWitnesses), and at runtime the list must
//      equal the schema's top-level `properties` keys, with `required`
//      a subset. Adding a field on either side alone fails the suite.
//
// Documented, pinned discrepancies (do NOT silently widen these — each
// pin breaks loudly when either side changes so a maintainer re-decides):
//
//   - advisory-wait-state / pre-merge-readiness: the CLIs print
//     `trustedMarkerActors` + `trustedMarkerActorsSource` provenance
//     fields that the schemas (additionalProperties: false) do not
//     declare, so the real CLI documents do not validate against their
//     published schemas. Tracked per entry as `reportOnlyKeys`.
//   - stalled-session-quiet-check: the schema uses `format: "uri"` and
//     union `type: ["string", "null"]`, which the in-repo validator
//     does not support, so full-document validation cannot pass today.
//     Tracked as `knownKeywordGaps` / `knownValidationGaps`.
//
// Depth limit: parity is asserted for top-level `properties` keys only;
// nested object shapes are covered by the fixture + `satisfies` pair.
// Optionality limit: parity compares key NAMES, not requiredness — a
// schema-required field whose type-side counterpart is optional is not
// flagged here; the runtime fixture validation partially compensates.
// ---------------------------------------------------------------------------

/** Structural view of a loaded JSON Schema document. */
interface SchemaObject {
  required?: readonly string[];
  properties?: Record<string, unknown>;
}

/** One row of the schema ⇄ type ⇄ module reconciliation table. */
interface SchemaTypeMapping {
  /** Schema file name inside schemas/. */
  readonly schemaFile: string;
  /** Exported TypeScript type the schema corresponds to. */
  readonly exportedType: string;
  /** Module that owns (exports or consumes) the document shape. */
  readonly owningModule: string;
  /** Top-level keys shared by the schema and the exported type. */
  readonly keys: readonly string[];
  /**
   * Keys present on the exported CLI report type (and in the real CLI
   * output) that the schema intentionally does not declare yet. Pinned
   * discrepancy: the suite asserts these stay undeclared in the schema
   * and that the validator rejects them as additional properties.
   */
  readonly reportOnlyKeys?: readonly string[];
  /** Pinned checkSchemaKeywords output for validator-unsupported keywords. */
  readonly knownKeywordGaps?: readonly string[];
  /** Pinned validate() errors for validator-unsupported constructs. */
  readonly knownValidationGaps?: readonly string[];
  /** Canonical fixture, declared `satisfies` the exported type. */
  readonly fixture: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Test-local types for schemas without a runtime type.
// ---------------------------------------------------------------------------

/**
 * Phase-graph document shape (schemas/phase-graph.schema.json).
 *
 * The schema describes the static schemas/phase-graph.json data file;
 * no runtime module materializes this document as a typed value
 * (phase-id-resolver.mts carries its own hard-coded ID list and
 * validate-schemas.mts checks the graph structurally), so the type is
 * defined here from the schema.
 */
interface PhaseGraphDocument {
  version: string;
  nodes: readonly { id: string; next: readonly string[] }[];
}

type ApprovalActorPolicy =
  | 'owners-and-maintainers-only'
  | 'all-write-permission-actors';
type ForcedHandoffMode = 'disabled' | 'human-gated';
interface ForcedHandoffConfig {
  mode?: ForcedHandoffMode;
  authorityPolicy?: ApprovalActorPolicy;
}
interface CheckSelectorConfig {
  selector: string;
  matchMode?: 'exact' | 'glob';
}

/**
 * Policy config file shape (schemas/policy.schema.json).
 *
 * The runtime intentionally has no complete type for this document:
 * policy-helpers.mts treats the adopter-controlled file as untrusted
 * input (`normalizePolicyConfig(config: unknown)`) and its private
 * RawConfig view covers only the namespaces that helper consumes. This
 * type is therefore defined here from the schema. The schema's `^x-`
 * patternProperties extension keys are not modelled (template-literal
 * index keys would make the key-parity witness vacuous).
 */
interface PolicyConfigFile {
  $schema?: string;
  iddVersion: string;
  markerPrefix: string;
  mergePolicy:
    | 'fully_autonomous_merge'
    | 'human_merge'
    | 'separate_merge_agent';
  reviewPolicy:
    | 'copilot-advisory'
    | 'human-required'
    | 'no-advisory'
    | 'external-bot';
  threadResolutionPolicy:
    | 'fast-agent-resolve'
    | 'hybrid-reviewer-ack'
    | 'strict-reviewer-resolve';
  claimTiming: { staleAge: string; heartbeatInterval: string };
  trustedMarkerActors: readonly string[];
  advisoryBotLogins?: readonly string[];
  workshop?: { exampleRepository?: string };
  commands: {
    'install-deps': string;
    'fix-validate': string;
    'pre-push-validate': string;
    'post-fix-validate': string;
  };
  helperRuntime?: {
    profile:
      | 'package-manager'
      | 'vendored-node'
      | 'ephemeral-npx'
      | 'instructions-only';
  };
  issueScope?: 'roadmap' | 'roadmap-first' | 'orphan-first';
  orphanFirstPolicy?: 'none' | 'maintainer-approved' | 'public-disabled';
  skipIssueAuthorApprovalGate?: boolean;
  critiqueLoopProfile?: string;
  mergeHandoffActor?: string;
  externalAdvisoryBot?: string;
  maintainerApprovalActorPolicy?: ApprovalActorPolicy;
  maintainerApprovalActors?: readonly string[];
  stallRecovery?: { quietWindow?: string };
  forcedHandoff?: ForcedHandoffConfig;
  'forced-handoff'?: ForcedHandoffConfig;
  forcedHandoffMode?: ForcedHandoffMode;
  'forced-handoff-mode'?: ForcedHandoffMode;
  forcedHandoffAuthority?: ApprovalActorPolicy;
  'forced-handoff-authority'?: ApprovalActorPolicy;
  markerTrust?: { allowCollaboratorMarkers?: boolean };
  markerTrustAllowCollaboratorMarkers?: boolean;
  allowCollaboratorMarkers?: boolean;
  advisoryWait?: {
    requestCap?: number;
    pendingWindow?: string;
    settledWindow?: string;
    pollInterval?: string;
    capExhaustedRoute?: 'phase-specific' | 'hold';
  };
  ciWait?: {
    runningTimeout?: string;
    generationTimeout?: string;
    rerunPolicy?: 'rerun-once' | 'hold';
  };
  ciGate?: {
    externalChecks?: {
      advisory?: readonly CheckSelectorConfig[];
      waivable?: readonly CheckSelectorConfig[];
    };
    externalCheckWaivers?: {
      mode?: 'disabled' | 'maintainer-authorized';
      authorityPolicy?: ApprovalActorPolicy;
      maxValidity?: string;
    };
  };
  discover?: {
    activeClaimPreScanBatchSize?: number;
    selectionDesync?: 'off' | 'session-offset';
  };
  claim?: { verifySettleDelay?: string };
  critiqueLoop?: {
    cPhaseLowSeveritySkipAfter?: number;
    e10NoProgressHoldAfter?: number;
  };
  reviewEscalation?: {
    changesRequestedFirstEscalation?: string;
    changesRequestedSecondEscalation?: string;
  };
  approvalSignals?: {
    readyLabelName?: string;
    labelFreshnessMode?: 'presence-only' | 'event-freshness';
  };
  issueAuthoring?: {
    maxClarificationRounds?: number;
    authoringLabelName?: string;
    authoringStaleAge?: string;
  };
  autopilotSuitability?: { floor?: 1 | 2 | 3 | 4 | 5; enabled?: boolean };
  worktreeGuard?: { enabled?: boolean; branchPatterns?: readonly string[] };
}

// ---------------------------------------------------------------------------
// Top-level key lists (exported per the reconciliation contract).
// ---------------------------------------------------------------------------

export const advisoryWaitStateKeys = [
  'protocolVersion',
  'prHeadSha',
  'lastCopilotCommit',
  'copilotPending',
  'copilotPendingCoversHead',
  'outcome',
  'f3Outcome',
  'now',
  'requestCap',
  'pendingWindowMinutes',
  'settledWindowMinutes',
  'pollIntervalMinutes',
  'capExhaustedRoute',
  'elapsedMinutes',
  'sameHeadMarkerPresent',
  'earliestSameHeadAt',
  'sameHeadMarkerCount',
  'requestMarkerCount',
  'trustedMarkerSummary',
] as const satisfies readonly (keyof AdvisoryWaitStateReport)[];

export const advisoryWaitStateReportOnlyKeys = [
  'trustedMarkerActors',
  'trustedMarkerActorsSource',
] as const satisfies readonly (keyof AdvisoryWaitStateReport)[];

export const branchConflictStateKeys = [
  'protocolVersion',
  'prNumber',
  'prHeadSha',
  'prBaseSha',
  'published',
  'mergeable',
  'mergeStateStatus',
  'branchState',
  'syncRecommendation',
  'readOnly',
  'worktreeUnchanged',
  'diagnostics',
] as const satisfies readonly (keyof BranchConflictResult)[];

export const claimMarkerKeys = [
  'agentId',
  'claimId',
  'supersedes',
  'branch',
  'createdAt',
] as const satisfies readonly (keyof ParsedClaimMarker)[];

export const forcedHandoffMarkerKeys = [
  'oldAgentId',
  'oldClaimId',
  'newAgentId',
  'newClaimId',
  'branch',
  'linkedPr',
  'forcedBy',
  'reason',
  'timestamp',
  'contextScope',
  'createdAt',
] as const satisfies readonly (keyof ParsedForcedHandoffMarker)[];

export const liveStatusDigestKeys = [
  'phase',
  'claim',
  'branch',
  'lastChecked',
  'openBlockers',
  'nextAction',
  'authoritativeBy',
] as const satisfies readonly (keyof LiveStatusDigestFields)[];

export const phaseGraphKeys = [
  'version',
  'nodes',
] as const satisfies readonly (keyof PhaseGraphDocument)[];

export const policyConfigKeys = [
  '$schema',
  'iddVersion',
  'markerPrefix',
  'mergePolicy',
  'reviewPolicy',
  'threadResolutionPolicy',
  'claimTiming',
  'trustedMarkerActors',
  'advisoryBotLogins',
  'workshop',
  'commands',
  'helperRuntime',
  'issueScope',
  'orphanFirstPolicy',
  'skipIssueAuthorApprovalGate',
  'critiqueLoopProfile',
  'mergeHandoffActor',
  'externalAdvisoryBot',
  'maintainerApprovalActorPolicy',
  'maintainerApprovalActors',
  'stallRecovery',
  'forcedHandoff',
  'forced-handoff',
  'forcedHandoffMode',
  'forced-handoff-mode',
  'forcedHandoffAuthority',
  'forced-handoff-authority',
  'markerTrust',
  'markerTrustAllowCollaboratorMarkers',
  'allowCollaboratorMarkers',
  'advisoryWait',
  'ciWait',
  'ciGate',
  'discover',
  'claim',
  'critiqueLoop',
  'reviewEscalation',
  'approvalSignals',
  'issueAuthoring',
  'autopilotSuitability',
  'worktreeGuard',
] as const satisfies readonly (keyof PolicyConfigFile)[];

// PreMergeReadinessReport is index-signature typed (its summary builder
// returns `Record<string, unknown>` plus a handful of named fields), so
// `keyof` collapses to `string | number`: the `satisfies` below is vacuous and no
// compile-time exhaustiveness witness is possible for this entry. The
// runtime parity test against the schema's `properties` keys still
// catches schema-side drift; type-side drift is not detectable until the
// report type is narrowed to a structural shape.
export const preMergeReadinessKeys = [
  'protocolVersion',
  'decisionAuthority',
  'prHeadSha',
  'now',
  'reviewCurrency',
  'threads',
  'unrepliedComments',
  'reviewerStates',
  'advisoryWait',
  'ci',
  'claim',
  'dispositionEvidence',
  'waiverEvidence',
] as const satisfies readonly (keyof PreMergeReadinessReport)[];

export const preMergeReadinessReportOnlyKeys = [
  'trustedMarkerActors',
  'trustedMarkerActorsSource',
] as const satisfies readonly (keyof PreMergeReadinessReport)[];

export const stalledSessionQuietCheckKeys = [
  'repository',
  'pr',
  'policy',
  'quiet_window_met',
  'quiet_window_ms',
  'window_start',
  'now',
  'latest_activity',
  'latest_activity_type',
  'reason',
  'evidence',
] as const satisfies readonly (keyof StalledSessionQuietCheckReport)[];

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness witnesses.
//
// Resolves to `true` only when `Covered` exhausts `keyof T`; assigning
// `true` below therefore fails `pnpm run typecheck` the moment a key is
// added to an exported type without being added to the key list (or, for
// the two CLI reports, to the documented reportOnlyKeys).
// ---------------------------------------------------------------------------

type CoversAllKeysOf<T, Covered extends PropertyKey> =
  Exclude<keyof T, Covered> extends never ? true : false;

const exhaustivenessWitnesses: {
  advisoryWaitState: CoversAllKeysOf<
    AdvisoryWaitStateReport,
    | (typeof advisoryWaitStateKeys)[number]
    | (typeof advisoryWaitStateReportOnlyKeys)[number]
  >;
  branchConflictState: CoversAllKeysOf<
    BranchConflictResult,
    (typeof branchConflictStateKeys)[number]
  >;
  claimMarker: CoversAllKeysOf<
    ParsedClaimMarker,
    (typeof claimMarkerKeys)[number]
  >;
  forcedHandoffMarker: CoversAllKeysOf<
    ParsedForcedHandoffMarker,
    (typeof forcedHandoffMarkerKeys)[number]
  >;
  liveStatusDigest: CoversAllKeysOf<
    LiveStatusDigestFields,
    (typeof liveStatusDigestKeys)[number]
  >;
  phaseGraph: CoversAllKeysOf<
    PhaseGraphDocument,
    (typeof phaseGraphKeys)[number]
  >;
  policyConfig: CoversAllKeysOf<
    PolicyConfigFile,
    (typeof policyConfigKeys)[number]
  >;
  stalledSessionQuietCheck: CoversAllKeysOf<
    StalledSessionQuietCheckReport,
    (typeof stalledSessionQuietCheckKeys)[number]
  >;
} = {
  advisoryWaitState: true,
  branchConflictState: true,
  claimMarker: true,
  forcedHandoffMarker: true,
  liveStatusDigest: true,
  phaseGraph: true,
  policyConfig: true,
  stalledSessionQuietCheck: true,
};

// ---------------------------------------------------------------------------
// Canonical fixtures (compile-time side of the reconciliation).
// ---------------------------------------------------------------------------

const advisoryWaitStateFixture = {
  protocolVersion: '1',
  prHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  lastCopilotCommit: '',
  copilotPending: false,
  copilotPendingCoversHead: false,
  outcome: 'REQUEST_NEEDED',
  f3Outcome: 'SATISFIED',
  now: '2026-06-11T17:00:00Z',
  requestCap: 30,
  pendingWindowMinutes: 30,
  settledWindowMinutes: 10,
  pollIntervalMinutes: 2,
  capExhaustedRoute: 'phase-specific',
  elapsedMinutes: 0,
  sameHeadMarkerPresent: false,
  earliestSameHeadAt: '',
  sameHeadMarkerCount: 0,
  requestMarkerCount: 0,
  trustedMarkerSummary: {
    viewerLogin: 'idd-bot',
    configuredTrustedActors: ['copilot-cli'],
    collaboratorTrustEnabled: false,
    trustedMarkerLogins: ['idd-bot'],
    trustedSameHeadMarkerCount: 0,
    untrustedSameHeadMarkerCount: 0,
    trustedRequestMarkerCount: 0,
    untrustedRequestMarkerCount: 0,
  },
  trustedMarkerActors: ['copilot-cli'],
  trustedMarkerActorsSource: 'config',
} satisfies AdvisoryWaitStateReport;

const branchConflictStateFixture = {
  protocolVersion: '1',
  prNumber: 101,
  prHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  prBaseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  published: true,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  branchState: 'clean',
  syncRecommendation: 'none',
  readOnly: true,
  worktreeUnchanged: true,
  diagnostics: {
    mergeableSource: 'github-mergeable',
    conflictFiles: [],
    notes: [],
  },
} satisfies BranchConflictResult;

const claimMarkerFixture = {
  agentId: 'github-copilot-cli',
  claimId: 'claim-20260611T000000Z-874',
  supersedes: 'none',
  branch: 'issue/874-reconcile-schemas-json-exported',
  createdAt: '2026-06-11T00:00:00Z',
} satisfies ParsedClaimMarker;

const forcedHandoffMarkerFixture = {
  oldAgentId: 'github-copilot-cli-old',
  oldClaimId: 'claim-20260512T090000Z-337-old',
  newAgentId: 'github-copilot-cli-new',
  newClaimId: 'claim-20260512T110000Z-337-new',
  branch: 'issue/337-feat-protocol-add-auditable-forced',
  linkedPr: '341',
  forcedBy: 'kurone-kito',
  reason: 'operator-approved-recovery',
  timestamp: '2026-05-12T11:00:00Z',
  contextScope: 'issue-plus-pr',
  createdAt: '2026-05-12T11:00:05Z',
} satisfies ParsedForcedHandoffMarker;

const liveStatusDigestFixture = {
  phase: 'E1',
  claim: 'claim-20260611T000000Z-874',
  branch: 'issue/874-reconcile-schemas-json-exported',
  lastChecked: '2026-06-11T00:30:00Z',
  openBlockers: 'none',
  nextAction: 'await CI completion',
  authoritativeBy: 'this comment',
} satisfies LiveStatusDigestFields;

const phaseGraphFixture = {
  version: '0.1.0',
  nodes: [
    { id: 'A1', next: ['B1'] },
    { id: 'B1', next: [] },
  ],
} satisfies PhaseGraphDocument;

const policyConfigFixture = {
  iddVersion: '1.0.0',
  markerPrefix: 'idd-skill',
  mergePolicy: 'fully_autonomous_merge',
  reviewPolicy: 'copilot-advisory',
  threadResolutionPolicy: 'fast-agent-resolve',
  claimTiming: { staleAge: 'PT24H', heartbeatInterval: 'PT12H' },
  trustedMarkerActors: ['copilot-cli'],
  commands: {
    'install-deps': 'true',
    'fix-validate': 'npx dprint fmt',
    'pre-push-validate': 'npx dprint check',
    'post-fix-validate': 'npx dprint fmt && npx markdownlint-cli2',
  },
  stallRecovery: { quietWindow: 'PT30M' },
  forcedHandoff: {
    mode: 'disabled',
    authorityPolicy: 'owners-and-maintainers-only',
  },
  markerTrust: { allowCollaboratorMarkers: false },
  advisoryWait: {
    requestCap: 30,
    pendingWindow: 'PT30M',
    settledWindow: 'PT10M',
    pollInterval: 'PT2M',
    capExhaustedRoute: 'phase-specific',
  },
  ciWait: {
    runningTimeout: 'PT30M',
    generationTimeout: 'PT10M',
    rerunPolicy: 'rerun-once',
  },
  ciGate: {
    externalChecks: {
      advisory: [{ selector: 'Copilot code review', matchMode: 'exact' }],
      waivable: [{ selector: 'CodeRabbit*', matchMode: 'glob' }],
    },
    externalCheckWaivers: {
      mode: 'maintainer-authorized',
      authorityPolicy: 'owners-and-maintainers-only',
      maxValidity: 'PT24H',
    },
  },
  discover: { activeClaimPreScanBatchSize: 10, selectionDesync: 'off' },
  claim: { verifySettleDelay: 'PT5S' },
  critiqueLoop: { cPhaseLowSeveritySkipAfter: 3, e10NoProgressHoldAfter: 3 },
  reviewEscalation: {
    changesRequestedFirstEscalation: 'PT24H',
    changesRequestedSecondEscalation: 'PT48H',
  },
  approvalSignals: {
    readyLabelName: 'idd:ready',
    labelFreshnessMode: 'presence-only',
  },
  issueAuthoring: {
    maxClarificationRounds: 3,
    authoringLabelName: 'status:authoring',
    authoringStaleAge: 'PT4H',
  },
  autopilotSuitability: { floor: 3, enabled: true },
  worktreeGuard: {
    enabled: true,
    branchPatterns: ['issue/*', 'roadmap-audit/*'],
  },
} satisfies PolicyConfigFile;

const preMergeReadinessFixture = {
  protocolVersion: '1',
  decisionAuthority: 'instructions',
  prHeadSha: '1111111111111111111111111111111111111111',
  now: '2026-05-12T00:00:00Z',
  reviewCurrency: {
    watermarkPresent: true,
    watermark: {
      agentId: 'github-copilot-cli',
      claimId: 'claim-123',
      headSha: '1111111111111111111111111111111111111111',
      maxActivityUpdatedAt: '2026-05-11T23:56:00Z',
      totalItemCount: 3,
      latestCiCompletedAt: '2026-05-11T23:57:00Z',
      createdAt: '2026-05-11T23:58:00Z',
    },
    live: {
      totalItemCount: 3,
      maxActivityUpdatedAt: '2026-05-11T23:56:00Z',
      latestCiCompletedAt: '2026-05-11T23:57:00Z',
      latestPassingCiCompletedAt: '2026-05-11T23:57:00Z',
      counts: { comments: 0, reviews: 2, threads: 1 },
      ackOnly: {
        advisoryBotLogins: ['coderabbitai[bot]'],
        source: 'config',
        dispositionsPresent: true,
        latestDispositionAt: '2026-05-11T23:56:00Z',
        items: [],
      },
      effective: {
        maxActivityUpdatedAt: '2026-05-11T23:56:00Z',
        totalItemCount: 3,
      },
    },
    comparisonRoute: 'proceed',
    comparisonReason: 'snapshot-current',
  },
  threads: {
    unresolvedCount: 1,
    actionableCount: 0,
    awaitingReviewerCount: 1,
    amdBlockingCount: 0,
    conversationResolveAgentCount: 0,
    conversationResolveAuthorCount: 0,
    classifications: [
      { id: 'thread-awaiting', classification: 'awaiting-reviewer' },
    ],
  },
  unrepliedComments: { count: 0, items: [] },
  reviewerStates: {
    reviewDecision: 'APPROVED',
    requiredApprovingReviewCount: 0,
    requireCodeOwnerReview: true,
    requiresConversationResolution: false,
    requiredReviewerLogins: [],
    requiredReviewerTeams: [],
    codeownerUserLogins: ['owner-reviewer'],
    codeownerTeamSlugs: [],
    unmatchedCodeownerFiles: [],
    latestByAuthor: [
      {
        login: 'copilot-pull-request-reviewer[bot]',
        state: 'APPROVED',
        submittedAt: '2026-05-11T23:54:00Z',
        isHuman: false,
        isAdvisoryBot: true,
        isCodeowner: false,
        isRequiredReviewer: false,
      },
      {
        login: 'owner-reviewer',
        state: 'APPROVED',
        submittedAt: '2026-05-11T23:55:00Z',
        isHuman: true,
        isAdvisoryBot: false,
        isCodeowner: true,
        isRequiredReviewer: false,
      },
    ],
    humanApprovedCount: 1,
    requiredApprovalsSatisfied: true,
    codeownerApprovalSatisfied: true,
    codeownerSelfApproval: {
      status: 'not_applicable',
      reason: 'codeowner-approval-satisfied',
      prAuthorLogin: 'pr-author',
      directCodeownerUserLogins: ['owner-reviewer'],
      codeownerTeamSlugs: [],
      requireCodeOwnerReview: true,
      codeownerApprovalSatisfied: true,
      bypassDetected: false,
      bypassMode: 'none',
      currentUserCanBypass: 'never',
    },
    humanChangesRequestedCount: 0,
    blockingChangesRequestedLogins: [],
  },
  advisoryWait: {
    outcome: 'SATISFIED',
    f3Outcome: 'SATISFIED',
    lastCopilotCommit: '1111111111111111111111111111111111111111',
    copilotPending: false,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: false,
    earliestSameHeadAt: '',
    sameHeadMarkerCount: 0,
    requestMarkerCount: 0,
    requestCap: 30,
    pendingWindowMinutes: 30,
    settledWindowMinutes: 10,
    pollIntervalMinutes: 2,
    capExhaustedRoute: 'phase-specific',
    elapsedMinutes: 0,
  },
  ci: {
    status: 'success',
    noRequiredChecksConfigured: false,
    presentRunConclusion: 'all-passing',
    requiredCheckCount: 1,
    generatedRequiredCheckCount: 1,
    requiredChecksGenerated: true,
    requiredChecksPassing: true,
    requiredCheckNames: ['lint'],
    missingRequiredCheckNames: [],
    checks: [
      {
        name: 'lint',
        state: 'SUCCESS',
        completedAt: '2026-05-11T23:57:00Z',
        required: true,
      },
    ],
  },
  claim: {
    expectedClaimId: 'claim-123',
    expectedAgentId: 'github-copilot-cli',
    activeClaimPresent: true,
    activeClaim: {
      agentId: 'github-copilot-cli',
      claimId: 'claim-123',
      supersedes: 'none',
      branch: 'issue/309-pre-merge-readiness',
      createdAt: '2026-05-11T23:20:00Z',
    },
    matchesExpectedClaim: true,
    claimLost: false,
    reason: 'match',
  },
  waiverEvidence: {
    valid: [],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
  },
  trustedMarkerActors: ['copilot-cli'],
  trustedMarkerActorsSource: 'config',
} satisfies PreMergeReadinessReport;

const stalledSessionQuietCheckFixture = {
  repository: { owner: 'kurone-kito', repo: 'idd-skill' },
  pr: {
    number: 874,
    title: 'test: reconcile schemas with exported types',
    head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    html_url: 'https://github.com/kurone-kito/idd-skill/pull/874',
  },
  policy: { quiet_window_ms: 1_800_000, claim_created_at: null },
  quiet_window_met: true,
  quiet_window_ms: 1_800_000,
  window_start: '2026-06-11T00:00:00Z',
  now: '2026-06-11T00:30:00Z',
  latest_activity: null,
  latest_activity_type: null,
  reason: 'no-activity-in-window',
  evidence: {
    activity_count_in_window: 0,
    // One element on purpose: it exercises (and pins) the nested
    // never-validating timestamp union, so a partial schema fix cannot
    // leave real documents failing while the suite stays green.
    blocking_activities: [
      {
        type: 'review-comment',
        timestamp: '2026-06-11T00:00:00Z',
      },
    ],
    has_heartbeat_in_window: false,
    has_ci_running: false,
    has_branch_tip_movement: false,
  },
} satisfies StalledSessionQuietCheckReport;

// ---------------------------------------------------------------------------
// The reconciliation table (single source of truth).
// ---------------------------------------------------------------------------

const SCHEMA_TYPE_MAP: readonly SchemaTypeMapping[] = [
  {
    schemaFile: 'advisory-wait-state.schema.json',
    exportedType: 'AdvisoryWaitStateReport',
    owningModule: 'src/scripts/advisory-wait-state.mts',
    keys: advisoryWaitStateKeys,
    reportOnlyKeys: advisoryWaitStateReportOnlyKeys,
    fixture: advisoryWaitStateFixture,
  },
  {
    schemaFile: 'branch-conflict-state.schema.json',
    exportedType: 'BranchConflictResult',
    owningModule: 'src/scripts/branch-conflict-state.mts',
    keys: branchConflictStateKeys,
    fixture: branchConflictStateFixture,
  },
  {
    schemaFile: 'claim-marker.schema.json',
    exportedType: 'ParsedClaimMarker',
    owningModule: 'src/scripts/protocol-helpers.mts',
    keys: claimMarkerKeys,
    fixture: claimMarkerFixture,
  },
  {
    schemaFile: 'forced-handoff-marker.schema.json',
    exportedType: 'ParsedForcedHandoffMarker',
    owningModule: 'src/scripts/protocol-helpers.mts',
    keys: forcedHandoffMarkerKeys,
    fixture: forcedHandoffMarkerFixture,
  },
  {
    schemaFile: 'live-status-digest.schema.json',
    exportedType: 'LiveStatusDigestFields',
    owningModule: 'src/scripts/protocol-helpers.mts',
    keys: liveStatusDigestKeys,
    fixture: liveStatusDigestFixture,
  },
  {
    schemaFile: 'phase-graph.schema.json',
    exportedType: 'PhaseGraphDocument (test-local; no runtime type)',
    owningModule:
      'schemas/phase-graph.json via src/scripts/validate-schemas.mts',
    keys: phaseGraphKeys,
    fixture: phaseGraphFixture,
  },
  {
    schemaFile: 'policy.schema.json',
    exportedType: 'PolicyConfigFile (test-local; no runtime type)',
    owningModule: 'src/scripts/policy-helpers.mts',
    keys: policyConfigKeys,
    fixture: policyConfigFixture,
  },
  {
    schemaFile: 'pre-merge-readiness.schema.json',
    exportedType: 'PreMergeReadinessReport',
    owningModule: 'src/scripts/pre-merge-readiness.mts',
    keys: preMergeReadinessKeys,
    reportOnlyKeys: preMergeReadinessReportOnlyKeys,
    fixture: preMergeReadinessFixture,
  },
  {
    schemaFile: 'stalled-session-quiet-check.schema.json',
    exportedType: 'StalledSessionQuietCheckReport',
    owningModule: 'src/scripts/stalled-session-quiet-check.mts',
    keys: stalledSessionQuietCheckKeys,
    // Pinned validator gaps: the in-repo validator supports neither
    // `format: "uri"` nor union `type: ["string", "null"]`, so the
    // schema cannot fully validate any document today. Each pin breaks
    // when the schema or the validator changes, forcing a re-decision.
    knownKeywordGaps: [
      '$.properties.pr.properties.html_url: unsupported format value "uri"',
    ],
    knownValidationGaps: [
      '$.policy.claim_created_at: expected type "string,null", got "null"',
      '$.latest_activity: expected type "string,null", got "null"',
      '$.latest_activity_type: expected type "string,null", got "null"',
      '$.evidence.blocking_activities[0].timestamp: expected type "string,null", got "string"',
    ],
    fixture: stalledSessionQuietCheckFixture,
  },
];

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const SCHEMAS_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));

function loadSchema(entry: SchemaTypeMapping): SchemaObject {
  return loadJson(`schemas/${entry.schemaFile}`) as SchemaObject;
}

/** Fixture restricted to the keys the schema declares. */
function schemaShapeOf(entry: SchemaTypeMapping): Record<string, unknown> {
  if (!entry.reportOnlyKeys) {
    return entry.fixture;
  }
  const copy: Record<string, unknown> = { ...entry.fixture };
  for (const key of entry.reportOnlyKeys) {
    delete copy[key];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Directory sweep — the table must cover schemas/ exactly.
// ---------------------------------------------------------------------------

test('every *.schema.json file in schemas/ is mapped to an exported type', () => {
  const onDisk = readdirSync(SCHEMAS_DIR)
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
  const mapped = new Set(SCHEMA_TYPE_MAP.map((entry) => entry.schemaFile));
  const unmapped = onDisk.filter((name) => !mapped.has(name));
  assert.deepEqual(
    unmapped,
    [],
    `unmapped schema file(s) in schemas/: ${unmapped.join(', ')} — add a SCHEMA_TYPE_MAP entry (schema ⇄ exported type ⇄ owning module) in tests/schema-type-reconciliation.test.mts`,
  );
});

test('every mapped schema file exists on disk exactly once', () => {
  const onDisk = new Set(
    readdirSync(SCHEMAS_DIR).filter((name) => name.endsWith('.schema.json')),
  );
  const stale = SCHEMA_TYPE_MAP.filter(
    (entry) => !onDisk.has(entry.schemaFile),
  ).map((entry) => entry.schemaFile);
  assert.deepEqual(
    stale,
    [],
    `SCHEMA_TYPE_MAP references missing schema file(s): ${stale.join(', ')}`,
  );
  const names = SCHEMA_TYPE_MAP.map((entry) => entry.schemaFile);
  assert.equal(
    new Set(names).size,
    names.length,
    'SCHEMA_TYPE_MAP contains duplicate schema entries',
  );
});

test('the only non-schema file in schemas/ is the phase-graph data file', () => {
  // schemas/phase-graph.json is DATA (an instance of
  // phase-graph.schema.json), not a schema; it is intentionally outside
  // the *.schema.json mapping glob. Any other stray file fails here.
  const nonSchema = readdirSync(SCHEMAS_DIR)
    .filter((name) => !name.endsWith('.schema.json'))
    .sort();
  assert.deepEqual(nonSchema, ['phase-graph.json']);
});

// ---------------------------------------------------------------------------
// Per-schema reconciliation.
// ---------------------------------------------------------------------------

for (const entry of SCHEMA_TYPE_MAP) {
  test(`${entry.schemaFile}: schema keywords are validator-supported (gaps pinned)`, () => {
    // Sort both sides: the pinned SET stays strict while key-traversal
    // order inside the validator cannot make the pin brittle.
    const errors = [...checkSchemaKeywords(loadSchema(entry))].sort();
    assert.deepEqual(errors, [...(entry.knownKeywordGaps ?? [])].sort());
  });

  test(`${entry.schemaFile}: canonical ${entry.exportedType} fixture validates against the schema`, () => {
    const errors = [
      ...validate(schemaShapeOf(entry), loadSchema(entry)),
    ].sort();
    assert.deepEqual(errors, [...(entry.knownValidationGaps ?? [])].sort());
  });

  test(`${entry.schemaFile}: top-level properties match the ${entry.exportedType} key list`, () => {
    const schema = loadSchema(entry);
    const schemaKeys = Object.keys(schema.properties ?? {}).sort();
    const typeKeys = [...entry.keys].sort();
    assert.deepEqual(
      schemaKeys,
      typeKeys,
      `top-level key drift between schemas/${entry.schemaFile} and ${entry.exportedType} (${entry.owningModule}) — update the schema, the type, or the SCHEMA_TYPE_MAP key list together`,
    );
  });

  test(`${entry.schemaFile}: schema required keys are a subset of the key list`, () => {
    const schema = loadSchema(entry);
    const keySet = new Set<string>(entry.keys);
    const missing = (schema.required ?? []).filter((key) => !keySet.has(key));
    assert.deepEqual(
      missing,
      [],
      `schemas/${entry.schemaFile} requires key(s) absent from the ${entry.exportedType} key list: ${missing.join(', ')}`,
    );
  });

  if (entry.reportOnlyKeys) {
    test(`${entry.schemaFile}: CLI report-only keys stay undeclared in the schema (pinned drift)`, () => {
      // Documented discrepancy: the CLI prints these provenance fields,
      // but the schema (additionalProperties: false) rejects them, so
      // the real CLI document does not validate against its published
      // schema. The pins below break if the schema starts declaring the
      // keys — remove them from reportOnlyKeys at that point.
      const schema = loadSchema(entry);
      const properties = schema.properties ?? {};
      for (const key of entry.reportOnlyKeys ?? []) {
        assert.ok(
          !Object.hasOwn(properties, key),
          `schemas/${entry.schemaFile} now declares "${key}" — move it from reportOnlyKeys into the key list`,
        );
      }
      const errors = validate(entry.fixture, schema);
      for (const key of entry.reportOnlyKeys ?? []) {
        assert.ok(
          errors.some((error) =>
            error.includes(`additional property "${key}" not allowed`),
          ),
          `expected the full CLI report shape to be rejected for "${key}", got: ${errors.join('; ')}`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Extra structural checks.
// ---------------------------------------------------------------------------

test('phase-graph canonical fixture passes referential-integrity validation', () => {
  assert.deepEqual(validatePhaseGraph(phaseGraphFixture), []);
});

test('compile-time key-exhaustiveness witnesses hold', () => {
  // The interesting work happens at `pnpm run typecheck`: each witness
  // collapses to `false` when its key list stops covering `keyof` the
  // exported type. This runtime pass just keeps the witnesses observable
  // in the suite output.
  for (const [name, witness] of Object.entries(exhaustivenessWitnesses)) {
    assert.equal(witness, true, `${name}: exhaustiveness witness must hold`);
  }
});
