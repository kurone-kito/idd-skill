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
} from './advisory-wait-policy.mts';
import { parseCliArgs } from './cli-args.mts';
import { resolveTrustedCollaboratorMarkerLogins } from './collaborator-permission.mts';
import { resolveHelperActiveClaim } from './forced-handoff-marker.mts';
import {
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  ghText,
  safeGhText,
} from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mts';
import type {
  ClaimValidationSummary,
  ExternalCheckWaiverEvidence,
} from './protocol-helpers.mts';
import {
  parseExternalCheckWaiverComment,
  parsePaginatedGhNdjson,
  renderExternalCheckWaiverComment,
  summarizeExternalCheckWaivers,
} from './protocol-helpers.mts';
import type { PromptFn } from './readline-prompt.mts';
import { makeReadlinePrompt } from './readline-prompt.mts';

/** Normalized policy object returned by {@link normalizePolicyConfig}. */
type NormalizedPolicy = ReturnType<typeof normalizePolicyConfig>;

/** Waivable external-check selector entry from the normalized policy. */
type WaivableSelector =
  NormalizedPolicy['ciGate']['externalChecks']['waivable'][number];

/** Active claim resolved from the trusted claim-marker stream. */
type ActiveClaim = ClaimValidationSummary['activeClaim'];

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  body?: string | null;
  created_at?: string | null;
  user?: GhAuthorPayload | null;
  author?: GhAuthorPayload | null;
}

/** Status-check rollup entry from `gh pr view --json statusCheckRollup`. */
interface StatusCheckRollupEntry {
  __typename?: string | null;
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
  status?: string | null;
  conclusion?: string | null;
  name?: string | null;
  detailsUrl?: string | null;
  workflowName?: string | null;
}

/** Linked issue reference from `closingIssuesReferences`. */
interface LinkedIssueRefPayload {
  number?: number | null;
  url?: string | null;
}

/** Pull-request payload fields consumed by this helper. */
interface PrPayload {
  number?: number | null;
  url?: string | null;
  state?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  statusCheckRollup?: StatusCheckRollupEntry[] | null;
  closingIssuesReferences?: LinkedIssueRefPayload[] | null;
}

/** Linked-issue candidate with its resolved active claim (or null). */
interface IssueCandidatePayload {
  number?: number | null;
  url?: string | null;
  activeClaim?: ActiveClaim | null;
}

/** Linked-issue candidate narrowed to a present active claim. */
interface LinkedIssueWithClaim {
  number?: number | null;
  url?: string | null;
  activeClaim: ActiveClaim;
}

/** Result of {@link selectLinkedIssueCandidate}. */
type LinkedIssueSelection =
  | { ok: true; issue: LinkedIssueWithClaim; reason: string }
  | { ok: false; issue: null; reason: string };

/** Raw authority evidence accepted by {@link normalizeAuthorityEvidence}. */
export interface AuthorityEvidenceInput {
  known?: boolean;
  roleName?: unknown;
  role_name?: unknown;
  user?: { role_name?: unknown } | null;
  permission?: unknown;
  permissions?: unknown;
  error?: unknown;
}

/** Normalized authority evidence emitted in the plan report. */
export interface AuthorityEvidence {
  actor: string;
  policy: string;
  known: boolean;
  authorized: boolean;
  isOwner: boolean;
  permission: string;
  roleName: string;
  error: string;
}

/** Collaborator authority lookup result. */
export interface CollaboratorAuthority {
  known: boolean;
  authorized: boolean;
  permission: string;
  roleName: string;
  error: string;
}

/** Normalized PR check entry derived from the status-check rollup. */
interface NormalizedCheck {
  type: string;
  name: string;
  state: string;
  successLike: boolean;
  pending: boolean;
  url: string;
  workflowName?: string;
}

/** Inputs accepted by {@link planExternalCheckWaiver}. */
interface ExternalCheckWaiverPlanInput {
  mode?: string;
  repository?: string;
  policy?: NormalizedPolicy;
  policySource?: string;
  actor?: string;
  authority?: AuthorityEvidenceInput;
  pr?: PrPayload;
  issueCandidates?: IssueCandidatePayload[];
  issueNumber?: number;
  expectedClaimId?: string;
  requestedSelector?: string;
  reason?: string;
  expiresAt?: string;
  repoOwner?: string;
  /**
   * #2328: the current HEAD commit's own timestamp, the anchor the
   * `idd-advisory-convergence` waiver deadline is measured from. Absent or
   * unparseable keeps the hatch shut, which is the safe direction.
   */
  headCommittedAt?: string;
  /**
   * #2328: the configured `advisoryWait.convergenceDeadline` in minutes.
   * Supplied by the caller from the RAW policy document, exactly as
   * `pre-merge-readiness` receives it: `normalizePolicyConfig` does not carry
   * `convergenceDeadline` through, so reading it off the normalized policy
   * would silently substitute the 24h default for a repository that
   * configured something shorter.
   */
  advisoryConvergenceDeadlineMinutes?: number;
  /**
   * #2328: post an `idd-advisory-convergence` waiver even though its hatch
   * has not opened. The marker is inert until the hatch opens, so this is
   * for an operator who knows the terminal opener applies -- which this
   * helper does not evaluate.
   */
  allowClosedPrecondition?: boolean;
  /**
   * #1905: render a claimless waiver -- claim-id `none` -- instead of
   * resolving the claim-id from a linked issue's active IDD claim. Skips
   * the linked-issue-claim requirement entirely; blocks instead when a
   * resolvable active claim IS found, since a claimless waiver only ever
   * satisfies `summarizeExternalCheckWaivers` on a PR with no active
   * claim, so posting one against a claimed PR would just be rejected as
   * `wrongClaim` at the merge gate.
   */
  claimless?: boolean;
}

/** Structured waiver plan report. */
interface ExternalCheckWaiverReport {
  mode: string;
  action: string;
  canApply: boolean;
  repository: string;
  policy: {
    source: string;
    waiverMode: string;
    authorityPolicy: string;
    maxValidity: string;
  };
  actor: AuthorityEvidence;
  pr: {
    number: number;
    url: string;
    state: string;
    headRefName: string;
    headRefOid: string;
  };
  linkedIssue: {
    number?: number | null;
    url?: string | null;
    activeClaim: ActiveClaim;
  } | null;
  requested: {
    selector: string;
    matchMode: string;
    reason: string;
    expiresAt: string;
  };
  checks: {
    total: number;
    matched: NormalizedCheck[];
    matchedSelectors: WaivableSelector[];
    uncoveredChecks: NormalizedCheck[];
  };
  blockingReasons: string[];
  /**
   * #2328: present only for the precondition-gated
   * `idd-advisory-convergence` selector. `terminalUnavailable` is always
   * `false` here: this helper evaluates the deadline opener only, so a
   * closed verdict means "the deadline has not passed", never "no opener
   * applies".
   */
  advisoryConvergenceWaiverPrecondition?: {
    checkSelector: string;
    deadlineMinutes: number;
    headCommittedAt: string;
    elapsedMinutes: number | null;
    deadlinePassed: boolean;
    terminalUnavailable: boolean;
    open: boolean;
    terminalEvaluated: boolean;
  };
  body: string;
  applied?: boolean;
  commentUrl?: string;
  /**
   * #2328: set when `--apply` found an existing valid waiver for this
   * selector and reused it rather than appending a second marker.
   */
  reusedWaiver?: ReusableWaiver;
  /**
   * #2328 (review): every valid waiver for this selector after the POST,
   * present only when a concurrent apply raced this one into a duplicate.
   */
  concurrentWaivers?: ReusableWaiver[];
  /**
   * #2328 (review): the waiver was posted, but the post-write re-read failed,
   * so a concurrent duplicate could not be ruled out. The apply still
   * succeeded — only the reconcile is unknown.
   */
  reconcileInconclusive?: boolean;
}

/** Parsed CLI arguments. */
interface ExternalCheckWaiverArgs {
  prNumber: number;
  issueNumber: number;
  claimId: string;
  checkSelector: string;
  reason: string;
  expiresAt: string;
  expiresIn: string;
  actor: string;
  repo: string;
  apply: boolean;
  yes: boolean;
  format: string;
  claimless: boolean;
  allowClosedPrecondition: boolean;
  help: boolean;
}

/** Posted-comment payload fields consumed by this helper. */
interface PostedCommentPayload {
  html_url?: string | null;
  url?: string | null;
}

/** GitHub API call result with a parsed JSON body and HTTP status. */
interface GhApiStatusResult {
  status: number;
  body: {
    permission?: unknown;
    role_name?: unknown;
    user?: { role_name?: unknown } | null;
  };
}

/** Options accepted by {@link runExternalCheckWaiver}. */
interface RunExternalCheckWaiverOptions {
  args?: ExternalCheckWaiverArgs;
  actor?: string;
  authority?: AuthorityEvidenceInput;
  pr?: PrPayload;
  issueCandidates?: IssueCandidatePayload[];
  now?: Date;
  isTTY?: boolean;
  prompt?: PromptFn;
  /**
   * #2328: injected PR issue comments for the reuse scan under test. A
   * function is called, so a test can exercise the fail-closed path by
   * throwing from it.
   */
  prComments?: WaiverCommentPayload[] | (() => WaiverCommentPayload[]);
  /** #2328: injected HEAD commit timestamp, so tests skip the commit read. */
  headCommittedAt?: string;
  /**
   * #2328 (review): injected linked-issue resolver, called once before the
   * post and once for the reconcile, so a test can model a takeover landing
   * between them.
   */
  resolveIssueCandidates?: () => IssueCandidatePayload[];
  postComment?: (
    prNumber: number,
    body: string,
  ) => Promise<PostedCommentPayload> | PostedCommentPayload;
}

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

export function matchCheckSelector(
  name: unknown,
  selector: unknown,
  matchMode: string = 'exact',
): boolean {
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

export function planExternalCheckWaiver(
  input: ExternalCheckWaiverPlanInput,
  options: { now?: Date; repoOwner?: string } = {},
): ExternalCheckWaiverReport {
  const pr = input?.pr ?? {};
  const issueCandidates = Array.isArray(input?.issueCandidates)
    ? input.issueCandidates
    : [];
  const policy = input?.policy ?? normalizePolicyConfig({});
  const requestedSelector = String(input?.requestedSelector ?? '').trim();
  const reason = String(input?.reason ?? '').trim();
  const expiresAt = String(input?.expiresAt ?? '').trim();
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

  const blockingReasons: string[] = [];
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
    // The normal path's agentId comes from the resolved claim, independent
    // of `actor`; --claimless has no claim to fall back on, so an empty
    // actor must surface here as a blocking reason like every other invalid
    // input in this function, rather than reaching
    // renderExternalCheckWaiverComment's own throw-on-empty-agentId guard.
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
  if (!authority.known) {
    blockingReasons.push(
      authority.error || 'actor authority could not be proven',
    );
  } else if (!authority.authorized) {
    blockingReasons.push(
      `${actor || 'actor'} is not authorized under ${authority.policy}`,
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
  const allowClosedPrecondition = input?.allowClosedPrecondition === true;
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
  // as before this change.
  const claimBinding = claimless
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
export function resolveActorLogin(
  optionsActor: string | undefined,
  argsActor: string,
  viewerLogin: string,
): string {
  return (
    [optionsActor, argsActor, viewerLogin]
      .map((actor) => actor?.trim() ?? '')
      .find(Boolean) ?? ''
  ).toLowerCase();
}

export async function runExternalCheckWaiver(
  options: RunExternalCheckWaiverOptions = {},
): Promise<{ exitCode: number; report?: ExternalCheckWaiverReport }> {
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
  const viewerLogin = String(safeGhText(['api', 'user', '--jq', '.login']))
    .trim()
    .toLowerCase();
  const actor = resolveActorLogin(options.actor, args.actor, viewerLogin);
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

  const authority =
    options.authority ??
    resolveCollaboratorAuthority({ owner, repo: name, actor });
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
      viewerLogin: actor,
      linkedIssues: pr.closingIssuesReferences,
      issueNumber: args.issueNumber,
      expectedClaimId: args.claimId,
      headRefName: pr.headRefName,
      prNumber: args.prNumber,
    });

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
      expiresAt: resolveExpiryAt({
        expiresAt: args.expiresAt,
        expiresIn: args.expiresIn,
        now: options.now instanceof Date ? options.now : new Date(),
      }),
      repoOwner: owner,
      claimless: args.claimless,
      headCommittedAt:
        options.headCommittedAt ??
        fetchHeadCommittedAt({
          owner,
          repo: name,
          headRefOid: String(pr.headRefOid ?? '').trim(),
        }),
      allowClosedPrecondition: args.allowClosedPrecondition,
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
  const readPrComments = (): WaiverCommentPayload[] =>
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
  const buildWaiverEvidence = (
    comments: WaiverCommentPayload[],
    binding: { claimId: string; supersedes: string },
  ) =>
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
        })
      : null;
  // The marker this invocation would post defines the binding a reusable
  // waiver must share; the predecessor claim is accepted too, matching the
  // gate's one-hop takeover exception.
  const toAllowedClaimIds = (binding: {
    claimId: string;
    supersedes: string;
  }): string[] =>
    [binding.claimId, binding.supersedes].filter(
      (value) => value && value !== 'none',
    );
  const preWriteBinding = {
    claimId: wouldPost?.claimId ?? '',
    supersedes: String(report.linkedIssue?.activeClaim?.supersedes ?? ''),
  };
  const existingWaiver = findReusableWaiverComment({
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
    : (ghJson([
        'api',
        `repos/${owner}/${name}/issues/${args.prNumber}/comments`,
        '--method',
        'POST',
        '-f',
        `body=${report.body}`,
      ]) as PostedCommentPayload);

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
  let postWriteComments: WaiverCommentPayload[] = [];
  let reconcileInconclusive = false;
  if (wouldPost) {
    try {
      postWriteComments = readPrComments();
    } catch (error) {
      reconcileInconclusive = true;
      process.stderr.write(
        `warning: the waiver was posted, but re-reading PR #${args.prNumber} comments failed, ` +
          `so a concurrent duplicate could not be ruled out: ${String(
            (error as { message?: unknown })?.message ?? error,
          )}\n`,
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
          `so a concurrent duplicate could not be ruled out: ${String(
            (error as { message?: unknown })?.message ?? error,
          )}\n`,
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
function fetchPrComments({
  owner,
  repo,
  prNumber,
}: {
  owner: string;
  repo: string;
  prNumber: number;
}): WaiverCommentPayload[] {
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
  return payload as WaiverCommentPayload[];
}

/** One issue comment, in the shape the GitHub REST list endpoint returns. */
interface WaiverCommentPayload {
  id?: string | number | null;
  html_url?: string | null;
  url?: string | null;
  body?: string | null;
  created_at?: string | null;
  user?: GhAuthorPayload | null;
  author?: GhAuthorPayload | null;
}

/** An existing waiver this invocation should reuse instead of appending. */
export interface ReusableWaiver {
  commentId: string;
  commentUrl: string;
  checkSelector: string;
  expiresAt: string;
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
export function findReusableWaiverComment(input: {
  comments: WaiverCommentPayload[] | null | undefined;
  evidence: ExternalCheckWaiverEvidence | null | undefined;
  checkSelector: string;
  expectedHeadSha?: string;
  allowedClaimIds?: string[];
}): ReusableWaiver | null {
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
}: {
  comments: WaiverCommentPayload[] | null | undefined;
  evidence: ExternalCheckWaiverEvidence | null | undefined;
  checkSelector: string;
  /**
   * #2328 (review): the HEAD the waiver must bind to. The summarizer keeps a
   * wrong-HEAD marker out of `valid`, but a wrong-HEAD comment can still
   * match a valid entry produced by a DIFFERENT comment when author, reason,
   * expiry, and second all coincide — the entry carries no binding of its
   * own to rule that out. Empty skips the check.
   */
  expectedHeadSha?: string;
  /**
   * #2328 (review): the claim ids a waiver may bind to — the active claim,
   * plus its immediate predecessor for the gate's one-hop takeover
   * exception. Empty skips the check.
   */
  allowedClaimIds?: string[];
}): ReusableWaiver[] {
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
  const found: ReusableWaiver[] = [];
  for (const comment of ordered) {
    const parsed = parseExternalCheckWaiverComment(
      String(comment?.body ?? ''),
      String(comment?.created_at ?? ''),
    );
    if (!parsed || parsed.checkSelector !== selector) continue;
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

function selectorRequestsGlob(selector: unknown): boolean {
  return /[*]/.test(String(selector ?? ''));
}

function selectLinkedIssueCandidate(
  issueCandidates: IssueCandidatePayload[],
  options: {
    issueNumber?: number;
    expectedClaimId?: string;
    headRefName?: string;
  } = {},
): LinkedIssueSelection {
  const filtered = issueCandidates.filter(
    (candidate): candidate is LinkedIssueWithClaim => {
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
    },
  );

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
    };
  }
  return {
    ok: false,
    issue: null,
    reason:
      'multiple linked issues expose active claims on the PR branch; rerun with --issue and --claim-id',
  };
}

function normalizeChecks(
  statusCheckRollup: StatusCheckRollupEntry[] | null | undefined = [],
): NormalizedCheck[] {
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
export function normalizeAuthorityEvidence(
  evidence: AuthorityEvidenceInput | null | undefined,
  actor: string,
  repoOwner: string,
  policy: string,
): AuthorityEvidence {
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

function resolveExpiryAt({
  expiresAt,
  expiresIn,
  now,
}: {
  expiresAt: string;
  expiresIn: string;
  now: Date;
}): string {
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
}: {
  owner: string;
  repo: string;
  rawConfig: unknown;
  viewerLogin: string;
  linkedIssues: LinkedIssueRefPayload[] | null | undefined;
  issueNumber: number;
  expectedClaimId: string;
  headRefName: string | null | undefined;
  prNumber: number;
}): IssueCandidatePayload[] {
  const issueRefs = (linkedIssues ?? []).filter((issue) => {
    return !issueNumber || Number(issue.number) === issueNumber;
  });
  const results: IssueCandidatePayload[] = [];
  for (const issue of issueRefs) {
    const comments = ghJson(
      [
        'api',
        '--paginate',
        `repos/${owner}/${repo}/issues/${issue.number}/comments`,
      ],
      true,
    ) as IssueCommentPayload[];
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

function fetchPullRequest({
  owner,
  repo,
  prNumber,
}: {
  owner: string;
  repo: string;
  prNumber: number;
}): PrPayload {
  return ghJson([
    'pr',
    'view',
    String(prNumber),
    '--repo',
    `${owner}/${repo}`,
    '--json',
    'number,state,url,headRefName,headRefOid,statusCheckRollup,closingIssuesReferences',
  ]) as PrPayload;
}

/**
 * #2328: the HEAD commit's own `committer.date`, the anchor the
 * `idd-advisory-convergence` waiver deadline is measured from. Returns an
 * empty string on any failure — a missing anchor keeps the hatch shut, which
 * is the safe direction, and never blocks a selector that is not
 * precondition-gated.
 */
function fetchHeadCommittedAt({
  owner,
  repo,
  headRefOid,
}: {
  owner: string;
  repo: string;
  headRefOid: string;
}): string {
  if (!headRefOid) return '';
  try {
    const payload = ghJson([
      'api',
      `repos/${owner}/${repo}/commits/${headRefOid}`,
    ]) as { commit?: { committer?: { date?: unknown } } } | null;
    return String(payload?.commit?.committer?.date ?? '').trim();
  } catch {
    return '';
  }
}

/** Exported for reuse by `provider-outage-declaration.mts` (#2320); see the doc comment on {@link normalizeAuthorityEvidence}. */
export function resolveCollaboratorAuthority({
  owner,
  repo,
  actor,
}: {
  owner: string;
  repo: string;
  actor: string;
}): CollaboratorAuthority {
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
}: {
  owner: string;
  repo: string;
  rawConfig: unknown;
  viewerLogin: string;
  issueComments?: IssueCommentPayload[] | null;
}): Set<string> {
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

function readTrustedMarkerActors(rawConfig: unknown): string[] {
  const actors = (rawConfig as { trustedMarkerActors?: unknown } | null)
    ?.trustedMarkerActors;
  if (!Array.isArray(actors)) {
    return [];
  }
  return actors
    .map(String)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function ghJson(args: string[], slurp = false): unknown {
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
export function deriveGhApiStatusFromError(error: unknown): GhApiStatusResult {
  const status = deriveGhHttpStatus(error);
  return {
    status: status ?? 500,
    body: {},
  };
}

function ghApiJsonWithStatus(path: string): GhApiStatusResult {
  try {
    return {
      status: 200,
      body: JSON.parse(ghText(['api', path])) as GhApiStatusResult['body'],
    };
  } catch (error) {
    return deriveGhApiStatusFromError(error);
  }
}

function renderReport(report: ExternalCheckWaiverReport, format: string): void {
  if (format === 'text') {
    process.stdout.write(renderTextReport(report));
    return;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function renderTextReport(report: ExternalCheckWaiverReport): string {
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
  '--help': { type: 'boolean', short: 'h' },
} as const;

export function parseArgs(argv: string[]): ExternalCheckWaiverArgs {
  const { values, help } = parseCliArgs(argv, EXTERNAL_CHECK_WAIVER_FLAG_SPEC);

  const format = (values.format as string).trim();
  if (format !== 'json' && format !== 'text') {
    throw new Error(`unsupported --format value: ${format}`);
  }

  const parsed: ExternalCheckWaiverArgs = {
    // parsePositiveInteger keeps its existing throw-on-invalid contract
    // and message shape unchanged; only called when the flag is actually
    // present, matching the original "absent --pr/--issue stays 0,
    // untouched" behavior (checked below via the "missing required"
    // guard, same as before this migration).
    prNumber:
      values.pr === undefined
        ? 0
        : parsePositiveInteger(values.pr as string, '--pr'),
    issueNumber:
      values.issue === undefined
        ? 0
        : parsePositiveInteger(values.issue as string, '--issue'),
    claimId: (values['claim-id'] as string).trim(),
    checkSelector: (values.check as string).trim(),
    reason: (values.reason as string).trim(),
    expiresAt: (values.expires as string).trim(),
    expiresIn: (values['expires-in'] as string).trim(),
    actor: (values.actor as string).trim(),
    repo: (values.repo as string).trim(),
    apply: values.apply as boolean,
    yes: values.yes as boolean,
    format,
    claimless: values.claimless as boolean,
    allowClosedPrecondition: values['allow-closed-precondition'] as boolean,
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
  }

  return parsed;
}

function parseOwnerRepo(value: unknown): { owner: string; name: string } {
  const repo = String(value ?? '').trim();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`invalid --repo value: ${value} (expected owner/name)`);
  }
  return { owner: match[1], name: match[2] };
}

function parsePositiveInteger(value: unknown, flag: string): number {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return Number(raw);
}

function splitCsv(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function printUsage(): void {
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
  --actor <login>                   override the GitHub actor used for authority evaluation
  --repo <owner/name>               repository override
  --apply                           post the canonical waiver comment after validation
  --yes                             skip the interactive apply confirmation
  --format <json|text>              output format (default: json)
  --help                            show this message
`);
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const result = await runExternalCheckWaiver({ args: parseArgs(argv) });
  process.exit(result.exitCode);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
