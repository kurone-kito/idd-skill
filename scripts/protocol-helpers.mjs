import { Buffer } from "node:buffer";

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
    pattern: /^<!--\s*forced-handoff:\s*\{[\s\S]*\}\s*-->[\s\S]*$/i,
    startPattern: /^<!--\s*forced-handoff:/i,
  },
];

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
const FORCED_HANDOFF_LINKED_PR_PATTERN = /^(?:[1-9]\d*|https?:\/\/[^\s<>"]+)$/i;

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
  const trimmed = body.trimEnd();
  const markerMatch = trimmed.match(/^<!--\s*forced-handoff:\s*/i);
  if (!markerMatch) {
    return null;
  }

  const markerEnd = trimmed.indexOf("-->");
  if (markerEnd < 0) {
    return null;
  }

  const visibleNote = trimmed.slice(markerEnd + 3).trim();
  if (!visibleNote) {
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
    return [
      `Forced handoff approved by ${normalized.forcedBy}. I verified that the current`,
      "owning session or agent is unavailable. This transfers ownership away",
      `from claim \`${normalized.oldClaimId}\` on branch \`${normalized.branch}\` for PR #${normalized.linkedPr}.`,
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
  return OPERATIONAL_MARKERS.find((marker) => marker.pattern.test(normalized))?.label ?? null;
}

export function operationalMarkerPrefixByStart(body) {
  const normalized = body.trimStart();
  return OPERATIONAL_MARKERS
    .find((marker) => marker.startPattern?.test(normalized) ?? normalized.startsWith(marker.label))
    ?.label ?? null;
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

  if (elapsedMs < 24 * 60 * 60 * 1000) {
    return {
      route: "hold-before-escalation",
      reason: "still within the first 24 hours after the rejection reply",
    };
  }
  if (elapsedMs < 48 * 60 * 60 * 1000) {
    return {
      route: "escalate-maintainer",
      reason: "the changes-requested review is still blocking after 24 hours with no reviewer response",
    };
  }
  const escalationElapsedMs = Date.parse(input.now ?? "") - Date.parse(input.escalationCommentCreatedAt ?? "");
  if (!Number.isFinite(escalationElapsedMs)) {
    return {
      route: "escalate-maintainer",
      reason: "the changes-requested review still needs maintainer escalation evidence before release",
    };
  }
  if (escalationElapsedMs < 24 * 60 * 60 * 1000) {
    return {
      route: "hold-after-escalation",
      reason: "still within 24 hours of the maintainer escalation comment",
    };
  }
  return {
    route: "label-and-release",
    reason: "the changes-requested review is still blocking after 48 hours with no escalation response",
  };
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

export function hasFreshDisposition(thread) {
  const comments = thread.comments?.nodes ?? [];
  const latestFeedbackAt = maxIsoTimestamp(
    comments
    .filter((comment) => !isIddDispositionComment(comment))
    .map((comment) => comment.createdAt),
  );

  return comments.some((comment) => {
    if (!isIddDispositionComment(comment)) {
      return false;
    }
    return !latestFeedbackAt || compareIsoTimestamps(comment.createdAt, latestFeedbackAt) > 0;
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
    if (!trustedLogins.has(authorLogin) || !isOperationalOrDigestComment(body)) {
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
  const requestCap = Number.isFinite(input.requestCap) ? input.requestCap : 30;
  const pendingWindowMinutes = Number.isFinite(input.pendingWindowMinutes)
    ? input.pendingWindowMinutes
    : 30;
  const settledWindowMinutes = Number.isFinite(input.settledWindowMinutes)
    ? input.settledWindowMinutes
    : 10;

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
  const requestCap = Number.isFinite(options.requestCap) ? options.requestCap : 30;
  const pendingWindowMinutes = Number.isFinite(options.pendingWindowMinutes)
    ? options.pendingWindowMinutes
    : 30;
  const settledWindowMinutes = Number.isFinite(options.settledWindowMinutes)
    ? options.settledWindowMinutes
    : 10;

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
      .filter(isValidIsoTimestamp),
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
      .filter(isValidIsoTimestamp),
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
    if (isOperationalOrDigestComment(comment.body) || !iddAgentLogins.has(comment.authorLogin)) {
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
    .filter((comment) => !isOperationalOrDigestComment(comment.body))
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

export function summarizeBranchReviewRequirements(branchRules = [], branchProtection = {}) {
  const requiredCheckNames = new Set();
  const requiredReviewerLogins = new Set();
  const requiredReviewerTeams = new Set();
  const requiredReviewerRequirements = [];

  let requiredApprovingReviewCount = 0;
  let requireCodeOwnerReview = false;
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
  requiredApprovingReviewCount = Math.max(
    requiredApprovingReviewCount,
    Number(protectionReviews.required_approving_review_count ?? 0) || 0,
  );
  requireCodeOwnerReview = requireCodeOwnerReview
    || Boolean(protectionReviews.require_code_owner_reviews)
    || Boolean(protectionReviews.require_code_owner_review);
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
    requiresConversationResolution,
    requiredCheckSourcePinned,
    requiredReviewerLogins: [...requiredReviewerLogins].sort(),
    requiredReviewerTeams: [...requiredReviewerTeams].sort(),
    requiredReviewerRequirements,
    requiredCheckNames: [...requiredCheckNames].sort(),
  };
}

export function summarizeRequiredChecks(checks = [], branchRules = [], branchProtection = {}) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(branchRules, branchProtection);
  const requiredCheckNames = branchReviewRequirements.requiredCheckNames;
  const requiredCheckNameSet = new Set(requiredCheckNames);
  const normalizedChecks = checks.map((check) => ({
    name: String(check.name ?? ""),
    state: String(check.state ?? "").toUpperCase(),
    completedAt: String(check.completedAt ?? ""),
  }));
  const matchedRequiredChecks = normalizedChecks.filter((check) => requiredCheckNameSet.has(check.name));
  const presentNames = new Set(matchedRequiredChecks.map((check) => check.name));
  const missingRequiredCheckNames = requiredCheckNames.filter((name) => !presentNames.has(name));

  let status = "unknown";
  if (requiredCheckNames.length > 0) {
    const ciClassification = classifyCiChecks(matchedRequiredChecks);
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
  }

  return {
    ruleCount: rules.length,
    changedFileCount: changedFiles.length,
    unmatchedFiles,
    codeownerUserLogins: [...codeownerUsers].sort(),
    codeownerTeamSlugs: [...codeownerTeams].sort(),
  };
}

export function summarizeReviewerStates(
  reviews = [],
  {
    reviewDecision = "",
    branchRules = [],
    branchProtection = {},
    codeownersText = "",
    changedFiles = [],
    advisoryBotLogins = [],
  } = {},
) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(branchRules, branchProtection);
  const requiredReviewerLogins = new Set(branchReviewRequirements.requiredReviewerLogins);
  const advisoryBotLoginSet = new Set(normalizeTrustedMarkerLogins(advisoryBotLogins));
  const codeownerRules = parseCodeownersRules(codeownersText);
  const codeowners = collectCodeownersForFiles(codeownerRules, changedFiles);
  const codeownerUsers = new Set(codeowners.codeownerUserLogins);
  const normalizedReviewDecision = String(reviewDecision ?? "");

  const latestByAuthor = [...indexLatestGatingReviewsByAuthor(reviews).values()]
    .map((review) => {
      const login = String(review.author?.login ?? "").trim().toLowerCase();
      const isAdvisoryBot = isGateAdvisoryBotLogin(login, advisoryBotLoginSet);
      const isCodeowner = codeownerUsers.has(login);
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
    humanChangesRequestedCount: blockingChangesRequestedLogins.length,
    blockingChangesRequestedLogins,
  };
}

export function summarizeClaimValidation(claimEvents = [], options = {}) {
  const trustedMarkerLogins = new Set(normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []));
  const expectedClaimId = String(options.expectedClaimId ?? "").trim();
  const expectedAgentId = String(options.expectedAgentId ?? "").trim();
  const activeClaim = resolveActiveClaim(
    claimEvents,
    (login) => trustedMarkerLogins.size === 0 || trustedMarkerLogins.has(String(login ?? "").trim().toLowerCase()),
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
    branchProtection = {},
    requestedReviewers = [],
    timelineEvents = [],
    claimEvents = [],
    changedFiles = [],
    codeownersText = "",
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
    threads,
  });
  const reviewerStates = summarizeReviewerStates(reviews, {
    reviewDecision,
    branchRules,
    branchProtection,
    codeownersText,
    changedFiles,
    advisoryBotLogins,
  });
  const ci = summarizeRequiredChecks(checks, branchRules, branchProtection);
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
      requestCap: Number.isFinite(options.requestCap) ? options.requestCap : 30,
      pendingWindowMinutes: Number.isFinite(options.pendingWindowMinutes)
        ? options.pendingWindowMinutes
        : 30,
      settledWindowMinutes: Number.isFinite(options.settledWindowMinutes)
        ? options.settledWindowMinutes
        : 10,
      viewerLogin: options.viewerLogin,
      configuredTrustedActors: options.configuredTrustedActors,
      collaboratorTrustEnabled: options.collaboratorTrustEnabled,
      trustedMarkerLogins,
    },
  );
  const claim = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins,
    expectedClaimId: options.expectedClaimId,
    expectedAgentId: options.expectedAgentId,
  });

  return {
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
      elapsedMinutes: advisoryWait.elapsedMinutes,
    },
    ci,
    claim,
  };
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
  if (!trimmed || trimmed.includes("-->")) {
    return "";
  }
  return trimmed;
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
