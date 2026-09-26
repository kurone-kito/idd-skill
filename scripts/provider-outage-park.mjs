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
import { parseCliArgs } from './cli-args.mjs';
import { ghApiJson, ghText } from './gh-exec.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadIddConfig } from './idd-config.mjs';
import { isValidIsoTimestamp, parseClaimComment } from './marker-helpers.mjs';
import { normalizePolicyConfig } from './policy-helpers.mjs';
import {
  compareIsoTimestamps,
  parseProviderOutageParkComment,
  renderProviderOutageParkComment,
  resolveTrustedMarkerActors,
  toSecondPrecisionIso,
} from './protocol-helpers.mjs';
import {
  buildProviderHealthReport,
  PROVIDER_HEALTH_SERVICES,
} from './provider-health.mjs';
/**
 * Fails closed to `true` when the open-pull-request sample was truncated
 * (more may exist beyond `sampleSize`), regardless of the sampled `count` --
 * an undercounted bound must never read as "still under the limit"
 * (Codex/CodeRabbit review, PR #2421).
 */
export function computeBoundReached(count, maxParkedChanges, sampleTruncated) {
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
export const PARK_ELIGIBLE_BLOCKER_GATES = Object.freeze({
  'advisory-review': new Set(['advisory-wait', 'copilot-terminal-unavailable']),
  'ci-actions': new Set(['ci', 'discarded-required-check-siblings']),
});
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
export function resolveParkEligibility(service, verdict, blockers) {
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
export function buildParkedChangeList(rawMarkers, verdictsByService) {
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
/**
 * The LATEST trusted `idd-provider-outage-park` marker on `comments` (by
 * the marker's own `parkedAt` field) -- mirrors
 * `latestTrustedAdvisoryWaitRequest` (provider-health.mts) deliberately: an
 * untrusted actor's comment must never poison park-list selection, and
 * selecting/sorting on anything other than the parser-validated `parkedAt`
 * field re-opens the exact NaN-poisoning trap `deriveAdvisoryReviewObservation`
 * and Copilot found (twice) in this repository's own #2403 session.
 */
function latestTrustedParkMarker(comments, trustedMarkerLogins) {
  let latest = null;
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
function latestTrustedClaimCreatedAt(comments, trustedMarkerLogins) {
  let latest = null;
  for (const comment of comments) {
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
  marker,
  prHeadSha,
  resolveIssueLatestClaimCreatedAt,
) {
  if (!PROVIDER_HEALTH_SERVICES.includes(marker.service)) {
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
const defaultFetchOpenPullRequests = (owner, repo, sampleSize) => {
  const payload = ghApiJson(
    `repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${sampleSize}`,
  );
  if (!Array.isArray(payload)) {
    throw new Error('malformed open pull request list response');
  }
  return payload;
};
const defaultFetchComments = (owner, repo, number) => {
  const payload = ghApiJson(
    `repos/${owner}/${repo}/issues/${number}/comments`,
    {
      paginate: true,
    },
  );
  if (!Array.isArray(payload)) {
    throw new Error('malformed comments response');
  }
  return payload;
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
function collectRawParkMarkers(owner, repo, options) {
  const sampleSize = options.sampleSize ?? 50;
  const fetchOpenPullRequests =
    options.fetchOpenPullRequests ?? defaultFetchOpenPullRequests;
  const fetchComments = options.fetchComments ?? defaultFetchComments;
  let openPrs;
  try {
    openPrs = fetchOpenPullRequests(owner, repo, sampleSize);
  } catch (error) {
    throw new Error(
      `could not read open pull requests to list parked changes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // #3379 review (Copilot): several markers can share one originating
  // issue (`deriveParkedIssues` explicitly supports this), so cache the
  // per-issue claim-lookup result -- including a failed read, which
  // still fails open to `null` -- for the lifetime of this collection
  // pass, keyed by issue number. Combined with `classifyParkMarker`'s
  // lazy resolver callback, a marker already retired by the cheaper
  // service/head checks never triggers this read at all.
  const issueLatestClaimCreatedAtCache = new Map();
  const resolveIssueLatestClaimCreatedAt = (issueNumber) => {
    const cached = issueLatestClaimCreatedAtCache.get(issueNumber);
    if (cached !== undefined) return cached;
    let result;
    try {
      const issueComments = fetchComments(owner, repo, issueNumber);
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
  const rawMarkers = [];
  let retiredCount = 0;
  let prCommentReadFailureCount = 0;
  for (const pr of openPrs) {
    if (typeof pr.number !== 'number') continue;
    let comments;
    try {
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
export function deriveParkedIssues(entries) {
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
 * `options.healthReport` lets a caller (e.g. {@link buildParkedIssuesSummary})
 * that already computed the live provider-health report pass it through
 * instead of paying for a second one; `options.buildHealthReport`
 * overrides which function computes a fresh one when `healthReport` is
 * not supplied (defaults to the real {@link buildProviderHealthReport}).
 */
export function buildParkedChangeReport(owner, repo, options = {}) {
  const config = options.config ?? loadIddConfig();
  const now = options.now ?? toSecondPrecisionIso(new Date());
  const { actors: trustedMarkerActors } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: config,
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
  });
  const distinctServices = [
    ...new Set(rawMarkers.map((r) => r.marker.service)),
  ];
  const verdictsByService = new Map();
  if (distinctServices.length > 0) {
    const buildHealthReport =
      options.buildHealthReport ?? buildProviderHealthReport;
    const report =
      options.healthReport ?? buildHealthReport(owner, repo, { config, now });
    for (const service of distinctServices) {
      const verdict = report.services[service]?.verdict;
      if (verdict) verdictsByService.set(service, verdict);
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
 * Cheap `--parked-issues` mode (#3277): the Discover sibling issue runs
 * this on EVERY pass, so it must not always pay for the full per-pull-
 * request comment fan-out {@link buildParkedChangeReport} performs.
 * Reads the live provider-health report FIRST, unconditionally. When
 * every {@link PROVIDER_HEALTH_SERVICES} entry's verdict is `'healthy'`,
 * `parkedIssues` is empty BY CONSTRUCTION (a live marker's `resumable` is
 * `true` only once its own service is healthy, and every service is
 * healthy) and complete, so this returns immediately -- no open-pull-
 * request read, no per-pull-request comment read. Otherwise falls
 * through to the full {@link buildParkedChangeReport}, reusing the
 * already-computed health report (never a second live-evidence read).
 */
export function buildParkedIssuesSummary(owner, repo, options = {}) {
  const config = options.config ?? loadIddConfig();
  const now = options.now ?? toSecondPrecisionIso(new Date());
  const buildHealthReport =
    options.buildHealthReport ?? buildProviderHealthReport;
  const healthReport = buildHealthReport(owner, repo, { config, now });
  const allHealthy = PROVIDER_HEALTH_SERVICES.every(
    (service) => healthReport.services[service]?.verdict === 'healthy',
  );
  if (allHealthy) {
    return { parkedIssues: [], parkedIssuesComplete: true };
  }
  const report = buildParkedChangeReport(owner, repo, {
    config,
    now,
    sampleSize: options.sampleSize,
    fetchOpenPullRequests: options.fetchOpenPullRequests,
    fetchComments: options.fetchComments,
    healthReport,
  });
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
export function runParkPullRequest(options) {
  if (!PROVIDER_HEALTH_SERVICES.includes(options.service)) {
    throw markCliUsageError(
      new Error(
        `unsupported --service value: ${options.service} (expected one of ${PROVIDER_HEALTH_SERVICES.join(', ')})`,
      ),
    );
  }
  const service = options.service;
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
    ((prNumber) =>
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
const PROVIDER_OUTAGE_PARK_FLAG_SPEC = {
  '--park': { type: 'boolean', default: false },
  '--parked-issues': { type: 'boolean', default: false },
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
};
function parsePositiveIntegerFlag(value, flag) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw markCliUsageError(new Error(`invalid ${flag} value: ${value}`));
  }
  return Number(raw);
}
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('provider-outage-park', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}
function main() {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    PROVIDER_OUTAGE_PARK_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    return 0;
  }
  // #3277: --park and --parked-issues are two independent single-purpose
  // modes -- both true is never a coherent request, so fail closed before
  // either mode's own flag validation runs, the same fail-closed posture
  // pre-merge-readiness.mts applies to its own mutually-exclusive flags.
  if (values.park && values['parked-issues']) {
    throw markCliUsageError(
      new Error('--park and --parked-issues are mutually exclusive'),
    );
  }
  const owner =
    values.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    values.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  if (values['parked-issues']) {
    const summary = buildParkedIssuesSummary(owner, repo);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  if (values.park) {
    const prNumber = parsePositiveIntegerFlag(values.pr, '--pr');
    const issueNumber = parsePositiveIntegerFlag(values.issue, '--issue');
    const service = values.service.trim();
    const agentId = values['agent-id'].trim();
    const claimId = values['claim-id'].trim();
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
    const blockers = values.blockers
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
      apply: values.apply,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.eligible ? 0 : 1;
  }
  const report = buildParkedChangeReport(owner, repo);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}
function printHelp() {
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
parkedIssuesComplete }. Reads the live provider-health report first; when
EVERY service is healthy, parkedIssues is empty and complete by
construction, so this returns without any open-pull-request or
per-pull-request comment read. Mutually exclusive with --park.

--park: re-checks the named --service's LIVE provider-health verdict is
unavailable, and requires every --blockers entry (the caller's own fresh
pre-merge-readiness blocker-gate names) to map to that service. Any other
blocker, or an empty --blockers, refuses to park (exit 1, prints the
eligibility reason). Default is dry-run; --apply posts the park marker to
the pull request. This command performs no claim/state gating itself --
the calling phase runs its own claim-revalidation gate before --apply, and
releases the issue's claim afterward as a separate, already-existing
unclaim step (see post-idd-marker.mjs); this command never touches claim
state.

--owner/--repo default to the current repository (gh repo view).
`);
}
