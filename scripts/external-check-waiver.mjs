#!/usr/bin/env node
// idd-generated-from: src/scripts/external-check-waiver.mts
//
// The scripts/external-check-waiver.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { readFileSync } from 'node:fs';
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
  parsePaginatedGhNdjson,
  renderExternalCheckWaiverComment,
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
    body,
  };
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
  const viewerLogin = String(safeGhText(['api', 'user', '--jq', '.login']))
    .trim()
    .toLowerCase();
  const actor = String(options.actor ?? args.actor ?? viewerLogin)
    .trim()
    .toLowerCase();
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
  const appliedReport = {
    ...report,
    applied: true,
    commentUrl: String(result.html_url ?? result.url ?? ''),
  };
  renderReport(appliedReport, args.format);
  return { exitCode: 0, report: appliedReport };
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
    };
  }
  return {
    ok: false,
    issue: null,
    reason:
      'multiple linked issues expose active claims on the PR branch; rerun with --issue and --claim-id',
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
function normalizeAuthorityEvidence(evidence, actor, repoOwner, policy) {
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
function resolveCollaboratorAuthority({ owner, repo, actor }) {
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
