import { Buffer } from "node:buffer";
import { getReviewEscalationChangesRequestedPolicy } from "./policy-helpers.mjs";

import {
  ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT,
  ADVISORY_CAP_EXHAUSTED_ROUTES,
  DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES,
  DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES,
  DEFAULT_ADVISORY_REQUEST_CAP,
  DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES,
  normalizeAdvisoryWaitRuntimeOptions,
} from "./advisory-wait-policy.mjs";

const ISO8601_UTC_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;
const OPTIONAL_IDD_VISIBLE_NOTE_PATTERN = String.raw`(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)`;

export const LIVE_STATUS_DIGEST_MARKER = "<!-- idd-live-status: current -->";

const OPERATIONAL_MARKERS = [
  {
    label: "<!-- claimed-by:",
    pattern: /^<!--\s*claimed-by:\s+\S+\s+\S+\s+supersedes:\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+branch:\s+[^\s>]+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
  },
  {
    label: "<!-- unclaimed-by:",
    pattern: /^<!--\s*unclaimed-by:\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
  },
  {
    label: "<!-- review-watermark:",
    pattern: /^<!--\s*review-watermark:\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+\S+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
  },
  {
    label: "<!-- review-baseline:",
    pattern: /^<!--\s*review-baseline:\s+\S+\s+\S+\s+\S+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
  },
  {
    label: "advisory-wait:",
    pattern: /^advisory-wait:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/,
  },
  {
    label: "advisory-wait-recovery:",
    pattern: /^advisory-wait-recovery:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/,
  },
  {
    label: "<!-- advisory-wait:",
    pattern: /^<!--\s*advisory-wait:\s+\S+\s+[0-9a-f]{40}\s+\S+\s*-->\s*$/,
  },
  {
    label: "<!-- forced-handoff:",
    pattern: /^\s*<!--\s*forced-handoff:\s*\{[\s\S]*\}\s*-->[\s\S]*$/i,
    startPattern: /^<!--\s*forced-handoff:/i,
  },
  {
    label: "<!-- idd-external-check-waiver:",
    pattern: /^<!--\s*idd-external-check-waiver:\s+\S+\s+\S+\s+[0-9a-f]{40}\s+check:\S+\s+reason:\S+\s+expires:\S+\s*-->[\s\S]*$/i,
    startPattern: /^<!--\s*idd-external-check-waiver:/i,
  },
];

const IDD_AGENT_DERIVED_MARKERS = new Set([
  "<!-- claimed-by:",
  "<!-- unclaimed-by:",
  "<!-- review-watermark:",
  "<!-- review-baseline:",
  "advisory-wait:",
  "advisory-wait-recovery:",
  "<!-- advisory-wait:",
]);

const REVIEW_BOT_LOGINS = new Set([
  "coderabbitai",
  "coderabbitai[bot]",
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);

const UNSAFE_TEXT_RULES = [
  {
    pattern: /\*\*Awaiting maintainer decision\*\*/i,
    reason: "contains an awaiting-maintainer-decision marker",
  },
  {
    pattern: /\bactive hold\b/i,
    reason: "contains active hold context",
  },
  {
    pattern: /\bfailed[- ]ci\b|\bfailing ci\b|\bci failure\b|\bci failed\b|\bfailed checks?\b/i,
    reason: "contains failed-CI context",
  },
];
const AMD_MARKER_PATTERN = /^\*\*Awaiting maintainer decision\*\*/i;
const FORCED_HANDOFF_CONTEXT_SCOPES = new Set(["issue-only", "issue-plus-pr"]);
const FORCED_HANDOFF_LINKED_PR_PATTERN = /^(?:[1-9]\d*|https?:\/\/[^\s<>"]+)$/;

export function parsePaginatedGhNdjson(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const value = JSON.parse(line);
      return Array.isArray(value) ? value : [value];
    });
}

export function parseClaimComment(body, createdAt) {
  const match = body.trimEnd().match(
    new RegExp(
      `^<!--\\s*claimed-by:\\s+(\\S+)\\s+(\\S+)\\s+supersedes:\\s+(\\S+)\\s+(${ISO8601_UTC_PATTERN.source})\\s+branch:\\s+([^\\s>]+)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
      "i",
    ),
  );
  if (!match || !isValidIsoTimestamp(match[4])) {
    return null;
  }
  return {
    agentId: match[1],
    claimId: match[2],
    supersedes: match[3],
    branch: match[5],
    createdAt,
  };
}

export function parseReleaseComment(body) {
  const match = body.trimEnd().match(
    new RegExp(
      `^<!--\\s*unclaimed-by:\\s+(\\S+)\\s+(\\S+)\\s+(${ISO8601_UTC_PATTERN.source})\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
      "i",
    ),
  );
  if (!match || !isValidIsoTimestamp(match[3])) {
    return null;
  }
  return {
    agentId: match[1],
    claimId: match[2],
  };
}

export function parseForcedHandoffComment(body, createdAt) {
  const trimmed = body.trimStart().trimEnd();
  const markerMatch = trimmed.match(/^<!--\s*forced-handoff:\s*/i);
  if (!markerMatch) {
    return null;
  }

  const markerEnd = trimmed.indexOf("-->");
  if (markerEnd < 0) {
    return null;
  }

  const visibleNote = trimmed.slice(markerEnd + 3);
  const visibleText = visibleNote
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--[\s\S]*$/g, " ")
    .trim();
  if (!visibleText) {
    return null;
  }

  const payloadText = trimmed.slice(markerMatch[0].length, markerEnd).trim();
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }

  return normalizeForcedHandoffPayload(payload, { createdAt });
}

export function normalizeForcedHandoffPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  if (
    hasConflictingPayloadAliases(payload, "oldAgentId", "old-agent-id")
    || hasConflictingPayloadAliases(payload, "oldClaimId", "old-claim-id")
    || hasConflictingPayloadAliases(payload, "newAgentId", "new-agent-id")
    || hasConflictingPayloadAliases(payload, "newClaimId", "new-claim-id")
    || hasConflictingPayloadAliases(payload, "forcedBy", "forced-by")
    || hasConflictingPayloadAliases(payload, "linkedPr", "linked-pr")
    || hasConflictingPayloadAliases(payload, "contextScope", "context-scope")
  ) {
    return null;
  }

  const oldAgentId = normalizeNonWhitespaceToken(pickPayloadValue(payload, "oldAgentId", "old-agent-id"));
  const oldClaimId = normalizeNonWhitespaceToken(pickPayloadValue(payload, "oldClaimId", "old-claim-id"));
  const newAgentId = normalizeNonWhitespaceToken(pickPayloadValue(payload, "newAgentId", "new-agent-id"));
  const newClaimId = normalizeNonWhitespaceToken(pickPayloadValue(payload, "newClaimId", "new-claim-id"));
  const branch = normalizeBranchToken(pickPayloadValue(payload, "branch"));
  const forcedBy = normalizeNonWhitespaceToken(pickPayloadValue(payload, "forcedBy", "forced-by"));
  const reason = normalizeForcedHandoffReason(pickPayloadValue(payload, "reason"));
  const timestamp = normalizeSecondPrecisionIsoTimestamp(pickPayloadValue(payload, "timestamp"));
  const contextScope = normalizeContextScope(pickPayloadValue(payload, "contextScope", "context-scope"));
  const linkedPr = normalizeLinkedPr(pickPayloadValue(payload, "linkedPr", "linked-pr"));
  const createdAt = normalizeSecondPrecisionIsoTimestamp(options.createdAt);

  if (
    !oldAgentId
    || !oldClaimId
    || !newAgentId
    || !newClaimId
    || !branch
    || !forcedBy
    || !reason
    || !timestamp
    || !contextScope
  ) {
    return null;
  }

  if (oldClaimId === newClaimId) {
    return null;
  }

  if (contextScope === "issue-plus-pr" && !linkedPr) {
    return null;
  }

  if (contextScope === "issue-only" && linkedPr) {
    return null;
  }

  return {
    oldAgentId,
    oldClaimId,
    newAgentId,
    newClaimId,
    branch,
    ...(linkedPr ? { linkedPr } : {}),
    forcedBy,
    reason,
    timestamp,
    contextScope,
    ...(createdAt ? { createdAt } : {}),
  };
}

export function renderForcedHandoffConsentNote(payload) {
  const normalized = normalizeForcedHandoffPayload(payload);
  if (!normalized) {
    throw new Error("invalid forced handoff payload");
  }

  if (normalized.contextScope === "issue-plus-pr") {
    const prReference = /^\d+$/.test(normalized.linkedPr) ? `#${normalized.linkedPr}` : normalized.linkedPr;
    return [
      `Forced handoff approved by ${normalized.forcedBy}. I verified that the current`,
      "owning session or agent is unavailable. This transfers ownership away",
      `from claim \`${normalized.oldClaimId}\` on branch \`${normalized.branch}\` for PR ${prReference}.`,
      "If the prior session resumes, it must stop immediately and must not",
      "push, comment, resolve review state, or merge until a maintainer",
      "reassigns ownership.",
    ].join("\n");
  }

  return [
    `Forced handoff approved by ${normalized.forcedBy}. I verified that the current`,
    "owning session or agent is unavailable. This transfers ownership away",
    `from claim \`${normalized.oldClaimId}\` on branch \`${normalized.branch}\`.`,
    "If the prior session resumes, it must stop immediately and must not",
    "push, comment, resolve review state, or merge until a maintainer",
    "reassigns ownership.",
  ].join("\n");
}

export function renderForcedHandoffComment(payload) {
  const normalized = normalizeForcedHandoffPayload(payload);
  if (!normalized) {
    throw new Error("invalid forced handoff payload");
  }

  const markerPayload = {
    "old-agent-id": normalized.oldAgentId,
    "old-claim-id": normalized.oldClaimId,
    "new-agent-id": normalized.newAgentId,
    "new-claim-id": normalized.newClaimId,
    branch: normalized.branch,
    ...(normalized.linkedPr ? { "linked-pr": normalized.linkedPr } : {}),
    "forced-by": normalized.forcedBy,
    reason: normalized.reason,
    timestamp: normalized.timestamp,
    "context-scope": normalized.contextScope,
  };

  return `<!-- forced-handoff: ${JSON.stringify(markerPayload)} -->\n\n${renderForcedHandoffConsentNote(normalized)}`;
}

function normalizeExternalCheckWaiverField(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.includes("<!--") || trimmed.includes("-->")) {
    return "";
  }
  return trimmed;
}

function encodeExternalCheckWaiverField(value) {
  return encodeURIComponent(value);
}

function decodeExternalCheckWaiverField(value) {
  try {
    return decodeURIComponent(String(value ?? "").trim());
  } catch {
    return "";
  }
}

function renderExternalCheckWaiverNote(normalized) {
  const actor = normalizeNonWhitespaceToken(normalized.actor) || "idd-operator";
  return [
    `_${actor}: external check waiver for IDD F phase on \`${normalized.checkSelector}\``,
    `until \`${normalized.expiresAt}\` (reason: ${normalized.reason})._`,
  ].join(" ");
}

export function renderExternalCheckWaiverComment(payload) {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const checkSelector = normalizeExternalCheckWaiverField(payload?.checkSelector ?? payload?.check);
  const reason = normalizeExternalCheckWaiverField(payload?.reason);
  const expiresAt = normalizeIsoTimestamp(payload?.expiresAt ?? payload?.expires);

  if (!agentId || !claimId || !/^[0-9a-f]{40}$/.test(headSha) || !checkSelector || !reason || !expiresAt) {
    throw new Error("invalid external check waiver payload");
  }

  const encodedCheck = encodeExternalCheckWaiverField(checkSelector);
  const encodedReason = encodeExternalCheckWaiverField(reason);

  return [
    `<!-- idd-external-check-waiver: ${agentId} ${claimId} ${headSha} check:${encodedCheck} reason:${encodedReason} expires:${expiresAt} -->`,
    "",
    renderExternalCheckWaiverNote({
      actor: payload?.actor,
      checkSelector,
      reason,
      expiresAt,
    }),
  ].join("\n");
}

function matchCheckSelectorLocal(name, selector) {
  const n = String(name ?? "").trim();
  const s = String(selector ?? "").trim();
  if (!n || !s) return false;
  if (s.includes("*")) {
    const source = s.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${source}$`).test(n);
  }
  return n === s;
}

export function summarizeExternalCheckWaivers(comments, {
  prHeadSha = "",
  activeClaimId = "",
  trustedMarkerLogins = [],
  now = "",
} = {}) {
  const trustedSet = new Set(normalizeTrustedMarkerLogins(trustedMarkerLogins));
  const nowMs = isValidIsoTimestamp(now) ? new Date(now).getTime() : Date.now();
  const headShaLower = String(prHeadSha).toLowerCase();
  const activeClaimLower = String(activeClaimId);

  const valid = [];
  const expired = [];
  const wrongHead = [];
  const wrongClaim = [];
  const unauthorized = [];
  const malformed = [];

  for (const comment of comments ?? []) {
    const body = String(comment?.body ?? "");
    if (!body.includes("idd-external-check-waiver")) continue;

    const authorLogin = String(
      comment?.author?.login ?? comment?.user?.login ?? "",
    ).trim().toLowerCase();
    const createdAt = String(comment?.created_at ?? comment?.createdAt ?? "");
    const parsed = parseExternalCheckWaiverComment(body, createdAt);

    if (!parsed) {
      malformed.push({ authorLogin, bodyPreview: body.slice(0, 120) });
      continue;
    }

    if (!trustedSet.has(authorLogin)) {
      unauthorized.push({ authorLogin, checkSelector: parsed.checkSelector, expiresAt: parsed.expiresAt });
      continue;
    }

    if (headShaLower && parsed.headSha !== headShaLower) {
      wrongHead.push({ authorLogin, checkSelector: parsed.checkSelector, waiverHeadSha: parsed.headSha });
      continue;
    }

    if (activeClaimLower && parsed.claimId !== activeClaimLower) {
      wrongClaim.push({ authorLogin, checkSelector: parsed.checkSelector, waiverClaimId: parsed.claimId });
      continue;
    }

    const expiresMs = new Date(parsed.expiresAt).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      expired.push({ authorLogin, checkSelector: parsed.checkSelector, expiresAt: parsed.expiresAt });
      continue;
    }

    valid.push({
      authorLogin,
      checkSelector: parsed.checkSelector,
      reason: parsed.reason,
      expiresAt: parsed.expiresAt,
    });
  }

  return { valid, expired, wrongHead, wrongClaim, unauthorized, malformed };
}

export function parseExternalCheckWaiverComment(body, createdAt) {
  const match = body.trimEnd().match(
    new RegExp(
      `^<!--\\s*idd-external-check-waiver:\\s+(\\S+)\\s+(\\S+)\\s+([0-9a-f]{40})\\s+check:(\\S+)\\s+reason:(\\S+)\\s+expires:(\\S+)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
      "i",
    ),
  );
  if (!match) {
    return null;
  }

  const checkSelector = normalizeExternalCheckWaiverField(decodeExternalCheckWaiverField(match[4]));
  const reason = normalizeExternalCheckWaiverField(decodeExternalCheckWaiverField(match[5]));
  const expiresAt = normalizeIsoTimestamp(match[6]);
  if (!checkSelector || !reason || !expiresAt) {
    return null;
  }

  return {
    agentId: match[1],
    claimId: match[2],
    headSha: match[3].toLowerCase(),
    checkSelector,
    reason,
    expiresAt,
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : "none",
  };
}

export function parseReviewWatermarkComment(body, createdAt) {
  const match = body.trimEnd().match(
    new RegExp(
      `^<!--\\s*review-watermark:\\s+(\\S+)\\s+(\\S+)\\s+([0-9a-f]{40})\\s+(\\S+)\\s+(\\d+)\\s+(\\S+)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
      "i",
    ),
  );
  if (!match) {
    return null;
  }

  const maxActivityUpdatedAt = match[4];
  const latestCiCompletedAt = match[6];
  if (maxActivityUpdatedAt !== "none" && !isValidIsoTimestamp(maxActivityUpdatedAt)) {
    return null;
  }
  if (latestCiCompletedAt !== "none" && !isValidIsoTimestamp(latestCiCompletedAt)) {
    return null;
  }

  const totalItemCount = Number.parseInt(match[5], 10);
  if (!Number.isInteger(totalItemCount) || totalItemCount < 0) {
    return null;
  }

  return {
    agentId: match[1],
    claimId: match[2],
    headSha: match[3],
    maxActivityUpdatedAt,
    totalItemCount,
    latestCiCompletedAt,
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : "none",
  };
}

export function operationalMarkerPrefix(body) {
  const normalized = body.trimEnd();
  const marker = OPERATIONAL_MARKERS.find((candidate) => candidate.pattern.test(normalized));
  if (!marker) {
    return null;
  }
  if (marker.label === "<!-- forced-handoff:" && !isValidForcedHandoffOperationalMarker(normalized)) {
    return null;
  }
  return marker.label;
}

export function operationalMarkerPrefixByStart(body) {
  const normalized = body.trimStart();
  const marker = OPERATIONAL_MARKERS
    .find((candidate) => candidate.startPattern?.test(normalized) ?? normalized.startsWith(candidate.label));
  if (!marker) {
    return null;
  }
  if (marker.label === "<!-- forced-handoff:" && !isValidForcedHandoffOperationalMarker(normalized)) {
    return null;
  }
  return marker.label;
}

export function findLiveStatusDigestComments(comments) {
  return comments.filter((comment) => {
    return firstLine(comment.body ?? "") === LIVE_STATUS_DIGEST_MARKER;
  });
}

export function renderLiveStatusDigest(fields) {
  const normalized = normalizeLiveStatusDigestFields(fields);
  return `${LIVE_STATUS_DIGEST_MARKER}

| Field | Value |
| --- | --- |
| Phase | ${escapeMarkdownTableCell(normalized.phase)} |
| Claim | ${escapeMarkdownTableCell(normalized.claim)} |
| Branch | ${escapeMarkdownTableCell(normalized.branch)} |
| Last checked | ${escapeMarkdownTableCell(normalized.lastChecked)} |
| Open blockers | ${escapeMarkdownTableCell(normalized.openBlockers)} |
| Next action | ${escapeMarkdownTableCell(normalized.nextAction)} |
| Authoritative by | ${escapeMarkdownTableCell(normalized.authoritativeBy)} |
`;
}

export function planLiveStatusDigestUpsert(comments, fields) {
  const matches = findLiveStatusDigestComments(comments);
  const nextBody = renderLiveStatusDigest(fields);

  if (matches.length > 1) {
    return {
      action: "duplicate",
      canApply: false,
      body: null,
      duplicates: matches.map((comment) => ({
        id: comment.id ?? null,
        url: comment.html_url ?? comment.url ?? null,
        createdAt: comment.created_at ?? comment.createdAt ?? null,
        updatedAt: comment.updated_at ?? comment.updatedAt ?? null,
      })),
      repairPath: [
        "Multiple current live status digest comments were found.",
        "Do not delete or minimize any audit history during unattended execution.",
        "Use trusted markers and GitHub state for workflow decisions until a maintainer selects one current digest and converts stale duplicate markers to non-current digest text.",
      ].join(" "),
    };
  }

  if (matches.length === 0) {
    return {
      action: "create",
      canApply: true,
      body: nextBody,
      duplicates: [],
    };
  }

  const [current] = matches;
  if (sameDigestBody(current.body ?? "", nextBody)) {
    return {
      action: "noop",
      canApply: true,
      body: nextBody,
      commentId: current.id ?? null,
      url: current.html_url ?? current.url ?? null,
      duplicates: [],
    };
  }

  return {
    action: "update",
    canApply: true,
    body: nextBody,
    commentId: current.id ?? null,
    url: current.html_url ?? current.url ?? null,
    duplicates: [],
  };
}

export function unsafeTextReason(body) {
  for (const rule of UNSAFE_TEXT_RULES) {
    if (rule.pattern.test(body)) {
      return rule.reason;
    }
  }
  return null;
}

export function isKnownReviewBot(login) {
  const normalized = login.toLowerCase();
  return REVIEW_BOT_LOGINS.has(normalized) || normalized.startsWith("copilot-pull-request-reviewer");
}

export function isCodeRabbitLogin(login) {
  const normalized = login.toLowerCase();
  return normalized === "coderabbitai" || normalized === "coderabbitai[bot]";
}

export function classifyRegularBotComment(comment, comments, threads) {
  const author = comment.author?.login ?? "";
  if (!isCodeRabbitLogin(author)) {
    return null;
  }

  if (hasUnresolvedKnownBotThreads(threads)) {
    return null;
  }

  const body = (comment.body ?? "").trimStart();

  if (body.startsWith("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->")) {
    if (/No actionable comments were generated/i.test(body)) {
      return {
        classifier: "RESOLVED",
        reason: "CodeRabbit completed summary reported no actionable comments",
      };
    }
    if (
      hasExplicitDispositionAfter(comment, comments)
      || hasCompletedBotThreadDispositions(threads, isCodeRabbitLogin)
    ) {
      return {
        classifier: "RESOLVED",
        reason: "CodeRabbit completed summary has matched IDD disposition evidence",
      };
    }
    return null;
  }

  if (body.startsWith("<!-- This is an auto-generated reply by CodeRabbit -->")) {
    if (/\b(Review triggered|Sure! I'll review|I'll review)\b/i.test(body)
      && hasExplicitDispositionAfter(comment, comments)) {
      return {
        classifier: "OUTDATED",
        reason: "stale CodeRabbit review-trigger acknowledgement after completed review",
      };
    }
  }

  return null;
}

export function indexLatestGatingReviewsByAuthor(reviews) {
  const index = new Map();
  for (const review of reviews) {
    const state = String(review.state ?? "");
    if (state === "COMMENTED" || state === "PENDING") {
      continue;
    }
    const author = review.author?.login?.toLowerCase();
    if (!author) {
      continue;
    }
    const effectiveSubmittedAt = normalizeGatingReviewTimestamp(review, state);
    if (!effectiveSubmittedAt) {
      continue;
    }
    const current = index.get(author);
    const currentTime = current ? Date.parse(current.submittedAt ?? current.submitted_at ?? "") : Number.NEGATIVE_INFINITY;
    const reviewTime = Date.parse(effectiveSubmittedAt);
    if (!current || reviewTime >= currentTime) {
      index.set(author, {
        ...review,
        submittedAt: effectiveSubmittedAt,
        submitted_at: effectiveSubmittedAt,
      });
    }
  }
  return index;
}

export function indexThreadsByReview(threads) {
  const index = new Map();

  for (const thread of threads) {
    const reviewIds = new Set(
      (thread.comments?.nodes ?? [])
        .map((comment) => comment.pullRequestReview?.id)
        .filter(Boolean),
    );

    for (const reviewId of reviewIds) {
      const current = index.get(reviewId) ?? {
        total: 0,
        unresolved: 0,
        missingDisposition: 0,
        incomplete: false,
        threadIds: [],
      };
      current.total += 1;
      if (!thread.isResolved) {
        current.unresolved += 1;
      }
      if (!hasFreshDisposition(thread)) {
        current.missingDisposition += 1;
      }
      if (thread.comments?.pageInfo?.hasNextPage) {
        current.incomplete = true;
      }
      current.threadIds.push(thread.id);
      index.set(reviewId, current);
    }
  }

  return index;
}

export function routeRejectedChangesRequestedReview(input) {
  const escalationPolicy = getReviewEscalationChangesRequestedPolicy(input?.policyConfig ?? {});
  const firstEscalationWindowMs = escalationPolicy.escalateAfterMs;
  const postEscalationWindowMs = escalationPolicy.releaseAfterEscalationMs;
  const totalWindowLabel = formatDurationLabel(firstEscalationWindowMs + postEscalationWindowMs);
  const firstWindowLabel = formatDurationLabel(firstEscalationWindowMs);

  const reviewState = String(input.reviewState ?? "");
  if (reviewState !== "CHANGES_REQUESTED") {
    return { route: "proceed", reason: "changes-requested state already cleared" };
  }

  const reviewerDisposition = String(input.reviewerDisposition ?? "none");
  if (reviewerDisposition === "disagreed") {
    return {
      route: "return-to-e1",
      reason: "reviewer disagreed with the rejection and the feedback must return to triage",
    };
  }
  if (reviewerDisposition === "agreed-state-cleared") {
    return {
      route: "hold-await-state-clear",
      reason: "reviewer agreement alone does not clear a changes-requested state",
    };
  }
  if (reviewerDisposition === "agreed-state-unchanged") {
    return {
      route: "hold-await-state-clear",
      reason: "reviewer agreement alone does not clear a changes-requested state",
    };
  }

  const maintainerDisposition = String(input.maintainerDisposition ?? "none");
  if (maintainerDisposition === "agreed-state-unchanged") {
    return {
      route: "hold-await-state-clear",
      reason: "maintainer agreement does not clear the original changes-requested state",
    };
  }

  const elapsedMs = Date.parse(input.now ?? "") - Date.parse(input.rejectionCommentCreatedAt ?? "");
  if (!Number.isFinite(elapsedMs)) {
    return {
      route: "hold-for-evidence",
      reason: "elapsed time cannot be computed for the rejected changes-requested review",
    };
  }

  if (elapsedMs < firstEscalationWindowMs) {
    return {
      route: "hold-before-escalation",
      reason: `still within the first ${firstWindowLabel} after the rejection reply`,
    };
  }

  const escalationElapsedMs = Date.parse(input.now ?? "") - Date.parse(input.escalationCommentCreatedAt ?? "");
  if (!Number.isFinite(escalationElapsedMs)) {
    return {
      route: "escalate-maintainer",
      reason:
        `the changes-requested review is still blocking after ${firstWindowLabel} with no reviewer response`,
    };
  }
  if (escalationElapsedMs < postEscalationWindowMs) {
    return {
      route: "hold-after-escalation",
      reason:
        `still within ${formatDurationLabel(postEscalationWindowMs)} of the maintainer escalation comment`,
    };
  }
  return {
    route: "label-and-release",
    reason:
      `the changes-requested review is still blocking after ${totalWindowLabel} with no escalation response`,
  };
}

function formatDurationLabel(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "0 minutes";
  }
  if (milliseconds % (60 * 60 * 1000) === 0) {
    const hours = milliseconds / (60 * 60 * 1000);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (milliseconds % (60 * 1000) === 0) {
    const minutes = milliseconds / (60 * 1000);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = milliseconds / 1000;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function diffReviewSnapshot(snapshot, live) {
  if (String(live.headSha ?? "") !== String(snapshot.headSha ?? "")) {
    return { route: "return-to-e1", reason: "head-changed" };
  }

  const snapshotMax = normalizeComparableTimestamp(snapshot.maxActivityUpdatedAt);
  const liveMax = normalizeComparableTimestamp(live.maxActivityUpdatedAt);
  const snapshotCount = Number(snapshot.totalItemCount ?? 0);
  const liveCount = Number(live.totalItemCount ?? 0);
  if (snapshotMax === "none" && liveCount > 0) {
    return { route: "return-to-e1", reason: "snapshot-was-empty-now-nonempty" };
  }
  if (
    typeof snapshotMax === "number"
    && liveCount > 0
    && (liveMax === null || liveMax === "none")
  ) {
    return { route: "return-to-e1", reason: "missing-live-activity-evidence" };
  }
  if (typeof snapshotMax === "number" && typeof liveMax === "number" && liveMax > snapshotMax) {
    return { route: "return-to-e1", reason: "newer-activity" };
  }
  if (liveCount > snapshotCount) {
    return { route: "return-to-e1", reason: "same-timestamp-count-growth" };
  }

  const snapshotCi = normalizeComparableTimestamp(
    snapshot.latestPassingCiCompletedAt ?? snapshot.latestCiCompletedAt,
  );
  const liveCi = normalizeComparableTimestamp(
    live.latestPassingCiCompletedAt ?? live.latestCiCompletedAt,
  );
  if (snapshotCi === null || liveCi === null) {
    return { route: "return-to-e1", reason: "missing-ci-evidence" };
  }
  if (snapshotCi !== liveCi) {
    return { route: "return-to-e1", reason: "ci-pass-drift" };
  }

  return { route: "proceed", reason: "snapshot-current" };
}

export function classifyReviewThreadForGate(thread, options = {}) {
  if (thread.isResolved) {
    return { classification: "resolved" };
  }
  if (thread.comments?.pageInfo?.hasNextPage) {
    return { classification: "actionable-blocking" };
  }

  const comments = thread.comments?.nodes ?? [];
  const latestComment = comments.at(-1) ?? null;
  const latestCommentAt = normalizeComparableTimestamp(latestComment?.createdAt);
  const latestAuthor = String(latestComment?.author?.login ?? "").toLowerCase();
  const iddAgentLogins = new Set(
    (options.iddAgentLogins ?? [])
      .map((login) => String(login ?? "").toLowerCase())
      .filter(Boolean),
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? "").toLowerCase();
  const latestIsIddAgent = iddAgentLogins.has(latestAuthor);
  const latestIsPrAuthor = Boolean(prAuthorLogin) && latestAuthor === prAuthorLogin;
  let latestAmdIndex = -1;
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    const authorLogin = String(comment.author?.login ?? "").toLowerCase();
    if (
      iddAgentLogins.has(authorLogin)
      && AMD_MARKER_PATTERN.test(String(comment.body ?? "").trimStart())
    ) {
      latestAmdIndex = index;
    }
  }
  const reviewerReopenedAt = normalizeComparableTimestamp(inferReviewerReopenedAt(thread));
  const reopenedAfterLatestComment = typeof reviewerReopenedAt === "number"
    && (typeof latestCommentAt !== "number" || reviewerReopenedAt > latestCommentAt);
  const amdAwaitsMaintainer = latestAmdIndex >= 0
    && !reopenedAfterLatestComment
    && !comments.slice(latestAmdIndex + 1).some((comment) => {
      const authorLogin = String(comment.author?.login ?? "").toLowerCase();
      return !iddAgentLogins.has(authorLogin) && authorLogin !== prAuthorLogin;
    });

  if (amdAwaitsMaintainer) {
    return { classification: "amd-blocking" };
  }

  if (!(latestIsIddAgent || latestIsPrAuthor)) {
    return { classification: "actionable-blocking" };
  }

  if (reopenedAfterLatestComment) {
    return { classification: "actionable-blocking" };
  }

  if (options.requiresConversationResolution) {
    if (latestIsIddAgent) {
      return { classification: "conversation-resolve-agent" };
    }
    return { classification: "conversation-resolve-author" };
  }

  return { classification: "awaiting-reviewer" };
}

export function summarizeReviewThreadsForGate(threads, options = {}) {
  const summary = {
    actionableCount: 0,
    awaitingReviewerCount: 0,
    amdBlockingCount: 0,
    conversationResolveAgentCount: 0,
    conversationResolveAuthorCount: 0,
    classifications: [],
  };

  for (const thread of threads) {
    const result = classifyReviewThreadForGate(thread, options);
    if (result.classification === "resolved") {
      continue;
    }

    summary.classifications.push({
      id: thread.id,
      classification: result.classification,
    });

    if (result.classification === "actionable-blocking") {
      summary.actionableCount += 1;
      continue;
    }
    if (result.classification === "amd-blocking") {
      summary.amdBlockingCount += 1;
      summary.actionableCount += 1;
      continue;
    }
    if (result.classification === "awaiting-reviewer") {
      summary.awaitingReviewerCount += 1;
      continue;
    }
    if (result.classification === "conversation-resolve-agent") {
      summary.actionableCount += 1;
      summary.conversationResolveAgentCount += 1;
      continue;
    }
    if (result.classification === "conversation-resolve-author") {
      summary.actionableCount += 1;
      summary.conversationResolveAuthorCount += 1;
    }
  }

  return summary;
}

function inferReviewerReopenedAt(thread) {
  const explicit = String(thread.reviewerReopenedAt ?? "");
  if (isValidIsoTimestamp(explicit)) {
    return explicit;
  }
  return "";
}

export function hasFreshDisposition(thread, options = {}) {
  // IMPORTANT: The default disposition-author predicate rejects known bots but accepts any human.
  // For F2/F3 merge-gate contexts (E7 disposition evidence), callers MUST pass
  // options.isDispositionAuthor with an IDD-scoped predicate (e.g., via summarizeDispositionEvidenceForGate).
  // Callers that require IDD-only dispositions (e.g., audit-pr-cleanup) should pass:
  //   { isDispositionAuthor: (login) => iddAgentLogins.has(login) }
  // This design trades stricter default behavior for backward compatibility with utility functions.
  const dispositionAuthorPredicate =
    typeof options.isDispositionAuthor === "function"
      ? options.isDispositionAuthor
      : (login) => !isKnownReviewBot(login);
  const comments = thread.comments?.nodes ?? [];
  const latestFeedbackAt = maxIsoTimestamp(
    comments
      .filter((comment) => {
        const authorLogin = String(comment.author?.login ?? "").trim().toLowerCase();
        return !(isDispositionComment(comment) && dispositionAuthorPredicate(authorLogin));
      })
      .map((comment) => effectiveThreadCommentActivityAt(comment))
      .filter(isValidIsoTimestamp),
  );

  return comments.some((comment) => {
    const authorLogin = String(comment.author?.login ?? "").trim().toLowerCase();
    if (!(isDispositionComment(comment) && dispositionAuthorPredicate(authorLogin))) {
      return false;
    }
    const dispositionActivityAt = effectiveThreadCommentActivityAt(comment);
    if (!isValidIsoTimestamp(dispositionActivityAt)) {
      return false;
    }
    return !latestFeedbackAt || compareIsoTimestamps(dispositionActivityAt, latestFeedbackAt) > 0;
  });
}

export function isDispositionComment(comment) {
  const body = (comment.body ?? "").trimEnd();
  return body.startsWith("**Accepted**") || body.startsWith("**Rejected**");
}

export function isIddDispositionComment(comment) {
  const author = comment.author?.login ?? "";
  return isDispositionComment(comment) && !isKnownReviewBot(author);
}

export function classifyCiChecks(checks) {
  const normalized = checks.map((check) => ({
    name: check.name,
    state: String(check.state ?? "").toUpperCase(),
    completedAt: check.completedAt ?? null,
  }));

  const failed = normalized.filter((check) => check.state === "FAILURE");
  if (failed.length > 0) {
    return { status: "failed", failed };
  }

  const pending = normalized.filter((check) => {
    return check.state === "QUEUED" || check.state === "IN_PROGRESS" || check.state === "WAITING";
  });
  if (pending.length > 0) {
    return { status: "pending", pending };
  }

  const passing = normalized.filter((check) => {
    return [
      "SUCCESS",
      "SKIPPED",
      "NEUTRAL",
      "NOT_APPLICABLE",
    ].includes(check.state);
  });

  return {
    status: passing.length === normalized.length ? "success" : "unknown",
    passing,
    unknown: normalized.filter((check) => !passing.includes(check)),
  };
}

export function isCopilotReviewerLogin(login) {
  const normalized = String(login ?? "").trim().toLowerCase();
  return normalized === "copilot" || normalized.startsWith("copilot-pull-request-reviewer");
}

export function findLastCopilotReviewCommit(reviews) {
  const latest = reviews
    .filter((review) => isCopilotReviewerLogin(review.user?.login ?? review.author?.login ?? ""))
    .map((review) => ({
      submittedAt: review.submitted_at ?? review.submittedAt ?? "",
      commitId: review.commit_id ?? review.commitId ?? "",
    }))
    .sort((left, right) => compareIsoTimestamps(left.submittedAt, right.submittedAt))
    .at(-1);

  return latest?.commitId ?? "";
}

export function isCopilotPending(requestedReviewers) {
  return requestedReviewers.some((reviewer) => {
    if (typeof reviewer === "string") {
      return isCopilotReviewerLogin(reviewer);
    }
    return isCopilotReviewerLogin(reviewer?.login ?? reviewer?.user?.login ?? "");
  });
}

export function computeCopilotPendingCoversHead(timelineEvents, prHeadSha) {
  let headIndex = -1;
  let requestIndex = -1;

  timelineEvents.forEach((event, index) => {
    const eventName = String(event?.event ?? "");
    if (eventName === "committed") {
      const sha = String(event?.sha ?? event?.commit_id ?? "");
      if (sha === prHeadSha) {
        headIndex = index;
      }
      return;
    }

    if (eventName === "review_requested") {
      const reviewerLogin = event?.requested_reviewer?.login ?? "";
      if (isCopilotReviewerLogin(reviewerLogin)) {
        requestIndex = index;
      }
    }
  });

  return headIndex !== -1 && requestIndex !== -1 && requestIndex > headIndex;
}

export function normalizeTrustedMarkerLogins(logins) {
  return [...new Set(
    (logins ?? [])
      .map((login) => String(login ?? "").trim().toLowerCase())
      .filter(Boolean),
  )].sort();
}

export function deriveIddAgentLogins({
  viewerLogin = "",
  iddAgentLogins = [],
  trustedMarkerLogins = [],
  operationalComments = [],
} = {}) {
  const trustedLogins = new Set(normalizeTrustedMarkerLogins(trustedMarkerLogins));
  const derivedLogins = [
    viewerLogin,
    ...(iddAgentLogins ?? []),
  ];

  for (const comment of operationalComments ?? []) {
    const authorLogin = String(comment?.author?.login ?? comment?.user?.login ?? "").trim().toLowerCase();
    const body = String(comment?.body ?? "");
    const markerPrefix = operationalMarkerPrefix(body);
    if (
      !trustedLogins.has(authorLogin)
      || !markerPrefix
      || !IDD_AGENT_DERIVED_MARKERS.has(markerPrefix)
    ) {
      continue;
    }
    derivedLogins.push(authorLogin);
  }

  return normalizeTrustedMarkerLogins(derivedLogins);
}

export function summarizeAdvisoryWaitMarkers(comments, prHeadSha, trustedMarkerLogins) {
  const trustedLogins = new Set(normalizeTrustedMarkerLogins(trustedMarkerLogins));
  let earliestSameHeadAt = "";
  let trustedSameHeadMarkerCount = 0;
  let trustedRequestMarkerCount = 0;
  let untrustedSameHeadMarkerCount = 0;
  let untrustedRequestMarkerCount = 0;

  for (const comment of comments) {
    const body = String(comment?.body ?? "").trimEnd();
    const login = String(comment?.author?.login ?? comment?.user?.login ?? "").trim().toLowerCase();
    const trusted = trustedLogins.has(login);
    const isSameHeadMarker = advisoryWaitMarkerMatchesHead(body, prHeadSha);
    const isRequestMarker = advisoryWaitRequestMarker(body);

    if (isSameHeadMarker) {
      if (trusted) {
        trustedSameHeadMarkerCount += 1;
        const createdAt = String(comment?.createdAt ?? comment?.created_at ?? "");
        if (
          isValidIsoTimestamp(createdAt)
          && (!earliestSameHeadAt || compareIsoTimestamps(createdAt, earliestSameHeadAt) < 0)
        ) {
          earliestSameHeadAt = createdAt;
        }
      } else {
        untrustedSameHeadMarkerCount += 1;
      }
    }

    if (isRequestMarker) {
      if (trusted) {
        trustedRequestMarkerCount += 1;
      } else {
        untrustedRequestMarkerCount += 1;
      }
    }
  }

  return {
    sameHeadMarkerPresent: trustedSameHeadMarkerCount > 0,
    earliestSameHeadAt,
    sameHeadMarkerCount: trustedSameHeadMarkerCount,
    requestMarkerCount: trustedRequestMarkerCount,
    trustedSameHeadMarkerCount,
    untrustedSameHeadMarkerCount,
    trustedRequestMarkerCount,
    untrustedRequestMarkerCount,
  };
}

export function evaluateAdvisoryWaitOutcome(input) {
  const {
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
  } = normalizeAdvisoryWaitRuntimeOptions(input);

  if (input.lastCopilotCommit === input.prHeadSha) {
    return "SATISFIED";
  }

  if (input.copilotPending) {
    if (!input.sameHeadMarkerPresent) {
      return input.copilotPendingCoversHead
        ? "RECOVERY_NEEDED"
        : (input.requestMarkerCount >= requestCap ? "CAP_EXHAUSTED" : "REQUEST_NEEDED");
    }
    return input.elapsedMinutes >= pendingWindowMinutes ? "SATISFIED" : "WAIT";
  }

  if (!input.sameHeadMarkerPresent) {
    return input.requestMarkerCount >= requestCap ? "CAP_EXHAUSTED" : "REQUEST_NEEDED";
  }

  return input.elapsedMinutes >= settledWindowMinutes ? "SATISFIED" : "WAIT";
}

export function evaluateAdvisoryWaitF3Outcome(input) {
  if (input.lastCopilotCommit === input.prHeadSha || !input.copilotPending) {
    return "SATISFIED";
  }
  return evaluateAdvisoryWaitOutcome(input);
}

export function buildAdvisoryWaitSummary(
  {
    prHeadSha,
    reviews = [],
    requestedReviewers = [],
    timelineEvents = [],
    comments = [],
  },
  options = {},
) {
  const now = String(options.now ?? "");
  if (!isValidIsoTimestamp(now)) {
    throw new Error("now must be an ISO 8601 UTC timestamp");
  }
  if (!/^[0-9a-f]{40}$/.test(String(prHeadSha ?? ""))) {
    throw new Error("prHeadSha must be a 40-character lowercase commit SHA");
  }

  const trustedMarkerLogins = normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []);
  const configuredTrustedActors = normalizeTrustedMarkerLogins(options.configuredTrustedActors ?? []);
  const markerSummary = summarizeAdvisoryWaitMarkers(comments, prHeadSha, trustedMarkerLogins);
  const elapsedMinutes = markerSummary.sameHeadMarkerPresent
    ? minutesBetweenIso(markerSummary.earliestSameHeadAt, now)
    : 0;
  const lastCopilotCommit = findLastCopilotReviewCommit(reviews);
  const copilotPending = isCopilotPending(requestedReviewers);
  const copilotPendingCoversHead = computeCopilotPendingCoversHead(timelineEvents, prHeadSha);
  const {
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
    pollIntervalMinutes,
    capExhaustedRoute,
  } = normalizeAdvisoryWaitRuntimeOptions(options);

  return {
    protocolVersion: "1",
    prHeadSha,
    lastCopilotCommit,
    copilotPending,
    copilotPendingCoversHead,
    outcome: evaluateAdvisoryWaitOutcome({
      lastCopilotCommit,
      prHeadSha,
      copilotPending,
      copilotPendingCoversHead,
      sameHeadMarkerPresent: markerSummary.sameHeadMarkerPresent,
      requestMarkerCount: markerSummary.requestMarkerCount,
      elapsedMinutes,
      requestCap,
      pendingWindowMinutes,
      settledWindowMinutes,
    }),
    f3Outcome: evaluateAdvisoryWaitF3Outcome({
      lastCopilotCommit,
      prHeadSha,
      copilotPending,
      copilotPendingCoversHead,
      sameHeadMarkerPresent: markerSummary.sameHeadMarkerPresent,
      requestMarkerCount: markerSummary.requestMarkerCount,
      elapsedMinutes,
      requestCap,
      pendingWindowMinutes,
      settledWindowMinutes,
    }),
    now,
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
    pollIntervalMinutes,
    capExhaustedRoute,
    elapsedMinutes,
    sameHeadMarkerPresent: markerSummary.sameHeadMarkerPresent,
    earliestSameHeadAt: markerSummary.earliestSameHeadAt,
    sameHeadMarkerCount: markerSummary.sameHeadMarkerCount,
    requestMarkerCount: markerSummary.requestMarkerCount,
    trustedMarkerSummary: {
      viewerLogin: String(options.viewerLogin ?? "").trim().toLowerCase(),
      configuredTrustedActors,
      collaboratorTrustEnabled: Boolean(options.collaboratorTrustEnabled),
      trustedMarkerLogins,
      trustedSameHeadMarkerCount: markerSummary.trustedSameHeadMarkerCount,
      untrustedSameHeadMarkerCount: markerSummary.untrustedSameHeadMarkerCount,
      trustedRequestMarkerCount: markerSummary.trustedRequestMarkerCount,
      untrustedRequestMarkerCount: markerSummary.untrustedRequestMarkerCount,
    },
  };
}

export function buildActivitySnapshotSummary(
  {
    comments = [],
    reviews = [],
    threads = [],
    checks = [],
  },
  options = {},
) {
  const trustedMarkerLogins = new Set(
    (options.trustedMarkerLogins ?? [])
      .map((login) => String(login ?? "").trim().toLowerCase())
      .filter(Boolean),
  );

  const filteredComments = comments.filter((comment) => {
    if (!trustedMarkerLogins.has((comment.author?.login ?? "").toLowerCase())) {
      return true;
    }
    return operationalMarkerPrefixByStart(comment.body ?? "") === null;
  });

  const commentActivities = filteredComments
    .map((comment) => comment.updatedAt ?? comment.createdAt)
    .filter(isValidIsoTimestamp);
  const reviewActivities = reviews
    .map((review) => review.updatedAt ?? review.submittedAt ?? review.createdAt)
    .filter(isValidIsoTimestamp);
  const threadActivities = threads
    .map((thread) => threadActivityAt(thread))
    .filter(isValidIsoTimestamp);

  const latestCiCompletedAt = maxIsoTimestamp(
    checks
      .map((check) => check.completedAt)
      .filter(isCompletedCiTimestamp),
  ) ?? "none";

  const latestPassingCiCompletedAt = maxIsoTimestamp(
    checks
      .filter((check) => {
        const state = String(check.state ?? "").toUpperCase();
        return [
          "SUCCESS",
          "SKIPPED",
          "NEUTRAL",
          "NOT_APPLICABLE",
        ].includes(state);
      })
      .map((check) => check.completedAt)
      .filter(isCompletedCiTimestamp),
  ) ?? "none";

  const maxActivityUpdatedAt = maxIsoTimestamp([
    ...commentActivities,
    ...reviewActivities,
    ...threadActivities,
  ]) ?? "none";

  return {
    totalItemCount: filteredComments.length + reviews.length + threads.length,
    maxActivityUpdatedAt,
    latestCiCompletedAt,
    latestPassingCiCompletedAt,
    counts: {
      comments: filteredComments.length,
      reviews: reviews.length,
      threads: threads.length,
    },
  };
}

export function resolveLatestReviewWatermark(comments, options = {}) {
  const expectedClaimId = String(options.expectedClaimId ?? "").trim();
  const isTrustedAuthor = options.isTrustedAuthor ?? (() => true);

  let latest = null;
  for (const comment of comments) {
    if (!isTrustedAuthor(comment.author?.login ?? comment.user?.login ?? "")) {
      continue;
    }

    const parsed = parseReviewWatermarkComment(
      comment.body ?? "",
      comment.createdAt ?? comment.created_at ?? "",
    );
    if (!parsed) {
      continue;
    }
    if (expectedClaimId && parsed.claimId !== expectedClaimId) {
      continue;
    }
    const parsedCreatedAt = normalizeComparableTimestamp(parsed.createdAt);
    if (parsedCreatedAt === null || parsedCreatedAt === "none") {
      continue;
    }
    const latestCreatedAt = normalizeComparableTimestamp(latest?.createdAt ?? "none");
    if (latestCreatedAt === null || latestCreatedAt === "none" || parsedCreatedAt > latestCreatedAt) {
      latest = parsed;
    }
  }

  return latest;
}

export function summarizeRegularCommentsForGate(comments, options = {}) {
  const iddAgentLogins = new Set(normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []));
  const advisoryBotLogins = new Set(normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []));
  const trustedMarkerLogins = new Set(normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []));
  const threads = Array.isArray(options.threads) ? options.threads : [];

  const normalized = comments
    .map((comment, inputIndex) => ({
      id: String(comment.id ?? ""),
      authorLogin: String(comment.author?.login ?? comment.user?.login ?? "").trim().toLowerCase(),
      body: String(comment.body ?? ""),
      createdAt: String(comment.createdAt ?? comment.created_at ?? ""),
      updatedAt: String(comment.updatedAt ?? comment.updated_at ?? ""),
      inputIndex,
    }))
    .filter((comment) => isValidIsoTimestamp(comment.createdAt))
    .map((comment) => ({
      ...comment,
      activityAt: effectiveRegularCommentActivityAt(comment),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.activityAt);
      const rightTime = Date.parse(right.activityAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.inputIndex - right.inputIndex;
    })
    .map((comment, sortedIndex) => ({ ...comment, sortedIndex }));

  const lastIddReplyAt = normalized.reduce((latestTimestamp, comment) => {
    if (
      isOperationalOrDigestCommentForGate(comment.body, comment.authorLogin, trustedMarkerLogins)
      || !iddAgentLogins.has(comment.authorLogin)
    ) {
      return latestTimestamp;
    }
    if (!latestTimestamp || compareIsoTimestamps(comment.createdAt, latestTimestamp) > 0) {
      return comment.createdAt;
    }
    return latestTimestamp;
  }, "");

  const classificationComments = normalized.map((comment) => ({
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
  }));

  const items = normalized
    .filter((comment) => !isOperationalOrDigestCommentForGate(comment.body, comment.authorLogin, trustedMarkerLogins))
    .filter((comment) => !iddAgentLogins.has(comment.authorLogin))
    .filter((comment) => !lastIddReplyAt || compareIsoTimestamps(lastIddReplyAt, comment.activityAt) <= 0)
    .filter((comment) => {
      if (!isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins)) {
        return true;
      }
      return classifyRegularBotComment(
        {
          author: { login: comment.authorLogin },
          body: comment.body,
          createdAt: comment.createdAt,
        },
        classificationComments,
        threads,
      ) === null;
    })
    .map((comment) => ({
      id: comment.id,
      authorLogin: comment.authorLogin,
      createdAt: comment.createdAt,
      bodyPreview: buildBodyPreview(comment.body),
    }));

  return {
    count: items.length,
    items,
  };
}

export function summarizeDispositionEvidenceForGate(
  { comments = [], threads = [] },
  options = {},
) {
  const iddAgentLogins = new Set(normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []));
  const advisoryBotLogins = new Set(normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []));
  const trustedMarkerLogins = new Set(normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []));
  const prAuthorLogin = String(options.prAuthorLogin ?? "").trim().toLowerCase();

  const normalizedComments = comments
    .map((comment, inputIndex) => ({
      id: String(comment.id ?? ""),
      authorLogin: String(comment.author?.login ?? comment.user?.login ?? "").trim().toLowerCase(),
      body: String(comment.body ?? ""),
      createdAt: String(comment.createdAt ?? comment.created_at ?? ""),
      updatedAt: String(comment.updatedAt ?? comment.updated_at ?? ""),
      inputIndex,
    }))
    .filter((comment) => isValidIsoTimestamp(comment.createdAt))
    .map((comment) => ({
      ...comment,
      activityAt: effectiveRegularCommentActivityAt(comment),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.activityAt);
      const rightTime = Date.parse(right.activityAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.inputIndex - right.inputIndex;
    })
    .map((comment, sortedIndex) => ({ ...comment, sortedIndex }));

  const classificationComments = normalizedComments.map((comment) => ({
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
  }));

  const missingRegularComments = normalizedComments
    .filter((comment) => !isOperationalOrDigestCommentForGate(comment.body, comment.authorLogin, trustedMarkerLogins))
    .filter((comment) => !iddAgentLogins.has(comment.authorLogin))
    .filter((comment) => {
      if (!isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins)) {
        return true;
      }
      return classifyRegularBotComment(
        {
          author: { login: comment.authorLogin },
          body: comment.body,
          createdAt: comment.createdAt,
        },
        classificationComments,
        threads,
      ) === null;
    })
    .filter((comment) => {
      return !normalizedComments.some((reply) => {
        return iddAgentLogins.has(reply.authorLogin)
          && isDispositionComment({ body: reply.body })
          && compareIsoTimestamps(reply.activityAt, comment.activityAt) > 0;
      });
    })
    .map((comment) => ({
      id: comment.id || `comment-${comment.sortedIndex + 1}`,
      authorLogin: comment.authorLogin || "unknown",
      createdAt: comment.createdAt,
      bodyPreview: buildBodyPreview(comment.body),
    }));

  const missingThreads = (threads ?? [])
    .map((thread, index) => {
      const commentsInThread = thread.comments?.nodes ?? [];
      const hasExternalFeedback = commentsInThread.some((comment) => {
        const authorLogin = String(comment.author?.login ?? "").trim().toLowerCase();
        return authorLogin && !iddAgentLogins.has(authorLogin) && authorLogin !== prAuthorLogin;
      });
      if (!hasExternalFeedback) {
        return null;
      }
      if (thread.comments?.pageInfo?.hasNextPage) {
        return {
          id: String(thread.id ?? "") || `thread-${index + 1}`,
          isResolved: Boolean(thread.isResolved),
          reason: "incomplete-thread-comments",
        };
      }
      if (hasFreshDisposition(thread, {
        isDispositionAuthor: (login) => iddAgentLogins.has(String(login ?? "").trim().toLowerCase()),
      })) {
        return null;
      }
      return {
        id: String(thread.id ?? "") || `thread-${index + 1}`,
        isResolved: Boolean(thread.isResolved),
        reason: thread.isResolved
          ? "missing-fresh-disposition"
          : "unresolved-without-fresh-disposition",
      };
    })
    .filter(Boolean);

  const blockingCount = missingRegularComments.length + missingThreads.length;
  return {
    route: blockingCount > 0 ? "return-to-e1" : "proceed",
    reason: blockingCount > 0 ? "missing-disposition-evidence" : "complete",
    blockingCount,
    missingRegularCommentCount: missingRegularComments.length,
    missingThreadCount: missingThreads.length,
    missingRegularComments,
    missingThreads,
  };
}

export function summarizeBranchReviewRequirements(branchRules = [], branchProtection = {}) {
  const requiredCheckNames = new Set();
  const requiredReviewerLogins = new Set();
  const requiredReviewerTeams = new Set();
  const requiredReviewerRequirements = [];
  const classicBypassPullRequestUserLogins = new Set();
  const classicBypassPullRequestTeamSlugs = new Set();
  const classicBypassPullRequestAppSlugs = new Set();

  let requiredApprovingReviewCount = 0;
  let requireCodeOwnerReview = false;
  let classicRequireCodeOwnerReview = false;
  let requiresConversationResolution = false;
  let requiredCheckSourcePinned = false;

  for (const rule of branchRules) {
    if (rule?.type === "pull_request") {
      const parameters = rule.parameters ?? {};
      requiredApprovingReviewCount = Math.max(
        requiredApprovingReviewCount,
        Number(parameters.required_approving_review_count ?? 0) || 0,
      );
      requireCodeOwnerReview = requireCodeOwnerReview || Boolean(parameters.require_code_owner_review);
      requiresConversationResolution = requiresConversationResolution
        || Boolean(parameters.required_review_thread_resolution);

      for (const reviewer of parameters.required_reviewers ?? []) {
        const requirement = extractRequiredReviewerRequirement(reviewer);
        if (!requirement.identity) {
          continue;
        }
        requiredReviewerRequirements.push(requirement);
        if (requirement.identity.includes("/")) {
          requiredReviewerTeams.add(requirement.identity);
        } else {
          requiredReviewerLogins.add(requirement.identity);
        }
      }
      continue;
    }

    if (rule?.type === "required_status_checks") {
      const checkMetadata = summarizeRequiredCheckMetadata(rule.parameters ?? {});
      requiredCheckSourcePinned = requiredCheckSourcePinned || checkMetadata.sourcePinned;
      for (const name of checkMetadata.names) {
        requiredCheckNames.add(name);
      }
      continue;
    }

    if (rule?.type === "workflows") {
      requiredCheckSourcePinned = true;
    }
  }

  const protectionReviews = branchProtection.required_pull_request_reviews ?? {};
  classicRequireCodeOwnerReview = Boolean(protectionReviews.require_code_owner_reviews)
    || Boolean(protectionReviews.require_code_owner_review);
  for (const user of protectionReviews.bypass_pull_request_allowances?.users ?? []) {
    const login = typeof user === "string" ? user : user?.login;
    for (const normalizedLogin of normalizeTrustedMarkerLogins([login])) {
      classicBypassPullRequestUserLogins.add(normalizedLogin);
    }
  }
  for (const team of protectionReviews.bypass_pull_request_allowances?.teams ?? []) {
    const slug = typeof team === "string" ? team : team?.slug;
    for (const normalizedSlug of normalizeTrustedMarkerLogins([slug])) {
      classicBypassPullRequestTeamSlugs.add(normalizedSlug);
    }
  }
  for (const app of protectionReviews.bypass_pull_request_allowances?.apps ?? []) {
    const slug = typeof app === "string" ? app : app?.slug ?? app?.app_slug;
    for (const normalizedSlug of normalizeTrustedMarkerLogins([slug])) {
      classicBypassPullRequestAppSlugs.add(normalizedSlug);
    }
  }
  requiredApprovingReviewCount = Math.max(
    requiredApprovingReviewCount,
    Number(protectionReviews.required_approving_review_count ?? 0) || 0,
  );
  requireCodeOwnerReview = requireCodeOwnerReview || classicRequireCodeOwnerReview;
  requiresConversationResolution = requiresConversationResolution
    || Boolean(branchProtection.required_conversation_resolution?.enabled);

  const protectionCheckMetadata = summarizeRequiredCheckMetadata(
    branchProtection.required_status_checks ?? {},
  );
  requiredCheckSourcePinned = requiredCheckSourcePinned || protectionCheckMetadata.sourcePinned;
  for (const name of protectionCheckMetadata.names) {
    requiredCheckNames.add(name);
  }

  return {
    requiredApprovingReviewCount,
    requireCodeOwnerReview,
    classicRequireCodeOwnerReview,
    classicBypassPullRequestUserLogins: [...classicBypassPullRequestUserLogins].sort(),
    classicBypassPullRequestTeamSlugs: [...classicBypassPullRequestTeamSlugs].sort(),
    classicBypassPullRequestAppSlugs: [...classicBypassPullRequestAppSlugs].sort(),
    requiresConversationResolution,
    requiredCheckSourcePinned,
    requiredReviewerLogins: [...requiredReviewerLogins].sort(),
    requiredReviewerTeams: [...requiredReviewerTeams].sort(),
    requiredReviewerRequirements,
    requiredCheckNames: [...requiredCheckNames].sort(),
  };
}

export function summarizeRequiredChecks(checks = [], branchRules = [], branchProtection = {}, { waivers = null } = {}) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(branchRules, branchProtection);
  const requiredCheckNames = branchReviewRequirements.requiredCheckNames;
  const requiredCheckNameSet = new Set(requiredCheckNames);
  const validWaivers = waivers?.valid ?? [];
  const SUCCESS_STATES = new Set(["SUCCESS", "SKIPPED", "NEUTRAL", "NOT_APPLICABLE"]);

  const normalizedChecks = checks.map((check) => {
    const name = String(check.name ?? "");
    const state = String(check.state ?? "").toUpperCase();
    const coveredByWaiver = !SUCCESS_STATES.has(state)
      && validWaivers.some((w) => matchCheckSelectorLocal(name, w.checkSelector));
    return { name, state, completedAt: String(check.completedAt ?? ""), coveredByWaiver };
  });

  const matchedRequiredChecks = normalizedChecks.filter((check) => requiredCheckNameSet.has(check.name));
  const presentNames = new Set(matchedRequiredChecks.map((check) => check.name));
  const missingRequiredCheckNames = requiredCheckNames.filter((name) => !presentNames.has(name));

  let status = "unknown";
  if (requiredCheckNames.length > 0) {
    const effectiveChecks = matchedRequiredChecks.map((c) =>
      c.coveredByWaiver ? { ...c, state: "SKIPPED" } : c,
    );
    const ciClassification = classifyCiChecks(effectiveChecks);
    status = missingRequiredCheckNames.length > 0
      ? "missing"
      : ciClassification.status;
    if (status === "success" && branchReviewRequirements.requiredCheckSourcePinned) {
      status = "unknown";
    }
  }

  return {
    status,
    requiredCheckCount: requiredCheckNames.length,
    generatedRequiredCheckCount: matchedRequiredChecks.length,
    requiredChecksGenerated: requiredCheckNames.length > 0 && missingRequiredCheckNames.length === 0,
    requiredChecksPassing: requiredCheckNames.length > 0 && status === "success",
    requiredCheckNames,
    missingRequiredCheckNames,
    checks: normalizedChecks.map((check) => ({
      name: check.name,
      state: check.state,
      completedAt: isValidIsoTimestamp(check.completedAt) ? check.completedAt : "",
      required: requiredCheckNameSet.has(check.name),
      ...(check.coveredByWaiver ? { coveredByWaiver: true } : {}),
    })),
  };
}

export function resolveCodeownersForFiles(codeownersText, changedFiles = []) {
  const rules = parseCodeownersRules(codeownersText);
  return collectCodeownersForFiles(rules, changedFiles);
}

export function selectCodeownersText(payloads = []) {
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "content")) {
      continue;
    }
    const content = String(payload.content ?? "").replace(/\n/g, "");
    return Buffer.from(content, "base64").toString("utf8");
  }
  return "";
}

function collectCodeownersForFiles(rules, changedFiles = []) {
  const codeownerUsers = new Set();
  const codeownerTeams = new Set();
  const codeownerEmails = new Set();
  const unmatchedFiles = [];

  for (const filePath of changedFiles) {
    const normalizedPath = String(filePath ?? "").replace(/^\/+/, "");
    if (!normalizedPath) {
      continue;
    }

    const owners = findCodeownersForPath(rules, normalizedPath);
    if (!owners) {
      unmatchedFiles.push(normalizedPath);
      continue;
    }
    if (!hasCodeownerOwners(owners)) {
      continue;
    }

    for (const owner of owners.users) {
      codeownerUsers.add(owner);
    }
    for (const owner of owners.teams) {
      codeownerTeams.add(owner);
    }
    for (const owner of owners.emails) {
      codeownerEmails.add(owner);
    }
  }

  return {
    ruleCount: rules.length,
    changedFileCount: changedFiles.length,
    unmatchedFiles,
    codeownerUserLogins: [...codeownerUsers].sort(),
    codeownerTeamSlugs: [...codeownerTeams].sort(),
    codeownerEmailAddresses: [...codeownerEmails].sort(),
  };
}

export function summarizeReviewerStates(
  reviews = [],
  {
    reviewDecision = "",
    branchRules = [],
    branchRulesets = [],
    branchProtection = {},
    codeownersText = "",
    changedFiles = [],
    eligibleCodeownerUserLogins = null,
    advisoryBotLogins = [],
    prAuthorLogin = "",
    viewerLogin = "",
    viewerTeamSlugs = [],
    viewerAppSlug = "",
  } = {},
) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(branchRules, branchProtection);
  const requiredReviewerLogins = new Set(branchReviewRequirements.requiredReviewerLogins);
  const advisoryBotLoginSet = new Set(normalizeTrustedMarkerLogins(advisoryBotLogins));
  const codeownerRules = parseCodeownersRules(codeownersText);
  const codeowners = collectCodeownersForFiles(codeownerRules, changedFiles);
  const codeownerUsers = new Set(codeowners.codeownerUserLogins);
  const eligibleCodeownerUsers = eligibleCodeownerUserLogins === null
    ? codeownerUsers
    : new Set(
      normalizeTrustedMarkerLogins(eligibleCodeownerUserLogins)
        .filter((login) => codeownerUsers.has(login)),
    );
  const normalizedReviewDecision = String(reviewDecision ?? "");

  const latestByAuthor = [...indexLatestGatingReviewsByAuthor(reviews).values()]
    .map((review) => {
      const login = String(review.author?.login ?? "").trim().toLowerCase();
      const isAdvisoryBot = isGateAdvisoryBotLogin(login, advisoryBotLoginSet);
      const isCodeowner = eligibleCodeownerUsers.has(login);
      const isRequiredReviewer = requiredReviewerLogins.has(login);
      return {
        login,
        state: String(review.state ?? ""),
        submittedAt: String(review.submittedAt ?? review.submitted_at ?? ""),
        isHuman: !isAdvisoryBot,
        isAdvisoryBot,
        isCodeowner,
        isRequiredReviewer,
      };
    })
    .sort((left, right) => left.login.localeCompare(right.login));

  const blockingChangesRequestedLogins = latestByAuthor
    .filter((review) => {
      return review.state === "CHANGES_REQUESTED"
        && !review.isAdvisoryBot;
    })
    .map((review) => review.login);

  const humanApprovedCount = latestByAuthor.filter((review) => {
    return review.isHuman && review.state === "APPROVED";
  }).length;
  const codeownerApproved = latestByAuthor.some((review) => {
    return review.isCodeowner && review.state === "APPROVED";
  });
  const hasExplicitCodeownerMatches = changedFiles.some((filePath) => {
    const normalizedPath = String(filePath ?? "").replace(/^\/+/, "");
    if (!normalizedPath) {
      return false;
    }
    const owners = findCodeownersForPath(codeownerRules, normalizedPath);
    return !!owners && hasCodeownerOwners(owners);
  });
  const latestByLogin = new Map(latestByAuthor.map((review) => [review.login, review]));
  const requiredReviewerApprovalsSatisfied = branchReviewRequirements.requiredReviewerRequirements
    .every((requirement) => {
      if (
        requirement.filePatterns.length > 0
        && !changedFiles.some((filePath) => {
          return requirement.filePatterns.some((pattern) => matchesCodeownersPattern(pattern, filePath));
        })
      ) {
        return true;
      }
      if ((requirement.minimumApprovals ?? 0) <= 0) {
        return true;
      }
      if (normalizedReviewDecision === "APPROVED") {
        return true;
      }
      if (requirement.identity.includes("/")) {
        return false;
      }
      return latestByLogin.get(requirement.identity)?.state === "APPROVED";
    });
  const codeownerSelfApproval = summarizeCodeownerSelfApproval({
    requireCodeOwnerReview: branchReviewRequirements.requireCodeOwnerReview,
    codeownerApprovalSatisfied:
      !branchReviewRequirements.requireCodeOwnerReview
        || !hasExplicitCodeownerMatches
        || codeownerApproved
        || normalizedReviewDecision === "APPROVED",
    hasExplicitCodeownerMatches,
    codeownerUserLogins: codeowners.codeownerUserLogins,
    eligibleCodeownerUserLogins:
      eligibleCodeownerUserLogins === null ? null : [...eligibleCodeownerUsers].sort(),
    codeownerTeamSlugs: codeowners.codeownerTeamSlugs,
    codeownerEmailAddresses: codeowners.codeownerEmailAddresses,
    prAuthorLogin,
    viewerLogin,
    viewerTeamSlugs,
    viewerAppSlug,
    branchRules,
    branchRulesets,
    classicRequireCodeOwnerReview: branchReviewRequirements.classicRequireCodeOwnerReview,
    classicBypassPullRequestUserLogins: branchReviewRequirements.classicBypassPullRequestUserLogins,
    classicBypassPullRequestTeamSlugs: branchReviewRequirements.classicBypassPullRequestTeamSlugs,
    classicBypassPullRequestAppSlugs: branchReviewRequirements.classicBypassPullRequestAppSlugs,
  });

  return {
    reviewDecision: normalizedReviewDecision,
    requiredApprovingReviewCount: branchReviewRequirements.requiredApprovingReviewCount,
    requireCodeOwnerReview: branchReviewRequirements.requireCodeOwnerReview,
    requiresConversationResolution: branchReviewRequirements.requiresConversationResolution,
    requiredReviewerLogins: branchReviewRequirements.requiredReviewerLogins,
    requiredReviewerTeams: branchReviewRequirements.requiredReviewerTeams,
    codeownerUserLogins: codeowners.codeownerUserLogins,
    codeownerTeamSlugs: codeowners.codeownerTeamSlugs,
    unmatchedCodeownerFiles: codeowners.unmatchedFiles,
    latestByAuthor,
    humanApprovedCount,
    requiredApprovalsSatisfied:
      requiredReviewerApprovalsSatisfied
      && (
        normalizedReviewDecision === "APPROVED"
        || (
          !normalizedReviewDecision
          && (
            branchReviewRequirements.requiredApprovingReviewCount === 0
            || humanApprovedCount >= branchReviewRequirements.requiredApprovingReviewCount
          )
        )
      ),
    codeownerApprovalSatisfied:
      !branchReviewRequirements.requireCodeOwnerReview
        || !hasExplicitCodeownerMatches
        || codeownerApproved
        || normalizedReviewDecision === "APPROVED",
    codeownerSelfApproval,
    humanChangesRequestedCount: blockingChangesRequestedLogins.length,
    blockingChangesRequestedLogins,
  };
}

function summarizeCodeownerSelfApproval({
  requireCodeOwnerReview,
  codeownerApprovalSatisfied,
  hasExplicitCodeownerMatches,
  codeownerUserLogins = [],
  eligibleCodeownerUserLogins = null,
  codeownerTeamSlugs = [],
  codeownerEmailAddresses = [],
  prAuthorLogin = "",
  viewerLogin = "",
  viewerTeamSlugs = [],
  viewerAppSlug = "",
  branchRules = [],
  branchRulesets = [],
  classicRequireCodeOwnerReview = false,
  classicBypassPullRequestUserLogins = [],
  classicBypassPullRequestTeamSlugs = [],
  classicBypassPullRequestAppSlugs = [],
}) {
  const normalizedAuthor = String(prAuthorLogin ?? "").trim().toLowerCase();
  const normalizedViewer = String(viewerLogin ?? "").trim().toLowerCase();
  const normalizedViewerAppSlug = String(viewerAppSlug ?? "").trim().toLowerCase();
  const normalizedViewerTeamSlugs = normalizeTrustedMarkerLogins(viewerTeamSlugs);
  const directCodeownerUserLogins = normalizeTrustedMarkerLogins(codeownerUserLogins);
  const eligibleDirectCodeownerUserLogins = eligibleCodeownerUserLogins === null
    ? directCodeownerUserLogins
    : normalizeTrustedMarkerLogins(eligibleCodeownerUserLogins)
      .filter((login) => directCodeownerUserLogins.includes(login));
  const normalizedCodeownerTeamSlugs = normalizeTrustedMarkerLogins(codeownerTeamSlugs);
  const normalizedCodeownerEmailAddresses = normalizeTrustedMarkerLogins(codeownerEmailAddresses);
  const classicBypassDetected = Boolean(
    Boolean(classicRequireCodeOwnerReview)
    && (
      (
        normalizedViewer
        && normalizeTrustedMarkerLogins(classicBypassPullRequestUserLogins).includes(normalizedViewer)
      )
      || normalizedViewerTeamSlugs.some((slug) => {
        return normalizeTrustedMarkerLogins(classicBypassPullRequestTeamSlugs).includes(slug);
      })
      || (
        normalizedViewerAppSlug
        && normalizeTrustedMarkerLogins(classicBypassPullRequestAppSlugs).includes(normalizedViewerAppSlug)
      )
    ),
  );
  const bypass = summarizeRulesetPullRequestBypass(branchRulesets, branchRules);
  const rulesetGateSatisfiedByBypass = bypass.relevantRulesetCount === 0 || bypass.detected;
  const classicGateSatisfiedByBypass = !classicRequireCodeOwnerReview || classicBypassDetected;
  const applicableBypassDetected = (bypass.detected || classicBypassDetected)
    && rulesetGateSatisfiedByBypass
    && classicGateSatisfiedByBypass;
  const applicableBypassMode = applicableBypassDetected
    ? (bypass.detected ? bypass.mode : "pull_request")
    : "none";
  const base = {
    status: "not_applicable",
    reason: "codeowner-review-not-required",
    prAuthorLogin: normalizedAuthor,
    directCodeownerUserLogins,
    codeownerTeamSlugs: normalizedCodeownerTeamSlugs,
    requireCodeOwnerReview: Boolean(requireCodeOwnerReview),
    codeownerApprovalSatisfied: Boolean(codeownerApprovalSatisfied),
    bypassDetected: applicableBypassDetected,
    bypassMode: applicableBypassMode,
    currentUserCanBypass: bypass.currentUserCanBypass,
  };

  if (!requireCodeOwnerReview) {
    return base;
  }
  if (!hasExplicitCodeownerMatches) {
    return {
      ...base,
      reason: "no-explicit-codeowner-match",
    };
  }
  if (codeownerApprovalSatisfied) {
    return {
      ...base,
      reason: "codeowner-approval-satisfied",
    };
  }
  if (applicableBypassDetected) {
    return {
      ...base,
      status: "clear",
      reason: applicableBypassMode === "pull_request"
        ? "pull-request-bypass-available"
        : "ruleset-bypass-available",
    };
  }
  if (!normalizedAuthor) {
    return {
      ...base,
      status: "possible_deadlock",
      reason: "pr-author-unknown",
    };
  }

  const allDirectUsersAreAuthor = eligibleDirectCodeownerUserLogins.length > 0
    && eligibleDirectCodeownerUserLogins.every((login) => login === normalizedAuthor);
  const hasNonAuthorDirectUser = eligibleDirectCodeownerUserLogins.some((login) => login !== normalizedAuthor);

  if (hasNonAuthorDirectUser) {
    return {
      ...base,
      status: "clear",
      reason: "non-author-codeowner-available",
    };
  }
  if (normalizedCodeownerTeamSlugs.length > 0) {
    return {
      ...base,
      status: "possible_deadlock",
      reason: "team-codeowner-ambiguous",
    };
  }
  if (normalizedCodeownerEmailAddresses.length > 0) {
    return {
      ...base,
      status: "possible_deadlock",
      reason: "email-codeowner-ambiguous",
    };
  }
  if (allDirectUsersAreAuthor) {
    return {
      ...base,
      status: "deadlock",
      reason: eligibleCodeownerUserLogins === null
        ? "pr-author-is-only-direct-codeowner"
        : "pr-author-is-only-eligible-direct-codeowner",
    };
  }

  return {
    ...base,
    status: "possible_deadlock",
    reason: "no-reviewable-codeowner-identity",
  };
}

function summarizeRulesetPullRequestBypass(branchRulesets = [], branchRules = []) {
  const codeownerRulesetIds = new Set(
    (branchRules ?? [])
      .filter((rule) => {
        return rule?.type === "pull_request"
          && Boolean(rule?.parameters?.require_code_owner_review);
      })
      .map((rule) => Number.parseInt(String(rule?.ruleset_id ?? ""), 10))
      .filter(Number.isInteger),
  );
  const expectedRulesetCount = codeownerRulesetIds.size;
  const relevantRulesets = (branchRulesets ?? [])
    .filter((ruleset) => {
      const rulesetId = Number.parseInt(String(ruleset?.id ?? ruleset?.ruleset_id ?? ""), 10);
      return codeownerRulesetIds.has(rulesetId);
    });
  const values = relevantRulesets
    .map((ruleset) => String(ruleset?.current_user_can_bypass ?? "").trim())
    .map((value) => {
      return ["always", "exempt", "never", "pull_requests_only"].includes(value)
        ? value
        : "unknown";
    })
    .filter(Boolean);
  let currentUserCanBypass = "unknown";
  if (values.length > 1 && new Set(values).size > 1) {
    currentUserCanBypass = "mixed";
  } else if (values.includes("exempt")) {
    currentUserCanBypass = "exempt";
  } else if (values.includes("pull_requests_only")) {
    currentUserCanBypass = "pull_requests_only";
  } else if (values.includes("always")) {
    currentUserCanBypass = "always";
  } else if (values.includes("never")) {
    currentUserCanBypass = "never";
  }
  const bypassValues = new Set(["always", "exempt", "pull_requests_only"]);
  const detected = expectedRulesetCount > 0
    && relevantRulesets.length === expectedRulesetCount
    && values.length === relevantRulesets.length
    && values.every((value) => bypassValues.has(value));
  let mode = "none";
  if (detected) {
    if (new Set(values).size > 1) {
      mode = "mixed";
    } else if (values.includes("pull_requests_only")) {
      mode = "pull_request";
    } else if (values.includes("always")) {
      mode = "always";
    } else if (values.includes("exempt")) {
      mode = "exempt";
    }
  }
  return {
    detected,
    mode,
    currentUserCanBypass,
    relevantRulesetCount: expectedRulesetCount,
  };
}

export function resolveRulesetDetailPath(owner, repo, rule, rulesetId) {
  const sourceType = String(rule?.ruleset_source_type ?? rule?.source_type ?? "")
    .trim()
    .toLowerCase();
  if (sourceType === "organization") {
    const source = String(rule?.ruleset_source ?? rule?.source ?? owner).trim();
    const org = source.split("/")[0] || owner;
    return `orgs/${encodeURIComponent(org)}/rulesets/${rulesetId}`;
  }
  if (sourceType === "enterprise") {
    const source = String(rule?.ruleset_source ?? rule?.source ?? "").trim();
    const enterprise = source.split("/")[0];
    if (enterprise) {
      return `enterprises/${encodeURIComponent(enterprise)}/rulesets/${rulesetId}`;
    }
  }
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rulesets/${rulesetId}`;
}

export function summarizeClaimValidation(claimEvents = [], options = {}) {
  const trustedMarkerLogins = new Set(normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []));
  const authorizedForcedHandoffLogins = new Set(
    normalizeTrustedMarkerLogins(options.authorizedForcedHandoffLogins ?? []),
  );
  const expectedLinkedPrReferences = new Set(
    (options.expectedLinkedPrs ?? [])
      .map((value) => normalizeLinkedPrReference(value))
      .filter(Boolean),
  );
  const expectedClaimId = String(options.expectedClaimId ?? "").trim();
  const expectedAgentId = String(options.expectedAgentId ?? "").trim();
  const trustedAuthorPredicate =
    typeof options.isTrustedAuthor === "function"
      ? options.isTrustedAuthor
      : (login) => trustedMarkerLogins.has(String(login ?? "").trim().toLowerCase());

  const activeClaim = resolveActiveClaim(
    claimEvents,
    {
      isTrustedAuthor: trustedAuthorPredicate,
      isForcedHandoffEnabled:
        typeof options.isForcedHandoffEnabled === "function"
          ? options.isForcedHandoffEnabled
          : (forcedHandoff) => {
            if (options.forcedHandoffEnabled !== true) {
              return false;
            }
            if (expectedLinkedPrReferences.size === 0) {
              return true;
            }
            if (forcedHandoff.contextScope !== "issue-plus-pr") {
              return false;
            }
            return expectedLinkedPrReferences.has(normalizeLinkedPrReference(forcedHandoff.linkedPr));
          },
      isAuthorizedForcedHandoff:
        typeof options.isAuthorizedForcedHandoff === "function"
          ? options.isAuthorizedForcedHandoff
          : (forcedBy) => {
            if (authorizedForcedHandoffLogins.size === 0) {
              return false;
            }
            return authorizedForcedHandoffLogins.has(String(forcedBy ?? "").trim().toLowerCase());
          },
    },
  );

  let reason = "match";
  if (!activeClaim) {
    reason = "missing-active-claim";
  } else if (expectedClaimId && activeClaim.claimId !== expectedClaimId) {
    reason = "claim-id-mismatch";
  } else if (expectedAgentId && activeClaim.agentId !== expectedAgentId) {
    reason = "agent-id-mismatch";
  }

  return {
    expectedClaimId,
    expectedAgentId,
    activeClaimPresent: Boolean(activeClaim),
    activeClaim: {
      agentId: activeClaim?.agentId ?? "",
      claimId: activeClaim?.claimId ?? "",
      supersedes: activeClaim?.supersedes ?? "",
      branch: activeClaim?.branch ?? "",
      createdAt: activeClaim?.createdAt ?? "",
    },
    matchesExpectedClaim: reason === "match",
    claimLost: reason !== "match",
    reason,
  };
}

export function buildPreMergeReadinessSummary(
  {
    prHeadSha,
    comments = [],
    reviews = [],
    threads = [],
    checks = [],
    branchRules = [],
    branchRulesets = [],
    branchProtection = {},
    requestedReviewers = [],
    timelineEvents = [],
    claimEvents = [],
    changedFiles = [],
    codeownersText = "",
    eligibleCodeownerUserLogins = null,
    reviewDecision = "",
  },
  options = {},
) {
  const now = String(options.now ?? "");
  if (!isValidIsoTimestamp(now)) {
    throw new Error("now must be an ISO 8601 UTC timestamp");
  }
  if (!/^[0-9a-f]{40}$/.test(String(prHeadSha ?? ""))) {
    throw new Error("prHeadSha must be a 40-character lowercase commit SHA");
  }

  const trustedMarkerLogins = normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []);
  const iddAgentLogins = normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []);
  const advisoryBotLogins = normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []);
  const prAuthorLogin = String(options.prAuthorLogin ?? "").trim().toLowerCase();
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const liveSnapshot = buildActivitySnapshotSummary(
    {
      comments,
      reviews,
      threads,
      checks,
    },
    { trustedMarkerLogins },
  );
  const watermark = resolveLatestReviewWatermark(comments, {
    expectedClaimId: options.expectedClaimId,
    isTrustedAuthor: (login) => trustedMarkerLogins.includes(String(login ?? "").trim().toLowerCase()),
  });
  const reviewCurrency = watermark
    ? diffReviewSnapshot(
      {
        headSha: watermark.headSha,
        maxActivityUpdatedAt: watermark.maxActivityUpdatedAt,
        totalItemCount: watermark.totalItemCount,
        latestPassingCiCompletedAt: watermark.latestCiCompletedAt,
      },
      {
        headSha: prHeadSha,
        ...liveSnapshot,
      },
    )
    : { route: "return-to-e1", reason: "missing-watermark" };
  const threadSummary = summarizeReviewThreadsForGate(threads, {
    iddAgentLogins,
    prAuthorLogin,
    requiresConversationResolution: branchReviewRequirements.requiresConversationResolution,
  });
  const unrepliedComments = summarizeRegularCommentsForGate(comments, {
    iddAgentLogins,
    advisoryBotLogins,
    trustedMarkerLogins,
    threads,
  });
  const reviewerStates = summarizeReviewerStates(reviews, {
    reviewDecision,
    branchRules,
    branchRulesets,
    branchProtection,
    codeownersText,
    changedFiles,
    eligibleCodeownerUserLogins,
    advisoryBotLogins,
    prAuthorLogin,
    viewerLogin: options.viewerLogin,
    viewerTeamSlugs: options.viewerTeamSlugs,
    viewerAppSlug: options.viewerAppSlug,
  });
  const advisoryWaitOptions = normalizeAdvisoryWaitRuntimeOptions(options);
  const advisoryWait = buildAdvisoryWaitSummary(
    {
      prHeadSha,
      reviews,
      requestedReviewers,
      timelineEvents,
      comments,
    },
    {
      now,
      ...advisoryWaitOptions,
      viewerLogin: options.viewerLogin,
      configuredTrustedActors: options.configuredTrustedActors,
      collaboratorTrustEnabled: options.collaboratorTrustEnabled,
      trustedMarkerLogins,
    },
  );
  const claim = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins,
    forcedHandoffEnabled: options.forcedHandoffEnabled === true,
    expectedLinkedPrs: options.expectedLinkedPrs ?? [],
    authorizedForcedHandoffLogins: options.authorizedForcedHandoffLogins,
    isAuthorizedForcedHandoff: options.isAuthorizedForcedHandoff,
    isForcedHandoffEnabled: options.isForcedHandoffEnabled,
    expectedClaimId: options.expectedClaimId,
    expectedAgentId: options.expectedAgentId,
  });
  const waiverEvidence = summarizeExternalCheckWaivers(comments, {
    prHeadSha,
    activeClaimId: claim.activeClaim?.claimId ?? options.activeClaimId ?? "",
    trustedMarkerLogins,
    now,
  });
  const ci = summarizeRequiredChecks(checks, branchRules, branchProtection, { waivers: waiverEvidence });

  const dispositionEvidence = options.includeDispositionEvidence
    ? summarizeDispositionEvidenceForGate(
      { comments, threads },
      {
        iddAgentLogins,
        advisoryBotLogins,
        trustedMarkerLogins,
        prAuthorLogin,
      },
    )
    : null;

  const summary = {
    protocolVersion: "1",
    decisionAuthority: "instructions",
    prHeadSha,
    now,
    reviewCurrency: {
      watermarkPresent: Boolean(watermark),
      watermark: {
        agentId: watermark?.agentId ?? "",
        claimId: watermark?.claimId ?? "",
        headSha: watermark?.headSha ?? "",
        maxActivityUpdatedAt: watermark?.maxActivityUpdatedAt ?? "none",
        totalItemCount: watermark?.totalItemCount ?? 0,
        latestCiCompletedAt: watermark?.latestCiCompletedAt ?? "none",
        createdAt: watermark?.createdAt ?? "none",
      },
      live: {
        totalItemCount: liveSnapshot.totalItemCount,
        maxActivityUpdatedAt: liveSnapshot.maxActivityUpdatedAt,
        latestCiCompletedAt: liveSnapshot.latestCiCompletedAt,
        latestPassingCiCompletedAt: liveSnapshot.latestPassingCiCompletedAt,
        counts: liveSnapshot.counts,
      },
      comparisonRoute: reviewCurrency.route,
      comparisonReason: reviewCurrency.reason,
    },
    threads: {
      unresolvedCount: threads.filter((thread) => !thread.isResolved).length,
      actionableCount: threadSummary.actionableCount,
      awaitingReviewerCount: threadSummary.awaitingReviewerCount,
      amdBlockingCount: threadSummary.amdBlockingCount,
      conversationResolveAgentCount: threadSummary.conversationResolveAgentCount,
      conversationResolveAuthorCount: threadSummary.conversationResolveAuthorCount,
      classifications: threadSummary.classifications,
    },
    unrepliedComments,
    reviewerStates,
    advisoryWait: {
      outcome: advisoryWait.outcome,
      f3Outcome: advisoryWait.f3Outcome,
      lastCopilotCommit: advisoryWait.lastCopilotCommit,
      copilotPending: advisoryWait.copilotPending,
      copilotPendingCoversHead: advisoryWait.copilotPendingCoversHead,
      sameHeadMarkerPresent: advisoryWait.sameHeadMarkerPresent,
      earliestSameHeadAt: advisoryWait.earliestSameHeadAt,
      sameHeadMarkerCount: advisoryWait.sameHeadMarkerCount,
      requestMarkerCount: advisoryWait.requestMarkerCount,
      requestCap: advisoryWait.requestCap,
      pendingWindowMinutes: advisoryWait.pendingWindowMinutes,
      settledWindowMinutes: advisoryWait.settledWindowMinutes,
      pollIntervalMinutes: advisoryWait.pollIntervalMinutes,
      capExhaustedRoute: advisoryWait.capExhaustedRoute,
      elapsedMinutes: advisoryWait.elapsedMinutes,
    },
    ci,
    claim,
    waiverEvidence,
  };

  if (dispositionEvidence) {
    summary.dispositionEvidence = dispositionEvidence;
  }

  return summary;
}

function normalizeLiveStatusDigestFields(fields) {
  const normalized = {
    phase: normalizeDigestField(fields.phase, "Phase"),
    claim: normalizeDigestField(fields.claim, "Claim"),
    branch: normalizeDigestField(fields.branch, "Branch"),
    lastChecked: normalizeDigestField(fields.lastChecked, "Last checked"),
    openBlockers: normalizeDigestField(fields.openBlockers, "Open blockers"),
    nextAction: normalizeDigestField(fields.nextAction, "Next action"),
    authoritativeBy: normalizeDigestField(fields.authoritativeBy, "Authoritative by"),
  };

  if (!isValidIsoTimestamp(normalized.lastChecked)) {
    throw new Error("Last checked must be an ISO 8601 UTC timestamp");
  }

  return normalized;
}

function normalizeDigestField(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function escapeMarkdownTableCell(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, "<br>");
}

function firstLine(value) {
  return String(value).replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trimEnd();
}

function sameDigestBody(currentBody, nextBody) {
  return currentBody.trimEnd() === nextBody.trimEnd();
}

export function isStaleAt(activeCreatedAt, nextCreatedAt) {
  const staleMs = 24 * 60 * 60 * 1000;
  return new Date(nextCreatedAt).getTime() - new Date(activeCreatedAt).getTime() >= staleMs;
}

function compareClaimIds(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function createdAtToTime(createdAt) {
  const time = new Date(createdAt ?? "").getTime();
  return Number.isFinite(time) ? time : null;
}

function createdAtToSecond(createdAt) {
  const time = createdAtToTime(createdAt);
  if (time === null) {
    return null;
  }
  return Math.floor(time / 1000);
}

export function resolveActiveClaim(events, isTrustedAuthor = () => true) {
  const options = normalizeClaimResolutionOptions(isTrustedAuthor);
  const orderedEvents = events
    .map((event, index) => {
      const claim = parseClaimComment(event.body ?? "", event.createdAt ?? "");
      return {
        event,
        index,
        claimId: claim?.claimId ?? null,
        time: createdAtToTime(event.createdAt),
        second: createdAtToSecond(event.createdAt),
      };
    })
    .sort((left, right) => {
      if (left.second !== null && right.second !== null && left.second !== right.second) {
        return left.second - right.second;
      }
      if (left.second !== null && right.second === null) {
        return -1;
      }
      if (left.second === null && right.second !== null) {
        return 1;
      }

      if (
        left.second !== null &&
        right.second !== null &&
        left.claimId &&
        right.claimId &&
        left.claimId !== right.claimId
      ) {
        return compareClaimIds(left.claimId, right.claimId);
      }

      if (left.time !== null && right.time !== null && left.time !== right.time) {
        return left.time - right.time;
      }

      return left.index - right.index;
    })
    .map(({ event }) => event);

  let active = null;
  for (const event of orderedEvents) {
    active = applyClaimEvent(active, event, options);
  }
  return active;
}

export function applyClaimEvent(activeClaim, event, options = {}) {
  const normalizedOptions = normalizeClaimResolutionOptions(options);
  const authorLogin = event.author?.login ?? "";
  if (!normalizedOptions.isTrustedAuthor(authorLogin)) {
    return activeClaim;
  }

  const claim = parseClaimComment(event.body ?? "", event.createdAt ?? "");
  if (claim) {
    if (!activeClaim) {
      return claim.supersedes === "none" ? claim : null;
    }

    if (claim.agentId === activeClaim.agentId && claim.claimId === activeClaim.claimId) {
      return {
        ...activeClaim,
        createdAt: event.createdAt ?? activeClaim.createdAt,
      };
    }

    if (claim.supersedes === activeClaim.claimId && isStaleAt(activeClaim.createdAt, event.createdAt ?? "")) {
      return claim;
    }

    return activeClaim;
  }

  const release = parseReleaseComment(event.body ?? "");
  if (release && activeClaim && release.agentId === activeClaim.agentId && release.claimId === activeClaim.claimId) {
    return null;
  }

  const forcedHandoff = parseForcedHandoffComment(event.body ?? "", event.createdAt ?? "");
  if (
    forcedHandoff
    && activeClaim
    && normalizedOptions.isForcedHandoffEnabled(forcedHandoff, event)
    && normalizedOptions.isAuthorizedForcedHandoff(forcedHandoff.forcedBy, forcedHandoff, event)
    && forcedHandoff.oldAgentId === activeClaim.agentId
    && forcedHandoff.oldClaimId === activeClaim.claimId
    && forcedHandoff.branch === activeClaim.branch
  ) {
    return {
      agentId: forcedHandoff.newAgentId,
      claimId: forcedHandoff.newClaimId,
      supersedes: forcedHandoff.oldClaimId,
      branch: forcedHandoff.branch,
      createdAt: forcedHandoff.createdAt ?? activeClaim.createdAt,
    };
  }

  return activeClaim;
}

function normalizeClaimResolutionOptions(optionsOrPredicate) {
  if (typeof optionsOrPredicate === "function") {
    return {
      isTrustedAuthor: optionsOrPredicate,
      isForcedHandoffEnabled: () => false,
      isAuthorizedForcedHandoff: () => false,
    };
  }

  const options = optionsOrPredicate ?? {};
  return {
    isTrustedAuthor:
      typeof options.isTrustedAuthor === "function" ? options.isTrustedAuthor : () => true,
    isForcedHandoffEnabled:
      typeof options.isForcedHandoffEnabled === "function"
        ? options.isForcedHandoffEnabled
        : () => false,
    isAuthorizedForcedHandoff:
      typeof options.isAuthorizedForcedHandoff === "function"
        ? options.isAuthorizedForcedHandoff
        : () => false,
  };
}

function normalizeNonWhitespaceToken(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes("<!--") || trimmed.includes("-->")) {
    return "";
  }
  return trimmed;
}

function pickPayloadValue(payload, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return payload[key];
    }
  }
  return undefined;
}

function hasConflictingPayloadAliases(payload, firstKey, secondKey) {
  if (
    !Object.prototype.hasOwnProperty.call(payload, firstKey)
    || !Object.prototype.hasOwnProperty.call(payload, secondKey)
  ) {
    return false;
  }

  return String(payload[firstKey] ?? "").trim() !== String(payload[secondKey] ?? "").trim();
}

function normalizeBranchToken(value) {
  const token = normalizeNonWhitespaceToken(value);
  if (!token || token.includes(">")) {
    return "";
  }
  return token;
}

function normalizeForcedHandoffReason(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.includes("-->")) {
    return "";
  }
  return trimmed;
}

function normalizeLinkedPrReference(value) {
  const token = String(value ?? "").trim();
  if (!token) {
    return "";
  }
  if (/^#?[1-9]\d*$/.test(token)) {
    return token.replace(/^#/, "");
  }
  try {
    const parsed = new URL(token);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      return token.toLowerCase();
    }
    if (hostname !== "github.com" && hostname !== "www.github.com") {
      return token.toLowerCase();
    }
    const pathMatch = parsed.pathname.match(/^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/i);
    if (pathMatch) {
      return pathMatch[1];
    }
  } catch {
    // Not a URL-form linked-pr reference.
  }
  return token.toLowerCase();
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || !isValidIsoTimestamp(trimmed)) {
    return "";
  }
  return trimmed;
}

function normalizeSecondPrecisionIsoTimestamp(value) {
  const timestamp = normalizeIsoTimestamp(value);
  if (!timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
    return "";
  }
  return timestamp;
}

function normalizeContextScope(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return FORCED_HANDOFF_CONTEXT_SCOPES.has(trimmed) ? trimmed : "";
}

function normalizeLinkedPr(value) {
  const token = normalizeNonWhitespaceToken(value);
  if (!token || !FORCED_HANDOFF_LINKED_PR_PATTERN.test(token)) {
    return "";
  }
  return token;
}

export function classifyResumeRoutingCase(input, options = {}) {
  const staleHours = Number.isFinite(options.staleHours) ? options.staleHours : 24;
  const stallMinutes = Number.isFinite(options.stallMinutes) ? options.stallMinutes : 30;
  const pendingCiStates = new Set(options.pendingCiStates ?? ["queued", "in_progress", "waiting", "pending"]);
  const terminalSafeCiStates = new Set(options.terminalSafeCiStates ?? ["success", "none"]);

  if (input.displacedByForcedHandoff) {
    return {
      route: "claim-lost-stop",
      reason: "session was displaced by trusted forced-handoff evidence",
    };
  }

  if (!input.hasActiveClaim) {
    return {
      route: "unclaimed-reclaim-required",
      reason: "resume requires a fresh claim before continuation",
    };
  }

  if (input.claimOwnedBySession) {
    if (input.rebaseInProgress || input.worktreeDirty) {
      return {
        route: "crash-recovery",
        reason: "owned claim with interrupted local state",
      };
    }
    return {
      route: "ordinary-continuation",
      reason: "owned claim with clean local state",
    };
  }

  if (input.hasUsableForcedHandoffEvidence) {
    return {
      route: "forced-handoff-recovery",
      reason: "trusted forced-handoff evidence takes precedence over stalled-session takeover",
    };
  }

  if (!Number.isFinite(input.claimAgeHours)) {
    return {
      route: "hold-for-evidence",
      reason: "claim age is missing for a non-owned claim",
    };
  }

  if (!Number.isFinite(input.latestActivityAgeMinutes)) {
    return {
      route: "hold-for-evidence",
      reason: "activity age is missing for a non-owned active claim",
    };
  }

  const ciState = String(input.ciState ?? "none").toLowerCase();
  if (pendingCiStates.has(ciState)) {
    return {
      route: "hold-for-evidence",
      reason: "CI is still pending for the active non-owned claim",
    };
  }
  if (!terminalSafeCiStates.has(ciState)) {
    return {
      route: "hold-for-evidence",
      reason: "CI is not in a terminal-safe state for stalled-claim recovery",
    };
  }

  if (input.claimAgeHours < staleHours) {
    if (input.latestActivityAgeMinutes >= stallMinutes) {
      return {
        route: "hold-for-evidence",
        reason: `non-owned claim is fresh and idle for >= ${stallMinutes}m, but still non-inheritable`,
      };
    }
    return {
      route: "hold-for-evidence",
      reason: "non-owned claim remains non-inheritable until stale",
    };
  }

  if (input.latestActivityAgeMinutes < stallMinutes) {
    return {
      route: "hold-for-evidence",
      reason: `non-owned claim is stale but quiet-window evidence is < ${stallMinutes}m`,
    };
  }

  return {
    route: "stale-claim-takeover",
    reason: `non-owned claim is stale at >= ${staleHours}h with quiet-window evidence >= ${stallMinutes}m`,
  };
}

function hasExplicitDispositionAfter(targetComment, comments) {
  const targetTime = Date.parse(targetComment.createdAt ?? "");
  return comments.some((comment) => {
    const author = comment.author?.login ?? "";
    if (isKnownReviewBot(author) || !isDispositionComment(comment)) {
      return false;
    }
    if (!/\bCodeRabbit\b/i.test(comment.body ?? "")) {
      return false;
    }
    const dispositionTime = Date.parse(comment.createdAt ?? "");
    return Number.isFinite(targetTime)
      && Number.isFinite(dispositionTime)
      && dispositionTime > targetTime;
  });
}

function normalizeGatingReviewTimestamp(review, state) {
  const submittedAt = String(review.submittedAt ?? review.submitted_at ?? "");
  if (isValidIsoTimestamp(submittedAt)) {
    return submittedAt;
  }
  if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") {
    return null;
  }
  const updatedAt = String(review.updatedAt ?? review.updated_at ?? "");
  if (isValidIsoTimestamp(updatedAt)) {
    return updatedAt;
  }
  return null;
}

function maxIsoTimestamp(values) {
  let latest = null;
  for (const value of values) {
    const normalized = String(value);
    if (!isValidIsoTimestamp(normalized)) {
      continue;
    }
    if (!latest || compareIsoTimestamps(normalized, latest) > 0) {
      latest = normalized;
    }
  }
  return latest;
}

function summarizeRequiredCheckMetadata(parameters) {
  const names = new Set();
  let sourcePinned = false;
  const rawChecks = [
    ...(parameters.required_status_checks ?? []),
    ...(parameters.required_checks ?? []),
    ...(parameters.checks ?? []),
    ...(parameters.contexts ?? []),
  ];

  for (const rawCheck of rawChecks) {
    if (typeof rawCheck === "string") {
      if (rawCheck.trim()) {
        names.add(rawCheck.trim());
      }
      continue;
    }

    if (
      isSourcePinnedRequirementId(rawCheck?.app_id)
      || isSourcePinnedRequirementId(rawCheck?.integration_id)
      || rawCheck?.source
    ) {
      sourcePinned = true;
    }

    for (const candidate of [
      rawCheck?.context,
      rawCheck?.name,
      rawCheck?.check,
      rawCheck?.integration_id ? rawCheck?.name : "",
    ]) {
      const normalized = String(candidate ?? "").trim();
      if (normalized) {
        names.add(normalized);
        break;
      }
    }
  }

  return {
    names: [...names].sort(),
    sourcePinned,
  };
}

function extractRequiredReviewerRequirement(reviewer) {
  const reviewerRef = reviewer?.reviewer ?? {};
  const reviewerType = String(reviewerRef.type ?? reviewer?.type ?? "").trim().toLowerCase();
  const reviewerId = String(reviewerRef.id ?? reviewer?.id ?? "").trim();
  let candidate = typeof reviewer === "string"
    ? reviewer
    : reviewer?.login
      ?? reviewerRef.login
      ?? reviewer?.slug
      ?? reviewer?.team
      ?? reviewerRef.slug
      ?? reviewerRef.team
      ?? reviewerRef.name
      ?? "";
  if (!candidate && reviewerType && reviewerId) {
    candidate = `${reviewerType}/${reviewerId}`;
  }
  return {
    identity: String(candidate ?? "").trim().replace(/^@/, "").toLowerCase(),
    minimumApprovals: Number(reviewer?.minimum_approvals ?? reviewer?.min_approvals ?? 1) || 0,
    filePatterns: (reviewer?.file_patterns ?? reviewer?.filePatterns ?? [])
      .map((pattern) => String(pattern ?? "").trim())
      .filter(Boolean),
  };
}

function parseCodeownersRules(codeownersText) {
  return String(codeownersText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => {
      const tokens = tokenizeCodeownersLine(line);
      const pattern = tokens.shift() ?? "";
      const ownerTokens = [];
      for (const token of tokens) {
        if (token.startsWith("#")) {
          break;
        }
        ownerTokens.push(token);
      }
      const users = ownerTokens
        .filter((token) => /^@[^/\s#]+$/.test(token))
        .map((token) => token.slice(1).toLowerCase());
      const teams = ownerTokens
        .filter((token) => /^@[^/\s#]+\/[^/\s#]+$/.test(token))
        .map((token) => token.slice(1).toLowerCase());
      const emails = ownerTokens
        .filter((token) => /^[^@\s#][^\s#]*@[^\s#]+$/.test(token))
        .map((token) => token.toLowerCase());
      if (!pattern) {
        return null;
      }
      return { pattern, users, teams, emails };
    })
    .filter(Boolean);
}

function findCodeownersForPath(rules, path) {
  let latest = null;
  for (const rule of rules) {
    if (matchesCodeownersPattern(rule.pattern, path)) {
      latest = rule;
    }
  }
  return latest;
}

function matchesCodeownersPattern(pattern, path) {
  const normalizedPattern = String(pattern ?? "").trim();
  const normalizedPath = String(path ?? "").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!normalizedPattern || !normalizedPath) {
    return false;
  }

  let body = normalizedPattern;
  const anchored = body.startsWith("/");
  if (anchored) {
    body = body.slice(1);
  }
  const rawBody = body;
  const trailingSlashPattern = rawBody.endsWith("/");
  const lastSegment = rawBody.split("/").at(-1) ?? "";
  const anyDepthFromRoot = rawBody.startsWith("**/");
  const directoryLikePattern = !trailingSlashPattern
    && !lastSegment.includes("*")
    && !lastSegment.includes("?");

  if (trailingSlashPattern) {
    body = `${body}**`;
  }

  if (anyDepthFromRoot) {
    body = body.slice(3);
  }

  const slashAnchored = anchored || (rawBody.includes("/") && !anyDepthFromRoot && !trailingSlashPattern);
  let source = anyDepthFromRoot || !slashAnchored ? "^(?:|.*\\/)" : "^";
  for (let index = 0; index < body.length; index += 1) {
    const triplet = body.slice(index, index + 3);
    const pair = body.slice(index, index + 2);
    if (triplet === "**/") {
      source += "(?:[^/]+/)*";
      index += 2;
      continue;
    }
    if (pair === "**") {
      source += ".*";
      index += 1;
      continue;
    }
    const character = body[index];
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(character);
  }
  if (directoryLikePattern) {
    source += "(?:/.*)?";
  }
  source += "$";

  return new RegExp(source).test(normalizedPath);
}

function effectiveRegularCommentActivityAt(comment) {
  const updatedAt = String(comment.updatedAt ?? "");
  if (isValidIsoTimestamp(updatedAt) && compareIsoTimestamps(updatedAt, comment.createdAt) > 0) {
    return updatedAt;
  }
  return comment.createdAt;
}

function isSourcePinnedRequirementId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0;
}

function tokenizeCodeownersLine(line) {
  const tokens = [];
  let current = "";
  let escaped = false;

  for (const character of String(line ?? "")) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === " " || character === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaped) {
    current += "\\";
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function hasCodeownerOwners(rule) {
  return (rule?.users?.length ?? 0) > 0
    || (rule?.teams?.length ?? 0) > 0
    || (rule?.emails?.length ?? 0) > 0;
}

function isGateAdvisoryBotLogin(login, advisoryBotLogins) {
  const normalized = String(login ?? "").trim().toLowerCase();
  return isKnownReviewBot(normalized) || advisoryBotLogins.has(normalized);
}

function isOperationalOrDigestComment(body) {
  return operationalMarkerPrefix(body) !== null || firstLine(body) === LIVE_STATUS_DIGEST_MARKER;
}

function isOperationalOrDigestCommentForGate(body, authorLogin, trustedMarkerLogins) {
  const marker = operationalMarkerPrefix(body);
  if (marker === "<!-- forced-handoff:") {
    return trustedMarkerLogins.has(String(authorLogin ?? "").trim().toLowerCase());
  }
  return marker !== null || firstLine(body) === LIVE_STATUS_DIGEST_MARKER;
}

function isValidForcedHandoffOperationalMarker(body) {
  return parseForcedHandoffComment(body, "") !== null;
}

function buildBodyPreview(body) {
  return firstLine(String(body ?? "")).slice(0, 120);
}

function advisoryWaitMarkerMatchesHead(body, prHeadSha) {
  return new RegExp(`^advisory-wait: [^ ]+ ${escapeRegExp(prHeadSha)}(?: |$)`).test(body)
    || new RegExp(`^advisory-wait-recovery: [^ ]+ ${escapeRegExp(prHeadSha)}(?: |$)`).test(body)
    || new RegExp(`^<!-- advisory-wait: [^ ]+ ${escapeRegExp(prHeadSha)} [^ ]+ -->$`).test(body);
}

function advisoryWaitRequestMarker(body) {
  return /^advisory-wait:/.test(body) || /^<!-- advisory-wait:/.test(body);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function minutesBetweenIso(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 60000);
}

function compareIsoTimestamps(left, right) {
  const leftComparable = normalizeComparableTimestamp(left);
  const rightComparable = normalizeComparableTimestamp(right);
  if (typeof leftComparable === "number" && typeof rightComparable === "number") {
    if (leftComparable !== rightComparable) {
      return leftComparable - rightComparable;
    }
    return String(left ?? "").localeCompare(String(right ?? ""));
  }
  if (typeof leftComparable === "number") {
    return 1;
  }
  if (typeof rightComparable === "number") {
    return -1;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function threadActivityAt(thread) {
  if (isValidIsoTimestamp(thread.updatedAt ?? "")) {
    return thread.updatedAt;
  }

  const commentTimes = (thread.comments?.nodes ?? [])
    .flatMap((comment) => [comment.updatedAt, comment.createdAt])
    .filter(isValidIsoTimestamp);

  return maxIsoTimestamp(commentTimes);
}

function effectiveThreadCommentActivityAt(comment) {
  const updatedAt = String(comment?.updatedAt ?? "");
  if (isValidIsoTimestamp(updatedAt)) {
    return updatedAt;
  }
  const createdAt = String(comment?.createdAt ?? "");
  if (isValidIsoTimestamp(createdAt)) {
    return createdAt;
  }
  return "";
}

function hasCompletedBotThreadDispositions(threads, loginPredicate) {
  const botThreads = threads.filter((thread) => {
    return (thread.comments?.nodes ?? []).some((comment) => {
      return loginPredicate(comment.author?.login ?? "") && !isDispositionComment(comment);
    });
  });

  return botThreads.length > 0 && botThreads.every((thread) => {
    return thread.isResolved
      && !thread.comments?.pageInfo?.hasNextPage
      && hasFreshDisposition(thread);
  });
}

function hasUnresolvedKnownBotThreads(threads) {
  return threads.some((thread) => {
    if (thread.isResolved) {
      return false;
    }
    if (thread.comments?.pageInfo?.hasNextPage) {
      return true;
    }
    return (thread.comments?.nodes ?? []).some((comment) => {
      return isKnownReviewBot(comment.author?.login ?? "");
    });
  });
}

function isValidIsoTimestamp(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const normalize = (ts) => ts.replace(".000Z", "Z");
  return normalize(new Date(time).toISOString()) === normalize(value);
}

function isCompletedCiTimestamp(value) {
  const timestamp = String(value ?? "");
  return timestamp !== "0001-01-01T00:00:00Z" && isValidIsoTimestamp(timestamp);
}

function normalizeComparableTimestamp(value) {
  const normalized = String(value ?? "none");
  if (normalized === "none") {
    return "none";
  }
  if (!isValidIsoTimestamp(normalized)) {
    return null;
  }
  return Date.parse(normalized);
}
