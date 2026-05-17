const HELPER_RUNTIME_PROFILES = new Set([
  "package-manager",
  "vendored-node",
  "ephemeral-npx",
  "instructions-only",
]);
const HELPER_RUNTIME_KEYS = new Set(["profile"]);
const ISSUE_SCOPES = new Set(["roadmap", "orphan-first"]);
const ORPHAN_FIRST_POLICIES = new Set(["none", "maintainer-approved", "public-disabled"]);
const APPROVAL_ACTOR_POLICIES = new Set(["owners-and-maintainers-only", "all-write-permission-actors"]);
const FORCED_HANDOFF_MODES = new Set(["disabled", "human-gated"]);
const ADVISORY_CAP_ROUTES = new Set(["phase-specific", "hold"]);
const EXTERNAL_CHECK_WAIVER_MODES = new Set(["disabled", "maintainer-authorized"]);
const CHECK_SELECTOR_MATCH_MODES = new Set(["exact", "glob"]);
const LEGACY_ADVISORY_CAP_ROUTE_ALIASES = new Map([
  ["phase-default", "phase-specific"],
  ["strict-hold", "hold"],
]);
const CI_RERUN_POLICIES = new Set(["rerun-once"]);
const LABEL_FRESHNESS_MODES = new Set(["presence-only", "event-freshness"]);
const ISO_DURATION_RE = /^P(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
const ADVISORY_WHOLE_MINUTE_DURATION_RE = /^P(?=(?:\d+D|T\d+[HM]))(?=.*(?:[1-9]\d*[DHM]))(?:\d+D)?(?:T(?=\d+[HM])(?:\d+H)?(?:\d+M)?)?$/;
const DURATION_RE =
  /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?)?$/;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const POLICY_DEFAULTS = Object.freeze({
  issueScope: "roadmap",
  orphanFirstPolicy: "none",
  skipIssueAuthorApprovalGate: false,
  maintainerApprovalActorPolicy: "owners-and-maintainers-only",
  stallRecovery: Object.freeze({
    quietWindow: "PT30M",
  }),
  forcedHandoff: Object.freeze({
    mode: "disabled",
    authorityPolicy: "owners-and-maintainers-only",
  }),
  markerTrust: Object.freeze({
    allowCollaboratorMarkers: false,
  }),
  advisoryWait: Object.freeze({
    requestCap: 30,
    pendingWindow: "PT30M",
    settledWindow: "PT10M",
    pollInterval: "PT2M",
    capExhaustedRoute: "phase-specific",
  }),
  ciWait: Object.freeze({
    runningTimeout: "PT30M",
    generationTimeout: "PT10M",
    rerunPolicy: "rerun-once",
  }),
  ciGate: Object.freeze({
    externalChecks: Object.freeze({
      advisory: Object.freeze([]),
      waivable: Object.freeze([]),
    }),
    externalCheckWaivers: Object.freeze({
      mode: "disabled",
      authorityPolicy: "owners-and-maintainers-only",
      maxValidity: "PT24H",
    }),
  }),
  discover: Object.freeze({
    activeClaimPreScanBatchSize: 10,
  }),
  claim: Object.freeze({
    verifySettleDelay: "PT5S",
  }),
  critiqueLoop: Object.freeze({
    cPhaseLowSeveritySkipAfter: 3,
    e10NoProgressHoldAfter: 3,
  }),
  reviewEscalation: Object.freeze({
    changesRequestedFirstEscalation: "PT24H",
    changesRequestedSecondEscalation: "PT48H",
  }),
  approvalSignals: Object.freeze({
    readyLabelName: "idd:ready",
    labelFreshnessMode: "presence-only",
  }),
  issueAuthoring: Object.freeze({
    maxClarificationRounds: 3,
    authoringLabelName: "status:authoring",
    authoringStaleAge: "PT4H",
  }),
});

export function parseProjectCommandRows(text) {
  const commands = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (!match) {
      continue;
    }
    commands.set(match[1].trim(), match[2].trim());
  }
  return commands;
}

export function inspectHelperRuntimeConfig(config) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { status: "invalid", reason: "config must be a non-null object" };
  }

  if (!hasOwn(config, "helperRuntime")) {
    return { status: "absent" };
  }

  const helperRuntime = config.helperRuntime;
  if (typeof helperRuntime !== "object" || helperRuntime === null || Array.isArray(helperRuntime)) {
    return { status: "invalid", reason: "helperRuntime must be an object when present" };
  }

  const unexpectedKeys = Object.keys(helperRuntime).filter((key) => !HELPER_RUNTIME_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    return {
      status: "invalid",
      reason: `unsupported helperRuntime keys: ${unexpectedKeys.join(", ")}`,
    };
  }

  const profile = helperRuntime.profile;
  if (typeof profile !== "string" || profile.length === 0) {
    return { status: "invalid", reason: "helperRuntime.profile must be a non-empty string" };
  }

  if (!HELPER_RUNTIME_PROFILES.has(profile)) {
    return {
      status: "invalid",
      reason: `unsupported helperRuntime.profile "${profile}"`,
    };
  }

  return { status: "ok", profile };
}

export function normalizePolicyConfig(config) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return clone(POLICY_DEFAULTS);
  }

  const forcedHandoffAuthorityAlias = firstAcceptedString(
    APPROVAL_ACTOR_POLICIES,
    config?.forcedHandoff?.authorityPolicy,
    config?.["forced-handoff"]?.authorityPolicy,
    config?.forcedHandoffAuthority,
    config?.["forced-handoff-authority"],
  );
  const forcedHandoffModeAlias = firstAcceptedString(
    FORCED_HANDOFF_MODES,
    config?.forcedHandoff?.mode,
    config?.["forced-handoff"]?.mode,
    config?.forcedHandoffMode,
    config?.["forced-handoff-mode"],
  );
  const markerTrustAlias = firstBoolean(
    config?.markerTrust?.allowCollaboratorMarkers,
    config?.markerTrustAllowCollaboratorMarkers,
    config?.allowCollaboratorMarkers,
  );

  return {
    issueScope: parseEnum(config?.issueScope, ISSUE_SCOPES, POLICY_DEFAULTS.issueScope),
    orphanFirstPolicy: parseEnum(
      config?.orphanFirstPolicy,
      ORPHAN_FIRST_POLICIES,
      POLICY_DEFAULTS.orphanFirstPolicy,
    ),
    skipIssueAuthorApprovalGate: config?.skipIssueAuthorApprovalGate === true,
    maintainerApprovalActorPolicy: parseEnum(
      config?.maintainerApprovalActorPolicy,
      APPROVAL_ACTOR_POLICIES,
      POLICY_DEFAULTS.maintainerApprovalActorPolicy,
    ),
    stallRecovery: {
      quietWindow: parseDuration(config?.stallRecovery?.quietWindow, POLICY_DEFAULTS.stallRecovery.quietWindow),
    },
    forcedHandoff: {
      mode: parseEnum(forcedHandoffModeAlias, FORCED_HANDOFF_MODES, POLICY_DEFAULTS.forcedHandoff.mode),
      authorityPolicy: parseEnum(
        forcedHandoffAuthorityAlias,
        APPROVAL_ACTOR_POLICIES,
        POLICY_DEFAULTS.forcedHandoff.authorityPolicy,
      ),
    },
    markerTrust: {
      allowCollaboratorMarkers: markerTrustAlias ?? POLICY_DEFAULTS.markerTrust.allowCollaboratorMarkers,
    },
    advisoryWait: {
      requestCap: parsePositiveInteger(config?.advisoryWait?.requestCap, POLICY_DEFAULTS.advisoryWait.requestCap),
      pendingWindow: parseAdvisoryWholeMinuteDuration(
        config?.advisoryWait?.pendingWindow,
        POLICY_DEFAULTS.advisoryWait.pendingWindow,
      ),
      settledWindow: parseAdvisoryWholeMinuteDuration(
        config?.advisoryWait?.settledWindow,
        POLICY_DEFAULTS.advisoryWait.settledWindow,
      ),
      pollInterval: parseAdvisoryWholeMinuteDuration(
        config?.advisoryWait?.pollInterval,
        POLICY_DEFAULTS.advisoryWait.pollInterval,
      ),
      capExhaustedRoute: parseAdvisoryCapRoute(
        config?.advisoryWait?.capExhaustedRoute,
        POLICY_DEFAULTS.advisoryWait.capExhaustedRoute,
      ),
    },
    ciWait: {
      runningTimeout: parseDuration(config?.ciWait?.runningTimeout, POLICY_DEFAULTS.ciWait.runningTimeout),
      generationTimeout: parseDuration(
        config?.ciWait?.generationTimeout,
        POLICY_DEFAULTS.ciWait.generationTimeout,
      ),
      rerunPolicy: parseEnum(config?.ciWait?.rerunPolicy, CI_RERUN_POLICIES, POLICY_DEFAULTS.ciWait.rerunPolicy),
    },
    ciGate: {
      externalChecks: {
        advisory: parseCheckSelectors(
          config?.ciGate?.externalChecks?.advisory,
          POLICY_DEFAULTS.ciGate.externalChecks.advisory,
        ),
        waivable: parseCheckSelectors(
          config?.ciGate?.externalChecks?.waivable,
          POLICY_DEFAULTS.ciGate.externalChecks.waivable,
        ),
      },
      externalCheckWaivers: {
        mode: parseEnum(
          config?.ciGate?.externalCheckWaivers?.mode,
          EXTERNAL_CHECK_WAIVER_MODES,
          POLICY_DEFAULTS.ciGate.externalCheckWaivers.mode,
        ),
        authorityPolicy: parseEnum(
          config?.ciGate?.externalCheckWaivers?.authorityPolicy,
          APPROVAL_ACTOR_POLICIES,
          POLICY_DEFAULTS.ciGate.externalCheckWaivers.authorityPolicy,
        ),
        maxValidity: parsePositiveDuration(
          config?.ciGate?.externalCheckWaivers?.maxValidity,
          POLICY_DEFAULTS.ciGate.externalCheckWaivers.maxValidity,
        ),
      },
    },
    discover: {
      activeClaimPreScanBatchSize: parsePositiveInteger(
        config?.discover?.activeClaimPreScanBatchSize,
        POLICY_DEFAULTS.discover.activeClaimPreScanBatchSize,
      ),
    },
    claim: {
      verifySettleDelay: parseDuration(
        config?.claim?.verifySettleDelay,
        POLICY_DEFAULTS.claim.verifySettleDelay,
      ),
    },
    critiqueLoop: {
      cPhaseLowSeveritySkipAfter: parsePositiveInteger(
        config?.critiqueLoop?.cPhaseLowSeveritySkipAfter,
        POLICY_DEFAULTS.critiqueLoop.cPhaseLowSeveritySkipAfter,
      ),
      e10NoProgressHoldAfter: parsePositiveInteger(
        config?.critiqueLoop?.e10NoProgressHoldAfter,
        POLICY_DEFAULTS.critiqueLoop.e10NoProgressHoldAfter,
      ),
    },
    reviewEscalation: {
      changesRequestedFirstEscalation: parseDuration(
        config?.reviewEscalation?.changesRequestedFirstEscalation,
        POLICY_DEFAULTS.reviewEscalation.changesRequestedFirstEscalation,
      ),
      changesRequestedSecondEscalation: parseDuration(
        config?.reviewEscalation?.changesRequestedSecondEscalation,
        POLICY_DEFAULTS.reviewEscalation.changesRequestedSecondEscalation,
      ),
    },
    approvalSignals: {
      readyLabelName: parseNonEmptyString(
        config?.approvalSignals?.readyLabelName,
        POLICY_DEFAULTS.approvalSignals.readyLabelName,
      ),
      labelFreshnessMode: parseEnum(
        config?.approvalSignals?.labelFreshnessMode,
        LABEL_FRESHNESS_MODES,
        POLICY_DEFAULTS.approvalSignals.labelFreshnessMode,
      ),
    },
    issueAuthoring: {
      maxClarificationRounds: parsePositiveInteger(
        config?.issueAuthoring?.maxClarificationRounds,
        POLICY_DEFAULTS.issueAuthoring.maxClarificationRounds,
      ),
      authoringLabelName: parseNonEmptyString(
        config?.issueAuthoring?.authoringLabelName,
        POLICY_DEFAULTS.issueAuthoring.authoringLabelName,
      ),
      authoringStaleAge: parseDuration(
        config?.issueAuthoring?.authoringStaleAge,
        POLICY_DEFAULTS.issueAuthoring.authoringStaleAge,
      ),
    },
  };
}

export function resolveCollaboratorMarkerTrust(config, envValue = "") {
  if (hasConfiguredCollaboratorMarkerTrust(config)) {
    return normalizePolicyConfig(config).markerTrust.allowCollaboratorMarkers;
  }
  return isTruthy(envValue);
}

export function parseIsoDurationToMs(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = DURATION_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  const days = Number.parseInt(match.groups.days ?? "0", 10);
  const hours = Number.parseInt(match.groups.hours ?? "0", 10);
  const minutes = Number.parseInt(match.groups.minutes ?? "0", 10);
  const seconds = Number.parseInt(match.groups.seconds ?? "0", 10);
  const totalMs = (days * DAY_MS) + (hours * HOUR_MS) + (minutes * MINUTE_MS) + (seconds * SECOND_MS);
  return totalMs > 0 ? totalMs : null;
}

export function getReviewEscalationChangesRequestedPolicy(config = {}) {
  const normalized = normalizePolicyConfig(config);
  const firstEscalationMs = parseIsoDurationToMs(
    normalized.reviewEscalation.changesRequestedFirstEscalation,
  );
  const secondEscalationMs = parseIsoDurationToMs(
    normalized.reviewEscalation.changesRequestedSecondEscalation,
  );
  const defaultFirstEscalationMs = parseIsoDurationToMs(
    POLICY_DEFAULTS.reviewEscalation.changesRequestedFirstEscalation,
  );
  const defaultSecondEscalationMs = parseIsoDurationToMs(
    POLICY_DEFAULTS.reviewEscalation.changesRequestedSecondEscalation,
  );
  const resolvedFirstEscalationMs = Number.isFinite(firstEscalationMs)
    ? firstEscalationMs
    : defaultFirstEscalationMs;
  const resolvedSecondEscalationMs = Number.isFinite(secondEscalationMs)
    ? secondEscalationMs
    : defaultSecondEscalationMs;
  const defaultPostEscalationMs = defaultSecondEscalationMs - defaultFirstEscalationMs;
  const resolvedPostEscalationMs = resolvedSecondEscalationMs > resolvedFirstEscalationMs
    ? resolvedSecondEscalationMs - resolvedFirstEscalationMs
    : defaultPostEscalationMs;

  return {
    escalateAfterMs: resolvedFirstEscalationMs,
    releaseAfterEscalationMs: resolvedPostEscalationMs,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function firstAcceptedString(accepted, ...values) {
  for (const value of values) {
    if (typeof value === "string" && accepted.has(value)) {
      return value;
    }
  }
  return "";
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function parseEnum(value, accepted, fallback) {
  if (typeof value === "string" && accepted.has(value)) {
    return value;
  }
  return fallback;
}

function parseDuration(value, fallback) {
  if (typeof value === "string" && ISO_DURATION_RE.test(value)) {
    return value;
  }
  return fallback;
}

function parseAdvisoryWholeMinuteDuration(value, fallback) {
  if (typeof value === "string" && ADVISORY_WHOLE_MINUTE_DURATION_RE.test(value)) {
    return value;
  }
  return fallback;
}

function parseAdvisoryCapRoute(value, fallback) {
  if (typeof value === "string") {
    if (ADVISORY_CAP_ROUTES.has(value)) {
      return value;
    }
    return LEGACY_ADVISORY_CAP_ROUTE_ALIASES.get(value) ?? fallback;
  }
  return fallback;
}

function parsePositiveDuration(value, fallback) {
  return typeof value === "string" && ISO_DURATION_RE.test(value) && parseIsoDurationToMs(value) !== null
    ? value
    : fallback;
}

function parsePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function parseNonEmptyString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseCheckSelectors(value, fallback) {
  if (!Array.isArray(value) || value.length === 0) {
    return clone(fallback);
  }

  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return clone(fallback);
    }

    const entryKeys = Object.keys(entry);
    if (entryKeys.some((key) => key !== "selector" && key !== "matchMode")) {
      return clone(fallback);
    }

    const selector = parseNonEmptyString(entry.selector, "");
    if (!selector) {
      return clone(fallback);
    }

    if (hasOwn(entry, "matchMode")) {
      if (typeof entry.matchMode !== "string" || !CHECK_SELECTOR_MATCH_MODES.has(entry.matchMode)) {
        return clone(fallback);
      }
    }

    normalized.push({
      selector,
      matchMode: typeof entry.matchMode === "string" ? entry.matchMode : "exact",
    });
  }

  return normalized;
}

function hasConfiguredCollaboratorMarkerTrust(config) {
  return typeof config?.markerTrust?.allowCollaboratorMarkers === "boolean"
    || typeof config?.markerTrustAllowCollaboratorMarkers === "boolean"
    || typeof config?.allowCollaboratorMarkers === "boolean";
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}
