import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AdvisoryConvergenceVerdict } from '../src/scripts/advisory-convergence.mts';
import type { AdvisoryWaitStateReport } from '../src/scripts/advisory-wait-state.mts';
import type { BranchConflictResult } from '../src/scripts/branch-conflict-state.mts';
import type {
  DiscoverIncompleteReport,
  RoadmapGraphUnionReport,
} from '../src/scripts/discover-roadmap-graph.mts';
import type { DispositionReport } from '../src/scripts/disposition-non-review-notices.mts';
import type { IddMergeExecuteVerdict } from '../src/scripts/idd-merge-execute.mts';
import type { IddRoadmapAuditExecuteVerdict } from '../src/scripts/idd-roadmap-audit-execute.mts';
import type {
  OnboardingHearingCatalog,
  OnboardingHearingTranscript,
} from '../src/scripts/onboarding-hearing.mts';
import type { PostIddMarkerResult } from '../src/scripts/post-idd-marker.mts';
import type { PreMergeReadinessReport } from '../src/scripts/pre-merge-readiness.mts';
import type {
  LiveStatusDigestFields,
  ParsedClaimMarker,
  ParsedForcedHandoffMarker,
  ParsedLocalValidationEvidence,
  ParsedProviderOutageDeclaration,
  ParsedProviderOutagePark,
} from '../src/scripts/protocol-helpers.mts';
import type { ProviderHealthReport } from '../src/scripts/provider-health.mts';
import {
  type CatalogSchemaFile,
  SCHEMA_TYPE_CATALOG,
} from '../src/scripts/repository-schema-audit.mts';
import type { ResolveReviewThreadReport } from '../src/scripts/resolve-review-thread.mts';
import type { StalledSessionQuietCheckReport } from '../src/scripts/stalled-session-quiet-check.mts';
import type {
  TokenCostEvent,
  TokenCostSample,
  TokenCostSnapshot,
} from '../src/scripts/token-cost-core.mts';
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
//   1. SCHEMA_TYPE_CATALOG (src/scripts/repository-schema-audit.mts, #3751)
//      is the single source of truth for the schema-file ⇄ exported-type ⇄
//      owning-module mapping, joined below with this file's test-only keys
//      and fixtures. A schema file on disk that is missing from the catalog
//      fails SCHEMA-TYPE-CATALOG in `audit-docs --check`.
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
// Pinned-discrepancy mechanism (`knownKeywordGaps` / `knownValidationGaps`):
// when a mapped schema uses a construct the in-repo validator does not
// support, its expected checkSchemaKeywords / validate() output is pinned on
// its entry so the gap breaks loudly if either side changes. There are
// currently no pinned gaps: the validator supports every construct the mapped
// schemas use — `format: "uri"` and union `type: ["string", "null"]` (both
// exercised by stalled-session-quiet-check) are recognized.
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

/** The test-only half of a reconciliation row, keyed by schema file. */
interface SchemaTestData {
  /** Top-level keys shared by the schema and the exported type. */
  readonly keys: readonly string[];
  /** Pinned checkSchemaKeywords output for validator-unsupported keywords. */
  readonly knownKeywordGaps?: readonly string[];
  /** Pinned validate() errors for validator-unsupported constructs. */
  readonly knownValidationGaps?: readonly string[];
  /** Canonical fixture, declared `satisfies` the exported type. */
  readonly fixture: Record<string, unknown>;
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

/**
 * Issue-authoring draft-review input shape
 * (schemas/issue-authoring-review-input.schema.json).
 *
 * The payload the issue-authoring caller writes to the configured
 * `issueAuthoring.adversarialReview.delegate.command`'s stdin. No helper
 * builds it (the caller composes it and the resolver never invokes the
 * command), so no runtime module owns a type and it is defined here from
 * the schema.
 */
interface IssueAuthoringReviewInput {
  title: string;
  body: string;
  packet: {
    goal: string;
    constraints: readonly string[];
    evidence: readonly string[];
    relationships: readonly string[];
    checklist: readonly string[];
  };
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
  developmentBranch?: string;
  provider?: 'github' | 'gitlab' | 'bitbucket';
  mergePolicy:
    | 'fully_autonomous_merge'
    | 'human_merge'
    | 'separate_merge_agent';
  mergePolicyAck?:
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
  authoringLanguage?: string;
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
    convergenceScope?: 'all-prs' | 'idd-claimed';
    requestCap?: number;
    pendingWindow?: string;
    settledWindow?: string;
    pollInterval?: string;
    capExhaustedRoute?: 'phase-specific' | 'hold';
  };
  advisoryConvergence?: {
    copilotReviewPollInterval?: string;
    copilotReviewPollMaxWait?: string;
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
    trustEmptyProtectionReads?: boolean;
    trustSourcePinnedRequiredChecks?: boolean;
  };
  discover?: {
    activeClaimPreScanBatchSize?: number;
    selectionDesync?: 'off' | 'session-offset';
    legacyRoots?: readonly number[];
  };
  claim?: { verifySettleDelay?: string };
  critiqueLoop?: {
    cPhaseLowSeveritySkipAfter?: number;
    e10NoProgressHoldAfter?: number;
    deferAfterRounds?: number;
    deferByUrgency?: 'off' | 'low' | 'low-and-medium' | 'severity-tiered';
    deferNeedsDecision?: 'on' | 'off';
    subagentWaitCeiling?: string;
    delegate?: {
      command: string;
      mode?: 'fallback' | 'combined' | 'on-success' | 'never';
    } | null;
    telemetryHook?: { command: string } | null;
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
    heartbeatCoalesceWindow?: string;
    journalIssue?: string;
    adversarialReview?: {
      waitCeiling?: string;
      delegate?: {
        command: string;
        mode?: 'fallback' | 'combined' | 'on-success' | 'never';
      } | null;
    };
  };
  autopilotSuitability?: { floor?: 1 | 2 | 3 | 4 | 5; enabled?: boolean };
  worktreeGuard?: { enabled?: boolean; branchPatterns?: readonly string[] };
  upstreamEscalation?: { enabled?: boolean };
  labels?: {
    roadmapLabelName?: string;
    blockedByHumanLabelName?: string;
    needsDecisionLabelName?: string;
    untrustedLabelerLogins?: readonly string[];
  };
  mergeGate?: {
    soloCodeownerAdminFallback?: 'auto-admin-retry' | 'hold-and-report';
  };
  providerOutage?: {
    declarationTarget?: number;
    maxValidity?: string;
    maxParkedChanges?: number;
  };
  localValidationEvidence?: {
    maxAge?: string;
  };
  providerHealth?: {
    minCorroboratingPrs?: number;
    samplingWindow?: string;
  };
  githubApi?: {
    telemetry?: {
      enabled?: boolean;
      maxRecords?: number;
      path?: string;
    };
    readCache?: {
      enabled?: boolean;
      maxAge?: string;
      maxBytes?: number;
      retention?: string;
      directory?: string;
    };
    loadControl?: {
      enabled?: boolean;
      maxConcurrent?: number;
      maxWait?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Top-level key lists (exported per the reconciliation contract).
// ---------------------------------------------------------------------------

export const advisoryConvergenceKeys = [
  'protocolVersion',
  'decisionAuthority',
  'prNumber',
  'prHeadSha',
  'now',
  'primaryBotLogin',
  'applicability',
  'review',
  'threads',
  'pending',
  'deadline',
  'waiver',
  'dispositionEvidence',
  'sameHeadReroll',
  'terminal',
  'converged',
  'waived',
  'ready',
  'reasons',
  'nextActions',
] as const satisfies readonly (keyof AdvisoryConvergenceVerdict)[];

export const advisoryWaitStateKeys = [
  'protocolVersion',
  'prHeadSha',
  'lastCopilotCommit',
  'copilotPending',
  'copilotPendingCoversHead',
  'outcome',
  'f3Outcome',
  'secondaryBotLogin',
  'secondaryBotLogins',
  'secondaryRequestLogins',
  'secondaryRequestNeeded',
  'now',
  'requestCap',
  'pendingWindowMinutes',
  'settledWindowMinutes',
  'pollIntervalMinutes',
  'capExhaustedRoute',
  'elapsedMinutes',
  'sameHeadMarkerPresent',
  'sameHeadRequestMarkerPresent',
  'earliestSameHeadAt',
  'sameHeadMarkerCount',
  'requestMarkerCount',
  'trustedMarkerSummary',
  'trustedMarkerActors',
  'trustedMarkerActorsSource',
  'copilotRecovery',
  'staleRequestRecovery',
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
  'baseAdvancedSinceMergeBase',
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

export const providerOutageDeclarationKeys = [
  'actor',
  'service',
  'startedAt',
  'expiresAt',
  'createdAt',
] as const satisfies readonly (keyof ParsedProviderOutageDeclaration)[];

export const providerOutageParkKeys = [
  'actor',
  'issueNumber',
  'service',
  'headSha',
  'claimId',
  'parkedAt',
  'blockers',
  'createdAt',
] as const satisfies readonly (keyof ParsedProviderOutagePark)[];

export const localValidationEvidenceKeys = [
  'actor',
  'headSha',
  'commandSet',
  'covers',
  'outcome',
  'createdAt',
] as const satisfies readonly (keyof ParsedLocalValidationEvidence)[];

export const discoverRoadmapUnionKeys = [
  'mode',
  'roots',
  'leaves',
  'diagnostics',
  'summary',
  'cache',
] as const satisfies readonly (keyof RoadmapGraphUnionReport)[];

export const discoverRoadmapIncompleteKeys = [
  'mode',
  'status',
  'incomplete',
  'cache',
] as const satisfies readonly (keyof DiscoverIncompleteReport)[];

export const iddMergeExecuteKeys = [
  'protocolVersion',
  'decisionAuthority',
  'mode',
  'prNumber',
  'prHeadSha',
  'ready',
  'blockers',
  'mergeCommand',
  'merged',
  'mergeResult',
  'adminFallbackUsed',
  'localHeadDrift',
  'postFailureState',
] as const satisfies readonly (keyof IddMergeExecuteVerdict)[];

export const iddRoadmapAuditExecuteKeys = [
  'protocolVersion',
  'decisionAuthority',
  'mode',
  'roadmapNumber',
  'ready',
  'blockers',
  'evidenceBody',
  'closed',
  'claimReleased',
  'result',
  'viewerLoginUnavailable',
  'localCoordinationNote',
] as const satisfies readonly (keyof IddRoadmapAuditExecuteVerdict)[];

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

export const issueAuthoringReviewInputKeys = [
  'title',
  'body',
  'packet',
] as const satisfies readonly (keyof IssueAuthoringReviewInput)[];

export const onboardingHearingCatalogKeys = [
  'version',
  'items',
] as const satisfies readonly (keyof OnboardingHearingCatalog)[];

export const onboardingHearingTranscriptKeys = [
  'version',
  'confirmedAt',
  'answers',
] as const satisfies readonly (keyof OnboardingHearingTranscript)[];

export const tokenCostSampleKeys = [
  'schemaVersion',
  'kind',
  'vendor',
  'model',
  'attribution',
  'outcome',
  'usage',
  'compactionCount',
  'startedAt',
  'endedAt',
  'vendorSessionId',
  'issueNumber',
  'stages',
  'claimId',
  'prNumber',
  'effort',
  'toolCallCount',
  'turnCount',
  'includesSubagents',
  'ambiguous',
] as const satisfies readonly (keyof TokenCostSample)[];

export const tokenCostEventKeys = [
  'schemaVersion',
  'event',
  'stageId',
  'at',
  'vendor',
  'vendorSessionId',
  'claimId',
  'issueNumber',
  'usage',
] as const satisfies readonly (keyof TokenCostEvent)[];

export const tokenCostSnapshotKeys = [
  'schemaVersion',
  'generatedAt',
  'minPublishableSamples',
  'minPublishableVendors',
  'publishable',
  'sampleCount',
  'vendors',
  'asOf',
  'totalUsage',
  'turnCount',
  'toolCallCount',
  'stageUsage',
  'compactionCount',
  'cacheHitRatio',
  'successRateByModel',
  'successRateByVendor',
] as const satisfies readonly (keyof TokenCostSnapshot)[];

export const policyConfigKeys = [
  '$schema',
  'iddVersion',
  'markerPrefix',
  'developmentBranch',
  'provider',
  'mergePolicy',
  'mergePolicyAck',
  'reviewPolicy',
  'threadResolutionPolicy',
  'authoringLanguage',
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
  'advisoryConvergence',
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
  'upstreamEscalation',
  'labels',
  'mergeGate',
  'providerOutage',
  'localValidationEvidence',
  'providerHealth',
  'githubApi',
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
  'secondaryQuietWindow',
  'threads',
  'unrepliedComments',
  'reviewerStates',
  'advisoryWait',
  'ci',
  'claim',
  'dispositionEvidence',
  'waiverEvidence',
  'advisoryConvergenceWaiverPrecondition',
  'claimIdentityInstalledAt',
  'staleSelfWaiver',
  'branchCurrency',
  'trustedMarkerActors',
  'trustedMarkerActorsSource',
  'localValidationEvidence',
  'developmentBranchTarget',
  'closingSet',
  'deferFollowUps',
  'ready',
  'blockers',
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

export const providerHealthKeys = [
  'protocolVersion',
  'now',
  'services',
] as const satisfies readonly (keyof ProviderHealthReport)[];

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness witnesses.
//
// Resolves to `true` only when `Covered` exhausts `keyof T`; assigning
// `true` below therefore fails `pnpm run typecheck` the moment a key is
// added to an exported type without being added to the key list.
// ---------------------------------------------------------------------------

type CoversAllKeysOf<T, Covered extends PropertyKey> =
  Exclude<keyof T, Covered> extends never ? true : false;

const exhaustivenessWitnesses: {
  advisoryWaitState: CoversAllKeysOf<
    AdvisoryWaitStateReport,
    (typeof advisoryWaitStateKeys)[number]
  >;
  branchConflictState: CoversAllKeysOf<
    BranchConflictResult,
    (typeof branchConflictStateKeys)[number]
  >;
  providerHealth: CoversAllKeysOf<
    ProviderHealthReport,
    (typeof providerHealthKeys)[number]
  >;
  claimMarker: CoversAllKeysOf<
    ParsedClaimMarker,
    (typeof claimMarkerKeys)[number]
  >;
  discoverRoadmapUnion: CoversAllKeysOf<
    RoadmapGraphUnionReport,
    (typeof discoverRoadmapUnionKeys)[number]
  >;
  discoverRoadmapIncomplete: CoversAllKeysOf<
    DiscoverIncompleteReport,
    (typeof discoverRoadmapIncompleteKeys)[number]
  >;
  forcedHandoffMarker: CoversAllKeysOf<
    ParsedForcedHandoffMarker,
    (typeof forcedHandoffMarkerKeys)[number]
  >;
  iddMergeExecute: CoversAllKeysOf<
    IddMergeExecuteVerdict,
    (typeof iddMergeExecuteKeys)[number]
  >;
  iddRoadmapAuditExecute: CoversAllKeysOf<
    IddRoadmapAuditExecuteVerdict,
    (typeof iddRoadmapAuditExecuteKeys)[number]
  >;
  liveStatusDigest: CoversAllKeysOf<
    LiveStatusDigestFields,
    (typeof liveStatusDigestKeys)[number]
  >;
  phaseGraph: CoversAllKeysOf<
    PhaseGraphDocument,
    (typeof phaseGraphKeys)[number]
  >;
  issueAuthoringReviewInput: CoversAllKeysOf<
    IssueAuthoringReviewInput,
    (typeof issueAuthoringReviewInputKeys)[number]
  >;
  onboardingHearingCatalog: CoversAllKeysOf<
    OnboardingHearingCatalog,
    (typeof onboardingHearingCatalogKeys)[number]
  >;
  onboardingHearingTranscript: CoversAllKeysOf<
    OnboardingHearingTranscript,
    (typeof onboardingHearingTranscriptKeys)[number]
  >;
  policyConfig: CoversAllKeysOf<
    PolicyConfigFile,
    (typeof policyConfigKeys)[number]
  >;
  stalledSessionQuietCheck: CoversAllKeysOf<
    StalledSessionQuietCheckReport,
    (typeof stalledSessionQuietCheckKeys)[number]
  >;
  tokenCostSample: CoversAllKeysOf<
    TokenCostSample,
    (typeof tokenCostSampleKeys)[number]
  >;
  tokenCostEvent: CoversAllKeysOf<
    TokenCostEvent,
    (typeof tokenCostEventKeys)[number]
  >;
  tokenCostSnapshot: CoversAllKeysOf<
    TokenCostSnapshot,
    (typeof tokenCostSnapshotKeys)[number]
  >;
} = {
  advisoryWaitState: true,
  branchConflictState: true,
  providerHealth: true,
  claimMarker: true,
  discoverRoadmapUnion: true,
  discoverRoadmapIncomplete: true,
  forcedHandoffMarker: true,
  iddMergeExecute: true,
  iddRoadmapAuditExecute: true,
  liveStatusDigest: true,
  phaseGraph: true,
  issueAuthoringReviewInput: true,
  onboardingHearingCatalog: true,
  onboardingHearingTranscript: true,
  policyConfig: true,
  stalledSessionQuietCheck: true,
  tokenCostSample: true,
  tokenCostEvent: true,
  tokenCostSnapshot: true,
};

// ---------------------------------------------------------------------------
// Canonical fixtures (compile-time side of the reconciliation).
// ---------------------------------------------------------------------------

const advisoryConvergenceFixture = {
  protocolVersion: '1',
  decisionAuthority: 'instructions',
  prNumber: 1340,
  prHeadSha: '0123456789abcdef0123456789abcdef01234567',
  now: '2026-07-11T12:00:00Z',
  primaryBotLogin: 'copilot',
  applicability: {
    scope: 'all-prs',
    status: 'applicable',
    reason: 'all-prs',
  },
  review: {
    found: true,
    reviewId: 'PRR_kwDOexample',
    commitId: '0123456789abcdef0123456789abcdef01234567',
    matchesHead: true,
    itemCount: 0,
    submittedAt: '2026-07-11T10:00:00Z',
    suppressedCount: 0,
    bodyShape: 'overview-v2',
    satisfied: true,
  },
  threads: {
    copilotThreadCount: 0,
    blockingIds: [],
    blockingCount: 0,
    satisfied: true,
  },
  pending: false,
  deadline: {
    minutes: 1440,
    headCommittedAt: '2026-07-11T09:00:00Z',
    headObservedAt: '2026-07-11T09:00:00Z',
    elapsedMinutes: 180,
    passed: false,
  },
  waiver: {
    mode: 'disabled',
    checkSelector: 'idd-advisory-convergence',
    activeClaimId: '',
    validCount: 0,
    outageRelieved: false,
    autoWaiverValid: false,
  },
  dispositionEvidence: {
    missingRegularCommentCount: 0,
    missingThreadCount: 0,
  },
  sameHeadReroll: {
    eligible: false,
    ineligibleReasons: ['review-item-count-not-positive'],
    count: 0,
    cap: 2,
    exhausted: false,
    latestAt: '',
    inFlight: false,
    requestable: false,
  },
  terminal: {
    cap: 2,
    completedCycleCount: 0,
    remainingBudget: 2,
    capExhausted: false,
    terminalWindowMinutes: 720,
    clockAnchor: '',
    elapsedMinutes: 0,
    windowElapsed: false,
    activeClaimProvided: false,
    state: 'NOT_TERMINAL',
    reason: 'active-claim-not-provided',
  },
  converged: true,
  waived: false,
  ready: true,
  reasons: [],
  nextActions: [],
} satisfies AdvisoryConvergenceVerdict;

const advisoryWaitStateFixture = {
  protocolVersion: '1',
  prHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  lastCopilotCommit: '',
  copilotPending: false,
  copilotPendingCoversHead: false,
  outcome: 'REQUEST_NEEDED',
  f3Outcome: 'SATISFIED',
  secondaryBotLogin: '',
  secondaryBotLogins: [],
  secondaryRequestLogins: [],
  secondaryRequestNeeded: false,
  now: '2026-06-11T17:00:00Z',
  requestCap: 30,
  pendingWindowMinutes: 30,
  settledWindowMinutes: 10,
  pollIntervalMinutes: 2,
  capExhaustedRoute: 'phase-specific',
  elapsedMinutes: 0,
  sameHeadMarkerPresent: false,
  sameHeadRequestMarkerPresent: false,
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
  copilotRecovery: {
    cap: 2,
    completedCycleCount: 0,
    remainingBudget: 2,
    capExhausted: false,
    terminalWindowMinutes: 720,
    clockAnchor: '',
    elapsedMinutes: 0,
    windowElapsed: false,
    activeClaimProvided: false,
    state: 'NOT_TERMINAL',
    reason: 'active-claim-not-provided',
  },
  staleRequestRecovery: {
    action: 'not-applicable',
    reason: 'not-pending',
  },
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
  baseAdvancedSinceMergeBase: false,
  readOnly: true,
  worktreeUnchanged: true,
  diagnostics: {
    mergeableSource: 'github-mergeable',
    conflictFiles: [],
    notes: [],
  },
} satisfies BranchConflictResult;

const providerHealthFixture = {
  protocolVersion: '1',
  now: '2026-09-01T00:00:00Z',
  services: {
    'advisory-review': {
      service: 'advisory-review',
      verdict: 'degraded',
      reason: 'failure-below-corroboration-threshold',
      distinctFailingPrCount: 1,
      distinctSuccessPrCount: 0,
      minCorroboratingPrs: 2,
    },
    'ci-actions': {
      service: 'ci-actions',
      verdict: 'healthy',
      reason: 'all-healthy',
      distinctFailingPrCount: 0,
      distinctSuccessPrCount: 3,
      minCorroboratingPrs: 2,
    },
  },
} satisfies ProviderHealthReport;

const claimMarkerFixture = {
  agentId: 'github-copilot-cli',
  claimId: 'claim-20260611T000000Z-874',
  supersedes: 'none',
  branch: 'issue/874-reconcile-schemas-json-exported',
  createdAt: '2026-06-11T00:00:00Z',
} satisfies ParsedClaimMarker;

const providerOutageDeclarationFixture = {
  actor: 'kurone-kito',
  service: 'idd-advisory-convergence',
  startedAt: '2026-09-01T05:00:00Z',
  expiresAt: '2026-09-02T05:00:00Z',
  createdAt: '2026-09-01T05:00:01Z',
} satisfies ParsedProviderOutageDeclaration;

const providerOutageParkFixture = {
  actor: 'claude-29738796',
  issueNumber: 2321,
  service: 'advisory-review',
  headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  claimId: 'f22dd6db-83f8-4e92-aaa9-23db47d10650',
  parkedAt: '2026-09-02T00:00:00Z',
  blockers: ['advisory-wait'],
  createdAt: '2026-09-02T00:00:05Z',
} satisfies ParsedProviderOutagePark;

const localValidationEvidenceFixture = {
  actor: 'kurone-kito',
  headSha: 'a'.repeat(40),
  commandSet: 'pre-push-validate',
  covers: ['idd-doctor', 'lint', 'pnpm-boundary'],
  outcome: 'pass',
  createdAt: '2026-09-01T05:00:01Z',
} satisfies ParsedLocalValidationEvidence;

const discoverRoadmapUnionFixture = {
  mode: 'all-roadmaps',
  roots: [
    {
      number: 100,
      title: 'roadmap 100',
      state: 'OPEN',
      roadmapMarkerId: 'epic-alpha',
    },
    {
      number: 200,
      title: 'roadmap 200',
      state: 'OPEN',
      roadmapMarkerId: 'epic-beta',
    },
  ],
  leaves: [
    {
      number: 101,
      title: 'scored leaf',
      state: 'OPEN',
      labels: [],
      classification: 'execution',
      roadmapMarkerId: '',
      autopilotSuitability: 5,
      effort: 'S',
      milestone: null,
      sourceRoots: [100],
    },
    {
      number: 201,
      title: 'shared unscored leaf',
      state: 'OPEN',
      labels: ['enhancement'],
      classification: 'execution',
      roadmapMarkerId: '',
      autopilotSuitability: null,
      effort: null,
      milestone: null,
      sourceRoots: [100, 200],
    },
  ],
  diagnostics: {
    duplicateReferences: [],
    cycles: [],
    inaccessibleReferences: [],
    unresolvedReferences: [],
  },
  summary: {
    rootCount: 2,
    leafCount: 2,
    scoredLeafCount: 1,
    sharedLeafCount: 1,
    duplicateReferenceCount: 0,
    cycleCount: 0,
    inaccessibleReferenceCount: 0,
    unresolvedReferenceCount: 0,
  },
  cache: {
    mode: 'hint',
    source: 'hint',
    ageMs: 60000,
    maxAgeMs: 300000,
    complete: true,
    enumerations: 0,
    exhaustionRefresh: false,
  },
} satisfies RoadmapGraphUnionReport;

const discoverRoadmapIncompleteFixture = {
  mode: 'all-roadmaps',
  status: 'incomplete',
  incomplete: {
    reason: 'rate-limit',
    phase: 'claim-state',
    lastCompletedPhase: 'traversal',
    counts: { unit: 'leaves', completed: 12, known: 19, leavesKnown: 19 },
    retryAt: '2026-10-01T03:15:00.000Z',
    retryAtSource: 'server',
    exhausted: false,
    recovery: {
      safeToRerun: true,
      sameArguments: true,
      notBefore: '2026-10-01T03:15:00.000Z',
      arguments: ['--all-roadmaps', '--with-claim-state', '--with-progress'],
    },
  },
  cache: {
    mode: 'off',
    source: 'live',
    ageMs: 0,
    maxAgeMs: 0,
    complete: false,
    enumerations: 1,
    exhaustionRefresh: false,
  },
} satisfies DiscoverIncompleteReport;

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

const iddMergeExecuteFixture = {
  protocolVersion: '1',
  decisionAuthority: 'instructions',
  mode: 'dry-run',
  prNumber: 994,
  prHeadSha: '0123456789abcdef0123456789abcdef01234567',
  ready: false,
  blockers: [
    {
      gate: 'advisory-wait',
      detail: 'f3Outcome is "WAIT" (expected "SATISFIED")',
    },
  ],
  mergeCommand:
    'gh pr merge 994 --merge --match-head-commit 0123456789abcdef0123456789abcdef01234567',
  merged: false,
  mergeResult: '',
  adminFallbackUsed: false,
  localHeadDrift: null,
} satisfies IddMergeExecuteVerdict;

const iddRoadmapAuditExecuteFixture = {
  protocolVersion: '1',
  decisionAuthority: 'instructions',
  mode: 'dry-run',
  roadmapNumber: 995,
  ready: false,
  blockers: [
    {
      kind: 'open-child',
      target: 1071,
      provenance: [995, 1071],
      detail: 'execution leaf #1071 is OPEN',
    },
  ],
  evidenceBody: '',
  closed: false,
  claimReleased: false,
  result: '',
} satisfies IddRoadmapAuditExecuteVerdict;

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

const issueAuthoringReviewInputFixture = {
  title:
    'docs(idd-workflow): document the user-global issue-authoring delegate',
  body: '## Background\n\nThe guide is inaccurate.\n\n## Acceptance criteria\n\n- The guide names the fragment.',
  packet: {
    goal: 'Keep the guide accurate about the user-global file.',
    constraints: ['Change no source file.'],
    evidence: ['src/scripts/idd-config.mts'],
    relationships: [],
    checklist: ['a concrete surface and an objective verification are named'],
  },
} satisfies IssueAuthoringReviewInput;

const onboardingHearingCatalogFixture = {
  version: '1.0.0',
  items: [
    {
      id: 'gh-cli',
      step: '0',
      kind: 'check',
      prompt: 'Is gh installed and authenticated?',
      explanation: 'IDD depends on the gh CLI.',
    },
  ],
} satisfies OnboardingHearingCatalog;

const onboardingHearingTranscriptFixture = {
  version: '1.0.0',
  confirmedAt: '2026-08-25T15:00:00Z',
  answers: [{ id: 'merge-policy', value: 'fully_autonomous_merge' }],
} satisfies OnboardingHearingTranscript;

const tokenCostSampleFixture = {
  schemaVersion: 1,
  kind: 'issue-loop',
  vendor: 'grok',
  model: 'grok-4.6',
  attribution: 'marker-join',
  outcome: 'merged',
  usage: {
    inputUncached: 1,
    cacheRead: 0,
    cacheCreation: 0,
    output: 1,
    reasoning: 0,
  },
  compactionCount: 0,
  startedAt: '2026-08-25T15:00:00Z',
  endedAt: '2026-08-25T16:00:00Z',
  vendorSessionId: 'sess',
  issueNumber: 2288,
  stages: [
    {
      id: 'work',
      usage: {
        inputUncached: 1,
        cacheRead: 0,
        cacheCreation: 0,
        output: 1,
        reasoning: 0,
      },
    },
  ],
} satisfies TokenCostSample;

const tokenCostEventFixture = {
  schemaVersion: 1,
  event: 'enter',
  stageId: 'work',
  at: '2026-08-25T15:10:00Z',
  vendor: 'claude',
} satisfies TokenCostEvent;

const tokenCostZeroPercentiles = { p25: 0, p50: 0, p75: 0 };
const tokenCostZeroUsagePercentiles = {
  inputUncached: tokenCostZeroPercentiles,
  cacheRead: tokenCostZeroPercentiles,
  cacheCreation: tokenCostZeroPercentiles,
  output: tokenCostZeroPercentiles,
  reasoning: tokenCostZeroPercentiles,
};

const tokenCostSnapshotFixture = {
  schemaVersion: 1,
  generatedAt: '2026-08-25T16:00:00Z',
  minPublishableSamples: 10,
  minPublishableVendors: 2,
  publishable: false,
  sampleCount: 0,
  vendors: [],
  asOf: '2026-08-25',
  totalUsage: tokenCostZeroUsagePercentiles,
  stageUsage: [],
  compactionCount: tokenCostZeroPercentiles,
  cacheHitRatio: 0,
  successRateByModel: {},
  successRateByVendor: {},
} satisfies TokenCostSnapshot;

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
    convergenceScope: 'all-prs',
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
    trustEmptyProtectionReads: true,
    trustSourcePinnedRequiredChecks: true,
  },
  discover: {
    activeClaimPreScanBatchSize: 10,
    selectionDesync: 'off',
    legacyRoots: [1234],
  },
  claim: { verifySettleDelay: 'PT5S' },
  critiqueLoop: {
    cPhaseLowSeveritySkipAfter: 3,
    e10NoProgressHoldAfter: 3,
    deferAfterRounds: 12,
    deferByUrgency: 'off',
    deferNeedsDecision: 'on',
    subagentWaitCeiling: 'PT20M',
  },
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
    heartbeatCoalesceWindow: 'PT2M',
    journalIssue: 'kurone-kito/idd-skill#2674',
  },
  autopilotSuitability: { floor: 3, enabled: true },
  worktreeGuard: {
    enabled: true,
    branchPatterns: ['issue/*', 'roadmap-audit/*'],
  },
  upstreamEscalation: { enabled: true },
  labels: {
    roadmapLabelName: 'roadmap',
    blockedByHumanLabelName: 'status:blocked-by-human',
    needsDecisionLabelName: 'status:needs-decision',
    untrustedLabelerLogins: ['triage-bot'],
  },
  mergeGate: { soloCodeownerAdminFallback: 'auto-admin-retry' },
  providerOutage: {
    declarationTarget: 1234,
    maxValidity: 'PT24H',
    maxParkedChanges: 10,
  },
  githubApi: {
    telemetry: {
      enabled: false,
      maxRecords: 100,
      path: '/var/tmp/idd-github-api-telemetry.jsonl',
    },
    readCache: {
      enabled: false,
      maxAge: 'PT5M',
      maxBytes: 104857600,
      retention: 'PT24H',
    },
    loadControl: {
      enabled: false,
      maxConcurrent: 1,
      maxWait: 'PT30S',
    },
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
  secondaryQuietWindow: {
    minutes: 0,
    configuredMinutes: 0,
    anchorAt: 'none',
    elapsedMinutes: null,
    elapsed: true,
    remainingMinutes: 0,
    declined: false,
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
      rulesetBypassUnreadable: false,
      prAuthorIsSoleEligibleCodeowner: false,
      codeownerEligibilityUnreadable: false,
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
    copilotUnavailable: false,
    copilotUnavailableWaived: false,
  },
  ci: {
    status: 'success',
    noRequiredChecksConfigured: false,
    protectionReadsUnreadable: false,
    presentRunConclusion: 'all-passing',
    requiredCheckCount: 1,
    generatedRequiredCheckCount: 1,
    requiredChecksGenerated: true,
    requiredChecksPassing: true,
    requiredCheckNames: ['lint'],
    missingRequiredCheckNames: [],
    discardedNonPassingRequiredChecks: [],
    sourcePinnedRequiredCheckNames: [],
    sourcePinnedUnresolved: false,
    identityUnresolvedRequiredCheckNames: [],
    nonTargetEventRequiredCheckNames: [],
    preDowngradeStatus: 'success',
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
    insufficientAuthority: [],
    malformed: [],
    notConfigured: [],
    modeDisabled: [],
    edited: [],
  },
  advisoryConvergenceWaiverPrecondition: {
    checkSelector: 'idd-advisory-convergence',
    deadlineMinutes: 1440,
    headCommittedAt: 'none',
    headObservedAt: 'none',
    elapsedMinutes: null,
    deadlinePassed: false,
    terminalUnavailable: false,
    open: false,
  },
  claimIdentityInstalledAt: '2026-05-11T23:20:00Z',
  staleSelfWaiver: {
    stale: false,
    checkSelector: 'idd-advisory-convergence',
    reason: null,
    expiresAt: '',
    waiverClaimId: '',
  },
  branchCurrency: {
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    requiresUpToDateHead: false,
    requiresUpToDateHeadSource: 'none',
  },
  closingSet: {
    status: 'match',
    expected: [309],
    actual: [309],
    extra: [],
    missing: [],
    strayCommitCloses: [],
  },
  trustedMarkerActors: ['copilot-cli'],
  trustedMarkerActorsSource: 'config',
  ready: true,
  blockers: [],
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

const dispositionNonReviewNoticesKeys = [
  'mode',
  'prNumber',
  'headSha',
  'planned',
  'status',
  'applied',
  'failed',
  'staleSkipped',
  'skipped',
] as const satisfies readonly (keyof DispositionReport)[];

const dispositionNonReviewNoticesFixture = {
  mode: 'apply',
  prNumber: 7,
  headSha: '0123456789abcdef0123456789abcdef01234567',
  planned: [],
  status: 'applied',
  applied: [{ noticeId: 1, commentId: 1000 }],
  failed: [],
  staleSkipped: [
    {
      noticeId: 3,
      botLogin: 'chatgpt-codex-connector[bot]',
      reason: 'codex-review-running-at-post-time',
    },
  ],
  skipped: [
    {
      noticeId: 2,
      botLogin: 'coderabbitai[bot]',
      reason: 'already-dispositioned',
    },
  ],
} satisfies DispositionReport;

const resolveReviewThreadKeys = [
  'mode',
  'prNumber',
  'commentId',
  'threadId',
  'alreadyResolved',
  'body',
  'status',
  'replyId',
  'error',
] as const satisfies readonly (keyof ResolveReviewThreadReport)[];

const resolveReviewThreadFixture = {
  mode: 'apply',
  prNumber: 7,
  commentId: 1001,
  threadId: 'thread-node-id',
  alreadyResolved: false,
  body: '**Accepted** — fixed in abc\n\n<!-- idd-skill-review-reply -->',
  status: 'applied',
  replyId: 4242,
} satisfies ResolveReviewThreadReport;

const postIddMarkerKeys = [
  'mode',
  'type',
  'target',
  'number',
  'body',
  'commentId',
  'url',
  'warnings',
  'operationLocal',
] as const satisfies readonly (keyof PostIddMarkerResult)[];

const postIddMarkerFixture = {
  mode: 'apply',
  type: 'claim',
  target: 'issue',
  number: 1047,
  commentId: 4800026123,
  url: 'https://github.com/kurone-kito/idd-skill/issues/1047#issuecomment-4800026123',
} satisfies PostIddMarkerResult;

const SCHEMA_TEST_DATA: Record<CatalogSchemaFile, SchemaTestData> = {
  'disposition-non-review-notices.schema.json': {
    keys: dispositionNonReviewNoticesKeys,
    fixture: dispositionNonReviewNoticesFixture,
  },
  'resolve-review-thread.schema.json': {
    keys: resolveReviewThreadKeys,
    fixture: resolveReviewThreadFixture,
  },
  'post-idd-marker.schema.json': {
    keys: postIddMarkerKeys,
    fixture: postIddMarkerFixture,
  },
  'advisory-convergence.schema.json': {
    keys: advisoryConvergenceKeys,
    fixture: advisoryConvergenceFixture,
  },
  'advisory-wait-state.schema.json': {
    keys: advisoryWaitStateKeys,
    fixture: advisoryWaitStateFixture,
  },
  'branch-conflict-state.schema.json': {
    keys: branchConflictStateKeys,
    fixture: branchConflictStateFixture,
  },
  'provider-health.schema.json': {
    keys: providerHealthKeys,
    fixture: providerHealthFixture,
  },
  'claim-marker.schema.json': {
    keys: claimMarkerKeys,
    fixture: claimMarkerFixture,
  },
  'provider-outage-declaration.schema.json': {
    keys: providerOutageDeclarationKeys,
    fixture: providerOutageDeclarationFixture,
  },
  'provider-outage-park.schema.json': {
    keys: providerOutageParkKeys,
    fixture: providerOutageParkFixture,
  },
  'local-validation-evidence.schema.json': {
    keys: localValidationEvidenceKeys,
    fixture: localValidationEvidenceFixture,
  },
  'token-cost-event.schema.json': {
    keys: tokenCostEventKeys,
    fixture: tokenCostEventFixture,
  },
  'token-cost-sample.schema.json': {
    keys: tokenCostSampleKeys,
    fixture: tokenCostSampleFixture,
  },
  'token-cost-snapshot.schema.json': {
    keys: tokenCostSnapshotKeys,
    fixture: tokenCostSnapshotFixture,
  },
  'discover-roadmap-union.schema.json': {
    keys: discoverRoadmapUnionKeys,
    fixture: discoverRoadmapUnionFixture,
  },
  'discover-roadmap-incomplete.schema.json': {
    keys: discoverRoadmapIncompleteKeys,
    fixture: discoverRoadmapIncompleteFixture,
  },
  'forced-handoff-marker.schema.json': {
    keys: forcedHandoffMarkerKeys,
    fixture: forcedHandoffMarkerFixture,
  },
  'idd-merge-execute.schema.json': {
    keys: iddMergeExecuteKeys,
    fixture: iddMergeExecuteFixture,
  },
  'idd-roadmap-audit-execute.schema.json': {
    keys: iddRoadmapAuditExecuteKeys,
    fixture: iddRoadmapAuditExecuteFixture,
  },
  'live-status-digest.schema.json': {
    keys: liveStatusDigestKeys,
    fixture: liveStatusDigestFixture,
  },
  'phase-graph.schema.json': {
    keys: phaseGraphKeys,
    fixture: phaseGraphFixture,
  },
  'issue-authoring-review-input.schema.json': {
    keys: issueAuthoringReviewInputKeys,
    fixture: issueAuthoringReviewInputFixture,
  },
  'onboarding-hearing-catalog.schema.json': {
    keys: onboardingHearingCatalogKeys,
    fixture: onboardingHearingCatalogFixture,
  },
  'onboarding-hearing-transcript.schema.json': {
    keys: onboardingHearingTranscriptKeys,
    fixture: onboardingHearingTranscriptFixture,
  },
  'policy.schema.json': {
    keys: policyConfigKeys,
    fixture: policyConfigFixture,
  },
  'pre-merge-readiness.schema.json': {
    keys: preMergeReadinessKeys,
    fixture: preMergeReadinessFixture,
  },
  'stalled-session-quiet-check.schema.json': {
    keys: stalledSessionQuietCheckKeys,
    fixture: stalledSessionQuietCheckFixture,
  },
};

/**
 * The catalog row (schema file, exported type, owning module) joined with this
 * file's test-only data. The catalog lives in the production audit module so
 * the repository audit never imports a test.
 */
const SCHEMA_TYPE_MAP: readonly SchemaTypeMapping[] = SCHEMA_TYPE_CATALOG.map(
  (entry) => ({ ...entry, ...SCHEMA_TEST_DATA[entry.schemaFile] }),
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function loadSchema(entry: SchemaTypeMapping): SchemaObject {
  return loadJson(`schemas/${entry.schemaFile}`) as SchemaObject;
}

// ---------------------------------------------------------------------------
// Catalog join — the audit owns the live directory sweep.
// ---------------------------------------------------------------------------

// SCHEMA-TYPE-CATALOG in scripts/repository-schema-audit.mjs (#3751) fails when
// a schemas/*.schema.json file is unmapped, a mapped file is missing or
// duplicated, or schemas/ holds a stray non-schema file. What stays here is the
// join between that catalog and this file's test-only data.

test('every catalog schema file has test data and no test data is stale', () => {
  assert.deepEqual(
    Object.keys(SCHEMA_TEST_DATA).sort(),
    SCHEMA_TYPE_CATALOG.map((entry) => entry.schemaFile).sort(),
    'SCHEMA_TEST_DATA and SCHEMA_TYPE_CATALOG must name the same schema files',
  );
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
    const errors = [...validate(entry.fixture, loadSchema(entry))].sort();
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
