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

// Structural view of the untrusted config object parsed from an
// adopter-controlled JSON file. Every field is optional and weakly
// typed; the runtime guards below perform the real validation.
interface RawConfig {
  issueScope?: unknown;
  orphanFirstPolicy?: unknown;
  skipIssueAuthorApprovalGate?: unknown;
  maintainerApprovalActorPolicy?: unknown;
  stallRecovery?: { quietWindow?: unknown };
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
  };
  discover?: {
    activeClaimPreScanBatchSize?: unknown;
    selectionDesync?: unknown;
  };
  claim?: { verifySettleDelay?: unknown };
  critiqueLoop?: {
    cPhaseLowSeveritySkipAfter?: unknown;
    e10NoProgressHoldAfter?: unknown;
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
}

const HELPER_RUNTIME_PROFILES = new Set([
  'package-manager',
  'vendored-node',
  'ephemeral-npx',
  'instructions-only',
]);
const HELPER_RUNTIME_KEYS = new Set(['profile']);
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
const SELECTION_DESYNC_MODES = new Set(['off', 'session-offset']);
const EXTERNAL_CHECK_WAIVER_MODES = new Set([
  'disabled',
  'maintainer-authorized',
]);
const CHECK_SELECTOR_MATCH_MODES = new Set(['exact', 'glob']);
const LEGACY_ADVISORY_CAP_ROUTE_ALIASES = new Map([
  ['phase-default', 'phase-specific'],
  ['strict-hold', 'hold'],
]);
const CI_RERUN_POLICIES = new Set(['rerun-once']);
const LABEL_FRESHNESS_MODES = new Set(['presence-only', 'event-freshness']);
const ISO_DURATION_RE =
  /^P(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
const ADVISORY_WHOLE_MINUTE_DURATION_RE =
  /^P(?=(?:\d+D|T\d+[HM]))(?=.*(?:[1-9]\d*[DHM]))(?:\d+D)?(?:T(?=\d+[HM])(?:\d+H)?(?:\d+M)?)?$/;
const DURATION_RE =
  /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?)?$/;
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
  }),
  discover: Object.freeze({
    activeClaimPreScanBatchSize: 10,
    selectionDesync: 'off',
  }),
  claim: Object.freeze({
    verifySettleDelay: 'PT5S',
  }),
  critiqueLoop: Object.freeze({
    cPhaseLowSeveritySkipAfter: 3,
    e10NoProgressHoldAfter: 3,
  }),
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

export function inspectHelperRuntimeConfig(config: unknown) {
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
    },
    claim: {
      verifySettleDelay: parseDuration(
        c?.claim?.verifySettleDelay,
        POLICY_DEFAULTS.claim.verifySettleDelay,
      ),
    },
    critiqueLoop: {
      cPhaseLowSeveritySkipAfter: parsePositiveInteger(
        c?.critiqueLoop?.cPhaseLowSeveritySkipAfter,
        POLICY_DEFAULTS.critiqueLoop.cPhaseLowSeveritySkipAfter,
      ),
      e10NoProgressHoldAfter: parsePositiveInteger(
        c?.critiqueLoop?.e10NoProgressHoldAfter,
        POLICY_DEFAULTS.critiqueLoop.e10NoProgressHoldAfter,
      ),
    },
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
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
