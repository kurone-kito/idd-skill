// idd-generated-from: src/scripts/policy-helpers.mts
//
// The scripts/policy-helpers.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

type EnumSet = ReadonlySet<string>;

interface CheckSelector {
  selector: string;
  matchMode: string;
}

interface RawForcedHandoff {
  mode?: unknown;
  authorityPolicy?: unknown;
}

export interface CritiqueLoopDelegate {
  command: string;
  mode: 'fallback' | 'combined' | 'on-success' | 'never';
}

interface CritiqueLoopPolicy {
  cPhaseLowSeveritySkipAfter: number;
  e10NoProgressHoldAfter: number;
  delegate?: CritiqueLoopDelegate;
}

/**
 * `declarationTarget` is intentionally optional and undefined by default
 * (#2320): its absence disables the outage-relief declaration path
 * entirely, mirroring how `critiqueLoop.delegate` above stays an own-
 * property-omitted key rather than a always-present field with a
 * meaningless default.
 */
interface ProviderOutagePolicy {
  declarationTarget?: number;
  maxValidity: string;
}

/**
 * #2323: how long a `idd-local-validation-evidence` marker stays readable
 * as fresh evidence, measured from the marker comment's own GitHub
 * `created_at` (never an embedded timestamp) -- mirrors `maxValidity`
 * above.
 */
interface LocalValidationEvidencePolicy {
  maxAge: string;
}

/** How one policy document presents `critiqueLoop.delegate`. */
export type CritiqueLoopDelegateLayerStatus =
  | 'absent'
  | 'disabled'
  | 'configured'
  | 'malformed';

export interface CritiqueLoopDelegateLayer {
  status: CritiqueLoopDelegateLayerStatus;
  delegate?: CritiqueLoopDelegate;
  reason?: string;
}

/**
 * Outcome of layered C1 delegate resolution. `local-malformed` is
 * fail-closed: a bad repository-local `delegate` must not inherit a
 * user-global object.
 */
export type EffectiveCritiqueLoopDelegateStatus =
  | 'local'
  | 'disabled'
  | 'global'
  | 'none'
  | 'local-malformed';

export type CritiqueLoopDelegateSource =
  | 'repository-local'
  | 'user-global'
  | 'none';

export interface EffectiveCritiqueLoopDelegate {
  status: EffectiveCritiqueLoopDelegateStatus;
  source: CritiqueLoopDelegateSource;
  delegate?: CritiqueLoopDelegate;
  reason?: string;
}

// Structural view of the untrusted config object parsed from an
// adopter-controlled JSON file. Every field is optional and weakly
// typed; the runtime guards below perform the real validation.
interface RawConfig {
  issueScope?: unknown;
  orphanFirstPolicy?: unknown;
  skipIssueAuthorApprovalGate?: unknown;
  maintainerApprovalActorPolicy?: unknown;
  stallRecovery?: { quietWindow?: unknown };
  claimTiming?: { staleAge?: unknown };
  forcedHandoff?: RawForcedHandoff;
  'forced-handoff'?: RawForcedHandoff;
  forcedHandoffAuthority?: unknown;
  'forced-handoff-authority'?: unknown;
  forcedHandoffMode?: unknown;
  'forced-handoff-mode'?: unknown;
  markerTrust?: { allowCollaboratorMarkers?: unknown };
  markerTrustAllowCollaboratorMarkers?: unknown;
  allowCollaboratorMarkers?: unknown;
  advisoryWait?: {
    requestCap?: unknown;
    pendingWindow?: unknown;
    settledWindow?: unknown;
    pollInterval?: unknown;
    capExhaustedRoute?: unknown;
    convergenceScope?: unknown;
    exemptBotAuthoredPrs?: unknown;
  };
  ciWait?: {
    runningTimeout?: unknown;
    generationTimeout?: unknown;
    rerunPolicy?: unknown;
  };
  ciGate?: {
    externalChecks?: { advisory?: unknown; waivable?: unknown };
    externalCheckWaivers?: {
      mode?: unknown;
      authorityPolicy?: unknown;
      maxValidity?: unknown;
    };
    trustEmptyProtectionReads?: unknown;
    trustSourcePinnedRequiredChecks?: unknown;
  };
  discover?: {
    activeClaimPreScanBatchSize?: unknown;
    selectionDesync?: unknown;
    legacyRoots?: unknown;
    milestoneScope?: unknown;
  };
  claim?: { verifySettleDelay?: unknown };
  critiqueLoop?: {
    cPhaseLowSeveritySkipAfter?: unknown;
    e10NoProgressHoldAfter?: unknown;
    delegate?: { command?: unknown; mode?: unknown };
  };
  reviewEscalation?: {
    changesRequestedFirstEscalation?: unknown;
    changesRequestedSecondEscalation?: unknown;
  };
  approvalSignals?: { readyLabelName?: unknown; labelFreshnessMode?: unknown };
  issueAuthoring?: {
    maxClarificationRounds?: unknown;
    authoringLabelName?: unknown;
    authoringStaleAge?: unknown;
  };
  labels?: {
    roadmapLabelName?: unknown;
    blockedByHumanLabelName?: unknown;
    needsDecisionLabelName?: unknown;
  };
  mergeGate?: { soloCodeownerAdminFallback?: unknown };
  providerOutage?: { declarationTarget?: unknown; maxValidity?: unknown };
  localValidationEvidence?: { maxAge?: unknown };
}

const HELPER_RUNTIME_PROFILES = new Set([
  'package-manager',
  'vendored-node',
  'ephemeral-npx',
  'instructions-only',
]);
const HELPER_RUNTIME_KEYS = new Set(['profile', 'packageSpec']);
const ISSUE_SCOPES = new Set(['roadmap', 'roadmap-first', 'orphan-first']);
const ORPHAN_FIRST_POLICIES = new Set([
  'none',
  'maintainer-approved',
  'public-disabled',
]);
const APPROVAL_ACTOR_POLICIES = new Set([
  'owners-and-maintainers-only',
  'all-write-permission-actors',
]);
const FORCED_HANDOFF_MODES = new Set(['disabled', 'human-gated']);
const ADVISORY_CAP_ROUTES = new Set(['phase-specific', 'hold']);
const ADVISORY_CONVERGENCE_SCOPES = new Set(['all-prs', 'idd-claimed']);
const SELECTION_DESYNC_MODES = new Set(['off', 'session-offset']);
const EXTERNAL_CHECK_WAIVER_MODES = new Set([
  'disabled',
  'maintainer-authorized',
]);
const CHECK_SELECTOR_MATCH_MODES = new Set(['exact', 'glob']);
const CRITIQUE_LOOP_DELEGATE_MODES = new Set([
  'fallback',
  'combined',
  'on-success',
  'never',
]);
const LEGACY_ADVISORY_CAP_ROUTE_ALIASES = new Map([
  ['phase-default', 'phase-specific'],
  ['strict-hold', 'hold'],
]);
// Matches the schema enum and ci-wait-policy.mts's own RERUN_POLICIES set
// (both accept `hold`); this set previously omitted it, silently
// downgrading a configured `hold` to `rerun-once` for any future consumer
// of normalizePolicyConfig(...).ciWait (see #1359).
const CI_RERUN_POLICIES = new Set(['rerun-once', 'hold']);
const LABEL_FRESHNESS_MODES = new Set(['presence-only', 'event-freshness']);
// #1521: `auto-admin-retry` is the distributed default (F3 retries once with
// `--admin` when the Gate checklist is fully green, the only merge-command
// failure is the self-CODEOWNER "base branch policy prohibits the merge"
// error, and the topology fact proves the PR author is the sole eligible
// codeowner). `hold-and-report` opts a repository into the pre-#1521
// unconditional hold-and-report behavior instead.
const MERGE_GATE_SOLO_CODEOWNER_ADMIN_FALLBACK_MODES = new Set([
  'auto-admin-retry',
  'hold-and-report',
]);
const ISO_DURATION_RE =
  /^P(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
const ADVISORY_WHOLE_MINUTE_DURATION_RE =
  /^P(?=(?:\d+D|T\d+[HM]))(?=.*(?:[1-9]\d*[DHM]))(?:\d+D)?(?:T(?=\d+[HM])(?:\d+H)?(?:\d+M)?)?$/;
const DURATION_RE =
  /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?)?$/;
// Mirrors schemas/policy.schema.json's helperRuntime.packageSpec pattern: a
// non-empty, shell-safe character allowlist (letters, digits, and
// `@:/_.+^#%-`), not merely "no whitespace" (idd-skill#1803 review). The
// value is embedded raw and unquoted into copy-pasteable shell command
// text (`npx --package <spec> ...`, `<manager> add <spec>`) -- a bare
// whitespace check still lets shell metacharacters (`;`, `&`, `|`, `$`,
// backticks, quotes, parens) through, which can corrupt or inject into
// that command when an operator copies it. The allowlist covers realistic
// npm specs (`@scope/name@version`, `github:owner/repo#ref`), HTTPS/git+
// URLs, and tarball paths while excluding every shell metacharacter in
// that list.
const PACKAGE_SPEC_RE = /^[A-Za-z0-9@:/_.+^#%-]+$/;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const POLICY_DEFAULTS = Object.freeze({
  issueScope: 'roadmap-first',
  orphanFirstPolicy: 'none',
  skipIssueAuthorApprovalGate: false,
  maintainerApprovalActorPolicy: 'owners-and-maintainers-only',
  stallRecovery: Object.freeze({
    quietWindow: 'PT30M',
  }),
  // The write-gate claim-staleness window (#1310). isStaleAt's hardcoded 24h
  // literal remains the fallback baked into protocol-helpers.mts; this is the
  // one canonical config parse point every write-gate caller should read
  // instead of hand-rolling `config?.claimTiming?.staleAge` access.
  claimTiming: Object.freeze({
    staleAge: 'PT24H',
  }),
  forcedHandoff: Object.freeze({
    mode: 'disabled',
    authorityPolicy: 'owners-and-maintainers-only',
  }),
  markerTrust: Object.freeze({
    allowCollaboratorMarkers: false,
  }),
  advisoryWait: Object.freeze({
    requestCap: 30,
    pendingWindow: 'PT30M',
    settledWindow: 'PT10M',
    pollInterval: 'PT2M',
    capExhaustedRoute: 'phase-specific',
    convergenceScope: 'all-prs',
    // #1906: opt-in, off by default -- no behavior change for a
    // repository that does not explicitly set this to `true`.
    exemptBotAuthoredPrs: false,
  }),
  ciWait: Object.freeze({
    runningTimeout: 'PT30M',
    generationTimeout: 'PT10M',
    rerunPolicy: 'rerun-once',
  }),
  ciGate: Object.freeze({
    externalChecks: Object.freeze({
      advisory: Object.freeze([]),
      waivable: Object.freeze([]),
    }),
    externalCheckWaivers: Object.freeze({
      mode: 'disabled',
      authorityPolicy: 'owners-and-maintainers-only',
      maxValidity: 'PT24H',
    }),
    // #1377: default false fails closed on a masked-403-as-404 branch-
    // protection/ruleset read instead of trusting it as genuinely empty.
    trustEmptyProtectionReads: false,
    // #1689: default false fails closed on a required check whose ruleset
    // entry carries an `app_id`/`integration_id` (source-pinned) -- this
    // repository has no way to verify the live check-run instance actually
    // came from that pinned integration (see the option's own doc comment
    // on `summarizeRequiredChecks` in protocol-helpers.mts), so a pinned
    // check's green state stays untrusted by default rather than silently
    // treated as passing.
    trustSourcePinnedRequiredChecks: false,
  }),
  discover: Object.freeze({
    activeClaimPreScanBatchSize: 10,
    selectionDesync: 'off',
    legacyRoots: Object.freeze([]),
    // Empty string is the off state: A4 Step 2's milestone preference is
    // disabled and ranking is unchanged, matching an absent key.
    milestoneScope: '',
  }),
  claim: Object.freeze({
    verifySettleDelay: 'PT5S',
  }),
  // Cast (not a literal `delegate` field) so this shares one declared type
  // with the resolver's `critiqueLoop` below -- without it, TypeScript
  // infers a two-branch union across normalizePolicyConfig's early
  // `clone(POLICY_DEFAULTS)` return and its main return, and rejects
  // `.critiqueLoop.delegate` on every caller. The runtime object still has
  // no `delegate` key at all -- see the clone() doc comment's invariant.
  critiqueLoop: Object.freeze({
    cPhaseLowSeveritySkipAfter: 3,
    e10NoProgressHoldAfter: 3,
  }) as Readonly<CritiqueLoopPolicy>,
  reviewEscalation: Object.freeze({
    changesRequestedFirstEscalation: 'PT24H',
    changesRequestedSecondEscalation: 'PT48H',
  }),
  approvalSignals: Object.freeze({
    readyLabelName: 'idd:ready',
    labelFreshnessMode: 'presence-only',
  }),
  issueAuthoring: Object.freeze({
    maxClarificationRounds: 3,
    authoringLabelName: 'status:authoring',
    authoringStaleAge: 'PT4H',
  }),
  // Added in #1272; the discover-roadmap-graph, discover-orphan-filter,
  // discover-readiness-check, idd-roadmap-audit-execute,
  // suitability-triage, and idd-doctor label lookups were wired to this
  // namespace in #1273.
  labels: Object.freeze({
    roadmapLabelName: 'roadmap',
    blockedByHumanLabelName: 'status:blocked-by-human',
    needsDecisionLabelName: 'status:needs-decision',
  }),
  // Added in #1521 (solo-CODEOWNER autonomous `--admin` merge fallback).
  mergeGate: Object.freeze({
    soloCodeownerAdminFallback: 'auto-admin-retry',
  }),
  // Added in #2320. `declarationTarget` cast the same way as
  // `critiqueLoop.delegate` above -- see that field's comment; the runtime
  // object carries no `declarationTarget` key at all until configured.
  providerOutage: Object.freeze({
    maxValidity: 'PT24H',
  }) as Readonly<ProviderOutagePolicy>,
  // Added in #2323. Deliberately shorter than providerOutage.maxValidity
  // (PT24H): a local validation run only stays representative of the
  // working tree for a bounded window, not the whole outage window.
  localValidationEvidence: Object.freeze({
    maxAge: 'PT4H',
  }) as Readonly<LocalValidationEvidencePolicy>,
});

export function parseProjectCommandRows(text: string): Map<string, string> {
  const commands = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (!match) {
      continue;
    }
    commands.set(match[1].trim(), match[2].trim());
  }
  return commands;
}

export function inspectHelperRuntimeConfig(
  config: unknown,
):
  | { status: 'invalid'; reason: string }
  | { status: 'absent' }
  | { status: 'ok'; profile: string; packageSpec?: string } {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { status: 'invalid', reason: 'config must be a non-null object' };
  }

  if (!hasOwn(config, 'helperRuntime')) {
    return { status: 'absent' };
  }

  const helperRuntime = (config as { helperRuntime?: unknown }).helperRuntime;
  if (
    typeof helperRuntime !== 'object' ||
    helperRuntime === null ||
    Array.isArray(helperRuntime)
  ) {
    return {
      status: 'invalid',
      reason: 'helperRuntime must be an object when present',
    };
  }

  const unexpectedKeys = Object.keys(helperRuntime).filter(
    (key) => !HELPER_RUNTIME_KEYS.has(key),
  );
  if (unexpectedKeys.length > 0) {
    return {
      status: 'invalid',
      reason: `unsupported helperRuntime keys: ${unexpectedKeys.join(', ')}`,
    };
  }

  const profile = (helperRuntime as { profile?: unknown }).profile;
  if (typeof profile !== 'string' || profile.length === 0) {
    return {
      status: 'invalid',
      reason: 'helperRuntime.profile must be a non-empty string',
    };
  }

  if (!HELPER_RUNTIME_PROFILES.has(profile)) {
    return {
      status: 'invalid',
      reason: `unsupported helperRuntime.profile "${profile}"`,
    };
  }

  // Optional: absent by default (existing behavior, existing profile-only
  // callers/tests are unaffected). When present, it must be a non-empty
  // string in the shell-safe character allowlist -- mirrors
  // schemas/policy.schema.json's pattern so the JSON Schema validator and
  // this runtime guard never disagree.
  if (hasOwn(helperRuntime, 'packageSpec')) {
    const packageSpec = (helperRuntime as { packageSpec?: unknown })
      .packageSpec;
    if (typeof packageSpec !== 'string' || !PACKAGE_SPEC_RE.test(packageSpec)) {
      return {
        status: 'invalid',
        reason:
          'helperRuntime.packageSpec must be a non-empty string using only shell-safe characters (letters, digits, and @:/_.+^#%-)',
      };
    }
    return { status: 'ok', profile, packageSpec };
  }

  return { status: 'ok', profile };
}

export function normalizePolicyConfig(config: unknown) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return clone(POLICY_DEFAULTS);
  }

  const c = config as RawConfig;

  const forcedHandoffAuthorityAlias = firstAcceptedString(
    APPROVAL_ACTOR_POLICIES,
    c?.forcedHandoff?.authorityPolicy,
    c?.['forced-handoff']?.authorityPolicy,
    c?.forcedHandoffAuthority,
    c?.['forced-handoff-authority'],
  );
  const forcedHandoffModeAlias = firstAcceptedString(
    FORCED_HANDOFF_MODES,
    c?.forcedHandoff?.mode,
    c?.['forced-handoff']?.mode,
    c?.forcedHandoffMode,
    c?.['forced-handoff-mode'],
  );
  const markerTrustAlias = firstBoolean(
    c?.markerTrust?.allowCollaboratorMarkers,
    c?.markerTrustAllowCollaboratorMarkers,
    c?.allowCollaboratorMarkers,
  );
  const critiqueLoopDelegate = parseCritiqueLoopDelegate(
    c?.critiqueLoop?.delegate,
  );
  // Explicitly typed so the optional `delegate` key is part of one stable
  // object type rather than a conditional-spread union TypeScript can't
  // narrow -- see the Own-property-omitted comment below for why the key
  // itself is conditionally present.
  const critiqueLoop: CritiqueLoopPolicy = {
    cPhaseLowSeveritySkipAfter: parsePositiveInteger(
      c?.critiqueLoop?.cPhaseLowSeveritySkipAfter,
      POLICY_DEFAULTS.critiqueLoop.cPhaseLowSeveritySkipAfter,
    ),
    e10NoProgressHoldAfter: parsePositiveInteger(
      c?.critiqueLoop?.e10NoProgressHoldAfter,
      POLICY_DEFAULTS.critiqueLoop.e10NoProgressHoldAfter,
    ),
  };
  // Own-property omitted (not set to `undefined`) when no delegate is
  // configured, matching POLICY_DEFAULTS -- see the clone() doc comment on
  // why POLICY_DEFAULTS itself never carries an undefined-valued key.
  if (critiqueLoopDelegate) {
    critiqueLoop.delegate = critiqueLoopDelegate;
  }
  // #2320: `declarationTarget` is a positive integer issue number, or
  // absent -- absence disables the outage-relief declaration path
  // entirely rather than falling back to some issue number. Same
  // own-property-omitted shape as `critiqueLoop.delegate` above.
  const rawDeclarationTarget = c?.providerOutage?.declarationTarget;
  const providerOutage: ProviderOutagePolicy = {
    maxValidity: parsePositiveDuration(
      c?.providerOutage?.maxValidity,
      POLICY_DEFAULTS.providerOutage.maxValidity,
    ),
  };
  if (
    typeof rawDeclarationTarget === 'number' &&
    Number.isInteger(rawDeclarationTarget) &&
    rawDeclarationTarget >= 1
  ) {
    providerOutage.declarationTarget = rawDeclarationTarget;
  }
  const localValidationEvidence: LocalValidationEvidencePolicy = {
    maxAge: parsePositiveDuration(
      c?.localValidationEvidence?.maxAge,
      POLICY_DEFAULTS.localValidationEvidence.maxAge,
    ),
  };

  return {
    issueScope: parseEnum(
      c?.issueScope,
      ISSUE_SCOPES,
      POLICY_DEFAULTS.issueScope,
    ),
    orphanFirstPolicy: parseEnum(
      c?.orphanFirstPolicy,
      ORPHAN_FIRST_POLICIES,
      POLICY_DEFAULTS.orphanFirstPolicy,
    ),
    skipIssueAuthorApprovalGate: c?.skipIssueAuthorApprovalGate === true,
    maintainerApprovalActorPolicy: parseEnum(
      c?.maintainerApprovalActorPolicy,
      APPROVAL_ACTOR_POLICIES,
      POLICY_DEFAULTS.maintainerApprovalActorPolicy,
    ),
    stallRecovery: {
      quietWindow: parseDuration(
        c?.stallRecovery?.quietWindow,
        POLICY_DEFAULTS.stallRecovery.quietWindow,
      ),
    },
    claimTiming: {
      staleAge: parsePositiveDuration(
        c?.claimTiming?.staleAge,
        POLICY_DEFAULTS.claimTiming.staleAge,
      ),
    },
    forcedHandoff: {
      mode: parseEnum(
        forcedHandoffModeAlias,
        FORCED_HANDOFF_MODES,
        POLICY_DEFAULTS.forcedHandoff.mode,
      ),
      authorityPolicy: parseEnum(
        forcedHandoffAuthorityAlias,
        APPROVAL_ACTOR_POLICIES,
        POLICY_DEFAULTS.forcedHandoff.authorityPolicy,
      ),
    },
    markerTrust: {
      allowCollaboratorMarkers:
        markerTrustAlias ??
        POLICY_DEFAULTS.markerTrust.allowCollaboratorMarkers,
    },
    advisoryWait: {
      requestCap: parsePositiveInteger(
        c?.advisoryWait?.requestCap,
        POLICY_DEFAULTS.advisoryWait.requestCap,
      ),
      pendingWindow: parseAdvisoryWholeMinuteDuration(
        c?.advisoryWait?.pendingWindow,
        POLICY_DEFAULTS.advisoryWait.pendingWindow,
      ),
      settledWindow: parseAdvisoryWholeMinuteDuration(
        c?.advisoryWait?.settledWindow,
        POLICY_DEFAULTS.advisoryWait.settledWindow,
      ),
      pollInterval: parseAdvisoryWholeMinuteDuration(
        c?.advisoryWait?.pollInterval,
        POLICY_DEFAULTS.advisoryWait.pollInterval,
      ),
      capExhaustedRoute: parseAdvisoryCapRoute(
        c?.advisoryWait?.capExhaustedRoute,
        POLICY_DEFAULTS.advisoryWait.capExhaustedRoute,
      ),
      convergenceScope: parseEnum(
        c?.advisoryWait?.convergenceScope,
        ADVISORY_CONVERGENCE_SCOPES,
        POLICY_DEFAULTS.advisoryWait.convergenceScope,
      ),
      // #1906: same simple-boolean coercion style as
      // `skipIssueAuthorApprovalGate` above -- only a literal `true`
      // opts in, everything else (including a malformed value) keeps
      // the conservative `false` default.
      exemptBotAuthoredPrs: c?.advisoryWait?.exemptBotAuthoredPrs === true,
    },
    ciWait: {
      runningTimeout: parseDuration(
        c?.ciWait?.runningTimeout,
        POLICY_DEFAULTS.ciWait.runningTimeout,
      ),
      generationTimeout: parseDuration(
        c?.ciWait?.generationTimeout,
        POLICY_DEFAULTS.ciWait.generationTimeout,
      ),
      rerunPolicy: parseEnum(
        c?.ciWait?.rerunPolicy,
        CI_RERUN_POLICIES,
        POLICY_DEFAULTS.ciWait.rerunPolicy,
      ),
    },
    ciGate: {
      externalChecks: {
        advisory: parseCheckSelectors(
          c?.ciGate?.externalChecks?.advisory,
          POLICY_DEFAULTS.ciGate.externalChecks.advisory,
        ),
        waivable: parseCheckSelectors(
          c?.ciGate?.externalChecks?.waivable,
          POLICY_DEFAULTS.ciGate.externalChecks.waivable,
        ),
      },
      externalCheckWaivers: {
        mode: parseEnum(
          c?.ciGate?.externalCheckWaivers?.mode,
          EXTERNAL_CHECK_WAIVER_MODES,
          POLICY_DEFAULTS.ciGate.externalCheckWaivers.mode,
        ),
        authorityPolicy: parseEnum(
          c?.ciGate?.externalCheckWaivers?.authorityPolicy,
          APPROVAL_ACTOR_POLICIES,
          POLICY_DEFAULTS.ciGate.externalCheckWaivers.authorityPolicy,
        ),
        maxValidity: parsePositiveDuration(
          c?.ciGate?.externalCheckWaivers?.maxValidity,
          POLICY_DEFAULTS.ciGate.externalCheckWaivers.maxValidity,
        ),
      },
      trustEmptyProtectionReads: c?.ciGate?.trustEmptyProtectionReads === true,
      trustSourcePinnedRequiredChecks:
        c?.ciGate?.trustSourcePinnedRequiredChecks === true,
    },
    discover: {
      activeClaimPreScanBatchSize: parsePositiveInteger(
        c?.discover?.activeClaimPreScanBatchSize,
        POLICY_DEFAULTS.discover.activeClaimPreScanBatchSize,
      ),
      selectionDesync: parseEnum(
        c?.discover?.selectionDesync,
        SELECTION_DESYNC_MODES,
        POLICY_DEFAULTS.discover.selectionDesync,
      ),
      legacyRoots: parsePositiveIntegerArray(
        c?.discover?.legacyRoots,
        POLICY_DEFAULTS.discover.legacyRoots,
      ),
      // parseNonEmptyString collapses absent, wrong-type, and empty-string
      // input to the same '' (off) fallback -- schema validation (`type:
      // "string"`) is what rejects a non-string config value with a named
      // reason; this resolver only needs to fail safe to neutral.
      milestoneScope: parseNonEmptyString(
        c?.discover?.milestoneScope,
        POLICY_DEFAULTS.discover.milestoneScope,
      ),
    },
    claim: {
      verifySettleDelay: parseDuration(
        c?.claim?.verifySettleDelay,
        POLICY_DEFAULTS.claim.verifySettleDelay,
      ),
    },
    critiqueLoop,
    reviewEscalation: {
      changesRequestedFirstEscalation: parseDuration(
        c?.reviewEscalation?.changesRequestedFirstEscalation,
        POLICY_DEFAULTS.reviewEscalation.changesRequestedFirstEscalation,
      ),
      changesRequestedSecondEscalation: parseDuration(
        c?.reviewEscalation?.changesRequestedSecondEscalation,
        POLICY_DEFAULTS.reviewEscalation.changesRequestedSecondEscalation,
      ),
    },
    approvalSignals: {
      readyLabelName: parseNonEmptyString(
        c?.approvalSignals?.readyLabelName,
        POLICY_DEFAULTS.approvalSignals.readyLabelName,
      ),
      labelFreshnessMode: parseEnum(
        c?.approvalSignals?.labelFreshnessMode,
        LABEL_FRESHNESS_MODES,
        POLICY_DEFAULTS.approvalSignals.labelFreshnessMode,
      ),
    },
    issueAuthoring: {
      maxClarificationRounds: parsePositiveInteger(
        c?.issueAuthoring?.maxClarificationRounds,
        POLICY_DEFAULTS.issueAuthoring.maxClarificationRounds,
      ),
      authoringLabelName: parseNonEmptyString(
        c?.issueAuthoring?.authoringLabelName,
        POLICY_DEFAULTS.issueAuthoring.authoringLabelName,
      ),
      authoringStaleAge: parseDuration(
        c?.issueAuthoring?.authoringStaleAge,
        POLICY_DEFAULTS.issueAuthoring.authoringStaleAge,
      ),
    },
    // Added in #1272 for shape parity with the clone(POLICY_DEFAULTS)
    // early-return branch above (non-object input); wired to the
    // consuming helpers' label lookups in #1273 (see the POLICY_DEFAULTS
    // comment above for the exact file list).
    labels: {
      roadmapLabelName: parseNonEmptyString(
        c?.labels?.roadmapLabelName,
        POLICY_DEFAULTS.labels.roadmapLabelName,
      ),
      blockedByHumanLabelName: parseNonEmptyString(
        c?.labels?.blockedByHumanLabelName,
        POLICY_DEFAULTS.labels.blockedByHumanLabelName,
      ),
      needsDecisionLabelName: parseNonEmptyString(
        c?.labels?.needsDecisionLabelName,
        POLICY_DEFAULTS.labels.needsDecisionLabelName,
      ),
    },
    mergeGate: {
      soloCodeownerAdminFallback: parseEnum(
        c?.mergeGate?.soloCodeownerAdminFallback,
        MERGE_GATE_SOLO_CODEOWNER_ADMIN_FALLBACK_MODES,
        POLICY_DEFAULTS.mergeGate.soloCodeownerAdminFallback,
      ),
    },
    providerOutage,
    localValidationEvidence,
  };
}

export function resolveCollaboratorMarkerTrust(
  config: unknown,
  envValue: string = '',
): boolean {
  if (hasConfiguredCollaboratorMarkerTrust(config)) {
    return normalizePolicyConfig(config).markerTrust.allowCollaboratorMarkers;
  }
  return isTruthy(envValue);
}

export function parseIsoDurationToMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = DURATION_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  const days = Number.parseInt(match.groups?.days ?? '0', 10);
  const hours = Number.parseInt(match.groups?.hours ?? '0', 10);
  const minutes = Number.parseInt(match.groups?.minutes ?? '0', 10);
  const seconds = Number.parseInt(match.groups?.seconds ?? '0', 10);
  const totalMs =
    days * DAY_MS + hours * HOUR_MS + minutes * MINUTE_MS + seconds * SECOND_MS;
  return totalMs > 0 ? totalMs : null;
}

export function getReviewEscalationChangesRequestedPolicy(
  config: unknown = {},
): { escalateAfterMs: number; releaseAfterEscalationMs: number } {
  const normalized = normalizePolicyConfig(config);
  const firstEscalationMs = parseIsoDurationToMs(
    normalized.reviewEscalation.changesRequestedFirstEscalation,
  );
  const secondEscalationMs = parseIsoDurationToMs(
    normalized.reviewEscalation.changesRequestedSecondEscalation,
  );
  const defaultFirstEscalationMs =
    parseIsoDurationToMs(
      POLICY_DEFAULTS.reviewEscalation.changesRequestedFirstEscalation,
    ) ?? 0;
  const defaultSecondEscalationMs =
    parseIsoDurationToMs(
      POLICY_DEFAULTS.reviewEscalation.changesRequestedSecondEscalation,
    ) ?? 0;
  const resolvedFirstEscalationMs = isFiniteNumber(firstEscalationMs)
    ? firstEscalationMs
    : defaultFirstEscalationMs;
  const resolvedSecondEscalationMs = isFiniteNumber(secondEscalationMs)
    ? secondEscalationMs
    : defaultSecondEscalationMs;
  const defaultPostEscalationMs =
    defaultSecondEscalationMs - defaultFirstEscalationMs;
  const resolvedPostEscalationMs =
    resolvedSecondEscalationMs > resolvedFirstEscalationMs
      ? resolvedSecondEscalationMs - resolvedFirstEscalationMs
      : defaultPostEscalationMs;

  return {
    escalateAfterMs: resolvedFirstEscalationMs,
    releaseAfterEscalationMs: resolvedPostEscalationMs,
  };
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Deterministically pick an index within a same-score tie band for the
 * Discover A4 Step 2 selection desync (`discover.selectionDesync:
 * session-offset`). Pure and network-free: the same session token always
 * maps to the same index, while distinct tokens spread across the band, so
 * concurrent autopilot sessions stop colliding on the lowest-numbered
 * candidate. Returns `0` — the lowest-numbered, i.e. the default
 * deterministic pick — for an empty/singleton band or a non-string/empty
 * token, so `off`, no-tie, and no-token behavior is unchanged.
 *
 * The band is the caller's ascending-issue-number ordering; this only
 * chooses an offset within it and never reorders across score bands or
 * affects branch naming.
 */
export function selectDesyncedIndex(token: unknown, bandSize: unknown): number {
  const size =
    typeof bandSize === 'number' && Number.isInteger(bandSize) && bandSize > 0
      ? bandSize
      : 0;
  if (size <= 1) {
    return 0;
  }
  if (typeof token !== 'string' || token.length === 0) {
    return 0;
  }
  // FNV-1a 32-bit hash — deterministic, dependency-free, well-spread.
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % size;
}

/**
 * Deep-clone helper for this module's own trusted defaults (#1449).
 *
 * Exported only so its equivalence can be unit-tested directly; every
 * production call site stays inside this file. `structuredClone` (global
 * since Node 17, well below this repo's `^22.23.2 || ^24.2 || >=26` floor) replaces
 * the previous `JSON.parse(JSON.stringify(value))` round-trip.
 * `structuredClone` differs from a JSON round-trip on several axes —
 * non-exhaustively: it throws on functions; it preserves `Date`, `Map`,
 * and `undefined`-valued keys that JSON drops or converts; and it also
 * diverges on `BigInt`, `RegExp`, typed arrays, and `NaN`/`Infinity`/`-0`
 * normalization. This list is deliberately not treated as exhaustive —
 * what matters for this swap is not enumerating every divergence axis,
 * but that `POLICY_DEFAULTS` (below) never contains a value on *any* of
 * them. All 8 call sites in this file were enumerated before making this
 * swap: `normalizePolicyConfig`'s `clone(POLICY_DEFAULTS)`, plus 7 calls
 * across `parsePositiveIntegerArray` and `parseCheckSelectors`, which
 * only ever clone `POLICY_DEFAULTS` itself or one of its own frozen
 * sub-arrays (`discover.legacyRoots`, `ciGate.externalChecks.advisory`,
 * `.waivable` — all `[]`). `POLICY_DEFAULTS` is a plain, deeply-frozen
 * literal of strings, finite numbers, booleans, and empty arrays only —
 * no function, `Date`, `Map`, `BigInt`, `RegExp`, typed array, exotic
 * number, or `undefined`-valued property appears anywhere in it, so none
 * of `structuredClone`'s divergences from a JSON round-trip is ever
 * exercised by a real caller (Copilot review, #1463).
 */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

function _firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

function firstAcceptedString(accepted: EnumSet, ...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && accepted.has(value)) {
      return value;
    }
  }
  return '';
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return null;
}

function parseEnum(
  value: unknown,
  accepted: EnumSet,
  fallback: string,
): string {
  if (typeof value === 'string' && accepted.has(value)) {
    return value;
  }
  return fallback;
}

function parseDuration(value: unknown, fallback: string): string {
  if (typeof value === 'string' && ISO_DURATION_RE.test(value)) {
    return value;
  }
  return fallback;
}

function parseAdvisoryWholeMinuteDuration(
  value: unknown,
  fallback: string,
): string {
  if (
    typeof value === 'string' &&
    ADVISORY_WHOLE_MINUTE_DURATION_RE.test(value)
  ) {
    return value;
  }
  return fallback;
}

function parseAdvisoryCapRoute(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    if (ADVISORY_CAP_ROUTES.has(value)) {
      return value;
    }
    return LEGACY_ADVISORY_CAP_ROUTE_ALIASES.get(value) ?? fallback;
  }
  return fallback;
}

function parsePositiveDuration(value: unknown, fallback: string): string {
  return typeof value === 'string' &&
    ISO_DURATION_RE.test(value) &&
    parseIsoDurationToMs(value) !== null
    ? value
    : fallback;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : fallback;
}

/**
 * Parse a config array of positive integers (e.g. issue numbers), such as
 * `discover.legacyRoots`. Mirrors `parseCheckSelectors`'s fail-closed shape:
 * a non-array, empty array, or any entry that is not a positive integer
 * falls back to `fallback` as a whole rather than dropping just the bad
 * entries, so a typo'd issue number cannot silently vanish from the set.
 */
function parsePositiveIntegerArray(
  value: unknown,
  fallback: readonly number[],
): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    return clone(fallback) as number[];
  }

  const normalized: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) {
      return clone(fallback) as number[];
    }
    normalized.push(entry);
  }
  return normalized;
}

function parseNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function parseCheckSelectors(
  value: unknown,
  fallback: readonly CheckSelector[],
): CheckSelector[] {
  if (!Array.isArray(value) || value.length === 0) {
    return clone(fallback) as CheckSelector[];
  }

  const entries = value as unknown[];
  const normalized: CheckSelector[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return clone(fallback) as CheckSelector[];
    }

    const candidate = entry as { selector?: unknown; matchMode?: unknown };
    const entryKeys = Object.keys(candidate);
    if (entryKeys.some((key) => key !== 'selector' && key !== 'matchMode')) {
      return clone(fallback) as CheckSelector[];
    }

    const selector = parseNonEmptyString(candidate.selector, '');
    if (!selector) {
      return clone(fallback) as CheckSelector[];
    }

    if (hasOwn(candidate, 'matchMode')) {
      if (
        typeof candidate.matchMode !== 'string' ||
        !CHECK_SELECTOR_MATCH_MODES.has(candidate.matchMode)
      ) {
        return clone(fallback) as CheckSelector[];
      }
    }

    normalized.push({
      selector,
      matchMode:
        typeof candidate.matchMode === 'string' ? candidate.matchMode : 'exact',
    });
  }

  return normalized;
}

/**
 * Parse `critiqueLoop.delegate`. Unlike the other `critiqueLoop` fields,
 * absence is not defaulted to a concrete value -- a non-object, an unknown
 * nested key, or a missing/whitespace-only `command` all normalize to
 * `undefined` (no delegate configured) so a direct `normalizePolicyConfig`
 * caller can never accept a shape the schema's `additionalProperties: false`
 * / `command` pattern would reject (#2207 review).
 */
function parseCritiqueLoopDelegate(
  value: unknown,
): CritiqueLoopDelegate | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as { command?: unknown; mode?: unknown };
  const candidateKeys = Object.keys(candidate);
  if (candidateKeys.some((key) => key !== 'command' && key !== 'mode')) {
    return undefined;
  }
  // Object.keys() above already excludes inherited keys, but a plain
  // property read (candidate.command) still walks the prototype chain --
  // require command/mode to be own properties so a crafted object (e.g.
  // Object.create({ command: '...' })) can't supply either through
  // inheritance instead of being rejected as absent (#2207 review).
  if (!Object.hasOwn(candidate, 'command')) {
    return undefined;
  }

  const command = parseNonEmptyString(candidate.command, '');
  if (!command || command.trim() === '') {
    return undefined;
  }

  return {
    command,
    mode: Object.hasOwn(candidate, 'mode')
      ? (parseEnum(candidate.mode, CRITIQUE_LOOP_DELEGATE_MODES, 'fallback') as
          | 'fallback'
          | 'combined'
          | 'on-success'
          | 'never')
      : 'fallback',
  };
}

const INVALID_LOCAL_DELEGATE_REASON = 'invalid-repository-local-delegate';

/**
 * Inspect `critiqueLoop.delegate` on a raw policy document without applying
 * `normalizePolicyConfig`'s fail-safe-to-undefined collapse. Distinguishes
 * absence, the explicit JSON `null` disable sentinel, a configured object,
 * and a present-but-malformed value.
 */
export function inspectCritiqueLoopDelegateLayer(
  config: unknown,
): CritiqueLoopDelegateLayer {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { status: 'absent' };
  }

  if (!Object.hasOwn(config, 'critiqueLoop')) {
    return { status: 'absent' };
  }

  const critiqueLoop = (config as RawConfig).critiqueLoop;
  if (
    typeof critiqueLoop !== 'object' ||
    critiqueLoop === null ||
    Array.isArray(critiqueLoop)
  ) {
    // A present non-object `critiqueLoop` is a local configuration error:
    // fail closed rather than treating it as "no delegate" and inheriting
    // a user-global object.
    return { status: 'malformed', reason: INVALID_LOCAL_DELEGATE_REASON };
  }

  if (!Object.hasOwn(critiqueLoop, 'delegate')) {
    return { status: 'absent' };
  }

  const value = (critiqueLoop as { delegate: unknown }).delegate;
  if (value === null) {
    return { status: 'disabled' };
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const candidate = value as { mode?: unknown };
    if (Object.hasOwn(candidate, 'mode')) {
      const mode = candidate.mode;
      if (typeof mode !== 'string' || !CRITIQUE_LOOP_DELEGATE_MODES.has(mode)) {
        return {
          status: 'malformed',
          reason: INVALID_LOCAL_DELEGATE_REASON,
        };
      }
    }
  }

  const parsed = parseCritiqueLoopDelegate(value);
  if (parsed) {
    return { status: 'configured', delegate: parsed };
  }

  return { status: 'malformed', reason: INVALID_LOCAL_DELEGATE_REASON };
}

/**
 * Resolve the effective C1 delegate from a repository-local document and an
 * optional user-global document. Pure: callers supply already-loaded JSON
 * (or `undefined` for an absent global file). Never reads the filesystem.
 *
 * Order: local object, local `null` disable, global object, then none.
 * A malformed local delegate is fail-closed and does not inherit global.
 * A malformed or disabled global fragment is treated as absent.
 */
export function resolveEffectiveCritiqueLoopDelegate(input: {
  localConfig: unknown;
  globalConfig?: unknown;
}): EffectiveCritiqueLoopDelegate {
  const local = inspectCritiqueLoopDelegateLayer(input.localConfig);
  if (local.status === 'configured' && local.delegate) {
    return {
      status: 'local',
      source: 'repository-local',
      delegate: local.delegate,
    };
  }
  if (local.status === 'disabled') {
    return { status: 'disabled', source: 'repository-local' };
  }
  if (local.status === 'malformed') {
    return {
      status: 'local-malformed',
      source: 'repository-local',
      reason: local.reason ?? INVALID_LOCAL_DELEGATE_REASON,
    };
  }

  if (input.globalConfig === undefined || input.globalConfig === null) {
    return { status: 'none', source: 'none' };
  }

  const global = inspectCritiqueLoopDelegateLayer(input.globalConfig);
  if (global.status === 'configured' && global.delegate) {
    return {
      status: 'global',
      source: 'user-global',
      delegate: global.delegate,
    };
  }

  return { status: 'none', source: 'none' };
}

function hasConfiguredCollaboratorMarkerTrust(config: unknown): boolean {
  const c = config as RawConfig | null | undefined;
  return (
    typeof c?.markerTrust?.allowCollaboratorMarkers === 'boolean' ||
    typeof c?.markerTrustAllowCollaboratorMarkers === 'boolean' ||
    typeof c?.allowCollaboratorMarkers === 'boolean'
  );
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}

function hasOwn(value: unknown, key: string): boolean {
  return Object.hasOwn((value ?? {}) as object, key);
}
