#!/usr/bin/env node
// idd-generated-from: src/scripts/resume-route-selection.mts
//
// The scripts/resume-route-selection.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';

import { parseCliArgs } from './cli-args.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type {
  ProviderChangeRequestSummary,
  ProviderComment,
  ProviderPort,
} from './provider-port.mts';

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** PR review payload fields consumed by this helper. */
interface ReviewPayload {
  user?: GhAuthorPayload | null;
  state?: string | null;
  submitted_at?: string | null;
}

/** Merge-state fields returned by `gh pr view`. */
interface MergeStatePayload {
  mergeable?: unknown;
  mergeStateStatus?: unknown;
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
  ghToken: string;
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
const RESUME_ROUTE_SELECTION_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--gh-token': { type: 'string' },
  '--token': { type: 'string' },
  '--table-dump': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

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
  if (args.ghToken) {
    process.env.GH_TOKEN = args.ghToken;
    process.env.GITHUB_TOKEN = args.ghToken;
  }

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);

  const routingInput = collectRoutingInput({
    port,
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
  port,
  issueNumber,
}: {
  port: ProviderPort;
  issueNumber: number | null;
}) {
  const prs = findIssueRelatedOpenPrs({ port, issueNumber });
  const issuePr = prs.length === 1 ? prs[0] : null;
  // resolveViewerLogin's REST leg is the exact gh api user --jq .login call
  // this file made directly pre-migration (same args, same options
  // profile); the only behavior delta is a GraphQL fallback attempt on a
  // 5xx/timeout REST failure before the identical error is re-thrown --
  // transport hygiene (widened resilience), not a distinct call shape.
  const viewerLogin = port.resolveViewerLogin().toLowerCase();
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

  const checks = port.listRequiredChecks(issuePr.number);
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

  const reviewThreads = port.listChangeRequestReviewThreads(issuePr.number);
  const unresolvedThreadCount = reviewThreads.filter(
    (thread) => thread.isResolved === false,
  ).length;

  const reviews = port.listReviews(issuePr.number) as ReviewPayload[];
  const changesRequestedCount = countLatestChangesRequestedByReviewer(reviews);
  const reviewExists = unresolvedThreadCount > 0 || reviews.length > 0;

  const comments = port.listWorkItemComments(issuePr.number);
  const unrepliedCommentCount = countUnrepliedRegularComments(
    comments,
    viewerLogin,
  );
  const reviewPending =
    unresolvedThreadCount > 0 ||
    unrepliedCommentCount > 0 ||
    changesRequestedCount > 0;

  // Fail closed: getChangeRequest returns null on a 404 rather than
  // throwing (unlike this file's pre-migration gh pr view, which threw on
  // any failure). issuePr was resolved moments earlier from the live open-PR
  // list, so a null here means the PR closed/vanished between the two
  // calls -- a genuine TOCTOU race, not a routine state; the generic
  // stdout-on-failure recovery the pre-migration ghJson wrapper also
  // applied here is dropped as untriggerable (gh pr view --json is not
  // documented to exit non-zero while still emitting valid JSON, unlike
  // gh pr checks).
  const mergeState = port.getChangeRequest(issuePr.number);
  if (!mergeState) {
    throw new Error(`PR #${issuePr.number} not found`);
  }
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
  port,
  issueNumber,
}: {
  port: ProviderPort;
  issueNumber: number | null;
}): ProviderChangeRequestSummary[] {
  const candidates = port.listOpenChangeRequests();
  const issueRefPattern = new RegExp(`(^|[^0-9])#${issueNumber}([^0-9]|$)`);
  return candidates.filter((pr) => issueRefPattern.test(pr.body));
}

function countUnrepliedRegularComments(
  comments: ProviderComment[],
  viewerLogin: string,
): number {
  const sorted = [...comments]
    .map((comment) => ({
      createdAt: Date.parse(comment.createdAt),
      author: comment.authorLogin.toLowerCase(),
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

function parseArgs(argv: string[]): ResumeRouteSelectionArgs {
  const { values, help } = parseCliArgs(argv, RESUME_ROUTE_SELECTION_FLAG_SPEC);
  const issueToken = values.issue as string | undefined;
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
  return {
    // Kept as lenient Number.parseInt (not the canonical-integer helper),
    // matching the pre-migration contract exactly -- see #1451's PR
    // description for why this is not tightened here.
    issue: issueToken === undefined ? null : Number.parseInt(issueToken, 10),
    owner: (values.owner as string | undefined) ?? '',
    repo: (values.repo as string | undefined) ?? '',
    ghToken: ghToken ?? '',
    tableDump: values['table-dump'] as boolean,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/resume-route-selection.mjs --issue <number> [--owner <owner>] [--repo <repo>] [--gh-token <token>] [--table-dump]
  Deprecated aliases (one release): --token -> --gh-token

Output schema:
{
  "route": "D1|D4|E1|E15|Esync|F1|F2|stop",
  "reason": "...",
  "state": {"prExists": true, "ciSuccess": false, ...},
  "evidence": {"rule_trace": ["..."]}
}
`);
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
