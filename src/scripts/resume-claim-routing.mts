#!/usr/bin/env node
// idd-generated-from: src/scripts/resume-claim-routing.mts
//
// The scripts/resume-claim-routing.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import { isAuthorizedForcedHandoffActor } from './collaborator-permission.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';
import type {
  ParsedClaimMarker,
  ParsedForcedHandoffMarker,
} from './protocol-helpers.mts';
import {
  buildForcedHandoffEnableGate,
  DEFAULT_STALE_AGE_MS,
  findActivationNonceWinner,
  isStaleByAge,
  normalizeLinkedPrReference,
  parseClaimComment,
  resolveActiveClaim,
} from './protocol-helpers.mts';

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  body?: string | null;
  created_at?: string | null;
  user?: GhAuthorPayload | null;
}

/** Raw claim event accepted by `evaluateResumeClaimRouting`. */
interface RawClaimEventPayload {
  body?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  author?: { login?: unknown } | null;
  user?: { login?: unknown } | null;
}

/** Normalized trusted claim event consumed by the routing evaluator. */
interface NormalizedClaimEvent {
  body: string;
  createdAt: string;
  author: { login: string };
}

/** Comment event shape passed to forced-handoff callbacks. */
interface CommentEventLike {
  body?: string | null;
  createdAt?: string | null;
  author?: GhAuthorPayload | null;
}

/** Inputs accepted by {@link evaluateResumeClaimRouting}. */
interface ResumeClaimRoutingInput {
  events?: unknown;
  claimId?: unknown;
  /**
   * This session's own recorded activation nonce for `claimId`, checked
   * against the winner among trusted `activation-nonce` markers for that
   * same claim-id (see {@link findActivationNonceWinner}). Optional and
   * additive: omitting it (or having no posted nonce marker at all for the
   * claim-id) skips the comparison entirely, so a caller that never wires
   * this in observes byte-identical behavior to before #1522.
   */
  nonce?: unknown;
  staleAgeMs?: unknown;
  now?: unknown;
}

/** Callback options accepted by {@link evaluateResumeClaimRouting}. */
interface ResumeClaimRoutingOptions {
  isTrustedAuthor?: (login: string) => boolean;
  isForcedHandoffEnabled?: (
    forcedHandoff: ParsedForcedHandoffMarker,
    event: CommentEventLike,
  ) => boolean;
  isAuthorizedForcedHandoff?: (
    forcedBy: string,
    forcedHandoff: ParsedForcedHandoffMarker,
    event: CommentEventLike,
  ) => boolean;
}

/** Legacy (claim-id-less) claim marker parsed from an issue comment. */
interface LegacyClaimMarker {
  agentId: string;
  createdAt: string;
  branch: string;
}

/** Parsed CLI arguments. */
interface ResumeClaimRoutingArgs {
  issue: number | null;
  owner: string;
  repo: string;
  token: string;
  claimId: string;
  nonce: string;
  now: string;
  policy: string;
  staleAgeMs: number;
  trustedMarkerLogins: string;
  freshClaimGate: boolean;
  help: boolean;
}

const LEGACY_CLAIM_PATTERN =
  /^<!--\s*claimed-by:\s+(\S+)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+branch:\s+([^\s>]+)\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i;
const LEGACY_RELEASE_PATTERN =
  /^<!--\s*unclaimed-by:\s+(\S+)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i;

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `issue:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --issue spec key
// below. See cli-args.mts's module header for the full invariant.
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires.
const RESUME_CLAIM_ROUTING_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--token': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--nonce': { type: 'string' },
  '--now': { type: 'string' },
  '--policy': { type: 'string' },
  '--stale-age-ms': { type: 'string' },
  '--trusted-marker-logins': { type: 'string' },
  '--fresh-claim-gate': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  runCli();
}

/**
 * Build the `isForcedHandoffEnabled` gate used by the resume CLI.
 *
 * Mirrors `summarizeClaimValidation`'s gate so a forced handoff that
 * displaces a **PR-backed** claim is honored only with `issue-plus-pr`
 * evidence naming that PR:
 *
 * - forced-handoff mode disabled → never honor;
 * - no open linked PR backs the claim (`expectedLinkedPrReferences`
 *   empty, including the fail-safe lookup-error case) → honor an
 *   `issue-only` handoff as before;
 * - an open linked PR backs the claim → require `contextScope` of
 *   `issue-plus-pr` whose `linkedPr` matches one of the expected PRs.
 */
export function buildForcedHandoffEnabledGate(options: {
  forcedHandoffEnabled: boolean;
  expectedLinkedPrReferences: Set<string>;
}): (forcedHandoff: ParsedForcedHandoffMarker) => boolean {
  // Delegate to the shared builder so resume routing and the merge-gate /
  // write-side helpers cannot drift. Resume routing never passes
  // `prFirstCommitAt`, so this stays byte-identical to the prior behavior:
  // an issue-only handoff against a PR-backed claim is rejected.
  return buildForcedHandoffEnableGate({
    forcedHandoffEnabled: options.forcedHandoffEnabled,
    expectedLinkedPrReferences: options.expectedLinkedPrReferences,
  });
}

export function evaluateResumeClaimRouting(
  input: ResumeClaimRoutingInput,
  options: ResumeClaimRoutingOptions = {},
) {
  const nowIso =
    normalizeIso(input.now) ?? normalizeIso(new Date().toISOString()) ?? '';
  const staleAgeMs = normalizeStaleAgeMs(input.staleAgeMs);
  const trustedAuthor =
    typeof options.isTrustedAuthor === 'function'
      ? options.isTrustedAuthor
      : () => true;
  const isForcedHandoffEnabled =
    typeof options.isForcedHandoffEnabled === 'function'
      ? options.isForcedHandoffEnabled
      : () => false;
  const isAuthorizedForcedHandoff =
    typeof options.isAuthorizedForcedHandoff === 'function'
      ? options.isAuthorizedForcedHandoff
      : () => false;

  const events = normalizeEvents(input.events).filter((event) =>
    trustedAuthor(event.author?.login ?? ''),
  );
  const state = resolveClaimState(events, nowIso, staleAgeMs, {
    isForcedHandoffEnabled,
    isAuthorizedForcedHandoff,
  });
  const claimIdChecked = normalizeToken(input.claimId);
  const sameSecondContenders = state.activeClaim
    ? findSameSecondContenders(events, state.activeClaim)
    : [];
  const laterCompetingClaim = state.activeClaim
    ? findLaterCompetingClaim(events, state.activeClaim)
    : null;
  const activationNonceWinner = state.activeClaim
    ? findActivationNonceWinner(events, state.activeClaim.claimId)
    : null;
  const nonceChecked = normalizeToken(input.nonce);

  const warnings = [...state.warnings];
  let routeState = 'unclaimed';
  let action = 're_claim';
  let reason = 'no-active-claim';

  if (state.mode === 'legacy-only') {
    if (!state.legacyClaim) {
      routeState = 'unclaimed';
      action = 're_claim';
      reason = 'legacy-absent';
    } else if (state.legacyReleased) {
      routeState = 'unclaimed';
      action = 're_claim';
      reason = 'legacy-released';
    } else if (isStaleByAge(state.legacyClaim.createdAt, nowIso, staleAgeMs)) {
      routeState = 'stale';
      action = 'takeover';
      reason = 'legacy-claim-stale';
    } else {
      routeState = 'non_inheritable';
      action = 'stop';
      reason = 'legacy-claim-non-stale';
    }
  } else if (!state.activeClaim) {
    routeState = 'unclaimed';
    action = 're_claim';
    reason = 'no-active-claim';
  } else if (laterCompetingClaim) {
    routeState = 'disputed';
    action = 'stop';
    reason = 'later-competing-claim';
  } else if (claimIdChecked && claimIdChecked === state.activeClaim.claimId) {
    // The claim-id matches, but claim-id alone cannot distinguish a second,
    // independent activation of the same id (the sticky forced-handoff
    // adopt-verbatim collision #1522 exists to catch) -- so when both a
    // local nonce and a trusted activation-nonce winner are available,
    // require them to agree too. Either side being absent (no nonce posted
    // yet, or this caller never opted in) skips the comparison and keeps
    // the claim-id-only outcome, matching pre-#1522 behavior exactly.
    if (
      activationNonceWinner !== null &&
      nonceChecked &&
      activationNonceWinner !== nonceChecked
    ) {
      routeState = 'disputed';
      action = 'stop';
      reason = 'activation-nonce-mismatch';
    } else {
      routeState = 'already_owned';
      action = 'keep';
      reason = 'claim-id-match';
    }
  } else if (claimIdChecked && sameSecondContenders.includes(claimIdChecked)) {
    routeState = 'disputed';
    action = 'stop';
    reason = 'same-second-claim-tie-break-loss';
  } else if (isStaleByAge(state.activeClaim.createdAt, nowIso, staleAgeMs)) {
    routeState = 'stale';
    action = 'takeover';
    reason = 'active-claim-stale';
  } else {
    routeState = 'non_inheritable';
    action = 'stop';
    reason = 'active-claim-non-stale';
  }

  return {
    state: routeState,
    action,
    reason,
    claim_id_checked: claimIdChecked || null,
    active_claim:
      routeState === 'unclaimed'
        ? null
        : state.activeClaim
          ? {
              agent_id: state.activeClaim.agentId,
              claim_id: state.activeClaim.claimId,
              created_at: state.activeClaim.createdAt,
              branch: state.activeClaim.branch,
            }
          : state.legacyClaim
            ? {
                agent_id: state.legacyClaim.agentId,
                claim_id: null,
                created_at: state.legacyClaim.createdAt,
                branch: state.legacyClaim.branch,
              }
            : null,
    stale_age_ms: staleAgeMs,
    now: nowIso,
    warnings,
    evidence: {
      trusted_event_count: events.length,
      new_format_claim_seen: state.mode === 'new-format',
      legacy_claim_seen: state.mode === 'legacy-only',
      same_second_contenders: sameSecondContenders,
      later_competing_claim: laterCompetingClaim,
      activation_nonce_winner: activationNonceWinner,
    },
  };
}

/** Verdict vocabulary for the fresh-claim (A5) claimability gate. */
export type FreshClaimVerdict =
  | 'claimable'
  | 'already-claimed'
  | 'stale-reclaimable';

/** Result of {@link evaluateFreshClaimGate}. */
export interface FreshClaimGateResult {
  verdict: FreshClaimVerdict;
  winningClaimId: string | null;
  reason: string;
}

/**
 * Mechanical fresh-claim (A5) claimability gate.
 *
 * It reuses the shared `evaluateResumeClaimRouting` resolver (which itself
 * builds on `resolveActiveClaim`) over a fresh marker fetch and maps the
 * routing state to the fresh-claim vocabulary, so the write-side path never
 * forks claim-state logic:
 *
 * - `unclaimed` → `claimable`
 * - `stale` → `stale-reclaimable`
 * - `non_inheritable` / `disputed` (a live competitor) → `already-claimed`
 *
 * A fresh claim owns no prior claim-id, so any `claimId` on `input` is ignored
 * (the resolver's already-owned / same-second-loss branches need a checked id
 * and would otherwise mask pure contention). `winningClaimId` is the active
 * claim's `{claim-id}`, or `null` when there is no active claim or the active
 * claim is a legacy (claim-id-less) marker. GitHub issue comments have no
 * compare-and-swap, so this **narrows** the A5(c) TOCTOU window rather than
 * closing it; the 24 h stale-takeover and same-second tie-break remain the
 * race-recovery backstop.
 */
export function evaluateFreshClaimGate(
  input: ResumeClaimRoutingInput,
  options: ResumeClaimRoutingOptions = {},
): FreshClaimGateResult {
  const routing = evaluateResumeClaimRouting(
    { ...input, claimId: undefined },
    options,
  );
  const verdict: FreshClaimVerdict =
    routing.state === 'unclaimed'
      ? 'claimable'
      : routing.state === 'stale'
        ? 'stale-reclaimable'
        : 'already-claimed';
  return {
    verdict,
    winningClaimId: routing.active_claim?.claim_id ?? null,
    reason: routing.reason,
  };
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isInteger(args.issue) || (args.issue ?? 0) <= 0) {
    throw new Error('--issue is required and must be a positive integer');
  }
  if (args.token) {
    process.env.GH_TOKEN = args.token;
    process.env.GITHUB_TOKEN = args.token;
  }

  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repository = `${owner}/${repo}`;
  const policy = loadPolicy(args.policy, { strict: Boolean(args.policy) });
  const staleAgeMs = args.staleAgeMs > 0 ? args.staleAgeMs : policy.staleAgeMs;
  const trustedLogins = resolveTrustedLogins({
    fromArgs: args.trustedMarkerLogins,
    fromPolicy: policy.trustedMarkerActors,
    currentLogin: ghText(
      ['api', 'user', '--jq', '.login'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    ),
  });
  const trustedSet = new Set(trustedLogins.map((login) => login.toLowerCase()));
  const comments = fetchIssueComments(repository, args.issue);
  const issue = ghJson(['api', `repos/${repository}/issues/${args.issue}`]) as {
    number?: unknown;
    title?: unknown;
    state?: unknown;
    html_url?: unknown;
    url?: unknown;
  };
  const forcedHandoffEnabled = policy.forcedHandoff.mode === 'human-gated';
  const forcedHandoffAuthorityPolicy = policy.forcedHandoff.authorityPolicy;
  const permissionCache: CollaboratorPermissionCache = new Map();
  // A forced handoff that displaces a PR-backed claim must carry
  // issue-plus-pr evidence naming that PR; detect the open linked PR(s)
  // so the gate below can enforce it (fail-safe to no enforcement). Skip
  // the lookup entirely when forced-handoff mode is off — the gate never
  // honors a handoff then, so the PR context would go unused.
  const expectedLinkedPrReferences = forcedHandoffEnabled
    ? fetchOpenLinkedPrReferences(repository, args.issue)
    : new Set<string>();

  const routingEvents = comments.map((comment) => ({
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  }));
  const routingOptions = {
    isTrustedAuthor: (login: string) =>
      trustedSet.has(
        String(login ?? '')
          .trim()
          .toLowerCase(),
      ),
    isForcedHandoffEnabled: buildForcedHandoffEnabledGate({
      forcedHandoffEnabled,
      expectedLinkedPrReferences,
    }),
    isAuthorizedForcedHandoff: (forcedBy: string) =>
      isAuthorizedForcedHandoffActor(
        owner,
        repo,
        forcedBy,
        forcedHandoffAuthorityPolicy,
        permissionCache,
      ),
  };
  const result = evaluateResumeClaimRouting(
    {
      events: routingEvents,
      claimId: args.claimId,
      nonce: args.nonce || undefined,
      staleAgeMs,
      now: args.now || undefined,
    },
    routingOptions,
  );

  // The fresh-claim (A5) gate re-uses the same resolver over the same markers
  // but ignores any --claim-id (a fresh claim owns none yet), mapping the
  // routing state to the write-side claimability vocabulary.
  const freshClaimGate = args.freshClaimGate
    ? evaluateFreshClaimGate(
        { events: routingEvents, staleAgeMs, now: args.now || undefined },
        routingOptions,
      )
    : null;

  const output = {
    repository: { owner, repo },
    issue: {
      number: Number.parseInt(String(issue.number), 10),
      title: String(issue.title ?? ''),
      state: String(issue.state ?? ''),
      url: String(issue.html_url ?? issue.url ?? ''),
    },
    policy: {
      source: policy.source,
      stale_age_ms: staleAgeMs,
      trusted_marker_logins: trustedLogins,
      forced_handoff_mode: policy.forcedHandoff.mode,
      forced_handoff_authority_policy: forcedHandoffAuthorityPolicy,
    },
    ...result,
    ...(freshClaimGate
      ? {
          fresh_claim_gate: {
            verdict: freshClaimGate.verdict,
            winning_claim_id: freshClaimGate.winningClaimId,
          },
        }
      : {}),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function resolveClaimState(
  events: NormalizedClaimEvent[],
  nowIso: string,
  staleAgeMs: number,
  options: {
    isForcedHandoffEnabled?: (
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentEventLike,
    ) => boolean;
    isAuthorizedForcedHandoff?: (
      forcedBy: string,
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentEventLike,
    ) => boolean;
  } = {},
) {
  const isForcedHandoffEnabled =
    typeof options.isForcedHandoffEnabled === 'function'
      ? options.isForcedHandoffEnabled
      : () => false;
  const isAuthorizedForcedHandoff =
    typeof options.isAuthorizedForcedHandoff === 'function'
      ? options.isAuthorizedForcedHandoff
      : () => false;

  // hasNewFormatClaim drives the new-format vs legacy-only mode. Detect
  // it by scanning before delegating to the canonical parser so the
  // wrapper can return the right legacy-fallback shape.
  const hasNewFormatClaim = events.some(
    (event) =>
      parseClaimComment(event.body ?? '', event.createdAt ?? '') !== null,
  );

  const warnings: string[] = [];
  const onAnomalousHeartbeat = ({
    claimId,
    activeBranch,
    heartbeatBranch,
  }: {
    claimId: string;
    activeBranch: string;
    heartbeatBranch: string;
  }) => {
    warnings.push(
      `ignored anomalous heartbeat for ${claimId}: branch ${heartbeatBranch} != ${activeBranch}`,
    );
  };
  const onIgnoredForcedHandoff = ({
    reason,
    forcedHandoff,
    event,
  }: {
    reason: string;
    forcedHandoff: ParsedForcedHandoffMarker;
    event: CommentEventLike;
  }) => {
    if (reason === 'mode-disabled') {
      warnings.push(
        `ignored forced-handoff for ${forcedHandoff.oldClaimId}: forced-handoff mode is not enabled`,
      );
      return;
    }
    if (reason === 'author-forced-by-mismatch') {
      warnings.push(
        `ignored forced-handoff for ${forcedHandoff.oldClaimId}: comment author ${event.author?.login ?? '(unknown)'} does not match forcedBy ${forcedHandoff.forcedBy}`,
      );
      return;
    }
    if (reason === 'forced-by-unauthorized') {
      warnings.push(
        `ignored forced-handoff for ${forcedHandoff.oldClaimId}: forcedBy ${forcedHandoff.forcedBy} is not an authorized maintainer`,
      );
    }
  };

  const activeClaim = hasNewFormatClaim
    ? resolveActiveClaim(events, {
        isTrustedAuthor: () => true, // events were already filtered by caller
        isForcedHandoffEnabled,
        isAuthorizedForcedHandoff,
        isStale: (activeCreatedAt, nextCreatedAt) =>
          isStaleByAge(activeCreatedAt, nextCreatedAt, staleAgeMs),
        // Resume routing enforces the rule-7 author/forcedBy binding to
        // block the same-identity self-signed hijack path — the strict half
        // of the strict-resume vs. lenient-relay-merge split (see
        // docs/idd-design-rationale.md, "Claim resolution"). The merge-side
        // summarizeClaimValidation path leaves it off because it may receive a
        // maintainer-authorized handoff relayed by a separate automation actor,
        // so the two callers can return different verdicts for the same
        // corrected-handoff state (resume `already_owned` vs. merge
        // `claimLost`) by design.
        requireAuthorMatchesForcedBy: true,
        onAnomalousHeartbeat,
        onIgnoredForcedHandoff,
      })
    : null;

  if (hasNewFormatClaim) {
    return {
      mode: 'new-format',
      activeClaim,
      warnings,
      legacyClaim: null,
      legacyReleased: false,
    };
  }

  const orderedEvents = [...events].sort(compareEvents);
  const legacy = resolveLegacyClaimState(orderedEvents, nowIso, staleAgeMs);
  return {
    mode: 'legacy-only',
    activeClaim: null,
    warnings,
    legacyClaim: legacy.claim,
    legacyReleased: legacy.released,
  };
}

function resolveLegacyClaimState(
  orderedEvents: NormalizedClaimEvent[],
  _nowIso?: string,
  _staleAgeMs?: number,
) {
  let latestClaim: LegacyClaimMarker | null = null;
  let latestMatchingRelease: { agentId: string; createdAt: string } | null =
    null;
  for (const event of orderedEvents) {
    const claim = parseLegacyClaimComment(event.body, event.createdAt);
    if (claim) {
      latestClaim = claim;
      latestMatchingRelease = null;
      continue;
    }
    const release = parseLegacyReleaseComment(event.body, event.createdAt);
    if (
      release &&
      latestClaim &&
      release.agentId === latestClaim.agentId &&
      compareIso(release.createdAt, latestClaim.createdAt) > 0
    ) {
      latestMatchingRelease = release;
    }
  }
  if (!latestClaim) {
    return { claim: null, released: false };
  }
  const released = Boolean(latestMatchingRelease);
  return { claim: latestClaim, released };
}

function findSameSecondContenders(
  events: NormalizedClaimEvent[],
  activeClaim: ParsedClaimMarker,
): string[] {
  const activeSecond = toSecond(activeClaim.createdAt);
  if (activeSecond === null) {
    return [];
  }
  return events
    .map((event) => parseClaimComment(event.body, event.createdAt))
    .filter((claim): claim is ParsedClaimMarker => Boolean(claim))
    .filter((claim) => toSecond(claim.createdAt) === activeSecond)
    .map((claim) => claim.claimId)
    .filter((claimId) => claimId !== activeClaim.claimId)
    .sort();
}

function findLaterCompetingClaim(
  events: NormalizedClaimEvent[],
  activeClaim: ParsedClaimMarker,
) {
  // Baseline on the active claim's ORIGINAL event time, not
  // activeClaim.createdAt: applyClaimEvent refreshes the latter to the most
  // recent heartbeat, which would hide a competing claim posted between the
  // original claim and that heartbeat. Take the earliest matching claim
  // event by timestamp rather than array position, since `events` is not
  // guaranteed to be sorted oldest-first.
  const originalCreatedAt = events
    .map((event) => parseClaimComment(event.body, event.createdAt))
    .filter(
      (claim): claim is ParsedClaimMarker =>
        Boolean(claim) && claim?.claimId === activeClaim.claimId,
    )
    .reduce<string | null>(
      (earliest, claim) =>
        earliest === null || compareIso(claim.createdAt, earliest) < 0
          ? claim.createdAt
          : earliest,
      null,
    );
  const activeSecond = toSecond(originalCreatedAt ?? activeClaim.createdAt);
  if (activeSecond === null) {
    return null;
  }
  const contenders = events
    .map((event) => parseClaimComment(event.body, event.createdAt))
    .filter((claim): claim is ParsedClaimMarker => Boolean(claim))
    .filter((claim) => claim.claimId !== activeClaim.claimId)
    .filter((claim) => {
      const claimSecond = toSecond(claim.createdAt);
      return claimSecond !== null && claimSecond > activeSecond;
    })
    .sort((left, right) => compareIso(left.createdAt, right.createdAt));
  if (contenders.length === 0) {
    return null;
  }
  return {
    claim_id: contenders[0].claimId,
    created_at: contenders[0].createdAt,
  };
}

// `findActivationNonceWinner` moved to marker-helpers.mts (#1528) so the
// F2/F3 merge-time write-gate (`summarizeClaimValidation` in
// protocol-helpers.mts) can share the identical primitive instead of
// forking its own copy. Imported above from './protocol-helpers.mts'.

function parseLegacyClaimComment(
  body: string,
  createdAt: string,
): LegacyClaimMarker | null {
  const match = String(body ?? '')
    .trimEnd()
    .match(LEGACY_CLAIM_PATTERN);
  if (!match) {
    return null;
  }
  return {
    agentId: match[1],
    createdAt: normalizeIso(match[2]) ?? normalizeIso(createdAt) ?? createdAt,
    branch: match[3],
  };
}

function parseLegacyReleaseComment(
  body: string,
  createdAt: string,
): { agentId: string; createdAt: string } | null {
  const match = String(body ?? '')
    .trimEnd()
    .match(LEGACY_RELEASE_PATTERN);
  if (!match) {
    return null;
  }
  return {
    agentId: match[1],
    createdAt: normalizeIso(match[2]) ?? normalizeIso(createdAt) ?? createdAt,
  };
}

function normalizeEvents(events: unknown): NormalizedClaimEvent[] {
  if (!Array.isArray(events)) {
    return [];
  }
  return (events as RawClaimEventPayload[])
    .map((event) => ({
      body: String(event?.body ?? ''),
      createdAt: normalizeIso(event?.createdAt ?? event?.created_at),
      author: {
        login: String(event?.author?.login ?? event?.user?.login ?? ''),
      },
    }))
    .filter((event): event is NormalizedClaimEvent => event.createdAt !== null);
}

function compareEvents(
  left: NormalizedClaimEvent,
  right: NormalizedClaimEvent,
): number {
  const leftSecond = toSecond(left.createdAt);
  const rightSecond = toSecond(right.createdAt);
  if (
    leftSecond !== null &&
    rightSecond !== null &&
    leftSecond !== rightSecond
  ) {
    return leftSecond - rightSecond;
  }
  if (leftSecond !== null && rightSecond === null) {
    return -1;
  }
  if (leftSecond === null && rightSecond !== null) {
    return 1;
  }

  const leftClaim = parseClaimComment(left.body, left.createdAt);
  const rightClaim = parseClaimComment(right.body, right.createdAt);
  if (leftClaim && rightClaim && leftClaim.claimId !== rightClaim.claimId) {
    return leftClaim.claimId < rightClaim.claimId ? -1 : 1;
  }
  return compareIso(left.createdAt, right.createdAt);
}

function parseArgs(argv: string[]): ResumeClaimRoutingArgs {
  const { values, help } = parseCliArgs(argv, RESUME_CLAIM_ROUTING_FLAG_SPEC);
  const issueToken = values.issue as string | undefined;
  const staleAgeMsToken = values['stale-age-ms'] as string | undefined;
  return {
    // Both --issue and --stale-age-ms are kept as lenient Number.parseInt
    // (not the canonical-integer helper), matching the pre-migration
    // contract exactly: --issue is re-validated by this file's own
    // "!Number.isInteger(args.issue) || (args.issue ?? 0) <= 0" post-check
    // (in runCli, unchanged), and --stale-age-ms already flows through
    // normalizeStaleAgeMs()'s own fail-safe (falls back to
    // DEFAULT_STALE_AGE_MS on any non-finite / non-positive value) --
    // tightening either at this layer would be an untested, out-of-scope
    // behavior change for this behavior-preserving migration (see #1451).
    issue: issueToken === undefined ? null : Number.parseInt(issueToken, 10),
    owner: (values.owner as string | undefined) ?? '',
    repo: (values.repo as string | undefined) ?? '',
    token: (values.token as string | undefined) ?? '',
    claimId: (values['claim-id'] as string | undefined) ?? '',
    nonce: (values.nonce as string | undefined) ?? '',
    now: (values.now as string | undefined) ?? '',
    policy: (values.policy as string | undefined) ?? '',
    staleAgeMs:
      staleAgeMsToken === undefined ? 0 : Number.parseInt(staleAgeMsToken, 10),
    trustedMarkerLogins:
      (values['trusted-marker-logins'] as string | undefined) ?? '',
    freshClaimGate: values['fresh-claim-gate'] as boolean,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/resume-claim-routing.mjs --issue <number> [--owner <owner>] [--repo <repo>] [--token <token>] [--claim-id <token>] [--nonce <token>] [--now <ISO8601>] [--policy <path>] [--stale-age-ms <ms>] [--trusted-marker-logins "<a,b,...>"] [--fresh-claim-gate]

  --fresh-claim-gate  emit the write-side A5(c) claimability verdict for the
                      issue from current marker state, ignoring --claim-id (a
                      fresh claim owns none yet). Run it on a fresh fetch
                      immediately before the claim write; it re-uses the same
                      resolver so claim-state logic never forks.
  --nonce <token>     this session's own recorded activation-nonce (#1522):
                      when --claim-id matches the active claim, also require
                      it to equal the winning trusted <!-- activation-nonce:
                      --> marker for that claim-id (lexicographically
                      earliest nonce among however many were posted). A
                      mismatch means a second, independent session activated
                      the identical claim-id -- routes to "disputed" the same
                      as a later-competing-claim loss. Omit --nonce, or leave
                      the claim-id's nonce not posted, to skip the comparison
                      (unchanged pre-#1522 behavior).

Output (selected fields; the JSON also carries repository / issue / policy /
warnings / evidence):
{
  "state": "unclaimed|already_owned|stale|non_inheritable|disputed",
  "action": "re_claim|takeover|keep|stop",
  "reason": "...",
  "active_claim": {"agent_id":"...","claim_id":"...","created_at":"...","branch":"..."} | null,
  "evidence": {"...": "...", "activation_nonce_winner": "..."|null},
  "fresh_claim_gate": {"verdict":"claimable|already-claimed|stale-reclaimable","winning_claim_id":"..."|null}  // only with --fresh-claim-gate
}
`);
}

function fetchIssueComments(
  repository: string,
  issueNumber: number | null,
): IssueCommentPayload[] {
  const comments: IssueCommentPayload[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const pageItems = ghJson([
      'api',
      `repos/${repository}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${page}`,
    ]) as IssueCommentPayload[];
    comments.push(...pageItems);
    if (pageItems.length < pageSize) {
      break;
    }
  }
  return comments;
}

function loadPolicy(
  policyPath: string,
  { strict = false }: { strict?: boolean } = {},
) {
  const source = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), '.github/idd/config.json');
  try {
    const config = JSON.parse(readFileSync(source, 'utf8')) as {
      claimTiming?: { staleAge?: unknown } | null;
      trustedMarkerActors?: unknown;
    } | null;
    const normalized = normalizePolicyConfig(config);
    return {
      source,
      staleAgeMs:
        parseDurationToMs(config?.claimTiming?.staleAge) ??
        DEFAULT_STALE_AGE_MS,
      trustedMarkerActors: Array.isArray(config?.trustedMarkerActors)
        ? (config.trustedMarkerActors as unknown[])
            .map((value) => String(value ?? '').trim())
            .filter(Boolean)
        : [],
      forcedHandoff: {
        mode: normalized.forcedHandoff.mode,
        authorityPolicy: normalized.forcedHandoff.authorityPolicy,
      },
    };
  } catch (error) {
    if (strict) {
      throw new Error(
        `failed to load policy from ${source}: ${String((error as { message?: unknown } | null)?.message ?? error)}`,
      );
    }
    const normalized = normalizePolicyConfig({});
    return {
      source,
      staleAgeMs: DEFAULT_STALE_AGE_MS,
      trustedMarkerActors: [],
      forcedHandoff: {
        mode: normalized.forcedHandoff.mode,
        authorityPolicy: normalized.forcedHandoff.authorityPolicy,
      },
    };
  }
}

function parseDurationToMs(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
    text,
  );
  if (!match) {
    return null;
  }
  const days = Number.parseInt(match[1] ?? '0', 10);
  const hours = Number.parseInt(match[2] ?? '0', 10);
  const minutes = Number.parseInt(match[3] ?? '0', 10);
  const seconds = Number.parseInt(match[4] ?? '0', 10);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function resolveTrustedLogins({
  fromArgs,
  fromPolicy,
  currentLogin,
}: {
  fromArgs?: unknown;
  fromPolicy?: string[] | null;
  currentLogin?: unknown;
}): string[] {
  const fromCsv = String(fromArgs ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const merged = [
    ...fromCsv,
    ...(fromPolicy ?? []),
    String(currentLogin ?? '').trim(),
  ]
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  return [...new Set(merged)];
}

function normalizeStaleAgeMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_STALE_AGE_MS;
  }
  return Math.floor(value);
}

function normalizeIso(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function compareIso(left: string, right: string): number {
  const leftTime = Date.parse(String(left ?? ''));
  const rightTime = Date.parse(String(right ?? ''));
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return 0;
  }
  return leftTime - rightTime;
}

function toSecond(iso: string | null | undefined): number | null {
  const milliseconds = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  return Math.floor(milliseconds / 1000);
}

function normalizeToken(value: unknown): string {
  const token = String(value ?? '').trim();
  return token.length > 0 ? token : '';
}

/**
 * Resolve the set of open pull requests that back this issue's claim, as
 * normalized PR references. Uses a precise signal — a PR connected to the
 * issue via `CONNECTED_EVENT` (reconciled against later
 * `DISCONNECTED_EVENT`s) that is currently `OPEN` — rather than a bare
 * cross-reference/mention, so an unrelated open PR merely mentioning the
 * issue does not falsely block a legitimate `issue-only` forced handoff.
 * Fails safe to an empty set (no enforcement) on any lookup error.
 */
function fetchOpenLinkedPrReferences(
  repository: string,
  issueNumber: number | null,
): Set<string> {
  const references = new Set<string>();
  const [owner, repo] = repository.split('/');
  if (!owner || !repo || !Number.isInteger(issueNumber)) {
    return references;
  }
  const query =
    'query($owner:String!,$repo:String!,$number:Int!){' +
    'repository(owner:$owner,name:$repo){issue(number:$number){' +
    // `last` so the most recent connect/disconnect events win: an issue
    // with many such events must not have newer DISCONNECTED_EVENTs missed.
    'timelineItems(last:100,itemTypes:[CONNECTED_EVENT,DISCONNECTED_EVENT])' +
    '{nodes{__typename ' +
    '... on ConnectedEvent{subject{__typename ... on PullRequest{number state}}} ' +
    '... on DisconnectedEvent{subject{__typename ... on PullRequest{number}}}' +
    '}}}}}';
  let data: unknown;
  try {
    data = ghJson([
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      '-F',
      `number=${issueNumber}`,
    ]);
  } catch {
    return references;
  }
  const nodes = (
    data as {
      data?: {
        repository?: { issue?: { timelineItems?: { nodes?: unknown } } };
      };
    } | null
  )?.data?.repository?.issue?.timelineItems?.nodes;
  if (!Array.isArray(nodes)) {
    return references;
  }
  // The last connect/disconnect event per PR wins (timeline is chronological).
  const connected = new Map<number, boolean>();
  const states = new Map<number, string>();
  for (const node of nodes) {
    const record = node as {
      __typename?: unknown;
      subject?: { __typename?: unknown; number?: unknown; state?: unknown };
    } | null;
    const subject = record?.subject;
    if (subject?.__typename !== 'PullRequest') {
      continue;
    }
    const number =
      typeof subject.number === 'number' ? subject.number : Number.NaN;
    if (!Number.isInteger(number)) {
      continue;
    }
    if (record?.__typename === 'ConnectedEvent') {
      connected.set(number, true);
      states.set(number, String(subject.state ?? ''));
    } else if (record?.__typename === 'DisconnectedEvent') {
      connected.set(number, false);
    }
  }
  for (const [number, isConnected] of connected) {
    if (isConnected && states.get(number) === 'OPEN') {
      references.add(normalizeLinkedPrReference(number));
    }
  }
  return references;
}

function ghJson(args: string[]): unknown {
  return JSON.parse(runGh(args).trim() || '[]');
}

function runGh(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(
      (error as { stderr?: unknown } | null)?.stderr ?? '',
    ).trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}
