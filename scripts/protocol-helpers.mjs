const ISO8601_UTC_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;

const OPERATIONAL_MARKERS = [
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
    pattern: /^advisory-wait:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/i,
  },
  {
    label: "advisory-wait-recovery:",
    pattern: /^advisory-wait-recovery:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/i,
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
      `^<!--\\s*claimed-by:\\s+(\\S+)\\s+(\\S+)\\s+supersedes:\\s+(\\S+)\\s+(${ISO8601_UTC_PATTERN.source})\\s+branch:\\s+([^\\s>]+)\\s*-->$`,
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
      `^<!--\\s*unclaimed-by:\\s+(\\S+)\\s+(\\S+)\\s+(${ISO8601_UTC_PATTERN.source})\\s*-->$`,
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
  return Number.isFinite(time) && new Date(time).toISOString().replace(".000Z", "Z") === value;
}
