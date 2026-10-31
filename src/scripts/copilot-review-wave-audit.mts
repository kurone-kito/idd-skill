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
// INTERNAL_ENTRY_REASONS in src/scripts/repository-inventory-audit.mts (its
// entry for scripts/copilot-review-wave-audit.mjs),
// same class as audit-code-span-wrap.mts / idd-critique-report.mts) -- an
// adopter repository has no Copilot-review-wave baseline of its own to
// measure against this one.
//
// Copilot's severity label is only machine-readable from a review body
// carrying the `<!-- ccr-overview-v2 -->` marker (a body without it is
// `legacy`). Findings are grouped under `<details><summary><strong>...`
// sections: the Open section, as `Open (<n>)` (the original format),
// `<n> open findings` (from about 2026-10-07, issue #4184), or
// `<n> open issues` (from 2026-10-16, issue #4472); `Resolved since last
// review (<n>)` or `<n> resolved since last review`; and the previously missed
// section, as `Previously missed (<n>)` or, from 2026-10-16,
// `<n> previously missed issues` (each nested finding under it carries a
// severity but no `#discussion_r<id>` link, so it has no thread to key by --
// excluded from every thread-keyed metric below). A `What changed in this PR`
// section may also appear. Every nested finding's own `<summary>` never wraps
// its severity badge in `<strong>`, which is what lets `findSections`
// (copilot-overview-sections.mts) tell a top-level section header apart from a
// nested one with a single discriminator. In the original format the header
// line's own `**Findings:** N <picture ... alt="... severity">` also carries an
// `alt=` attribute; the October 2026 format (issue #4184) has a bold `**<n> open
// findings**` line with no `alt=` at all. Section-scoped extraction (below)
// never widens the "Open" item scan to include either line, avoiding a
// double-count.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mts';
import {
  emptySeverityCounts,
  type ParsedOpenFinding,
  parseOverviewSections,
  type Severity,
  type SeverityCounts,
} from './copilot-overview-sections.mts';
import {
  combineOwnerRepoFlags,
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  ghText,
  ghTextUnbounded,
  resolveGhApiHostname,
} from './gh-exec.mts';
import { stripMarkdownCodeRegions } from './markdown-code.mts';
import { parseTriageLine } from './policy-helpers.mts';
import {
  AMD_MARKER_PATTERN,
  classifyCommentEditState,
  DISPOSITION_ACCEPTED_PREFIX_RE,
  DISPOSITION_REJECTED_PREFIX_RE,
  isCopilotReviewerLogin,
  isRejectionConfirmedDisposition,
  parsePaginatedGhNdjson,
} from './protocol-helpers.mts';
import { fetchLastEditedAtByNodeId } from './provider-adapter-github.mts';

// Re-exported so the wave audit keeps its public types (its own test imports
// `ParsedOpenFinding` from here), while the shared extraction owns them.
export type {
  ParsedOpenFinding,
  Severity,
  SeverityCounts,
} from './copilot-overview-sections.mts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low'];

export type TransitionKey = 'none' | Severity;
const TRANSITION_KEYS: readonly TransitionKey[] = [
  'none',
  'low',
  'medium',
  'high',
];

export type ReviewTrigger =
  | 'first'
  | 'sameHead'
  | 'newHead'
  | 'mergeCommitHead'
  | 'unknown';
export type NextReviewTrigger = Exclude<ReviewTrigger, 'first'>;
export type ReviewVerdict = 'approval' | 'changes' | 'closerLook';

export interface WhatChanged {
  paths: string[];
  generatedHelperPaths: string[];
  syncMirrorPaths: string[];
}

export interface FindingPathClass {
  generatedHelper: number;
  syncMirror: number;
  other: number;
  noPath: number;
}

export interface ApprovalAudit {
  total: number;
  followed: number;
  nextTrigger: Record<NextReviewTrigger, number>;
}

const REVIEW_TRIGGERS: readonly ReviewTrigger[] = [
  'first',
  'sameHead',
  'newHead',
  'mergeCommitHead',
  'unknown',
];
const NEXT_REVIEW_TRIGGERS: readonly NextReviewTrigger[] = [
  'sameHead',
  'newHead',
  'mergeCommitHead',
  'unknown',
];
export type DispositionReviewCountBucket = '1-2' | '3-4' | '5-9' | '10+';

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
  /** The commit the review was made on (REST `commit_id`). */
  commitId?: string | null;
}

export interface RawComment {
  id: number;
  inReplyToId: number | null;
  body: string;
  createdAt: string | null;
  lastEditedAt?: string | null;
  login?: string | null;
  path?: string | null;
  side?: string | null;
  /** REST `original_line`: the line on the commit the comment was made on. */
  originalLine?: number | null;
  pullRequestReviewId?: number | null;
}

/** One file entry of a `repos/.../compare/{base}...{head}` response. */
export interface CompareFile {
  filename: string;
  patch?: string;
}

/**
 * Where a Copilot inline finding sits relative to the previous push (issue
 * #4190). `unknown` covers every comment the locality rules cannot place.
 */
export interface FindingLocality {
  firstWave: number;
  nearPreviousPush: number;
  sameFileElsewhere: number;
  untouchedFile: number;
  unknown: number;
}

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
  commitId: string | null;
  trigger: ReviewTrigger;
  verdict: ReviewVerdict | null;
  whatChanged: WhatChanged | null;
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

export type TriageOutcome = 'accepted' | 'deferred' | 'rejected';
export type TriageUrgency = 'very-low' | 'low' | 'medium' | 'high';
export type TriageStep = '0' | '1' | '2';

export interface TriageStepCounts {
  urgency: Record<TriageUrgency, number>;
  outcome: Record<TriageOutcome, number>;
}

/**
 * Recorded `Triage:` lines on finding threads whose disposition is accepted,
 * deferred, or rejected (issue #4189). `recorded` and `unrecorded` partition
 * those threads; `malformed` is the subset of `unrecorded` whose reply's first
 * Triage-like line (the opener forms of `TRIAGE_OPENER_LINE_RE`) yields no
 * record, so parser drift shows up as a count instead of silently lowering the
 * recorded share.
 */
export interface TriageAudit {
  recorded: number;
  unrecorded: number;
  malformed: number;
  byStep: Record<TriageStep, TriageStepCounts>;
  overrides: number;
  contradictions: number;
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
  triage: TriageAudit;
  findingLocality: FindingLocality;
  triggers: Record<ReviewTrigger, number>;
  approvals: ApprovalAudit;
  findingPathClass: FindingPathClass;
  /** Merge time from `gh pr list` under `--limit` or a merge window. */
  mergedAt: string | null;
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
  triage: TriageAudit;
  findingLocality: FindingLocality;
  triggers: Record<ReviewTrigger, number>;
  approvals: ApprovalAudit;
  findingPathClass: FindingPathClass;
  whatChanged: {
    tables: number;
    listingGeneratedHelper: number;
    listingSyncMirror: number;
  };
  dispositionsByReviewCount: Record<
    DispositionReviewCountBucket,
    Record<Disposition, number>
  >;
}

function emptyDispositionCounts(): Record<Disposition, number> {
  return { deferred: 0, rejected: 0, accepted: 0, other: 0, none: 0 };
}

// ---------------------------------------------------------------------------
// Pure core: overview-body parsing
// ---------------------------------------------------------------------------

const CCR_OVERVIEW_V2_MARKER = '<!-- ccr-overview-v2 -->';

/**
 * Parse one Copilot review's overview body. Never throws: a marker-absent
 * body is `legacy`; a marker-present body whose sections are not consistent
 * with their own headers (see `parseOverviewSections`) is `unparsed`, keeping
 * the partial extraction -- the "degrade gracefully" contract. "Resolved since
 * last review" and "What changed in this PR" are recognized-and-ignored.
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

  const { open, previouslyMissed, unparsedReasons } =
    parseOverviewSections(text);
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
 * Classify one reply body's disposition marker, preserving each pattern's
 * own established trim contract exactly rather than merging them (Copilot
 * review, PR #3245, re-review 2026-09-23T20:43:20Z,
 * `#discussion_r4086537940`'s sibling "Previously missed" finding: an
 * earlier revision here used a single `.trim()` for every pattern, which
 * would classify `"  **Accepted** ..."` -- leading whitespace before the
 * marker -- as a valid disposition, even though `isDispositionComment`
 * (`protocol-helpers.mts`) deliberately rejects exactly that case via its
 * own `trimEnd()`-only, marker-first-bytes contract. Since this audit's
 * whole point is fidelity to what the merge gate actually credits, a
 * looser trim here would silently disagree with the gate on some real
 * replies). `DISPOSITION_ACCEPTED_PREFIX_RE`/`DISPOSITION_REJECTED_PREFIX_RE`
 * therefore use `trimEnd()` only, matching `isDispositionComment` exactly;
 * `AMD_MARKER_PATTERN` uses `trimStart()`, matching its own established
 * call site; `isRejectionConfirmedDisposition` trims internally, so the
 * raw body is passed through unmodified. Returns `null` for any reply that
 * is not a recognized disposition marker at all (ordinary prose, a
 * reviewer's own follow-up remark, etc.).
 */
export function classifyDispositionReply(rawBody: unknown): Disposition | null {
  const body = String(rawBody ?? '');
  const trimmedEnd = body.trimEnd();
  if (DISPOSITION_REJECTED_PREFIX_RE.test(trimmedEnd)) {
    return DEFERRED_TO_FOLLOW_UP_RE.test(trimmedEnd) ? 'deferred' : 'rejected';
  }
  if (DISPOSITION_ACCEPTED_PREFIX_RE.test(trimmedEnd)) {
    return 'accepted';
  }
  if (
    AMD_MARKER_PATTERN.test(body.trimStart()) ||
    isRejectionConfirmedDisposition({ body })
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
export interface ThreadDispositionReply {
  disposition: Disposition;
  /** Body of the winning reply, or `null` when no reply is recognized. */
  body: string | null;
}

/**
 * Resolve one finding thread's winning disposition reply, and its body, by
 * the rules of {@link resolveThreadDisposition}. The body feeds the triage
 * audit; the disposition is the same value the thread metrics use.
 */
export function resolveThreadDispositionReply(
  findingId: number,
  comments: readonly RawComment[],
): ThreadDispositionReply {
  const replies = comments
    .filter(
      (comment) =>
        comment.inReplyToId === findingId &&
        classifyCommentEditState(comment) === 'unedited',
    )
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
  let resolvedBody: string | null = null;
  for (const reply of replies) {
    const classified = classifyDispositionReply(reply.body);
    if (classified) {
      resolved = classified;
      resolvedBody = reply.body;
    }
  }
  if (resolved === null) {
    return { disposition: 'none', body: null };
  }
  return { disposition: resolved, body: resolvedBody };
}

export function resolveThreadDisposition(
  findingId: number,
  comments: readonly RawComment[],
): Disposition {
  return resolveThreadDispositionReply(findingId, comments).disposition;
}

// ---------------------------------------------------------------------------
// Pure core: triage audit (issue #4189)
// ---------------------------------------------------------------------------

const TRIAGE_URGENCIES: readonly TriageUrgency[] = [
  'very-low',
  'low',
  'medium',
  'high',
];
const TRIAGE_STEPS: readonly TriageStep[] = ['0', '1', '2'];
const TRIAGE_OUTCOMES: readonly TriageOutcome[] = [
  'accepted',
  'deferred',
  'rejected',
];
// A Triage-like line is an attempted record, so a malformed one cannot pass as
// unrecorded (Copilot reviews of #4268). It is the case-insensitive word
// `Triage` followed by optional spaces or tabs and a colon, at the start of the
// line after any run of spaces, tabs, list bullets (`-`, `+`), and `*` marks,
// with an optional `*` or `**` right after the word. The emphasis marks need
// not pair up. Underscore emphasis is not matched. The prefix never spans a
// newline. A reply is recorded when its first Triage-like line parses with
// `parseTriageLine`. A reply whose first such line does not parse is
// malformed, even when a later line would parse: that fails closed.
const TRIAGE_OPENER_LINE_RE = /^[ \t*+-]*triage(?:\*\*|\*)?[ \t]*:/iu;

function isTriageOutcome(
  disposition: Disposition,
): disposition is TriageOutcome {
  return (TRIAGE_OUTCOMES as readonly Disposition[]).includes(disposition);
}

function emptyTriageStepCounts(): TriageStepCounts {
  return {
    urgency: { 'very-low': 0, low: 0, medium: 0, high: 0 },
    outcome: { accepted: 0, deferred: 0, rejected: 0 },
  };
}

function emptyTriageAudit(): TriageAudit {
  return {
    recorded: 0,
    unrecorded: 0,
    malformed: 0,
    byStep: {
      '0': emptyTriageStepCounts(),
      '1': emptyTriageStepCounts(),
      '2': emptyTriageStepCounts(),
    },
    overrides: 0,
    contradictions: 0,
  };
}

function addTriageAudit(target: TriageAudit, source: TriageAudit): void {
  target.recorded += source.recorded;
  target.unrecorded += source.unrecorded;
  target.malformed += source.malformed;
  target.overrides += source.overrides;
  target.contradictions += source.contradictions;
  for (const step of TRIAGE_STEPS) {
    for (const urgency of TRIAGE_URGENCIES) {
      target.byStep[step].urgency[urgency] +=
        source.byStep[step].urgency[urgency];
    }
    for (const outcome of TRIAGE_OUTCOMES) {
      target.byStep[step].outcome[outcome] +=
        source.byStep[step].outcome[outcome];
    }
  }
}

/**
 * Count the `Triage:` lines of one PR's accepted, deferred, or rejected
 * threads (issue #4189). Threads with `other` or `none` are not counted. A
 * recorded line with an `override:` part is an override and is never a
 * contradiction. Otherwise a contradiction is an accepted reply whose recorded
 * line says `verdict defer`.
 */
function computeTriageAudit(
  threads: readonly FindingThread[],
  comments: readonly RawComment[],
): TriageAudit {
  const audit = emptyTriageAudit();
  for (const thread of threads) {
    if (!isTriageOutcome(thread.disposition)) {
      continue;
    }
    const outcome = thread.disposition;
    const { body } = resolveThreadDispositionReply(thread.id, comments);
    // The first Triage-like line decides, so a malformed first line is not
    // rescued by a later parseable one (Copilot review of #4268).
    const opener =
      body === null
        ? undefined
        : body.split(/\r?\n/u).find((line) => TRIAGE_OPENER_LINE_RE.test(line));
    const record = opener === undefined ? null : parseTriageLine(opener);
    if (record === null) {
      audit.unrecorded += 1;
      if (opener !== undefined) {
        audit.malformed += 1;
      }
      continue;
    }
    audit.recorded += 1;
    const step = String(record.step) as TriageStep;
    audit.byStep[step].urgency[record.urgency] += 1;
    audit.byStep[step].outcome[outcome] += 1;
    if (record.override !== null) {
      audit.overrides += 1;
      continue;
    }
    if (outcome === 'accepted' && record.verdict === 'defer') {
      audit.contradictions += 1;
    }
  }
  return audit;
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

/** A finding this close to a line the previous push changed is `nearPreviousPush`. */
const NEAR_PREVIOUS_PUSH_LINE_DISTANCE = 3;
/** GitHub's compare endpoint caps its `files` list at this many entries. */
const COMPARE_FILES_CAP = 300;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * The new-file line numbers a unified-diff `patch` changed (issue #4190).
 * A `+` line records its line and advances; a `-` line records the line it
 * would occupy without advancing; a space advances; `\` and empty lines are
 * ignored. A `patch` field has no `---`/`+++` file header, so a removed line
 * such as `-- x` is correctly read as a deletion.
 */
export function parseChangedNewLines(patch: string): number[] {
  const changed = new Set<number>();
  let counter: number | null = null;
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER_RE.exec(line);
    if (header) {
      counter = Number(header[1]);
      continue;
    }
    if (counter === null) {
      continue;
    }
    if (line.startsWith('+')) {
      changed.add(counter);
      counter += 1;
    } else if (line.startsWith('-')) {
      changed.add(counter);
    } else if (line.startsWith(' ')) {
      counter += 1;
    }
  }
  return [...changed].sort((a, b) => a - b);
}

/**
 * The compare response's file list, or `null` when it cannot be trusted:
 * a non-array, or exactly the endpoint's cap, which may hide a file that
 * the previous push touched. A `null` makes its comments `unknown`, never
 * `untouchedFile`.
 */
export function toCompareFiles(raw: unknown): readonly CompareFile[] | null {
  if (!Array.isArray(raw) || raw.length >= COMPARE_FILES_CAP) {
    return null;
  }
  return raw.map((entry: unknown): CompareFile => {
    const file = (entry ?? {}) as { filename?: unknown; patch?: unknown };
    return {
      filename: String(file.filename ?? ''),
      ...(typeof file.patch === 'string' ? { patch: file.patch } : {}),
    };
  });
}

function emptyFindingLocality(): FindingLocality {
  return {
    firstWave: 0,
    nearPreviousPush: 0,
    sameFileElsewhere: 0,
    untouchedFile: 0,
    unknown: 0,
  };
}

function emptyReviewTriggerCounts(): Record<ReviewTrigger, number> {
  return { first: 0, sameHead: 0, newHead: 0, mergeCommitHead: 0, unknown: 0 };
}

function emptyApprovalAudit(): ApprovalAudit {
  return {
    total: 0,
    followed: 0,
    nextTrigger: { sameHead: 0, newHead: 0, mergeCommitHead: 0, unknown: 0 },
  };
}

function emptyFindingPathClass(): FindingPathClass {
  return { generatedHelper: 0, syncMirror: 0, other: 0, noPath: 0 };
}

function emptyDispositionsByReviewCount(): Record<
  DispositionReviewCountBucket,
  Record<Disposition, number>
> {
  return {
    '1-2': emptyDispositionCounts(),
    '3-4': emptyDispositionCounts(),
    '5-9': emptyDispositionCounts(),
    '10+': emptyDispositionCounts(),
  };
}

function dispositionReviewCountBucket(
  reviewCount: number,
): DispositionReviewCountBucket | null {
  if (reviewCount >= 1 && reviewCount <= 2) return '1-2';
  if (reviewCount <= 4 && reviewCount >= 3) return '3-4';
  if (reviewCount <= 9 && reviewCount >= 5) return '5-9';
  if (reviewCount >= 10) return '10+';
  return null;
}

function reachablePrCommits(
  head: string,
  commitParents: ReadonlyMap<string, readonly string[]>,
): Set<string> | null {
  if (!commitParents.has(head)) return null;
  const reached = new Set<string>();
  const pending = [head];
  while (pending.length > 0) {
    const sha = pending.pop();
    if (!sha || reached.has(sha)) continue;
    const parents = commitParents.get(sha);
    if (!parents) continue;
    reached.add(sha);
    for (const parent of parents) {
      if (commitParents.has(parent) && !reached.has(parent))
        pending.push(parent);
    }
  }
  return reached;
}

function classifyReviewTrigger(
  reviewIndex: number,
  reviews: readonly RawReview[],
  commitParents: ReadonlyMap<string, readonly string[]> | null,
): ReviewTrigger {
  if (reviewIndex === 0) return 'first';
  const previous = reviews[reviewIndex - 1];
  const current = reviews[reviewIndex];
  const base = previous?.commitId;
  const head = current?.commitId;
  if (!base || !head) return 'unknown';
  if (base === head) return 'sameHead';
  if (!commitParents) return 'unknown';
  const baseReachable = reachablePrCommits(base, commitParents);
  const headReachable = reachablePrCommits(head, commitParents);
  if (!baseReachable || !headReachable) return 'unknown';
  const newCommits = [...headReachable].filter(
    (sha) => !baseReachable.has(sha),
  );
  if (newCommits.length === 0) return 'unknown';
  const newParents = newCommits.map((sha) => commitParents.get(sha) ?? []);
  if (newParents.some((parents) => parents.length === 1)) return 'newHead';
  if (newParents.every((parents) => parents.length >= 2)) {
    return 'mergeCommitHead';
  }
  return 'unknown';
}

function parseReviewVerdict(
  body: string,
  kind: ParsedOverview['kind'],
): ReviewVerdict | null {
  if (kind === 'legacy') return null;
  const text = stripMarkdownCodeRegions(body);
  const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  for (const match of text.matchAll(heading)) {
    const title = (match[1] ?? '')
      .replace(
        /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s*)/u,
        '',
      )
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (title === 'approval recommended') return 'approval';
    if (title === 'changes recommended') {
      return 'changes';
    }
    if (title === 'needs a closer look') {
      return 'closerLook';
    }
  }
  return null;
}

function isGeneratedHelperPath(path: string): boolean {
  return /^scripts\/[^/]+\.mjs$/.test(path) || /^bin\/.+\.mjs$/.test(path);
}

function parseWhatChanged(
  body: string,
  kind: ParsedOverview['kind'],
  syncMirrorTargets: ReadonlySet<string>,
): WhatChanged | null {
  if (kind === 'legacy') return null;
  const text = body;
  const summary =
    /<summary>\s*<strong>What changed in this PR<\/strong>\s*<\/summary>/i.exec(
      text,
    );
  if (!summary || summary.index === undefined) return null;
  const sectionStart = summary.index + summary[0].length;
  const sectionEnd = text.indexOf('</details>', sectionStart);
  if (sectionEnd === -1) return null;
  const rows = text
    .slice(sectionStart, sectionEnd)
    .split(/\n/)
    .map((line) => line.replace(/\r$/, '').trimStart())
    .filter((line) => line.startsWith('|'));
  if (rows.length < 2) return null;
  const paths = rows
    .slice(2)
    .map((row) => {
      const firstCell = row.split('|')[1] ?? '';
      return firstCell
        .replace(/`/g, '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .trim();
    })
    .filter((path) => path !== '');
  return {
    paths,
    generatedHelperPaths: paths.filter(isGeneratedHelperPath),
    syncMirrorPaths: paths.filter((path) => syncMirrorTargets.has(path)),
  };
}

function classifyFindingPath(
  comment: RawComment,
  syncMirrorTargets: ReadonlySet<string>,
): keyof FindingPathClass {
  if (!comment.path) return 'noPath';
  if (isGeneratedHelperPath(comment.path)) return 'generatedHelper';
  if (syncMirrorTargets.has(comment.path)) return 'syncMirror';
  return 'other';
}

/** Only Copilot's own inline finding comments count, never replies. */
function isCopilotInlineFinding(comment: RawComment): boolean {
  return isCopilotReviewerLogin(comment.login) && comment.inReplyToId === null;
}

function classifyFindingLocality(
  comment: RawComment,
  reviewsInOrder: readonly RawReview[],
  reviewIndexById: ReadonlyMap<number, number>,
  compareFiles: ReadonlyMap<string, readonly CompareFile[] | null>,
): keyof FindingLocality {
  const reviewIndex =
    comment.pullRequestReviewId === null ||
    comment.pullRequestReviewId === undefined
      ? undefined
      : reviewIndexById.get(comment.pullRequestReviewId);
  if (reviewIndex === undefined) {
    return 'unknown';
  }
  if (reviewIndex === 0) {
    return 'firstWave';
  }
  const previous = reviewsInOrder[reviewIndex - 1];
  const current = reviewsInOrder[reviewIndex];
  if (!previous || !current) {
    return 'unknown';
  }
  const { commitId: base } = previous;
  const { commitId: head } = current;
  if (!base || !head || base === head) {
    return 'unknown';
  }
  const files = compareFiles.get(`${base}...${head}`);
  if (!files) {
    return 'unknown';
  }
  const path = comment.path;
  const line = comment.originalLine;
  if (comment.side === 'LEFT' || !path || line === null || line === undefined) {
    return 'unknown';
  }
  const file = files.find((entry) => entry.filename === path);
  if (!file) {
    return 'untouchedFile';
  }
  if (typeof file.patch !== 'string') {
    return 'unknown';
  }
  const near = parseChangedNewLines(file.patch).some(
    (changed) => Math.abs(changed - line) <= NEAR_PREVIOUS_PUSH_LINE_DISTANCE,
  );
  return near ? 'nearPreviousPush' : 'sameFileElsewhere';
}

/**
 * Pure composition: given one PR's Copilot reviews (already filtered to
 * `isCopilotReviewerLogin`, sorted to submission order) and its review
 * comments, compute the full per-PR report. `compareFiles` is keyed by
 * `base...head`; a missing key, or a `null` entry, makes its comments
 * `unknown`. No `gh` call inside -- see {@link auditPr} for the
 * fetch-then-compute wrapper.
 */
export function computePrAudit(
  prNumber: number,
  copilotReviewsInOrder: readonly RawReview[],
  comments: readonly RawComment[],
  compareFiles: ReadonlyMap<string, readonly CompareFile[] | null> = new Map(),
  commitParents: ReadonlyMap<string, readonly string[]> | null = new Map(),
  syncMirrorTargets: ReadonlySet<string> = new Set(),
): PrAuditReport {
  const parsedReviews = copilotReviewsInOrder.map((review) =>
    parseOverviewBody(review.body),
  );

  const findingLocality = emptyFindingLocality();
  const findingPathClass = emptyFindingPathClass();
  const reviewIndexById = new Map(
    copilotReviewsInOrder.map((review, index) => [review.id, index] as const),
  );
  for (const comment of comments) {
    if (isCopilotInlineFinding(comment)) {
      findingLocality[
        classifyFindingLocality(
          comment,
          copilotReviewsInOrder,
          reviewIndexById,
          compareFiles,
        )
      ] += 1;
      findingPathClass[classifyFindingPath(comment, syncMirrorTargets)] += 1;
    }
  }

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
  const triage = computeTriageAudit(threads, comments);
  const triggers = emptyReviewTriggerCounts();
  const approvals = emptyApprovalAudit();
  const reviews: PrReviewRecord[] = copilotReviewsInOrder.map(
    (review, index) => {
      const parsed = parsedReviews[index];
      const trigger = classifyReviewTrigger(
        index,
        copilotReviewsInOrder,
        commitParents,
      );
      triggers[trigger] += 1;
      const verdict = parseReviewVerdict(review.body, parsed.kind);
      const whatChanged = parseWhatChanged(
        review.body,
        parsed.kind,
        syncMirrorTargets,
      );
      if (verdict === 'approval') {
        approvals.total += 1;
        const next =
          index < copilotReviewsInOrder.length - 1
            ? classifyReviewTrigger(
                index + 1,
                copilotReviewsInOrder,
                commitParents,
              )
            : null;
        if (next && next !== 'first') {
          approvals.followed += 1;
          approvals.nextTrigger[next] += 1;
        }
      }
      return {
        reviewId: review.id,
        submittedAt: review.submittedAt,
        kind: parsed.kind,
        commitId: review.commitId ?? null,
        trigger,
        verdict,
        whatChanged,
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
    triage,
    findingLocality,
    triggers,
    approvals,
    findingPathClass,
    mergedAt: null,
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

  const triage = emptyTriageAudit();
  const findingLocality = emptyFindingLocality();
  const triggers = emptyReviewTriggerCounts();
  const approvals = emptyApprovalAudit();
  const findingPathClass = emptyFindingPathClass();
  const whatChanged = {
    tables: 0,
    listingGeneratedHelper: 0,
    listingSyncMirror: 0,
  };
  const dispositionsByReviewCount = emptyDispositionsByReviewCount();
  for (const report of reports) {
    addTriageAudit(triage, report.triage);
    for (const key of Object.keys(
      findingLocality,
    ) as (keyof FindingLocality)[]) {
      findingLocality[key] += report.findingLocality[key];
    }
    for (const trigger of REVIEW_TRIGGERS) {
      triggers[trigger] += report.triggers[trigger];
    }
    approvals.total += report.approvals.total;
    approvals.followed += report.approvals.followed;
    for (const trigger of NEXT_REVIEW_TRIGGERS) {
      approvals.nextTrigger[trigger] += report.approvals.nextTrigger[trigger];
    }
    for (const key of Object.keys(
      findingPathClass,
    ) as (keyof FindingPathClass)[]) {
      findingPathClass[key] += report.findingPathClass[key];
    }
    const reviewCountBucket = dispositionReviewCountBucket(report.reviewCount);
    if (reviewCountBucket) {
      for (const thread of report.threads) {
        dispositionsByReviewCount[reviewCountBucket][thread.disposition] += 1;
      }
    }
    for (const review of report.reviews) {
      if (review.whatChanged) {
        whatChanged.tables += 1;
        if (review.whatChanged.generatedHelperPaths.length > 0) {
          whatChanged.listingGeneratedHelper += 1;
        }
        if (review.whatChanged.syncMirrorPaths.length > 0) {
          whatChanged.listingSyncMirror += 1;
        }
      }
    }
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
    triage,
    findingLocality,
    triggers,
    approvals,
    findingPathClass,
    whatChanged,
    dispositionsByReviewCount,
  };
}

// ---------------------------------------------------------------------------
// Fetch layer
// ---------------------------------------------------------------------------

interface RestReviewPayload {
  id?: unknown;
  submitted_at?: unknown;
  body?: unknown;
  commit_id?: unknown;
  user?: { login?: unknown } | null;
}

interface RestCommitPayload {
  sha?: unknown;
  parents?: unknown;
}

interface SyncManifestPayload {
  syncPairs?: unknown;
}

interface RestCommentPayload {
  id?: unknown;
  in_reply_to_id?: unknown;
  body?: unknown;
  created_at?: unknown;
  node_id?: unknown;
  user?: { login?: unknown } | null;
  path?: unknown;
  side?: unknown;
  original_line?: unknown;
  pull_request_review_id?: unknown;
}

function toRawReview(raw: RestReviewPayload): RawReview {
  return {
    id: Number(raw.id),
    submittedAt: typeof raw.submitted_at === 'string' ? raw.submitted_at : null,
    body: String(raw.body ?? ''),
    login: String(raw.user?.login ?? ''),
    commitId: typeof raw.commit_id === 'string' ? raw.commit_id : null,
  };
}

function toRawComment(
  raw: RestCommentPayload,
  lastEditedAt?: string | null,
): RawComment {
  const replyTo = raw.in_reply_to_id;
  return {
    id: Number(raw.id),
    inReplyToId:
      replyTo === null || replyTo === undefined ? null : Number(replyTo),
    body: String(raw.body ?? ''),
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
    lastEditedAt,
    login: typeof raw.user?.login === 'string' ? raw.user.login : null,
    path: typeof raw.path === 'string' ? raw.path : null,
    side: typeof raw.side === 'string' ? raw.side : null,
    originalLine:
      typeof raw.original_line === 'number' ? raw.original_line : null,
    pullRequestReviewId:
      typeof raw.pull_request_review_id === 'number'
        ? raw.pull_request_review_id
        : null,
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

function ghApiPaginatedItemsUnbounded(
  path: string,
  jqFilter: string,
): unknown[] {
  const hostname = resolveGhApiHostname();
  const args = [
    'api',
    path,
    ...(hostname ? ['--hostname', hostname] : []),
    '--paginate',
    '--jq',
    jqFilter,
  ];
  const raw = ghTextUnbounded(args, {
    timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  });
  return parsePaginatedGhNdjson(raw);
}

const COPILOT_REVIEWER_WORKFLOW_PATH =
  'dynamic/agents/copilot-pull-request-reviewer';

interface ReviewerWorkflow {
  id: number;
  path: string;
}

interface ReviewerWorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  head_branch: string | null | undefined;
  run_started_at: string | null;
  updated_at: string | null;
}

export interface ReviewerRunsReport {
  workflowPath: string;
  workflowId: number;
  from: string;
  to: string;
  runs: number;
  completed: number;
  byConclusion: {
    success: number;
    failure: number;
    cancelled: number;
    other: number;
  };
  totalDurationMs: number;
  medianDurationMs: number | null;
  headBranches: number;
  medianRunsPerHeadBranch: number | null;
}

function failReviewerRuns(message: string): never {
  process.stderr.write(`copilot-review-wave-audit: ${message}\n`);
  process.exit(1);
}

function lowerMiddleMedian(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function nextReviewerRunsDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function auditReviewerRuns(
  owner: string,
  repo: string,
  from: string,
  to: string,
): ReviewerRunsReport {
  const workflowListPath = `repos/${owner}/${repo}/actions/workflows`;
  let workflows: unknown[];
  try {
    workflows = ghApiPaginatedItemsUnbounded(workflowListPath, '.workflows[]');
  } catch (error) {
    failReviewerRuns(
      'reviewer runs: ' +
        workflowListPath +
        ': ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const workflow = workflows.find(
    (candidate): candidate is ReviewerWorkflow =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as ReviewerWorkflow).path === COPILOT_REVIEWER_WORKFLOW_PATH,
  );
  if (!workflow) {
    failReviewerRuns(
      'no Copilot reviewer workflow (' +
        COPILOT_REVIEWER_WORKFLOW_PATH +
        ') in ' +
        owner +
        '/' +
        repo,
    );
  }
  if (!Number.isSafeInteger(workflow.id) || workflow.id <= 0) {
    failReviewerRuns(
      'reviewer runs: ' +
        workflowListPath +
        ': Copilot reviewer workflow did not include a valid id',
    );
  }

  const runs: ReviewerWorkflowRun[] = [];
  for (let day = from; day <= to; day = nextReviewerRunsDate(day)) {
    const runsPath =
      'repos/' +
      owner +
      '/' +
      repo +
      '/actions/workflows/' +
      workflow.id +
      '/runs?created=' +
      day +
      '&per_page=100';
    let pageItems: unknown[];
    try {
      pageItems = ghApiPaginatedItemsUnbounded(
        runsPath,
        '.total_count, .workflow_runs[]',
      );
    } catch (error) {
      failReviewerRuns(
        'reviewer runs: ' +
          runsPath +
          ': ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    const totalCount = pageItems.find(
      (item): item is number => typeof item === 'number',
    );
    if (totalCount === undefined || !Number.isSafeInteger(totalCount)) {
      failReviewerRuns(
        `reviewer runs: ${runsPath}: response has no valid total_count`,
      );
    }
    if (totalCount >= 1000) {
      failReviewerRuns(
        'reviewer runs: ' +
          runsPath +
          ': total_count for ' +
          day +
          ' is ' +
          totalCount +
          ', reaching the 1,000-run limit',
      );
    }
    for (const item of pageItems) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        runs.push(item as ReviewerWorkflowRun);
      }
    }
  }

  const byConclusion = {
    success: 0,
    failure: 0,
    cancelled: 0,
    other: 0,
  };
  const branchCounts = new Map<string, number>();
  const durations: number[] = [];
  let completed = 0;
  let totalDurationMs = 0;
  for (const run of runs) {
    const headBranch = run.head_branch;
    if (typeof headBranch !== 'string' || headBranch.length === 0) {
      failReviewerRuns(`reviewer runs: run ${run.id} has no valid head_branch`);
    }
    branchCounts.set(headBranch, (branchCounts.get(headBranch) ?? 0) + 1);
    if (run.status !== 'completed') {
      continue;
    }
    completed += 1;
    if (run.conclusion === 'success') {
      byConclusion.success += 1;
    } else if (run.conclusion === 'failure') {
      byConclusion.failure += 1;
    } else if (run.conclusion === 'cancelled') {
      byConclusion.cancelled += 1;
    } else {
      byConclusion.other += 1;
    }
    const startedAt = Date.parse(run.run_started_at ?? '');
    const updatedAt = Date.parse(run.updated_at ?? '');
    const durationMs = updatedAt - startedAt;
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(updatedAt) ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      failReviewerRuns(
        'reviewer runs: completed run ' +
          run.id +
          ' has invalid run_started_at or updated_at values',
      );
    }
    durations.push(durationMs);
    totalDurationMs += durationMs;
  }

  return {
    workflowPath: COPILOT_REVIEWER_WORKFLOW_PATH,
    workflowId: workflow.id,
    from,
    to,
    runs: runs.length,
    completed,
    byConclusion,
    totalDurationMs,
    medianDurationMs: lowerMiddleMedian(durations),
    headBranches: branchCounts.size,
    medianRunsPerHeadBranch: lowerMiddleMedian([...branchCounts.values()]),
  };
}

function formatReviewerRunsStepSummary(report: ReviewerRunsReport): string {
  const totalHours = (report.totalDurationMs / 3_600_000).toFixed(1);
  const medianSeconds =
    report.medianDurationMs === null
      ? 'n/a'
      : String(report.medianDurationMs / 1000);
  return [
    '## Copilot reviewer runs',
    '',
    '- Created from: ' +
      report.from +
      ' through ' +
      report.to +
      ' (UTC, inclusive)',
    `- Runs: ${report.runs}`,
    `- Total duration: ${totalHours} hours`,
    `- Median duration: ${medianSeconds} seconds`,
    `- Distinct head branches: ${report.headBranches}`,
    '- Median runs per head branch: ' +
      (report.medianRunsPerHeadBranch ?? 'n/a'),
    '',
    'These are the runs created in the range, not the runs of the pull requests merged in it.',
  ].join('\n');
}

function appendReviewerRunsStepSummary(
  path: string,
  report: ReviewerRunsReport,
): void {
  const existingSummary = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const separator =
    existingSummary.length > 0 && !existingSummary.endsWith('\n') ? '\n' : '';
  appendFileSync(
    path,
    `${separator + formatReviewerRunsStepSummary(report)}\n`,
    'utf8',
  );
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
  syncMirrorTargets: ReadonlySet<string> = new Set(),
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
  const needsCommitGraph = copilotReviews.some((review, index) => {
    if (index === 0) return false;
    const previousCommit = copilotReviews[index - 1]?.commitId;
    return Boolean(
      previousCommit && review.commitId && previousCommit !== review.commitId,
    );
  });
  const commitParents = needsCommitGraph
    ? fetchCommitParents(owner, repo, prNumber)
    : new Map<string, readonly string[]>();
  const nodeIds = rawComments.map((comment) => String(comment.node_id ?? ''));
  if (nodeIds.some((nodeId) => nodeId === '')) {
    throw new Error(
      `copilot-review-wave-audit: PR #${prNumber} comment is missing node_id, cannot resolve edit state`,
    );
  }
  const lastEditedAtByNodeId = fetchLastEditedAtByNodeId(ghText, nodeIds);
  const comments = rawComments.map((comment) => {
    const nodeId = String(comment.node_id);
    if (!lastEditedAtByNodeId.has(nodeId)) {
      throw new Error(
        `copilot-review-wave-audit: missing edit-state resolution for PR #${prNumber} comment ${nodeId}`,
      );
    }
    return toRawComment(comment, lastEditedAtByNodeId.get(nodeId));
  });

  return computePrAudit(
    prNumber,
    copilotReviews,
    comments,
    fetchCompareFilesForFindings(owner, repo, copilotReviews, comments),
    commitParents,
    syncMirrorTargets,
  );
}

function toCommitParents(
  rawCommits: readonly unknown[],
): Map<string, readonly string[]> | null {
  const commitParents = new Map<string, readonly string[]>();
  for (const raw of rawCommits) {
    if (raw === null || typeof raw !== 'object') return null;
    const commit = raw as RestCommitPayload;
    if (typeof commit.sha !== 'string' || !Array.isArray(commit.parents)) {
      return null;
    }
    const parents: string[] = [];
    for (const rawParent of commit.parents) {
      if (
        rawParent === null ||
        typeof rawParent !== 'object' ||
        typeof (rawParent as { sha?: unknown }).sha !== 'string'
      ) {
        return null;
      }
      parents.push((rawParent as { sha: string }).sha);
    }
    commitParents.set(commit.sha, parents);
  }
  return commitParents;
}

function fetchCommitParents(
  owner: string,
  repo: string,
  prNumber: number,
): ReadonlyMap<string, readonly string[]> | null {
  try {
    return toCommitParents(
      ghApiPaginatedUnbounded(
        `repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`,
      ),
    );
  } catch {
    return null;
  }
}

/**
 * One `compare/{base}...{head}` lookup. The response is not paginated and
 * a diff's patches can be large, so the body is read unbounded. Any failure
 * (including the cap check in {@link toCompareFiles}) yields `null`, which
 * the audit reads as an unknown locality, never a fatal error.
 */
function fetchCompareFiles(
  owner: string,
  repo: string,
  range: string,
): readonly CompareFile[] | null {
  try {
    const hostname = resolveGhApiHostname();
    const raw = ghTextUnbounded(
      [
        'api',
        `repos/${owner}/${repo}/compare/${range}`,
        ...(hostname ? ['--hostname', hostname] : []),
        '--jq',
        '.files',
      ],
      { timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS },
    );
    return toCompareFiles(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * One compare lookup per distinct `base...head` pair that a Copilot inline
 * finding on the later review actually needs. Pairs with a null or equal
 * commit are skipped; they are `unknown` without a fetch.
 */
function fetchCompareFilesForFindings(
  owner: string,
  repo: string,
  reviewsInOrder: readonly RawReview[],
  comments: readonly RawComment[],
): Map<string, readonly CompareFile[] | null> {
  const reviewIdsWithFindings = new Set(
    comments
      .filter((comment) => isCopilotInlineFinding(comment))
      .map((comment) => comment.pullRequestReviewId)
      .filter((id): id is number => typeof id === 'number'),
  );
  const compareFiles = new Map<string, readonly CompareFile[] | null>();
  for (let index = 1; index < reviewsInOrder.length; index += 1) {
    const previous = reviewsInOrder[index - 1];
    const current = reviewsInOrder[index];
    if (!previous || !current || !reviewIdsWithFindings.has(current.id)) {
      continue;
    }
    const { commitId: base } = previous;
    const { commitId: head } = current;
    if (!base || !head || base === head) {
      continue;
    }
    const range = `${base}...${head}`;
    if (!compareFiles.has(range)) {
      compareFiles.set(range, fetchCompareFiles(owner, repo, range));
    }
  }
  return compareFiles;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(message: string): never {
  process.stderr.write(`copilot-review-wave-audit: ${message}\n`);
  process.exit(2);
}

function resolveRepoRoot(fromDir: string): string {
  let dir = fromDir;
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot find package.json above ${fromDir}`);
}

function loadSyncMirrorTargets(): ReadonlySet<string> {
  const manifestPath = join(
    resolveRepoRoot(import.meta.dirname),
    'audit/sync-manifest.json',
  );
  let parsed: SyncManifestPayload;
  try {
    parsed = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as SyncManifestPayload;
  } catch (error) {
    throw new Error(
      `cannot read or parse ${manifestPath}: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(parsed.syncPairs)) {
    throw new Error(`${manifestPath} must contain a syncPairs array`);
  }
  const targets = new Set<string>();
  for (const pair of parsed.syncPairs) {
    if (pair === null || typeof pair !== 'object') {
      throw new Error(`${manifestPath} contains an invalid syncPairs entry`);
    }
    const record = pair as { mode?: unknown; target?: unknown };
    if (typeof record.mode !== 'string' || typeof record.target !== 'string') {
      throw new Error(`${manifestPath} contains an invalid syncPairs entry`);
    }
    if (record.mode === 'exact' || record.mode === 'concreted') {
      targets.add(record.target);
    }
  }
  return targets;
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

interface RecentMergedPrs {
  numbers: number[];
  mergedAtByNumber: Map<number, string | null>;
}

function resolveRecentMergedPrNumbers(
  owner: string,
  repo: string,
  limit: number,
): RecentMergedPrs {
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
  return {
    numbers: selectMostRecentlyMerged(parsed, limit),
    mergedAtByNumber: new Map(
      parsed.map((candidate) => [candidate.number, candidate.mergedAt]),
    ),
  };
}

function shiftCalendarDate(value: string, days: number, flag: string): string {
  const shifted = new Date(
    Date.parse(`${value}T00:00:00Z`) + days * 24 * 60 * 60 * 1000,
  );
  const year = shifted.getUTCFullYear();
  if (!Number.isFinite(shifted.getTime()) || year < 0 || year > 9999) {
    fail(`${flag} cannot be expanded to the neighboring calendar date`);
  }
  return [
    String(year).padStart(4, '0'),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function resolveMergedWindowPrNumbers(
  owner: string,
  repo: string,
  mergedFrom: string,
  mergedTo: string,
): RecentMergedPrs {
  const search = `merged:${shiftCalendarDate(mergedFrom, -1, '--merged-from')}..${shiftCalendarDate(mergedTo, 1, '--merged-to')}`;
  const raw = ghText([
    'pr',
    'list',
    '--repo',
    `${owner}/${repo}`,
    '--state',
    'merged',
    '--search',
    search,
    '--limit',
    String(RECENT_MERGED_OVER_FETCH_MAX),
    '--json',
    'number,mergedAt',
  ]);
  const parsed = JSON.parse(raw) as MergedPrCandidate[];
  if (parsed.length === RECENT_MERGED_OVER_FETCH_MAX) {
    fail(
      `merge window ${mergedFrom} through ${mergedTo} returned ${RECENT_MERGED_OVER_FETCH_MAX} pull requests, the search cap; use a shorter window`,
    );
  }

  const startMs = Date.parse(`${mergedFrom}T00:00:00Z`);
  const endMs = Date.parse(
    `${shiftCalendarDate(mergedTo, 1, '--merged-to')}T00:00:00Z`,
  );
  const inWindow = parsed.filter((candidate) => {
    if (candidate.mergedAt === null) return false;
    const mergedMs = Date.parse(candidate.mergedAt);
    return mergedMs >= startMs && mergedMs < endMs;
  });
  return {
    numbers: selectMostRecentlyMerged(inWindow, inWindow.length),
    mergedAtByNumber: new Map(
      inWindow.map((candidate) => [candidate.number, candidate.mergedAt]),
    ),
  };
}

const COPILOT_REVIEW_WAVE_AUDIT_FLAG_SPEC = {
  '--prs': { type: 'string' },
  '--limit': { type: 'string' },
  '--merged-from': { type: 'string' },
  '--merged-to': { type: 'string' },
  '--reviewer-runs-from': { type: 'string' },
  '--reviewer-runs-to': { type: 'string' },
  '--format': { type: 'string', default: 'json' },
  '--repo': { type: 'string' },
  '--owner': { type: 'string' },
  '--check': { type: 'boolean', default: false },
  '--since': { type: 'string' },
  '--min-recorded-share': { type: 'string' },
  '--baseline-reviews-per-pr': { type: 'string' },
  '--step-summary': { type: 'string' },
  '--help': { type: 'boolean', short: 'h', default: false },
} as const;

const DEFAULT_MIN_RECORDED_SHARE = 0.9;
const DECIMAL_SHARE_RE = /^(\d+(\.\d+)?|\.\d+)$/u;
const POSITIVE_DECIMAL_RE = /^(\d+(\.\d+)?|\.\d+)$/u;
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

export interface CheckOptions {
  /** `YYYY-MM-DD`: only reports merged on or after this UTC date count. */
  since: string | null;
  minRecordedShare: number;
}

/**
 * Pure `--check` gate (issue #4189). Returns one message per failed check,
 * or an empty list. The recorded share is computed over the reports merged
 * on or after `since`, not over the whole cohort; a report with no merge
 * time, or one with no accepted, deferred, or rejected threads, adds nothing
 * to that share.
 */
export function checkFailures(
  summary: CohortSummary,
  reports: readonly PrAuditReport[],
  options: CheckOptions,
): string[] {
  const failures: string[] = [];
  if (summary.unparsedCount > 0) {
    failures.push(
      `${summary.unparsedCount} unparsed Copilot review(s): the overview parser has drifted`,
    );
  }
  if (summary.triage.malformed > 0) {
    failures.push(
      `${summary.triage.malformed} malformed Triage line(s) on accepted, deferred, or rejected threads`,
    );
  }
  if (options.since !== null) {
    const sinceMs = Date.parse(`${options.since}T00:00:00Z`);
    let recorded = 0;
    let unrecorded = 0;
    for (const report of reports) {
      const mergedMs =
        report.mergedAt === null ? Number.NaN : Date.parse(report.mergedAt);
      if (!(mergedMs >= sinceMs)) {
        continue;
      }
      recorded += report.triage.recorded;
      unrecorded += report.triage.unrecorded;
    }
    const total = recorded + unrecorded;
    if (total > 0) {
      const share = recorded / total;
      if (share < options.minRecordedShare) {
        failures.push(
          `recorded triage share ${share.toFixed(3)} since ${options.since} is below ${options.minRecordedShare} (${recorded} of ${total} threads)`,
        );
      }
    }
  }
  if (summary.triage.contradictions > 0) {
    failures.push(
      `${summary.triage.contradictions} recorded triage contradiction(s): accepted replies that carry verdict defer`,
    );
  }
  return failures;
}

function parseCalendarDate(value: string, flag: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !CALENDAR_DATE_RE.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    fail(`${flag} must be a real calendar date as YYYY-MM-DD, got "${value}"`);
  }
  return value;
}

function parseSinceDate(value: string): string {
  return parseCalendarDate(value, '--since');
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/copilot-review-wave-audit.mjs --prs <n,n,...> [options]
  node scripts/copilot-review-wave-audit.mjs --limit <N> [options]
  node scripts/copilot-review-wave-audit.mjs --merged-from <YYYY-MM-DD> --merged-to <YYYY-MM-DD> [options]
  node scripts/copilot-review-wave-audit.mjs --reviewer-runs-from <YYYY-MM-DD> --reviewer-runs-to <YYYY-MM-DD> [options]

  --prs <n,n,...>     Audit these merged PR numbers (mutually exclusive
                      with --limit and the merge window).
  --limit <N>         Audit the N most recently merged PRs, sorted by
                      merge date (best-effort: over-fetches and
                      re-sorts client-side, since GitHub has no
                      merge-date sort of its own -- use --prs for a
                      fully precise, reproducible number set).
                      Mutually exclusive with --prs and the merge window.
  --merged-from <date> First UTC calendar date in an inclusive merge window.
                      Requires --merged-to; mutually exclusive with --prs
                      and --limit. The search cap is 1,000 PRs.
  --merged-to <date>   Last UTC calendar date in an inclusive merge window.
                      Requires --merged-from.
  --reviewer-runs-from <date>
                      First UTC calendar date in an inclusive Copilot
                      reviewer workflow run window; requires --reviewer-runs-to.
  --reviewer-runs-to <date>
                      Last UTC calendar date in an inclusive Copilot
                      reviewer workflow run window; requires --reviewer-runs-from.
                      Mutually exclusive with pull-request audit options.
  --format <json|tsv> Output format (default: json).
  --repo <owner/name> Repository override, combined form.
  --owner <owner>     Repository override, split form (use with
                      --repo <name>, the bare repository name -- not
                      both --owner and a combined --repo together).
  --check             Exit 1 when a check fails (an unparsed Copilot review,
                      a malformed Triage line, a recorded triage
                      contradiction, or a recorded share below
                      --min-recorded-share with --since). The report is still
                      printed; each failure is written to stderr.
  --since <YYYY-MM-DD> With --check and --limit or the merge window: count only
                      PRs merged on or after this UTC date in the recorded-share check.
  --min-recorded-share <n>
                      Minimum recorded share from 0 to 1 (default 0.9). Valid
                      only with --check and --since.
  --baseline-reviews-per-pr <n>
                      Show reviews per PR and its ratio to this positive
                      decimal baseline in the step summary.
  --step-summary <path>
                      Append the cohort summary as Markdown to this file.
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

Each PR's "triage" object counts the \`Triage:\` lines of its accepted,
deferred, or rejected threads: recorded versus unrecorded (plus malformed,
a Triage-like line that yields no record), per step and urgency, overrides, and
contradictions (accepted replies that carry verdict defer). JSON output only.
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
  failedPrs: FailedPr[],
): void {
  process.stdout.write(
    `${JSON.stringify({ reports, summary, failedPrs }, null, 2)}\n`,
  );
}

interface FailedPr {
  pr: number;
  message: string;
}

function formatStepSummary(
  selector: string,
  summary: CohortSummary,
  failedPrs: readonly FailedPr[],
  baselineReviewsPerPr: number | null,
): string {
  const reviewsPerPr =
    summary.prCount === 0
      ? 'n/a'
      : String(summary.reviewCount / summary.prCount);
  const lines = [
    '## Copilot review-wave audit',
    '',
    `- Selector: \`${selector}\``,
    `- Pull requests audited: ${summary.prCount}`,
    `- Copilot reviews: ${summary.reviewCount} (v2=${summary.v2Count}, legacy=${summary.legacyCount}, unparsed=${summary.unparsedCount})`,
    `- Pull requests that could not be audited: ${failedPrs.length}`,
    `- Reviews per pull request: ${reviewsPerPr}`,
  ];
  if (baselineReviewsPerPr !== null) {
    const ratio =
      reviewsPerPr === 'n/a'
        ? 'n/a'
        : String(Number(reviewsPerPr) / baselineReviewsPerPr);
    lines.push(
      `- Baseline reviews per pull request: ${baselineReviewsPerPr}`,
      `- Ratio to baseline: ${ratio}`,
    );
  }
  lines.push(
    '',
    `- Review triggers: ${Object.entries(summary.triggers)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ')}`,
    `- Approvals: total=${summary.approvals.total}, followed=${summary.approvals.followed}; next trigger: ${Object.entries(
      summary.approvals.nextTrigger,
    )
      .map(([key, value]) => `${key}=${value}`)
      .join(', ')}`,
    '',
    '### Dispositions by PR review-count bucket',
    '',
    '| Reviews per PR | Deferred | Rejected | Accepted | Other | None |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const bucket of ['1-2', '3-4', '5-9', '10+'] as const) {
    const counts = summary.dispositionsByReviewCount[bucket];
    lines.push(
      `| ${bucket} | ${counts.deferred} | ${counts.rejected} | ${counts.accepted} | ${counts.other} | ${counts.none} |`,
    );
  }
  lines.push(
    '',
    `- What-changed tables: ${summary.whatChanged.tables}; listing generated helpers: ${summary.whatChanged.listingGeneratedHelper}; listing sync mirrors: ${summary.whatChanged.listingSyncMirror}`,
    `- Inline findings by path class: ${Object.entries(summary.findingPathClass)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ')}`,
    `- Triage: recorded=${summary.triage.recorded}, unrecorded=${summary.triage.unrecorded}, contradictions=${summary.triage.contradictions}`,
  );
  return lines.join('\n');
}

function appendStepSummary(
  path: string,
  selector: string,
  summary: CohortSummary,
  failedPrs: readonly FailedPr[],
  baselineReviewsPerPr: number | null,
): void {
  const existingSummary = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const separator =
    existingSummary.length > 0 && !existingSummary.endsWith('\n') ? '\n' : '';
  appendFileSync(
    path,
    `${separator}${formatStepSummary(selector, summary, failedPrs, baselineReviewsPerPr)}\n`,
    'utf8',
  );
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

  const reviewerFormat = values.format as string;
  if (reviewerFormat !== 'json' && reviewerFormat !== 'tsv') {
    fail(`--format must be "json" or "tsv", got "${reviewerFormat}"`);
  }
  const reviewerRunsFromFlag = values['reviewer-runs-from'] as
    | string
    | undefined;
  const reviewerRunsToFlag = values['reviewer-runs-to'] as string | undefined;
  const reviewerRunsMode =
    reviewerRunsFromFlag !== undefined || reviewerRunsToFlag !== undefined;
  if (reviewerRunsMode) {
    if (
      (reviewerRunsFromFlag === undefined) !==
      (reviewerRunsToFlag === undefined)
    ) {
      fail(
        '--reviewer-runs-from and --reviewer-runs-to must be given together',
      );
    }
    const reviewerRunsFrom = parseCalendarDate(
      reviewerRunsFromFlag as string,
      '--reviewer-runs-from',
    );
    const reviewerRunsTo = parseCalendarDate(
      reviewerRunsToFlag as string,
      '--reviewer-runs-to',
    );
    if (reviewerRunsFrom > reviewerRunsTo) {
      fail('--reviewer-runs-from must be on or before --reviewer-runs-to');
    }
    const incompatibleFlags: Array<[string, boolean]> = [
      ['--prs', values.prs !== undefined],
      ['--limit', values.limit !== undefined],
      ['--merged-from', values['merged-from'] !== undefined],
      ['--merged-to', values['merged-to'] !== undefined],
      ['--check', values.check === true],
      ['--since', values.since !== undefined],
      ['--min-recorded-share', values['min-recorded-share'] !== undefined],
      [
        '--baseline-reviews-per-pr',
        values['baseline-reviews-per-pr'] !== undefined,
      ],
      ['--format tsv', reviewerFormat === 'tsv'],
    ];
    const incompatible = incompatibleFlags.find(([, present]) => present);
    if (incompatible) {
      fail(`reviewer-run mode cannot be combined with ${incompatible[0]}`);
    }

    let reviewerRepository: string;
    try {
      reviewerRepository =
        combineOwnerRepoFlags(values as { owner?: string; repo?: string }) ??
        detectRepository();
    } catch (error) {
      fail((error as Error).message);
    }
    const [reviewerOwner, reviewerRepo] = parseRepository(reviewerRepository);
    const reviewerRuns = auditReviewerRuns(
      reviewerOwner,
      reviewerRepo,
      reviewerRunsFrom,
      reviewerRunsTo,
    );
    process.stdout.write(`${JSON.stringify({ reviewerRuns }, null, 2)}\n`);

    const reviewerStepSummaryPath = values['step-summary'] as
      | string
      | undefined;
    if (reviewerStepSummaryPath !== undefined) {
      try {
        appendReviewerRunsStepSummary(reviewerStepSummaryPath, reviewerRuns);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          'copilot-review-wave-audit: cannot write step summary ' +
            reviewerStepSummaryPath +
            ': ' +
            reason +
            '\n',
        );
        process.exitCode = 2;
      }
    }
  }

  if (!reviewerRunsMode) {
    const prsFlag = values.prs as string | undefined;
    const limitFlag = values.limit as string | undefined;
    const mergedFromFlag = values['merged-from'] as string | undefined;
    const mergedToFlag = values['merged-to'] as string | undefined;
    const hasMergedWindow =
      mergedFromFlag !== undefined || mergedToFlag !== undefined;
    if ((mergedFromFlag === undefined) !== (mergedToFlag === undefined)) {
      fail('--merged-from and --merged-to must be given together');
    }
    const selectorCount =
      Number(prsFlag !== undefined) +
      Number(limitFlag !== undefined) +
      Number(hasMergedWindow);
    if (selectorCount !== 1) {
      fail(
        'choose exactly one of --prs <n,n,...>, --limit <N>, or the --merged-from/--merged-to window',
      );
    }
    let mergedFrom: string | null = null;
    let mergedTo: string | null = null;
    if (hasMergedWindow) {
      mergedFrom = parseCalendarDate(mergedFromFlag as string, '--merged-from');
      mergedTo = parseCalendarDate(mergedToFlag as string, '--merged-to');
      if (mergedFrom > mergedTo) {
        fail('--merged-from must be on or before --merged-to');
      }
    }
    const format = values.format as string;
    if (format !== 'json' && format !== 'tsv') {
      fail(`--format must be "json" or "tsv", got "${format}"`);
    }

    // Validated before detectRepository, so no misuse below reaches gh (#4189).
    const checkMode = values.check === true;
    const sinceFlag = values.since as string | undefined;
    if (sinceFlag !== undefined) {
      if (!checkMode) {
        fail('--since is only valid with --check');
      }
      if (prsFlag !== undefined) {
        fail(
          '--since is not valid with --prs; use --limit or --merged-from/--merged-to',
        );
      }
      parseSinceDate(sinceFlag);
    }
    const shareFlag = values['min-recorded-share'] as string | undefined;
    let minRecordedShare = DEFAULT_MIN_RECORDED_SHARE;
    if (shareFlag !== undefined) {
      if (!checkMode || sinceFlag === undefined) {
        fail('--min-recorded-share is only valid with --check and --since');
      }
      const value = DECIMAL_SHARE_RE.test(shareFlag) ? Number(shareFlag) : NaN;
      if (!(value >= 0 && value <= 1)) {
        fail(
          `--min-recorded-share must be a decimal from 0 to 1, got "${shareFlag}"`,
        );
      }
      minRecordedShare = value;
    }
    const baselineFlag = values['baseline-reviews-per-pr'] as
      | string
      | undefined;
    let baselineReviewsPerPr: number | null = null;
    if (baselineFlag !== undefined) {
      const value = POSITIVE_DECIMAL_RE.test(baselineFlag)
        ? Number(baselineFlag)
        : Number.NaN;
      if (!Number.isFinite(value) || value <= 0) {
        fail(
          `--baseline-reviews-per-pr must be a positive decimal, got "${baselineFlag}"`,
        );
      }
      baselineReviewsPerPr = value;
    }
    const stepSummaryPath = values['step-summary'] as string | undefined;

    let syncMirrorTargets: ReadonlySet<string>;
    try {
      syncMirrorTargets = loadSyncMirrorTargets();
    } catch (error) {
      fail((error as Error).message);
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

    const recent =
      limitFlag === undefined
        ? null
        : resolveRecentMergedPrNumbers(
            owner,
            repo,
            parseCanonicalIntegerOrThrow(limitFlag, '--limit'),
          );
    const mergedWindow =
      mergedFrom === null || mergedTo === null
        ? null
        : resolveMergedWindowPrNumbers(owner, repo, mergedFrom, mergedTo);
    const prNumbers =
      prsFlag !== undefined
        ? parsePrNumberList(prsFlag)
        : (recent?.numbers ?? mergedWindow?.numbers ?? []);
    const mergedAtByNumber =
      recent?.mergedAtByNumber ?? mergedWindow?.mergedAtByNumber ?? new Map();
    const selector =
      mergedFrom !== null && mergedTo !== null
        ? `--merged-from ${mergedFrom} --merged-to ${mergedTo}`
        : limitFlag !== undefined
          ? `--limit ${limitFlag}`
          : `--prs (${prNumbers.length} pull requests)`;

    const reports: PrAuditReport[] = [];
    const failedPrs: FailedPr[] = [];
    for (const prNumber of prNumbers) {
      try {
        const report = auditPr(owner, repo, prNumber, syncMirrorTargets);
        report.mergedAt = mergedAtByNumber.get(prNumber) ?? null;
        reports.push(report);
      } catch (error) {
        failedPrs.push({
          pr: prNumber,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const summary = summarizeCohort(reports);

    if (format === 'tsv') {
      writeTsvReport(reports, summary);
    } else {
      writeJsonReport(reports, summary, failedPrs);
    }

    let stepSummaryFailed = false;
    if (stepSummaryPath !== undefined) {
      try {
        appendStepSummary(
          stepSummaryPath,
          selector,
          summary,
          failedPrs,
          baselineReviewsPerPr,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `copilot-review-wave-audit: cannot write step summary ${stepSummaryPath}: ${reason}\n`,
        );
        process.exitCode = 2;
        stepSummaryFailed = true;
      }
    }

    if (!stepSummaryFailed) {
      if (checkMode) {
        const failures = checkFailures(summary, reports, {
          since: sinceFlag ?? null,
          minRecordedShare,
        });
        for (const message of failures) {
          process.stderr.write(
            `copilot-review-wave-audit: check: ${message}\n`,
          );
        }
        if (failures.length > 0) {
          // Not process.exit: piped stdout may still be flushing (Windows CI).
          process.exitCode = 1;
        }
      }
      if (failedPrs.length > 0) {
        process.stderr.write(
          `copilot-review-wave-audit: ${failedPrs.length} pull request(s) could not be audited\n`,
        );
        process.exitCode = 1;
      }
    }
  }
}
