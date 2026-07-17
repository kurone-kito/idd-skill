#!/usr/bin/env node
// idd-generated-from: src/scripts/resume-route-selection.mts
//
// The scripts/resume-route-selection.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';

import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import { parsePaginatedGhNdjson } from './protocol-helpers.mts';

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** Open-PR candidate row returned by `gh pr list`. */
interface PrCandidatePayload {
  number?: number;
  title?: string | null;
  body?: string | null;
  url?: string | null;
}

/** CI status-check entry returned by `gh pr checks`. */
interface CheckPayload {
  name?: string | null;
  state?: string | null;
  completedAt?: string | null;
}

/** PR review payload fields consumed by this helper. */
interface ReviewPayload {
  user?: GhAuthorPayload | null;
  state?: string | null;
  submitted_at?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  created_at?: string | null;
  user?: GhAuthorPayload | null;
}

/** Merge-state fields returned by `gh pr view`. */
interface MergeStatePayload {
  mergeable?: unknown;
  mergeStateStatus?: unknown;
}

/** GraphQL `reviewThreads` connection slice consumed by this helper. */
interface ReviewThreadsConnectionPayload {
  nodes?: { isResolved?: boolean | null }[] | null;
  pageInfo?: {
    hasNextPage?: boolean | null;
    endCursor?: string | null;
  } | null;
}

/** Routing input accepted by {@link selectResumeRoute}. */
interface ResumeRouteInput {
  prAmbiguous?: unknown;
  prExists?: unknown;
  requiredChecksGenerated?: unknown;
  hasUnpushedCommits?: unknown;
  worktreeDirty?: unknown;
  ciRunning?: unknown;
  ciFailed?: unknown;
  ciSuccess?: unknown;
  reviewExists?: unknown;
  reviewPending?: unknown;
  branchState?: unknown;
}

/** Fully-defaulted routing state derived from {@link ResumeRouteInput}. */
interface NormalizedResumeRouteState {
  prAmbiguous: boolean;
  prExists: boolean;
  requiredChecksGenerated: boolean;
  hasUnpushedCommits: boolean;
  worktreeDirty: boolean;
  ciRunning: boolean;
  ciFailed: boolean;
  ciSuccess: boolean;
  reviewExists: boolean;
  reviewPending: boolean;
  branchState: string;
}

/** Parsed CLI arguments. */
interface ResumeRouteSelectionArgs {
  issue: number | null;
  owner: string;
  repo: string;
  token: string;
  tableDump: boolean;
  help: boolean;
}

const RUNNING_STATES = new Set([
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'requested',
]);
const FAILURE_STATES = new Set(['failure', 'cancelled', 'timed_out']);
const PASS_EQUIVALENT_STATES = new Set([
  'success',
  'skipped',
  'neutral',
  'not_applicable',
]);

/**
 * The documented branch-state taxonomy: every value {@link classifyBranchState}
 * can return and that {@link selectResumeRoute} routes on. A caller-supplied
 * `branchState` outside this set is unrecognized and normalizes to the cautious
 * `'unknown'` (which routes to `stop`) rather than the permissive `'clean'`.
 */
const BRANCH_STATES = new Set([
  'clean',
  'behind-no-conflict',
  'content-conflict',
  'dirty',
  'computing',
  'unknown',
]);

if (import.meta.main) {
  runCli();
}

export function selectResumeRoute(input: ResumeRouteInput) {
  const state = normalizeState(input);
  const reasonParts: string[] = [];

  if (state.prAmbiguous) {
    return result('stop', 'multiple-open-prs-for-issue', state, reasonParts);
  }

  if (!state.prExists) {
    if (state.hasUnpushedCommits && !state.worktreeDirty) {
      return result('D1', 'no-pr-unpushed-clean-worktree', state, reasonParts);
    }
    if (!state.requiredChecksGenerated) {
      return result(
        'D4',
        'no-pr-required-checks-not-generated',
        state,
        reasonParts,
      );
    }
    return result('stop', 'no-pr-no-unpushed-clean-path', state, reasonParts);
  }

  if (!state.requiredChecksGenerated) {
    return result(
      state.reviewExists ? 'E15' : 'D4',
      'pr-required-checks-not-generated',
      state,
      reasonParts,
    );
  }

  if (state.ciRunning) {
    return result(
      state.reviewExists ? 'E15' : 'D4',
      'pr-ci-running',
      state,
      reasonParts,
    );
  }

  if (state.ciFailed) {
    return result(
      state.reviewExists ? 'E15' : 'D4',
      'pr-ci-failed',
      state,
      reasonParts,
    );
  }

  if (state.ciSuccess) {
    if (state.reviewPending) {
      return result('E1', 'pr-ci-success-review-pending', state, reasonParts);
    }
    if (state.branchState === 'content-conflict') {
      return result(
        'Esync',
        'pr-ci-success-content-conflict',
        state,
        reasonParts,
      );
    }
    if (state.branchState === 'dirty' || state.branchState === 'unknown') {
      return result(
        'stop',
        'pr-ci-success-branch-dirty-or-unknown',
        state,
        reasonParts,
      );
    }
    if (state.branchState === 'computing') {
      // Mergeability is still computing (transient `UNKNOWN`); resume into F1,
      // whose bounded re-poll resolves it instead of stopping on a
      // self-resolving state.
      return result('F1', 'pr-ci-success-branch-computing', state, reasonParts);
    }
    if (state.branchState === 'behind-no-conflict') {
      return result(
        'F1',
        'pr-ci-success-branch-behind-no-conflict',
        state,
        reasonParts,
      );
    }
    return result('F2', 'pr-ci-success-no-review-pending', state, reasonParts);
  }

  return result('stop', 'pr-ci-unknown-state', state, reasonParts);
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

  const routingInput = collectRoutingInput({
    repository,
    issueNumber: args.issue,
  });
  const selected = selectResumeRoute(routingInput);

  const output: {
    repository: { owner: string; repo: string };
    issue: number | null;
    route: string;
    reason: string;
    state: NormalizedResumeRouteState;
    evidence: { rule_trace: string[] };
    decision_table?: { condition: string; route: string }[];
  } = {
    repository: { owner, repo },
    issue: args.issue,
    route: selected.route,
    reason: selected.reason,
    state: selected.state,
    evidence: selected.evidence,
  };

  if (args.tableDump) {
    output.decision_table = decisionTable();
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function collectRoutingInput({
  repository,
  issueNumber,
}: {
  repository: string;
  issueNumber: number | null;
}) {
  const prs = findIssueRelatedOpenPrs({ repository, issueNumber });
  const issuePr = prs.length === 1 ? prs[0] : null;
  const viewerLogin = ghText(
    ['api', 'user', '--jq', '.login'],
    GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ).toLowerCase();
  const gitState = collectLocalGitState();

  if (!issuePr) {
    return {
      prAmbiguous: prs.length > 1,
      prExists: false,
      requiredChecksGenerated: false,
      hasUnpushedCommits: gitState.hasUnpushedCommits,
      worktreeDirty: gitState.worktreeDirty,
      ciChecks: [],
      ciRunning: false,
      ciFailed: false,
      ciSuccess: false,
      reviewExists: false,
      reviewPending: false,
      unresolvedThreadCount: 0,
      unrepliedCommentCount: 0,
      changesRequestedCount: 0,
      branchState: 'clean',
      prCount: prs.length,
      prNumber: null,
      prUrl: null,
    };
  }

  const checks = ghJson(
    [
      'pr',
      'checks',
      String(issuePr.number),
      '--repo',
      repository,
      '--required',
      '--json',
      'name,state,completedAt',
    ],
    { allowNoRequiredChecks: true },
  ) as CheckPayload[];
  const normalizedStates = checks.map((check) =>
    String(check.state ?? '').toLowerCase(),
  );
  const requiredChecksGenerated = checks.length > 0;
  const ciRunning = normalizedStates.some((state) => RUNNING_STATES.has(state));
  const ciFailed = normalizedStates.some((state) => FAILURE_STATES.has(state));
  const ciSuccess =
    requiredChecksGenerated &&
    !ciRunning &&
    !ciFailed &&
    normalizedStates.every((state) => PASS_EQUIVALENT_STATES.has(state));

  const reviewThreads = fetchReviewThreads({
    owner: repository.split('/')[0],
    repo: repository.split('/')[1],
    number: issuePr.number,
  });
  const unresolvedThreadCount = reviewThreads.filter(
    (thread) => thread.isResolved === false,
  ).length;

  const reviews = ghApiJson(
    `repos/${repository}/pulls/${issuePr.number}/reviews`,
    true,
  ) as ReviewPayload[];
  const changesRequestedCount = countLatestChangesRequestedByReviewer(reviews);
  const reviewExists = unresolvedThreadCount > 0 || reviews.length > 0;

  const comments = ghApiJson(
    `repos/${repository}/issues/${issuePr.number}/comments`,
    true,
  ) as IssueCommentPayload[];
  const unrepliedCommentCount = countUnrepliedRegularComments(
    comments,
    viewerLogin,
  );
  const reviewPending =
    unresolvedThreadCount > 0 ||
    unrepliedCommentCount > 0 ||
    changesRequestedCount > 0;

  const mergeState = ghJson([
    'pr',
    'view',
    String(issuePr.number),
    '--repo',
    repository,
    '--json',
    'mergeable,mergeStateStatus',
  ]) as MergeStatePayload;
  const branchState = classifyBranchState(mergeState);

  return {
    prAmbiguous: false,
    prExists: true,
    requiredChecksGenerated,
    hasUnpushedCommits: gitState.hasUnpushedCommits,
    worktreeDirty: gitState.worktreeDirty,
    ciChecks: checks,
    ciRunning,
    ciFailed,
    ciSuccess,
    reviewExists,
    reviewPending,
    unresolvedThreadCount,
    unrepliedCommentCount,
    changesRequestedCount,
    branchState,
    prCount: prs.length,
    prNumber: issuePr.number,
    prUrl: issuePr.url,
  };
}

function collectLocalGitState() {
  const worktreeDirty = runGit(['status', '--porcelain']).trim().length > 0;
  const hasUnpushedCommits = detectUnpushedCommits();
  return {
    hasUnpushedCommits,
    worktreeDirty,
  };
}

function detectUnpushedCommits(): boolean {
  const hasUpstream = runGitAllowFailure([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]).ok;
  if (hasUpstream) {
    return runGit(['log', '--oneline', '@{u}..HEAD']).trim().length > 0;
  }
  return runGit(['rev-list', '--count', 'HEAD']).trim() !== '0';
}

function findIssueRelatedOpenPrs({
  repository,
  issueNumber,
}: {
  repository: string;
  issueNumber: number | null;
}): PrCandidatePayload[] {
  const candidates = ghJson([
    'pr',
    'list',
    '--repo',
    repository,
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title,body,url',
  ]) as PrCandidatePayload[];
  const issueRefPattern = new RegExp(`(^|[^0-9])#${issueNumber}([^0-9]|$)`);
  return candidates.filter((pr) => issueRefPattern.test(String(pr.body ?? '')));
}

function countUnrepliedRegularComments(
  comments: IssueCommentPayload[],
  viewerLogin: string,
): number {
  const sorted = [...comments]
    .map((comment) => ({
      createdAt: Date.parse(String(comment.created_at ?? '')),
      author: String(comment.user?.login ?? '').toLowerCase(),
    }))
    .filter((comment) => Number.isFinite(comment.createdAt))
    .sort((left, right) => left.createdAt - right.createdAt);

  let count = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const comment = sorted[index];
    if (!comment.author || comment.author === viewerLogin) {
      continue;
    }
    const replied = sorted
      .slice(index + 1)
      .some((later) => later.author === viewerLogin);
    if (!replied) {
      count += 1;
    }
  }
  return count;
}

export function classifyBranchState(
  mergeState: MergeStatePayload | null | undefined,
): string {
  const rawMergeable = mergeState?.mergeable;
  const mergeable = String(rawMergeable ?? '').toUpperCase();
  const mergeStateStatus = String(
    mergeState?.mergeStateStatus ?? '',
  ).toUpperCase();
  if (mergeable === 'CONFLICTING') return 'content-conflict';
  if (mergeStateStatus === 'DIRTY') return 'dirty';
  if (mergeStateStatus === 'CLEAN') return 'clean';
  if (mergeStateStatus === 'BEHIND') return 'behind-no-conflict';
  if (mergeable === 'MERGEABLE') return 'clean';
  // GitHub computes `mergeable` asynchronously: an explicit `UNKNOWN` — or an
  // explicit `null` mergeable on a present payload — means the result is still
  // computing (transient), not a terminal classification failure. A genuinely
  // missing/unparseable payload (no `mergeable` field at all, i.e. `undefined`)
  // stays terminal `unknown`.
  if (mergeable === 'UNKNOWN' || rawMergeable === null) return 'computing';
  return 'unknown';
}

export function countLatestChangesRequestedByReviewer(
  reviews: ReviewPayload[],
): number {
  const latestByReviewer = new Map<
    string,
    { state: string; submittedAt: number }
  >();
  for (const review of reviews) {
    const reviewer = String(review.user?.login ?? '').toLowerCase();
    const state = String(review.state ?? '').toUpperCase();
    if (!reviewer || state === 'COMMENTED' || state === 'PENDING') {
      continue;
    }
    const submittedAt = Date.parse(String(review.submitted_at ?? ''));
    if (!Number.isFinite(submittedAt)) {
      continue;
    }
    const current = latestByReviewer.get(reviewer);
    if (!current || submittedAt >= current.submittedAt) {
      latestByReviewer.set(reviewer, { state, submittedAt });
    }
  }
  let count = 0;
  for (const review of latestByReviewer.values()) {
    if (review.state === 'CHANGES_REQUESTED') {
      count += 1;
    }
  }
  return count;
}

function normalizeState(input: ResumeRouteInput): NormalizedResumeRouteState {
  return {
    prAmbiguous: input.prAmbiguous === true,
    prExists: input.prExists === true,
    requiredChecksGenerated: input.requiredChecksGenerated === true,
    hasUnpushedCommits: input.hasUnpushedCommits === true,
    worktreeDirty: input.worktreeDirty === true,
    ciRunning: input.ciRunning === true,
    ciFailed: input.ciFailed === true,
    ciSuccess: input.ciSuccess === true,
    reviewExists: input.reviewExists === true,
    reviewPending: input.reviewPending === true,
    branchState:
      typeof input.branchState === 'string' &&
      BRANCH_STATES.has(input.branchState)
        ? input.branchState
        : 'unknown',
  };
}

function result(
  route: string,
  reason: string,
  state: NormalizedResumeRouteState,
  reasonParts: string[],
) {
  return {
    route,
    reason,
    state,
    evidence: {
      rule_trace: [...reasonParts, reason],
    },
  };
}

function decisionTable(): { condition: string; route: string }[] {
  return [
    { condition: 'multiple open PRs match issue', route: 'stop' },
    { condition: 'no PR + required checks not generated', route: 'D4' },
    { condition: 'no PR + clean worktree + unpushed commits', route: 'D1' },
    { condition: 'PR + checks not generated + no reviews', route: 'D4' },
    { condition: 'PR + checks not generated + reviews exist', route: 'E15' },
    { condition: 'PR + CI running/failing + no reviews', route: 'D4' },
    { condition: 'PR + CI running/failing + reviews exist', route: 'E15' },
    { condition: 'PR + CI success + review pending', route: 'E1' },
    {
      condition: 'PR + CI success + no review pending + content conflict',
      route: 'Esync',
    },
    {
      condition:
        'PR + CI success + no review pending + dirty or unknown branch state',
      route: 'stop',
    },
    {
      condition: 'PR + CI success + no review pending + behind (no conflict)',
      route: 'F1',
    },
    {
      condition: 'PR + CI success + no review pending + clean branch',
      route: 'F2',
    },
  ];
}

function fetchReviewThreads({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number | undefined;
}): { isResolved?: boolean | null }[] {
  const threads: { isResolved?: boolean | null }[] = [];
  let cursor: string | null | undefined = null;
  while (true) {
    const response: ReviewThreadsConnectionPayload | null | undefined = (
      ghApiGraphqlJson({
        query:
          'query($owner:String!, $repo:String!, $number:Int!, $cursor:String) { repository(owner:$owner,name:$repo){ pullRequest(number:$number){ reviewThreads(first:100, after:$cursor){ nodes{ isResolved } pageInfo{ hasNextPage endCursor } } } } }',
        variables: {
          owner,
          repo,
          number,
          cursor,
        },
      }) as {
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: ReviewThreadsConnectionPayload | null;
            } | null;
          } | null;
        } | null;
      }
    ).data?.repository?.pullRequest?.reviewThreads;
    const nodes = response?.nodes ?? [];
    threads.push(...nodes);
    const pageInfo: ReviewThreadsConnectionPayload['pageInfo'] =
      response?.pageInfo;
    if (!pageInfo?.hasNextPage) {
      break;
    }
    // hasNextPage with a missing cursor would silently undercount
    // unresolved threads; fail fast on the malformed payload instead,
    // matching the other pagination loops in this cluster.
    if (!pageInfo.endCursor) {
      throw new Error('review thread pagination payload is missing endCursor');
    }
    cursor = pageInfo.endCursor;
  }
  return threads;
}

function parseArgs(argv: string[]): ResumeRouteSelectionArgs {
  const parsed: ResumeRouteSelectionArgs = {
    issue: null,
    owner: '',
    repo: '',
    token: '',
    tableDump: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = () => {
      if (value === undefined || String(value).startsWith('--')) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    if (token === '--issue') {
      parsed.issue = Number.parseInt(String(requireValue()), 10);
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
    if (token === '--token') {
      parsed.token = requireValue();
      index += 1;
      continue;
    }
    if (token === '--table-dump') {
      parsed.tableDump = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/resume-route-selection.mjs --issue <number> [--owner <owner>] [--repo <repo>] [--token <token>] [--table-dump]

Output schema:
{
  "route": "D1|D4|E1|E15|Esync|F1|F2|stop",
  "reason": "...",
  "state": {"prExists": true, "ciSuccess": false, ...},
  "evidence": {"rule_trace": ["..."]}
}
`);
}

function ghApiGraphqlJson({
  query,
  variables,
}: {
  query: string;
  variables: Record<string, string | number | null | undefined>;
}): unknown {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Number.isInteger(value)) {
      args.push('-F', `${key}=${value}`);
    } else {
      args.push('-f', `${key}=${value}`);
    }
  }
  return JSON.parse(runGh(args).trim() || '{}');
}

function ghApiJson(path: string, paginate = false): unknown {
  const args = ['api', path];
  if (paginate) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    args.push('--paginate', '--jq', '.[]');
  }
  const raw = runGh(args).trim();
  if (!paginate) {
    return JSON.parse(raw || '[]');
  }
  if (!raw) {
    return [];
  }
  return parsePaginatedGhNdjson(raw);
}

function ghJson(
  args: string[],
  options: { allowNoRequiredChecks?: boolean } = {},
): unknown {
  try {
    return JSON.parse(runGh(args).trim() || '{}');
  } catch (error) {
    const recovered = recoverJsonFromGhFailure(error, options);
    if (recovered.recovered) {
      return recovered.value;
    }
    throw error;
  }
}

export function recoverJsonFromGhFailure(
  error: unknown,
  options: { allowNoRequiredChecks?: boolean } = {},
): { recovered: boolean; value: unknown } {
  const stderr = String((error as { stderr?: unknown } | null)?.stderr ?? '');
  if (
    options.allowNoRequiredChecks &&
    /no required checks reported/i.test(stderr)
  ) {
    return { recovered: true, value: [] };
  }

  const stdout = String(
    (error as { stdout?: unknown } | null)?.stdout ?? '',
  ).trim();
  if (stdout) {
    return { recovered: true, value: JSON.parse(stdout) };
  }

  return { recovered: false, value: null };
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
      const wrapped = new Error(`gh command failed: ${stderr}`) as Error & {
        stderr?: string;
        stdout?: string;
      };
      wrapped.stderr = String(
        (error as { stderr?: unknown } | null)?.stderr ?? '',
      );
      wrapped.stdout = String(
        (error as { stdout?: unknown } | null)?.stdout ?? '',
      );
      throw wrapped;
    }
    throw error;
  }
}

function runGit(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(
      (error as { stderr?: unknown } | null)?.stderr ?? '',
    ).trim();
    if (stderr) {
      throw new Error(`git command failed: ${stderr}`);
    }
    throw error;
  }
}

function runGitAllowFailure(args: string[]) {
  try {
    const stdout = execFileSync('git', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stderr: String((error as { stderr?: unknown } | null)?.stderr ?? ''),
    };
  }
}
