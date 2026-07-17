#!/usr/bin/env node
// idd-generated-from: src/scripts/live-status-digest.mts
//
// The scripts/live-status-digest.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  collaboratorPermission,
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import { ghApiJson } from './gh-exec.mts';
import { resolveCollaboratorMarkerTrust } from './policy-helpers.mts';
import type { PrCommitPayload } from './protocol-helpers.mts';
import {
  applyDigestUpsert,
  type DigestUpsertOutcome,
  normalizeTrustedMarkerLogins,
  parsePaginatedGhNdjson,
  planLiveStatusDigestUpsert,
  resolvePrFirstCommitAt,
  resolveTrustedMarkerActors,
  summarizeClaimValidation,
} from './protocol-helpers.mts';

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentRestPayload {
  id?: string | number | null;
  url?: string | null;
  html_url?: string | null;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  user?: GhAuthorPayload | null;
}

/** Parsed CLI arguments. */
interface LiveStatusDigestArgs {
  format: string;
  help?: boolean;
  issue?: string;
  pr?: string;
  repo?: string;
  dryRun?: boolean;
  apply?: boolean;
  phase?: string;
  claim?: string;
  branch?: string;
  lastChecked?: string;
  openBlockers?: string;
  nextAction?: string;
  authoritativeBy?: string;
  claimIssue?: string;
  claimId?: string;
  agentId?: string;
  skipClaimCheck?: boolean;
  includeBody?: boolean;
}

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `issue:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --issue spec key
// below. See cli-args.mts's module header for the full invariant.
const LIVE_STATUS_DIGEST_FLAG_SPEC = {
  '--help': { type: 'boolean', short: 'h', default: false },
  '--issue': { type: 'string' },
  '--pr': { type: 'string' },
  '--repo': { type: 'string' },
  '--dry-run': { type: 'boolean', default: false },
  '--apply': { type: 'boolean', default: false },
  '--phase': { type: 'string' },
  '--claim': { type: 'string' },
  '--branch': { type: 'string' },
  '--last-checked': { type: 'string' },
  '--open-blockers': { type: 'string' },
  '--next-action': { type: 'string' },
  '--authoritative-by': { type: 'string' },
  '--claim-issue': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--skip-claim-check': { type: 'boolean', default: false },
  '--include-body': { type: 'boolean', default: false },
  '--format': { type: 'string', default: 'json' },
} as const;

/** Duplicate-digest evidence row in the upsert plan and report. */
interface LiveStatusDigestDuplicate {
  id: string | number | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Upsert plan produced by `planLiveStatusDigestUpsert`. */
interface LiveStatusDigestPlan {
  action: string;
  canApply: boolean;
  body: string | null;
  commentId?: string | number | null;
  url?: string | null;
  duplicates: LiveStatusDigestDuplicate[];
  repairPath?: string;
}

/**
 * JSON state document printed by this CLI: the live-status digest
 * upsert plan/apply outcome for one issue or pull request.
 */
export interface LiveStatusDigestReport {
  repository: string;
  target: { type: 'issue' | 'pr'; number: number };
  mode: 'apply' | 'dry-run';
  action: string;
  canApply: boolean;
  commentId: string | number | null;
  url: string | null;
  duplicates: LiveStatusDigestDuplicate[];
  repairPath: string | null;
  applied: boolean;
  body?: string | null;
}

const TRUSTED_MARKER_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const trustedMarkerAuthorCache = new Map<string, boolean>();
const collaboratorPermissionCache: CollaboratorPermissionCache = new Map();
let cachedConfiguredTrustedMarkerAuthors: Set<string> | null = null;
let cachedCurrentViewerLogin: string | null = null;

if (import.meta.main) {
  main();
}

// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or
// process.exit.
function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (args.issue && args.pr) {
    fail('choose only one of --issue or --pr');
  }
  if (!args.issue && !args.pr) {
    fail('missing required --issue <number> or --pr <number>');
  }
  if (args.apply && args.dryRun) {
    fail('choose only one of --dry-run or --apply');
  }
  if (!args.apply) {
    args.dryRun = true;
  }
  if (args.apply && args.skipClaimCheck && (args.claimIssue || args.claimId)) {
    fail(
      '--skip-claim-check cannot be combined with --claim-issue or --claim-id',
    );
  }
  if (
    args.apply &&
    !args.skipClaimCheck &&
    (!args.claimIssue || !args.claimId)
  ) {
    fail(
      '--apply requires --claim-issue and --claim-id, or explicit --skip-claim-check',
    );
  }

  const repository = args.repo ?? detectRepository();
  const [owner, repo] = parseRepository(repository);
  const targetType = args.issue ? 'issue' : 'pr';
  const targetNumber = parsePositiveInteger(
    args.issue ?? args.pr,
    `--${targetType}`,
  );
  // `expectedLinkedPrs` is a pure, local computation, so building it
  // eagerly is free. `prFirstCommitAt` is not: resolving it makes a
  // paginated `gh api pulls/{pr}/commits` call. `claimContext` is only
  // consumed inside the `assertClaim` callback below, which
  // `applyDigestUpsert` invokes only for a real `--apply` claim check (never
  // for a dry-run, a duplicate-plan exit, or `--apply --skip-claim-check`),
  // so resolve `prFirstCommitAt` lazily at that same call site instead of
  // paying for it on every invocation regardless of whether anything ends
  // up consuming it.
  const claimContext =
    targetType === 'pr'
      ? {
          expectedLinkedPrs: buildExpectedLinkedPrReferences(
            owner,
            repo,
            targetNumber,
          ),
        }
      : {};

  if (args.claimIssue) {
    args.claimIssue = String(
      parsePositiveInteger(args.claimIssue, '--claim-issue'),
    );
  }

  const fields = {
    phase: args.phase,
    claim: args.claim,
    branch: args.branch,
    lastChecked: args.lastChecked ?? currentIsoTimestamp(),
    openBlockers: args.openBlockers,
    nextAction: args.nextAction,
    authoritativeBy: args.authoritativeBy,
  };

  const comments = fetchIssueComments(owner, repo, targetNumber);
  let planned: LiveStatusDigestPlan;
  try {
    planned = planLiveStatusDigestUpsert(comments, fields);
  } catch (error) {
    fail((error as Error).message);
  }
  const report: LiveStatusDigestReport = {
    repository: `${owner}/${repo}`,
    target: {
      type: targetType,
      number: targetNumber,
    },
    mode: args.apply ? 'apply' : 'dry-run',
    action: planned.action,
    canApply: planned.canApply,
    commentId: planned.commentId ?? null,
    url: planned.url ?? null,
    duplicates: planned.duplicates ?? [],
    repairPath: planned.repairPath ?? null,
    applied: false,
    body: args.includeBody ? planned.body : undefined,
  };

  if (planned.action === 'duplicate') {
    writeReport(report, args.format);
    process.exit(1);
  }

  if (args.apply) {
    // The ordering invariant — re-fetch and re-plan, then revalidate the
    // active claim immediately before the create/update mutation, with no
    // write if the claim check throws — lives in applyDigestUpsert. The live
    // `gh` I/O is injected here so that invariant stays unit-testable.
    let outcome: DigestUpsertOutcome<LiveStatusDigestPlan>;
    try {
      outcome = applyDigestUpsert<LiveStatusDigestPlan>({
        skipClaimCheck: Boolean(args.skipClaimCheck),
        refetchAndPlan: () =>
          planLiveStatusDigestUpsert(
            fetchIssueComments(owner, repo, targetNumber),
            fields,
          ),
        assertClaim: () =>
          assertActiveClaim(
            owner,
            repo,
            args.claimIssue,
            args.agentId,
            args.claimId,
            {
              ...claimContext,
              prFirstCommitAt:
                targetType === 'pr'
                  ? resolvePrFirstCommitAtForPr(owner, repo, targetNumber)
                  : null,
            },
          ),
        createComment: (body) =>
          createIssueComment(owner, repo, targetNumber, body),
        updateComment: (commentId, body) =>
          updateIssueComment(owner, repo, commentId, body),
      });
    } catch (error) {
      fail((error as Error).message);
    }

    planned = outcome.planned;
    updateReportFromPlan(report, planned, args.includeBody);
    if (outcome.outcome === 'duplicate') {
      writeReport(report, args.format);
      process.exit(1);
    }
    if (outcome.outcome === 'created' || outcome.outcome === 'updated') {
      report.applied = true;
      report.commentId = outcome.commentId ?? report.commentId;
      report.url = outcome.url ?? report.url;
    }
  }

  writeReport(report, args.format);
}

function updateReportFromPlan(
  report: LiveStatusDigestReport,
  planned: LiveStatusDigestPlan,
  includeBody = false,
): void {
  report.action = planned.action;
  report.canApply = planned.canApply;
  report.commentId = planned.commentId ?? null;
  report.url = planned.url ?? null;
  report.duplicates = planned.duplicates ?? [];
  report.repairPath = planned.repairPath ?? null;
  if (includeBody) {
    report.body = planned.body;
  }
}

function fetchIssueComments(
  owner: string,
  repo: string,
  number: number | string | undefined,
) {
  // gh api with --paginate and --jq '.[]' emits one JSON object per line.
  // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
  // via apt, so keep the NDJSON-compatible form here.
  const result = parsePaginatedGhNdjson(
    execFileSync(
      'gh',
      [
        'api',
        '--paginate',
        '--jq',
        '.[]',
        `repos/${owner}/${repo}/issues/${number}/comments`,
      ],
      { encoding: 'utf8' },
    ),
  ) as IssueCommentRestPayload[];
  return result.map((comment) => ({
    id: comment.id,
    url: comment.url,
    html_url: comment.html_url,
    body: comment.body ?? '',
    created_at: comment.created_at ?? '',
    updated_at: comment.updated_at ?? comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  }));
}

function createIssueComment(
  owner: string,
  repo: string,
  number: number,
  body: string | null,
) {
  return ghJson([
    'api',
    `repos/${owner}/${repo}/issues/${number}/comments`,
    '-X',
    'POST',
    '-f',
    `body=${body}`,
  ]) as {
    id?: string | number | null;
    html_url?: string | null;
    url?: string | null;
  };
}

function updateIssueComment(
  owner: string,
  repo: string,
  commentId: string | number,
  body: string | null,
) {
  return ghJson([
    'api',
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
    '-X',
    'PATCH',
    '-f',
    `body=${body}`,
  ]) as {
    id?: string | number | null;
    html_url?: string | null;
    url?: string | null;
  };
}

function assertActiveClaim(
  owner: string,
  repo: string,
  issueNumber: string | undefined,
  agentId: string | undefined,
  claimId: string | undefined,
  options: {
    expectedLinkedPrs?: string[];
    prFirstCommitAt?: string | null;
  } = {},
): void {
  const active = readActiveClaim(owner, repo, issueNumber, options);
  if (
    !active ||
    active.claimId !== claimId ||
    (agentId && active.agentId !== agentId)
  ) {
    const activeLabel = active ? `${active.agentId} ${active.claimId}` : 'none';
    throw new Error(
      `claim check failed for #${issueNumber}: active claim is ${activeLabel}`,
    );
  }
}

function readActiveClaim(
  owner: string,
  repo: string,
  issueNumber: string | undefined,
  options: {
    expectedLinkedPrs?: string[];
    prFirstCommitAt?: string | null;
  } = {},
) {
  const comments = fetchIssueComments(owner, repo, issueNumber).map(
    (comment) => {
      return {
        body: comment.body,
        createdAt: comment.created_at,
        author: { login: comment.author?.login ?? '' },
      };
    },
  );

  // Read the authority policy once per call; the
  // isAuthorizedForcedHandoff callback may fire multiple times during
  // claim parsing and re-reading .github/idd/config.json on each call
  // would be a needless I/O hot path.
  const forcedHandoffAuthorityPolicyValue = readForcedHandoffAuthorityPolicy();
  const summary = summarizeClaimValidation(comments, {
    trustedMarkerLogins: resolveTrustedMarkerLogins(owner, repo, comments),
    forcedHandoffEnabled: readForcedHandoffMode() === 'human-gated',
    expectedLinkedPrs: options.expectedLinkedPrs ?? [],
    prFirstCommitAt: options.prFirstCommitAt ?? null,
    isAuthorizedForcedHandoff: (forcedBy) =>
      isAuthorizedForcedHandoffActor(
        owner,
        repo,
        forcedBy,
        forcedHandoffAuthorityPolicyValue,
        collaboratorPermissionCache,
      ),
  });

  return summary.activeClaimPresent ? summary.activeClaim : null;
}

function resolveTrustedMarkerLogins(
  owner: string,
  repo: string,
  comments: { author?: GhAuthorPayload | null }[],
): string[] {
  return normalizeTrustedMarkerLogins(
    comments
      .map((comment) => comment.author?.login ?? '')
      .filter(Boolean)
      .filter((login) => isTrustedMarkerAuthor(owner, repo, login)),
  );
}

function buildExpectedLinkedPrReferences(
  owner: string,
  repo: string,
  prNumber: number,
): string[] {
  const normalized = String(prNumber ?? '').trim();
  if (!normalized) {
    return [];
  }
  return [
    normalized,
    `#${normalized}`,
    `https://github.com/${owner}/${repo}/pull/${normalized}`,
  ];
}

// The PR's first-commit time backs the Part B forced-handoff rule (#1058): a
// legitimate issue-only handoff that predates the PR is honored even against
// a PR-backed claim -- see `buildForcedHandoffEnableGate` in
// protocol-helpers.mts. Resolve it only when forced handoffs are enabled, and
// fail closed to `null` (reject) on any lookup/parse error so a transient
// commits-API failure never widens what the gate accepts. Mirrors
// `pre-merge-readiness.mts` / `advisory-convergence.mts`'s identical
// resolution, sharing `resolvePrFirstCommitAt`'s date computation with both.
function resolvePrFirstCommitAtForPr(
  owner: string,
  repo: string,
  prNumber: number,
): string | null {
  if (readForcedHandoffMode() !== 'human-gated') {
    return null;
  }
  try {
    const prCommits = ghApiJson(
      `repos/${owner}/${repo}/pulls/${prNumber}/commits`,
      {
        paginate: true,
      },
    ) as PrCommitPayload[];
    return resolvePrFirstCommitAt(prCommits);
  } catch {
    return null;
  }
}

export function isTrustedMarkerAuthor(
  owner: string,
  repo: string,
  login: string,
): boolean {
  if (!login) {
    return false;
  }

  const normalized = login.toLowerCase();
  if (normalized === currentViewerLogin()) {
    return true;
  }
  if (configuredTrustedMarkerAuthors().has(normalized)) {
    return true;
  }

  if (!trustCollaboratorMarkers()) {
    return false;
  }

  const cacheKey = `${owner}/${repo}:${normalized}`;
  if (trustedMarkerAuthorCache.has(cacheKey)) {
    return trustedMarkerAuthorCache.get(cacheKey) ?? false;
  }

  const trusted = TRUSTED_MARKER_PERMISSIONS.has(
    collaboratorPermission(owner, repo, normalized, collaboratorPermissionCache)
      .permission,
  );

  trustedMarkerAuthorCache.set(cacheKey, trusted);
  return trusted;
}

function currentViewerLogin(): string {
  if (cachedCurrentViewerLogin !== null) {
    return cachedCurrentViewerLogin;
  }

  try {
    cachedCurrentViewerLogin = execFileSync(
      'gh',
      ['api', 'user', '--jq', '.login'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .toLowerCase();
  } catch {
    cachedCurrentViewerLogin = '';
  }
  return cachedCurrentViewerLogin;
}

export function configuredTrustedMarkerAuthors(): Set<string> {
  if (cachedConfiguredTrustedMarkerAuthors) {
    return cachedConfiguredTrustedMarkerAuthors;
  }

  // Read config.json the same way trustCollaboratorMarkers() does, then defer
  // to the shared flag-less env -> config ladder (env still wins over config),
  // so trusted-marker authors are no longer env-only in this script.
  let config: { trustedMarkerActors?: unknown } | null = null;
  try {
    config = JSON.parse(readFileSync('.github/idd/config.json', 'utf8'));
  } catch {
    // No readable or parseable config; fall back to env-only resolution.
  }
  const { actors } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config,
  });
  cachedConfiguredTrustedMarkerAuthors = new Set(actors);
  return cachedConfiguredTrustedMarkerAuthors;
}

export function trustCollaboratorMarkers(): boolean {
  try {
    return resolveCollaboratorMarkerTrust(
      JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
      process.env.IDD_TRUST_COLLABORATOR_MARKERS,
    );
  } catch {
    // Fall through to env-var fallback.
  }
  return /^(1|true|yes)$/i.test(
    process.env.IDD_TRUST_COLLABORATOR_MARKERS ?? '',
  );
}

/**
 * Test-only seam: clear the module-level trusted-marker caches so each unit
 * test starts from a known state, and optionally seed the cached current-viewer
 * login so `isTrustedMarkerAuthor` is deterministic without shelling out to
 * `gh`. Not part of the CLI contract.
 */
export function __resetTrustedMarkerCachesForTest(
  seed: { currentViewerLogin?: string } = {},
): void {
  trustedMarkerAuthorCache.clear();
  collaboratorPermissionCache.clear();
  cachedConfiguredTrustedMarkerAuthors = null;
  cachedCurrentViewerLogin = seed.currentViewerLogin ?? null;
}

function detectRepository(): string {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  return execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    {
      encoding: 'utf8',
    },
  ).trim();
}

function parseRepository(value: string): string[] {
  const parts = value.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => part.length === 0 || /\s/.test(part))
  ) {
    fail(`invalid repository ${value}; expected owner/name`);
  }
  return parts;
}

function ghJson(commandArgs: string[]): unknown {
  try {
    return JSON.parse(execFileSync('gh', commandArgs, { encoding: 'utf8' }));
  } catch (error) {
    const stdout = String((error as { stdout?: unknown }).stdout ?? '').trim();
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    const response = parseJsonOrNull(stdout) as {
      message?: unknown;
      errors?: unknown;
    } | null;
    if (response?.message || response?.errors) {
      fail(`gh ${commandArgs.join(' ')} failed: ${JSON.stringify(response)}`);
    }
    if (response) {
      return response;
    }
    fail(
      `gh ${commandArgs.join(' ')} failed: ${stderr || (error as Error).message}`,
    );
  }
}

function parseJsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function writeReport(report: LiveStatusDigestReport, format: string): void {
  if (format === 'json') {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  console.log(`mode\taction\tcanApply\tapplied\tcommentId\turl`);
  console.log(
    [
      report.mode,
      report.action,
      report.canApply,
      report.applied,
      report.commentId ?? '',
      report.url ?? '',
    ].join('\t'),
  );
  if (report.duplicates.length > 0) {
    console.log('duplicates:');
    console.log('id\tcreatedAt\tupdatedAt\turl');
    for (const duplicate of report.duplicates) {
      console.log(
        [
          duplicate.id ?? '',
          duplicate.createdAt ?? '',
          duplicate.updatedAt ?? '',
          duplicate.url ?? '',
        ].join('\t'),
      );
    }
  }
  if (report.repairPath) {
    console.log(`repairPath:\t${report.repairPath}`);
  }
}

function parseArgs(argv: string[]): LiveStatusDigestArgs {
  // No test in this file asserts the pre-migration message text or the
  // no-colon "unknown argument X" / "X requires a value" spelling (see
  // #1451's PR description), so a parse failure adopts the wrapper's
  // uniform message. The exit-code-2 contract IS preserved: catch the
  // wrapper's thrown Error here and route it through this file's own
  // fail() exactly as every other malformed-input path already does.
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv, LIVE_STATUS_DIGEST_FLAG_SPEC);
  } catch (error) {
    fail((error as Error).message);
  }
  const { values, help } = parsed;

  // The pre-migration readValue() used `!value` (not `=== undefined`), so
  // an explicit empty-string value was rejected the same as an omitted
  // flag for EVERY flag in this file. parseCliArgs accepts an empty
  // string (matching bare node:util parseArgs), so this check restores
  // that exact uniform pre-migration behavior.
  const requireNonEmpty = (
    token: string | undefined,
    flag: string,
  ): string | undefined => {
    if (token === '') {
      fail(`${flag} requires a value`);
    }
    return token;
  };

  const format = requireNonEmpty(values.format as string, '--format') as string;
  if (!['json', 'table'].includes(format)) {
    fail('--format must be json or table');
  }

  const parsedArgs: LiveStatusDigestArgs = {
    format,
    help,
    issue: requireNonEmpty(values.issue as string | undefined, '--issue'),
    pr: requireNonEmpty(values.pr as string | undefined, '--pr'),
    repo: requireNonEmpty(values.repo as string | undefined, '--repo'),
    dryRun: values['dry-run'] as boolean,
    apply: values.apply as boolean,
    phase: requireNonEmpty(values.phase as string | undefined, '--phase'),
    claim: requireNonEmpty(values.claim as string | undefined, '--claim'),
    branch: requireNonEmpty(values.branch as string | undefined, '--branch'),
    lastChecked: requireNonEmpty(
      values['last-checked'] as string | undefined,
      '--last-checked',
    ),
    openBlockers: requireNonEmpty(
      values['open-blockers'] as string | undefined,
      '--open-blockers',
    ),
    nextAction: requireNonEmpty(
      values['next-action'] as string | undefined,
      '--next-action',
    ),
    authoritativeBy: requireNonEmpty(
      values['authoritative-by'] as string | undefined,
      '--authoritative-by',
    ),
    claimIssue: requireNonEmpty(
      values['claim-issue'] as string | undefined,
      '--claim-issue',
    ),
    claimId: requireNonEmpty(
      values['claim-id'] as string | undefined,
      '--claim-id',
    ),
    agentId: requireNonEmpty(
      values['agent-id'] as string | undefined,
      '--agent-id',
    ),
    skipClaimCheck: values['skip-claim-check'] as boolean,
    includeBody: values['include-body'] as boolean,
  };

  for (const flag of [
    ['phase', '--phase'],
    ['claim', '--claim'],
    ['branch', '--branch'],
    ['openBlockers', '--open-blockers'],
    ['nextAction', '--next-action'],
    ['authoritativeBy', '--authoritative-by'],
  ] as const) {
    if (!parsedArgs[flag[0]]) {
      if (!parsedArgs.help) {
        fail(`${flag[1]} is required`);
      }
    }
  }

  return parsedArgs;
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    fail(`${flag} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

function currentIsoTimestamp(): string {
  return new Date().toISOString().replace('.000Z', 'Z');
}

function printUsage(): void {
  console.log(`usage: node scripts/live-status-digest.mjs (--issue <number> | --pr <number>) [options]

Options:
  --dry-run                         compute the create/update/noop action (default)
  --apply                           create or update the single current digest
  --phase <text>                    digest Phase field
  --claim <text>                    digest Claim field
  --branch <text>                   digest Branch field
  --last-checked <timestamp>        digest Last checked field (default: current UTC)
  --open-blockers <text>            digest Open blockers field
  --next-action <text>              digest Next action field
  --authoritative-by <text>         digest Authoritative by field
  --claim-issue <number>            issue whose active claim protects apply mode
  --claim-id <id>                   active claim id required for apply mode
  --agent-id <id>                   optionally require this claim agent id
  --skip-claim-check                explicit maintainer override for apply mode
  --repo <owner/name>               repository override
  --format <json|table>             output format (default: json)
  --include-body                    include the rendered body in JSON reports
  --help                            show this help

Environment:
  IDD_TRUSTED_MARKER_ACTORS         comma-separated trusted bot/app logins
  IDD_TRUST_COLLABORATOR_MARKERS    set true to trust Write/Maintain/Admin collaborators
`);
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}
