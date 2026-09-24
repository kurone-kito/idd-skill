#!/usr/bin/env node
// idd-generated-from: src/scripts/resume-claim-routing.mts
//
// The scripts/resume-claim-routing.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import { isAuthorizedForcedHandoffActor } from './collaborator-permission.mts';
import {
  isCurrentSessionWorktreeOwner,
  resolveCurrentSessionClaimEvidence,
} from './discover-roadmap-graph.mts';
import { loadPolicyConfig } from './idd-config.mts';
import {
  inspectLocalWorktreeBranch,
  type LocalWorktreeInspection,
} from './local-worktree-occupancy.mts';
import {
  listActivationNonces,
  parseLegacyClaimComment,
  resolveLegacyClaimState,
} from './marker-helpers.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';
import type {
  ParsedClaimMarker,
  ParsedForcedHandoffMarker,
} from './protocol-helpers.mts';
import {
  buildForcedHandoffEnableGate,
  DEFAULT_STALE_AGE_MS,
  isStaleByAge,
  normalizeLinkedPrReference,
  normalizeTrustedMarkerLogins,
  orderClaimEvents,
  parseClaimComment,
  parseReleaseComment,
  readClaimStaleAgeMs,
  resolveActiveClaimWithForcedHandoffTrace,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type { ProviderPort } from './provider-port.mts';

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
  /** Read same-clone worktree occupancy before a stale takeover. */
  inspectLocalWorktree?: (branchName: string) => LocalWorktreeInspection;
  /** Independently prove the active claim belongs to this session. */
  isCurrentSessionOwner?: (claim: ParsedClaimMarker) => boolean;
  /**
   * #3276: true when the caller's linked-PR lookup for this issue itself
   * failed (PR state unknown), as opposed to succeeding with no connected
   * PR. Only ever `true` when forced-handoff mode is enabled (the lookup
   * only runs then), which lets {@link resolveClaimState}'s
   * `onIgnoredForcedHandoff` handler distinguish this case from a genuinely
   * disabled forced-handoff mode without a separate flag. When set, a
   * trusted `issue-only` forced-handoff marker targeting the active claim
   * is never honored (the gate the caller builds, e.g. via
   * {@link buildForcedHandoffEnabledGate}, is expected to already encode
   * that rejection), and {@link evaluateResumeClaimRouting} additionally
   * routes a `--claim-id` check for either side of that blocked handoff to
   * an explicit `stop` instead of an ordinary claim-state outcome -- see
   * the override at the end of that function.
   */
  linkedPrLookupFailed?: boolean;
}

/**
 * Evidence that a trusted, rule-7-valid `forced-handoff` marker transferred
 * the active claim to the pair currently active. `timestamp` is the
 * transferring comment's GitHub `created_at` (the same authority every other
 * marker in this file uses), not the marker's own embedded `timestamp`
 * field; `null` when that comment metadata is unavailable, never an empty
 * string.
 */
interface AppliedForcedHandoffEvidence {
  old_agent_id: string;
  old_claim_id: string;
  new_agent_id: string;
  new_claim_id: string;
  forced_by: string;
  timestamp: string | null;
}

/** Parsed CLI arguments. */
interface ResumeClaimRoutingArgs {
  issue: number | null;
  owner: string;
  repo: string;
  ghToken: string;
  claimId: string;
  nonce: string;
  now: string;
  policy: string;
  staleAgeMs: number;
  trustedMarkerLogins: string;
  freshClaimGate: boolean;
  worktree: string;
  format: string;
  help: boolean;
}

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
  '--gh-token': { type: 'string' },
  '--token': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--nonce': { type: 'string' },
  '--now': { type: 'string' },
  '--policy': { type: 'string' },
  '--stale-age-ms': { type: 'string' },
  '--trusted-marker-logins': { type: 'string' },
  '--fresh-claim-gate': { type: 'boolean', default: false },
  '--worktree': { type: 'string' },
  '--format': { type: 'string', default: 'json' },
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
 * - no open linked PR backs the claim, and the lookup that produced that
 *   empty result actually succeeded (`expectedLinkedPrReferences` empty,
 *   `linkedPrLookupFailed` false/omitted) → honor an `issue-only` handoff
 *   as before;
 * - an open linked PR backs the claim → require `contextScope` of
 *   `issue-plus-pr` whose `linkedPr` matches one of the expected PRs.
 * - `linkedPrLookupFailed: true` (#3276, Groom hearing 2026-09-24): the
 *   lookup itself failed, so PR state is unknown rather than genuinely
 *   empty. An `issue-plus-pr` handoff still delegates to the shared gate
 *   above unchanged -- this decision covers `issue-only` handoffs only,
 *   and `expectedLinkedPrReferences` is empty either way on a failed
 *   lookup, so an `issue-plus-pr` marker naming any PR would fail to
 *   match a real backing PR regardless; that pre-existing shortcut is
 *   left as-is rather than widened or narrowed here. An `issue-only`
 *   handoff against an enabled mode is rejected outright instead of
 *   falling into the empty-set-means-honor-it shortcut.
 */
export function buildForcedHandoffEnabledGate(options: {
  forcedHandoffEnabled: boolean;
  expectedLinkedPrReferences: Set<string>;
  linkedPrLookupFailed?: boolean;
}): (forcedHandoff: ParsedForcedHandoffMarker) => boolean {
  // Delegate to the shared builder so resume routing and the merge-gate /
  // write-side helpers cannot drift. Resume routing never passes
  // `prFirstCommitAt`, so this stays byte-identical to the prior behavior:
  // an issue-only handoff against a PR-backed claim is rejected.
  const sharedGate = buildForcedHandoffEnableGate({
    forcedHandoffEnabled: options.forcedHandoffEnabled,
    expectedLinkedPrReferences: options.expectedLinkedPrReferences,
  });
  if (!options.linkedPrLookupFailed) {
    return sharedGate;
  }
  return (forcedHandoff: ParsedForcedHandoffMarker) =>
    forcedHandoff.contextScope === 'issue-plus-pr'
      ? sharedGate(forcedHandoff)
      : false;
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
  const linkedPrLookupFailed = options.linkedPrLookupFailed === true;
  const state = resolveClaimState(events, staleAgeMs, {
    isForcedHandoffEnabled,
    isAuthorizedForcedHandoff,
    linkedPrLookupFailed,
  });
  const claimIdChecked = normalizeToken(input.claimId);
  const sameSecondContenders = state.activeClaim
    ? findSameSecondContenders(events, state.activeClaim)
    : [];
  const laterCompetingClaim = state.activeClaim
    ? findLaterCompetingClaim(events, state.activeClaim)
    : null;
  const activationNonces = state.activeClaim
    ? listActivationNonces(events, state.activeClaim.claimId)
    : [];
  const activationNonceWinner =
    activationNonces.length > 0 ? activationNonces[0] : null;
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
  } else if (claimIdChecked && claimIdChecked === state.activeClaim.claimId) {
    // Owner-resume path: the checking session already proved ownership of
    // the active claim-id. A later trusted `claimed-by` with a different
    // claim-id never disputes an owner here (#3268): Claim-state parsing
    // rules 4 and 6 could never have activated it (rule 4 rejects a
    // `supersedes: none` competitor while a claim is already active; rule 6
    // ignores a mismatched/already-superseded `supersedes:`), and
    // `resolveActiveClaim` already proved that by leaving this owner's
    // claim-id active. Surfacing it as a dispute only ever stopped the real
    // owner while the loser still failed its own step 3 and returned to
    // Discover unchanged -- so it is kept as diagnostics
    // (`evidence.later_competing_claim` plus a warning below), not a route
    // outcome. Only the non-owner / fresh-claim-gate path below still
    // disputes on it, since a claim that never activated there has not yet
    // been proven a loser.
    //
    // The claim-id matches, but claim-id alone cannot distinguish a second,
    // independent activation of the same id (the sticky forced-handoff
    // adopt-verbatim collision #1522 exists to catch) -- so when both a
    // local nonce and a trusted activation-nonce winner are available,
    // require them to agree too. Either side being absent (no nonce posted
    // yet, or this caller never opted in) skips the comparison and keeps
    // the claim-id-only outcome, matching pre-#1522 behavior exactly.
    const nonceMismatch =
      activationNonceWinner !== null &&
      nonceChecked &&
      activationNonceWinner !== nonceChecked;
    if (laterCompetingClaim) {
      warnings.push(
        `later trusted claim ${laterCompetingClaim.claim_id} at ${laterCompetingClaim.created_at} cannot activate under Claim-state parsing rules 4/6 and is ignored on the owner path`,
      );
    }
    if (nonceMismatch) {
      routeState = 'disputed';
      action = 'stop';
      reason = 'activation-nonce-mismatch';
    } else if (!nonceChecked && activationNonces.length >= 2) {
      // #1529: omitting --nonce is no longer a full opt-out once 2+
      // trusted activation-nonce markers exist. A cold resume cannot tell
      // which marker is its own (`agent-id` is shared), so fail closed.
      routeState = 'disputed';
      action = 'stop';
      reason = 'cold-recovery-activation-nonce-collision';
    } else if (
      (options.inspectLocalWorktree || options.isCurrentSessionOwner) &&
      options.inspectLocalWorktree?.(state.activeClaim.branch)?.status !==
        'absent' &&
      !options.isCurrentSessionOwner?.(state.activeClaim)
    ) {
      // A matching remote claim-id is not sufficient to resume a live
      // session when a local worktree probe for this branch did not come
      // back `absent`: the current canonical worktree, lock, generated
      // tokens, and branch occupancy must independently identify this
      // owner, since the occupant could be a second, unrelated same-host
      // session. The CLI wires this proof from Discover; a missing or
      // contradictory proof fails closed rather than allowing that second
      // session to use the branch.
      //
      // Blocking on non-`absent` -- not only `occupied` -- matters because
      // `unreadable` is itself an ambiguous result the fail-closed default
      // governs: it means occupancy could not be verified either way, which
      // must not silently behave like "verified empty" (#3154 review).
      //
      // Gating on the probe result at all (not merely on whether the
      // callbacks are wired) matters for a forced-handoff successor's very
      // first routing check, which can run before B1 ever creates its
      // worktree (#3154 review): with the probe reporting `absent`, there
      // is no second session to disambiguate from, and requiring ownership
      // proof anyway would wrongly reject the successor's own
      // still-to-be-created worktree.
      //
      // A distinct state, not the reused `non_inheritable` (#3272): a
      // claim-id match with no independent owner evidence is not the same
      // fact as a genuinely disputed claim (a real later competing claim,
      // handled below by the `laterCompetingClaim` branch, which this
      // owner-resume path deliberately ignores per the comment above). Both
      // used to report `non_inheritable`, which every consumer reads as "a
      // live competitor claim" -- conflating "you haven't proven you're the
      // owner yet" with "someone else genuinely holds this". Keeping the
      // `action`/`reason` unchanged (`stop` /
      // `claim-id-match-without-independent-owner-evidence`) preserves the
      // fail-closed behavior; only `state` becomes distinguishable.
      routeState = 'owner_evidence_required';
      action = 'stop';
      reason = 'claim-id-match-without-independent-owner-evidence';
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
    // Non-owner path (a fresh session, or --fresh-claim-gate, which always
    // ignores claim-id): staleness of the active claim is now evaluated
    // BEFORE laterCompetingClaim, so a stale disputed claim still escapes to
    // a takeover-eligible route once claim-stale-age elapses (#1687) --
    // closing the livelock where a lost different-second claim race left the
    // issue permanently disputed even past the 24h stale-takeover backstop.
    routeState = 'stale';
    action = 'takeover';
    reason = 'active-claim-stale';
  } else if (laterCompetingClaim) {
    routeState = 'disputed';
    action = 'stop';
    reason = 'later-competing-claim';
  } else {
    routeState = 'non_inheritable';
    action = 'stop';
    reason = 'active-claim-non-stale';
  }

  let localWorktree: LocalWorktreeInspection | null = null;
  const worktreeSource =
    routeState === 'stale'
      ? 'stale'
      : routeState === 'unclaimed' && state.releasedClaim
        ? 'released'
        : null;
  if (worktreeSource && options.inspectLocalWorktree) {
    const branch =
      state.activeClaim?.branch ??
      state.legacyClaim?.branch ??
      state.releasedClaim?.branch ??
      '';
    if (branch) {
      localWorktree = options.inspectLocalWorktree(branch);
      if (localWorktree.status !== 'absent') {
        routeState = 'local_worktree_occupied';
        action = 'stop';
        const reasonPrefix =
          worktreeSource === 'released' ? 'released-claim' : 'stale-claim';
        reason =
          localWorktree.status === 'unreadable'
            ? `${reasonPrefix}-local-worktree-unreadable`
            : `${reasonPrefix}-local-worktree-occupied`;
        warnings.push(
          localWorktree.status === 'unreadable'
            ? `cannot verify local worktree occupancy for ${worktreeSource} branch ${branch}: ${localWorktree.reason ?? 'unknown error'}`
            : `${worktreeSource} branch ${branch} has a live local worktree: ${localWorktree.paths.join(', ')}`,
        );
      }
    }
  }

  // #3276: neither side of an issue-only forced handoff that was blocked
  // solely because the linked-PR lookup failed (PR state unknown) may read
  // as an ordinary claim-state outcome for a --claim-id check -- not the
  // displaced original owner's `already_owned`, and not the would-be
  // successor's generic non-stale/disputed stop. `resolveClaimState`
  // already recorded every such blocked marker while folding events (see
  // its `onIgnoredForcedHandoff` handler); only one whose `oldClaimId`
  // still equals the (unchanged, since the transfer was blocked) final
  // active claim is a live match -- a marker recorded earlier in history
  // for a claim that has since moved on for an unrelated reason is not.
  const linkedPrLookupFailureMatch =
    claimIdChecked && state.activeClaim
      ? (state.linkedPrLookupFailureRejections ?? []).find(
          (forcedHandoff) =>
            forcedHandoff.oldClaimId === state.activeClaim?.claimId &&
            (forcedHandoff.oldClaimId === claimIdChecked ||
              forcedHandoff.newClaimId === claimIdChecked),
        )
      : undefined;
  if (linkedPrLookupFailureMatch) {
    routeState = 'disputed';
    action = 'stop';
    reason = 'forced-handoff-linked-pr-lookup-failed';
  }

  return {
    state: routeState,
    action,
    reason,
    claim_id_checked: claimIdChecked || null,
    active_claim: state.activeClaim
      ? {
          agent_id: state.activeClaim.agentId,
          claim_id: state.activeClaim.claimId,
          created_at: state.activeClaim.createdAt,
          branch: state.activeClaim.branch,
        }
      : state.legacyClaim && !state.legacyReleased
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
      legacy_claim_seen: state.hasLegacyClaimMarker,
      same_second_contenders: sameSecondContenders,
      later_competing_claim: laterCompetingClaim,
      activation_nonce_winner: activationNonceWinner,
      activation_nonce_count: activationNonces.length,
      // #3276: explicitly null under the override above, not merely relying
      // on state.appliedForcedHandoff already being null because the
      // transfer never applied (true today, but this keeps the field
      // correct even if a future change to the fold logic ever left a
      // stale appliedForcedHandoff value around a blocked marker).
      forced_handoff: linkedPrLookupFailureMatch
        ? null
        : toForcedHandoffEvidence(state.appliedForcedHandoff),
      // #3276: always present (byte-stable), not only when a lookup was
      // attempted -- 'ok' covers both "no lookup ran" (forced-handoff mode
      // disabled) and "the lookup succeeded", matching the Proposed
      // change's `evidence.linked_pr_lookup: "failed"` example field.
      linked_pr_lookup: linkedPrLookupFailed ? 'failed' : 'ok',
      ...(state.releasedClaim
        ? {
            released_claim: {
              agent_id: state.releasedClaim.agentId,
              claim_id:
                'claimId' in state.releasedClaim
                  ? state.releasedClaim.claimId
                  : null,
              created_at: state.releasedClaim.createdAt,
              branch: state.releasedClaim.branch,
            },
          }
        : {}),
      ...(localWorktree ? { local_worktree: localWorktree } : {}),
    },
  };
}

/** Render {@link ActiveClaimResolution.appliedForcedHandoff} for JSON output. */
function toForcedHandoffEvidence(
  applied: ParsedForcedHandoffMarker | null,
): AppliedForcedHandoffEvidence | null {
  if (!applied) {
    return null;
  }
  return {
    old_agent_id: applied.oldAgentId,
    old_claim_id: applied.oldClaimId,
    new_agent_id: applied.newAgentId,
    new_claim_id: applied.newClaimId,
    forced_by: applied.forcedBy,
    timestamp: applied.createdAt ?? null,
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
 * `owner_evidence_required` (#3272) is never produced here: that state only
 * arises on the claim-id-match branch, and a fresh claim always passes
 * `claimId: undefined` (below) so it can never reach that branch.
 *
 * A fresh claim owns no prior claim-id, so any `claimId` on `input` is ignored
 * (the resolver's already-owned / same-second-loss branches need a checked id
 * and would otherwise mask pure contention). `winningClaimId` is the active
 * claim's `{claim-id}`, or the retained released claim's id when its matching
 * local worktree blocks a fresh claim; it is `null` for legacy releases or
 * when no active/released claim id exists. GitHub issue comments have no
 * compare-and-swap, so this **narrows** the A5(c) TOCTOU window rather than
 * closing it; the 24 h stale-takeover and same-second tie-break remain the
 * race-recovery backstop. A verified owner may use a retained released id
 * with the worktree-local lock takeover protocol; legacy releases remain
 * claim-id-less and require operator recovery before reuse.
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
  // Only a verified-occupied probe proves a local worktree is what a
  // caller would actually be taking over -- an `unreadable` result
  // (occupancy could not be inspected either way) must not expose either
  // the stale active claim's or the released claim's id as a trustworthy
  // takeover target, since the claim instructions treat a matching
  // winningClaimId as sufficient authorization for `claim-lock --takeover`
  // without separately re-checking local_worktree.status (#3154 review).
  // This applies to `active_claim` too, not only the released-claim
  // fallback: a stale (not released) claim whose worktree probe comes back
  // unreadable still reaches `local_worktree_occupied` with `active_claim`
  // populated.
  const localWorktreeUnverified =
    routing.state === 'local_worktree_occupied' &&
    routing.evidence.local_worktree?.status !== 'occupied';
  return {
    verdict,
    winningClaimId: localWorktreeUnverified
      ? null
      : (routing.active_claim?.claim_id ??
        (routing.state === 'local_worktree_occupied'
          ? (routing.evidence.released_claim?.claim_id ?? null)
          : null)),
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
  if (args.ghToken) {
    process.env.GH_TOKEN = args.ghToken;
    process.env.GITHUB_TOKEN = args.ghToken;
  }

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  const policy = loadPolicy(args.policy);
  const staleAgeMs = args.staleAgeMs > 0 ? args.staleAgeMs : policy.staleAgeMs;
  const viewerLogin = port.resolveViewerLogin();
  // Same ladder shape as pre-merge-readiness.mts's own
  // `resolveTrustedMarkerActors` call (#3272): a non-empty
  // `--trusted-marker-logins` flag REPLACES both `IDD_TRUSTED_MARKER_ACTORS`
  // and the config's `trustedMarkerActors` rather than adding to them, and
  // `IDD_TRUSTED_MARKER_ACTORS` is now read at all (it previously never
  // was here). The viewer login is still unconditionally added on top of
  // the ladder result, same as pre-merge-readiness.mts.
  const { actors: configuredTrustedActors, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
      config: { trustedMarkerActors: policy.trustedMarkerActors },
    });
  const trustedLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
  ]);
  const trustedSet = new Set(trustedLogins);
  const comments = fetchIssueComments(port, args.issue);
  const rawIssue = port.getWorkItem(args.issue ?? 0);
  if (!rawIssue) {
    throw new Error(`issue #${args.issue} not found`);
  }
  // Remapped back to the raw REST (snake_case) shape the output block
  // below expects -- ProviderWorkItem's camelCase fields (and getWorkItem's
  // uppercased state) are a port-level convention, not this file's
  // pre-migration contract.
  const issue = {
    number: rawIssue.number,
    title: rawIssue.title,
    state: rawIssue.state.toLowerCase(),
    html_url: rawIssue.htmlUrl,
    url: rawIssue.url,
  };
  const forcedHandoffEnabled = policy.forcedHandoff.mode === 'human-gated';
  const forcedHandoffAuthorityPolicy = policy.forcedHandoff.authorityPolicy;
  const permissionCache: CollaboratorPermissionCache = new Map();
  // A forced handoff that displaces a PR-backed claim must carry
  // issue-plus-pr evidence naming that PR; detect the open linked PR(s)
  // so the gate below can enforce it (fail-safe to no enforcement, except
  // #3276's own new issue-only-on-failure rejection below). Skip the
  // lookup entirely when forced-handoff mode is off — the gate never
  // honors a handoff then, so the PR context would go unused.
  const linkedPrLookup = forcedHandoffEnabled
    ? fetchOpenLinkedPrReferences(port, args.issue)
    : { references: new Set<string>(), lookupFailed: false };
  const expectedLinkedPrReferences = linkedPrLookup.references;
  const linkedPrLookupFailed = linkedPrLookup.lookupFailed;

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
      linkedPrLookupFailed,
    }),
    isAuthorizedForcedHandoff: (forcedBy: string) =>
      isAuthorizedForcedHandoffActor(
        owner,
        repo,
        forcedBy,
        forcedHandoffAuthorityPolicy,
        permissionCache,
      ),
    inspectLocalWorktree: (branchName: string) =>
      inspectLocalWorktreeBranch(branchName),
    isCurrentSessionOwner: (claim: ParsedClaimMarker) => {
      const evidence = resolveCurrentSessionClaimEvidence(
        claim.claimId,
        args.worktree || undefined,
      );
      if (
        evidence === null ||
        evidence.agentId !== claim.agentId ||
        evidence.branchName !== claim.branch
      ) {
        return false;
      }
      return isCurrentSessionWorktreeOwner(
        evidence.worktreePath,
        evidence.branchName,
        claim.branch,
        inspectLocalWorktreeBranch(claim.branch),
      );
    },
    linkedPrLookupFailed,
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
      trusted_marker_actors_source: trustedMarkerActorsSource,
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
    /** See {@link ResumeClaimRoutingOptions.linkedPrLookupFailed}. */
    linkedPrLookupFailed?: boolean;
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
  const linkedPrLookupFailed = options.linkedPrLookupFailed === true;

  // hasNewFormatClaim drives the new-format vs legacy-only mode. Detect
  // it by scanning before delegating to the canonical parser so the
  // wrapper can return the right legacy-fallback shape.
  const hasNewFormatClaim = events.some(
    (event) =>
      parseClaimComment(event.body ?? '', event.createdAt ?? '') !== null,
  );
  // hasLegacyClaimMarker records whether any legacy-format marker was ever
  // posted, independent of whether the 'new-format' branch below ignores it
  // in favor of a co-existing new-format claim (#2317's follow-up finding:
  // `legacyClaim` alone conflates "no legacy marker existed" with "one
  // existed but new-format priority skipped resolving it").
  const hasLegacyClaimMarker = events.some(
    (event) =>
      parseLegacyClaimComment(event.body ?? '', event.createdAt ?? '') !== null,
  );

  const warnings: string[] = [];
  // #3276: forced-handoff markers rejected specifically because
  // `linkedPrLookupFailed` blocked an issue-only handoff (never a
  // genuinely disabled mode -- see onIgnoredForcedHandoff below), for
  // evaluateResumeClaimRouting's own --claim-id override.
  const linkedPrLookupFailureRejections: ParsedForcedHandoffMarker[] = [];
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
      // The gate returns false for two distinct reasons that both surface
      // here as the same generic 'mode-disabled' event (applyClaimEvent
      // does not distinguish them): a genuinely disabled forced-handoff
      // mode, or #3276's new lookup-failure rejection. `linkedPrLookupFailed`
      // can only be true when the lookup actually ran, which only happens
      // when forced-handoff mode is enabled -- so its presence here
      // unambiguously means the latter, never the former, for an
      // issue-only marker.
      //
      // #3276 (CodeRabbit review, PR #3386): applyClaimEvent checks
      // isForcedHandoffEnabled BEFORE the author/forcedBy match and
      // authorization checks (the 'author-forced-by-mismatch' /
      // 'forced-by-unauthorized' branches below), so a forged or
      // unauthorized issue-only marker would otherwise reach here too --
      // recorded as though it were a genuinely valid handoff blocked only
      // by the lookup failure, even though it would be rejected as forged/
      // unauthorized regardless of the lookup outcome. Only record (and
      // warn about) a lookup-failure rejection for a marker that is
      // otherwise genuinely valid, by independently re-deriving the same
      // two checks `resolveClaimState` always applies for this file
      // (`requireAuthorMatchesForcedBy: true` below) before deciding.
      const authorMatchesForcedBy =
        String(event.author?.login ?? '')
          .trim()
          .toLowerCase() ===
        String(forcedHandoff.forcedBy ?? '')
          .trim()
          .toLowerCase();
      const otherwiseValidHandoff =
        authorMatchesForcedBy &&
        isAuthorizedForcedHandoff(forcedHandoff.forcedBy, forcedHandoff, event);
      if (
        linkedPrLookupFailed &&
        forcedHandoff.contextScope !== 'issue-plus-pr' &&
        otherwiseValidHandoff
      ) {
        linkedPrLookupFailureRejections.push(forcedHandoff);
        warnings.push(
          `ignored forced-handoff for ${forcedHandoff.oldClaimId}: linked-PR lookup failed (PR state unknown), issue-only handoff not honored`,
        );
        return;
      }
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

  const claimTrace = hasNewFormatClaim
    ? resolveActiveClaimWithForcedHandoffTrace(events, {
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
      activeClaim: claimTrace?.activeClaim ?? null,
      releasedClaim: claimTrace?.releasedClaim ?? null,
      appliedForcedHandoff: claimTrace?.appliedForcedHandoff ?? null,
      warnings,
      legacyClaim: null,
      legacyReleased: false,
      hasLegacyClaimMarker,
      linkedPrLookupFailureRejections,
    };
  }

  // kurone-kito/idd-skill#3266: shared with the new-format path above via
  // the single `orderClaimEvents` primitive instead of this file's own
  // near-duplicate comparator (removed). `events` here is already
  // trust-filtered by `evaluateResumeClaimRouting`'s own top-level
  // filter, so no claim-id tie-break can ever fire in practice (no
  // legacy marker carries a claim-id) -- this is effectively the same
  // `(second, time, index)` ordering `compareEvents` produced, just
  // sharing the one implementation.
  const orderedEvents = orderClaimEvents(events);
  const legacy = resolveLegacyClaimState(orderedEvents);
  return {
    mode: 'legacy-only',
    activeClaim: null,
    releasedClaim: legacy.releasedClaim,
    appliedForcedHandoff: null,
    warnings,
    legacyClaim: legacy.claim,
    legacyReleased: legacy.released,
    hasLegacyClaimMarker,
    linkedPrLookupFailureRejections,
  };
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
    // Reconcile competitor releases (#1687): a competing claimed-by whose
    // {agent-id}/{claim-id} pair has a later matching trusted unclaimed-by
    // no longer counts as a live competitor -- a courteous loser that
    // releases its raced claim must clear the dispute it created, instead
    // of leaving the issue permanently disputed against a claim nobody
    // holds anymore.
    .filter((claim) => !isClaimReleased(events, claim))
    .sort((left, right) => compareIso(left.createdAt, right.createdAt));
  if (contenders.length === 0) {
    return null;
  }
  return {
    claim_id: contenders[0].claimId,
    created_at: contenders[0].createdAt,
  };
}

/**
 * True when a trusted `unclaimed-by` event releases `claim` -- its parsed
 * `{agentId, claimId}` (via `parseReleaseComment`, which carries no
 * timestamp of its own) matches `claim`'s, and the release event's own
 * GitHub `created_at` (`event.createdAt`, the raw comment metadata) is
 * strictly later than `claim.createdAt`. Uses the same `{agentId, claimId}`
 * match as `applyClaimEvent`'s release check, but is evaluated
 * independently here: `findLaterCompetingClaim`'s candidate
 * never became the active claim (rule 4 of Claim-state parsing rejects a
 * `supersedes: none` competitor while a claim already exists), so its own
 * release never flows through `resolveActiveClaim`'s state machine and must
 * be checked directly against the raw trusted event stream instead.
 *
 * Deliberately fail-closed, not a byte-identical mirror of
 * `resolveActiveClaim`'s ordering: GitHub `created_at` is second-precision,
 * so a claim and its release can share an identical timestamp string.
 * `resolveActiveClaim`'s own sort breaks that tie by array/index order
 * (effectively trusting fetch order) when resolving the *active* claim;
 * this check requires a strictly later second instead, so an
 * indistinguishable same-second ordering is never treated as proof of
 * release -- the competing claim stays counted as live (the safer default)
 * until a later, unambiguous release lands.
 */
function isClaimReleased(
  events: NormalizedClaimEvent[],
  claim: ParsedClaimMarker,
): boolean {
  return events.some((event) => {
    const release = parseReleaseComment(event.body);
    if (
      !release ||
      release.agentId !== claim.agentId ||
      release.claimId !== claim.claimId
    ) {
      return false;
    }
    return compareIso(event.createdAt, claim.createdAt) > 0;
  });
}

// `findActivationNonceWinner` moved to marker-helpers.mts (#1528) so the
// F2/F3 merge-time write-gate (`summarizeClaimValidation` in
// protocol-helpers.mts) can share the identical primitive instead of
// forking its own copy. Imported above from './protocol-helpers.mts'.

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

function warnDeprecatedFlag(deprecated: string, canonical: string): void {
  process.stderr.write(
    `warning: ${deprecated} is deprecated; use ${canonical} instead.\n`,
  );
}

/**
 * Find `flag`'s last occurrence in `argv`, recognizing both the
 * two-token form (`--flag value`) and the single-token `--flag=value`
 * form `parseCliArgs` also accepts.
 */
function findLastFlagOccurrenceIndex(
  argv: readonly string[],
  flag: string,
): number {
  const equalsPrefix = `${flag}=`;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    if (argv[index] === flag || argv[index].startsWith(equalsPrefix)) {
      return index;
    }
  }
  return -1;
}

/**
 * Resolve a canonical/deprecated flag pair: whichever flag's LAST
 * occurrence comes later in argv wins when both spellings are given
 * together (matches `pre-merge-readiness.mts`'s `--claim-id` /
 * `--expected-claim-id` precedent). `-1` (never given) sorts before any
 * real index, so an absent flag never wins against one that was
 * actually passed.
 */
function resolveLastGivenAlias(
  argv: readonly string[],
  canonicalFlag: string,
  canonicalValue: string | undefined,
  deprecatedFlag: string,
  deprecatedValue: string | undefined,
): string | undefined {
  if (canonicalValue === undefined) {
    return deprecatedValue;
  }
  if (deprecatedValue === undefined) {
    return canonicalValue;
  }
  const lastCanonicalIndex = findLastFlagOccurrenceIndex(argv, canonicalFlag);
  const lastDeprecatedIndex = findLastFlagOccurrenceIndex(argv, deprecatedFlag);
  return lastDeprecatedIndex > lastCanonicalIndex
    ? deprecatedValue
    : canonicalValue;
}

function parseArgs(argv: string[]): ResumeClaimRoutingArgs {
  const { values, help } = parseCliArgs(argv, RESUME_CLAIM_ROUTING_FLAG_SPEC);
  const issueToken = values.issue as string | undefined;
  const staleAgeMsToken = values['stale-age-ms'] as string | undefined;
  const ghToken = resolveLastGivenAlias(
    argv,
    '--gh-token',
    values['gh-token'] as string | undefined,
    '--token',
    values.token as string | undefined,
  );
  const deprecatedTokenValue = values.token as string | undefined;
  if (deprecatedTokenValue !== undefined) {
    warnDeprecatedFlag('--token', '--gh-token');
  }
  // #3188: accepted so callers that always pass `--format json` across IDD
  // helpers (live-status-digest documents `--format <json|table>`) do not
  // hit `unknown argument: --format` here. This helper only ever emits
  // JSON, so `json` is a no-op; every other value fails loudly instead of
  // silently degrading to JSON.
  const format = values.format as string;
  if (format !== 'json') {
    throw new Error(`--format must be json (got "${format}")`);
  }
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
    ghToken: ghToken ?? '',
    claimId: (values['claim-id'] as string | undefined) ?? '',
    nonce: (values.nonce as string | undefined) ?? '',
    now: (values.now as string | undefined) ?? '',
    policy: (values.policy as string | undefined) ?? '',
    staleAgeMs:
      staleAgeMsToken === undefined ? 0 : Number.parseInt(staleAgeMsToken, 10),
    trustedMarkerLogins:
      (values['trusted-marker-logins'] as string | undefined) ?? '',
    freshClaimGate: values['fresh-claim-gate'] as boolean,
    worktree: (values.worktree as string | undefined) ?? '',
    format,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/resume-claim-routing.mjs --issue <number> [--owner <owner>] [--repo <repo>] [--gh-token <token>] [--claim-id <token>] [--nonce <token>] [--now <ISO8601>] [--policy <path>] [--stale-age-ms <ms>] [--trusted-marker-logins "<a,b,...>"] [--fresh-claim-gate] [--worktree <path>] [--format json]
  Deprecated aliases (one release): --token -> --gh-token

  --format json       output format (default: json). JSON is the only
                      supported value; it is accepted for consistency with
                      sibling helpers and any other value is rejected.

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
                      the identical claim-id -- routes to "disputed" with
                      reason activation-nonce-mismatch. Omit --nonce when
                      the claim-id has 0 or 1 trusted nonce to skip the
                      comparison. Omit --nonce when 2+ trusted nonces exist
                      and this session has no local nonce: route to
                      disputed/stop (cold-recovery collision, #1529).
  --worktree <path>   read the independent owner-evidence proof (the claim
                      lock, the generated-tokens record, and the current
                      branch) from this path instead of process.cwd() when
                      --claim-id matches the active claim (#3272). Use this
                      when running from the primary checkout, before the
                      claimed branch's own worktree exists as the current
                      directory -- the evidence bar is unchanged, only the
                      path it is read from. Omit it to keep reading from
                      process.cwd(), the prior behavior.
  --trusted-marker-logins "<a,b,...>"
                      a non-empty value REPLACES both the
                      IDD_TRUSTED_MARKER_ACTORS env var and the config's
                      trustedMarkerActors array, rather than adding to them
                      (#3272; matches pre-merge-readiness.mts's own ladder:
                      flag, then env, then config). The viewer login is
                      always added on top of whichever source wins.

Output (selected fields; the JSON also carries repository / issue / policy /
warnings / evidence):
{
  "state": "unclaimed|already_owned|stale|local_worktree_occupied|non_inheritable|owner_evidence_required|disputed",
  "action": "re_claim|takeover|keep|stop",
  "reason": "...",
  "active_claim": {"agent_id":"...","claim_id":"...","created_at":"...","branch":"..."} | null,
  "evidence": {"...": "...", "activation_nonce_winner": "..."|null},
  "fresh_claim_gate": {"verdict":"claimable|already-claimed|stale-reclaimable","winning_claim_id":"..."|null}  // only with --fresh-claim-gate
}

policy.trusted_marker_actors_source reports which input supplied the
trusted-marker-logins ladder's value: "flag" | "env" | "config" | "none".
`);
}

function fetchIssueComments(
  port: ProviderPort,
  issueNumber: number | null,
): IssueCommentPayload[] {
  // Remapped back to the raw snake_case shape this file's own consumers
  // expect (body / created_at / user.login) -- listWorkItemComments's
  // camelCase ProviderComment shape is a port-level convention, not this
  // file's pre-migration contract.
  return port.listWorkItemComments(issueNumber ?? 0).map((comment) => ({
    body: comment.body,
    created_at: comment.createdAt,
    user: { login: comment.authorLogin },
  }));
}

// Read-and-parse failure semantics (explicit path throws; default path
// silently falls back only on ENOENT) are converged in idd-config.mts's
// loadPolicyConfig (#1721). It already implements exactly what this
// function's former `strict` option hand-rolled -- the caller always passed
// `strict: Boolean(args.policy)`, the same "was an explicit path given" test
// loadPolicyConfig makes internally -- so the option (and this function's
// own try/catch around the read) is no longer needed; a load failure now
// propagates the shared reader's own error.
export function loadPolicy(policyPath: string) {
  const { path: source, config } = loadPolicyConfig(policyPath);
  const typedConfig = config as {
    claimTiming?: { staleAge?: unknown } | null;
    trustedMarkerActors?: unknown;
  } | null;
  const normalized = normalizePolicyConfig(typedConfig);
  return {
    source,
    // #3270: was a loose, case-insensitive local `parseDurationToMs` copy
    // applied to the RAW value -- a schema-invalid `pt12h` parsed to 12h
    // here but fell back to the distributed 24h default in
    // `pre-merge-readiness.mts` (case-sensitive). Now the same shared,
    // strict `readClaimStaleAgeMs` every other caller uses, applied to the
    // already-normalized `claimTiming.staleAge` (fail-safe to `PT24H`), so
    // a schema-invalid value resolves identically everywhere.
    staleAgeMs: readClaimStaleAgeMs(typedConfig),
    trustedMarkerActors: Array.isArray(typedConfig?.trustedMarkerActors)
      ? (typedConfig.trustedMarkerActors as unknown[])
          .map((value) => String(value ?? '').trim())
          .filter(Boolean)
      : [],
    forcedHandoff: {
      mode: normalized.forcedHandoff.mode,
      authorityPolicy: normalized.forcedHandoff.authorityPolicy,
    },
  };
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

/** Fold one raw CONNECTED_EVENT/DISCONNECTED_EVENT timeline node into the
 * running connected/state maps {@link fetchOpenLinkedPrReferences} reconciles
 * afterward. The last connect/disconnect event per PR wins (the timeline is
 * chronological, and pagination preserves that order across pages). */
function applyConnectedPrEventNode(
  node: unknown,
  connected: Map<number, boolean>,
  states: Map<number, string>,
): void {
  const record = node as {
    __typename?: unknown;
    subject?: { __typename?: unknown; number?: unknown; state?: unknown };
  } | null;
  const subject = record?.subject;
  if (subject?.__typename !== 'PullRequest') {
    return;
  }
  const number =
    typeof subject.number === 'number' ? subject.number : Number.NaN;
  if (!Number.isInteger(number)) {
    return;
  }
  if (record?.__typename === 'ConnectedEvent') {
    connected.set(number, true);
    states.set(number, String(subject.state ?? ''));
  } else if (record?.__typename === 'DisconnectedEvent') {
    connected.set(number, false);
  }
}

/**
 * Resolve the set of open pull requests that back this issue's claim, as
 * normalized PR references, plus whether the lookup itself failed. Uses a
 * precise signal — a PR connected to the issue via `CONNECTED_EVENT`
 * (reconciled against later `DISCONNECTED_EVENT`s) that is currently `OPEN`
 * — rather than a bare cross-reference/mention, so an unrelated open PR
 * merely mentioning the issue does not falsely block a legitimate
 * `issue-only` forced handoff.
 *
 * #3276: paginates {@link ProviderPort.getConnectedPullRequestEventsPage}
 * (which throws on a failed or malformed page, matching
 * `idd-roadmap-audit-execute.mts`'s `hasOpenConnectedPr` precedent) instead
 * of the unpaginated, fail-open `getConnectedPullRequestEventsSingle` --
 * removing the prior silent `last:100` truncation as a side effect. A
 * genuine lookup failure now surfaces as `lookupFailed: true` with an empty
 * `references` set, distinct from a successful lookup that legitimately
 * found no connected PR (`lookupFailed: false`, empty set). Callers must not
 * treat the two the same -- see
 * {@link ResumeClaimRoutingOptions.linkedPrLookupFailed}.
 */
export function fetchOpenLinkedPrReferences(
  port: ProviderPort,
  issueNumber: number | null,
): { references: Set<string>; lookupFailed: boolean } {
  const references = new Set<string>();
  if (!Number.isInteger(issueNumber)) {
    return { references, lookupFailed: false };
  }
  const connected = new Map<number, boolean>();
  const states = new Map<number, string>();
  try {
    let after: string | null = null;
    // #3276 (CodeRabbit review, PR #3386): the adapter returns whatever
    // cursor the GraphQL response carries with no progress guarantee of its
    // own -- a repeated non-empty cursor (immediate or a multi-cursor
    // cycle) would otherwise make this loop request the same page
    // indefinitely. Track every cursor seen and throw on a repeat rather
    // than imposing an arbitrary page cap, which could wrongly reject a
    // genuinely long timeline.
    const seenCursors = new Set<string>();
    for (;;) {
      // Number.isInteger(issueNumber) above already excludes null; TS can't
      // narrow a plain boolean-returning call the way a type predicate would.
      const page = port.getConnectedPullRequestEventsPage(
        issueNumber as number,
        after,
      );
      for (const node of page.events) {
        applyConnectedPrEventNode(node, connected, states);
      }
      if (!page.hasNextPage) {
        break;
      }
      const nextCursor = page.endCursor ?? null;
      if (!nextCursor) {
        // hasNextPage with no endCursor: reconciling a truncated timeline
        // could miss a later CONNECTED/DISCONNECTED event and silently read
        // as a smaller, wrong PR set -- exactly the ambiguity this issue
        // exists to close. Throw so the caller treats it as a lookup
        // failure instead of trusting the partial stream.
        throw new Error(
          'incomplete connected-PR pagination: hasNextPage with no endCursor',
        );
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(
          'non-progressing connected-PR pagination: repeated endCursor',
        );
      }
      seenCursors.add(nextCursor);
      after = nextCursor;
    }
  } catch {
    return { references: new Set(), lookupFailed: true };
  }
  for (const [number, isConnected] of connected) {
    if (isConnected && states.get(number) === 'OPEN') {
      references.add(normalizeLinkedPrReference(number));
    }
  }
  return { references, lookupFailed: false };
}
