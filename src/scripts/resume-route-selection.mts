#!/usr/bin/env node

// idd-generated-from: src/scripts/resume-route-selection.mts
//
// The scripts/resume-route-selection.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import {
  buildCiWaitStateSummary,
  type CiWaitCheckEntry,
  selectLatestCheckEntry,
} from './ci-wait-state.mts';
import { parseCliArgs } from './cli-args.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { type IddConfig, loadTrustedIddConfig } from './idd-config.mts';
import {
  type EnclosingListContentIndentCache,
  indentationColumns,
  isInterruptingListMarker,
  MARKDOWN_CUSTOM_HTML_BLOCK_START_LINE_PATTERN,
  MARKDOWN_HTML_BLOCK_START_PATTERN,
  MARKDOWN_THEMATIC_BREAK_PATTERN,
  maskMarkdownForScan,
  parseListItemMatch,
  stripEnclosingListContentIndent,
} from './markdown-code.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';
import { summarizeBranchReviewRequirements } from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type {
  ProviderChangeRequestSummary,
  ProviderComment,
  ProviderGovernanceReadOutcome,
  ProviderPort,
} from './provider-port.mts';
import { CLOSING_KEYWORD_ALTERNATION } from './supersession-detection.mts';

/** A GitHub task-list checkbox after a list marker, with its padding. */
const TASK_CHECKBOX_PREFIX = /^\[[ xX]\][ \t]+/u;

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
  noRequiredChecksConfigured?: unknown;
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
  noRequiredChecksConfigured: boolean;
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
  // #3343: call runCli() directly when the envelope is disabled -- see
  // applyHelperCliOutcomeWhenDisabled's own doc comment for why.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('resume-route-selection', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
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

  if (!state.requiredChecksGenerated && !state.noRequiredChecksConfigured) {
    return result(
      state.reviewExists ? 'E15' : 'D4',
      'pr-required-checks-not-generated',
      state,
      reasonParts,
    );
  }

  // A repository can have no required checks while its PR still has an
  // ordinary present-run check set. An empty or unknown present-run set is
  // not a vacuous pass: keep the existing D4/E15 fail-closed routing until a
  // concrete check result is available.
  if (
    state.noRequiredChecksConfigured &&
    !state.ciRunning &&
    !state.ciFailed &&
    !state.ciSuccess
  ) {
    return result(
      state.reviewExists ? 'E15' : 'D4',
      'pr-present-run-not-generated',
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

function runCli(): HelperCliResult {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isInteger(args.issue) || (args.issue ?? 0) <= 0) {
    throw markCliUsageError(
      new Error('--issue is required and must be a positive integer'),
    );
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
  return 0;
}

/**
 * Collect the routing input for one claimed issue.
 *
 * `loadTrustedConfig` resolves policy from a ref that the PR under evaluation
 * cannot edit. `collectGitState` reads the local worktree state (whether it is
 * dirty and whether it has unpushed commits); it defaults to the real `git`
 * reader and exists so tests can inject a fixed state instead of starting git
 * processes.
 */
export function collectRoutingInput({
  port,
  issueNumber,
  loadTrustedConfig = loadTrustedIddConfig,
  collectGitState = collectLocalGitState,
}: {
  port: ProviderPort;
  issueNumber: number | null;
  /** Resolve policy from a ref the PR under evaluation cannot edit. */
  loadTrustedConfig?: (
    owner: string,
    repo: string,
    ref: string,
  ) => IddConfig | null;
  /** Read the local worktree state; tests inject a fixed state. */
  collectGitState?: () => {
    hasUnpushedCommits: boolean;
    worktreeDirty: boolean;
  };
}) {
  const prs = findIssueRelatedOpenPrs({ port, issueNumber });
  const issuePr = prs.length === 1 ? prs[0] : null;
  // resolveViewerLogin's REST leg is the exact gh api user --jq .login call
  // this file made directly pre-migration (same args, same options
  // profile); the only behavior delta is a GraphQL fallback attempt on a
  // 5xx/timeout REST failure before the identical error is re-thrown --
  // transport hygiene (widened resilience), not a distinct call shape.
  const viewerLogin = port.resolveViewerLogin().toLowerCase();
  const gitState = collectGitState();

  if (!issuePr) {
    return {
      prAmbiguous: prs.length > 1,
      prExists: false,
      requiredChecksGenerated: false,
      noRequiredChecksConfigured: false,
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

  const branchAndChecks = port.getChangeRequestBranchAndChecks(issuePr.number);
  const requiredChecksSummary = port.listRequiredChecksSummary(issuePr.number);
  const repository = port.resolveRepositoryLocator();
  const trustedConfigRef =
    branchAndChecks.baseRefName ||
    port.getRepositoryDefaultBranch(repository.owner, repository.name);
  if (!trustedConfigRef) {
    throw new Error(
      `cannot resolve a trusted ref for .github/idd/config.json: PR #${issuePr.number} has no baseRefName and the repository's live default branch could not be determined`,
    );
  }
  const policyConfig = normalizePolicyConfig(
    loadTrustedConfig(repository.owner, repository.name, trustedConfigRef),
  );
  const trustEmptyProtectionReads =
    policyConfig.ciGate.trustEmptyProtectionReads === true;
  const branchRulesOutcome = readResumeGovernanceOutcome(() =>
    port.listBranchRules(repository.owner, repository.name, trustedConfigRef),
  );
  const branchProtectionOutcome = readResumeGovernanceOutcome(() =>
    port.getBranchProtection(
      repository.owner,
      repository.name,
      trustedConfigRef,
    ),
  );
  const protectionReadsUnreadable =
    branchRulesOutcome.outcome === 'unreadable' ||
    branchProtectionOutcome.outcome === 'unreadable' ||
    (!trustEmptyProtectionReads &&
      branchRulesOutcome.outcome === 'not-found') ||
    (!trustEmptyProtectionReads &&
      branchProtectionOutcome.outcome === 'not-found');
  const branchRules =
    branchRulesOutcome.outcome === 'ok' ? branchRulesOutcome.value : [];
  const branchProtection =
    branchProtectionOutcome.outcome === 'ok'
      ? branchProtectionOutcome.value
      : {};
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules as Parameters<typeof summarizeBranchReviewRequirements>[0],
    branchProtection as Parameters<typeof summarizeBranchReviewRequirements>[1],
  );
  const requiredChecksConfigurationPresent =
    branchReviewRequirements.requiredCheckSourcePinned ||
    branchReviewRequirements.requiredCheckNames.length > 0;
  const configuredRequiredCheckNames = new Set(
    branchReviewRequirements.requiredCheckNames,
  );
  const summarizedRequiredCheckNames = new Set(
    requiredChecksSummary.checks
      .map((check) => String(check.name ?? '').trim())
      .filter(Boolean),
  );
  const requiredCheckSourcesDisagree =
    (requiredChecksSummary.checks.length > 0 &&
      !requiredChecksConfigurationPresent) ||
    (configuredRequiredCheckNames.size > 0 &&
      summarizedRequiredCheckNames.size !==
        configuredRequiredCheckNames.size) ||
    [...summarizedRequiredCheckNames].some(
      (name) => !configuredRequiredCheckNames.has(name),
    );
  const ciWaitState = buildCiWaitStateSummary(
    {
      headRefOid: branchAndChecks.headSha,
      statusCheckRollup: branchAndChecks.statusCheckRollup as Parameters<
        typeof buildCiWaitStateSummary
      >[0]['statusCheckRollup'],
    },
    {
      requiredCheckNames: branchReviewRequirements.requiredCheckNames,
      requiredCheckSourcePinned:
        branchReviewRequirements.requiredCheckSourcePinned,
      requiredCheckSourcePinnedUnresolved:
        branchReviewRequirements.requiredCheckSourcePinnedUnresolved,
      trustSourcePinnedRequiredChecks:
        policyConfig.ciGate.trustSourcePinnedRequiredChecks === true,
    },
  );
  const noRequiredChecksConfigured =
    !protectionReadsUnreadable &&
    requiredChecksSummary.noRequiredChecksConfigured &&
    requiredChecksSummary.checks.length === 0 &&
    !requiredChecksConfigurationPresent;
  const requiredChecksGenerated =
    !noRequiredChecksConfigured &&
    !protectionReadsUnreadable &&
    !requiredCheckSourcesDisagree &&
    requiredChecksConfigurationPresent &&
    requiredChecksSummary.checks.length > 0 &&
    ciWaitState.requiredChecks.allRequiredPresent;
  const requiredChecks = ciWaitState.checks.filter((check) => check.required);
  const presentChecks = selectLatestPresentRunChecks(ciWaitState.checks);
  const presentRunIdentityUnresolved = ciWaitState.checks.some(
    (check) =>
      check.type === 'check-run' &&
      check.workflowPath == null &&
      (check.workflowRunPresent !== false || check.appSlug == null),
  );
  const checks = noRequiredChecksConfigured ? presentChecks : requiredChecks;
  const ciChecks = checks.map((check) => ({
    name: check.checkName,
    state: check.state,
    completedAt: check.completedAt || null,
  }));
  const ciRunning = noRequiredChecksConfigured
    ? presentChecks.some((check) => check.status === 'pending')
    : ciWaitState.requiredChecks.anyRequiredPending;
  const ciFailed = noRequiredChecksConfigured
    ? presentChecks.some((check) => check.status === 'failure')
    : ciWaitState.requiredChecks.anyRequiredFailing;
  const ciSuccess = noRequiredChecksConfigured
    ? presentChecks.length > 0 &&
      !presentRunIdentityUnresolved &&
      presentChecks.every((check) => check.status === 'success')
    : !protectionReadsUnreadable &&
      !requiredCheckSourcesDisagree &&
      requiredChecksConfigurationPresent &&
      requiredChecksSummary.checks.length > 0 &&
      ciWaitState.requiredChecks.status === 'success';

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
    noRequiredChecksConfigured,
    hasUnpushedCommits: gitState.hasUnpushedCommits,
    worktreeDirty: gitState.worktreeDirty,
    ciChecks,
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

type ResumeGovernanceReadOutcome<T> =
  | ProviderGovernanceReadOutcome<T>
  | { outcome: 'unreadable' };

/**
 * Resume routing must turn an explicit governance 403 into a hold signal.
 * The provider adapter preserves other non-404 failures as thrown errors for
 * callers whose failure contract is different, so catch only this permission
 * outcome at the D4 boundary (Codex review, PR #3150).
 */
function readResumeGovernanceOutcome<T>(
  read: () => ProviderGovernanceReadOutcome<T>,
): ResumeGovernanceReadOutcome<T> {
  try {
    return read();
  } catch (error) {
    if (deriveGhHttpStatus(error) === 403) {
      return { outcome: 'unreadable' };
    }
    throw error;
  }
}

function selectLatestPresentRunChecks(
  checks: CiWaitCheckEntry[],
): CiWaitCheckEntry[] {
  const groups = new Map<string, CiWaitCheckEntry[]>();
  for (const check of checks) {
    const key = `${check.type}\u0000${check.checkName}\u0000${check.workflowName}\u0000${check.workflowPath ?? '<unresolved>'}\u0000${check.appSlug ?? '<unresolved>'}\u0000${check.workflowRunPresent === false ? '<external-app>' : '<workflow>'}`;
    const group = groups.get(key);
    if (group) {
      group.push(check);
    } else {
      groups.set(key, [check]);
    }
  }
  return [...groups.values()].map((group) => selectLatestCheckEntry(group));
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
  if (!Number.isInteger(issueNumber) || (issueNumber ?? 0) <= 0) {
    return [];
  }
  const targetIssueNumber = Number(issueNumber);
  const candidates = port.listOpenChangeRequests();
  const repository = port.resolveRepositoryLocator();
  return candidates.filter((pr) => {
    // D3.5 defines a relationship through a plain-text closing keyword in
    // the PR body. Exclude blockquotes, including unmarked lazy paragraph
    // continuations, before masking code and matching each keyword directly
    // to one same-repository reference. D3.5's matcher is intentionally
    // negation-blind, like GitHub's closing-keyword parser; this prevents
    // incidental mentions such as the one reported in #3763 from making
    // Resume treat an unrelated PR as a second implementation.
    const bodyWithoutBlockQuotes = stripBlockQuotesAndLazyContinuations(
      pr.body,
    );
    const d35ClosingKeyword = new RegExp(
      `\\b(${CLOSING_KEYWORD_ALTERNATION})(\\s+)(#\\d+|[\\w.-]+/[\\w.-]+#\\d+)\\b`,
      'gi',
    );
    const maskedBody = maskMarkdownForScan(bodyWithoutBlockQuotes);
    return hasD35ClosingReference(
      maskedBody,
      bodyWithoutBlockQuotes,
      d35ClosingKeyword,
      {
        issueNumber: targetIssueNumber,
        owner: repository.owner,
        repo: repository.name,
      },
    );
  });
}

function stripBlockQuotesAndLazyContinuations(body: string): string {
  let quotedParagraphOpen = false;
  let paragraphOpen = false;
  // Content column of the list item that the previous line opened with
  // paragraph text, or `null`. A line inside that item continues the
  // paragraph, so a non-`1` ordered marker on it cannot start a list.
  let listItemParagraphColumn: number | null = null;
  // Content column of the list item whose marker had excess padding and so
  // starts with an indented code block, or `null` outside such a block.
  let listCodeContentColumn: number | null = null;
  // True from the first line that leaves such an item until a blank line, a
  // quote or any non-code line, so indented code that follows it stays masked.
  let followsListCode = false;
  const blockQuoteScanBarrier = '\u0000';
  const listIndentFastPath: ListProbeFlags = {
    skipDeeplyIndentedProbe: false,
    skipExitProbe: false,
  };
  const listZoneCache: EnclosingListContentIndentCache = {
    contentIndent: 0,
    nextLineStart: -1,
  };
  const normalizedBody = body.replace(/\r\n/gu, '\n');
  let lineStart = 0;
  return normalizedBody
    .split('\n')
    .map((line) => {
      const currentLineStart = lineStart;
      lineStart += line.length + 1;
      if (line.trim() === '') {
        quotedParagraphOpen = false;
        paragraphOpen = false;
        listItemParagraphColumn = null;
        followsListCode = false;
        return line;
      }

      const itemParagraphContinues =
        listItemParagraphColumn !== null &&
        indentationColumns(line) >= listItemParagraphColumn;
      listItemParagraphColumn = null;

      let probeForIndentedCode = false;
      if (listCodeContentColumn !== null) {
        // A blank line does not end the code block, so only a shallower
        // non-blank line does. Lines inside it skip the enclosing-list
        // probe, which keeps long code blocks linear (issue #3763).
        const lineColumns = indentationColumns(line);
        if (lineColumns >= listCodeContentColumn + 4) {
          // Keep the indentation: after a blank line the later code mask must
          // still see these lines as part of the item.
          return `${line.match(/^[ \t]*/u)?.[0] ?? ''}${blockQuoteScanBarrier}`;
        }
        // Still in the item but less than four columns past its content, the
        // line is a paragraph there; code that follows is top-level code.
        followsListCode = lineColumns < listCodeContentColumn;
        probeForIndentedCode = followsListCode;
        listCodeContentColumn = null;
      }

      const scan = scanBlockQuoteAndListPrefixes(line, {
        body: normalizedBody,
        lineStart: currentLineStart,
        probeFlags: listIndentFastPath,
        paragraphOpen: paragraphOpen || itemParagraphContinues,
        quoteParagraphOpen: quotedParagraphOpen,
        zoneCache: listZoneCache,
        probeForIndentedCode,
      });
      if (scan.kind === 'listCode') {
        listCodeContentColumn = scan.contentColumn;
        followsListCode = false;
        quotedParagraphOpen = false;
        paragraphOpen = false;
        // Keep the marker and its padding: the later code mask needs the list
        // item to recognize a fence or paragraph that belongs to it.
        return `${line.slice(0, line.length - scan.codeLength)}${blockQuoteScanBarrier}`;
      }
      if (scan.kind === 'quote') {
        followsListCode = false;
        quotedParagraphOpen = startsBlockQuoteParagraph(scan.content);
        paragraphOpen = false;
        return blockQuoteScanBarrier;
      }
      if (followsListCode) {
        if (scan.indentedCode) {
          return blockQuoteScanBarrier;
        }
        followsListCode = false;
      }

      if (quotedParagraphOpen) {
        if (!startsMarkdownBlock(line, true)) {
          return blockQuoteScanBarrier;
        }
        quotedParagraphOpen = false;
      }

      // A non-`1` ordered marker cannot interrupt an open paragraph, so the
      // line is paragraph text. Defuse the marker: the later code mask would
      // otherwise open a nested list there and misplace the lines after it.
      const isParagraphText =
        (paragraphOpen || itemParagraphContinues) &&
        isNonInterruptingListItem(line);
      paragraphOpen =
        isParagraphText || !startsMarkdownBlock(line, paragraphOpen);
      listItemParagraphColumn = isParagraphText
        ? null
        : listItemParagraphContentColumn(line);
      return isParagraphText ? defuseOrderedMarker(line) : line;
    })
    .join('\n');
}

function defuseOrderedMarker(line: string): string {
  return line.replace(/^([ \t]*\d{1,9})[.)]/u, '$1\u0001');
}

function isNonInterruptingListItem(line: string): boolean {
  const listItem = parseListItemMatch(line.trimStart());
  return listItem !== null && !isInterruptingListMarker(listItem.marker);
}

function listItemParagraphContentColumn(line: string): number | null {
  let content = line.trimStart();
  let column = indentationColumns(line);
  let contentColumn: number | null = null;
  for (
    let listItem = parseListItemMatch(content);
    listItem !== null;
    listItem = parseListItemMatch(content)
  ) {
    const markerEnd = column + listItem.marker.length;
    const padding = indentationColumns(listItem.spacing, markerEnd) - markerEnd;
    // Five or more columns of padding start the item with code, not text.
    contentColumn = markerEnd + (padding > 4 ? 1 : padding);
    column = markerEnd + padding;
    content = listItem.content.replace(TASK_CHECKBOX_PREFIX, '');
  }
  return contentColumn !== null &&
    content.trim() !== '' &&
    !content.startsWith('>') &&
    !startsMarkdownLeafBlock(content)
    ? contentColumn
    : null;
}

type ListProbeFlags = {
  skipDeeplyIndentedProbe: boolean;
  skipExitProbe: boolean;
};

type ListPrefixScan =
  | { kind: 'none'; indentedCode: boolean }
  | { kind: 'quote'; content: string }
  | { kind: 'listCode'; contentColumn: number; codeLength: number };

function stripBlockQuoteAndListPrefixes(line: string): string | null {
  const scan = scanBlockQuoteAndListPrefixes(line);
  return scan.kind === 'quote' ? scan.content : null;
}

interface LinePrefixScanOptions {
  /** The whole body and the line's offset in it, for the enclosing-list lookup. */
  body?: string;
  lineStart?: number;
  probeFlags?: ListProbeFlags;
  zoneCache?: EnclosingListContentIndentCache;
  /** A paragraph is open where this line continues it. */
  paragraphOpen?: boolean;
  /** A quote paragraph is open; it only counts after the line's own `>`. */
  quoteParagraphOpen?: boolean;
  /** The first line after list-item code that left the item: probe once. */
  probeForIndentedCode?: boolean;
}

function scanBlockQuoteAndListPrefixes(
  line: string,
  options: LinePrefixScanOptions = {},
): ListPrefixScan {
  const {
    body,
    lineStart,
    probeFlags: listIndentFastPath,
    zoneCache: listZoneCache,
    paragraphOpen = false,
    quoteParagraphOpen = false,
    probeForIndentedCode = false,
  } = options;
  // Most lines, including ordinary indented code, cannot become a
  // blockquote or nested list after list-content indentation is removed.
  // Avoid the helper's backward scan for those lines; doing it once per
  // line made large PR bodies quadratic (issue #3763).
  const mayContainBlockQuote = mayContainBlockQuoteAfterListMarkers(line);
  const leadingIndent = line.match(/^[ \t]*/u)?.[0] ?? '';
  const isDeeplyIndented = indentationColumns(leadingIndent) >= 4;
  const hasShallowListMarker =
    !isDeeplyIndented && parseListItemMatch(line.trimStart()) !== null;
  const previousSkipExitProbe = listIndentFastPath?.skipExitProbe ?? false;
  if (!isDeeplyIndented && line.trim() !== '' && listIndentFastPath) {
    listIndentFastPath.skipDeeplyIndentedProbe = false;
    listIndentFastPath.skipExitProbe = false;
  }
  // The first line to leave a list item's code block may still sit inside an
  // enclosing item, where four columns of indentation are not yet code.
  const shouldProbeEnclosingList =
    (mayContainBlockQuote &&
      !hasShallowListMarker &&
      !(isDeeplyIndented && listIndentFastPath?.skipDeeplyIndentedProbe)) ||
    (probeForIndentedCode &&
      isDeeplyIndented &&
      !listIndentFastPath?.skipExitProbe);
  const listContent =
    body === undefined || lineStart === undefined || !shouldProbeEnclosingList
      ? null
      : stripEnclosingListContentIndent(body, lineStart, listZoneCache);
  if (
    shouldProbeEnclosingList &&
    listContent === null &&
    isDeeplyIndented &&
    listIndentFastPath
  ) {
    // An unindented list/block boundary clears this negative cache above.
    // Until then, further deeply indented lines cannot acquire a new list
    // container, so marker-shaped indented code needs only one backward
    // probe rather than one scan per line (issue #3763).
    listIndentFastPath.skipDeeplyIndentedProbe = true;
  }
  if (
    probeForIndentedCode &&
    shouldProbeEnclosingList &&
    listContent === null &&
    listIndentFastPath
  ) {
    // Same idea for the line after a list item's code block: without an
    // enclosing item on one such line, repeated openers need no more probes.
    listIndentFastPath.skipExitProbe = true;
  }
  const candidate = listContent ?? line;
  if (isIndentedCodeBlock(candidate)) {
    return { kind: 'none', indentedCode: true };
  }
  let remaining = candidate.trimStart();
  // Absolute column (tabs stop every four columns) of `remaining`, taken from
  // the raw line: stripping an enclosing list's indent must not shift the
  // tab stops that decide how wide a marker's padding is.
  let column = indentationColumns(leadingIndent);
  let foundBlockQuote = false;
  let foundListMarker = false;
  while (remaining) {
    const markerPrefix = remaining.replace(/^ {0,3}/u, '');
    column += remaining.length - markerPrefix.length;
    if (markerPrefix.startsWith('>')) {
      foundBlockQuote = true;
      const afterQuote = markerPrefix.slice(1);
      const separator = afterQuote.match(/^[ \t]?/u)?.[0] ?? '';
      column = indentationColumns(separator, column + 1);
      remaining = afterQuote.slice(separator.length);
      continue;
    }
    const listMarker = markerPrefix.match(/^(?:[-+*]|\d{1,9}[.)])[ \t]+/u);
    if (listMarker) {
      const parsedListItem = parseListItemMatch(markerPrefix);
      // A line without a quote marker is not inside a quote paragraph, so
      // `quoteParagraphOpen` only counts after the line's own `>`.
      if (
        (paragraphOpen || (foundBlockQuote && quoteParagraphOpen)) &&
        !foundListMarker &&
        parsedListItem !== null &&
        !isInterruptingListMarker(parsedListItem.marker)
      ) {
        break;
      }
      foundListMarker = true;
      const marker = listMarker[0].trimEnd();
      const markerEndColumn = column + marker.length;
      const contentStartColumn = indentationColumns(
        listMarker[0].slice(marker.length),
        markerEndColumn,
      );
      remaining = markerPrefix.slice(listMarker[0].length);
      // Five or more columns of padding make the item start with one
      // separating space plus an indented code block, so a `>` there is
      // literal code rather than a quote (issue #3769).
      if (
        contentStartColumn - markerEndColumn > 4 &&
        mayContainBlockQuoteAfterListMarkers(
          remaining.replace(TASK_CHECKBOX_PREFIX, ''),
        )
      ) {
        // An opener starts no enclosing item, so it keeps the exit cache.
        if (listIndentFastPath) {
          listIndentFastPath.skipExitProbe = previousSkipExitProbe;
        }
        return {
          kind: 'listCode',
          contentColumn: markerEndColumn + 1,
          codeLength: remaining.length,
        };
      }
      column = contentStartColumn;
      const taskCheckbox = remaining.match(TASK_CHECKBOX_PREFIX);
      if (taskCheckbox) {
        column = indentationColumns(taskCheckbox[0].slice(3), column + 3);
        remaining = remaining.slice(taskCheckbox[0].length);
      }
      continue;
    }
    break;
  }
  return foundBlockQuote
    ? { kind: 'quote', content: remaining }
    : { kind: 'none', indentedCode: false };
}

function mayContainBlockQuoteAfterListMarkers(line: string): boolean {
  let candidate = line.trimStart();
  while (candidate) {
    if (candidate.startsWith('>')) {
      return true;
    }
    const listItem = parseListItemMatch(candidate);
    if (listItem === null) {
      return false;
    }
    candidate = listItem.content;
    const taskCheckbox = candidate.match(TASK_CHECKBOX_PREFIX);
    if (taskCheckbox) {
      candidate = candidate.slice(taskCheckbox[0].length);
    }
  }
  return false;
}

function startsBlockQuoteParagraph(content: string): boolean {
  const nestedContent = stripBlockQuoteAndListPrefixes(content) ?? content;
  if (!nestedContent.trim()) {
    return false;
  }
  return !startsMarkdownLeafBlock(nestedContent);
}

function startsMarkdownBlock(line: string, paragraphOpen = false): boolean {
  // Indented code cannot interrupt an open paragraph. Keep the original
  // indentation in this decision before examining tokens after trimStart().
  if (paragraphOpen && isIndentedCodeBlock(line)) {
    return false;
  }
  const content = line.trimStart();
  const listItem = parseListItemMatch(content);
  return (
    content.startsWith('>') ||
    (listItem !== null &&
      (!paragraphOpen || isInterruptingListMarker(listItem.marker))) ||
    startsMarkdownLeafBlock(content, paragraphOpen) ||
    (!paragraphOpen && isIndentedCodeBlock(line))
  );
}

function startsMarkdownLeafBlock(
  content: string,
  paragraphOpen = false,
): boolean {
  return (
    isIndentedCodeBlock(content) ||
    /^#{1,6}(?:[ \t]+|$)/u.test(content) ||
    /^(?:`{3,}|~{3,})/u.test(content) ||
    MARKDOWN_THEMATIC_BREAK_PATTERN.test(content) ||
    MARKDOWN_HTML_BLOCK_START_PATTERN.test(content) ||
    (!paragraphOpen &&
      MARKDOWN_CUSTOM_HTML_BLOCK_START_LINE_PATTERN.test(content))
  );
}

function isIndentedCodeBlock(line: string): boolean {
  const leadingWhitespace = line.match(/^[ \t]*/u)?.[0] ?? '';
  return (
    leadingWhitespace.length < line.length &&
    indentationColumns(leadingWhitespace) >= 4
  );
}

function hasD35ClosingReference(
  maskedBody: string,
  sourceBody: string,
  closingReferencePattern: RegExp,
  options: { issueNumber: number; owner: string; repo: string },
): boolean {
  for (const match of maskedBody.matchAll(closingReferencePattern)) {
    const keyword = match[1];
    const spacing = match[2];
    const reference = match[3];
    if (!keyword || !spacing || !reference) {
      continue;
    }
    const matchStart = match.index ?? 0;
    const sourceSpacing = sourceBody.slice(
      matchStart + keyword.length,
      matchStart + keyword.length + spacing.length,
    );
    if (!/^\s+$/u.test(sourceSpacing)) {
      continue;
    }
    const expectedLocalReference = `#${options.issueNumber}`;
    const expectedQualifiedReference = `${options.owner}/${options.repo}#${options.issueNumber}`;
    if (
      reference === expectedLocalReference ||
      reference.toLowerCase() === expectedQualifiedReference.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
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
    noRequiredChecksConfigured: input.noRequiredChecksConfigured === true,
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
    {
      condition:
        'PR + required checks not generated + no no-required fallback + no reviews',
      route: 'D4',
    },
    {
      condition:
        'PR + required checks not generated + no no-required fallback + reviews exist',
      route: 'E15',
    },
    {
      condition:
        'PR + no required checks + present run empty or unknown + no reviews',
      route: 'D4',
    },
    {
      condition:
        'PR + no required checks + present run empty or unknown + reviews exist',
      route: 'E15',
    },
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
