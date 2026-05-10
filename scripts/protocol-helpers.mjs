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

export function operationalMarkerPrefix(body) {
  const normalized = body.trimEnd();
  return OPERATIONAL_MARKERS.find((marker) => marker.pattern.test(normalized))?.label ?? null;
}

export function operationalMarkerPrefixByStart(body) {
  const normalized = body.trimStart();
  return OPERATIONAL_MARKERS
    .map((marker) => marker.label)
    .find((prefix) => normalized.startsWith(prefix)) ?? null;
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
    if (review.state === "COMMENTED") {
      continue;
    }
    const author = review.author?.login?.toLowerCase();
    if (!author) {
      continue;
    }
    const current = index.get(author);
    const submittedAt = review.submittedAt ?? "";
    if (!current || submittedAt > (current.submittedAt ?? "")) {
      index.set(author, review);
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

export function hasFreshDisposition(thread) {
  const comments = thread.comments?.nodes ?? [];
  const latestFeedbackAt = comments
    .filter((comment) => !isIddDispositionComment(comment))
    .map((comment) => comment.createdAt)
    .sort()
    .at(-1);

  return comments.some((comment) => {
    if (!isIddDispositionComment(comment)) {
      return false;
    }
    return !latestFeedbackAt || comment.createdAt > latestFeedbackAt;
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

export function applyClaimEvent(activeClaim, event, isTrustedAuthor = () => true) {
  if (!isTrustedAuthor(event.author?.login ?? "")) {
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

  return activeClaim;
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

function maxIsoTimestamp(values) {
  const sorted = values
    .map((value) => String(value))
    .filter(isValidIsoTimestamp)
    .sort();
  return sorted.at(-1) ?? null;
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
