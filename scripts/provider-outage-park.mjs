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
import { loadIddConfig } from './idd-config.mjs';
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
 * Collect every open pull request's latest trusted park marker, bounded to
 * the `sampleSize` most-recently-updated open pull requests (default `50`,
 * same default `provider-health.mts` uses) so a repository with many open
 * pull requests never produces an unbounded fan-out of per-pull-request
 * comment reads. `sampleTruncated` is true when the live open-PR count may
 * exceed `sampleSize` (the fetched page came back full) -- an older parked
 * pull request outside this sample would otherwise silently understate
 * `count`/`boundReached` (Codex/CodeRabbit review, PR #2421); the caller
 * must treat that case as bound-reached rather than trust an undercount.
 */
function collectRawParkMarkers(owner, repo, options) {
  const sampleSize = options.sampleSize ?? 50;
  let openPrs;
  try {
    const payload = ghApiJson(
      `repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${sampleSize}`,
    );
    if (!Array.isArray(payload)) {
      throw new Error('malformed open pull request list response');
    }
    openPrs = payload;
  } catch (error) {
    throw new Error(
      `could not read open pull requests to list parked changes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rawMarkers = [];
  for (const pr of openPrs) {
    if (typeof pr.number !== 'number') continue;
    let comments;
    try {
      const payload = ghApiJson(
        `repos/${owner}/${repo}/issues/${pr.number}/comments`,
        {
          paginate: true,
        },
      );
      if (!Array.isArray(payload)) continue;
      comments = payload;
    } catch {
      // A per-pull-request comment read failure skips that pull request
      // only -- the fetchable pull requests still yield a real (if
      // incomplete) list, matching provider-health.mts's own per-item
      // read-failure posture.
      continue;
    }
    const marker = latestTrustedParkMarker(
      comments,
      options.trustedMarkerLogins,
    );
    if (marker !== null) {
      rawMarkers.push({ prNumber: pr.number, marker });
    }
  }
  return { rawMarkers, sampleTruncated: openPrs.length >= sampleSize };
}
/**
 * Read-only list mode (#2321): every open pull request carrying a trusted
 * park marker, each annotated with its parked service's CURRENT live
 * `provider-health` verdict. `count`/`boundReached` against the configured
 * `providerOutage.maxParkedChanges` are information only -- this function
 * enforces nothing; the bound stops new issue CLAIMS (an instruction-level
 * rule), never the parking of an already-stuck pull request. When the open
 * pull request read is truncated (more may exist beyond `sampleSize`),
 * `boundReached` fails closed to `true` regardless of the sampled `count` --
 * an undercounted bound must never read as "still under the limit".
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
  const { rawMarkers, sampleTruncated } = collectRawParkMarkers(owner, repo, {
    sampleSize: options.sampleSize,
    trustedMarkerLogins,
  });
  const distinctServices = [
    ...new Set(rawMarkers.map((r) => r.marker.service)),
  ];
  const verdictsByService = new Map();
  if (distinctServices.length > 0) {
    const report = buildProviderHealthReport(owner, repo, { config, now });
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
    throw new Error(
      `unsupported --service value: ${options.service} (expected one of ${PROVIDER_HEALTH_SERVICES.join(', ')})`,
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
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return Number(raw);
}
if (import.meta.main) {
  main();
}
function main() {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    PROVIDER_OUTAGE_PARK_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const owner =
    values.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    values.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  if (values.park) {
    const prNumber = parsePositiveIntegerFlag(values.pr, '--pr');
    const issueNumber = parsePositiveIntegerFlag(values.issue, '--issue');
    const service = values.service.trim();
    const agentId = values['agent-id'].trim();
    const claimId = values['claim-id'].trim();
    if (!service) throw new Error('missing required --service <name> argument');
    if (!agentId) throw new Error('missing required --agent-id <id> argument');
    if (!claimId) throw new Error('missing required --claim-id <id> argument');
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
    process.exitCode = result.eligible ? 0 : 1;
    return;
  }
  const report = buildParkedChangeReport(owner, repo);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/provider-outage-park.mjs [--owner <owner>] [--repo <repo>]
  node scripts/provider-outage-park.mjs --park --pr <n> --issue <n> \\
    --service <advisory-review|ci-actions> --blockers <gate1,gate2> \\
    --agent-id <id> --claim-id <id> [--apply]

Default (no --park): read-only list mode. Reports every open pull request
carrying a trusted idd-provider-outage-park marker, each with its parked
service's current provider-health verdict and resumable (true only once
that verdict is healthy). Sorted by parkedAt then pull request number.
Also reports count and boundReached against providerOutage.maxParkedChanges
(default 10) as information only -- this mode enforces nothing.

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
