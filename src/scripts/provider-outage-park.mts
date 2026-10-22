#!/usr/bin/env node

// idd-generated-from: src/scripts/provider-outage-park.mts
//
// The scripts/provider-outage-park.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// #2321: every current route for an unavailable external service ends in
// a hold, which keeps the claim live until `claimTiming.staleAge` elapses
// -- the session can neither continue nor pick up different work, and the
// outage keeps producing more pull requests stuck the same way. Parking
// releases the originating issue's claim immediately instead, at no cost
// to any quality gate: it never resolves a thread, satisfies a gate, or
// merges. This module supplies the eligibility decision, the marker post,
// and a read-only cross-pull-request list of parked changes; releasing
// the claim itself is a separate, already-existing step
// (`post-idd-marker.mjs --type unclaim`) the caller takes afterward.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { parseCliArgs } from './cli-args.mts';
import { ghApiJson, ghText, resolveGhOwnerRepo } from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadIddConfig } from './idd-config.mts';
import { isValidIsoTimestamp, parseClaimComment } from './marker-helpers.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';
import {
  compareIsoTimestamps,
  filterTrustedClaimFamilyEvents,
  type ParsedProviderOutagePark,
  parseProviderOutageParkComment,
  renderProviderOutageParkComment,
  resolveTrustedMarkerActors,
  toSecondPrecisionIso,
} from './protocol-helpers.mts';
import { fetchLastEditedAtByNodeId } from './provider-adapter-github.mts';
import {
  buildProviderHealthReport,
  buildProviderHealthServiceReport,
  PROVIDER_HEALTH_SERVICES,
  type ProviderHealthService,
  type ProviderHealthServiceReader,
  type ProviderHealthVerdict,
} from './provider-health.mts';

// #4615: discover live park markers before collecting provider health, then
// read only the distinct service evidence those markers require.

/**
 * Fails closed to `true` when the open-pull-request sample was truncated
 * (more may exist beyond `sampleSize`), regardless of the sampled `count` --
 * an undercounted bound must never read as "still under the limit"
 * (Codex/CodeRabbit review, PR #2421).
 */
export function computeBoundReached(
  count: number,
  maxParkedChanges: number,
  sampleTruncated: boolean,
): boolean {
  return sampleTruncated || count >= maxParkedChanges;
}

/**
 * pre-merge-readiness blocker-`gate` names that are *unambiguously* about
 * one provider-health service's availability -- never a gate that can also
 * fire for an unrelated reason. `review-currency` and `disposition-evidence`
 * are deliberately excluded: this repository's own #2403 session proved
 * both fire for non-outage causes (`ci-pass-drift`, `missing-watermark`).
 * `discarded-required-check-siblings` stays mapped to `ci-actions` despite
 * one known non-outage cause (rerun-once budget exhaustion, also from
 * #2403) -- a false-positive park costs only delay (park never resolves a
 * thread, satisfies a gate, or merges), and the `unavailable` verdict this
 * mapping gates on already requires corroborated cross-pull-request
 * evidence, not a single PR's own noise.
 */
export const PARK_ELIGIBLE_BLOCKER_GATES: Readonly<
  Record<ProviderHealthService, ReadonlySet<string>>
> = Object.freeze({
  'advisory-review': new Set(['advisory-wait', 'copilot-terminal-unavailable']),
  'ci-actions': new Set(['ci', 'discarded-required-check-siblings']),
});

export type ParkEligibilityReason =
  | 'eligible'
  | 'verdict-not-unavailable'
  | 'no-blockers'
  | 'unmapped-blocker';

export interface ParkEligibility {
  eligible: boolean;
  reason: ParkEligibilityReason;
  unmappedBlockers: string[];
}

/**
 * Pure eligibility decision (#2321): park only when the live verdict for
 * `service` is `unavailable` AND every one of the caller's fresh
 * `pre-merge-readiness` blocker-gate names maps to that service via
 * {@link PARK_ELIGIBLE_BLOCKER_GATES}. An empty `blockers` list is not
 * eligible either -- "no blocker at all" is not "blocked solely by this
 * service". Any blocker outside the map (including one that maps to the
 * OTHER service) fails closed to ineligible, matching "any other blocker
 * keeps today's [hold] behavior".
 */
export function resolveParkEligibility(
  service: ProviderHealthService,
  verdict: ProviderHealthVerdict | string,
  blockers: readonly string[],
): ParkEligibility {
  if (verdict !== 'unavailable') {
    return {
      eligible: false,
      reason: 'verdict-not-unavailable',
      unmappedBlockers: [],
    };
  }
  if (blockers.length === 0) {
    return { eligible: false, reason: 'no-blockers', unmappedBlockers: [] };
  }
  const allowedGates = PARK_ELIGIBLE_BLOCKER_GATES[service];
  const unmappedBlockers = blockers.filter((gate) => !allowedGates.has(gate));
  if (unmappedBlockers.length > 0) {
    return { eligible: false, reason: 'unmapped-blocker', unmappedBlockers };
  }
  return { eligible: true, reason: 'eligible', unmappedBlockers: [] };
}

/** One parked pull request as reported by the read-only list mode. */
export interface ParkedPullRequestEntry {
  prNumber: number;
  issueNumber: number;
  service: string;
  headSha: string;
  claimId: string;
  parkedAt: string;
  actor: string;
  blockers: string[];
  verdict: ProviderHealthVerdict | 'unknown';
  resumable: boolean;
}

/** One raw, already-trust-filtered park marker read off a specific pull request. */
export interface RawParkMarker {
  prNumber: number;
  marker: ParsedProviderOutagePark;
}

type ReadStage =
  | 'repository/auth-resolution'
  | 'open-pr-enumeration'
  | 'park-marker-and-issue-comment-reads'
  | 'provider-health-reads';

type ReportReadStage = (stage: ReadStage) => void;

/**
 * Pure assembly of the parked-change list (#2321): annotates each raw
 * marker with its parked service's CURRENT live verdict (never the verdict
 * at park time -- resumability is about whether the service has recovered
 * NOW) and sorts deterministically by the marker's own `parkedAt` field,
 * then pull request number as a tie-break. Never sorts or selects on a
 * comment's `createdAt` -- {@link parseProviderOutageParkComment} degrades
 * an unreadable `createdAt` to the literal string `'none'`, and `parkedAt`
 * is the field {@link renderProviderOutageParkComment} always validates
 * before rendering, so it is the only timestamp safe to sort on here.
 */
export function buildParkedChangeList(
  rawMarkers: readonly RawParkMarker[],
  verdictsByService: ReadonlyMap<string, ProviderHealthVerdict>,
): { entries: ParkedPullRequestEntry[]; count: number } {
  const entries = rawMarkers.map(({ prNumber, marker }) => {
    const verdict = verdictsByService.get(marker.service) ?? 'unknown';
    return {
      prNumber,
      issueNumber: marker.issueNumber,
      service: marker.service,
      headSha: marker.headSha,
      claimId: marker.claimId,
      parkedAt: marker.parkedAt,
      actor: marker.actor,
      blockers: marker.blockers,
      verdict,
      resumable: verdict === 'healthy',
    };
  });
  entries.sort((a, b) => {
    const byParkedAt = compareIsoTimestamps(a.parkedAt, b.parkedAt);
    return byParkedAt !== 0 ? byParkedAt : a.prNumber - b.prNumber;
  });
  return { entries, count: entries.length };
}

/** One issue comment, in the shape the GitHub REST list endpoint returns. */
interface CommentLike {
  id?: string | number | null;
  node_id?: string | null;
  body?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  author?: { login?: string | null } | null;
  user?: { login?: string | null } | null;
  /** #3249: `idd-provider-outage-park` is one of the issue's own named
   * restrict-only exceptions -- ignoring an edited marker would LOWER the
   * parked count and could lift `providerOutage.maxParkedChanges`, the
   * opposite of every other family this issue tightens. Declared here only
   * so a test fixture carrying it type-checks; this reader never consults
   * it and intentionally applies no edit-state gate. */
  last_edited_at?: string | null;
  lastEditedAt?: string | null;
  html_url?: string | null;
  url?: string | null;
}

/**
 * The LATEST trusted `idd-provider-outage-park` marker on `comments` (by
 * the marker's own `parkedAt` field) -- mirrors
 * `latestTrustedAdvisoryWaitRequest` (provider-health.mts) deliberately: an
 * untrusted actor's comment must never poison park-list selection, and
 * selecting/sorting on anything other than the parser-validated `parkedAt`
 * field re-opens the exact NaN-poisoning trap `deriveAdvisoryReviewObservation`
 * and Copilot found (twice) in this repository's own #2403 session.
 */
function latestTrustedParkMarker(
  comments: readonly CommentLike[],
  trustedMarkerLogins: ReadonlySet<string>,
): ParsedProviderOutagePark | null {
  let latest: ParsedProviderOutagePark | null = null;
  for (const comment of comments) {
    const authorLogin = String(comment?.user?.login ?? '')
      .trim()
      .toLowerCase();
    if (!trustedMarkerLogins.has(authorLogin)) continue;
    const parsed = parseProviderOutageParkComment(
      String(comment?.body ?? ''),
      String(comment?.created_at ?? ''),
    );
    if (parsed === null) continue;
    if (
      latest === null ||
      compareIsoTimestamps(parsed.parkedAt, latest.parkedAt) > 0
    ) {
      latest = parsed;
    }
  }
  return latest;
}

/**
 * The latest GitHub `created_at` of a trusted `claimed-by` comment on the
 * originating issue (#3277), or `null` when none exists. A fresh claim and
 * a heartbeat share the identical `claimed-by:` wire format
 * (`parseClaimComment`, marker-helpers.mts), so either one means "a
 * session has touched this issue since it was parked" -- exactly the
 * signal {@link classifyParkMarker}'s liveness check needs, no supersede-
 * chain or active-claim resolution required. Explicitly validates each
 * comment's own `created_at` via `isValidIsoTimestamp` before comparing,
 * rather than relying on `compareIsoTimestamps`'s fallback ordering for a
 * malformed timestamp to happen to produce the right answer.
 */
function latestTrustedClaimCreatedAt(
  comments: readonly CommentLike[],
  trustedMarkerLogins: ReadonlySet<string>,
): string | null {
  let latest: string | null = null;
  const trusted = (login: string) =>
    trustedMarkerLogins.has(login.trim().toLowerCase());
  for (const comment of filterTrustedClaimFamilyEvents(
    [...comments],
    trusted,
  )) {
    const authorLogin = String(comment?.user?.login ?? '')
      .trim()
      .toLowerCase();
    if (!trustedMarkerLogins.has(authorLogin)) continue;
    const createdAt = String(comment?.created_at ?? '');
    if (!isValidIsoTimestamp(createdAt)) continue;
    const parsed = parseClaimComment(String(comment?.body ?? ''), createdAt);
    if (parsed === null) continue;
    if (latest === null || compareIsoTimestamps(parsed.createdAt, latest) > 0) {
      latest = parsed.createdAt;
    }
  }
  return latest;
}

/** One raw park marker's liveness classification (#3277). */
export type ParkMarkerClassification =
  | 'live'
  | 'retired:head-moved'
  | 'retired:later-claim'
  | 'retired:unsupported-service';

/**
 * Pure liveness decision (#3277): a park marker counts as LIVE only when
 * all of these hold:
 *
 * - `marker.service` is one of {@link PROVIDER_HEALTH_SERVICES} -- `--park`
 *   already rejects any other value, so a marker outside this set is
 *   stale/malformed evidence, not a service this report can even classify;
 * - the marker's `headSha` still equals the pull request's current head
 *   SHA (the pull request has not moved since it was parked). An empty
 *   `prHeadSha` (the open-pull-request list payload's own `head.sha` was
 *   missing or unreadable) fails CLOSED to `retired:head-moved` --
 *   `marker.headSha` is always a validated 40-hex value
 *   (`renderProviderOutageParkComment` rejects anything else), so it can
 *   never equal an empty string; the required current-head comparison
 *   was never actually established, so this must never be silently
 *   treated as proven-live (#3379 review, Copilot);
 * - no trusted `claimed-by` on the originating issue has a GitHub
 *   `created_at` STRICTLY LATER than the park marker's own COMMENT
 *   `created_at` (never the embedded `parked:` field, which is the
 *   parking agent's local clock -- the Groom-hearing decision this issue
 *   records).
 *
 * `resolveIssueLatestClaimCreatedAt` is a LAZY callback, not a plain
 * value: it is invoked only once the cheaper service/head checks above
 * already pass and `marker.createdAt` is readable, so a marker already
 * retired by service or head never pays for the originating-issue
 * comment read at all (#3379 review, Copilot) -- the caller
 * ({@link collectRawParkMarkers}) also caches its result per issue
 * number, since several markers can share one originating issue.
 *
 * The `marker.createdAt === 'none'` short-circuit below is LOAD-BEARING,
 * not defensive: `compareIsoTimestamps` sorts a non-ISO string (including
 * the literal `'none'` `parseProviderOutageParkComment` degrades an
 * unreadable comment `created_at` to) as AFTER any valid ISO timestamp
 * via its numeric/string fallback, so removing this guard would silently
 * flip the fail-open contract -- an unreadable park comment would retire
 * the marker instead of keeping it live. A resolved
 * `issueLatestClaimCreatedAt === null` (no trusted claimed-by found at
 * all, or the issue's own comment read failed) fails open the same way.
 */
export function classifyParkMarker(
  marker: ParsedProviderOutagePark,
  prHeadSha: string,
  resolveIssueLatestClaimCreatedAt: () => string | null,
): ParkMarkerClassification {
  if (
    !PROVIDER_HEALTH_SERVICES.includes(marker.service as ProviderHealthService)
  ) {
    return 'retired:unsupported-service';
  }
  if (marker.headSha.toLowerCase() !== prHeadSha.toLowerCase()) {
    return 'retired:head-moved';
  }
  if (marker.createdAt === 'none') {
    return 'live';
  }
  const issueLatestClaimCreatedAt = resolveIssueLatestClaimCreatedAt();
  if (
    issueLatestClaimCreatedAt !== null &&
    compareIsoTimestamps(issueLatestClaimCreatedAt, marker.createdAt) > 0
  ) {
    return 'retired:later-claim';
  }
  return 'live';
}

interface GhOpenPullRequest {
  number?: number;
  head?: { sha?: string };
}

/** Injectable open-pull-request-list fetcher; see {@link collectRawParkMarkers}. */
type FetchOpenPullRequests = (
  owner: string,
  repo: string,
  sampleSize: number,
) => GhOpenPullRequest[];

/**
 * Injectable comments fetcher -- PRs and issues share the identical GitHub
 * REST shape (`issues/{number}/comments`), so one function serves both the
 * per-pull-request park-marker read and the new per-issue claim read
 * (#3277). Throws on failure; the caller decides what a failure means at
 * each call site.
 */
type FetchComments = (
  owner: string,
  repo: string,
  number: number,
  resolveClaimEditState?: boolean,
) => CommentLike[];

const defaultFetchOpenPullRequests: FetchOpenPullRequests = (
  owner,
  repo,
  sampleSize,
) => {
  const payload = ghApiJson(
    `repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${sampleSize}`,
  );
  if (!Array.isArray(payload)) {
    throw new Error('malformed open pull request list response');
  }
  return payload as GhOpenPullRequest[];
};

const defaultFetchComments: FetchComments = (
  owner,
  repo,
  number,
  resolveClaimEditState = false,
) => {
  const payload = ghApiJson(
    `repos/${owner}/${repo}/issues/${number}/comments`,
    {
      paginate: true,
    },
  );
  if (!Array.isArray(payload)) {
    throw new Error('malformed comments response');
  }
  const comments = payload as CommentLike[];
  if (!resolveClaimEditState || comments.length === 0) {
    return comments;
  }
  const nodeIds = comments.map((comment) => String(comment.node_id ?? ''));
  if (nodeIds.some((nodeId) => nodeId === '')) {
    throw new Error(
      'provider-outage-park: comment response is missing node_id required to resolve edit state',
    );
  }
  const lastEditedAtByNodeId = fetchLastEditedAtByNodeId(ghText, nodeIds);
  return comments.map((comment, index) => ({
    ...comment,
    lastEditedAt: lastEditedAtByNodeId.get(nodeIds[index]),
  }));
};

/**
 * Collect every open pull request's latest trusted park marker, bounded to
 * the `sampleSize` most-recently-updated open pull requests (default `50`,
 * same default `provider-health.mts` uses) so a repository with many open
 * pull requests never produces an unbounded fan-out of per-pull-request
 * comment reads. `sampleTruncated` is true when the live open-PR count may
 * exceed `sampleSize` (the fetched page came back full) -- an older parked
 * pull request outside this sample would otherwise silently understate
 * `count`/`boundReached` (Codex/CodeRabbit review, PR #2421); the caller
 * must treat that case as bound-reached rather than trust an undercount.
 *
 * #3277: a found marker is additionally classified via
 * {@link classifyParkMarker} against the pull request's own live `head.sha`
 * (already present on the open-PR list payload -- no extra fetch) and the
 * originating issue's latest trusted `claimed-by` `created_at`
 * ({@link latestTrustedClaimCreatedAt}, read via the SAME injectable
 * `fetchComments`, lazily and cached per issue number -- see
 * `resolveIssueLatestClaimCreatedAt` below; #3379 review, Copilot). Only a
 * `'live'` classification is kept in `rawMarkers`; anything else
 * increments `retiredCount`. A failed ORIGINATING-ISSUE comment read is
 * caught locally and treated as `null` (fails open toward live, per
 * {@link classifyParkMarker}) -- it does not drop a marker from the list,
 * so it is never counted toward `prCommentReadFailureCount`, which tracks
 * only a failed PULL-REQUEST comment read (the read that finds the marker
 * itself, whose failure DOES silently drop a genuinely parked pull
 * request).
 */
function collectRawParkMarkers(
  owner: string,
  repo: string,
  options: {
    sampleSize?: number;
    trustedMarkerLogins: ReadonlySet<string>;
    fetchOpenPullRequests?: FetchOpenPullRequests;
    fetchComments?: FetchComments;
    reportReadStage?: ReportReadStage;
  },
): {
  rawMarkers: RawParkMarker[];
  sampleTruncated: boolean;
  retiredCount: number;
  prCommentReadFailureCount: number;
} {
  const sampleSize = options.sampleSize ?? 50;
  const fetchOpenPullRequests =
    options.fetchOpenPullRequests ?? defaultFetchOpenPullRequests;
  const fetchComments = options.fetchComments ?? defaultFetchComments;
  let openPrs: GhOpenPullRequest[];
  try {
    options.reportReadStage?.('open-pr-enumeration');
    openPrs = fetchOpenPullRequests(owner, repo, sampleSize);
  } catch (error) {
    // #3346 review finding: preserve the original gh-exec.mts-tagged error
    // as `.cause` (not dropped as before) so classifyHelperError's
    // cause-chain walk can still classify a real gh transport/not-found
    // failure correctly instead of losing it to the generic `internal`
    // fallback -- mirrors provider-outage-declaration.mts's identical fix.
    throw new Error(
      `could not read open pull requests to list parked changes: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  // #3379 review (Copilot): several markers can share one originating
  // issue (`deriveParkedIssues` explicitly supports this), so cache the
  // per-issue claim-lookup result -- including a failed read, which
  // still fails open to `null` -- for the lifetime of this collection
  // pass, keyed by issue number. Combined with `classifyParkMarker`'s
  // lazy resolver callback, a marker already retired by the cheaper
  // service/head checks never triggers this read at all.
  const issueLatestClaimCreatedAtCache = new Map<number, string | null>();
  const resolveIssueLatestClaimCreatedAt = (
    issueNumber: number,
  ): string | null => {
    const cached = issueLatestClaimCreatedAtCache.get(issueNumber);
    if (cached !== undefined) return cached;
    let result: string | null;
    try {
      options.reportReadStage?.('park-marker-and-issue-comment-reads');
      const issueComments = fetchComments(owner, repo, issueNumber, true);
      result = latestTrustedClaimCreatedAt(
        issueComments,
        options.trustedMarkerLogins,
      );
    } catch {
      // Fails open toward live (#3277 AC) -- never counted toward
      // `prCommentReadFailureCount`; see the docstring above.
      result = null;
    }
    issueLatestClaimCreatedAtCache.set(issueNumber, result);
    return result;
  };

  const rawMarkers: RawParkMarker[] = [];
  let retiredCount = 0;
  let prCommentReadFailureCount = 0;
  for (const pr of openPrs) {
    if (typeof pr.number !== 'number') continue;
    let comments: CommentLike[];
    try {
      options.reportReadStage?.('park-marker-and-issue-comment-reads');
      comments = fetchComments(owner, repo, pr.number);
    } catch {
      // A per-pull-request comment read failure skips that pull request
      // only -- the fetchable pull requests still yield a real (if
      // incomplete) list, matching provider-health.mts's own per-item
      // read-failure posture. Counted toward `prCommentReadFailureCount`
      // (#3277): this IS a completeness risk, unlike a failed
      // originating-issue read below.
      prCommentReadFailureCount += 1;
      continue;
    }
    const marker = latestTrustedParkMarker(
      comments,
      options.trustedMarkerLogins,
    );
    if (marker === null) continue;

    const classification = classifyParkMarker(
      marker,
      String(pr.head?.sha ?? ''),
      () => resolveIssueLatestClaimCreatedAt(marker.issueNumber),
    );
    if (classification !== 'live') {
      retiredCount += 1;
      continue;
    }
    rawMarkers.push({ prNumber: pr.number, marker });
  }
  return {
    rawMarkers,
    sampleTruncated: openPrs.length >= sampleSize,
    retiredCount,
    prCommentReadFailureCount,
  };
}

/**
 * The sorted, de-duplicated issue numbers of every LIVE entry whose
 * `resumable` is `false` (#3277) -- the set the Discover sibling issue
 * consumes to skip still-parked issues. Pure and exported so it is
 * directly testable against a synthetic `entries` list, independent of
 * {@link buildParkedChangeReport}'s own network reads.
 */
export function deriveParkedIssues(
  entries: readonly ParkedPullRequestEntry[],
): number[] {
  return [
    ...new Set(
      entries.filter((entry) => !entry.resumable).map((e) => e.issueNumber),
    ),
  ].sort((a, b) => a - b);
}

/**
 * Read-only list mode (#2321): every open pull request carrying a LIVE
 * trusted park marker (#3277: {@link classifyParkMarker} retires a marker
 * whose head has moved, whose issue was re-claimed since, or whose
 * service is no longer recognized -- see `retiredCount`), each annotated
 * with its parked service's CURRENT live `provider-health` verdict.
 * `count`/`boundReached` against the configured
 * `providerOutage.maxParkedChanges` are information only -- this function
 * enforces nothing; the bound stops new issue CLAIMS (an instruction-level
 * rule), never the parking of an already-stuck pull request. When the open
 * pull request read is truncated (more may exist beyond `sampleSize`),
 * `boundReached` fails closed to `true` regardless of the sampled `count` --
 * an undercounted bound must never read as "still under the limit".
 *
 * `parkedIssues`/`parkedIssuesComplete` (#3277) are the cheap-mode
 * contract: `parkedIssuesComplete` is `false` when `sampleTruncated` is
 * `true` or any per-PULL-REQUEST comment read failed (either can silently
 * drop a parked issue from `parkedIssues`) -- a failed per-ISSUE comment
 * read does NOT affect completeness, since it fails open toward keeping
 * the marker live instead of dropping it.
 *
 * Live markers are collected before health evidence (#4615), and each
 * distinct marker service is read once through the typed service-scoped
 * reader. This keeps empty scans free of provider-health reads and avoids
 * collecting evidence for an unused service. `readHealthService` is an
 * injectable seam for offline tests and runtime stage reporting.
 */
export function buildParkedChangeReport(
  owner: string,
  repo: string,
  options: {
    config?: unknown;
    now?: string;
    sampleSize?: number;
    fetchOpenPullRequests?: FetchOpenPullRequests;
    fetchComments?: FetchComments;
    readHealthService?: ProviderHealthServiceReader;
    reportReadStage?: ReportReadStage;
  } = {},
): {
  protocolVersion: '1';
  now: string;
  entries: ParkedPullRequestEntry[];
  count: number;
  maxParkedChanges: number;
  boundReached: boolean;
  sampleTruncated: boolean;
  retiredCount: number;
  parkedIssues: number[];
  parkedIssuesComplete: boolean;
} {
  const config = options.config ?? loadIddConfig();
  const now = options.now ?? toSecondPrecisionIso(new Date());
  const { actors: trustedMarkerActors } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: config as { trustedMarkerActors?: unknown } | null,
  });
  const trustedMarkerLogins = new Set(
    trustedMarkerActors.map((login) => login.toLowerCase()),
  );
  const maxParkedChanges =
    normalizePolicyConfig(config).providerOutage.maxParkedChanges;

  const {
    rawMarkers,
    sampleTruncated,
    retiredCount,
    prCommentReadFailureCount,
  } = collectRawParkMarkers(owner, repo, {
    sampleSize: options.sampleSize,
    trustedMarkerLogins,
    fetchOpenPullRequests: options.fetchOpenPullRequests,
    fetchComments: options.fetchComments,
    reportReadStage: options.reportReadStage,
  });

  const distinctServices = [
    ...new Set(rawMarkers.map((r) => r.marker.service)),
  ].filter((service): service is ProviderHealthService =>
    (PROVIDER_HEALTH_SERVICES as readonly string[]).includes(service),
  );
  const verdictsByService = new Map<string, ProviderHealthVerdict>();
  const readHealthService =
    options.readHealthService ?? buildProviderHealthServiceReport;
  for (const service of distinctServices) {
    try {
      options.reportReadStage?.('provider-health-reads');
      const result = readHealthService(owner, repo, service, { config, now });
      if (result.service === service) {
        verdictsByService.set(service, result.verdict);
      }
    } catch {
      // A failed service read leaves the verdict absent; the list builder
      // maps that to `unknown`, which keeps the issue parked.
    }
  }

  const { entries, count } = buildParkedChangeList(
    rawMarkers,
    verdictsByService,
  );
  return {
    protocolVersion: '1',
    now,
    entries,
    count,
    maxParkedChanges,
    boundReached: computeBoundReached(count, maxParkedChanges, sampleTruncated),
    sampleTruncated,
    retiredCount,
    parkedIssues: deriveParkedIssues(entries),
    parkedIssuesComplete: !sampleTruncated && prCommentReadFailureCount === 0,
  };
}

/**
 * Cheap `--parked-issues` mode (#3277): collect and validate live markers
 * first, then read only the service evidence those markers require (#4615).
 * With no live markers it returns the marker scan's completeness result
 * without any provider-health read. The same collected markers and
 * service verdicts feed list mode and this summary.
 */
export function buildParkedIssuesSummary(
  owner: string,
  repo: string,
  options: {
    config?: unknown;
    now?: string;
    sampleSize?: number;
    readHealthService?: ProviderHealthServiceReader;
    fetchOpenPullRequests?: FetchOpenPullRequests;
    fetchComments?: FetchComments;
    reportReadStage?: ReportReadStage;
  } = {},
): { parkedIssues: number[]; parkedIssuesComplete: boolean } {
  const report = buildParkedChangeReport(owner, repo, options);
  return {
    parkedIssues: report.parkedIssues,
    parkedIssuesComplete: report.parkedIssuesComplete,
  };
}

/**
 * `--park` mode (#2321): re-checks eligibility against LIVE state (never
 * trusts a caller-supplied verdict, which would be circular -- the live
 * recheck is the fail-closed teeth) and, on `--apply`, posts the park
 * marker to the pull request. Fetches the pull request's own live head SHA
 * itself (one read) rather than a hand-typed `--head-sha`, removing a
 * 40-hex typo class. Releasing the originating issue's claim is a
 * separate, already-existing step (`post-idd-marker.mjs --type unclaim`)
 * the caller takes afterward -- this function never touches claim state.
 */
export function runParkPullRequest(options: {
  owner: string;
  repo: string;
  prNumber: number;
  issueNumber: number;
  service: string;
  blockers: readonly string[];
  agentId: string;
  claimId: string;
  apply: boolean;
  config?: unknown;
  now?: string;
  fetchHeadSha?: (prNumber: number) => string;
}): {
  eligible: boolean;
  eligibility: ParkEligibility;
  verdict: ProviderHealthVerdict | 'unknown';
  headSha: string;
  markerBody: string;
  posted: boolean;
} {
  if (
    !PROVIDER_HEALTH_SERVICES.includes(options.service as ProviderHealthService)
  ) {
    throw markCliUsageError(
      new Error(
        `unsupported --service value: ${options.service} (expected one of ${PROVIDER_HEALTH_SERVICES.join(', ')})`,
      ),
    );
  }
  const service = options.service as ProviderHealthService;
  const config = options.config ?? loadIddConfig();
  // renderProviderOutageParkComment requires a second-precision `parkedAt`
  // (marker-helpers.mts's normalizeSecondPrecisionIsoTimestamp rejects
  // fractional seconds outright) -- Date#toISOString() always includes
  // milliseconds, so the default `now` must be truncated here or every
  // ordinary --park --apply call (no --now override) throws.
  const now = options.now ?? toSecondPrecisionIso(new Date());

  const report = buildProviderHealthReport(options.owner, options.repo, {
    config,
    now,
  });
  const verdict = report.services[service].verdict;

  const eligibility = resolveParkEligibility(
    service,
    verdict,
    options.blockers,
  );

  const fetchHeadSha =
    options.fetchHeadSha ??
    ((prNumber: number) =>
      ghText([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        `${options.owner}/${options.repo}`,
        '--json',
        'headRefOid',
        '--jq',
        '.headRefOid',
      ]).trim());

  if (!eligibility.eligible) {
    return {
      eligible: false,
      eligibility,
      verdict,
      headSha: '',
      markerBody: '',
      posted: false,
    };
  }

  const headSha = fetchHeadSha(options.prNumber);
  const markerBody = renderProviderOutageParkComment({
    actor: options.agentId,
    issueNumber: options.issueNumber,
    service,
    headSha,
    claimId: options.claimId,
    parkedAt: now,
    blockers: options.blockers,
  });

  let posted = false;
  if (options.apply) {
    ghText([
      'api',
      `repos/${options.owner}/${options.repo}/issues/${options.prNumber}/comments`,
      '--method',
      'POST',
      '-f',
      `body=${markerBody}`,
    ]);
    posted = true;
  }

  return { eligible: true, eligibility, verdict, headSha, markerBody, posted };
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `owner:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --owner spec key
// below. See cli-args.mts's module header for the full invariant.
export const DEFAULT_READ_BUDGET_MS = 120_000;
export const MAX_READ_BUDGET_MS = 2_147_483_647;
const READ_PROGRESS_INTERVAL_MS = 10_000;
const PROCESS_TREE_CLEANUP_BUDGET_MS = 5_000;
const READ_WORKER_HANDSHAKE_TIMEOUT_MS = 5_000;
const READ_WORKER_ENV = 'IDD_PROVIDER_OUTAGE_PARK_READ_WORKER';
const READ_WORKER_STAGE_FD_ENV = 'IDD_PROVIDER_OUTAGE_PARK_STAGE_FD';
const READ_WORKER_TOKEN_ENV = 'IDD_PROVIDER_OUTAGE_PARK_READ_WORKER_TOKEN';
const READ_WORKER_HANDSHAKE_TYPE = 'idd-provider-outage-park-read-worker';
let readWorkerAuthorized = false;
const READ_STAGES = new Set<ReadStage>([
  'repository/auth-resolution',
  'open-pr-enumeration',
  'park-marker-and-issue-comment-reads',
  'provider-health-reads',
]);

const PROVIDER_OUTAGE_PARK_FLAG_SPEC = {
  '--park': { type: 'boolean', default: false },
  '--parked-issues': { type: 'boolean', default: false },
  '--budget-ms': { type: 'string', default: String(DEFAULT_READ_BUDGET_MS) },
  '--pr': { type: 'string', default: '' },
  '--issue': { type: 'string', default: '' },
  '--service': { type: 'string', default: '' },
  '--blockers': { type: 'string', default: '' },
  '--agent-id': { type: 'string', default: '' },
  '--claim-id': { type: 'string', default: '' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--apply': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function parsePositiveIntegerFlag(value: unknown, flag: string): number {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw markCliUsageError(new Error(`invalid ${flag} value: ${value}`));
  }
  return Number(raw);
}

export function parseReadBudget(value: unknown): number {
  const budgetMs = parsePositiveIntegerFlag(value, '--budget-ms');
  if (!Number.isSafeInteger(budgetMs) || budgetMs > MAX_READ_BUDGET_MS) {
    throw markCliUsageError(
      new Error(
        `invalid --budget-ms value: expected an integer from 1 through ${MAX_READ_BUDGET_MS}`,
      ),
    );
  }
  return budgetMs;
}

export interface ReadSupervisorDependencies {
  now?: () => number;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  entryPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  progressIntervalMs?: number;
  cleanupBudgetMs?: number;
  writeStderr?: (text: string) => void;
  writeStdout?: (chunk: string | Uint8Array) => void;
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  processGroupExists?: (pid: number) => boolean;
}

export interface ChildCloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

function hasReadWorkerEnvironment(): boolean {
  return (
    process.env[READ_WORKER_ENV] === '1' &&
    process.env[READ_WORKER_STAGE_FD_ENV] === '3'
  );
}

function authorizeReadWorkerProcess(token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      process.removeListener('message', onMessage);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('read worker authorization timed out'));
    }, READ_WORKER_HANDSHAKE_TIMEOUT_MS);
    const onMessage = (message: unknown) => {
      cleanup();
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === READ_WORKER_HANDSHAKE_TYPE &&
        (message as { token?: unknown }).token === token
      ) {
        process.disconnect?.();
        resolve();
        return;
      }
      reject(new Error('read worker authorization was invalid'));
    };
    process.once('message', onMessage);
  });
}

function reportReadStage(stage: ReadStage): boolean {
  if (!readWorkerAuthorized || process.env[READ_WORKER_STAGE_FD_ENV] !== '3') {
    return false;
  }
  const line = Buffer.from(`${JSON.stringify({ stage })}\n`, 'utf8');
  try {
    let offset = 0;
    while (offset < line.length) {
      offset += writeSync(3, line, offset, line.length - offset);
    }
    return true;
  } catch {
    return false;
  }
}

function hasExplicitFlag(args: readonly string[], flag: string): boolean {
  return args.some(
    (argument) => argument === flag || argument.startsWith(`${flag}=`),
  );
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

function childClose(child: ChildProcess): Promise<ChildCloseResult> {
  return new Promise((resolve) => {
    let error: Error | null = null;
    child.once('error', (caught) => {
      error = caught;
    });
    child.once('close', (code, signal) => {
      resolve({ code, signal, error });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve(timeoutValue),
      Math.max(0, timeoutMs),
    );
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function runTaskkill(
  child: ChildProcess,
  force: boolean,
  remainingMs: number,
  spawnProcess: typeof spawn,
): Promise<{ success: boolean; reaped: boolean }> {
  if (child.pid === undefined || remainingMs <= 0) {
    return { success: false, reaped: false };
  }
  let taskkill: ChildProcess;
  try {
    taskkill = spawnProcess(
      'taskkill',
      ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch {
    return { success: false, reaped: true };
  }
  const taskkillClosed = childClose(taskkill);
  const waitMs = force
    ? Math.max(0, remainingMs - 100)
    : Math.min(1_000, Math.floor(remainingMs / 2));
  const result = await raceWithTimeout(taskkillClosed, waitMs, null);
  if (result !== null) {
    return {
      success: result.code === 0 && result.error === null,
      reaped: true,
    };
  }
  try {
    taskkill.kill('SIGKILL');
  } catch {
    // The bounded child-close wait below determines whether taskkill stopped.
  }
  const reaped = await raceWithTimeout(
    taskkillClosed,
    Math.min(100, Math.max(0, remainingMs - waitMs)),
    null,
  );
  if (reaped === null) {
    try {
      taskkill.kill('SIGKILL');
    } catch {
      // Cleanup failure is reported by the caller.
    }
  }
  return { success: false, reaped: reaped !== null };
}

export async function terminateOwnedProcessTree(
  child: ChildProcess,
  closed: Promise<ChildCloseResult>,
  dependencies: Required<
    Pick<
      ReadSupervisorDependencies,
      | 'now'
      | 'platform'
      | 'spawnProcess'
      | 'cleanupBudgetMs'
      | 'signalProcessGroup'
      | 'processGroupExists'
    >
  >,
): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return false;
  const deadline = dependencies.now() + dependencies.cleanupBudgetMs;
  const remaining = () => Math.max(0, deadline - dependencies.now());

  if (dependencies.platform === 'win32') {
    const graceful = await runTaskkill(
      child,
      false,
      remaining(),
      dependencies.spawnProcess,
    );
    if (!graceful.reaped) return false;
    if (graceful.success) {
      const gracefulExit = await raceWithTimeout(
        closed.then(() => true),
        Math.min(250, remaining()),
        false,
      );
      if (gracefulExit) return true;
    }
    const forced = await runTaskkill(
      child,
      true,
      remaining(),
      dependencies.spawnProcess,
    );
    if (!forced.success || !forced.reaped) return false;
    const result = await raceWithTimeout(
      closed.then(() => true),
      remaining(),
      false,
    );
    return result;
  }

  if (dependencies.processGroupExists(pid)) {
    try {
      dependencies.signalProcessGroup(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        // Continue to the liveness probe and forced-cleanup path.
      }
    }
    await delay(Math.min(300, remaining()));
  }
  if (remaining() > 0 && dependencies.processGroupExists(pid)) {
    try {
      dependencies.signalProcessGroup(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        // The final liveness check reports a cleanup failure if it remains.
      }
    }
  }
  while (remaining() > 0 && dependencies.processGroupExists(pid)) {
    await delay(Math.min(50, remaining()));
  }
  if (dependencies.processGroupExists(pid)) return false;
  return raceWithTimeout(
    closed.then(() => true),
    remaining(),
    false,
  );
}

function parseWorkerErrorEnvelope(stderr: string): {
  stderr: string;
  outcome: HelperCliResult | null;
} {
  const content = stderr.replace(/\r?\n+$/, '');
  const lineStart = content.lastIndexOf('\n') + 1;
  const line = content.slice(lineStart).replace(/\r$/, '');
  if (!line.startsWith('{"iddHelperError":')) {
    return { stderr, outcome: null };
  }
  try {
    const parsed = JSON.parse(line) as {
      iddHelperError?: {
        version?: number;
        helper?: string;
        kind?: string;
        exitCode?: number;
        message?: string;
        httpStatus?: number | null;
        notDispatched?: true;
        retryAt?: string;
      };
    };
    const envelope = parsed.iddHelperError;
    if (
      envelope?.version !== 1 ||
      envelope.helper !== 'provider-outage-park' ||
      !['usage', 'not-found', 'transport', 'gate', 'internal'].includes(
        String(envelope.kind),
      ) ||
      typeof envelope.exitCode !== 'number'
    ) {
      return { stderr, outcome: null };
    }
    return {
      stderr: content.slice(0, lineStart),
      outcome: {
        exitCode: envelope.exitCode,
        kind: envelope.kind as
          | 'usage'
          | 'not-found'
          | 'transport'
          | 'gate'
          | 'internal',
        message: envelope.message,
        httpStatus: envelope.httpStatus,
        ...(envelope.notDispatched ? { notDispatched: true } : {}),
        ...(envelope.retryAt ? { retryAt: envelope.retryAt } : {}),
      },
    };
  } catch {
    return { stderr, outcome: null };
  }
}

export async function superviseReadMode(
  mode: 'list' | 'parked-issues',
  budgetMs: number,
  args: readonly string[],
  dependencies: ReadSupervisorDependencies = {},
): Promise<HelperCliResult> {
  const now = dependencies.now ?? (() => performance.now());
  const platform = dependencies.platform ?? process.platform;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const progressIntervalMs =
    dependencies.progressIntervalMs ?? READ_PROGRESS_INTERVAL_MS;
  const cleanupBudgetMs =
    dependencies.cleanupBudgetMs ?? PROCESS_TREE_CLEANUP_BUDGET_MS;
  const writeStderr =
    dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  const writeStdout =
    dependencies.writeStdout ??
    ((chunk: string | Uint8Array) => process.stdout.write(chunk));
  const signalGroup = dependencies.signalProcessGroup ?? signalProcessGroup;
  const groupExists = dependencies.processGroupExists ?? processGroupExists;
  const startedAt = now();
  let lastStage: ReadStage | 'worker-startup' = 'worker-startup';
  const elapsed = () => Math.max(0, Math.floor(now() - startedAt));
  const progress = (kind: 'start' | 'progress') => {
    writeStderr(
      `provider-outage-park: ${kind} mode=${mode} elapsed=${elapsed()}ms budget=${budgetMs}ms stage=${lastStage}\n`,
    );
  };

  let settleAbort!: (
    reason: 'deadline' | 'SIGINT' | 'SIGTERM' | 'worker-startup',
  ) => void;
  let abortReason: 'deadline' | 'SIGINT' | 'SIGTERM' | 'worker-startup' | null =
    null;
  const abort = new Promise<
    'deadline' | 'SIGINT' | 'SIGTERM' | 'worker-startup'
  >((resolve) => {
    settleAbort = (reason) => {
      abortReason ??= reason;
      resolve(abortReason);
    };
  });
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const onSigint = () => settleAbort('SIGINT');
  const onSigterm = () => settleAbort('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const deadlineTimer = setTimeout(
    () => settleAbort('deadline'),
    Math.max(0, budgetMs - elapsed()),
  );
  const cleanupListeners = () => {
    clearTimeout(deadlineTimer);
    if (progressTimer) clearInterval(progressTimer);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };

  progress('start');
  const preSpawnAbort =
    (abortReason as 'deadline' | 'SIGINT' | 'SIGTERM' | null) ??
    (elapsed() >= budgetMs ? 'deadline' : null);
  if (preSpawnAbort) {
    cleanupListeners();
    const message =
      preSpawnAbort === 'deadline'
        ? `read budget expired after ${budgetMs}ms at stage ${lastStage}; worker was not started`
        : `read interrupted by ${preSpawnAbort} at stage ${lastStage}; worker was not started`;
    writeStderr(`provider-outage-park: ${message}\n`);
    const exitCode =
      preSpawnAbort === 'SIGINT' ? 130 : preSpawnAbort === 'SIGTERM' ? 143 : 1;
    return { exitCode, kind: 'transport', message };
  }

  const workerToken = randomBytes(32).toString('hex');
  let child: ChildProcess;
  try {
    child = spawnProcess(
      process.execPath,
      [dependencies.entryPath ?? fileURLToPath(import.meta.url), ...args],
      {
        cwd: dependencies.cwd,
        detached: platform !== 'win32',
        env: {
          ...(dependencies.env ?? process.env),
          [READ_WORKER_ENV]: '1',
          [READ_WORKER_STAGE_FD_ENV]: '3',
          [READ_WORKER_TOKEN_ENV]: workerToken,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
  } catch (error) {
    cleanupListeners();
    const message = `could not start bounded read worker: ${error instanceof Error ? error.message : String(error)}`;
    writeStderr(`provider-outage-park: ${message}\n`);
    return { exitCode: 1, kind: 'transport', message };
  }

  const output: Buffer[] = [];
  const errorOutput: Buffer[] = [];
  let stageBuffer = '';
  child.stdout?.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));
  child.stderr?.on('data', (chunk: Buffer) =>
    errorOutput.push(Buffer.from(chunk)),
  );
  child.stdio[3]?.on('data', (chunk: Buffer) => {
    stageBuffer += Buffer.from(chunk).toString('utf8');
    for (;;) {
      const newline = stageBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stageBuffer.slice(0, newline);
      stageBuffer = stageBuffer.slice(newline + 1);
      try {
        const message = JSON.parse(line) as { stage?: ReadStage };
        if (message.stage && READ_STAGES.has(message.stage)) {
          lastStage = message.stage;
        }
      } catch {
        // A malformed stage notice is ignored; it never affects the read.
      }
    }
  });
  const closed = childClose(child);
  progressTimer = setInterval(() => progress('progress'), progressIntervalMs);
  let workerStartupError: Error | null = null;
  try {
    child.send(
      { type: READ_WORKER_HANDSHAKE_TYPE, token: workerToken },
      (error) => {
        if (error) {
          workerStartupError = error;
          settleAbort('worker-startup');
        }
      },
    );
  } catch (error) {
    workerStartupError =
      error instanceof Error ? error : new Error(String(error));
    settleAbort('worker-startup');
  }
  if (elapsed() >= budgetMs) settleAbort('deadline');

  const winner = await Promise.race([
    closed.then((result) => ({ kind: 'closed' as const, result })),
    abort.then((reason) => ({ kind: 'abort' as const, reason })),
  ]);
  const lateCompletion =
    winner.kind === 'closed' && now() - startedAt >= budgetMs;
  if (winner.kind === 'abort' || lateCompletion) {
    const reason = winner.kind === 'abort' ? winner.reason : 'deadline';
    const cleanupSucceeded = await terminateOwnedProcessTree(child, closed, {
      now,
      platform,
      spawnProcess,
      cleanupBudgetMs,
      signalProcessGroup: signalGroup,
      processGroupExists: groupExists,
    });
    cleanupListeners();
    const status = cleanupSucceeded
      ? 'owned process tree stopped and reaped'
      : `owned process tree cleanup failed within ${cleanupBudgetMs}ms`;
    const message =
      reason === 'deadline'
        ? `read budget expired after ${budgetMs}ms at stage ${lastStage}; ${status}`
        : reason === 'worker-startup'
          ? `bounded read worker authorization failed${workerStartupError ? `: ${workerStartupError.message}` : ''}; ${status}`
          : `read interrupted by ${reason} at stage ${lastStage}; ${status}`;
    writeStderr(`provider-outage-park: ${message}\n`);
    const exitCode = reason === 'SIGINT' ? 130 : reason === 'SIGTERM' ? 143 : 1;
    return { exitCode, kind: 'transport', message };
  }

  const childResult = winner.result;
  const mustCheckClosedWorkerTree =
    (platform !== 'win32' &&
      child.pid !== undefined &&
      groupExists(child.pid)) ||
    (platform === 'win32' && childResult.signal !== null);
  if (mustCheckClosedWorkerTree) {
    const cleanupSucceeded = await terminateOwnedProcessTree(child, closed, {
      now,
      platform,
      spawnProcess,
      cleanupBudgetMs,
      signalProcessGroup: signalGroup,
      processGroupExists: groupExists,
    });
    if (!cleanupSucceeded) {
      cleanupListeners();
      const message = `read worker exited while owned process tree cleanup failed within ${cleanupBudgetMs}ms`;
      writeStderr(`provider-outage-park: ${message}\n`);
      return { exitCode: 1, kind: 'transport', message };
    }
    if (platform !== 'win32') {
      writeStderr(
        'provider-outage-park: stopped remaining owned descendants after worker exit\n',
      );
    }
  }

  cleanupListeners();
  const stderr = Buffer.concat(errorOutput).toString('utf8');
  if (childResult.code !== 0) {
    const parsed = parseWorkerErrorEnvelope(stderr);
    if (parsed.stderr) writeStderr(parsed.stderr);
    if (parsed.outcome) return parsed.outcome;
    return childResult.code === null
      ? {
          exitCode: 1,
          kind: 'transport',
          message: 'read worker terminated before completion',
        }
      : childResult.code;
  }
  if (stderr) writeStderr(stderr);
  writeStdout(Buffer.concat(output));
  return 0;
}

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('provider-outage-park', main);
  } else {
    const outcome = main();
    if (outcome instanceof Promise) {
      outcome.then(applyHelperCliOutcomeWhenDisabled, (error) => {
        throw error;
      });
    } else {
      applyHelperCliOutcomeWhenDisabled(outcome);
    }
  }
}

export function main(): HelperCliResult | Promise<HelperCliResult> {
  const args = process.argv.slice(2);
  const { values, help } = parseCliArgs(args, PROVIDER_OUTAGE_PARK_FLAG_SPEC);
  if (help) {
    printHelp();
    return 0;
  }

  // #3277: --park and --parked-issues are two independent single-purpose
  // modes -- both true is never a coherent request, so fail closed before
  // either mode's own flag validation runs, the same fail-closed posture
  // pre-merge-readiness.mts applies to its own mutually-exclusive flags.
  if ((values.park as boolean) && (values['parked-issues'] as boolean)) {
    throw markCliUsageError(
      new Error('--park and --parked-issues are mutually exclusive'),
    );
  }

  const budgetWasExplicit = hasExplicitFlag(args, '--budget-ms');
  if (values.park as boolean) {
    if (budgetWasExplicit) {
      throw markCliUsageError(
        new Error('--budget-ms is available only in read-only modes'),
      );
    }
  } else {
    const budgetMs = parseReadBudget(values['budget-ms']);
    const mode = (values['parked-issues'] as boolean)
      ? 'parked-issues'
      : 'list';
    if (
      hasReadWorkerEnvironment() &&
      process.connected === true &&
      typeof process.send === 'function'
    ) {
      const token = process.env[READ_WORKER_TOKEN_ENV];
      if (!token || !/^[0-9a-f]{64}$/.test(token)) {
        throw new Error(
          'read worker authorization token is missing or invalid',
        );
      }
      return authorizeReadWorkerProcess(token).then(() => {
        readWorkerAuthorized = true;
        delete process.env[READ_WORKER_TOKEN_ENV];
        if (!reportReadStage('repository/auth-resolution')) {
          const message = 'read worker stage reporting channel is unavailable';
          process.stderr.write(`provider-outage-park: ${message}\n`);
          return { exitCode: 1, kind: 'transport', message };
        }
        const { owner, repo } = resolveGhOwnerRepo({
          owner: values.owner as string,
          repo: values.repo as string,
        });
        const reportOptions = { reportReadStage };
        const result =
          mode === 'parked-issues'
            ? buildParkedIssuesSummary(owner, repo, reportOptions)
            : buildParkedChangeReport(owner, repo, reportOptions);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      });
    }
    return superviseReadMode(mode, budgetMs, args);
  }

  const { owner, repo } = resolveGhOwnerRepo({
    owner: values.owner as string,
    repo: values.repo as string,
  });

  if (values.park as boolean) {
    const prNumber = parsePositiveIntegerFlag(values.pr, '--pr');
    const issueNumber = parsePositiveIntegerFlag(values.issue, '--issue');
    const service = (values.service as string).trim();
    const agentId = (values['agent-id'] as string).trim();
    const claimId = (values['claim-id'] as string).trim();
    if (!service) {
      throw markCliUsageError(
        new Error('missing required --service <name> argument'),
      );
    }
    if (!agentId) {
      throw markCliUsageError(
        new Error('missing required --agent-id <id> argument'),
      );
    }
    if (!claimId) {
      throw markCliUsageError(
        new Error('missing required --claim-id <id> argument'),
      );
    }
    const blockers = (values.blockers as string)
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);

    const result = runParkPullRequest({
      owner,
      repo,
      prNumber,
      issueNumber,
      service,
      blockers,
      agentId,
      claimId,
      apply: values.apply as boolean,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.eligible ? 0 : 1;
  }

  throw new Error(
    'read-only mode should have been routed through its supervisor',
  );
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/provider-outage-park.mjs [--owner <owner>] [--repo <repo>]
  node scripts/provider-outage-park.mjs --parked-issues [--owner <owner>] [--repo <repo>]
  node scripts/provider-outage-park.mjs --park --pr <n> --issue <n> \\
    --service <advisory-review|ci-actions> --blockers <gate1,gate2> \\
    --agent-id <id> --claim-id <id> [--apply]

Default (no --park/--parked-issues): read-only list mode. Reports every
open pull request carrying a LIVE trusted idd-provider-outage-park marker,
each with its parked service's current provider-health verdict and
resumable (true only once that verdict is healthy). Sorted by parkedAt
then pull request number. Also reports count and boundReached against
providerOutage.maxParkedChanges (default 10) as information only -- this
mode enforces nothing.

--budget-ms: whole-operation deadline for the default read-only list mode
and --parked-issues (default ${DEFAULT_READ_BUDGET_MS}; valid range 1 through
${MAX_READ_BUDGET_MS}). The deadline includes repository/auth resolution,
all API reads and nested synchronous gh calls. Use a larger value only
when a slow environment needs it. Expiry stops the owned process tree,
returns nonzero, and never prints a partial success report.

#3277 marker liveness: a park marker counts only when its head: still
equals the pull request's current head SHA, AND no trusted claimed-by on
the originating issue has a GitHub created_at later than the park
COMMENT's own created_at (never the embedded parked: field). A marker
that fails either check, or whose service: is not one of
advisory-review/ci-actions, is excluded from entries/count/boundReached
and counted in retiredCount instead. A failed read of the originating
issue's own comments keeps a marker live (fail-open); a failed read of
the pull request's own comments (the read that finds the marker) instead
marks the report parkedIssuesComplete: false, alongside a truncated
open-pull-request sample.

parkedIssues/parkedIssuesComplete: the sorted, de-duplicated issue
numbers of every live, non-resumable entry, for a Discover consumer to
skip. parkedIssuesComplete is false exactly when the report may have
silently dropped a parked issue (sampleTruncated, or any per-pull-request
comment read failed).

--parked-issues: cheap mode -- prints ONLY { parkedIssues,
parkedIssuesComplete }. It collects live markers first; no live markers
means no provider-health reads. Otherwise it reads only each distinct
marker service once, reusing the same markers and verdicts as list mode
(#4615). A truncated sample or failed pull-request comment read keeps
parkedIssuesComplete false even when no live marker was observed.
Mutually exclusive with --park.

--park: re-checks the named --service's LIVE provider-health verdict is
unavailable, and requires every --blockers entry (the caller's own fresh
pre-merge-readiness blocker-gate names) to map to that service. Any other
blocker, or an empty --blockers, refuses to park (exit 1, prints the
eligibility reason). Default is dry-run; --apply posts the park marker to
the pull request. This command performs no claim/state gating itself --
the calling phase runs its own claim-revalidation gate before --apply, and
releases the issue's claim afterward as a separate, already-existing
unclaim step (see post-idd-marker.mjs); this command never touches claim
state. --budget-ms cannot be combined with --park.

--owner/--repo default to the current repository (gh repo view).
`);
}
