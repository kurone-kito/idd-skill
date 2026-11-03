// idd-generated-from: src/scripts/provisional-claim-lineage.mts
//
// The scripts/provisional-claim-lineage.mjs copy is generated from this
// source by `pnpm run build`. Edit this .mts, never the generated .mjs. See
// docs/typescript-sources.md.

import type { ParsedClaimMarker } from './marker-helpers.mts';
import {
  parseActivationNonceComment,
  parseClaimComment,
  parseForcedHandoffComment,
  parseLegacyClaimComment,
  parseLegacyReleaseComment,
  parseReleaseComment,
} from './marker-helpers.mts';
import {
  applyClaimEvent,
  classifyCommentEditState,
  isStaleAt,
  isStaleByAge,
} from './protocol-helpers.mts';
import type { VerifiedProvisionalDecisionClaim } from './provisional-decision-state.mts';

export interface ProvisionalClaimLineageComment {
  readonly id: string;
  readonly url: string;
  readonly body: string;
  readonly createdAt: string;
  readonly authorLogin: string | null;
  readonly lastEditedAt: string | null | undefined;
  readonly trustedAuthor: boolean;
}

export interface BuildVerifiedClaimLineageInput {
  readonly comments: readonly ProvisionalClaimLineageComment[];
  readonly completeHistory: boolean;
  readonly staleAgeMs: number;
  readonly trustedMarkerLogins: readonly string[];
}

export type ClaimLineageRecoveryReason =
  | 'history-incomplete'
  | 'history-order-invalid'
  | 'duplicate-comment'
  | 'date-time-required'
  | 'unknown-edit-state'
  | 'edited-claim-marker'
  | 'legacy-claim-marker'
  | 'malformed-claim-marker'
  | 'same-second-claims'
  | 'takeover-accepted'
  | 'duplicate-claim-id'
  | 'non-canonical-branch'
  | 'forced-handoff-after-last-claim'
  | 'empty-lineage';

export type BuildVerifiedClaimLineageResult =
  | {
      readonly status: 'ok';
      readonly claims: readonly VerifiedProvisionalDecisionClaim[];
      readonly active: {
        readonly claimId: string;
        readonly agentId: string;
        readonly branch: string;
        readonly claimedAt: string;
      } | null;
      readonly activeSince: string | null;
    }
  | {
      readonly status: 'recovery-hold';
      readonly reason: ClaimLineageRecoveryReason;
    };

interface Rfc3339Instant {
  readonly epochSeconds: number;
  readonly fraction: string;
}

interface TrustedClaimComment {
  readonly sourceIndex: number;
  readonly comment: ProvisionalClaimLineageComment;
  readonly event: ClaimFoldEvent;
  readonly claim: ReturnType<typeof parseClaimComment>;
  readonly forcedHandoff: ReturnType<typeof parseForcedHandoffComment>;
}

interface ClaimFoldEvent {
  readonly id: string;
  readonly url: string;
  readonly body: string;
  readonly createdAt: string;
  readonly author: { readonly login: string };
  readonly lastEditedAt: string | null | undefined;
}

function recovery(
  reason: ClaimLineageRecoveryReason,
): BuildVerifiedClaimLineageResult {
  return { status: 'recovery-hold', reason };
}

function daysBeforeYear(year: number): number {
  return (
    365 * year +
    Math.floor((year + 3) / 4) -
    Math.floor((year + 99) / 100) +
    Math.floor((year + 399) / 400)
  );
}

/** Mirrors replay's RFC 3339 parser so ordering keeps sub-millisecond precision. */
function parseRfc3339Instant(value: string): Rfc3339Instant | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const daysInMonth = monthLengths[month - 1];
  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const daysSinceEpoch =
    daysBeforeYear(year) +
    monthLengths
      .slice(0, month - 1)
      .reduce((total, length) => total + length, 0) +
    day -
    1 -
    daysBeforeYear(1970);
  const offsetSign = match[8] === '+' ? 1 : match[8] === '-' ? -1 : 0;
  const offsetSeconds = offsetSign * (offsetHour * 60 + offsetMinute) * 60;
  return {
    epochSeconds:
      daysSinceEpoch * 86400 +
      hour * 3600 +
      minute * 60 +
      second -
      offsetSeconds,
    fraction: (match[7] ?? '').replace(/0+$/u, ''),
  };
}

function compareInstants(left: Rfc3339Instant, right: Rfc3339Instant): number {
  if (left.epochSeconds !== right.epochSeconds) {
    return left.epochSeconds < right.epochSeconds ? -1 : 1;
  }
  const fractionLength = Math.max(left.fraction.length, right.fraction.length);
  for (let index = 0; index < fractionLength; index += 1) {
    const leftDigit = left.fraction[index] ?? '0';
    const rightDigit = right.fraction[index] ?? '0';
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}

function commentUrlKey(value: string): string {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/u);
    const commentId = url.hash.match(/^#issuecomment-(\d+)$/u);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      match &&
      commentId
    ) {
      return `${match[1]?.toLowerCase()}/${match[2]?.toLowerCase()}/issues/${match[3]}#issuecomment-${commentId[1]}`;
    }
  } catch {
    // Keep the exact URL as the duplicate key when it is not a GitHub issue comment URL.
  }
  return value;
}

function beginsClaimFamily(body: string): boolean {
  return (
    /^<!--\s*(?:claimed-by|unclaimed-by|activation-nonce)\s*:/iu.test(body) ||
    /^\s*<!--\s*forced-handoff\s*:/iu.test(body)
  );
}

function isTrusted(
  comment: ProvisionalClaimLineageComment,
  trustedLogins: ReadonlySet<string>,
): boolean {
  const login = comment.authorLogin?.trim().toLowerCase() ?? '';
  return comment.trustedAuthor && login !== '' && trustedLogins.has(login);
}

function identityChanged(
  before: { readonly agentId: string; readonly claimId: string } | null,
  after: { readonly agentId: string; readonly claimId: string } | null,
): boolean {
  return (
    (before?.agentId ?? null) !== (after?.agentId ?? null) ||
    (before?.claimId ?? null) !== (after?.claimId ?? null)
  );
}

interface ClaimStart {
  readonly sourceIndex: number;
  readonly claim: NonNullable<TrustedClaimComment['claim']>;
  readonly comment: ProvisionalClaimLineageComment;
}

interface ClaimStartResolution {
  readonly starts: readonly ClaimStart[];
  readonly activeClaim: ParsedClaimMarker | null;
  readonly activeSince: string;
}

function stalePredicate(staleAgeMs: number) {
  const isStale =
    Number.isFinite(staleAgeMs) && staleAgeMs > 0
      ? (activeCreatedAt: string, nextCreatedAt: string) =>
          isStaleByAge(activeCreatedAt, nextCreatedAt, staleAgeMs)
      : isStaleAt;
  return isStale;
}

function resolveStarts(
  trustedComments: readonly TrustedClaimComment[],
  staleAgeMs: number,
): ClaimStartResolution {
  const starts: ClaimStart[] = [];
  const isTrustedAuthor = () => true;
  const isStale = stalePredicate(staleAgeMs);
  let activeClaim: ParsedClaimMarker | null = null;
  let activeSince = '';

  // History has already been checked oldest-first. Carry reducer state
  // forward once; competing claim identities in one UTC second are refused
  // below before the resulting active state is trusted.
  for (const entry of trustedComments) {
    const event = entry.event;
    const next = applyClaimEvent(activeClaim, event, {
      isTrustedAuthor,
      isStale,
    });
    if (identityChanged(activeClaim, next)) {
      activeSince = String(event.createdAt ?? '');
      if (next) {
        if (entry.claim) {
          starts.push({
            sourceIndex: entry.sourceIndex,
            claim: entry.claim,
            comment: entry.comment,
          });
        }
      }
    }
    activeClaim = next;
  }

  return { starts, activeClaim, activeSince };
}

function hasDistinctClaimsInSameSecond(
  trustedComments: readonly TrustedClaimComment[],
): boolean {
  const claimBySecond = new Map<
    number,
    { readonly agentId: string; readonly claimId: string }
  >();
  for (const entry of trustedComments) {
    if (!entry.claim) continue;
    const instant = parseRfc3339Instant(entry.comment.createdAt);
    if (!instant) continue;
    const previous = claimBySecond.get(instant.epochSeconds);
    if (
      previous &&
      (previous.agentId !== entry.claim.agentId ||
        previous.claimId !== entry.claim.claimId)
    ) {
      return true;
    }
    claimBySecond.set(instant.epochSeconds, {
      agentId: entry.claim.agentId,
      claimId: entry.claim.claimId,
    });
  }
  return false;
}

/**
 * Build the trusted, replay-accepted claim history for a provisional-decision
 * source. This is a pure conversion: it reads no GitHub state and writes none.
 */
// audit:ignore-dead-export: runtime consumers are the provisional decision writer in #4792 and protected-source merge path in #4532
export function buildVerifiedClaimLineage(
  input: BuildVerifiedClaimLineageInput,
): BuildVerifiedClaimLineageResult {
  const comments = input.comments;
  if (input.completeHistory !== true) return recovery('history-incomplete');

  const parsedTimes = comments.map((comment) =>
    typeof comment.createdAt === 'string'
      ? parseRfc3339Instant(comment.createdAt)
      : undefined,
  );
  for (let index = 1; index < comments.length; index += 1) {
    const previous = parsedTimes[index - 1];
    const current = parsedTimes[index];
    if (previous && current && compareInstants(current, previous) < 0) {
      return recovery('history-order-invalid');
    }
  }

  const commentIds = new Set<string>();
  const commentUrls = new Set<string>();
  for (const comment of comments) {
    const id = String(comment.id);
    const url = commentUrlKey(comment.url);
    if (commentIds.has(id) || commentUrls.has(url)) {
      return recovery('duplicate-comment');
    }
    commentIds.add(id);
    commentUrls.add(url);
  }

  if (parsedTimes.some((time) => time === undefined)) {
    return recovery('date-time-required');
  }

  const trustedLogins = new Set(
    input.trustedMarkerLogins
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
  const trustedComments: TrustedClaimComment[] = [];
  for (let sourceIndex = 0; sourceIndex < comments.length; sourceIndex += 1) {
    const comment = comments[sourceIndex];
    if (!isTrusted(comment, trustedLogins)) continue;
    const createdAt = comment.createdAt;
    const body = comment.body;
    trustedComments.push({
      sourceIndex,
      comment,
      event: {
        id: comment.id,
        url: comment.url,
        body,
        createdAt,
        author: { login: comment.authorLogin?.trim() ?? '' },
        lastEditedAt: comment.lastEditedAt,
      },
      claim: parseClaimComment(body, createdAt),
      forcedHandoff: parseForcedHandoffComment(body, createdAt),
    });
  }

  const claimFamily = trustedComments.filter(
    ({ comment, claim, forcedHandoff }) =>
      Boolean(
        claim ||
          forcedHandoff ||
          parseLegacyClaimComment(comment.body, comment.createdAt) ||
          parseReleaseComment(comment.body) ||
          parseLegacyReleaseComment(comment.body, comment.createdAt) ||
          parseActivationNonceComment(comment.body, comment.createdAt) ||
          beginsClaimFamily(comment.body),
      ),
  );
  if (
    claimFamily.some(
      ({ comment }) =>
        classifyCommentEditState({ lastEditedAt: comment.lastEditedAt }) ===
        'unknown',
    )
  ) {
    return recovery('unknown-edit-state');
  }
  if (
    claimFamily.some(
      ({ comment }) =>
        classifyCommentEditState({ lastEditedAt: comment.lastEditedAt }) ===
        'edited',
    )
  ) {
    return recovery('edited-claim-marker');
  }
  if (
    claimFamily.some(
      ({ comment }) =>
        parseLegacyClaimComment(comment.body, comment.createdAt) !== null ||
        parseLegacyReleaseComment(comment.body, comment.createdAt) !== null,
    )
  ) {
    return recovery('legacy-claim-marker');
  }
  if (
    claimFamily.some(({ comment }) => {
      const body = comment.body;
      return (
        beginsClaimFamily(body) &&
        parseClaimComment(body, comment.createdAt) === null &&
        parseReleaseComment(body) === null &&
        parseActivationNonceComment(body, comment.createdAt) === null &&
        parseForcedHandoffComment(body, comment.createdAt) === null
      );
    })
  ) {
    return recovery('malformed-claim-marker');
  }

  const { starts, activeClaim, activeSince } = resolveStarts(
    trustedComments,
    input.staleAgeMs,
  );
  if (hasDistinctClaimsInSameSecond(trustedComments)) {
    return recovery('same-second-claims');
  }
  const startSeconds = new Set<number>();
  for (const start of starts) {
    const instant = parseRfc3339Instant(start.comment.createdAt);
    if (instant && startSeconds.has(instant.epochSeconds)) {
      return recovery('same-second-claims');
    }
    if (instant) startSeconds.add(instant.epochSeconds);
  }
  if (starts.some(({ claim }) => claim.supersedes !== 'none')) {
    return recovery('takeover-accepted');
  }

  const claimIds = new Set<string>();
  for (const { claim } of starts) {
    if (claimIds.has(claim.claimId)) return recovery('duplicate-claim-id');
    claimIds.add(claim.claimId);
  }
  if (
    starts.some(
      ({ claim }) =>
        !/^issue\/[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(claim.branch),
    )
  ) {
    return recovery('non-canonical-branch');
  }

  const lastStart = starts.at(-1);
  if (
    lastStart &&
    trustedComments.some(
      ({ sourceIndex, forcedHandoff }) =>
        forcedHandoff !== null && sourceIndex >= lastStart.sourceIndex,
    )
  ) {
    return recovery('forced-handoff-after-last-claim');
  }
  if (starts.length === 0) return recovery('empty-lineage');

  if (!activeClaim) {
    return {
      status: 'ok',
      claims: starts.map(({ claim, comment }) => ({
        claimId: claim.claimId,
        agentId: claim.agentId,
        branch: claim.branch,
        claimedAt: comment.createdAt,
        supersedes: claim.supersedes,
        commentId: comment.id,
      })),
      active: null,
      activeSince: null,
    };
  }

  let activeStart: (typeof starts)[number] | undefined;
  for (const start of starts) {
    if (
      start.claim.claimId === activeClaim.claimId &&
      start.claim.agentId === activeClaim.agentId
    ) {
      activeStart = start;
    }
  }
  if (!activeStart) return recovery('forced-handoff-after-last-claim');

  return {
    status: 'ok',
    claims: starts.map(({ claim, comment }) => ({
      claimId: claim.claimId,
      agentId: claim.agentId,
      branch: claim.branch,
      claimedAt: comment.createdAt,
      supersedes: claim.supersedes,
      commentId: comment.id,
    })),
    active: {
      claimId: activeClaim.claimId,
      agentId: activeClaim.agentId,
      branch: activeClaim.branch,
      claimedAt: activeStart.comment.createdAt,
    },
    activeSince: activeSince || null,
  };
}
