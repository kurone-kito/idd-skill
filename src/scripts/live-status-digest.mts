#!/usr/bin/env node
// idd-generated-from: src/scripts/live-status-digest.mts
//
// The scripts/live-status-digest.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { readFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  collaboratorPermission,
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import {
  combineOwnerRepoFlags,
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  ghApiJson,
  ghText,
} from './gh-exec.mts';
import { resolveCollaboratorMarkerTrust } from './policy-helpers.mts';
import type {
  LiveStatusDigestRepairPlan,
  LiveStatusDigestSnapshot,
  PrCommitPayload,
} from './protocol-helpers.mts';
import {
  applyDigestUpsert,
  compareLiveStatusDigestSnapshot,
  createLiveStatusDigestSnapshot,
  createLiveStatusDigestSnapshotFromEntries,
  type DigestUpsertOutcome,
  findLiveStatusDigestComments,
  isHistoricalLiveStatusDigestBody,
  normalizeLiveStatusDigestIds,
  normalizeTrustedMarkerLogins,
  parsePaginatedGhNdjson,
  planLiveStatusDigestRepair,
  planLiveStatusDigestUpsert,
  renderLiveStatusDigestRepairEvidence,
  resolvePrFirstCommitAt,
  resolveTrustedMarkerActors,
  retireLiveStatusDigestBody,
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
  owner?: string;
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
  repairDuplicate?: boolean;
  retainCommentId?: string;
  expectedCurrentDigestIds?: string;
  expectedCurrentDigestSha256?: string;
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
  '--owner': { type: 'string' },
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
  '--repair-duplicate': { type: 'boolean', default: false },
  '--retain-comment-id': { type: 'string' },
  '--expected-current-digest-ids': { type: 'string' },
  '--expected-current-digest-sha256': { type: 'string' },
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

interface LiveStatusDigestRepairReport {
  action: string;
  canApply: boolean;
  applied: boolean;
  actor: string | null;
  retainedCommentId: string | null;
  retiredCommentIds: string[];
  preflight: LiveStatusDigestSnapshot | null;
  postflight: LiveStatusDigestSnapshot | null;
  evidenceCommentId: string | number | null;
  recoveryHold: string | null;
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
  repair?: LiveStatusDigestRepairReport;
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
  if (
    !args.repairDuplicate &&
    args.apply &&
    args.skipClaimCheck &&
    (args.claimIssue || args.claimId)
  ) {
    fail(
      '--skip-claim-check cannot be combined with --claim-issue or --claim-id',
    );
  }
  if (
    !args.repairDuplicate &&
    args.apply &&
    !args.skipClaimCheck &&
    (!args.claimIssue || !args.claimId)
  ) {
    fail(
      '--apply requires --claim-issue and --claim-id, or explicit --skip-claim-check',
    );
  }

  let repository: string;
  try {
    repository = combineOwnerRepoFlags(args) ?? detectRepository();
  } catch (error) {
    fail((error as Error).message);
  }
  const [owner, repo] = parseRepository(repository);
  const targetType = args.issue ? 'issue' : 'pr';
  const targetNumber = parsePositiveInteger(
    args.issue ?? args.pr,
    `--${targetType}`,
  );

  if (args.claimIssue) {
    args.claimIssue = String(
      parsePositiveInteger(args.claimIssue, '--claim-issue'),
    );
  }

  if (args.repairDuplicate) {
    runDuplicateDigestRepair({
      args,
      owner,
      repo,
      targetType,
      targetNumber,
    });
    return;
  }
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

interface DuplicateDigestRepairInput {
  args: LiveStatusDigestArgs;
  owner: string;
  repo: string;
  targetType: 'issue' | 'pr';
  targetNumber: number;
}

function runDuplicateDigestRepair(input: DuplicateDigestRepairInput): void {
  const { args, owner, repo, targetType, targetNumber } = input;
  if (args.skipClaimCheck) {
    fail(
      '--repair-duplicate never accepts --skip-claim-check; apply mode requires an active claim',
    );
  }
  if (args.apply && (!args.claimIssue || !args.claimId || !args.agentId)) {
    fail(
      '--apply --repair-duplicate requires --claim-issue, --claim-id, and --agent-id for writer coordination',
    );
  }
  if (!args.retainCommentId) {
    fail('--repair-duplicate requires --retain-comment-id');
  }
  const retainedCommentId = parseCommentId(
    args.retainCommentId,
    '--retain-comment-id',
  );
  const expectedIds =
    args.expectedCurrentDigestIds === undefined
      ? undefined
      : parseDigestIdList(
          args.expectedCurrentDigestIds,
          '--expected-current-digest-ids',
        );
  if (args.apply && expectedIds === undefined) {
    fail(
      '--apply --repair-duplicate requires --expected-current-digest-ids from a fresh dry-run',
    );
  }
  if (args.apply && args.expectedCurrentDigestSha256 === undefined) {
    fail(
      '--apply --repair-duplicate requires --expected-current-digest-sha256 from a fresh dry-run',
    );
  }

  let targetState: string;
  let comments: ReturnType<typeof fetchIssueComments>;
  try {
    targetState = fetchRepairTargetState(owner, repo, targetType, targetNumber);
    comments = fetchIssueComments(owner, repo, targetNumber);
  } catch (error) {
    const report = createRepairReport({
      owner,
      repo,
      targetType,
      targetNumber,
      mode: args.apply ? 'apply' : 'dry-run',
      retainedCommentId,
      recoveryHold: `repair preflight read failed: ${(error as Error).message}`,
    });
    finishRepairHold(
      report,
      args.format,
      report.repair?.recoveryHold ?? 'repair preflight read failed',
      null,
      [],
      owner,
      repo,
      targetNumber,
      targetType,
      false,
    );
    return;
  }
  let plan: LiveStatusDigestRepairPlan;
  try {
    plan = planLiveStatusDigestRepair({
      comments,
      targetState,
      retainedCommentId,
      expectedCurrentDigestIds: expectedIds,
      expectedCurrentDigestSha256: args.expectedCurrentDigestSha256,
    });
  } catch (error) {
    const report = createRepairReport({
      owner,
      repo,
      targetType,
      targetNumber,
      mode: args.apply ? 'apply' : 'dry-run',
      retainedCommentId,
      recoveryHold: `repair preflight could not be planned: ${(error as Error).message}`,
    });
    finishRepairHold(
      report,
      args.format,
      report.repair?.recoveryHold ?? 'repair preflight could not be planned',
      null,
      [],
      owner,
      repo,
      targetNumber,
      targetType,
      false,
    );
    return;
  }

  const report = createRepairReport({
    owner,
    repo,
    targetType,
    targetNumber,
    mode: args.apply ? 'apply' : 'dry-run',
    retainedCommentId,
    plan,
  });
  const repairReport = report.repair;
  if (!repairReport) {
    fail(
      'internal error: duplicate repair report is missing its repair section',
    );
  }

  if (plan.action !== 'ready') {
    writeRepairReportAndStop(report, args.format);
    return;
  }
  if (!args.apply) {
    report.action = 'repair-ready';
    repairReport.action = 'repair-ready';
    writeRepairReportAndStop(report, args.format, false);
    return;
  }

  const authorization = resolveDuplicateRepairActor(owner, repo);
  repairReport.actor = authorization.actor;
  if (!authorization.authorized) {
    finishRepairHold(
      report,
      args.format,
      `maintainer authorization failed: ${authorization.reason}`,
      plan.snapshot,
      [],
      owner,
      repo,
      targetNumber,
      targetType,
      false,
    );
    return;
  }

  try {
    assertRepairClaimBoundToTarget(
      owner,
      repo,
      targetType,
      targetNumber,
      args.claimIssue,
    );
  } catch (error) {
    finishRepairHold(
      report,
      args.format,
      `repair claim is not bound to the digest target: ${(error as Error).message}`,
      plan.snapshot,
      [],
      owner,
      repo,
      targetNumber,
      targetType,
      false,
    );
    return;
  }

  const repairClaimContext =
    targetType === 'pr'
      ? {
          expectedLinkedPrs: buildExpectedLinkedPrReferences(
            owner,
            repo,
            targetNumber,
          ),
          prFirstCommitAt: resolvePrFirstCommitAtForPr(
            owner,
            repo,
            targetNumber,
          ),
        }
      : {};
  const assertRepairClaim = (): void => {
    if (!args.apply) return;
    assertActiveClaim(
      owner,
      repo,
      args.claimIssue,
      args.agentId,
      args.claimId,
      repairClaimContext,
    );
  };

  try {
    assertRepairClaim();
  } catch (error) {
    finishRepairHold(
      report,
      args.format,
      `repair claim check failed before mutation: ${(error as Error).message}`,
      plan.snapshot,
      [],
      owner,
      repo,
      targetNumber,
      targetType,
      false,
    );
    return;
  }

  let expectedSnapshot = plan.snapshot;
  const retiredCommentIds: string[] = [];
  for (const retirement of plan.retirements) {
    let currentState: string;
    let currentComments: ReturnType<typeof fetchIssueComments>;
    try {
      currentState = fetchRepairTargetState(
        owner,
        repo,
        targetType,
        targetNumber,
      );
      currentComments = fetchIssueComments(owner, repo, targetNumber);
    } catch (error) {
      finishRepairHold(
        report,
        args.format,
        `repair pre-mutation read failed: ${(error as Error).message}`,
        null,
        retiredCommentIds,
        owner,
        repo,
        targetNumber,
        targetType,
        true,
        assertRepairClaim,
      );
      return;
    }
    let comparison: ReturnType<typeof compareLiveStatusDigestSnapshot>;
    try {
      comparison = compareLiveStatusDigestSnapshot(
        currentComments,
        currentState,
        expectedSnapshot.entries.map((entry) => entry.id),
        expectedSnapshot.sha256,
      );
    } catch (error) {
      finishRepairHold(
        report,
        args.format,
        `repair pre-mutation snapshot failed: ${(error as Error).message}`,
        null,
        retiredCommentIds,
        owner,
        repo,
        targetNumber,
        targetType,
        true,
        assertRepairClaim,
      );
      return;
    }
    if (!comparison.matches) {
      finishRepairHold(
        report,
        args.format,
        `duplicate set changed before retiring comment ${retirement.id}: ${comparison.reason}`,
        comparison.snapshot,
        retiredCommentIds,
        owner,
        repo,
        targetNumber,
        targetType,
        true,
        assertRepairClaim,
      );
      return;
    }
    const current = findLiveStatusDigestComments(currentComments).find(
      (comment) => String(comment.id ?? '').trim() === retirement.id,
    );
    const currentBody = String(current?.body ?? '');
    let conditionalComment: { body: string };
    try {
      conditionalComment = fetchRepairComment(owner, repo, retirement.id);
    } catch (error) {
      finishRepairHold(
        report,
        args.format,
        `conditional retirement read failed: ${(error as Error).message}`,
        comparison.snapshot,
        retiredCommentIds,
        owner,
        repo,
        targetNumber,
        targetType,
        true,
        assertRepairClaim,
      );
      return;
    }
    if (
      !current ||
      currentBody !== retirement.originalBody ||
      conditionalComment.body !== retirement.originalBody
    ) {
      finishRepairHold(
        report,
        args.format,
        `selected retirement comment ${retirement.id} changed after preflight`,
        comparison.snapshot,
        retiredCommentIds,
        owner,
        repo,
        targetNumber,
        targetType,
        true,
        assertRepairClaim,
      );
      return;
    }
    const retiredBody = retireLiveStatusDigestBody(currentBody);
    if (retiredBody !== retirement.retiredBody) {
      finishRepairHold(
        report,
        args.format,
        `historical body plan changed for comment ${retirement.id}`,
        comparison.snapshot,
        retiredCommentIds,
        owner,
        repo,
        targetNumber,
        targetType,
        true,
        assertRepairClaim,
      );
      return;
    }
    try {
      assertRepairClaim();
    } catch (error) {
      finishRepairHold(
        report,
        args.format,
        `repair claim check failed before retiring comment ${retirement.id}: ${(error as Error).message}`,
        comparison.snapshot,
        retiredCommentIds,
        owner,
        repo,
        targetNumber,
        targetType,
        retiredCommentIds.length > 0,
        assertRepairClaim,
      );
      return;
    }
    try {
      patchRepairComment(owner, repo, retirement.id, retiredBody);
    } catch (error) {
      const reconciliation = reconcileRepairRetirementMutation(
        owner,
        repo,
        targetType,
        targetNumber,
        retirement.id,
        retiredBody,
      );
      if (reconciliation.retired) {
        retiredCommentIds.push(retirement.id);
      }
      finishRepairHold(
        report,
        args.format,
        `retirement mutation failed for comment ${retirement.id}: ${(error as Error).message}; ${reconciliation.detail}`,
        reconciliation.postflight,
        retiredCommentIds,
        owner,
        repo,
        targetNumber,
        targetType,
        true,
        assertRepairClaim,
      );
      return;
    }
    retiredCommentIds.push(retirement.id);
    expectedSnapshot = createLiveStatusDigestSnapshotFromEntries(
      currentState,
      expectedSnapshot.entries.filter((entry) => entry.id !== retirement.id),
    );
  }

  let postflightComments: ReturnType<typeof fetchIssueComments>;
  let postflightState: string;
  try {
    postflightState = fetchRepairTargetState(
      owner,
      repo,
      targetType,
      targetNumber,
    );
    postflightComments = fetchIssueComments(owner, repo, targetNumber);
  } catch (error) {
    finishRepairHold(
      report,
      args.format,
      `post-repair read failed: ${(error as Error).message}`,
      null,
      retiredCommentIds,
      owner,
      repo,
      targetNumber,
      targetType,
      true,
      assertRepairClaim,
    );
    return;
  }
  let postflight: LiveStatusDigestSnapshot;
  try {
    postflight = createLiveStatusDigestSnapshot(
      postflightComments,
      postflightState,
    );
  } catch (error) {
    finishRepairHold(
      report,
      args.format,
      `post-repair snapshot failed: ${(error as Error).message}`,
      null,
      retiredCommentIds,
      owner,
      repo,
      targetNumber,
      targetType,
      true,
      assertRepairClaim,
    );
    return;
  }
  const currentPostflight = findLiveStatusDigestComments(postflightComments);
  const retainedPostflight = currentPostflight.find(
    (comment) => String(comment.id ?? '').trim() === plan.retainedCommentId,
  );
  const postconditionOk =
    postflightState === plan.snapshot.targetState &&
    currentPostflight.length === 1 &&
    Boolean(retainedPostflight) &&
    String(retainedPostflight?.body ?? '') ===
      String(
        findLiveStatusDigestComments(comments).find(
          (comment) =>
            String(comment.id ?? '').trim() === plan.retainedCommentId,
        )?.body ?? '',
      ) &&
    plan.retirements.every((retirement) => {
      const comment = postflightComments.find(
        (candidate) => String(candidate.id ?? '').trim() === retirement.id,
      );
      const body = String(comment?.body ?? '');
      return (
        isHistoricalLiveStatusDigestBody(body) &&
        body === retirement.retiredBody
      );
    });
  if (!postconditionOk) {
    finishRepairHold(
      report,
      args.format,
      'post-repair verification did not prove exactly one retained current digest and unchanged retired content',
      postflight,
      retiredCommentIds,
      owner,
      repo,
      targetNumber,
      targetType,
      true,
      assertRepairClaim,
    );
    return;
  }

  const evidence = renderLiveStatusDigestRepairEvidence({
    target: `${targetType} #${targetNumber}`,
    status: 'complete',
    actor: authorization.actor,
    retainedCommentId: plan.retainedCommentId,
    retiredCommentIds,
    preflight: plan.snapshot,
    postflight,
  });
  try {
    assertRepairClaim();
  } catch (error) {
    finishRepairHold(
      report,
      args.format,
      `repair claim check failed before evidence write: ${(error as Error).message}`,
      postflight,
      retiredCommentIds,
      owner,
      repo,
      targetNumber,
      targetType,
      false,
    );
    return;
  }
  let evidenceResult: { id?: string | number | null };
  try {
    evidenceResult = postRepairEvidenceWithReconciliation(
      owner,
      repo,
      targetNumber,
      evidence,
      authorization.actor,
      new Set(
        postflightComments.map((comment) => String(comment.id ?? '').trim()),
      ),
    );
  } catch (error) {
    finishRepairHold(
      report,
      args.format,
      `durable repair evidence write failed: ${(error as Error).message}`,
      postflight,
      retiredCommentIds,
      owner,
      repo,
      targetNumber,
      targetType,
      false,
    );
    return;
  }
  if (evidenceResult.id === undefined || evidenceResult.id === null) {
    finishRepairHold(
      report,
      args.format,
      'durable repair evidence write returned no comment id',
      postflight,
      retiredCommentIds,
      owner,
      repo,
      targetNumber,
      targetType,
      true,
      assertRepairClaim,
    );
    return;
  }
  report.action = 'repair-complete';
  report.canApply = true;
  report.applied = true;
  report.repair = {
    action: 'repair-complete',
    canApply: true,
    applied: true,
    actor: authorization.actor,
    retainedCommentId: plan.retainedCommentId,
    retiredCommentIds,
    preflight: plan.snapshot,
    postflight,
    evidenceCommentId: evidenceResult.id,
    recoveryHold: null,
  };
  writeReport(report, args.format);
}

function createRepairReport(input: {
  owner: string;
  repo: string;
  targetType: 'issue' | 'pr';
  targetNumber: number;
  mode: 'apply' | 'dry-run';
  retainedCommentId: string;
  plan?: LiveStatusDigestRepairPlan;
  recoveryHold?: string;
}): LiveStatusDigestReport {
  const { plan } = input;
  const action = plan ? `repair-${plan.action}` : 'repair-recovery-hold';
  return {
    repository: `${input.owner}/${input.repo}`,
    target: { type: input.targetType, number: input.targetNumber },
    mode: input.mode,
    action,
    canApply: plan?.canApply ?? false,
    commentId: null,
    url: null,
    duplicates: [],
    repairPath: null,
    applied: false,
    repair: {
      action,
      canApply: plan?.canApply ?? false,
      applied: false,
      actor: null,
      retainedCommentId: plan?.retainedCommentId || input.retainedCommentId,
      retiredCommentIds: [],
      preflight: plan?.snapshot ?? null,
      postflight: null,
      evidenceCommentId: null,
      recoveryHold:
        input.recoveryHold ??
        (plan?.action === 'ready' ? null : (plan?.reason ?? null)),
    },
  };
}

function parseCommentId(value: string, flag: string): string {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    fail(`${flag} must be a positive integer`);
  }
  return normalized;
}

function parseDigestIdList(value: string, flag: string): string[] {
  const values = value.split(',').map((item) => item.trim());
  if (values.some((item) => item.length === 0)) {
    fail(`${flag} must be a comma-separated list of comment ids`);
  }
  try {
    return normalizeLiveStatusDigestIds(values);
  } catch (error) {
    fail(`${flag} is invalid: ${(error as Error).message}`);
  }
}

function fetchRepairTargetState(
  owner: string,
  repo: string,
  targetType: 'issue' | 'pr',
  number: number,
): string {
  const path =
    targetType === 'pr'
      ? `repos/${owner}/${repo}/pulls/${number}`
      : `repos/${owner}/${repo}/issues/${number}`;
  const payload = ghApiJson(path) as {
    state?: unknown;
    state_reason?: unknown;
    merged_at?: unknown;
  };
  if (
    typeof payload.state !== 'string' ||
    payload.state.trim().length === 0 ||
    (targetType === 'pr' && !Object.hasOwn(payload, 'merged_at')) ||
    (targetType === 'issue' && !Object.hasOwn(payload, 'state_reason'))
  ) {
    throw new Error(
      `GitHub ${targetType} response is missing required target-state fields`,
    );
  }
  return JSON.stringify({
    mergedAt:
      targetType === 'pr' ? String(payload.merged_at ?? 'none') : 'none',
    state: String(payload.state ?? 'unknown'),
    stateReason:
      targetType === 'issue' ? String(payload.state_reason ?? 'none') : 'none',
  });
}

function fetchRepairComment(
  owner: string,
  repo: string,
  commentId: string,
): { body: string } {
  const payload = ghApiJson(
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
  ) as IssueCommentRestPayload;
  if (String(payload.id ?? '').trim() !== commentId) {
    throw new Error(`GitHub returned an unexpected comment for ${commentId}`);
  }
  return { body: String(payload.body ?? '') };
}

function reconcileRepairRetirementMutation(
  owner: string,
  repo: string,
  targetType: 'issue' | 'pr',
  targetNumber: number,
  commentId: string,
  retiredBody: string,
): {
  retired: boolean;
  detail: string;
  postflight: LiveStatusDigestSnapshot | null;
} {
  let observedBody: string | null = null;
  let commentDetail = 'comment reread unavailable';
  try {
    observedBody = fetchRepairComment(owner, repo, commentId).body;
    commentDetail = `comment body is ${
      observedBody === retiredBody &&
      isHistoricalLiveStatusDigestBody(observedBody)
        ? 'the planned historical body'
        : 'not the planned historical body'
    }`;
  } catch (error) {
    commentDetail = `comment reread failed: ${(error as Error).message}`;
  }
  let postflight: LiveStatusDigestSnapshot | null = null;
  let postflightDetail = 'postflight snapshot reread unavailable';
  try {
    const targetState = fetchRepairTargetState(
      owner,
      repo,
      targetType,
      targetNumber,
    );
    postflight = createLiveStatusDigestSnapshot(
      fetchIssueComments(owner, repo, targetNumber),
      targetState,
    );
    postflightDetail = `postflight snapshot reread: ${postflight.sha256}`;
  } catch (error) {
    postflightDetail = `postflight snapshot reread failed: ${(error as Error).message}`;
  }
  return {
    retired:
      observedBody === retiredBody &&
      isHistoricalLiveStatusDigestBody(observedBody),
    detail: `ambiguous mutation reconciliation: ${commentDetail}; ${postflightDetail}`,
    postflight,
  };
}

function resolveDuplicateRepairActor(
  owner: string,
  repo: string,
): { actor: string; authorized: boolean; reason: string } {
  const actor = currentViewerLogin().trim();
  if (!actor) {
    return {
      actor: '',
      authorized: false,
      reason: 'authenticated viewer login is unavailable',
    };
  }
  const authorized = isAuthorizedForcedHandoffActor(
    owner,
    repo,
    actor,
    'owners-and-maintainers-only',
    collaboratorPermissionCache,
  );
  return {
    actor,
    authorized,
    reason: authorized
      ? 'authenticated viewer is an owner or maintainer'
      : 'authenticated viewer is not an owner or maintainer, or permission lookup was unavailable',
  };
}

function assertRepairClaimBoundToTarget(
  owner: string,
  repo: string,
  targetType: 'issue' | 'pr',
  targetNumber: number,
  claimIssue: string | undefined,
): void {
  const normalizedClaimIssue = String(claimIssue ?? '').trim();
  if (!normalizedClaimIssue) {
    throw new Error('claim issue is empty');
  }
  if (targetType === 'issue') {
    if (normalizedClaimIssue !== String(targetNumber)) {
      throw new Error(
        `issue target #${targetNumber} requires --claim-issue ${targetNumber}`,
      );
    }
    return;
  }

  let payload: { closingIssuesReferences?: unknown };
  try {
    payload = JSON.parse(
      ghText([
        'pr',
        'view',
        String(targetNumber),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'closingIssuesReferences',
      ]),
    ) as { closingIssuesReferences?: unknown };
  } catch (error) {
    throw new Error(
      `could not read closingIssuesReferences for PR #${targetNumber}: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(payload.closingIssuesReferences)) {
    throw new Error(
      `PR #${targetNumber} returned no usable closingIssuesReferences`,
    );
  }
  const linkedIssueNumbers = payload.closingIssuesReferences
    .map((reference) =>
      String((reference as { number?: unknown } | null)?.number ?? '').trim(),
    )
    .filter(Boolean);
  // A PR-repair coordination lease must be unique to this PR: accepting any
  // one of several linked issues' claims would let two maintainers each
  // legitimately claim a different linked issue and both authorize a repair
  // on the same PR concurrently. Requiring exactly one linked issue ties the
  // lease to the one claim this repository's protocol can ever mark active
  // for it at a time (kurone-kito/idd-skill#3158 review).
  if (linkedIssueNumbers.length !== 1) {
    throw new Error(
      `PR #${targetNumber} must link exactly one issue for a unique repair claim lease; found ${linkedIssueNumbers.join(', ') || 'none'}`,
    );
  }
  if (linkedIssueNumbers[0] !== normalizedClaimIssue) {
    throw new Error(
      `PR #${targetNumber} does not link claim issue #${normalizedClaimIssue}; expected ${linkedIssueNumbers[0]}`,
    );
  }
}

function patchRepairComment(
  owner: string,
  repo: string,
  commentId: string,
  body: string,
): IssueCommentRestPayload {
  const payload = ghApiJson(
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      extraArgs: ['-X', 'PATCH', '--input', '-'],
      input: JSON.stringify({ body }),
    },
  ) as IssueCommentRestPayload;
  if (String(payload.id ?? '').trim() !== commentId) {
    throw new Error(`GitHub returned an unexpected comment for ${commentId}`);
  }
  if (String(payload.body ?? '') !== body) {
    throw new Error(
      `GitHub returned a different body for comment ${commentId} after PATCH`,
    );
  }
  return payload;
}

function createRepairEvidenceComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): { id?: string | number | null } {
  return ghApiJson(`repos/${owner}/${repo}/issues/${number}/comments`, {
    extraArgs: ['-X', 'POST', '--input', '-'],
    input: JSON.stringify({ body }),
  }) as { id?: string | number | null };
}

function findRepairEvidenceComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
  actor: string,
  existingCommentIds: ReadonlySet<string>,
): { id: string | number } | null {
  const normalizedActor = actor.trim().toLowerCase();
  const comment = fetchIssueComments(owner, repo, number).find(
    (candidate) =>
      candidate.body === body &&
      candidate.id != null &&
      !existingCommentIds.has(String(candidate.id).trim()) &&
      String(candidate.author?.login ?? '')
        .trim()
        .toLowerCase() === normalizedActor,
  );
  return comment?.id == null ? null : { id: comment.id };
}

function postRepairEvidenceWithReconciliation(
  owner: string,
  repo: string,
  number: number,
  body: string,
  actor: string,
  existingCommentIds: ReadonlySet<string>,
): { id: string | number } {
  let writeError: Error | null = null;
  try {
    const result = createRepairEvidenceComment(owner, repo, number, body);
    if (result.id !== undefined && result.id !== null) {
      return { id: result.id };
    }
    writeError = new Error(
      'evidence write returned no comment id; response outcome is ambiguous',
    );
  } catch (error) {
    writeError = error as Error;
  }

  try {
    const existing = findRepairEvidenceComment(
      owner,
      repo,
      number,
      body,
      actor,
      existingCommentIds,
    );
    if (existing) return existing;
  } catch (error) {
    throw new Error(
      `${writeError?.message ?? 'evidence write failed'}; evidence reconciliation failed: ${(error as Error).message}; no retry attempted`,
    );
  }
  throw new Error(
    `${writeError?.message ?? 'evidence write failed'}; exact evidence comment was not observed after reconciliation; no retry attempted`,
  );
}

function finishRepairHold(
  report: LiveStatusDigestReport,
  format: string,
  reason: string,
  postflight: LiveStatusDigestSnapshot | null,
  retiredCommentIds: string[],
  owner: string,
  repo: string,
  targetNumber: number,
  targetType: 'issue' | 'pr',
  postEvidence: boolean,
  assertClaimBeforeEvidence?: () => void,
): void {
  const repair = report.repair;
  if (!repair) {
    fail(reason);
  }
  repair.action = 'repair-recovery-hold';
  repair.canApply = false;
  repair.applied = false;
  repair.retiredCommentIds = [...retiredCommentIds];
  repair.postflight = postflight;
  repair.recoveryHold = reason;
  report.action = 'repair-recovery-hold';
  report.canApply = false;
  report.applied = false;
  let canPostEvidence = postEvidence;
  if (canPostEvidence && assertClaimBeforeEvidence) {
    try {
      assertClaimBeforeEvidence();
    } catch (error) {
      canPostEvidence = false;
      repair.recoveryHold = `${reason}; claim check failed before recovery evidence: ${(error as Error).message}`;
    }
  }
  if (canPostEvidence) {
    try {
      const evidenceId = createRepairEvidenceComment(
        owner,
        repo,
        targetNumber,
        renderLiveStatusDigestRepairEvidence({
          target: `${targetType} #${targetNumber}`,
          status: 'recovery-hold',
          actor: repair.actor ?? '',
          retainedCommentId: repair.retainedCommentId ?? '',
          retiredCommentIds,
          preflight:
            repair.preflight ?? createLiveStatusDigestSnapshot([], 'unknown'),
          postflight,
          reason,
        }),
      );
      repair.evidenceCommentId = evidenceId.id ?? null;
    } catch {
      // The JSON report remains the recovery record when GitHub cannot accept
      // the compensating evidence comment.
    }
  }
  writeRepairReportAndStop(report, format);
}

function writeRepairReportAndStop(
  report: LiveStatusDigestReport,
  format: string,
  failed = true,
): void {
  writeReport(report, format);
  if (failed) {
    process.exitCode = 1;
  }
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
    ghText(
      [
        'api',
        '--paginate',
        '--jq',
        '.[]',
        `repos/${owner}/${repo}/issues/${number}/comments`,
      ],
      { timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS },
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
    cachedCurrentViewerLogin = ghText(['api', 'user', '--jq', '.login'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toLowerCase();
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
  return ghText([
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]);
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
    return JSON.parse(ghText(commandArgs));
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
  if (report.repair) {
    console.log('repair:');
    console.log('field\tvalue');
    for (const [field, value] of Object.entries(report.repair)) {
      if (field === 'preflight' || field === 'postflight') {
        const snapshot = value as LiveStatusDigestSnapshot | null;
        console.log(
          `${field}\t${snapshot ? JSON.stringify(snapshot) : 'none'}`,
        );
        continue;
      }
      console.log(
        `${field}\t${Array.isArray(value) ? value.join(', ') : (value ?? '')}`,
      );
    }
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
  // that exact uniform pre-migration behavior. The message matches
  // parseCliArgs' own "missing value for argument: <flag>" phrasing
  // (Copilot review finding on PR #1467) so an empty-string value and an
  // omitted/flag-shaped value report the same failure style.
  const requireNonEmpty = (
    token: string | undefined,
    flag: string,
  ): string | undefined => {
    if (token === '') {
      fail(`missing value for argument: ${flag}`);
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
    owner: requireNonEmpty(values.owner as string | undefined, '--owner'),
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
    repairDuplicate: values['repair-duplicate'] as boolean,
    retainCommentId: requireNonEmpty(
      values['retain-comment-id'] as string | undefined,
      '--retain-comment-id',
    ),
    expectedCurrentDigestIds: requireNonEmpty(
      values['expected-current-digest-ids'] as string | undefined,
      '--expected-current-digest-ids',
    ),
    expectedCurrentDigestSha256: requireNonEmpty(
      values['expected-current-digest-sha256'] as string | undefined,
      '--expected-current-digest-sha256',
    ),
  };

  if (!parsedArgs.repairDuplicate) {
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
  --repair-duplicate                explicitly repair duplicate current digests
  --retain-comment-id <id>           current digest comment to retain for repair
  --expected-current-digest-ids <ids>
                                     comma-separated dry-run digest IDs required for apply repair
  --expected-current-digest-sha256 <sha256>
                                     dry-run snapshot SHA-256 required for apply repair
  --phase <text>                    digest Phase field (required)
  --claim <text>                    digest Claim field (required)
  --branch <text>                   digest Branch field (required)
  --last-checked <timestamp>        digest Last checked field (default: current UTC)
  --open-blockers <text>            digest Open blockers field (required)
  --next-action <text>              digest Next action field (required)
  --authoritative-by <text>         digest Authoritative by field (required)
  --claim-issue <number>            issue carrying the active claim, required for apply mode
  --claim-id <id>                   active claim id required for apply mode
  --agent-id <id>                   optionally require this claim agent id
  --skip-claim-check                explicit maintainer override for apply mode
                                     (not accepted with --repair-duplicate)
  --repo <owner/name>               repository override, combined form
  --owner <owner>                   repository override, split form (use
                                     with --repo <name>, the bare
                                     repository name -- not both --owner
                                     and a combined --repo together)
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
