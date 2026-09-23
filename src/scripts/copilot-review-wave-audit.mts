#!/usr/bin/env node
// idd-generated-from: src/scripts/copilot-review-wave-audit.mts
//
// The scripts/copilot-review-wave-audit.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Source-repo-only dogfood measurement tool (issue #3223): reproduces the
// 2026-09-24 baseline docs/critique-telemetry.md cites for Copilot's review
// wave/severity trends, so a future change aimed at cutting Copilot review
// cost (like #3046's deferAfterRounds lowering, or the adopt-now urgency
// defer rule) can be re-measured on demand instead of rebuilt from throwaway
// scripts each time (#3001, #3046, #3221). Never registered in
// HELPER_COMMANDS or distributed to idd-template/ (see
// SOURCE_REPO_INTERNAL_ENTRY_PATHS in tests/helper-invocation-profile.test.mts,
// same class as audit-code-span-wrap.mts / idd-critique-report.mts) -- an
// adopter repository has no Copilot-review-wave baseline of its own to
// measure against this one.
//
// Copilot's severity label is only machine-readable from a review body
// carrying the `<!-- ccr-overview-v2 -->` marker (a body without it is
// `legacy`). Findings are grouped under `<details><summary><strong>...`
// sections: `Open (<n>)`, `Resolved since last review (<n>)`, and
// `Previously missed (<n>)` (each nested finding under "Previously missed"
// carries a severity but no `#discussion_r<id>` link, so it has no thread to
// key by -- excluded from every thread-keyed metric below). A `What changed
// in this PR` section may also appear. Every nested finding's own
// `<summary>` never wraps its severity badge in `<strong>`, which is what
// lets `findSections` below tell a top-level section header apart from a
// nested one with a single discriminator. The header line's own
// `**Findings:** N <picture ... alt="... severity">` also carries an `alt=`
// attribute -- section-scoped extraction (below) never widens the "Open"
// item scan to include that header line, avoiding a double-count.

import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mts';
import {
  combineOwnerRepoFlags,
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  ghText,
  ghTextUnbounded,
  resolveGhApiHostname,
} from './gh-exec.mts';
import {
  AMD_MARKER_PATTERN,
  DISPOSITION_ACCEPTED_PREFIX_RE,
  DISPOSITION_REJECTED_PREFIX_RE,
  isCopilotReviewerLogin,
  isRejectionConfirmedDisposition,
  parsePaginatedGhNdjson,
} from './protocol-helpers.mts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'high' | 'medium' | 'low';
const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low'];

export type TransitionKey = 'none' | Severity;
const TRANSITION_KEYS: readonly TransitionKey[] = [
  'none',
  'low',
  'medium',
  'high',
];

/**
 * `deferred`/`rejected`/`accepted` mirror the issue's own three named
 * outcomes; `other` is a recognized-but-non-accept/reject disposition (an
 * `**Awaiting maintainer decision**` marker, or a
 * `**Rejection confirmed by maintainer**` reply); `none` is the true
 * remainder -- no reply at all, or replies exist but none are a recognized
 * disposition marker. `other` and `none` are deliberately NOT collapsed:
 * conflating "a human is still deciding" with "nobody has replied" would
 * hide exactly the distinction a cost-reduction measurement needs.
 */
export type Disposition =
  | 'deferred'
  | 'rejected'
  | 'accepted'
  | 'other'
  | 'none';
const DISPOSITIONS: readonly Disposition[] = [
  'deferred',
  'rejected',
  'accepted',
  'other',
  'none',
];

export interface RawReview {
  id: number;
  submittedAt: string | null;
  body: string;
  login: string;
}

export interface RawComment {
  id: number;
  inReplyToId: number | null;
  body: string;
  createdAt: string | null;
}

export interface ParsedOpenFinding {
  id: number;
  severity: Severity;
  isNew: boolean;
}

export type SeverityCounts = Record<Severity, number>;

export interface ParsedOverview {
  kind: 'v2' | 'legacy' | 'unparsed';
  open: ParsedOpenFinding[];
  previouslyMissed: SeverityCounts;
  unparsedReason?: string;
}

export interface FindingThread {
  id: number;
  severity: Severity;
  disposition: Disposition;
}

export interface TransitionRow {
  severity: TransitionKey;
  followed: number;
  last: number;
}

export interface ReviewSequenceEntry {
  kind: ParsedOverview['kind'];
  open: readonly ParsedOpenFinding[];
}

/**
 * One review's own parsed record, preserved per-review (not only folded
 * into the PR-level aggregates) so a report can answer "which findings
 * were new versus carried in THIS review" -- the issue's own "per v2
 * review, the Open findings with severity, discussion_r id, and
 * new-versus-carried status" requirement (Copilot review, PR #3245).
 */
export interface PrReviewRecord {
  reviewId: number;
  submittedAt: string | null;
  kind: ParsedOverview['kind'];
  /**
   * For `kind: 'v2'`, the trusted, fully-parsed Open findings -- these are
   * the ones folded into `PrAuditReport.openAppearances`/`.threads`. For
   * `kind: 'unparsed'`, this can still carry whatever partially parsed
   * behind the header/item count mismatch that caused `unparsedReason` --
   * kept here only for diagnosing the mismatch, deliberately excluded from
   * every aggregate (openAppearances, threads, the TSV per-finding table)
   * so an untrusted partial parse never pollutes a trusted total. For
   * `kind: 'legacy'`, always empty.
   */
  open: ParsedOpenFinding[];
  previouslyMissed: SeverityCounts;
  unparsedReason?: string;
}

export interface PrAuditReport {
  pr: number;
  reviewCount: number;
  v2Count: number;
  legacyCount: number;
  unparsedCount: number;
  openAppearances: SeverityCounts;
  previouslyMissed: SeverityCounts;
  reviews: PrReviewRecord[];
  threads: FindingThread[];
  transitions: TransitionRow[];
}

export interface CohortSummary {
  prCount: number;
  reviewCount: number;
  v2Count: number;
  legacyCount: number;
  unparsedCount: number;
  openAppearances: SeverityCounts;
  uniqueThreads: SeverityCounts;
  dispositionsBySeverity: Record<Severity, Record<Disposition, number>>;
  previouslyMissed: SeverityCounts;
  allLowFollowed: { followed: number; total: number };
  transitions: TransitionRow[];
}

function emptySeverityCounts(): SeverityCounts {
  return { high: 0, medium: 0, low: 0 };
}

function emptyDispositionCounts(): Record<Disposition, number> {
  return { deferred: 0, rejected: 0, accepted: 0, other: 0, none: 0 };
}

function toSeverity(word: string): Severity {
  return word.toLowerCase() as Severity;
}

// ---------------------------------------------------------------------------
// Pure core: overview-body parsing
// ---------------------------------------------------------------------------

const CCR_OVERVIEW_V2_MARKER = '<!-- ccr-overview-v2 -->';

// The discriminator between a top-level section header and a nested
// "Previously missed" finding's own <summary>: only a top-level header wraps
// its text in <strong>. See this file's header comment.
const SECTION_HEADER_RE = /<summary><strong>([^<]+)<\/strong><\/summary>/g;
const OPEN_HEADER_RE = /^Open \((\d+)\)$/;
const PREVIOUSLY_MISSED_HEADER_RE = /^Previously missed \((\d+)\)$/;
const SEVERITY_ALT_RE = /alt="(High|Medium|Low) severity"/g;
// Lazy `[\s\S]*?` is safe here only because each "Open" list item carries
// exactly one `alt="..."` (on its <picture>'s single <img>, never its
// <source> siblings) and exactly one `#discussion_r<id>` link -- confirmed
// against real bodies (PR #3147 review 5255592914, PR #3210 review
// 5292079228) -- so the lazy match cannot skip past one item into the next.
// `· New` is U+00B7 MIDDLE DOT, not an ASCII period.
const OPEN_ITEM_RE =
  /alt="(High|Medium|Low) severity"[\s\S]*?\]\(#discussion_r(\d+)\)(\s*·\s*New)?/g;

interface RawSection {
  header: string;
  content: string;
}

function findSections(body: string): RawSection[] {
  const sections: RawSection[] = [];
  const matches = [...body.matchAll(SECTION_HEADER_RE)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const header = match[1].trim();
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? body.length)
        : body.length;
    sections.push({ header, content: body.slice(contentStart, contentEnd) });
  }
  return sections;
}

/**
 * Parse one Copilot review's overview body. Never throws: a marker-absent
 * body is `legacy`; a marker-present body whose "Open" or "Previously
 * missed" section's parsed item count disagrees with its own header `(n)`
 * is `unparsed` (this file's own extraction likely missed something, e.g.
 * an unrecognized severity word) -- the acceptance criterion's "degrade
 * gracefully" contract. "Resolved since last review" and "What changed in
 * this PR" are recognized-and-ignored: neither feeds any metric this helper
 * computes, and an unrecognized future section on its own is deliberately
 * NOT treated as a parse failure -- only a genuine count mismatch in a
 * section this helper does rely on is.
 */
export function parseOverviewBody(body: unknown): ParsedOverview {
  const text = String(body ?? '');
  if (!text.includes(CCR_OVERVIEW_V2_MARKER)) {
    return {
      kind: 'legacy',
      open: [],
      previouslyMissed: emptySeverityCounts(),
    };
  }

  const open: ParsedOpenFinding[] = [];
  const previouslyMissed = emptySeverityCounts();
  const unparsedReasons: string[] = [];

  for (const { header, content } of findSections(text)) {
    const openMatch = OPEN_HEADER_RE.exec(header);
    if (openMatch) {
      const expected = Number.parseInt(openMatch[1], 10);
      const items = [...content.matchAll(OPEN_ITEM_RE)];
      for (const item of items) {
        open.push({
          severity: toSeverity(item[1]),
          id: Number.parseInt(item[2], 10),
          isNew: Boolean(item[3]),
        });
      }
      if (items.length !== expected) {
        unparsedReasons.push(
          `Open header declared ${expected} but ${items.length} were parsed`,
        );
      }
      continue;
    }

    const missedMatch = PREVIOUSLY_MISSED_HEADER_RE.exec(header);
    if (missedMatch) {
      const expected = Number.parseInt(missedMatch[1], 10);
      const alts = [...content.matchAll(SEVERITY_ALT_RE)];
      for (const alt of alts) {
        previouslyMissed[toSeverity(alt[1])] += 1;
      }
      if (alts.length !== expected) {
        unparsedReasons.push(
          `Previously missed header declared ${expected} but ${alts.length} were parsed`,
        );
      }
    }
  }

  if (unparsedReasons.length > 0) {
    return {
      kind: 'unparsed',
      open,
      previouslyMissed,
      unparsedReason: unparsedReasons.join('; '),
    };
  }

  return { kind: 'v2', open, previouslyMissed };
}

// ---------------------------------------------------------------------------
// Pure core: disposition classification
// ---------------------------------------------------------------------------

const DEFERRED_TO_FOLLOW_UP_RE = /\bdeferred to follow-up issue\b/i;

/**
 * Classify one reply body's disposition marker. `.trim()` (both ends)
 * deliberately merges two established call-site conventions in
 * protocol-helpers.mts: `isDispositionComment`'s `trimEnd()`-only
 * marker-first-bytes contract and `AMD_MARKER_PATTERN`'s own established
 * `trimStart()` call site -- real GitHub reply bodies carry no meaningful
 * leading/trailing whitespace, so merging both into a plain `.trim()` here
 * is a safe, deliberate simplification for this read-only historical audit
 * (never a gating decision on an in-flight thread). Returns `null` for any
 * reply that is not a recognized disposition marker at all (ordinary prose,
 * a reviewer's own follow-up remark, etc.).
 */
export function classifyDispositionReply(rawBody: unknown): Disposition | null {
  const trimmed = String(rawBody ?? '').trim();
  if (DISPOSITION_REJECTED_PREFIX_RE.test(trimmed)) {
    return DEFERRED_TO_FOLLOW_UP_RE.test(trimmed) ? 'deferred' : 'rejected';
  }
  if (DISPOSITION_ACCEPTED_PREFIX_RE.test(trimmed)) {
    return 'accepted';
  }
  if (
    AMD_MARKER_PATTERN.test(trimmed) ||
    isRejectionConfirmedDisposition({ body: trimmed })
  ) {
    return 'other';
  }
  return null;
}

/**
 * Resolve one finding thread's disposition from every reply whose
 * `inReplyToId` matches `findingId`, ordered by `createdAt` (falling back to
 * numeric `id`, both GitHub-monotonic proxies for creation order). When
 * several replies are recognized dispositions, the chronologically LAST
 * recognized one wins (a later correction supersedes an earlier one; a
 * trailing non-disposition remark does not erase an earlier recognized
 * disposition). `none` covers both "no reply at all" and "replies exist but
 * none are recognized".
 */
export function resolveThreadDisposition(
  findingId: number,
  comments: readonly RawComment[],
): Disposition {
  const replies = comments
    .filter((comment) => comment.inReplyToId === findingId)
    .slice()
    .sort((a, b) => {
      const aTime = a.createdAt ?? '';
      const bTime = b.createdAt ?? '';
      if (aTime !== bTime) {
        return aTime < bTime ? -1 : 1;
      }
      return a.id - b.id;
    });
  let resolved: Disposition | null = null;
  for (const reply of replies) {
    const classified = classifyDispositionReply(reply.body);
    if (classified) {
      resolved = classified;
    }
  }
  return resolved ?? 'none';
}

/**
 * Build one unique finding thread per id, keyed by the FIRST severity seen
 * for that id across `openFindingsInSubmissionOrder` (already the
 * submission-ordered concatenation of every v2 review's "Open" findings) --
 * distinct from the "appearances" metric (`PrAuditReport.openAppearances`),
 * which counts every listing, carried-over or not.
 */
export function buildFindingThreads(
  openFindingsInSubmissionOrder: readonly ParsedOpenFinding[],
  comments: readonly RawComment[],
): FindingThread[] {
  const firstSeen = new Map<number, Severity>();
  for (const finding of openFindingsInSubmissionOrder) {
    if (!firstSeen.has(finding.id)) {
      firstSeen.set(finding.id, finding.severity);
    }
  }
  return [...firstSeen.entries()].map(([id, severity]) => ({
    id,
    severity,
    disposition: resolveThreadDisposition(id, comments),
  }));
}

// ---------------------------------------------------------------------------
// Pure core: transition table
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

function highestOpenSeverity(
  open: readonly ParsedOpenFinding[],
): TransitionKey {
  let best: TransitionKey = 'none';
  for (const finding of open) {
    if (
      best === 'none' ||
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[best as Severity]
    ) {
      best = finding.severity;
    }
  }
  return best;
}

/**
 * Per v2 review, keyed by the highest "Open" severity in that review
 * (`none` when Open is empty), split into "followed by another Copilot
 * review" (any later review of either kind exists in the full sequence)
 * versus "last review". A legacy/unparsed review occupies a sequence
 * position (so a v2 review immediately before one still counts as
 * "followed") but contributes no row of its own.
 */
export function buildTransitionTable(
  reviewsInOrder: readonly ReviewSequenceEntry[],
): TransitionRow[] {
  const rows = new Map<TransitionKey, { followed: number; last: number }>();
  for (const key of TRANSITION_KEYS) {
    rows.set(key, { followed: 0, last: 0 });
  }
  reviewsInOrder.forEach((review, index) => {
    if (review.kind !== 'v2') {
      return;
    }
    const key = highestOpenSeverity(review.open);
    const bucket = rows.get(key);
    if (!bucket) {
      return;
    }
    if (index < reviewsInOrder.length - 1) {
      bucket.followed += 1;
    } else {
      bucket.last += 1;
    }
  });
  return TRANSITION_KEYS.map((severity) => ({
    severity,
    ...(rows.get(severity) ?? { followed: 0, last: 0 }),
  }));
}

// ---------------------------------------------------------------------------
// Pure core: per-PR and cohort aggregation
// ---------------------------------------------------------------------------

/**
 * Pure composition: given one PR's Copilot reviews (already filtered to
 * `isCopilotReviewerLogin`, sorted to submission order) and its review
 * comments, compute the full per-PR report. No `gh` call inside -- see
 * {@link auditPr} for the fetch-then-compute wrapper.
 */
export function computePrAudit(
  prNumber: number,
  copilotReviewsInOrder: readonly RawReview[],
  comments: readonly RawComment[],
): PrAuditReport {
  const parsedReviews = copilotReviewsInOrder.map((review) =>
    parseOverviewBody(review.body),
  );

  let v2Count = 0;
  let legacyCount = 0;
  let unparsedCount = 0;
  const openAppearances = emptySeverityCounts();
  const previouslyMissed = emptySeverityCounts();
  const allOpenInOrder: ParsedOpenFinding[] = [];

  for (const parsed of parsedReviews) {
    if (parsed.kind === 'v2') {
      v2Count += 1;
      for (const finding of parsed.open) {
        openAppearances[finding.severity] += 1;
        allOpenInOrder.push(finding);
      }
      for (const severity of SEVERITIES) {
        previouslyMissed[severity] += parsed.previouslyMissed[severity];
      }
    } else if (parsed.kind === 'legacy') {
      legacyCount += 1;
    } else {
      unparsedCount += 1;
    }
  }

  const threads = buildFindingThreads(allOpenInOrder, comments);
  const transitions = buildTransitionTable(
    parsedReviews.map((parsed) => ({ kind: parsed.kind, open: parsed.open })),
  );
  const reviews: PrReviewRecord[] = copilotReviewsInOrder.map(
    (review, index) => {
      const parsed = parsedReviews[index];
      return {
        reviewId: review.id,
        submittedAt: review.submittedAt,
        kind: parsed.kind,
        open: parsed.open,
        previouslyMissed: parsed.previouslyMissed,
        ...(parsed.unparsedReason
          ? { unparsedReason: parsed.unparsedReason }
          : {}),
      };
    },
  );

  return {
    pr: prNumber,
    reviewCount: copilotReviewsInOrder.length,
    v2Count,
    legacyCount,
    unparsedCount,
    openAppearances,
    previouslyMissed,
    reviews,
    threads,
    transitions,
  };
}

/** Pure aggregation across a cohort of per-PR reports. */
export function summarizeCohort(
  reports: readonly PrAuditReport[],
): CohortSummary {
  const dispositionsBySeverity: Record<
    Severity,
    Record<Disposition, number>
  > = {
    high: emptyDispositionCounts(),
    medium: emptyDispositionCounts(),
    low: emptyDispositionCounts(),
  };
  const uniqueThreads = emptySeverityCounts();
  const openAppearances = emptySeverityCounts();
  const previouslyMissed = emptySeverityCounts();
  let reviewCount = 0;
  let v2Count = 0;
  let legacyCount = 0;
  let unparsedCount = 0;
  const transitionTotals = new Map<
    TransitionKey,
    { followed: number; last: number }
  >();
  for (const key of TRANSITION_KEYS) {
    transitionTotals.set(key, { followed: 0, last: 0 });
  }

  for (const report of reports) {
    reviewCount += report.reviewCount;
    v2Count += report.v2Count;
    legacyCount += report.legacyCount;
    unparsedCount += report.unparsedCount;
    for (const severity of SEVERITIES) {
      openAppearances[severity] += report.openAppearances[severity];
      previouslyMissed[severity] += report.previouslyMissed[severity];
    }
    for (const thread of report.threads) {
      uniqueThreads[thread.severity] += 1;
      dispositionsBySeverity[thread.severity][thread.disposition] += 1;
    }
    for (const row of report.transitions) {
      const bucket = transitionTotals.get(row.severity);
      if (!bucket) {
        continue;
      }
      bucket.followed += row.followed;
      bucket.last += row.last;
    }
  }

  const lowTransitions = transitionTotals.get('low') ?? {
    followed: 0,
    last: 0,
  };

  return {
    prCount: reports.length,
    reviewCount,
    v2Count,
    legacyCount,
    unparsedCount,
    openAppearances,
    uniqueThreads,
    dispositionsBySeverity,
    previouslyMissed,
    allLowFollowed: {
      followed: lowTransitions.followed,
      total: lowTransitions.followed + lowTransitions.last,
    },
    transitions: TRANSITION_KEYS.map((severity) => ({
      severity,
      ...(transitionTotals.get(severity) ?? { followed: 0, last: 0 }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Fetch layer
// ---------------------------------------------------------------------------

interface RestReviewPayload {
  id?: unknown;
  submitted_at?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
}

interface RestCommentPayload {
  id?: unknown;
  in_reply_to_id?: unknown;
  body?: unknown;
  created_at?: unknown;
}

function toRawReview(raw: RestReviewPayload): RawReview {
  return {
    id: Number(raw.id),
    submittedAt: typeof raw.submitted_at === 'string' ? raw.submitted_at : null,
    body: String(raw.body ?? ''),
    login: String(raw.user?.login ?? ''),
  };
}

function toRawComment(raw: RestCommentPayload): RawComment {
  const replyTo = raw.in_reply_to_id;
  return {
    id: Number(raw.id),
    inReplyToId:
      replyTo === null || replyTo === undefined ? null : Number(replyTo),
    body: String(raw.body ?? ''),
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
  };
}

function sortReviewsBySubmission(reviews: readonly RawReview[]): RawReview[] {
  return reviews.slice().sort((a, b) => {
    const aTime = a.submittedAt ?? '';
    const bTime = b.submittedAt ?? '';
    if (aTime !== bTime) {
      return aTime < bTime ? -1 : 1;
    }
    return a.id - b.id;
  });
}

/**
 * Fetch one `gh api` REST path, merging paginated pages correctly (`gh api
 * --paginate` alone prints one JSON array PER PAGE, so relying on its raw
 * output to self-merge silently drops every page but the first --
 * `--jq '.[]'` instead emits one NDJSON line per element across every page,
 * which {@link parsePaginatedGhNdjson} re-merges into a single array).
 *
 * Reads the child process's stdout through a temp file
 * ({@link ghTextUnbounded}) rather than an in-memory pipe with a fixed
 * `maxBuffer` ceiling: a PR with many review comments can exceed any fixed
 * buffer guess -- this repository's own PR #3154 (inside the 2026-09-24
 * baseline window) has 203 review comments totaling ~1.26 MB of paginated
 * NDJSON, already past Node's default 1 MiB child-process buffer, which
 * crashed the whole cohort run rather than just that one PR (found and
 * independently reproduced during this issue's own review-fix critique
 * pass on PR #3245, alongside Copilot's separate `#discussion_r4086537940`
 * finding). Mirrors the identical fix `sweep-authoring-markers.mts` applies
 * to its own
 * paginated GraphQL walk (#2935) -- removing the buffer-guessing class of
 * bug entirely, rather than sizing a fixed cap that could still be wrong
 * for some future PR.
 */
function ghApiPaginatedUnbounded(path: string): unknown[] {
  const hostname = resolveGhApiHostname();
  const args = [
    'api',
    path,
    ...(hostname ? ['--hostname', hostname] : []),
    '--paginate',
    '--jq',
    '.[]',
  ];
  const raw = ghTextUnbounded(args, {
    timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  });
  return parsePaginatedGhNdjson(raw);
}

/**
 * Fetch one PR's reviews and review comments and compute the PR's audit
 * report. The only network-touching function in this file besides the
 * PR-number resolvers below.
 */
export function auditPr(
  owner: string,
  repo: string,
  prNumber: number,
): PrAuditReport {
  const rawReviews = ghApiPaginatedUnbounded(
    `repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
  ) as RestReviewPayload[];
  const rawComments = ghApiPaginatedUnbounded(
    `repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
  ) as RestCommentPayload[];

  const copilotReviews = sortReviewsBySubmission(
    rawReviews
      .map(toRawReview)
      .filter((review) => isCopilotReviewerLogin(review.login)),
  );
  const comments = rawComments.map(toRawComment);

  return computePrAudit(prNumber, copilotReviews, comments);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(message: string): never {
  process.stderr.write(`copilot-review-wave-audit: ${message}\n`);
  process.exit(2);
}

function detectRepository(): string {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  return ghText([
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]);
}

function parseRepository(value: string): [string, string] {
  const parts = value.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => part.length === 0 || /\s/.test(part))
  ) {
    fail(`invalid repository "${value}"; expected owner/name`);
  }
  return parts as [string, string];
}

function parsePrNumberList(value: string): number[] {
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const token of value.split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') {
      continue;
    }
    const num = parseCanonicalIntegerOrThrow(trimmed, '--prs');
    if (!seen.has(num)) {
      seen.add(num);
      numbers.push(num);
    }
  }
  if (numbers.length === 0) {
    fail('--prs must contain at least one PR number');
  }
  return numbers;
}

// `gh pr list` (and the GitHub search API it wraps) has no "sort by merge
// date" qualifier -- only creation/update/comments/reactions -- and sorts
// merged-state results by creation date descending, NOT merge date
// (confirmed live: a PR created later but merged earlier sorts ahead of one
// created earlier but merged later). A plain `--limit N` therefore returns
// the N most recently CREATED merged PRs, not the N most recently MERGED
// ones -- a real gap for a tool whose whole purpose is precise, reproducible
// measurement (found during this issue's own review-fix critique pass on
// PR #3245, not a GitHub bot finding). Over-fetch a generous multiple of
// `limit` (capped) and re-sort client-side by `mergedAt` instead. This is a
// best-effort correction, not a mathematical guarantee: a PR merged long
// after a long review cycle could still fall outside the over-fetched pool
// in a pathological case. `--prs <n,n,...>` (an explicit, caller-resolved
// number set, as this helper's own baseline reproduction command in
// docs/critique-telemetry.md uses) is the fully precise route when exact
// reproducibility matters.
export const RECENT_MERGED_OVER_FETCH_MULTIPLIER = 5;
export const RECENT_MERGED_OVER_FETCH_MIN = 100;
export const RECENT_MERGED_OVER_FETCH_MAX = 1000;

export interface MergedPrCandidate {
  number: number;
  mergedAt: string | null;
}

/**
 * Pure sort/select core of the `--limit` fix above (exported so it is
 * unit-testable without shelling out to `gh`): descending by `mergedAt`
 * (a `null` -- a PR `gh pr list` reports merged but with no timestamp,
 * which should not happen but is defended against -- sorts last), ties
 * broken by descending PR number for determinism, then the first `limit`
 * entries.
 */
export function selectMostRecentlyMerged(
  candidates: readonly MergedPrCandidate[],
  limit: number,
): number[] {
  return candidates
    .slice()
    .sort((a, b) => {
      const aTime = a.mergedAt ?? '';
      const bTime = b.mergedAt ?? '';
      if (aTime !== bTime) {
        return aTime < bTime ? 1 : -1;
      }
      return b.number - a.number;
    })
    .slice(0, limit)
    .map((entry) => entry.number);
}

function resolveRecentMergedPrNumbers(
  owner: string,
  repo: string,
  limit: number,
): number[] {
  const fetchCount = Math.min(
    Math.max(
      limit * RECENT_MERGED_OVER_FETCH_MULTIPLIER,
      RECENT_MERGED_OVER_FETCH_MIN,
    ),
    RECENT_MERGED_OVER_FETCH_MAX,
  );
  if (fetchCount < limit) {
    // Reachable whenever `limit` exceeds RECENT_MERGED_OVER_FETCH_MAX
    // (e.g. `--limit 2000`): the ceiling caps fetchCount at MAX regardless
    // of how large `limit` itself is, so without this guard the CLI would
    // silently return fewer PRs than requested instead of the documented
    // "N most recently merged" count -- fail closed instead.
    // parseCanonicalIntegerOrThrow places no upper bound of its own on
    // --limit, so this is the only enforcement point.
    fail(
      `--limit ${limit} exceeds this helper's over-fetch ceiling (${RECENT_MERGED_OVER_FETCH_MAX}); use --prs <n,n,...> with an explicit, caller-resolved number set instead`,
    );
  }
  const raw = ghText([
    'pr',
    'list',
    '--repo',
    `${owner}/${repo}`,
    '--state',
    'merged',
    '--limit',
    String(fetchCount),
    '--json',
    'number,mergedAt',
  ]);
  const parsed = JSON.parse(raw) as MergedPrCandidate[];
  if (
    parsed.length === fetchCount &&
    fetchCount === RECENT_MERGED_OVER_FETCH_MAX
  ) {
    // The fetch hit its ceiling and may not have been large enough to
    // guarantee the true top `limit` by merge date are all present in the
    // over-fetched pool (see this section's header comment) -- warn rather
    // than silently return a best-effort-but-unverifiable answer.
    process.stderr.write(
      `copilot-review-wave-audit: warning: --limit ${limit} is large enough that the ` +
        `${RECENT_MERGED_OVER_FETCH_MAX}-PR over-fetch ceiling may not include every ` +
        'candidate; the result is best-effort, not guaranteed exact. Use --prs for a ' +
        'fully precise number set.\n',
    );
  }
  return selectMostRecentlyMerged(parsed, limit);
}

const COPILOT_REVIEW_WAVE_AUDIT_FLAG_SPEC = {
  '--prs': { type: 'string' },
  '--limit': { type: 'string' },
  '--format': { type: 'string', default: 'json' },
  '--repo': { type: 'string' },
  '--owner': { type: 'string' },
  '--help': { type: 'boolean', short: 'h', default: false },
} as const;

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/copilot-review-wave-audit.mjs --prs <n,n,...> [options]
  node scripts/copilot-review-wave-audit.mjs --limit <N> [options]

  --prs <n,n,...>     Audit these merged PR numbers (mutually exclusive
                      with --limit).
  --limit <N>         Audit the N most recently merged PRs, sorted by
                      merge date (best-effort: over-fetches and
                      re-sorts client-side, since GitHub has no
                      merge-date sort of its own -- use --prs for a
                      fully precise, reproducible number set).
                      Mutually exclusive with --prs.
  --format <json|tsv> Output format (default: json).
  --repo <owner/name> Repository override, combined form.
  --owner <owner>     Repository override, split form (use with
                      --repo <name>, the bare repository name -- not
                      both --owner and a combined --repo together).
  --help, -h          Show this help.

Computes, per PR and as a cohort summary: Copilot review count (v2 vs.
legacy), "Open" finding appearances by severity, unique finding-thread
counts by severity (first severity seen), each thread's disposition
(deferred/rejected/accepted/other/none), "Previously missed"
per-severity counts (thread-less, excluded from thread metrics), and a
transition table keyed by each v2 review's highest Open severity. Each
per-PR report also preserves the full per-review breakdown (severity,
discussion_r id, and new-versus-carried status per Open finding) --
"reviews" in JSON output, a second severity/finding-id/is_new table in
TSV output.
`);
}

function formatSeverityCounts(counts: SeverityCounts): string {
  return `high=${counts.high} medium=${counts.medium} low=${counts.low}`;
}

function formatDispositionCounts(counts: Record<Disposition, number>): string {
  return DISPOSITIONS.map(
    (disposition) => `${disposition}=${counts[disposition]}`,
  ).join(' ');
}

function writeJsonReport(
  reports: PrAuditReport[],
  summary: CohortSummary,
): void {
  process.stdout.write(`${JSON.stringify({ reports, summary }, null, 2)}\n`);
}

function writeTsvReport(
  reports: PrAuditReport[],
  summary: CohortSummary,
): void {
  const lines: string[] = [];
  lines.push(
    [
      'pr',
      'reviews',
      'v2',
      'legacy',
      'unparsed',
      'open_high',
      'open_medium',
      'open_low',
      'prevmissed_high',
      'prevmissed_medium',
      'prevmissed_low',
      'threads',
    ].join('\t'),
  );
  for (const report of reports) {
    lines.push(
      [
        report.pr,
        report.reviewCount,
        report.v2Count,
        report.legacyCount,
        report.unparsedCount,
        report.openAppearances.high,
        report.openAppearances.medium,
        report.openAppearances.low,
        report.previouslyMissed.high,
        report.previouslyMissed.medium,
        report.previouslyMissed.low,
        report.threads.length,
      ].join('\t'),
    );
  }
  lines.push('');
  lines.push(
    [
      'pr',
      'review_id',
      'submitted_at',
      'kind',
      'severity',
      'finding_id',
      'is_new',
    ].join('\t'),
  );
  for (const report of reports) {
    for (const review of report.reviews) {
      // Only v2 reviews feed openAppearances/threads (computePrAudit
      // deliberately excludes legacy/unparsed reviews from those
      // aggregates); an unparsed review's `open` can still carry the
      // partially-parsed items behind its header/item count mismatch
      // (diagnostic value, kept in the JSON report's own `reviews[]`), but
      // listing them here too would let a naive per-severity sum of this
      // table diverge from the summary's openAppearances -- skip them in
      // this table, matching the aggregate's own scope exactly.
      if (review.kind !== 'v2') {
        continue;
      }
      for (const finding of review.open) {
        lines.push(
          [
            report.pr,
            review.reviewId,
            review.submittedAt ?? '',
            review.kind,
            finding.severity,
            finding.id,
            String(finding.isNew),
          ].join('\t'),
        );
      }
    }
  }
  lines.push('');
  lines.push(
    `# cohort: prs=${summary.prCount} reviews=${summary.reviewCount} v2=${summary.v2Count} legacy=${summary.legacyCount} unparsed=${summary.unparsedCount}`,
  );
  lines.push(
    `# open_appearances: ${formatSeverityCounts(summary.openAppearances)}`,
  );
  lines.push(
    `# unique_threads: ${formatSeverityCounts(summary.uniqueThreads)}`,
  );
  lines.push(
    `# previously_missed: ${formatSeverityCounts(summary.previouslyMissed)}`,
  );
  for (const severity of SEVERITIES) {
    lines.push(
      `# dispositions[${severity}]: ${formatDispositionCounts(summary.dispositionsBySeverity[severity])}`,
    );
  }
  lines.push(
    `# all_low_followed: ${summary.allLowFollowed.followed}/${summary.allLowFollowed.total}`,
  );
  for (const row of summary.transitions) {
    lines.push(
      `# transition[${row.severity}]: followed=${row.followed} last=${row.last}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (import.meta.main) {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    COPILOT_REVIEW_WAVE_AUDIT_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }

  const prsFlag = values.prs as string | undefined;
  const limitFlag = values.limit as string | undefined;
  if (Boolean(prsFlag) === Boolean(limitFlag)) {
    fail('choose exactly one of --prs <n,n,...> or --limit <N>');
  }
  const format = values.format as string;
  if (format !== 'json' && format !== 'tsv') {
    fail(`--format must be "json" or "tsv", got "${format}"`);
  }

  let repository: string;
  try {
    repository =
      combineOwnerRepoFlags(values as { owner?: string; repo?: string }) ??
      detectRepository();
  } catch (error) {
    fail((error as Error).message);
  }
  const [owner, repo] = parseRepository(repository);

  const prNumbers = prsFlag
    ? parsePrNumberList(prsFlag)
    : resolveRecentMergedPrNumbers(
        owner,
        repo,
        parseCanonicalIntegerOrThrow(limitFlag, '--limit'),
      );

  const reports = prNumbers.map((prNumber) => auditPr(owner, repo, prNumber));
  const summary = summarizeCohort(reports);

  if (format === 'tsv') {
    writeTsvReport(reports, summary);
  } else {
    writeJsonReport(reports, summary);
  }
}
