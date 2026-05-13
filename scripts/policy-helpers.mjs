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
const ADVISORY_CAP_ROUTES = new Set(["phase-default", "strict-hold"]);
const CI_RERUN_POLICIES = new Set(["rerun-once"]);
const LABEL_FRESHNESS_MODES = new Set(["presence-only", "event-freshness"]);
const ISO_DURATION_RE = /^P(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;

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
    capExhaustedRoute: "phase-default",
  }),
  ciWait: Object.freeze({
    runningTimeout: "PT30M",
    generationTimeout: "PT10M",
    rerunPolicy: "rerun-once",
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
      pendingWindow: parseDuration(
        config?.advisoryWait?.pendingWindow,
        POLICY_DEFAULTS.advisoryWait.pendingWindow,
      ),
      settledWindow: parseDuration(
        config?.advisoryWait?.settledWindow,
        POLICY_DEFAULTS.advisoryWait.settledWindow,
      ),
      pollInterval: parseDuration(
        config?.advisoryWait?.pollInterval,
        POLICY_DEFAULTS.advisoryWait.pollInterval,
      ),
      capExhaustedRoute: parseEnum(
        config?.advisoryWait?.capExhaustedRoute,
        ADVISORY_CAP_ROUTES,
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
    },
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

function parsePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function parseNonEmptyString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}
