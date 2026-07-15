#!/usr/bin/env node
// idd-generated-from: src/scripts/pre-merge-readiness.mts
//
// The scripts/pre-merge-readiness.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readAdvisoryPrimaryBotLogin,
  readAdvisoryWaitPolicy,
} from './advisory-wait-policy.mjs';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mjs';
import { GH_TEXT_LOOP_OPTIONS, ghText, safeGhText } from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mjs';
import {
  buildPreMergeReadinessSummary,
  DEFAULT_STALE_AGE_MS,
  deriveIddAgentLogins,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  parsePaginatedGhNdjson,
  resolveAdvisoryBotLogins,
  resolveCodeownersForFiles,
  resolveRulesetDetailPath,
  resolveTrustedMarkerActors,
  selectCodeownersText,
} from './protocol-helpers.mjs';
/**
 * Fetch live GitHub state for the PR + claim issue and build the
 * read-only pre-merge readiness report. Shared by this CLI and the
 * `idd-merge-execute` helper so the F2/F3 gate logic is collected from
 * exactly one place (no duplicated gh plumbing or gate evaluation).
 */
export function collectPreMergeReadiness(argv) {
  const args = parseArgs(argv);
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }
  if (!args.claimIssueNumber) {
    throw new Error('missing required --claim-issue <number> argument');
  }
  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_OPTIONS,
    );
  const repoRef = `${owner}/${repo}`;
  const viewerLogin = safeGhText(
    ['api', 'user', '--jq', '.login'],
    GH_TEXT_LOOP_OPTIONS,
  ).toLowerCase();
  const viewerAppSlug = safeGhText(
    ['api', 'app', '--jq', '.slug // .app_slug // empty'],
    GH_TEXT_LOOP_OPTIONS,
  ).toLowerCase();
  const iddConfig = loadIddConfig();
  const { actors: configuredTrustedActors, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
      config: iddConfig,
    });
  const { logins: advisoryBotLogins, source: advisoryBotLoginsSource } =
    resolveAdvisoryBotLogins({
      flagValue: args.advisoryBotLogins,
      envValue: process.env.IDD_ADVISORY_BOT_LOGINS,
      config: iddConfig,
    });
  const pr = ghJson([
    'pr',
    'view',
    String(args.prNumber),
    '-R',
    repoRef,
    '--json',
    'headRefOid,baseRefName,url,author,reviewDecision',
    '--jq',
    '.',
  ]);
  const prHeadSha = String(pr.headRefOid ?? '');
  const baseRefName = String(pr.baseRefName ?? '');
  const prUrl = String(pr.url ?? '');
  const prAuthorLogin = String(pr.author?.login ?? '').toLowerCase();
  const reviewDecision = String(pr.reviewDecision ?? '');
  const encodedBaseRefName = encodeURIComponent(baseRefName);
  const checks = ghJson(
    [
      'pr',
      'checks',
      String(args.prNumber),
      '-R',
      repoRef,
      '--json',
      'name,state,completedAt',
      '--jq',
      '.',
    ],
    { allowStatuses: [1, 8] },
  );
  const trustEmptyProtectionReads = readTrustEmptyProtectionReads();
  const branchRulesRead = fetchGovernanceJson(
    `repos/${owner}/${repo}/rules/branches/${encodedBaseRefName}`,
    true,
    trustEmptyProtectionReads,
    [],
  );
  const branchRules = branchRulesRead.value;
  const branchRulesetsRead = fetchBranchRulesets(
    owner,
    repo,
    branchRules,
    trustEmptyProtectionReads,
  );
  const branchRulesets = branchRulesetsRead.value;
  const branchProtectionRead = fetchGovernanceJson(
    `repos/${owner}/${repo}/branches/${encodedBaseRefName}/protection`,
    false,
    trustEmptyProtectionReads,
    {},
  );
  const branchProtection = branchProtectionRead.value;
  // #1377: a masked-403-as-404 on either read means the required-check set
  // this call collected cannot be trusted as complete, so the F2/F3 CI gate
  // must not fall through to `noRequiredChecksConfigured` on it (see
  // `summarizeRequiredChecks` in protocol-helpers.mts).
  const protectionReadsUnreadable =
    branchRulesRead.unreadable || branchProtectionRead.unreadable;
  // #1380: a masked-403-as-404 on a ruleset's *detail* read is a distinct
  // surface from the required-check reads above -- `branchRulesets` only
  // feeds `summarizeReviewerStates`'s ruleset-bypass/CODEOWNER detection,
  // never `summarizeRequiredChecks` (see `summarizeBranchReviewRequirements`
  // in protocol-helpers.mts, which reads only `branchRules` /
  // `branchProtection`) -- so it is threaded separately rather than folded
  // into `protectionReadsUnreadable`.
  const branchRulesetsUnreadable = branchRulesetsRead.unreadable;
  const reviews = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/reviews`,
    true,
  );
  const requestedReviewers = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/requested_reviewers`,
    false,
  );
  const timelineEvents = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/timeline`,
    true,
    ['-H', 'Accept: application/vnd.github+json'],
  );
  const comments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
    true,
  );
  const claimComments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.claimIssueNumber}/comments`,
    true,
  );
  const threads = fetchReviewThreads(owner, repo, args.prNumber);
  const changedFiles = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/files`,
    true,
  )
    .map((file) => String(file.filename ?? ''))
    .filter(Boolean);
  const codeownersText = fetchCodeownersText(owner, repo, baseRefName);
  const eligibleCodeownerUserLogins = resolveEligibleCodeownerUserLogins(
    owner,
    repo,
    resolveCodeownersForFiles(codeownersText, changedFiles).codeownerUserLogins,
  );
  const viewerTeamSlugs = resolveViewerClassicBypassTeamSlugs(
    owner,
    viewerLogin,
    branchProtection,
  );
  const collaboratorTrustEnabled = readCollaboratorTrustEnabled();
  const trustedMarkerLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
    ...(collaboratorTrustEnabled
      ? resolveTrustedCollaboratorMarkerLogins(owner, repo, [
          ...comments,
          ...claimComments,
        ])
      : []),
  ]);
  const iddAgentLogins = deriveIddAgentLogins({
    viewerLogin,
    iddAgentLogins: splitCsv(args.iddAgentLogins),
    trustedMarkerLogins,
    operationalComments: [...comments, ...claimComments],
  });
  const advisoryWaitPolicy = readAdvisoryWaitPolicy();
  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  const forcedHandoffEnabled = readForcedHandoffMode() === 'human-gated';
  // The PR's first-commit time backs the Part B forced-handoff rule (#1058):
  // a legitimate issue-only handoff that predates the PR is honored even
  // against a PR-backed claim. This allowance is applied on the merge side
  // only; resume-claim-routing.mts intentionally never passes prFirstCommitAt
  // (an issue-only handoff against a PR-backed claim stays rejected there) —
  // the merge-only half of the documented strict-resume vs. lenient-relay-merge
  // split (see docs/idd-design-rationale.md, "Claim resolution"). Resolve it
  // only when forced handoffs are enabled, and fail closed to `null` (reject)
  // on any lookup/parse error so a transient commits-API failure never aborts
  // the readiness gate.
  let prFirstCommitAt = null;
  if (forcedHandoffEnabled) {
    try {
      const prCommits = ghApiJson(
        `repos/${owner}/${repo}/pulls/${args.prNumber}/commits`,
        true,
      );
      prFirstCommitAt = resolvePrFirstCommitAt(prCommits);
    } catch {
      prFirstCommitAt = null;
    }
  }
  const forcedHandoffPermissionCache = new Map();
  const waivableCheckSelectors = readWaivableCheckSelectors();
  const externalCheckWaiverMaxValidity = readExternalCheckWaiverMaxValidity();
  const staleAgeMs = readClaimStaleAgeMs();
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      comments: comments.map(normalizeComment),
      reviews: reviews.map(normalizeReview),
      threads: threads.map(normalizeThread),
      checks,
      branchRules,
      branchRulesets,
      branchProtection,
      protectionReadsUnreadable,
      branchRulesetsUnreadable,
      requestedReviewers: requestedReviewers.users ?? [],
      timelineEvents,
      claimEvents: claimComments.map(normalizeClaimComment),
      changedFiles,
      codeownersText,
      eligibleCodeownerUserLogins,
      reviewDecision,
    },
    {
      now: args.now || new Date().toISOString().replace('.000Z', 'Z'),
      trustedMarkerLogins,
      iddAgentLogins,
      advisoryBotLogins,
      advisoryBotLoginsSource,
      prAuthorLogin,
      expectedClaimId: args.expectedClaimId,
      expectedAgentId: args.expectedAgentId,
      includeDispositionEvidence: true,
      requestCap: advisoryWaitPolicy.requestCap,
      pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
      settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
      pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
      capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
      primaryBotLogin,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity,
      staleAgeMs,
      forcedHandoffEnabled,
      expectedLinkedPrs: [String(args.prNumber), prUrl].filter(Boolean),
      prFirstCommitAt,
      isAuthorizedForcedHandoff: (forcedBy) =>
        isAuthorizedForcedHandoffActor(
          owner,
          repo,
          forcedBy,
          forcedHandoffAuthorityPolicy,
          forcedHandoffPermissionCache,
        ),
      viewerLogin,
      viewerTeamSlugs,
      viewerAppSlug,
      configuredTrustedActors,
      collaboratorTrustEnabled,
    },
  );
  return {
    ...summary,
    trustedMarkerActors: configuredTrustedActors,
    trustedMarkerActorsSource,
  };
}
// CLI: emit the readiness report as JSON when invoked directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(collectPreMergeReadiness(process.argv.slice(2)), null, 2)}\n`,
  );
}
function warnDeprecatedFlag(deprecated, canonical) {
  process.stderr.write(
    `warning: ${deprecated} is deprecated; use ${canonical} instead.\n`,
  );
}
export function parseArgs(argv) {
  const parsed = {
    prNumber: null,
    claimIssueNumber: null,
    owner: '',
    repo: '',
    trustedMarkerLogins: '',
    iddAgentLogins: '',
    advisoryBotLogins: '',
    expectedClaimId: '',
    expectedAgentId: '',
    now: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    // Reject a missing value (undefined) or a flag-shaped value so that
    // `--pr --json` fails fast instead of consuming `--json` as the value.
    const requireValue = () => {
      if (value === undefined || String(value).startsWith('--')) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    // Positive-integer guard shared by both numeric flags below.
    const requirePositiveInteger = () => {
      const raw = requireValue();
      if (!/^[1-9]\d*$/.test(raw)) {
        throw new Error(`invalid ${token} value: ${raw}`);
      }
      return Number(raw);
    };
    if (token === '--pr') {
      parsed.prNumber = requirePositiveInteger();
      index += 1;
      continue;
    }
    if (token === '--claim-issue') {
      parsed.claimIssueNumber = requirePositiveInteger();
      index += 1;
      continue;
    }
    if (token === '--owner') {
      parsed.owner = requireValue();
      index += 1;
      continue;
    }
    if (token === '--repo') {
      parsed.repo = requireValue();
      index += 1;
      continue;
    }
    if (token === '--trusted-marker-logins') {
      parsed.trustedMarkerLogins = requireValue();
      index += 1;
      continue;
    }
    if (token === '--idd-agent-logins') {
      parsed.iddAgentLogins = requireValue();
      index += 1;
      continue;
    }
    if (token === '--advisory-bot-logins') {
      parsed.advisoryBotLogins = requireValue();
      index += 1;
      continue;
    }
    if (token === '--claim-id') {
      parsed.expectedClaimId = requireValue();
      index += 1;
      continue;
    }
    if (token === '--expected-claim-id') {
      warnDeprecatedFlag('--expected-claim-id', '--claim-id');
      parsed.expectedClaimId = requireValue();
      index += 1;
      continue;
    }
    if (token === '--agent-id') {
      parsed.expectedAgentId = requireValue();
      index += 1;
      continue;
    }
    if (token === '--expected-agent-id') {
      warnDeprecatedFlag('--expected-agent-id', '--agent-id');
      parsed.expectedAgentId = requireValue();
      index += 1;
      continue;
    }
    if (token === '--now') {
      parsed.now = requireValue();
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/pre-merge-readiness.mjs --pr <number> --claim-issue <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--idd-agent-logins <login1,login2>] [--advisory-bot-logins <login1,login2>] [--claim-id <claim-id>] [--agent-id <agent-id>] [--now <ISO8601>]
  Deprecated aliases (one release): --expected-claim-id -> --claim-id, --expected-agent-id -> --agent-id
`);
}
function normalizeComment(comment) {
  return {
    id: String(comment.id ?? ''),
    author: { login: comment.user?.login ?? '' },
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    updatedAt: comment.updated_at ?? comment.created_at ?? '',
  };
}
function normalizeClaimComment(comment) {
  return {
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  };
}
function normalizeReview(review) {
  return {
    author: { login: review.user?.login ?? '' },
    state: review.state ?? '',
    commitId: review.commit_id ?? '',
    submittedAt: review.submitted_at ?? '',
    createdAt: review.submitted_at ?? '',
    updatedAt: review.updated_at ?? review.submitted_at ?? '',
  };
}
function normalizeThread(thread) {
  return {
    id: thread.id,
    isResolved: Boolean(thread.isResolved),
    updatedAt: '',
    reviewerReopenedAt: inferReviewerReopenedAt(thread),
    comments: {
      pageInfo: {
        hasNextPage: Boolean(thread.comments?.pageInfo?.hasNextPage),
      },
      nodes: (thread.comments?.nodes ?? []).map((comment) => ({
        author: { login: comment.author?.login ?? '' },
        body: comment.body ?? '',
        createdAt: comment.createdAt ?? '',
        updatedAt: comment.updatedAt ?? comment.createdAt ?? '',
        pullRequestReview: { id: comment.pullRequestReview?.id ?? null },
      })),
    },
  };
}
function inferReviewerReopenedAt(thread) {
  return thread.reviewerReopenedAt ?? '';
}
function resolveTrustedCollaboratorMarkerLogins(owner, repo, comments) {
  const markerAuthors = [
    ...new Set(
      comments
        .filter(
          (comment) => operationalMarkerPrefix(comment.body ?? '') !== null,
        )
        .map((comment) => comment.user?.login ?? '')
        .filter(Boolean),
    ),
  ];
  return markerAuthors.filter((login) => {
    const permission = safeGhText(
      [
        'api',
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        '--jq',
        '.permission',
      ],
      GH_TEXT_LOOP_OPTIONS,
    ).toLowerCase();
    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}
function resolveEligibleCodeownerUserLogins(owner, repo, logins) {
  return normalizeTrustedMarkerLogins(logins).filter((login) => {
    const permission = safeGhText(
      [
        'api',
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        '--jq',
        '.permission',
      ],
      GH_TEXT_LOOP_OPTIONS,
    ).toLowerCase();
    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}
function fetchCodeownersText(owner, repo, ref) {
  const payloads = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].map(
    (path) => {
      return ghApiJson(
        `repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        false,
        [],
        { allowHttpStatuses: [404] },
      );
    },
  );
  return selectCodeownersText(payloads);
}
/**
 * Fetch each referenced ruleset's detail, discriminating a masked `404`
 * (unreadable) from a genuine deletion race.
 *
 * Every `ruleset_id` passed in via `branchRules` was already confirmed to
 * exist moments earlier by the `rules/branches/{base}` list read in the same
 * call (see `collectPreMergeReadiness`), so a `404` on its own detail read
 * here is not a plausible independent deletion race. GitHub's "Get a
 * repository ruleset" reference documents only `200`/`404`/`500` for this
 * endpoint -- no `403` --
 * (<https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset>),
 * the same masked-403-as-404 pattern `#1377` documented for the other two
 * governance reads (see `fetchGovernanceJson`'s doc comment for the full
 * citation set, including GitHub's REST troubleshooting guide). A `404`
 * here is therefore **unreadable** by default: the ruleset is still dropped
 * from the returned array (the caller has no usable detail either way, so
 * `#1380` cannot invent one), but `unreadable` is set so
 * `summarizeReviewerStates` can distinguish "no bypass configured" from
 * "could not determine" instead of asserting an unjustified certain
 * `deadlock`. `trustEmptyReads` (`ciGate.trustEmptyProtectionReads`, the
 * same policy key `fetchGovernanceJson` reads) restores the pre-`#1380`
 * trusting behavior.
 *
 * Any other thrown status (`403`, rate limit, transient failure, …) is
 * still re-thrown unchanged, preserving the existing fail-closed behavior
 * for an explicit permission error (`#1371`) instead of fabricating a "no
 * ruleset" result that would silently over-block a legitimately configured
 * bypass.
 *
 * The 404 must be discriminated on the *thrown* status: `gh api` writes a 404
 * response body to stdout, so `allowHttpStatuses: [404]` would return that
 * non-empty error object and the `Object.keys(...).length > 0` filter would
 * keep it as a junk ruleset. Letting the 404 throw and matching it here yields
 * the empty/skipped result the gate expects.
 *
 * `fetchRulesetDetail` is injectable for tests; production uses the default
 * `gh api` call.
 */
export function fetchBranchRulesets(
  owner,
  repo,
  branchRules,
  trustEmptyReads = false,
  fetchRulesetDetail = (path) =>
    ghApiJson(path, false, ['-H', 'Accept: application/vnd.github+json']),
) {
  const rulesetPaths = [];
  const seenPaths = new Set();
  for (const rule of branchRules ?? []) {
    const rulesetId = Number.parseInt(String(rule?.ruleset_id ?? ''), 10);
    if (!Number.isInteger(rulesetId)) {
      continue;
    }
    const path = resolveRulesetDetailPath(owner, repo, rule, rulesetId);
    if (seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    rulesetPaths.push(path);
  }
  let unreadable = false;
  const value = rulesetPaths
    .map((path) => {
      try {
        return fetchRulesetDetail(path);
      } catch (error) {
        if (deriveGhHttpStatus(error) === 404) {
          if (!trustEmptyReads) {
            unreadable = true;
          }
          return {};
        }
        throw error;
      }
    })
    .filter((ruleset) => Object.keys(ruleset).length > 0);
  return { value, unreadable };
}
function resolveViewerClassicBypassTeamSlugs(
  owner,
  viewerLogin,
  branchProtection,
) {
  if (!viewerLogin) {
    return [];
  }
  const teams =
    branchProtection.required_pull_request_reviews
      ?.bypass_pull_request_allowances?.teams ?? [];
  const viewerTeams = new Set();
  for (const team of teams) {
    const slug = String(team?.slug ?? '')
      .trim()
      .toLowerCase();
    if (!slug) {
      continue;
    }
    const org = String(
      team?.organization?.login ??
        extractTeamOrgFromHtmlUrl(team?.html_url) ??
        owner,
    ).trim();
    const state = safeGhText(
      [
        'api',
        `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(viewerLogin)}`,
        '--jq',
        '.state',
      ],
      GH_TEXT_LOOP_OPTIONS,
    ).toLowerCase();
    if (state === 'active') {
      viewerTeams.add(slug);
    }
  }
  return [...viewerTeams].sort();
}
function extractTeamOrgFromHtmlUrl(htmlUrl) {
  const match = String(htmlUrl ?? '').match(/\/orgs\/([^/]+)\/teams\//);
  return match?.[1] ?? '';
}
function fetchReviewThreads(owner, repo, prNumber) {
  const nodes = [];
  let cursor = null;
  while (true) {
    const payload = ghGraphql(
      `
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  comments(first: 100) {
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      body
                      createdAt
                      updatedAt
                      author { login }
                      pullRequestReview { id }
                    }
                  }
                }
              }
            }
          }
        }`,
      {
        owner,
        repo,
        number: Number.parseInt(String(prNumber), 10),
        cursor,
      },
    );
    const reviewThreads = payload?.data?.repository?.pullRequest?.reviewThreads;
    for (const thread of reviewThreads?.nodes ?? []) {
      if (thread.comments?.pageInfo?.hasNextPage) {
        // hasNextPage with a missing thread id or cursor is a malformed
        // payload; fail fast with a clear message instead of a confusing
        // GraphQL error or a silently truncated thread.
        if (!thread.id || !thread.comments.pageInfo.endCursor) {
          throw new Error(
            'review thread pagination payload is missing id or endCursor',
          );
        }
        thread.comments.nodes.push(
          ...fetchThreadCommentPages(
            thread.id,
            thread.comments.pageInfo.endCursor,
          ),
        );
        thread.comments.pageInfo.hasNextPage = false;
      }
    }
    nodes.push(...(reviewThreads?.nodes ?? []));
    if (!reviewThreads?.pageInfo?.hasNextPage) {
      break;
    }
    // hasNextPage with a missing cursor would re-fetch the first page
    // forever; fail fast on the malformed payload instead.
    if (!reviewThreads.pageInfo.endCursor) {
      throw new Error('review thread pagination payload is missing endCursor');
    }
    cursor = reviewThreads.pageInfo.endCursor;
  }
  return nodes;
}
function fetchThreadCommentPages(threadId, afterCursor) {
  const nodes = [];
  let cursor = afterCursor;
  while (cursor) {
    const payload = ghGraphql(
      `
        query($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on PullRequestReviewThread {
              comments(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  body
                  createdAt
                  updatedAt
                  author { login }
                  pullRequestReview { id }
                }
              }
            }
          }
        }`,
      { id: threadId, cursor },
    );
    const comments = payload?.data?.node?.comments;
    nodes.push(...(comments?.nodes ?? []));
    if (comments?.pageInfo?.hasNextPage && !comments.pageInfo.endCursor) {
      throw new Error('thread comment pagination payload is missing endCursor');
    }
    cursor = comments?.pageInfo?.hasNextPage
      ? comments.pageInfo.endCursor
      : null;
  }
  return nodes;
}
function ghGraphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'number') {
      args.push('-F', `${key}=${value}`);
      continue;
    }
    args.push('-f', `${key}=${value}`);
  }
  return JSON.parse(runGh(args).trim() || '{}');
}
function ghJson(args, options = {}) {
  return JSON.parse(runGh(args, options).trim() || '[]');
}
function ghApiJson(path, paginate = false, extraArgs = [], options = {}) {
  const args = ['api', path, ...extraArgs];
  if (paginate) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    args.push('--paginate', '--jq', '.[]');
  }
  const raw = runGh(args, options).trim();
  if (!raw) {
    return paginate ? [] : {};
  }
  if (paginate) {
    return parsePaginatedGhNdjson(raw);
  }
  return JSON.parse(raw);
}
/**
 * Resolve the PR's first-commit time as an ISO string: the minimum across all
 * commits of each commit's committer date (falling back to author date). The
 * GitHub `pulls/{pr}/commits` listing is chronological, but compute the
 * minimum defensively rather than relying on order. Returns `null` when no
 * commit carries a parseable date, which makes the Part B gate fail closed
 * (issue-only handoffs against a PR-backed claim stay rejected).
 */
function resolvePrFirstCommitAt(commits) {
  let earliestMs = null;
  let earliestIso = null;
  for (const commit of commits) {
    const date =
      String(commit?.commit?.committer?.date ?? '').trim() ||
      String(commit?.commit?.author?.date ?? '').trim();
    if (!date) {
      continue;
    }
    const ms = Date.parse(date);
    if (!Number.isFinite(ms)) {
      continue;
    }
    if (earliestMs === null || ms < earliestMs) {
      earliestMs = ms;
      earliestIso = date;
    }
  }
  return earliestIso;
}
/**
 * Decide how a thrown `gh` failure is tolerated, returning the string result to
 * use or `undefined` when the caller must re-throw.
 *
 * - `allowHttpStatuses` matches the HTTP status derived from the gh error via
 *   the shared `deriveGhHttpStatus` (the same extractor `fetchBranchRulesets`
 *   uses) and yields an **empty** string. `gh api` writes the JSON error body to
 *   stdout on a non-2xx response (a 404 prints `{"message":"Not Found",…}`), so
 *   returning that body would make `ghApiJson` parse the error object instead of
 *   `{}` / `[]`. An allowed status never carries useful data, so the empty
 *   result lets `ghApiJson` resolve it to an empty object / array.
 * - `allowStatuses` matches the process exit code and returns stdout **only**
 *   when the body is genuinely the wanted JSON (`gh` commands that exit non-zero
 *   yet still print the data, e.g. the checks rollup).
 *
 * The HTTP-status branch is checked **first**: an explicitly tolerated HTTP
 * status must always yield empty, even when the exit code is also tolerated and
 * the error body on stdout happens to be JSON. Checking `allowStatuses` first
 * would return that error body and reintroduce the very parsing bug this guards
 * against. No current caller sets both options, so the order is behavior-neutral
 * today; it keeps the resolver correct for any future combined call.
 */
export function resolveToleratedGhFailure(error, options = {}) {
  const httpStatus = deriveGhHttpStatus(error);
  if (
    httpStatus !== null &&
    (options.allowHttpStatuses ?? []).includes(httpStatus)
  ) {
    return '';
  }
  const status = Number(error?.status ?? -1);
  if ((options.allowStatuses ?? []).includes(status)) {
    const stdout = String(error?.stdout ?? '');
    if (/^\s*[[{]/.test(stdout)) {
      return stdout;
    }
  }
  return undefined;
}
function runGh(args, options = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const tolerated = resolveToleratedGhFailure(error, options);
    if (tolerated !== undefined) {
      return tolerated;
    }
    throw error;
  }
}
function splitCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}
function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}
function readCollaboratorTrustEnabled() {
  try {
    return resolveCollaboratorMarkerTrust(
      JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
      process.env.IDD_TRUST_COLLABORATOR_MARKERS,
    );
  } catch {
    // Fall through to env-var fallback.
  }
  return isTruthy(process.env.IDD_TRUST_COLLABORATOR_MARKERS);
}
// Configured waivable external-check selectors (`ciGate.externalChecks.
// waivable`). The F2 gate only lets a valid waiver fold a check into
// `requiredChecksPassing` when that check sits on this surface; an absent or
// unreadable config yields an empty list (nothing waivable).
function readWaivableCheckSelectors() {
  try {
    return [
      ...normalizePolicyConfig(
        JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
      ).ciGate.externalChecks.waivable,
    ];
  } catch {
    return [];
  }
}
// Configured external-check waiver validity window (`ciGate.
// externalCheckWaivers.maxValidity`). The consume side re-enforces it so a
// waiver whose `expiresAt - createdAt` outlives the policy window cannot count
// as valid. `normalizePolicyConfig` already defaults this to `PT24H`; an absent
// or unreadable config falls back to the same authoring default.
function readExternalCheckWaiverMaxValidity() {
  try {
    return normalizePolicyConfig(
      JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
    ).ciGate.externalCheckWaivers.maxValidity;
  } catch {
    return 'PT24H';
  }
}
// Configured claim-staleness window (`claimTiming.staleAge`, #1310), parsed
// to milliseconds so the write-gate claim resolver honors it instead of the
// hardcoded 24h `isStaleAt` default. Reuses the shared `loadIddConfig`
// loader (already imported by this file) instead of a per-helper
// `readFileSync + JSON.parse` copy; `loadIddConfig` already fails safe to
// `null` and `normalizePolicyConfig(null)` already defaults to `PT24H`, so
// no separate try/catch is needed here. An absent, unreadable, or
// unparseable config falls back to the shared `DEFAULT_STALE_AGE_MS`
// (protocol-helpers.mts) rather than a second local 24h literal, so
// behavior is unchanged for repos on the default and there is exactly one
// hardcoded-24h source of truth.
function readClaimStaleAgeMs() {
  const staleAge = normalizePolicyConfig(loadIddConfig()).claimTiming.staleAge;
  return parseIsoDurationToMs(staleAge) ?? DEFAULT_STALE_AGE_MS;
}
// Configured governance-read trust opt-in (`ciGate.trustEmptyProtectionReads`,
// #1377). Reuses the shared `loadIddConfig` loader (already imported by this
// file); an absent, unreadable, or unparseable config fails safe to the
// `false` default via `normalizePolicyConfig(null)`, matching
// `readClaimStaleAgeMs`'s pattern above.
function readTrustEmptyProtectionReads() {
  return (
    normalizePolicyConfig(loadIddConfig()).ciGate.trustEmptyProtectionReads ===
    true
  );
}
/**
 * Fetch a branch-governance read that GitHub's documented status-code
 * contracts never pair with `403` — `branches/{branch}/protection`
 * documents only `200`/`404`, and `rules/branches/{branch}` can also
 * surface a permission failure as `404` per GitHub's REST troubleshooting
 * guide (see `idd-ci.instructions.md`'s Required-check discovery step 4
 * for the citations `#1377` gathered). Because the response body cannot
 * distinguish "genuinely nothing configured" from "the token cannot read
 * this," a `404` here is **unreadable** by default: the caller still gets
 * a valid empty shape (`emptyValue`) to keep working with, but
 * `unreadable` is set so the CI gate can fail closed instead of silently
 * accepting a vacuous "no required checks" result. `trustEmptyReads`
 * (from `ciGate.trustEmptyProtectionReads`) restores the pre-`#1377`
 * trusting behavior for a repository whose operator has git-committed
 * that its automation token is known to carry full read access to these
 * endpoints — an explicit, auditable policy decision, not a runtime
 * signal a narrower-scoped token could spoof. Any other thrown status
 * (`403`, `500`, a transient failure, …) still re-throws unchanged,
 * preserving `#1363`'s existing fail-closed behavior for an explicit
 * permission error.
 *
 * `fetchJson` is injectable for tests (mirrors `fetchBranchRulesets`'s
 * `fetchRulesetDetail` parameter); production uses the default `gh api` call.
 */
export function fetchGovernanceJson(
  path,
  paginate,
  trustEmptyReads,
  emptyValue,
  fetchJson = (p, pg) => ghApiJson(p, pg, []),
) {
  try {
    return { value: fetchJson(path, paginate), unreadable: false };
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return { value: emptyValue, unreadable: !trustEmptyReads };
    }
    throw error;
  }
}
