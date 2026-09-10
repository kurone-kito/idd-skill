#!/usr/bin/env node
// idd-generated-from: src/scripts/external-check-waiver.mts
//
// The scripts/external-check-waiver.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { readFileSync } from 'node:fs';
import {
  buildAdvisoryConvergenceWaiverPrecondition,
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  readAdvisoryConvergenceDeadlineMinutes,
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_EXPIRY,
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
} from './advisory-wait-policy.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { resolveTrustedCollaboratorMarkerLogins } from './collaborator-permission.mjs';
import { resolveHelperActiveClaim } from './forced-handoff-marker.mjs';
import {
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  ghText,
  safeGhText,
} from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mjs';
import {
  parseExternalCheckWaiverComment,
  parsePaginatedGhNdjson,
  renderExternalCheckWaiverComment,
  summarizeExternalCheckWaivers,
} from './protocol-helpers.mjs';
import { makeReadlinePrompt } from './readline-prompt.mjs';

const APPROVAL_ACTOR_POLICIES = new Set([
  'owners-and-maintainers-only',
  'all-write-permission-actors',
]);
const APPROVAL_ACTOR_POLICY_DEFAULT = 'owners-and-maintainers-only';
const EXTERNAL_CHECK_WAIVER_MODE = 'maintainer-authorized';
const EXTERNAL_CHECK_WAIVER_MODE_DISABLED = 'disabled';
const SUCCESS_LIKE_CHECK_STATES = new Set([
  'success',
  'neutral',
  'skipped',
  'not_applicable',
]);
const PENDING_CHECK_STATES = new Set([
  'queued',
  'in_progress',
  'waiting',
  'pending',
  'expected',
]);
export const NON_TTY_APPLY_ERROR =
  'operator interaction is required; rerun in a TTY or pass --yes after reviewing dry-run output';
export function matchCheckSelector(name, selector, matchMode = 'exact') {
  const normalizedName = String(name ?? '').trim();
  const normalizedSelector = String(selector ?? '').trim();
  if (!normalizedName || !normalizedSelector) {
    return false;
  }
  if (matchMode === 'glob') {
    const source = normalizedSelector
      .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${source}$`).test(normalizedName);
  }
  return normalizedName === normalizedSelector;
}
export function planExternalCheckWaiver(input, options = {}) {
  const pr = input?.pr ?? {};
  const issueCandidates = Array.isArray(input?.issueCandidates)
    ? input.issueCandidates
    : [];
  const policy = input?.policy ?? normalizePolicyConfig({});
  const requestedSelector = String(input?.requestedSelector ?? '').trim();
  const reason = String(input?.reason ?? '').trim();
  const expiresAt = String(input?.expiresAt ?? '').trim();
  const autoBootstrap = Boolean(input?.autoBootstrap);
  const runId = String(input?.runId ?? '').trim();
  const actor = String(input?.actor ?? '')
    .trim()
    .toLowerCase();
  const authority = normalizeAuthorityEvidence(
    input?.authority,
    actor,
    String(options.repoOwner ?? input?.repoOwner ?? '').trim(),
    policy?.ciGate?.externalCheckWaivers?.authorityPolicy,
  );
  const requestedMatchMode = selectorRequestsGlob(requestedSelector)
    ? 'glob'
    : 'exact';
  const normalizedChecks = normalizeChecks(pr.statusCheckRollup);
  const matchedChecks = normalizedChecks.filter((check) => {
    return matchCheckSelector(
      check.name,
      requestedSelector,
      requestedMatchMode,
    );
  });
  const waivableSelectors = policy?.ciGate?.externalChecks?.waivable ?? [];
  const matchedSelectors = waivableSelectors.filter((selector) => {
    return matchedChecks.some((check) => {
      return matchCheckSelector(
        check.name,
        selector.selector,
        selector.matchMode,
      );
    });
  });
  const uncoveredChecks = matchedChecks.filter((check) => {
    return !waivableSelectors.some((selector) => {
      return matchCheckSelector(
        check.name,
        selector.selector,
        selector.matchMode,
      );
    });
  });
  const maxValidity = parseIsoDurationToMs(
    policy?.ciGate?.externalCheckWaivers?.maxValidity ?? 'PT24H',
  );
  const now = options.now instanceof Date ? options.now : new Date();
  const expiresDate = expiresAt ? new Date(expiresAt) : null;
  const expiresKnown =
    expiresDate instanceof Date && Number.isFinite(expiresDate.getTime());
  const expiresInFuture = expiresKnown && expiresDate.getTime() > now.getTime();
  const withinMaxValidity =
    expiresKnown && Number.isFinite(maxValidity)
      ? expiresDate.getTime() - now.getTime() <= (maxValidity ?? 0)
      : false;
  // #1905: still resolved even under --claimless -- not to gate on it (a
  // claimless waiver never requires a linked-issue claim), but so a
  // resolvable active claim can be surfaced as a blocking diagnostic below:
  // a `none`-claim-id waiver only ever satisfies
  // `summarizeExternalCheckWaivers` on a PR with NO active claim, so
  // rendering one against a claimed PR would just be rejected `wrongClaim`
  // at the merge gate -- better to block it here with a clear reason than
  // let the operator post a waiver that can never take effect.
  const linkedIssue = selectLinkedIssueCandidate(issueCandidates, {
    issueNumber: input?.issueNumber,
    expectedClaimId: input?.expectedClaimId,
    headRefName: String(pr.headRefName ?? '').trim(),
  });
  const claimless = Boolean(input?.claimless);
  // kurone-kito/idd-skill#2657 (Codex review, PR #2895): when an adopter
  // keeps the template's default `advisoryWait.convergenceScope: "all-prs"`,
  // a human-authored PR that merely edits an allowlisted checker file can be
  // fully claimless -- no linked issue, no IDD claim at all. `--auto-bootstrap`
  // never invokes `--issue`/`--claim-id`/`--claimless` (the workflow's fixed
  // command line), so without this, `!linkedIssue.ok` below would block the
  // post outright, permanently defeating the bootstrap for exactly the PRs
  // this scope setting is meant to cover. The trust chain that authorizes an
  // auto-bootstrap marker (`verifySelfReferentialBootstrapWaiverRun`'s run-id
  // verification) is already independent of any claim, so falling back to
  // the same `none`-claim-id binding `--claimless` uses is safe: the
  // consumer's `claimBindingSatisfied` check only accepts the `none` sentinel
  // when it independently finds no active claim either (protocol-helpers.mts),
  // so this can never paper over a genuine claim mismatch. Left `false` when
  // `linkedIssue.ok` (a resolvable claim exists -- bind to it normally, same
  // as before this change) or the caller already passed the literal
  // `--claimless` flag (that combination is rejected explicitly below,
  // unaffected by this auto-fallback).
  //
  // kurone-kito/idd-skill#2657 (Copilot review, PR #2895): restricted to
  // `candidateCount === 0` -- a DEFINITIVELY claimless PR, not merely any
  // failure to resolve. `selectLinkedIssueCandidate` also reports `ok:
  // false` for an AMBIGUOUS PR (multiple candidates, `candidateCount >
  // 1`): applicability there is indeterminate, not absent -- some claim
  // genuinely exists, just not uniquely identified from this input alone.
  // Falling back to `none` for that case too would still fail closed at
  // consume time in the ordinary case (the sentinel only matches an
  // independently-empty active claim there), but this repository's own
  // gate resolves its claim through a DIFFERENT mechanism than this
  // file's own multi-candidate scan (`summarizeClaimValidation` over the
  // linked issue's own claim comments, not `issueCandidates` filtering),
  // so nothing here can prove the two would always agree on "ambiguous".
  // Restricting to the unambiguous, provably-empty case removes that
  // doubt entirely rather than relying on a symmetry this file cannot
  // verify.
  const autoBootstrapImplicitClaimless =
    autoBootstrap &&
    !claimless &&
    !linkedIssue.ok &&
    linkedIssue.candidateCount === 0;
  const blockingReasons = [];
  if (String(pr.state ?? 'OPEN').toUpperCase() !== 'OPEN') {
    blockingReasons.push(`PR #${pr.number ?? '?'} is not open`);
  }
  if (
    (policy?.ciGate?.externalCheckWaivers?.mode ??
      EXTERNAL_CHECK_WAIVER_MODE_DISABLED) !== EXTERNAL_CHECK_WAIVER_MODE
  ) {
    blockingReasons.push('external-check waiver mode is disabled');
  }
  if (claimless) {
    if (linkedIssue.ok) {
      blockingReasons.push(
        'PR has a resolvable active IDD claim on a linked issue; a claimless (none) waiver only applies when no claim resolves -- use --issue/--claim-id instead',
      );
    }
  }
  if (claimless || autoBootstrapImplicitClaimless) {
    // The normal path's agentId comes from the resolved claim, independent
    // of `actor`; a claimless binding (explicit --claimless, or the implicit
    // auto-bootstrap fallback above) has no claim to fall back on, so an
    // empty actor must surface here as a blocking reason like every other
    // invalid input in this function, rather than reaching
    // renderExternalCheckWaiverComment's own throw-on-empty-agentId guard.
    // Unreachable in practice for auto-bootstrap, whose caller always sets
    // `actor = 'github-actions[bot]'` -- kept for direct callers of this
    // function (e.g. tests) that construct the autoBootstrap input by hand.
    if (!actor) {
      blockingReasons.push('actor is empty');
    }
  } else if (!linkedIssue.ok) {
    blockingReasons.push(linkedIssue.reason);
  }
  if (!requestedSelector) {
    blockingReasons.push('requested check selector is empty');
  }
  if (!reason) {
    blockingReasons.push('reason is empty');
  }
  if (!expiresKnown) {
    blockingReasons.push('expiry is not a valid ISO-8601 timestamp');
  } else {
    if (!expiresInFuture) {
      blockingReasons.push('expiry must be in the future');
    }
    if (!withinMaxValidity) {
      blockingReasons.push(
        `expiry exceeds configured maxValidity ${policy?.ciGate?.externalCheckWaivers?.maxValidity ?? 'PT24H'}`,
      );
    }
  }
  // kurone-kito/idd-skill#2657: the one narrow, documented exception to
  // "human maintainer only" -- an auto-bootstrap marker's trust comes from
  // the run-id/event-type verification `advisory-convergence.mts` performs
  // at consume time (the marker names the exact GitHub Actions run that
  // posted it, and the consumer independently confirms that run is a
  // `pull_request_target`-triggered run of this gate's own workflow file
  // for the current PR HEAD), never from a GitHub collaborator permission.
  // There is no human actor to authorize here, so this skips the check
  // entirely rather than trying to satisfy it with a synthetic identity.
  if (!autoBootstrap) {
    if (!authority.known) {
      blockingReasons.push(
        authority.error || 'actor authority could not be proven',
      );
    } else if (!authority.authorized) {
      blockingReasons.push(
        `${actor || 'actor'} is not authorized under ${authority.policy}`,
      );
    }
  }
  if (autoBootstrap && reason !== SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON) {
    blockingReasons.push(
      `--auto-bootstrap requires reason to be exactly "${SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON}"`,
    );
  }
  // kurone-kito/idd-skill#2657 (Codex review, PR #2895): the reverse
  // case. summarizeExternalCheckWaivers now deliberately excludes every
  // marker with this exact reason from generic waiver evidence
  // (allowSelfReferentialBootstrapAuto's own doc comment), so an
  // ordinary (non-`--auto-bootstrap`) post using it would report a
  // successful apply for a marker no consumer can ever honor -- not
  // even a maintainer, past any deadline. Reject it outright instead of
  // silently accepting a marker that can never take effect.
  if (!autoBootstrap && reason === SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON) {
    blockingReasons.push(
      `reason "${SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON}" is reserved for --auto-bootstrap`,
    );
  }
  if (autoBootstrap && !runId) {
    blockingReasons.push('--auto-bootstrap requires a run id');
  }
  if (autoBootstrap && claimless) {
    blockingReasons.push(
      '--auto-bootstrap cannot be combined with --claimless',
    );
  }
  if (matchedChecks.length === 0) {
    blockingReasons.push(
      `requested selector ${requestedSelector || '<empty>'} did not match any current PR checks`,
    );
  }
  if (
    matchedChecks.length > 0 &&
    matchedChecks.every((check) => check.successLike)
  ) {
    blockingReasons.push('matched checks are already passing');
  }
  if (matchedChecks.length > 0 && uncoveredChecks.length > 0) {
    blockingReasons.push(
      'one or more matched checks are not configured as waivable external checks',
    );
  }
  // #2328: `idd-advisory-convergence` never treats a posted waiver as active
  // until its own precondition opens, so rendering one before then produces a
  // marker the gate ignores. Report that precondition from the shared builder
  // -- the same one `pre-merge-readiness` uses -- and block on a closed hatch,
  // rather than reporting no blocking reasons while the gate reports the hatch
  // shut. Only the EXACT selector is gated: a glob waiver is never treated as
  // covering this check by the gate either (#2021), so gating one here would
  // block for the wrong reason.
  //
  // The terminal opener is deliberately NOT evaluated: proving it needs
  // trusted advisory-wait recovery-marker state this helper does not collect.
  // The blocking reason therefore says the deadline has not passed, never that
  // no opener applies -- an unevaluated terminal opener may well be open.
  const preconditionGatedSelector =
    requestedMatchMode === 'exact' &&
    requestedSelector === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR;
  const advisoryConvergenceWaiverPrecondition = preconditionGatedSelector
    ? (() => {
        const { precondition } = buildAdvisoryConvergenceWaiverPrecondition({
          headCommittedAt: input?.headCommittedAt,
          deadlineMinutes: input?.advisoryConvergenceDeadlineMinutes,
          now: now.toISOString(),
        });
        return { ...precondition, terminalEvaluated: false };
      })()
    : undefined;
  // kurone-kito/idd-skill#2657: an auto-bootstrap marker is evaluated
  // independent of this hatch by design (`autoWaiverValid` in
  // `advisory-convergence.mts` never gates behind `deadlinePassed`/
  // `terminalUnavailable`) -- the whole point is posting immediately, not
  // waiting for the deadline clock this hatch reports on. Always bypassed
  // for this mode, not merely available via the operator opt-in flag.
  const allowClosedPrecondition =
    input?.allowClosedPrecondition === true || autoBootstrap;
  if (
    advisoryConvergenceWaiverPrecondition &&
    !advisoryConvergenceWaiverPrecondition.open &&
    !allowClosedPrecondition
  ) {
    const elapsed = advisoryConvergenceWaiverPrecondition.elapsedMinutes;
    blockingReasons.push(
      `${DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR} waiver deadline has not passed ` +
        `(${elapsed === null ? 'elapsed unknown' : `${elapsed} of ${advisoryConvergenceWaiverPrecondition.deadlineMinutes} minutes`}` +
        `, anchored on HEAD commit ${advisoryConvergenceWaiverPrecondition.headCommittedAt}); ` +
        'terminal Copilot unavailability was not evaluated here, so pass ' +
        '--allow-closed-precondition if that opener already applies',
    );
  }
  // #1905: --claimless binds the marker to the sentinel claim-id `none` and
  // the acting maintainer's own identity as agentId (there is no
  // issue-claim agentId to reuse when the PR carries no active claim by
  // design); the normal path binds to the linked issue's active claim, same
  // as before this change. `autoBootstrapImplicitClaimless` (#2657) reuses
  // this exact same `none` binding for the auto-bootstrap fallback case.
  const claimBinding =
    claimless || autoBootstrapImplicitClaimless
      ? actor
        ? { agentId: actor, claimId: 'none' }
        : null
      : linkedIssue.ok
        ? {
            agentId: linkedIssue.issue.activeClaim.agentId,
            claimId: linkedIssue.issue.activeClaim.claimId,
          }
        : null;
  const body =
    claimBinding &&
    requestedSelector &&
    reason &&
    expiresKnown &&
    String(pr.headRefOid ?? '').match(/^[0-9a-f]{40}$/i)
      ? renderExternalCheckWaiverComment({
          actor,
          agentId: claimBinding.agentId,
          claimId: claimBinding.claimId,
          headSha: String(pr.headRefOid ?? '').toLowerCase(),
          checkSelector: requestedSelector,
          reason,
          expiresAt,
          runId: autoBootstrap ? runId : undefined,
        })
      : '';
  return {
    mode: input?.mode === 'apply' ? 'apply' : 'dry-run',
    action: input?.mode === 'apply' ? 'create' : 'plan',
    canApply: blockingReasons.length === 0,
    repository: input?.repository ?? '',
    policy: {
      source: input?.policySource ?? '.github/idd/config.json',
      waiverMode:
        policy?.ciGate?.externalCheckWaivers?.mode ??
        EXTERNAL_CHECK_WAIVER_MODE_DISABLED,
      authorityPolicy:
        policy?.ciGate?.externalCheckWaivers?.authorityPolicy ??
        APPROVAL_ACTOR_POLICY_DEFAULT,
      maxValidity: policy?.ciGate?.externalCheckWaivers?.maxValidity ?? 'PT24H',
    },
    actor: authority,
    pr: {
      number: pr.number ?? 0,
      url: pr.url ?? '',
      state: String(pr.state ?? ''),
      headRefName: pr.headRefName ?? '',
      headRefOid: pr.headRefOid ?? '',
    },
    linkedIssue: linkedIssue.ok
      ? {
          number: linkedIssue.issue.number,
          url: linkedIssue.issue.url,
          activeClaim: linkedIssue.issue.activeClaim,
        }
      : null,
    requested: {
      selector: requestedSelector,
      matchMode: requestedMatchMode,
      reason,
      expiresAt,
    },
    checks: {
      total: normalizedChecks.length,
      matched: matchedChecks,
      matchedSelectors,
      uncoveredChecks,
    },
    blockingReasons,
    ...(advisoryConvergenceWaiverPrecondition
      ? { advisoryConvergenceWaiverPrecondition }
      : {}),
    body,
  };
}
/**
 * Resolves the effective actor login for authority evaluation: an explicit
 * programmatic override, else the CLI `--actor` flag, else the
 * authenticated `gh` viewer.
 *
 * Trims each candidate _before_ testing it for truthiness and picks the
 * first non-empty result, rather than a plain `a || b || c` chain -- a
 * whitespace-only candidate (for example a programmatic `options.actor`
 * override of `'   '`) is truthy as a raw string, so a post-trim `||`
 * chain would select it and then collapse it to `''` without ever
 * falling through to the next source. This also fixes the original bug
 * this helper exists for: the CLI flag spec gives `--actor` a parsed
 * default of `''` (not `undefined`), so `args.actor` is always a string
 * and is `''` whenever the flag is omitted -- a `??` chain would treat
 * that `''` as "provided" and never fall through to `viewerLogin`. No
 * other fallback chain in this file changes.
 */
export function resolveActorLogin(optionsActor, argsActor, viewerLogin) {
  return (
    [optionsActor, argsActor, viewerLogin]
      .map((actor) => actor?.trim() ?? '')
      .find(Boolean) ?? ''
  ).toLowerCase();
}
export async function runExternalCheckWaiver(options = {}) {
  const args = options.args ?? parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return { exitCode: 0 };
  }
  const repository =
    args.repo ||
    ghText([
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '--jq',
      '.nameWithOwner',
    ]);
  const { owner, name } = parseOwnerRepo(repository);
  const rawConfig = readJsonFile('.github/idd/config.json');
  const policy = normalizePolicyConfig(rawConfig);
  // kurone-kito/idd-skill#2657: `--auto-bootstrap` runs as a GitHub Actions
  // job authenticated via `GITHUB_TOKEN`, not an interactive human operator
  // -- `gh api user` has no meaningful identity to resolve there (and may
  // simply fail), and there is no authenticated viewer to require matching
  // `--actor` against. The actual GitHub comment author is whatever
  // `GITHUB_TOKEN` resolves to regardless of this string; it only feeds the
  // rendered marker's human-readable note.
  let actor;
  let authority;
  if (args.autoBootstrap) {
    actor = 'github-actions[bot]';
    authority = options.authority ?? {};
  } else {
    const viewerLogin = String(safeGhText(['api', 'user', '--jq', '.login']))
      .trim()
      .toLowerCase();
    actor = resolveActorLogin(options.actor, args.actor, viewerLogin);
    if (!actor) {
      throw new Error(
        'could not determine current GitHub user; ensure gh is authenticated',
      );
    }
    if (args.apply && args.actor && actor !== viewerLogin && viewerLogin) {
      throw new Error(
        `--actor ${args.actor} does not match the authenticated user ${viewerLogin}; omit --actor to use the authenticated identity`,
      );
    }
    authority =
      options.authority ??
      resolveCollaboratorAuthority({ owner, repo: name, actor });
  }
  const pr =
    options.pr ??
    fetchPullRequest({ owner, repo: name, prNumber: args.prNumber });
  const issueCandidates =
    options.issueCandidates ??
    options.resolveIssueCandidates?.() ??
    resolveLinkedIssueCandidates({
      owner,
      repo: name,
      rawConfig,
      // Auto-bootstrap has no human "viewer" identity to add as an extra
      // trusted login for resolving the linked issue's OWN claim markers
      // (`buildTrustedMarkerLogins` always trusts `viewerLogin` alongside
      // the repo owner and configured `trustedMarkerActors`) -- passing
      // the bot login here would be a no-op in practice (it never posts
      // issue claim markers) but is semantically wrong, so pass `''`.
      viewerLogin: args.autoBootstrap ? '' : actor,
      linkedIssues: pr.closingIssuesReferences,
      issueNumber: args.issueNumber,
      expectedClaimId: args.claimId,
      headRefName: pr.headRefName,
      prNumber: args.prNumber,
    });
  const resolvedHeadCommittedAt =
    options.headCommittedAt ??
    fetchHeadCommittedAt({
      owner,
      repo: name,
      headRefOid: String(pr.headRefOid ?? '').trim(),
    });
  // kurone-kito/idd-skill#2657: the fixed, bounded validity window
  // computed from the PR's own HEAD commit timestamp -- independent of
  // `advisoryWait.convergenceDeadline` (the 2026-09-10 self-cancellation
  // bug: a waiver with the same anchor and duration as `deadlinePassed`
  // is always already expired the moment `deadlinePassed` becomes true).
  // An unresolvable anchor yields '', which flows into
  // `planExternalCheckWaiver`'s existing, UNCHANGED
  // `if (!expiresKnown) blockingReasons.push(...)` check -- the same
  // fail-closed mechanism this file already relies on for an unresolvable
  // anchor elsewhere; deliberately not a `?? now()`-style fallback, which
  // would silently defeat that.
  const autoBootstrapExpiresAt = () => {
    const headMs = Date.parse(resolvedHeadCommittedAt);
    if (!Number.isFinite(headMs)) {
      return '';
    }
    const durationMs = parseIsoDurationToMs(
      SELF_REFERENTIAL_BOOTSTRAP_AUTO_EXPIRY,
    );
    if (!Number.isFinite(durationMs) || (durationMs ?? 0) <= 0) {
      return '';
    }
    // kurone-kito/idd-skill#2657 (Codex review, PR #2895): clamp to the
    // adopter's configured `ciGate.externalCheckWaivers.maxValidity` when it
    // is SHORTER than the fixed default above. Without this, an adopter who
    // configures a stricter maximum (e.g. `PT2H`) would have every
    // auto-bootstrap marker rejected by `planExternalCheckWaiver`'s own
    // `withinMaxValidity` check the instant it computes an expiry longer
    // than that configured ceiling, permanently blocking the self-waiver
    // path for that adopter. A configured value this helper cannot parse is
    // treated as absent -- `planExternalCheckWaiver` already fails closed on
    // an unparsable `maxValidity` elsewhere, so silently ignoring it here
    // only widens the window up to the untouched fixed default, never past
    // it.
    const configuredMaxValidityMs = parseIsoDurationToMs(
      policy.ciGate.externalCheckWaivers.maxValidity,
    );
    const clampedDurationMs =
      Number.isFinite(configuredMaxValidityMs) &&
      (configuredMaxValidityMs ?? 0) > 0
        ? Math.min(durationMs ?? 0, configuredMaxValidityMs ?? 0)
        : (durationMs ?? 0);
    // kurone-kito/idd-skill#2657 (CodeRabbit review, PR #2895): a
    // `pull_request_target` `reopened` trigger can fire with no new
    // commit, so `resolvedHeadCommittedAt` can be far older than "now"
    // (days, for a long-stale PR). Anchoring purely on that HEAD
    // timestamp would then compute an expiry already in the past, which
    // `planExternalCheckWaiver`'s own `expiry must be in the future`
    // check rejects -- silently blocking the auto-bootstrap post in
    // exactly the stale-reopen scenario the workflow's own trigger list
    // (`opened`/`reopened`/`synchronize`) invites. Fall back to
    // anchoring on "now" ONLY when the HEAD-anchored value would
    // already be non-future -- mirroring `expiresInFuture`'s own
    // strict `>` comparison exactly, so this never fires for the
    // ordinary case (HEAD and "now" only seconds/minutes apart, since
    // this runs moments after the triggering push). Anchoring on "now"
    // unconditionally would defeat the whole point of this waiver being
    // HEAD-anchored rather than now-anchored (the 2026-09-10
    // self-cancellation bug this design already avoids elsewhere).
    const headAnchoredExpiryMs = headMs + clampedDurationMs;
    const nowMs = (
      options.now instanceof Date ? options.now : new Date()
    ).getTime();
    const expiryMs =
      headAnchoredExpiryMs > nowMs
        ? headAnchoredExpiryMs
        : nowMs + clampedDurationMs;
    // Matches `resolveExpiryAt`'s own `--expires` (absolute) branch: strip
    // the millisecond suffix `toISOString()` always adds, for the same
    // whole-second canonical style every hand-authored/rendered timestamp
    // in this marker family already uses.
    return new Date(expiryMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  };
  const report = planExternalCheckWaiver(
    {
      mode: args.apply ? 'apply' : 'dry-run',
      repository: `${owner}/${name}`,
      policy,
      policySource: '.github/idd/config.json',
      actor,
      authority,
      pr,
      issueCandidates,
      issueNumber: args.issueNumber,
      expectedClaimId: args.claimId,
      requestedSelector: args.checkSelector,
      reason: args.reason,
      expiresAt: args.autoBootstrap
        ? autoBootstrapExpiresAt()
        : resolveExpiryAt({
            expiresAt: args.expiresAt,
            expiresIn: args.expiresIn,
            now: options.now instanceof Date ? options.now : new Date(),
          }),
      repoOwner: owner,
      claimless: args.claimless,
      headCommittedAt: resolvedHeadCommittedAt,
      allowClosedPrecondition: args.allowClosedPrecondition,
      autoBootstrap: args.autoBootstrap,
      runId: args.runId,
      // Read through the SAME validating reader the gate uses, not the raw
      // resolver: the gate rejects the whole `advisoryWait` section when any
      // sibling key is schema-invalid and falls back to the 24h default. A
      // resolver that skips that validation would report the configured value
      // where the gate reports the default, reproducing the very disagreement
      // this change removes.
      advisoryConvergenceDeadlineMinutes:
        readAdvisoryConvergenceDeadlineMinutes(),
    },
    { now: options.now, repoOwner: owner },
  );
  if (!args.apply) {
    renderReport(report, args.format);
    return { exitCode: 0, report };
  }
  if (!report.canApply) {
    // kurone-kito/idd-skill#2657 (Codex review, PR #2895): the
    // distributed template's own shipped `.github/idd/config.json`
    // omits `ciGate` entirely, so an adopter who hosts this workflow
    // without ALSO opting into `ciGate.externalCheckWaivers.mode:
    // "maintainer-authorized"` and registering this selector under
    // `ciGate.externalChecks.waivable` (a non-obvious co-requisite,
    // undocumented as required for this specific job) would otherwise
    // have this job fail on every single allowlisted-touching PR.
    // Treat that specific, adopter-configuration-only blocking shape as
    // a graceful no-op for `--auto-bootstrap` -- exit 0 with a clear
    // notice -- rather than a failed job; any OTHER blocking reason
    // (a genuine problem unrelated to this opt-in policy) still throws
    // exactly as before.
    const configOnlyBlockingReasons = new Set([
      'external-check waiver mode is disabled',
      'one or more matched checks are not configured as waivable external checks',
    ]);
    if (
      args.autoBootstrap &&
      report.blockingReasons.length > 0 &&
      report.blockingReasons.every((reason) =>
        configOnlyBlockingReasons.has(reason),
      )
    ) {
      process.stderr.write(
        `::notice::--auto-bootstrap skipped: this repository has not opted into ` +
          `ciGate.externalCheckWaivers.mode "maintainer-authorized" with this ` +
          `selector registered under ciGate.externalChecks.waivable, so the ` +
          `self-referential-bootstrap-auto waiver cannot be posted yet ` +
          `(${report.blockingReasons.join('; ')}). See docs/customization.md.\n`,
      );
      const skippedReport = { ...report, applied: false };
      renderReport(skippedReport, args.format);
      return { exitCode: 0, report: skippedReport };
    }
    renderReport(report, args.format);
    throw new Error(
      `external-check waiver apply blocked: ${report.blockingReasons.join('; ')}`,
    );
  }
  if (!report.body) {
    throw new Error(
      'external-check waiver apply blocked: canonical comment body is empty',
    );
  }
  const isTTY =
    options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!args.yes && !isTTY) {
    throw new Error(NON_TTY_APPLY_ERROR);
  }
  if (!args.yes) {
    renderReport(report, args.format);
    const ask = options.prompt ?? makeReadlinePrompt();
    const answer = await ask('Post external-check waiver comment? [y/N] ');
    ask.close?.();
    if (
      String(answer ?? '')
        .trim()
        .toLowerCase() !== 'y'
    ) {
      process.stdout.write('Aborted. No changes made.\n');
      return { exitCode: 0, report: { ...report, applied: false } };
    }
  }
  // #2328: appending is not idempotent, so look for an existing valid waiver
  // for this selector first. A repeated `--apply` previously posted a second
  // identical marker, leaving two live waivers on the pull request.
  // Repeatable: called again after the POST for the concurrency reconcile
  // below, so the second read observes anything that landed meanwhile.
  const readPrComments = () =>
    typeof options.prComments === 'function'
      ? options.prComments()
      : (options.prComments ??
        fetchPrComments({ owner, repo: name, prNumber: args.prNumber }));
  const prComments = readPrComments();
  // The marker this invocation would post is the exact context a reusable
  // waiver must match, so recover the HEAD and claim from it rather than
  // threading them separately and risking a mismatch.
  const wouldPost = parseExternalCheckWaiverComment(
    report.body,
    new Date().toISOString(),
  );
  // One evidence build for both the pre-write scan and the post-write
  // reconcile, so the two can never classify the same marker differently.
  const buildWaiverEvidence = (comments, binding) =>
    wouldPost
      ? summarizeExternalCheckWaivers(comments, {
          prHeadSha: wouldPost.headSha,
          activeClaimId: binding.claimId,
          // The gate accepts a waiver bound to the immediate predecessor
          // claim through its one-hop takeover exception. Omitting this
          // would classify such a waiver `wrongClaim` here and append a
          // second one after every takeover.
          activeClaimSupersedes: binding.supersedes,
          // Derived from the SAME snapshot being summarized, never from the
          // pre-write one. With collaborator-marker trust enabled, a
          // maintainer absent from the earlier read would otherwise be
          // classified unauthorized here while the gate — which derives
          // trust from the final comments — accepts their waiver, so the
          // reconcile would miss exactly the duplicate it exists to find.
          trustedMarkerLogins: [
            ...buildTrustedMarkerLogins({
              owner,
              repo: name,
              rawConfig,
              viewerLogin: actor,
              issueComments: comments,
            }),
          ],
          now: (options.now instanceof Date
            ? options.now
            : new Date()
          ).toISOString(),
          waivableSelectors: [
            ...normalizePolicyConfig(rawConfig).ciGate.externalChecks.waivable,
          ],
          maxValidity:
            normalizePolicyConfig(rawConfig).ciGate.externalCheckWaivers
              .maxValidity,
          mode: normalizePolicyConfig(rawConfig).ciGate.externalCheckWaivers
            .mode,
          // kurone-kito/idd-skill#2657 (Copilot review, PR #2895): without
          // this, `summarizeExternalCheckWaivers` excludes every
          // `self-referential-bootstrap-auto`-reasoned marker from EVERY
          // evidence bucket by default (its own doc comment) -- including
          // the one THIS invocation just posted. The pre-write call site
          // above never reaches this (its own ternary skips reuse-scanning
          // entirely for `--auto-bootstrap`), but the post-write reconcile
          // below runs for every mode, and is the ONLY concurrent-duplicate
          // detection `--auto-bootstrap` has (reuse-scanning is
          // intentionally disabled for it pre-write) -- leaving this unset
          // would make that reconcile permanently blind to concurrent
          // automatic posts, defeating its own stated purpose.
          allowSelfReferentialBootstrapAuto: args.autoBootstrap,
        })
      : null;
  // The marker this invocation would post defines the binding a reusable
  // waiver must share; the predecessor claim is accepted too, matching the
  // gate's one-hop takeover exception.
  const toAllowedClaimIds = (binding) =>
    [binding.claimId, binding.supersedes].filter(
      (value) => value && value !== 'none',
    );
  const preWriteBinding = {
    claimId: wouldPost?.claimId ?? '',
    supersedes: String(report.linkedIssue?.activeClaim?.supersedes ?? ''),
  };
  // kurone-kito/idd-skill#2657 (Codex review, PR #2895, round 2): the
  // generic reuse scan correlates on `reason` (now via `expectedReason`)
  // but never validates a candidate's `run-id:` against the Actions Runs
  // API the way the CONSUMER's `autoWaiverValid` check does. A
  // same-repository PR-controlled `pull_request` workflow with
  // `issues: write` could therefore prepost a same-selector,
  // same-claim/HEAD bot marker using the exact
  // `self-referential-bootstrap-auto` reason token but an absent or
  // unverifiable `run-id:`, which this reuse scan would still accept as
  // reusable -- causing the trusted `pull_request_target` posting job to
  // exit believing a valid waiver already exists, skip posting its own
  // run-bound marker, and leave the required check permanently red once
  // the consumer (correctly) rejects the unverifiable reused one.
  // Applying the same run-id/event-type trust checks here would require
  // this CLI to make its own Actions Runs API call and duplicate
  // `verifySelfReferentialBootstrapWaiverRun`; simpler and just as safe
  // (per the reviewer's own suggested alternative) is to disable generic
  // reuse entirely for this mode: this job runs once per relevant
  // trigger with a fresh `$GITHUB_RUN_ID` every time, so always
  // attempting to post is at worst a harmless extra marker (the
  // consumer's `autoWaiverValid` check already tolerates more than one
  // valid entry, taking any that verifies) -- never a missed post.
  const existingWaiver = args.autoBootstrap
    ? null
    : findReusableWaiverComment({
        comments: prComments,
        evidence: buildWaiverEvidence(prComments, preWriteBinding),
        checkSelector: report.requested.selector,
        expectedHeadSha: wouldPost?.headSha ?? '',
        allowedClaimIds: toAllowedClaimIds(preWriteBinding),
      });
  if (existingWaiver) {
    const reusedReport = {
      ...report,
      applied: false,
      reusedWaiver: existingWaiver,
      commentUrl: existingWaiver.commentUrl,
    };
    renderReport(reusedReport, args.format);
    return { exitCode: 0, report: reusedReport };
  }
  const result = options.postComment
    ? await options.postComment(args.prNumber, report.body)
    : ghJson([
        'api',
        `repos/${owner}/${name}/issues/${args.prNumber}/comments`,
        '--method',
        'POST',
        '-f',
        `body=${report.body}`,
      ]);
  // #2328 (review): the reuse check above and this POST are not one atomic
  // step, and GitHub comments have no compare-and-swap -- the same limitation
  // `idd-claim.instructions.md` records for claim markers. Two concurrent
  // `--apply` runs can therefore both observe no waiver and both post.
  // Reconcile after the fact the way the claim protocol does: re-read, and
  // when more than one valid waiver now exists for this selector, name them
  // all and identify the earliest, which is the one a deterministic reader
  // resolves to. Reporting rather than deleting -- removing a marker another
  // session just posted is not this helper's call to make.
  // ONE snapshot for both arguments. Two sequential reads would let a waiver
  // land between them, leaving `comments` older than `evidence`;
  // `collectValidWaiverComments` can only correlate entries it can find in
  // `comments`, so the newer marker would be dropped and the duplicate
  // silently missed — a snapshot mismatch inside the code that exists to
  // catch mismatches.
  //
  // Failing closed is right BEFORE the post, where an unreadable list can
  // cause a duplicate. After it the waiver already exists and the write is
  // irreversible, so throwing here would report a failed apply for work that
  // succeeded and would withhold the posted comment URL — pushing an operator
  // toward a retry that can only make things worse. Degrade to a warning and
  // still render the applied result; only duplicate detection is lost.
  let postWriteComments = [];
  let reconcileInconclusive = false;
  if (wouldPost) {
    try {
      postWriteComments = readPrComments();
    } catch (error) {
      reconcileInconclusive = true;
      process.stderr.write(
        `warning: the waiver was posted, but re-reading PR #${args.prNumber} comments failed, ` +
          `so a concurrent duplicate could not be ruled out: ${String(error?.message ?? error)}\n`,
      );
    }
  }
  // #2328 (review): re-resolve the claim for the reconcile rather than
  // reusing the pre-write binding. If a takeover lands between the two, the
  // gate resolves the successor with the predecessor as `supersedes` and
  // accepts BOTH waivers, while a summarizer still pinned to the predecessor
  // classifies the successor's as `wrongClaim` and reports no duplicate --
  // silence exactly where the operator most needs the warning. A failure to
  // re-resolve makes the reconcile inconclusive rather than wrong; the apply
  // itself already succeeded and is never retracted for this.
  let postWriteBinding = preWriteBinding;
  if (wouldPost && !reconcileInconclusive) {
    try {
      const refreshed = selectLinkedIssueCandidate(
        options.issueCandidates ??
          options.resolveIssueCandidates?.() ??
          resolveLinkedIssueCandidates({
            owner,
            repo: name,
            rawConfig,
            viewerLogin: actor,
            linkedIssues: pr.closingIssuesReferences,
            issueNumber: args.issueNumber,
            expectedClaimId: '',
            headRefName: pr.headRefName,
            prNumber: args.prNumber,
          }),
        {
          issueNumber: args.issueNumber,
          headRefName: String(pr.headRefName ?? ''),
        },
      );
      if (refreshed.ok) {
        postWriteBinding = {
          claimId: refreshed.issue.activeClaim.claimId,
          supersedes: String(refreshed.issue.activeClaim.supersedes ?? ''),
        };
      }
    } catch (error) {
      reconcileInconclusive = true;
      process.stderr.write(
        `warning: the waiver was posted, but re-resolving the active claim failed, ` +
          `so a concurrent duplicate could not be ruled out: ${String(error?.message ?? error)}\n`,
      );
    }
  }
  const concurrentWaivers =
    wouldPost && !reconcileInconclusive
      ? collectValidWaiverComments({
          comments: postWriteComments,
          evidence: buildWaiverEvidence(postWriteComments, postWriteBinding),
          checkSelector: report.requested.selector,
          expectedHeadSha: wouldPost?.headSha ?? '',
          allowedClaimIds: toAllowedClaimIds(postWriteBinding),
          expectedReason: args.autoBootstrap
            ? SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON
            : undefined,
        })
      : [];
  if (concurrentWaivers.length > 1) {
    const earliest = concurrentWaivers[0];
    process.stderr.write(
      `warning: ${concurrentWaivers.length} valid ${report.requested.selector} waivers now exist on PR #${args.prNumber} ` +
        `(comment ids ${concurrentWaivers.map((entry) => entry.commentId).join(', ')}). ` +
        `A concurrent apply raced this one. Readers resolve to the earliest, ${earliest?.commentId}; ` +
        'minimize the rest so a later session does not have to disambiguate.\n',
    );
  }
  const appliedReport = {
    ...report,
    applied: true,
    commentUrl: String(result.html_url ?? result.url ?? ''),
    ...(concurrentWaivers.length > 1 ? { concurrentWaivers } : {}),
    ...(reconcileInconclusive ? { reconcileInconclusive: true } : {}),
  };
  renderReport(appliedReport, args.format);
  return { exitCode: 0, report: appliedReport };
}
/**
 * #2328: the pull request's own issue comments, where waiver markers live.
 * Paginated so a long conversation cannot hide an existing waiver and cause
 * a duplicate to be appended.
 */
function fetchPrComments({ owner, repo, prNumber }) {
  // Never fail open: an unreadable list is not an empty one. Swallowing the
  // error would hide an existing waiver and let `--apply` append a duplicate,
  // which is the regression this change exists to remove.
  const payload = ghJson(
    ['api', '--paginate', `repos/${owner}/${repo}/issues/${prNumber}/comments`],
    true,
  );
  if (!Array.isArray(payload)) {
    throw new Error(
      `external-check waiver apply blocked: could not read PR #${prNumber} comments to check for an existing waiver`,
    );
  }
  return payload;
}
/**
 * #2328: find an existing valid waiver for this exact selector so a repeated
 * `--apply` reuses it instead of appending a second marker. Re-running the
 * same command posted a duplicate on pull request #2325, leaving two live
 * waivers a later session had to disambiguate by hand.
 *
 * Validity is not re-derived here: `summarizeExternalCheckWaivers` already
 * classifies every marker into valid / expired / wrong-HEAD / wrong-claim,
 * and both `pre-merge-readiness` and `advisory-convergence` read it. This
 * function only correlates a `valid` entry back to the comment that carried
 * it, so an expired, wrong-HEAD, or wrong-claim waiver is never reused —
 * it simply never appears in `evidence.valid`.
 *
 * The earliest matching comment wins, mirroring the release-marker path's
 * reuse-the-earliest rule, so a retry converges on one marker rather than
 * picking a different one each pass.
 */
export function findReusableWaiverComment(input) {
  return collectValidWaiverComments(input)[0] ?? null;
}
/**
 * #2328 (review): every valid waiver for one selector, earliest first. The
 * reuse scan takes the first; the post-write reconcile uses the whole list to
 * detect a concurrent apply that raced this one. Sharing this function keeps
 * the two from classifying the same marker differently.
 */
export function collectValidWaiverComments({
  comments,
  evidence,
  checkSelector,
  expectedHeadSha = '',
  allowedClaimIds = [],
  expectedReason = '',
}) {
  const selector = String(checkSelector ?? '').trim();
  if (!selector) return [];
  const validForSelector = (evidence?.valid ?? []).filter(
    (entry) => entry.checkSelector === selector,
  );
  if (validForSelector.length === 0) return [];
  const ordered = [...(comments ?? [])].sort((left, right) =>
    String(left?.created_at ?? '').localeCompare(
      String(right?.created_at ?? ''),
    ),
  );
  const found = [];
  for (const comment of ordered) {
    const parsed = parseExternalCheckWaiverComment(
      String(comment?.body ?? ''),
      String(comment?.created_at ?? ''),
    );
    if (!parsed || parsed.checkSelector !== selector) continue;
    // kurone-kito/idd-skill#2657 (Codex review, PR #2895): reject a
    // candidate whose OWN `reason:` token does not match the expected one
    // before it ever reaches `matchesValidEntry` below -- see the
    // `expectedReason` doc comment above for why this must be checked
    // against the comment's own parsed field, not only via the evidence
    // entry's `reason`, which a forged same-second marker could still
    // share.
    const normalizedExpectedReason = String(expectedReason ?? '').trim();
    if (
      normalizedExpectedReason &&
      String(parsed.reason ?? '').trim() !== normalizedExpectedReason
    ) {
      continue;
    }
    // #2328 (review): correlate on EVERY field the evidence entry carries,
    // not just expiry and timestamp. `created_at` has second resolution, so a
    // valid maintainer waiver and an unauthorized, wrong-HEAD, or wrong-claim
    // marker posted in the same second would otherwise both correlate to the
    // single valid entry — letting the reuse path report the invalid comment
    // as authoritative, and the reconcile invent a duplicate and point the
    // operator at the genuinely valid marker to minimize.
    const commentAuthorLogin = String(
      comment?.author?.login ?? comment?.user?.login ?? '',
    )
      .trim()
      .toLowerCase();
    // The evidence entry carries no HEAD or claim binding, so those are
    // checked against the expected values directly. Without this a
    // wrong-HEAD or wrong-claim marker sharing all four entry fields with a
    // genuinely valid sibling would still correlate.
    const normalizedHead = String(expectedHeadSha ?? '')
      .trim()
      .toLowerCase();
    if (
      normalizedHead &&
      String(parsed.headSha ?? '')
        .trim()
        .toLowerCase() !== normalizedHead
    ) {
      continue;
    }
    const acceptedClaimIds = (allowedClaimIds ?? [])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0);
    if (
      acceptedClaimIds.length > 0 &&
      !acceptedClaimIds.includes(String(parsed.claimId ?? '').trim())
    ) {
      continue;
    }
    const matchesValidEntry = validForSelector.some(
      (entry) =>
        entry.authorLogin === commentAuthorLogin &&
        entry.reason === parsed.reason &&
        entry.expiresAt === parsed.expiresAt &&
        entry.createdAt === parsed.createdAt,
    );
    if (!matchesValidEntry) continue;
    found.push({
      commentId: String(comment?.id ?? ''),
      commentUrl: String(comment?.html_url ?? comment?.url ?? ''),
      checkSelector: selector,
      expiresAt: parsed.expiresAt,
    });
  }
  return found;
}
function selectorRequestsGlob(selector) {
  return /[*]/.test(String(selector ?? ''));
}
function selectLinkedIssueCandidate(issueCandidates, options = {}) {
  const filtered = issueCandidates.filter((candidate) => {
    if (options.issueNumber && candidate.number !== options.issueNumber) {
      return false;
    }
    if (candidate.activeClaim?.branch !== options.headRefName) {
      return false;
    }
    if (
      options.expectedClaimId &&
      candidate.activeClaim?.claimId !== options.expectedClaimId
    ) {
      return false;
    }
    return Boolean(candidate.activeClaim);
  });
  if (filtered.length === 1) {
    return {
      ok: true,
      issue: filtered[0],
      reason: '',
    };
  }
  if (filtered.length === 0) {
    return {
      ok: false,
      issue: null,
      reason:
        'could not resolve a single active linked issue claim on the PR branch',
      candidateCount: 0,
    };
  }
  return {
    ok: false,
    issue: null,
    reason:
      'multiple linked issues expose active claims on the PR branch; rerun with --issue and --claim-id',
    candidateCount: filtered.length,
  };
}
function normalizeChecks(statusCheckRollup = []) {
  return (statusCheckRollup ?? [])
    .map((entry) => {
      if (entry?.__typename === 'StatusContext') {
        const rawState = String(entry.state ?? '')
          .trim()
          .toLowerCase();
        return {
          type: 'status-context',
          name: String(entry.context ?? '').trim(),
          state: rawState,
          successLike: SUCCESS_LIKE_CHECK_STATES.has(rawState),
          pending: PENDING_CHECK_STATES.has(rawState),
          url: String(entry.targetUrl ?? ''),
        };
      }
      const status = String(entry?.status ?? '')
        .trim()
        .toLowerCase();
      const conclusion = String(entry?.conclusion ?? '')
        .trim()
        .toLowerCase();
      const state =
        status === 'completed' ? conclusion || 'unknown' : status || 'unknown';
      return {
        type: 'check-run',
        name: String(entry?.name ?? '').trim(),
        state,
        successLike: SUCCESS_LIKE_CHECK_STATES.has(state),
        pending: PENDING_CHECK_STATES.has(state),
        url: String(entry?.detailsUrl ?? ''),
        workflowName: String(entry?.workflowName ?? ''),
      };
    })
    .filter((entry) => entry.name);
}
/**
 * Exported for reuse by `provider-outage-declaration.mts` (#2320), which
 * evaluates actor authority under the exact same
 * `ciGate.externalCheckWaivers.authorityPolicy` -- reusing this function
 * keeps a single trust path rather than growing a second, subtly divergent
 * one.
 */
export function normalizeAuthorityEvidence(evidence, actor, repoOwner, policy) {
  const normalizedPolicy = APPROVAL_ACTOR_POLICIES.has(policy)
    ? policy
    : APPROVAL_ACTOR_POLICY_DEFAULT;
  const roleName = String(
    evidence?.roleName ??
      evidence?.role_name ??
      evidence?.user?.role_name ??
      '',
  )
    .trim()
    .toLowerCase();
  const permission = String(evidence?.permission ?? evidence?.permissions ?? '')
    .trim()
    .toLowerCase();
  const known =
    evidence?.known !== false &&
    (roleName.length > 0 ||
      permission.length > 0 ||
      actor === repoOwner.toLowerCase());
  const isOwner = actor === repoOwner.toLowerCase();
  let authorized = false;
  if (isOwner) {
    authorized = true;
  } else if (normalizedPolicy === 'all-write-permission-actors') {
    authorized =
      roleName === 'admin' ||
      roleName === 'maintain' ||
      roleName === 'write' ||
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write';
  } else {
    authorized =
      roleName === 'admin' ||
      roleName === 'maintain' ||
      permission === 'admin' ||
      permission === 'maintain';
  }
  const error = known
    ? ''
    : String(
        evidence?.error ??
          'authority lookup did not return role-aware permission evidence',
      );
  return {
    actor,
    policy: normalizedPolicy,
    known,
    authorized,
    isOwner,
    permission,
    roleName,
    error,
  };
}
function resolveExpiryAt({ expiresAt, expiresIn, now }) {
  const hasExpiresAt = Boolean(String(expiresAt ?? '').trim());
  const hasExpiresIn = Boolean(String(expiresIn ?? '').trim());
  if (hasExpiresAt === hasExpiresIn) {
    throw new Error('specify exactly one of --expires or --expires-in');
  }
  if (hasExpiresAt) {
    const parsed = new Date(String(expiresAt).trim());
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error(`invalid --expires value: ${expiresAt}`);
    }
    return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const durationMs = parseIsoDurationToMs(String(expiresIn).trim());
  if (!Number.isFinite(durationMs) || (durationMs ?? 0) <= 0) {
    throw new Error(`invalid --expires-in value: ${expiresIn}`);
  }
  return new Date(now.getTime() + (durationMs ?? 0)).toISOString();
}
function resolveLinkedIssueCandidates({
  owner,
  repo,
  rawConfig,
  viewerLogin,
  linkedIssues,
  issueNumber,
  expectedClaimId,
  headRefName,
  prNumber,
}) {
  const issueRefs = (linkedIssues ?? []).filter((issue) => {
    return !issueNumber || Number(issue.number) === issueNumber;
  });
  const results = [];
  for (const issue of issueRefs) {
    const comments = ghJson(
      [
        'api',
        '--paginate',
        `repos/${owner}/${repo}/issues/${issue.number}/comments`,
      ],
      true,
    );
    const trustedMarkerLogins = buildTrustedMarkerLogins({
      owner,
      repo,
      rawConfig,
      viewerLogin,
      issueComments: comments,
    });
    const forcedHandoffAuthorityPolicy =
      normalizePolicyConfig(rawConfig).forcedHandoff.authorityPolicy;
    const expectedLinkedPrs = prNumber ? [String(prNumber)] : [];
    const activeClaim = resolveHelperActiveClaim(
      comments,
      [...trustedMarkerLogins],
      {
        expectedLinkedPrs,
        isAuthorizedForcedHandoff: (fhActor) => {
          const auth = resolveCollaboratorAuthority({
            owner,
            repo,
            actor: fhActor,
          });
          if (forcedHandoffAuthorityPolicy === 'all-write-permission-actors') {
            return (
              auth.permission === 'admin' ||
              auth.permission === 'maintain' ||
              auth.permission === 'write'
            );
          }
          return auth.permission === 'admin' || auth.permission === 'maintain';
        },
      },
    );
    if (!activeClaim) {
      results.push({
        number: issue.number,
        url: issue.url,
        activeClaim: null,
      });
      continue;
    }
    if (expectedClaimId && activeClaim.claimId !== expectedClaimId) {
      results.push({
        number: issue.number,
        url: issue.url,
        activeClaim: null,
      });
      continue;
    }
    if (headRefName && activeClaim.branch !== headRefName) {
      results.push({
        number: issue.number,
        url: issue.url,
        activeClaim: null,
      });
      continue;
    }
    results.push({
      number: issue.number,
      url: issue.url,
      activeClaim,
    });
  }
  return results;
}
function fetchPullRequest({ owner, repo, prNumber }) {
  return ghJson([
    'pr',
    'view',
    String(prNumber),
    '--repo',
    `${owner}/${repo}`,
    '--json',
    'number,state,url,headRefName,headRefOid,statusCheckRollup,closingIssuesReferences',
  ]);
}
/**
 * #2328: the HEAD commit's own `committer.date`, the anchor the
 * `idd-advisory-convergence` waiver deadline is measured from. Returns an
 * empty string on any failure — a missing anchor keeps the hatch shut, which
 * is the safe direction, and never blocks a selector that is not
 * precondition-gated.
 */
function fetchHeadCommittedAt({ owner, repo, headRefOid }) {
  if (!headRefOid) return '';
  try {
    const payload = ghJson([
      'api',
      `repos/${owner}/${repo}/commits/${headRefOid}`,
    ]);
    return String(payload?.commit?.committer?.date ?? '').trim();
  } catch {
    return '';
  }
}
/** Exported for reuse by `provider-outage-declaration.mts` (#2320); see the doc comment on {@link normalizeAuthorityEvidence}. */
export function resolveCollaboratorAuthority({ owner, repo, actor }) {
  const normalized = String(actor ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return {
      known: false,
      authorized: false,
      permission: '',
      roleName: '',
      error: 'empty actor',
    };
  }
  const result = ghApiJsonWithStatus(
    `repos/${owner}/${repo}/collaborators/${encodeURIComponent(normalized)}/permission`,
  );
  if (result.status === 404) {
    return {
      known: true,
      authorized: false,
      permission: 'none',
      roleName: '',
      error: '',
    };
  }
  if (result.status !== 200) {
    return {
      known: false,
      authorized: false,
      permission: '',
      roleName: '',
      error: `authority lookup failed: ${result.status}`,
    };
  }
  return {
    known: true,
    authorized: false,
    permission: String(result.body?.permission ?? '')
      .trim()
      .toLowerCase(),
    roleName: String(
      result.body?.role_name ?? result.body?.user?.role_name ?? '',
    )
      .trim()
      .toLowerCase(),
    error: '',
  };
}
export function buildTrustedMarkerLogins({
  owner,
  repo,
  rawConfig,
  viewerLogin,
  issueComments,
}) {
  const trusted = new Set(
    [
      owner,
      viewerLogin,
      ...readTrustedMarkerActors(rawConfig),
      ...splitCsv(process.env.IDD_TRUSTED_MARKER_ACTORS),
    ]
      .filter(Boolean)
      .map((login) => login.toLowerCase()),
  );
  if (
    !resolveCollaboratorMarkerTrust(
      rawConfig,
      process.env.IDD_TRUST_COLLABORATOR_MARKERS,
    )
  ) {
    return trusted;
  }
  // #1693: marker-authors-first -- only comment authors whose comment is
  // itself operational-marker-shaped are permission-checked, matching
  // pre-merge-readiness.mts / advisory-convergence.mts /
  // advisory-wait-state.mts (and force-handoff.mts as of this change).
  // Checking every unique comment author (the prior local loop here)
  // over-trusted ordinary commenters.
  for (const login of resolveTrustedCollaboratorMarkerLogins(
    owner,
    repo,
    issueComments ?? [],
  )) {
    trusted.add(login);
  }
  return trusted;
}
function readTrustedMarkerActors(rawConfig) {
  const actors = rawConfig?.trustedMarkerActors;
  if (!Array.isArray(actors)) {
    return [];
  }
  return actors
    .map(String)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}
function ghJson(args, slurp = false) {
  const finalArgs = [...args];
  if (slurp) {
    finalArgs.splice(1, 0, '--jq', '.[]');
    return parsePaginatedGhNdjson(
      ghText(finalArgs, { timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS }),
    );
  }
  return JSON.parse(ghText(finalArgs));
}
/**
 * Pure derivation step for {@link ghApiJsonWithStatus}'s catch branch,
 * exported so tests can inject an error shape directly instead of shelling
 * out to a real `gh` invocation (matching the mock-free-subprocess
 * convention documented in `tests/collaborator-permission.test.mts`).
 *
 * #1693: derives the real HTTP status via the shared gh-http-status.mts
 * helpers (stderr `(HTTP NNN)` pattern, then a JSON-body `"status"` field
 * fallback across stderr/stdout/message) instead of the prior local
 * `extractGhHttpStatus`, which fell back to the child-process exit code
 * when no HTTP-status text was found -- `gh` exits 1 for 401/403/404
 * alike, so that fallback could misreport a 404 or an auth failure as
 * "status 1". `deriveGhHttpStatus` returns null (not 0) when no status can
 * be determined at all; 500 preserves this function's existing
 * "definitely not 200, not 404" fail-closed fallback for that case.
 */
export function deriveGhApiStatusFromError(error) {
  const status = deriveGhHttpStatus(error);
  return {
    status: status ?? 500,
    body: {},
  };
}
function ghApiJsonWithStatus(path) {
  try {
    return {
      status: 200,
      body: JSON.parse(ghText(['api', path])),
    };
  } catch (error) {
    return deriveGhApiStatusFromError(error);
  }
}
function renderReport(report, format) {
  if (format === 'text') {
    process.stdout.write(renderTextReport(report));
    return;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
function renderTextReport(report) {
  const matchedChecks =
    report.checks.matched
      .map((check) => `${check.name}=${check.state}`)
      .join(', ') || 'none';
  const blockers =
    report.blockingReasons.length > 0
      ? report.blockingReasons.map((reason) => `- ${reason}`).join('\n')
      : '- none';
  return [
    `mode: ${report.mode}`,
    `canApply: ${report.canApply}`,
    `pr: #${report.pr.number} ${report.pr.url}`,
    `head: ${report.pr.headRefOid}`,
    `linkedIssue: ${report.linkedIssue ? `#${report.linkedIssue.number}` : 'none'}`,
    `claim: ${report.linkedIssue?.activeClaim ? `${report.linkedIssue.activeClaim.agentId} / ${report.linkedIssue.activeClaim.claimId}` : 'none'}`,
    `actor: ${report.actor.actor} (${report.actor.roleName || report.actor.permission || 'unknown'})`,
    `requestedCheck: ${report.requested.selector}`,
    `matchedChecks: ${matchedChecks}`,
    `expiresAt: ${report.requested.expiresAt}`,
    'blockingReasons:',
    blockers,
    '',
    'body:',
    report.body || '<none>',
    '',
  ].join('\n');
}
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
const EXTERNAL_CHECK_WAIVER_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--issue': { type: 'string' },
  '--claim-id': { type: 'string', default: '' },
  '--check': { type: 'string', default: '' },
  '--reason': { type: 'string', default: '' },
  '--expires': { type: 'string', default: '' },
  '--expires-in': { type: 'string', default: '' },
  '--actor': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--apply': { type: 'boolean', default: false },
  '--yes': { type: 'boolean', default: false },
  '--format': { type: 'string', default: 'json' },
  '--claimless': { type: 'boolean', default: false },
  '--allow-closed-precondition': { type: 'boolean', default: false },
  '--auto-bootstrap': { type: 'boolean', default: false },
  '--run-id': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
};
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, EXTERNAL_CHECK_WAIVER_FLAG_SPEC);
  const format = values.format.trim();
  if (format !== 'json' && format !== 'text') {
    throw new Error(`unsupported --format value: ${format}`);
  }
  const parsed = {
    // parsePositiveInteger keeps its existing throw-on-invalid contract
    // and message shape unchanged; only called when the flag is actually
    // present, matching the original "absent --pr/--issue stays 0,
    // untouched" behavior (checked below via the "missing required"
    // guard, same as before this migration).
    prNumber:
      values.pr === undefined ? 0 : parsePositiveInteger(values.pr, '--pr'),
    issueNumber:
      values.issue === undefined
        ? 0
        : parsePositiveInteger(values.issue, '--issue'),
    claimId: values['claim-id'].trim(),
    checkSelector: values.check.trim(),
    reason: values.reason.trim(),
    expiresAt: values.expires.trim(),
    expiresIn: values['expires-in'].trim(),
    actor: values.actor.trim(),
    repo: values.repo.trim(),
    apply: values.apply,
    yes: values.yes,
    format,
    claimless: values.claimless,
    allowClosedPrecondition: values['allow-closed-precondition'],
    autoBootstrap: values['auto-bootstrap'],
    runId: values['run-id'].trim(),
    help,
  };
  if (!parsed.help) {
    if (!parsed.prNumber) {
      throw new Error('missing required --pr <number> argument');
    }
    if (!parsed.checkSelector) {
      throw new Error('missing required --check <selector> argument');
    }
    if (!parsed.reason) {
      throw new Error('missing required --reason <text> argument');
    }
    // #1905: --claimless renders claim-id `none` directly -- it never
    // resolves a linked issue's active claim, so combining it with --issue
    // or --claim-id is contradictory and almost certainly an operator
    // mistake (one flag says "there is no claim", the other says "resolve
    // this specific one").
    if (parsed.claimless && parsed.issueNumber) {
      throw new Error('--claimless cannot be combined with --issue');
    }
    if (parsed.claimless && parsed.claimId) {
      throw new Error('--claimless cannot be combined with --claim-id');
    }
    // kurone-kito/idd-skill#2657: --auto-bootstrap always resolves a real
    // linked-issue claim (never claimless), always requires --run-id, and
    // always computes --expires internally as the PR's HEAD commit
    // timestamp plus the fixed SELF_REFERENTIAL_BOOTSTRAP_AUTO_EXPIRY
    // duration -- independent of `advisoryWait.convergenceDeadline` --
    // rather than trusting a caller-supplied expiry. --reason is still a
    // required, visible flag in the workflow invocation (for auditability),
    // but must equal the dedicated token exactly; planExternalCheckWaiver
    // enforces this same invariant again as a blocking reason, in case a
    // future caller constructs the plan input directly instead of through
    // this CLI.
    if (parsed.autoBootstrap) {
      if (parsed.claimless) {
        throw new Error('--auto-bootstrap cannot be combined with --claimless');
      }
      if (!parsed.runId) {
        throw new Error('--auto-bootstrap requires --run-id <id>');
      }
      if (parsed.reason !== SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON) {
        throw new Error(
          `--auto-bootstrap requires --reason ${SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON}`,
        );
      }
      if (parsed.expiresAt || parsed.expiresIn) {
        throw new Error(
          '--auto-bootstrap computes --expires internally; do not pass --expires or --expires-in',
        );
      }
    }
  }
  return parsed;
}
function parseOwnerRepo(value) {
  const repo = String(value ?? '').trim();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`invalid --repo value: ${value} (expected owner/name)`);
  }
  return { owner: match[1], name: match[2] };
}
function parsePositiveInteger(value, flag) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return Number(raw);
}
function splitCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
function printUsage() {
  process.stdout.write(`usage: node scripts/external-check-waiver.mjs --pr <number> --check <selector> --reason <text> (--expires <iso8601> | --expires-in <duration>) [options]

Options:
  --issue <number>                  linked issue to use for active claim resolution
  --claim-id <id>                   require the resolved active claim to match this claim id
  --claimless                       render a claimless waiver (claim-id "none") instead of
                                     resolving a linked issue's active claim; for a PR with
                                     no IDD claim at all (e.g. Dependabot). Cannot combine
                                     with --issue or --claim-id.
  --allow-closed-precondition       post an idd-advisory-convergence waiver even though its
                                     deadline has not passed. The marker stays inert until a
                                     precondition opens; use it when terminal Copilot
                                     unavailability already applies, which this helper does
                                     not evaluate.
  --auto-bootstrap                  render the CI-workflow-posted, run-bound
                                     self-referential-bootstrap-auto waiver instead of an
                                     ordinary maintainer-authorized one: skips the actor
                                     authority check entirely, bypasses the deadline-hatch
                                     precondition, and requires --run-id and --reason
                                     self-referential-bootstrap-auto exactly. --expires and
                                     --expires-in are computed internally and must be
                                     omitted. Cannot combine with --claimless.
  --run-id <id>                     the posting GitHub Actions run's own GITHUB_RUN_ID;
                                     required with --auto-bootstrap.
  --actor <login>                   override the GitHub actor used for authority evaluation
  --repo <owner/name>               repository override
  --apply                           post the canonical waiver comment after validation
  --yes                             skip the interactive apply confirmation
  --format <json|text>              output format (default: json)
  --help                            show this message
`);
}
export async function main(argv = process.argv.slice(2)) {
  const result = await runExternalCheckWaiver({ args: parseArgs(argv) });
  process.exit(result.exitCode);
}
if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  });
}
