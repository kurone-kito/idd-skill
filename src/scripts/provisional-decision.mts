// idd-generated-from: src/scripts/provisional-decision.mts
//
// The scripts/provisional-decision.mjs copy is generated from this source by
// `pnpm run build`. Edit this .mts, never the generated .mjs. See
// docs/typescript-sources.md.

import { createHash } from 'node:crypto';
import { type IddConfig, loadIddConfig } from './idd-config.mts';
import {
  parseClaimComment,
  parseForcedHandoffComment,
} from './marker-helpers.mts';
import {
  applyClaimEvent,
  filterTrustedClaimFamilyEvents,
  isStaleAt,
  isStaleByAge,
  orderClaimEvents,
  readClaimStaleAgeMs,
  resolveActiveClaimWithForcedHandoffTrace,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';
import { buildVerifiedClaimLineage } from './provisional-claim-lineage.mts';
import {
  PROVISIONAL_DECISION_ANSWER_MARKER,
  PROVISIONAL_DECISION_ANSWER_NOTE,
  type ProvisionalDecisionAnswer,
  type ProvisionalDecisionComment,
  type ProvisionalDecisionRecord,
  type ProvisionalDecisionReplayResult,
  type ProvisionalDecisionSource,
  type ProvisionalReworkHandoff,
  parseProvisionalDecisionAnswerComment,
  parseProvisionalDecisionRecordComment,
  type ReplayedProvisionalDecision,
  replayProvisionalDecisionHistory,
  type VerifiedProvisionalDecisionClaim,
  type VerifiedProvisionalReworkRoadmap,
  type VerifiedProvisionalWork,
} from './provisional-decision-state.mts';

export type ProvisionalDecisionAction =
  | 'none'
  | 'reconcile'
  | 'recovery-hold'
  | 'fix-input';

export type ProvisionalDecisionCommandState =
  | 'planned'
  | 'applied'
  | 'reconciled'
  | 'refused';

export interface ProvisionalDecisionHistoryComment
  extends ProvisionalDecisionComment {
  readonly edited: boolean;
}

export interface ProvisionalDecisionHistoryRead {
  readonly comments: readonly ProvisionalDecisionHistoryComment[];
  readonly complete: boolean;
  /** HTTP Date header returned by the history read. */
  readonly serverDate: string;
}

export interface ProvisionalDecisionSourceIssueRead {
  readonly title: string;
  readonly body: string;
  readonly updatedAt: string;
}

export interface ProvisionalDecisionPullRequestRead {
  readonly state: 'open' | 'merged' | 'closed-unmerged';
  readonly headSha: string;
  readonly mergeCommitSha: string | null;
  readonly requiredChecksPassing: boolean;
}

export interface ProvisionalDecisionStoredRecord {
  readonly id: string;
  readonly url: string;
}

export interface ProvisionalDecisionStore {
  /**
   * The trusted policy the planner reads for claim trust and the label name.
   * Undefined reads the local config, as the planner always has.
   */
  readonly policy?: IddConfig | null;
  readHistory(): Promise<ProvisionalDecisionHistoryRead>;
  readSourceIssue(): Promise<ProvisionalDecisionSourceIssueRead>;
  readPullRequest(url: string): Promise<ProvisionalDecisionPullRequestRead>;
  /** Append once by record ID, returning the created or existing comment. */
  appendRecordBody(
    recordId: string,
    body: string,
  ): Promise<{
    readonly result: 'created' | 'existed';
    readonly record: ProvisionalDecisionStoredRecord;
  }>;
  /** Apply when requested, then return the label state read back from GitHub. */
  applyOrReadDecisionLabel(input: {
    readonly labelName: string;
    readonly apply: boolean;
  }): Promise<{ readonly present: boolean }>;
}

export interface ProvisionalDecisionBaseline {
  readonly title: string;
  readonly bodySha256: string;
}

export interface ProvisionalDecisionOption {
  readonly id: string;
  readonly description: string;
  readonly feasibilityRationale: string;
  readonly requirementFit: string;
  readonly consequences: string;
  readonly verification: string;
  readonly reversalOrMigration: string;
  readonly rationale?: string;
  readonly comparison?: string;
  readonly rejectionReason?: string;
}

interface RequestBase {
  readonly repository: string;
  readonly issueNumber: number;
  readonly evidenceUrl?: string;
  readonly claimId: string;
  readonly policyTrusted: boolean;
  readonly optionComparisonValid: boolean;
  readonly worktreeBranch: string;
  readonly baseline: ProvisionalDecisionBaseline;
  readonly verifiedReworkRoadmaps: readonly VerifiedProvisionalReworkRoadmap[];
}

export interface ProvisionalDecisionSelectedRequest extends RequestBase {
  readonly type: 'selected';
  readonly selectedOption?: ProvisionalDecisionOption;
  readonly feasibleAlternatives?: readonly ProvisionalDecisionOption[];
  readonly executionCriteria?: readonly string[];
}

export interface ProvisionalDecisionWorkStartedRequest extends RequestBase {
  readonly type: 'work-started';
  readonly planCommentUrl?: string;
}

export interface ProvisionalDecisionWorkCompletedRequest extends RequestBase {
  readonly type: 'work-completed';
  readonly pullRequestUrl?: string;
  readonly verifiedHeadSha: string;
  readonly executionCriteriaSatisfied: boolean;
}

export type ProvisionalDecisionCommandRequest =
  | ProvisionalDecisionSelectedRequest
  | ProvisionalDecisionWorkStartedRequest
  | ProvisionalDecisionWorkCompletedRequest;

export interface ProvisionalDecisionPlan {
  readonly candidateRecord: ProvisionalDecisionRecord;
  readonly verifiedClaimLineage: readonly VerifiedProvisionalDecisionClaim[];
  readonly verifiedAt: string;
  readonly locatedDecision: {
    readonly recordId: string;
    readonly bundleGeneration: number;
    readonly decisionGeneration: number;
    readonly status: ReplayedProvisionalDecision['status'];
    readonly bundleState: 'accepting' | 'waiting' | 'complete';
  } | null;
  readonly history: ProvisionalDecisionHistoryRead;
  readonly baseline: ProvisionalDecisionBaseline;
  readonly existingRecord: {
    readonly commentId: string;
    readonly commentUrl: string;
    readonly labelPresent: boolean;
  } | null;
  readonly pullRequest: ProvisionalDecisionPullRequestRead | null;
}

interface ResultBase {
  readonly recordId: string | null;
  readonly commentUrl: string;
  readonly reason?: string;
  readonly plan?: ProvisionalDecisionPlan;
}

export type ProvisionalDecisionCommandResult =
  | (ResultBase & {
      readonly state: 'planned';
      readonly action?: never;
      readonly plan: ProvisionalDecisionPlan;
    })
  | (ResultBase & {
      readonly state: 'applied';
      readonly action?: never;
    })
  | (ResultBase & {
      readonly state: 'reconciled';
      readonly action: 'reconcile';
      readonly plan?: ProvisionalDecisionPlan;
    })
  | (ResultBase & {
      readonly state: 'refused';
      readonly action: Exclude<ProvisionalDecisionAction, 'reconcile'>;
    });

interface ClaimFoldResult {
  readonly lineage: readonly VerifiedProvisionalDecisionClaim[];
  readonly active: {
    readonly claimId: string;
    readonly agentId: string;
    readonly branch: string;
  };
}

type ClaimFoldVerification = ClaimFoldResult | { readonly failure: string };

interface CandidateInfo {
  readonly record: ProvisionalDecisionRecord;
  readonly parseIssues: readonly string[];
}

const RECORD_MARKER = '<!-- idd-provisional-decision-record:v1 -->';
const DEFAULT_DECISION_LABEL = 'status:needs-decision';

function refused(
  action: Exclude<ProvisionalDecisionAction, 'reconcile'>,
  reason: string,
  recordId: string | null = null,
  commentUrl = '',
): ProvisionalDecisionCommandResult {
  return { state: 'refused', action, reason, recordId, commentUrl };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseServerDate(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().replace('.000Z', 'Z');
}

function bodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function normalizeRepository(repository: string): string {
  return repository.trim().toLowerCase();
}

function sourceFromRead(
  request: RequestBase,
  read: ProvisionalDecisionSourceIssueRead,
): ProvisionalDecisionSource {
  return {
    repository: normalizeRepository(request.repository),
    issueNumber: request.issueNumber,
    snapshot: {
      title: read.title,
      bodySha256: bodySha256(read.body),
      updatedAt: read.updatedAt,
    },
  };
}

function normalizeLogin(login: string | null): string {
  return (login ?? '').trim().toLowerCase();
}

/** The config the planner reads: the store's trusted policy when it has one. */
function plannerConfig(store: ProvisionalDecisionStore): IddConfig | null {
  return store.policy === undefined ? loadIddConfig() : store.policy;
}

function resolveClaimFold(
  history: ProvisionalDecisionHistoryRead,
  store: ProvisionalDecisionStore,
  onNoActiveClaim?: (
    lineage: readonly VerifiedProvisionalDecisionClaim[],
  ) => void,
): ClaimFoldVerification | null {
  const config = plannerConfig(store);
  const trustedLogins = resolveTrustedMarkerActors({ config }).actors.map(
    (login) => login.trim().toLowerCase(),
  );
  const trustedLoginSet = new Set(trustedLogins);
  const isTrustedAuthor = (login: string) =>
    trustedLoginSet.has(normalizeLogin(login));
  const staleAgeMs = readClaimStaleAgeMs(config);
  const isStale =
    Number.isFinite(staleAgeMs) && staleAgeMs > 0
      ? (activeCreatedAt: string, nextCreatedAt: string) =>
          isStaleByAge(activeCreatedAt, nextCreatedAt, staleAgeMs)
      : isStaleAt;
  const events = history.comments.map((comment) => ({
    id: comment.id,
    url: comment.url,
    body: comment.body,
    createdAt: comment.createdAt,
    author: { login: comment.authorLogin?.trim() ?? '' },
    lastEditedAt: comment.edited === false ? null : comment.createdAt,
  }));
  const trustedEvents = events.filter(
    (_event, index) => history.comments[index]?.trustedAuthor === true,
  );

  let ignoredForcedHandoff = false;
  let trace: ReturnType<typeof resolveActiveClaimWithForcedHandoffTrace>;
  try {
    trace = resolveActiveClaimWithForcedHandoffTrace(trustedEvents, {
      isTrustedAuthor,
      isStale,
      onIgnoredForcedHandoff: () => {
        ignoredForcedHandoff = true;
      },
    });
  } catch (error) {
    return { failure: `canonical claim trace failed: ${errorText(error)}` };
  }
  const hasTrustedForcedHandoff = history.comments.some((comment) => {
    const login = normalizeLogin(comment.authorLogin);
    return (
      comment.trustedAuthor === true &&
      login !== '' &&
      trustedLoginSet.has(login) &&
      Boolean(parseForcedHandoffComment(comment.body, comment.createdAt))
    );
  });
  if (ignoredForcedHandoff || hasTrustedForcedHandoff) {
    return { failure: 'trusted forced-handoff marker requires recovery' };
  }

  const result = buildVerifiedClaimLineage({
    comments: history.comments.map((comment) => ({
      id: comment.id,
      url: comment.url,
      body: comment.body,
      createdAt: comment.createdAt,
      authorLogin: comment.authorLogin,
      lastEditedAt: comment.edited === false ? null : comment.createdAt,
      trustedAuthor: comment.trustedAuthor === true,
    })),
    completeHistory: history.complete === true,
    staleAgeMs,
    trustedMarkerLogins: trustedLogins,
  });
  if (result.status !== 'ok') return { failure: result.reason };

  const orderedEvents = orderClaimEvents(
    filterTrustedClaimFamilyEvents(trustedEvents, isTrustedAuthor),
  );
  const lineage: VerifiedProvisionalDecisionClaim[] = [];
  const seenClaimIds = new Set<string>();
  let active: typeof trace.activeClaim = null;
  let activeSince = '';
  let foldIgnoredForcedHandoff = false;
  for (const event of orderedEvents) {
    const next = applyClaimEvent(active, event, {
      isTrustedAuthor,
      isStale,
      onIgnoredForcedHandoff: () => {
        foldIgnoredForcedHandoff = true;
      },
    });
    const identityChanged =
      (next?.claimId ?? null) !== (active?.claimId ?? null) ||
      (next?.agentId ?? null) !== (active?.agentId ?? null);
    if (identityChanged) {
      activeSince = String(event.createdAt ?? '');
      if (next) {
        const claim = parseClaimComment(
          event.body ?? '',
          event.createdAt ?? '',
        );
        if (
          claim?.supersedes !== 'none' ||
          seenClaimIds.has(claim.claimId) ||
          !/^issue\/[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(claim.branch)
        ) {
          return { failure: 'canonical claim lineage is malformed' };
        }
        seenClaimIds.add(claim.claimId);
        lineage.push({
          claimId: claim.claimId,
          agentId: claim.agentId,
          branch: claim.branch,
          claimedAt: event.createdAt ?? '',
          supersedes: claim.supersedes,
          commentId: String(event.id ?? ''),
        });
      }
    }
    active = next;
  }

  if (foldIgnoredForcedHandoff) {
    return { failure: 'claim fold ignored a trusted forced-handoff marker' };
  }
  const sameClaim = (
    left: {
      readonly claimId: string;
      readonly agentId: string;
      readonly branch: string;
    } | null,
    right: {
      readonly claimId: string;
      readonly agentId: string;
      readonly branch: string;
    } | null,
  ) =>
    left?.claimId === right?.claimId &&
    left?.agentId === right?.agentId &&
    left?.branch === right?.branch;
  const lineageMatchesValidatedResult =
    lineage.length === result.claims.length &&
    lineage.every((claim, index) => {
      const validated = result.claims[index];
      return (
        claim.claimId === validated?.claimId &&
        claim.agentId === validated?.agentId &&
        claim.branch === validated?.branch &&
        claim.claimedAt === validated?.claimedAt &&
        claim.supersedes === validated?.supersedes &&
        claim.commentId === validated?.commentId
      );
    });
  if (
    !sameClaim(active, trace.activeClaim) ||
    activeSince !== trace.activeSince ||
    !sameClaim(
      trace.activeClaim,
      result.active
        ? {
            claimId: result.active.claimId,
            agentId: result.active.agentId,
            branch: result.active.branch,
          }
        : null,
    ) ||
    !lineageMatchesValidatedResult
  ) {
    return { failure: 'canonical claim trace and lineage disagree' };
  }
  if (!trace.activeClaim) {
    onNoActiveClaim?.(lineage);
    return null;
  }
  const lastClaim = lineage.at(-1);
  if (
    !lastClaim ||
    lastClaim.claimId !== trace.activeClaim.claimId ||
    lastClaim.agentId !== trace.activeClaim.agentId ||
    lastClaim.branch !== trace.activeClaim.branch ||
    lastClaim.claimedAt !== trace.activeSince
  ) {
    return { failure: 'canonical activeSince does not match claim lineage' };
  }
  return {
    lineage,
    active: {
      claimId: trace.activeClaim.claimId,
      agentId: trace.activeClaim.agentId,
      branch: trace.activeClaim.branch,
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commentUrlKey(value: string): string {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
    const commentId = url.hash.match(/^#issuecomment-(\d+)$/);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      match &&
      commentId
    ) {
      return `${match[1]?.toLowerCase()}/${match[2]?.toLowerCase()}/issues/${match[3]}#issuecomment-${commentId[1]}`;
    }
  } catch {
    // Preserve exact lookup behavior for URLs outside the GitHub comment form.
  }
  return value;
}

function contentComparable(record: ProvisionalDecisionRecord): unknown {
  const copy = structuredClone(record) as ProvisionalDecisionRecord;
  const mutable = copy as unknown as {
    claimLineage?: unknown;
    evidenceReferences?: string[];
    source?: {
      repository?: string;
      snapshot?: { updatedAt?: unknown };
    };
    event?: {
      type?: unknown;
      planReference?: string;
      result?: { verifiedAt?: unknown };
    };
  };
  // Claim lineage identifies the run, not the decision content.
  delete mutable.claimLineage;
  if (mutable.source?.repository) {
    mutable.source.repository = normalizeRepository(mutable.source.repository);
  }
  if (mutable.evidenceReferences) {
    mutable.evidenceReferences = mutable.evidenceReferences.map(commentUrlKey);
  }
  if (mutable.source?.snapshot) delete mutable.source.snapshot.updatedAt;
  if (typeof mutable.event?.planReference === 'string') {
    mutable.event.planReference = commentUrlKey(mutable.event.planReference);
  }
  if (mutable.event?.type === 'work-completed' && mutable.event.result) {
    delete mutable.event.result.verifiedAt;
  }
  return copy;
}

function sameContent(
  left: ProvisionalDecisionRecord,
  right: ProvisionalDecisionRecord,
): boolean {
  return (
    stableJson(contentComparable(left)) === stableJson(contentComparable(right))
  );
}

function extractRecordId(body: string): string | null {
  if (!body.startsWith(RECORD_MARKER)) return null;
  let payload = body.slice(RECORD_MARKER.length);
  if (payload.startsWith('\r\n')) payload = payload.slice(2);
  else if (payload.startsWith('\n')) payload = payload.slice(1);
  else return null;
  try {
    const value = JSON.parse(payload) as { recordId?: unknown };
    return typeof value?.recordId === 'string' ? value.recordId : null;
  } catch {
    return null;
  }
}

function recordCommentBody(record: ProvisionalDecisionRecord): string {
  return `${RECORD_MARKER}\n${JSON.stringify(record)}`;
}

function recordIdFor(
  repository: string,
  issueNumber: number,
  bundleGeneration: number,
  decisionGeneration: number,
  eventType: string,
): string {
  const input = `${normalizeRepository(repository)}|${issueNumber}|${bundleGeneration}|${decisionGeneration}|${eventType}`;
  return `prov-${createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32)}`;
}

function questionFromBody(body: string): string | null {
  const lines = body.split(/\r?\n/u);
  const decisionHeadings: number[] = [];
  const sectionHeadings: number[] = [];
  let fence: { readonly character: string; readonly length: number } | null =
    null;
  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (!fence)
        fence = { character: marker[0] ?? '`', length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    if (/^ {0,3}## Decision needed\s*$/u.test(line)) {
      decisionHeadings.push(index);
    }
    if (/^ {0,3}##\s/u.test(line)) sectionHeadings.push(index);
  }
  if (decisionHeadings.length !== 1) return null;
  const start = decisionHeadings[0];
  if (start === undefined) return null;
  const end = sectionHeadings.find((index) => index > start) ?? lines.length;
  fence = null;
  const questions: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (!fence)
        fence = { character: marker[0] ?? '`', length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    if (line.startsWith('Question: ')) {
      questions.push(line.slice('Question: '.length).trim());
    }
  }
  if (questions.length !== 1 || !questions[0]) return null;
  return questions[0];
}

function bundleState(
  decisions: readonly ReplayedProvisionalDecision[],
  generation: number,
): 'accepting' | 'waiting' | 'complete' {
  const inBundle = decisions.filter(
    (decision) => decision.bundleGeneration === generation,
  );
  if (
    inBundle.length > 0 &&
    inBundle.every(
      (decision) =>
        decision.status === 'confirmed' ||
        decision.status === 'rework-authored',
    )
  ) {
    return 'complete';
  }
  if (
    inBundle.every(
      (decision) =>
        decision.status !== 'confirmed' &&
        decision.status !== 'rework-requested' &&
        decision.status !== 'rework-authored',
    )
  ) {
    return 'accepting';
  }
  return 'waiting';
}

function decisionForEvidence(
  replay: ProvisionalDecisionReplayResult,
  evidenceUrl: string,
): ReplayedProvisionalDecision[] {
  return replay.decisions.filter((decision) =>
    decision.selection.evidenceReferences.some(
      (reference) => commentUrlKey(reference) === commentUrlKey(evidenceUrl),
    ),
  );
}

function baselineMatches(
  baseline: ProvisionalDecisionBaseline,
  source: ProvisionalDecisionSource,
): boolean {
  return (
    baseline.title === source.snapshot.title &&
    baseline.bodySha256 === source.snapshot.bodySha256
  );
}

function chooseLabelName(store: ProvisionalDecisionStore): string {
  const config = plannerConfig(store);
  const labels = config?.labels;
  if (
    labels &&
    typeof labels === 'object' &&
    typeof (labels as Record<string, unknown>).needsDecisionLabelName ===
      'string' &&
    (labels as Record<string, string>).needsDecisionLabelName.trim()
  ) {
    return (labels as Record<string, string>).needsDecisionLabelName.trim();
  }
  return DEFAULT_DECISION_LABEL;
}

function toClaimLineage(
  lineage: ClaimFoldResult['lineage'],
): ProvisionalDecisionRecord['claimLineage'] {
  return lineage.map(({ claimId, agentId, branch, claimedAt, supersedes }) => ({
    claimId,
    agentId,
    branch,
    claimedAt,
    ...(supersedes ? { supersedes } : {}),
  }));
}

function historicalWorkFromRecord(
  record: ProvisionalDecisionRecord,
): VerifiedProvisionalWork | null {
  if (record.event.type !== 'work-completed') return null;
  const result = record.event.result as Record<string, unknown>;
  if (
    result.kind !== 'merged-pull-request' ||
    typeof result.reference !== 'string' ||
    typeof result.verifiedAt !== 'string' ||
    typeof result.headSha !== 'string' ||
    typeof result.mergeCommitSha !== 'string'
  ) {
    throw new Error(
      'historical completion is not a merged pull request record',
    );
  }
  return {
    source: record.source,
    bundleGeneration: record.bundleGeneration,
    decisionGeneration: record.decisionGeneration,
    reference: result.reference,
    verifiedAt: result.verifiedAt,
    headSha: result.headSha,
    mergeCommitSha: result.mergeCommitSha,
    executionCriteriaSatisfied: true,
  };
}

async function rebuildHistoricalWork(
  history: ProvisionalDecisionHistoryRead,
  store: ProvisionalDecisionStore,
): Promise<VerifiedProvisionalWork[]> {
  const work: VerifiedProvisionalWork[] = [];
  for (const comment of history.comments) {
    if (
      comment.trustedAuthor !== true ||
      comment.edited !== false ||
      !comment.authorLogin
    )
      continue;
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    if (!parsed.ok || parsed.record.event.type !== 'work-completed') continue;
    const evidence = historicalWorkFromRecord(parsed.record);
    if (!evidence) continue;
    const pullRequest = await store.readPullRequest(evidence.reference);
    const completion = parsed.record.event.result as Record<string, unknown>;
    if (
      pullRequest.state !== 'merged' ||
      pullRequest.headSha !== completion.headSha ||
      pullRequest.mergeCommitSha !== completion.mergeCommitSha
    ) {
      throw new Error(
        `historical pull request verification failed for ${evidence.reference}`,
      );
    }
    work.push(evidence);
  }
  return work;
}

function plan(
  candidateRecord: ProvisionalDecisionRecord,
  lineage: ClaimFoldResult['lineage'],
  verifiedAt: string,
  locatedDecision: ProvisionalDecisionPlan['locatedDecision'],
  history: ProvisionalDecisionHistoryRead,
  baseline: ProvisionalDecisionBaseline,
  existingRecord: ProvisionalDecisionPlan['existingRecord'],
  pullRequest: ProvisionalDecisionPullRequestRead | null,
): ProvisionalDecisionPlan {
  return {
    candidateRecord,
    verifiedClaimLineage: lineage,
    verifiedAt,
    locatedDecision,
    history,
    baseline,
    existingRecord,
    pullRequest,
  };
}

function gateFailure(
  request: ProvisionalDecisionCommandRequest,
  active: ClaimFoldResult['active'],
  source: ProvisionalDecisionSource,
  replayed: ReplayedProvisionalDecision | null,
  verifiedAt: string,
  history: ProvisionalDecisionHistoryRead,
  pullRequest: ProvisionalDecisionPullRequestRead | null,
): string | null {
  if (request.policyTrusted !== true)
    return 'trusted dangerouslyAutoDecide policy is not enabled';
  if (request.optionComparisonValid !== true)
    return 'option comparison has not been validated';
  if (request.worktreeBranch !== active.branch)
    return 'worktree branch does not match the active claim';
  if (request.claimId !== active.claimId) return 'a different claim is active';
  if (!baselineMatches(request.baseline, source))
    return 'source baseline differs from the fresh source read';
  if (request.type === 'work-started') {
    if (replayed?.status !== 'selected')
      return 'work-started requires a selected decision';
    if (!request.planCommentUrl) return 'planCommentUrl is required';
    const planComment = history.comments.find(
      (comment) =>
        commentUrlKey(comment.url) ===
        commentUrlKey(request.planCommentUrl ?? ''),
    );
    if (!planComment) return 'planCommentUrl is not a source history comment';
    const selectedComment = history.comments.find(
      (comment) =>
        extractRecordId(comment.body) === replayed.selection.recordId,
    );
    if (
      selectedComment &&
      Date.parse(planComment.createdAt) < Date.parse(selectedComment.createdAt)
    ) {
      return 'plan comment predates the selection';
    }
  }
  if (request.type === 'work-completed') {
    if (replayed?.status !== 'in-progress')
      return 'work-completed requires an in-progress decision';
    if (request.executionCriteriaSatisfied !== true)
      return 'execution criteria are not satisfied';
    if (
      pullRequest?.state !== 'merged' ||
      pullRequest.requiredChecksPassing !== true
    ) {
      return 'pull request is not merged with required checks passing';
    }
    const startedAt = replayed.workStarted?.event.startedAt;
    if (
      typeof startedAt === 'string' &&
      Date.parse(verifiedAt) < Date.parse(startedAt)
    ) {
      return 'verifiedAt predates work-started';
    }
  }
  return null;
}

function candidateFor(
  request: ProvisionalDecisionCommandRequest,
  source: ProvisionalDecisionSource,
  lineage: ClaimFoldResult['lineage'],
  evidenceUrl: string,
  bundleGeneration: number,
  decisionGeneration: number,
  verifiedAt: string,
  question: string | null,
  planComment: ProvisionalDecisionHistoryComment | null,
  pullRequest: ProvisionalDecisionPullRequestRead | null,
): CandidateInfo {
  const event: Record<string, unknown> = { type: request.type };
  if (request.type === 'selected') {
    event.question = question ?? '';
    event.selectedOption = request.selectedOption;
    event.feasibleAlternatives = request.feasibleAlternatives;
    event.executionCriteria = request.executionCriteria;
  } else if (request.type === 'work-started') {
    event.startedAt = planComment?.createdAt ?? '';
    event.planReference = request.planCommentUrl ?? '';
  } else {
    event.result = {
      kind: 'merged-pull-request',
      reference: request.pullRequestUrl ?? '',
      verifiedAt,
      headSha: request.verifiedHeadSha,
      mergeCommitSha: pullRequest?.mergeCommitSha ?? '',
    };
  }
  const record = {
    schemaVersion: 1,
    recordId: recordIdFor(
      request.repository,
      request.issueNumber,
      bundleGeneration,
      decisionGeneration,
      request.type,
    ),
    source,
    bundleGeneration,
    decisionGeneration,
    claimLineage: toClaimLineage(lineage),
    evidenceReferences: [evidenceUrl],
    event,
  } as unknown as ProvisionalDecisionRecord;
  const parsed = parseProvisionalDecisionRecordComment(
    recordCommentBody(record),
  );
  return {
    record,
    parseIssues: parsed.ok ? [] : parsed.issues.map((issue) => issue.code),
  };
}

function rawRecordMatches(
  comments: readonly ProvisionalDecisionHistoryComment[],
  recordId: string,
): ProvisionalDecisionHistoryComment[] {
  return comments.filter(
    (comment) => extractRecordId(comment.body) === recordId,
  );
}

function parseStoredRecord(
  comment: ProvisionalDecisionHistoryComment,
): ProvisionalDecisionRecord | null {
  const result = parseProvisionalDecisionRecordComment(comment.body);
  return result.ok ? result.record : null;
}

function createPlan(
  candidate: ProvisionalDecisionRecord,
  folded: ClaimFoldResult,
  verifiedAt: string,
  located: ReplayedProvisionalDecision | null,
  statusBundle: 'accepting' | 'waiting' | 'complete' | null,
  history: ProvisionalDecisionHistoryRead,
  baseline: ProvisionalDecisionBaseline,
  existing: ProvisionalDecisionPlan['existingRecord'],
  pullRequest: ProvisionalDecisionPullRequestRead | null,
): ProvisionalDecisionPlan {
  return plan(
    candidate,
    folded.lineage,
    verifiedAt,
    located
      ? {
          recordId: located.selection.recordId,
          bundleGeneration: located.bundleGeneration,
          decisionGeneration: located.decisionGeneration,
          status: located.status,
          bundleState: statusBundle ?? 'accepting',
        }
      : null,
    history,
    baseline,
    existing,
    pullRequest,
  );
}

/** Read-only steps 0 through 7 of the provisional-decision protocol. */
async function planProvisionalDecisionCommand(
  request: ProvisionalDecisionCommandRequest,
  store: ProvisionalDecisionStore,
): Promise<ProvisionalDecisionCommandResult> {
  if (request.type === 'work-completed' && !request.pullRequestUrl) {
    return refused('fix-input', 'pullRequestUrl is required before reads');
  }

  let history: ProvisionalDecisionHistoryRead;
  let sourceRead: ProvisionalDecisionSourceIssueRead;
  let pullRequest: ProvisionalDecisionPullRequestRead | null = null;
  let verifiedAt: string;
  try {
    [history, sourceRead] = await Promise.all([
      store.readHistory(),
      store.readSourceIssue(),
    ]);
    if (request.type === 'work-completed') {
      pullRequest = await store.readPullRequest(
        request.pullRequestUrl as string,
      );
    }
    const parsedDate = parseServerDate(history.serverDate);
    if (history.complete !== true || !parsedDate) {
      return refused(
        'recovery-hold',
        'history is incomplete or its server Date is invalid',
      );
    }
    verifiedAt = parsedDate;
  } catch (error) {
    return refused('recovery-hold', `fresh read failed: ${errorText(error)}`);
  }

  const source = sourceFromRead(request, sourceRead);
  let verifiedWork: VerifiedProvisionalWork[];
  try {
    verifiedWork = await rebuildHistoricalWork(history, store);
  } catch (error) {
    return refused(
      'recovery-hold',
      `historical completion verification failed: ${errorText(error)}`,
    );
  }

  const folded = resolveClaimFold(history, store);
  if (!folded)
    return refused(
      'recovery-hold',
      'active claim lineage could not be verified',
    );
  if ('failure' in folded) {
    return refused(
      'recovery-hold',
      `active claim lineage could not be verified: ${folded.failure}`,
    );
  }

  const completeRecords = history.comments.flatMap((comment) => {
    if (comment.trustedAuthor !== true || comment.edited !== false) return [];
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    return parsed.ok ? [{ comment, record: parsed.record }] : [];
  });
  const reworkRecordIds = completeRecords
    .filter(({ record }) => record.event.type === 'rework-authored')
    .map(({ record }) => record.recordId);
  if (
    request.verifiedReworkRoadmaps.length !== reworkRecordIds.length ||
    reworkRecordIds.some(
      (recordId) =>
        request.verifiedReworkRoadmaps.filter(
          (item) => item.recordId === recordId,
        ).length !== 1,
    )
  ) {
    return refused(
      'recovery-hold',
      'verified rework evidence is missing or duplicated',
    );
  }

  const replay = replayProvisionalDecisionHistory({
    comments: history.comments.map((comment) => ({
      ...comment,
      trustedAuthor: comment.trustedAuthor === true,
      edited: comment.edited !== false,
    })),
    completeHistory: history.complete === true,
    currentSource: source,
    verifiedClaimLineage: folded.lineage,
    verifiedWork,
    verifiedReworkRoadmaps: request.verifiedReworkRoadmaps,
  });
  if (!replay.valid) {
    return refused(
      'recovery-hold',
      `decision history replay refused: ${replay.issues[0]?.code ?? 'unknown'}`,
    );
  }

  const evidenceUrl = request.evidenceUrl;
  if (!evidenceUrl) return refused('fix-input', 'evidenceUrl is required');
  const matches = decisionForEvidence(replay, evidenceUrl);
  if (matches.length > 1) {
    return refused(
      'recovery-hold',
      'evidence URL identifies multiple decisions',
    );
  }
  const evidenceComment = history.comments.find(
    (comment) => commentUrlKey(comment.url) === commentUrlKey(evidenceUrl),
  );
  if (!evidenceComment) {
    return refused('fix-input', 'evidenceUrl is not a source history comment');
  }

  const latestBundleGeneration = replay.decisions.reduce(
    (latest, decision) => Math.max(latest, decision.bundleGeneration),
    0,
  );
  const latestBundleState = latestBundleGeneration
    ? bundleState(replay.decisions, latestBundleGeneration)
    : null;
  const located = matches[0] ?? null;
  if (located && located.bundleGeneration !== latestBundleGeneration) {
    return refused(
      'fix-input',
      'evidence URL belongs to an earlier decision bundle',
    );
  }
  if (!located && request.type !== 'selected') {
    return refused('fix-input', 'work transition has no selected decision');
  }

  let bundleGeneration = located?.bundleGeneration ?? 1;
  let decisionGeneration = located?.decisionGeneration ?? 1;
  const locatedStatus: 'accepting' | 'waiting' | 'complete' | null = located
    ? latestBundleState
    : null;
  if (!located && request.type === 'selected' && latestBundleGeneration > 0) {
    if (latestBundleState === 'waiting') {
      return refused('none', 'latest decision bundle is waiting');
    }
    if (latestBundleState === 'complete') {
      bundleGeneration = latestBundleGeneration + 1;
      decisionGeneration = 1;
    } else {
      bundleGeneration = latestBundleGeneration;
      const used = replay.decisions
        .filter(
          (decision) => decision.bundleGeneration === latestBundleGeneration,
        )
        .map((decision) => decision.decisionGeneration);
      decisionGeneration = Math.max(0, ...used) + 1;
    }
  }

  const question =
    request.type === 'selected' ? questionFromBody(sourceRead.body) : null;
  if (request.type === 'selected' && !question) {
    // Candidate parsing is held until step 7 so the explicit precheck
    // precedence can report a current gate failure first.
  }
  const planComment =
    request.type === 'work-started'
      ? (history.comments.find(
          (comment) =>
            commentUrlKey(comment.url) ===
            commentUrlKey(request.planCommentUrl ?? ''),
        ) ?? null)
      : null;

  if (request.type === 'work-completed') {
    if (pullRequest?.headSha !== request.verifiedHeadSha) {
      return refused(
        'recovery-hold',
        'pull request head differs from verifiedHeadSha',
      );
    }
    if (
      pullRequest.state === 'open' ||
      pullRequest.state === 'closed-unmerged' ||
      pullRequest.requiredChecksPassing !== true
    ) {
      return refused(
        'fix-input',
        'pull request is not merged or required checks are failing',
      );
    }
  }

  const candidateInfo = candidateFor(
    request,
    source,
    folded.lineage,
    evidenceUrl,
    bundleGeneration,
    decisionGeneration,
    verifiedAt,
    question,
    planComment,
    pullRequest,
  );
  const recordId = candidateInfo.record.recordId;
  if (candidateInfo.parseIssues.length) {
    const gateError = gateFailure(
      request,
      folded.active,
      source,
      located,
      verifiedAt,
      history,
      pullRequest,
    );
    if (gateError) return refused('fix-input', gateError, recordId);
    return refused(
      'fix-input',
      `candidate record failed schema parsing: ${candidateInfo.parseIssues.join(', ')}`,
      recordId,
    );
  }
  const sameIdComments = rawRecordMatches(history.comments, recordId);
  if (sameIdComments.length > 1) {
    return refused(
      'recovery-hold',
      'multiple history comments share the candidate recordId',
      recordId,
    );
  }
  const sameIdComment = sameIdComments[0];
  let existingPlan: ProvisionalDecisionPlan['existingRecord'] = null;
  if (sameIdComment) {
    if (
      sameIdComment.trustedAuthor !== true ||
      sameIdComment.edited !== false
    ) {
      return refused(
        'recovery-hold',
        'same recordId exists in an untrusted or edited comment',
        recordId,
        sameIdComment.url,
      );
    }
    if (!baselineMatches(request.baseline, source)) {
      return refused(
        'recovery-hold',
        'source baseline differs for an existing record',
        recordId,
        sameIdComment.url,
      );
    }
    const storedRecord = parseStoredRecord(sameIdComment);
    if (!storedRecord || !sameContent(storedRecord, candidateInfo.record)) {
      return refused(
        'recovery-hold',
        'same recordId exists with different content',
        recordId,
        sameIdComment.url,
      );
    }
    const locatedBundle = located
      ? bundleState(replay.decisions, located.bundleGeneration)
      : null;
    const earlyGateFailure =
      request.policyTrusted !== true
        ? 'trusted dangerouslyAutoDecide policy is not enabled'
        : request.optionComparisonValid !== true
          ? 'option comparison has not been validated'
          : request.worktreeBranch !== folded.active.branch
            ? 'worktree branch does not match the active claim'
            : request.claimId !== folded.active.claimId
              ? 'a different claim is active'
              : request.type === 'work-completed' &&
                  request.executionCriteriaSatisfied !== true
                ? 'execution criteria are not satisfied'
                : null;
    if (earlyGateFailure) {
      return refused(
        'fix-input',
        earlyGateFailure,
        recordId,
        sameIdComment.url,
      );
    }
    try {
      let labelPresent = false;
      if (request.type === 'work-completed') {
        const label = await store.applyOrReadDecisionLabel({
          labelName: chooseLabelName(store),
          apply: false,
        });
        labelPresent = label.present === true;
      }
      existingPlan = {
        commentId: sameIdComment.id,
        commentUrl: sameIdComment.url,
        labelPresent,
      };
      const existingCandidate = storedRecord;
      const resultPlan = createPlan(
        existingCandidate,
        folded,
        request.type === 'work-completed'
          ? ((storedRecord.event.result as Record<string, unknown>)
              .verifiedAt as string)
          : verifiedAt,
        located,
        locatedBundle,
        history,
        request.baseline,
        existingPlan,
        pullRequest,
      );
      if (request.type === 'work-completed' && !labelPresent) {
        return {
          state: 'planned',
          recordId,
          commentUrl: sameIdComment.url,
          plan: resultPlan,
        };
      }
      return {
        state: 'reconciled',
        action: 'reconcile',
        recordId,
        commentUrl: sameIdComment.url,
        plan: resultPlan,
      };
    } catch (error) {
      return refused(
        'recovery-hold',
        `decision label read failed: ${errorText(error)}`,
        recordId,
        sameIdComment.url,
      );
    }
  }

  const gateError = gateFailure(
    request,
    folded.active,
    source,
    located,
    verifiedAt,
    history,
    pullRequest,
  );
  if (gateError) return refused('fix-input', gateError, recordId);

  const resultPlan = createPlan(
    candidateInfo.record,
    folded,
    verifiedAt,
    located,
    locatedStatus,
    history,
    request.baseline,
    existingPlan,
    pullRequest,
  );
  return {
    state: 'planned',
    recordId,
    commentUrl: '',
    plan: resultPlan,
  };
}

export interface ProvisionalDecisionCommandOptions {
  /** Defaults to false. Only true may append a record or apply the label. */
  readonly apply?: boolean;
}

function expectedStatus(
  request: ProvisionalDecisionCommandRequest,
): ReplayedProvisionalDecision['status'] {
  switch (request.type) {
    case 'selected':
      return 'selected';
    case 'work-started':
      return 'in-progress';
    case 'work-completed':
      return 'confirmation-pending';
  }
}

function sameLineage(
  left: readonly VerifiedProvisionalDecisionClaim[],
  right: readonly VerifiedProvisionalDecisionClaim[],
): boolean {
  return stableJson(left) === stableJson(right);
}

function stepEightPlanChanged(
  before: ProvisionalDecisionPlan,
  after: ProvisionalDecisionPlan,
): boolean {
  return (
    !sameContent(before.candidateRecord, after.candidateRecord) ||
    before.candidateRecord.source.snapshot.title !==
      after.candidateRecord.source.snapshot.title ||
    before.candidateRecord.source.snapshot.bodySha256 !==
      after.candidateRecord.source.snapshot.bodySha256 ||
    !sameLineage(before.verifiedClaimLineage, after.verifiedClaimLineage) ||
    stableJson(before.locatedDecision) !== stableJson(after.locatedDecision)
  );
}

function recoveryHold(
  result: ProvisionalDecisionCommandResult,
  reason: string,
  recordId: string | null = result.recordId,
  commentUrl = result.commentUrl,
): ProvisionalDecisionCommandResult {
  return refused('recovery-hold', reason, recordId, commentUrl);
}

function verifyStoredAppend(
  request: ProvisionalDecisionCommandRequest,
  expected: ProvisionalDecisionRecord,
  expectedDecision: ProvisionalDecisionPlan['locatedDecision'],
  stored: ProvisionalDecisionStoredRecord,
  result: ProvisionalDecisionCommandResult,
): string | null {
  if (result.state === 'refused') {
    return `fresh history verification refused: ${result.reason ?? result.action}`;
  }
  if (!('plan' in result) || !result.plan) {
    return 'fresh history verification did not return its plan';
  }
  const comments = rawRecordMatches(
    result.plan.history.comments,
    expected.recordId,
  );
  if (comments.length !== 1) {
    return 'fresh history must contain exactly one matching record';
  }
  const comment = comments[0];
  if (
    !comment ||
    comment.id !== stored.id ||
    comment.url !== stored.url ||
    comment.trustedAuthor !== true ||
    comment.edited !== false
  ) {
    return 'fresh history record identity, trust, or edit state differs';
  }
  const record = parseStoredRecord(comment);
  if (!record || !sameContent(record, expected)) {
    return 'fresh history record content differs from the appended record';
  }
  if (
    result.plan.candidateRecord.recordId !== expected.recordId ||
    result.plan.candidateRecord.source.snapshot.title !==
      request.baseline.title ||
    result.plan.candidateRecord.source.snapshot.bodySha256 !==
      request.baseline.bodySha256
  ) {
    return 'fresh history record baseline differs from the request';
  }
  const decisionRecordId =
    request.type === 'selected'
      ? expected.recordId
      : expectedDecision?.recordId;
  if (
    !decisionRecordId ||
    result.plan.locatedDecision?.recordId !== decisionRecordId ||
    result.plan.locatedDecision.bundleGeneration !==
      expected.bundleGeneration ||
    result.plan.locatedDecision.decisionGeneration !==
      expected.decisionGeneration ||
    result.plan.locatedDecision.status !== expectedStatus(request)
  ) {
    return 'fresh history replay did not produce the expected decision status';
  }
  if (
    result.plan.existingRecord?.commentId !== stored.id ||
    result.plan.existingRecord.commentUrl !== stored.url
  ) {
    return 'fresh history plan did not retain the stored record identity';
  }
  return null;
}

async function applyCompletionLabel(
  request: ProvisionalDecisionCommandRequest,
  store: ProvisionalDecisionStore,
  planned: ProvisionalDecisionCommandResult,
): Promise<ProvisionalDecisionCommandResult> {
  if (
    request.type !== 'work-completed' ||
    planned.state !== 'planned' ||
    !planned.plan.existingRecord
  ) {
    return recoveryHold(
      planned,
      'completion label step requires a verified stored completion record',
    );
  }
  const { plan: resultPlan } = planned;
  const recordId = resultPlan.candidateRecord.recordId;
  const existingRecord = resultPlan.existingRecord;
  if (!existingRecord) {
    return recoveryHold(
      planned,
      'completion label step requires a verified stored completion record',
    );
  }
  const commentUrl = existingRecord.commentUrl;
  if (existingRecord.labelPresent) {
    return {
      state: 'reconciled',
      action: 'reconcile',
      recordId,
      commentUrl,
    };
  }
  if (resultPlan.locatedDecision?.status !== 'confirmation-pending') {
    return {
      state: 'reconciled',
      action: 'reconcile',
      reason: 'decision no longer awaits confirmation',
      recordId,
      commentUrl,
    };
  }

  // The read-back can go stale before this label side effect.
  let finalRead: ProvisionalDecisionCommandResult;
  try {
    finalRead = await planProvisionalDecisionCommand(request, store);
  } catch (error) {
    return recoveryHold(
      planned,
      `step-10 fresh read failed: ${errorText(error)}`,
      recordId,
      commentUrl,
    );
  }
  if (finalRead.state === 'reconciled') return finalRead;
  if (finalRead.state === 'refused') {
    if (finalRead.action === 'fix-input') {
      return refused(
        'fix-input',
        finalRead.reason ?? 'step-10 gates no longer pass',
        recordId,
        commentUrl,
      );
    }
    return recoveryHold(
      finalRead,
      `step-10 fresh read no longer permits label application: ${finalRead.reason ?? finalRead.action}`,
      recordId,
      commentUrl,
    );
  }
  if (finalRead.state !== 'planned') {
    return recoveryHold(
      finalRead,
      'step-10 fresh read did not return a plan',
      recordId,
      commentUrl,
    );
  }

  const finalPlan = finalRead.plan;
  const finalExistingRecord = finalPlan.existingRecord;
  if (
    stepEightPlanChanged(resultPlan, finalPlan) ||
    finalPlan.locatedDecision?.status !== 'confirmation-pending' ||
    !finalExistingRecord ||
    finalExistingRecord.commentId !== existingRecord.commentId ||
    finalExistingRecord.commentUrl !== commentUrl ||
    finalExistingRecord.labelPresent
  ) {
    return recoveryHold(
      finalRead,
      'step-10 decision history or stored record changed before label application',
      recordId,
      commentUrl,
    );
  }

  try {
    const label = await store.applyOrReadDecisionLabel({
      labelName: chooseLabelName(store),
      apply: true,
    });
    if (label.present === true)
      return { state: 'applied', recordId, commentUrl };
    return {
      state: 'reconciled',
      action: 'reconcile',
      reason: 'decision label was not present after apply and read-back',
      recordId,
      commentUrl,
    };
  } catch (error) {
    return {
      state: 'reconciled',
      action: 'reconcile',
      reason: `decision label apply or read-back failed: ${errorText(error)}`,
      recordId,
      commentUrl,
    };
  }
}

/**
 * Run the provisional-decision protocol. The default is read-only; `apply`
 * re-reads every gate before appending or applying a completion label.
 */
export async function runProvisionalDecisionCommand(
  request: ProvisionalDecisionCommandRequest,
  store: ProvisionalDecisionStore,
  options: ProvisionalDecisionCommandOptions = {},
): Promise<ProvisionalDecisionCommandResult> {
  const initial = await planProvisionalDecisionCommand(request, store);
  if (options.apply !== true || initial.state !== 'planned') return initial;

  const initialPlan = initial.plan;
  let stepEight: ProvisionalDecisionCommandResult;
  try {
    stepEight = await planProvisionalDecisionCommand(request, store);
  } catch (error) {
    return recoveryHold(
      initial,
      `step-8 fresh read failed: ${errorText(error)}`,
      initialPlan.candidateRecord.recordId,
    );
  }

  if (stepEight.state === 'refused') {
    if (
      stepEight.action === 'fix-input' &&
      stepEight.recordId === initialPlan.candidateRecord.recordId &&
      stepEight.commentUrl !== ''
    ) {
      return stepEight;
    }
    return recoveryHold(
      stepEight,
      `step-8 fresh read no longer satisfies the plan: ${stepEight.reason ?? stepEight.action}`,
      initialPlan.candidateRecord.recordId,
      initialPlan.existingRecord?.commentUrl,
    );
  }

  if (stepEight.state === 'reconciled') {
    if (stepEight.plan && stepEightPlanChanged(initialPlan, stepEight.plan)) {
      return recoveryHold(
        stepEight,
        'step-8 located decision, bundle, source, or claim lineage changed',
        initialPlan.candidateRecord.recordId,
        stepEight.plan.existingRecord?.commentUrl ??
          initialPlan.existingRecord?.commentUrl ??
          stepEight.commentUrl,
      );
    }
    return stepEight;
  }
  if (stepEight.state !== 'planned') {
    return recoveryHold(
      stepEight,
      'step-8 fresh read did not return a plan',
      initialPlan.candidateRecord.recordId,
    );
  }

  const freshPlan = stepEight.plan;
  if (freshPlan.existingRecord) {
    // Another writer may have created this record after the first plan. The
    // planner has just applied the existing-record step-6 checks to it.
    if (stepEightPlanChanged(initialPlan, freshPlan)) {
      return recoveryHold(
        stepEight,
        'step-8 located decision, bundle, source, or claim lineage changed',
        initialPlan.candidateRecord.recordId,
        freshPlan.existingRecord.commentUrl,
      );
    }
    return applyCompletionLabel(request, store, stepEight);
  }

  if (
    initialPlan.existingRecord ||
    stepEightPlanChanged(initialPlan, freshPlan)
  ) {
    return recoveryHold(
      stepEight,
      'step-8 located decision, bundle, source, or claim lineage changed',
      initialPlan.candidateRecord.recordId,
    );
  }

  let append: {
    readonly result: 'created' | 'existed';
    readonly record: ProvisionalDecisionStoredRecord;
  };
  try {
    append = await store.appendRecordBody(
      initialPlan.candidateRecord.recordId,
      recordCommentBody(initialPlan.candidateRecord),
    );
  } catch (error) {
    return recoveryHold(
      stepEight,
      `step-8 append failed: ${errorText(error)}`,
      initialPlan.candidateRecord.recordId,
    );
  }

  if (!append.record.id || !append.record.url) {
    return recoveryHold(
      stepEight,
      'append returned an empty comment identity',
      initialPlan.candidateRecord.recordId,
      append.record.url,
    );
  }

  let readBack: ProvisionalDecisionCommandResult;
  try {
    readBack = await planProvisionalDecisionCommand(request, store);
  } catch (error) {
    return recoveryHold(
      stepEight,
      `step-9 fresh read failed: ${errorText(error)}`,
      initialPlan.candidateRecord.recordId,
      append.record.url,
    );
  }

  if (append.result === 'existed' && readBack.state === 'refused') {
    if (readBack.action === 'fix-input') {
      return refused(
        'fix-input',
        readBack.reason ?? 'existing record gates failed',
        initialPlan.candidateRecord.recordId,
        append.record.url,
      );
    }
    return recoveryHold(
      readBack,
      readBack.reason ?? 'existing record could not be verified',
      initialPlan.candidateRecord.recordId,
      append.record.url,
    );
  }

  const readBackError = verifyStoredAppend(
    request,
    initialPlan.candidateRecord,
    initialPlan.locatedDecision,
    append.record,
    readBack,
  );
  if (readBackError) {
    return recoveryHold(
      readBack,
      append.result === 'created'
        ? `step-9 read-back failed: ${readBackError}`
        : `step-8 existing-record verification failed: ${readBackError}`,
      initialPlan.candidateRecord.recordId,
      append.record.url,
    );
  }

  if (append.result === 'existed') {
    if (readBack.state === 'refused') return readBack;
    if (readBack.state === 'planned') {
      return applyCompletionLabel(request, store, readBack);
    }
    return readBack;
  }

  if (request.type === 'work-completed') {
    if (readBack.state === 'planned') {
      return applyCompletionLabel(request, store, readBack);
    }
    if (readBack.state === 'reconciled') return readBack;
    return recoveryHold(
      readBack,
      'step-9 verification did not permit completion-label application',
      initialPlan.candidateRecord.recordId,
      append.record.url,
    );
  }

  return {
    state: 'applied',
    recordId: initialPlan.candidateRecord.recordId,
    commentUrl: append.record.url,
  };
}

// ---------------------------------------------------------------------------
// Resolution of an execution-complete, confirmation-pending source (#4536).
//
// A separate entry point from `runProvisionalDecisionCommand`: it shares the
// replay and claim machinery above but leaves the existing request union and
// store untouched. Every step is derived from fresh reads, so a crash, an
// uncertain write, or a failed close resumes exactly the remaining step.
// ---------------------------------------------------------------------------

/** The question every resolution presents and every answer record retains. */
export const PROVISIONAL_CONFIRMATION_QUESTION =
  'Were the implemented choices above acceptable? [y/N]';

export interface ProvisionalDecisionSourceStateRead {
  readonly state: 'open' | 'closed';
  /** GitHub's close reason when closed, or null while open. */
  readonly stateReason: string | null;
}

/** What a close must still find true; see `closeSourceIssue`. */
export interface ProvisionalResolutionCloseExpectation {
  readonly state: 'open';
  readonly title: string;
  readonly bodySha256: string;
  /** The coordination claim that must still be the active claim. */
  readonly claim: {
    readonly claimId: string;
    readonly agentId: string;
    readonly branch: string;
  };
}

/** The writes a resolution needs on top of the decision store. */
export interface ProvisionalResolutionStore extends ProvisionalDecisionStore {
  readSourceState(): Promise<ProvisionalDecisionSourceStateRead>;
  /** Append an agent-answer comment, or return the identical existing one. */
  appendAnswerBody(body: string): Promise<{
    readonly result: 'created' | 'existed';
    readonly record: ProvisionalDecisionStoredRecord;
  }>;
  /**
   * Close the source issue with the completed reason, but only while it is
   * still in the state the plan evaluated; otherwise throw without closing. A
   * store checks, as far as its API allows, that the issue is still open (so
   * an intervening close with another reason is never overwritten), that its
   * title and body still match (`bodySha256` is the lowercase SHA-256 hex of
   * the body's UTF-8 bytes), and that the named coordination claim is still
   * the active claim (so a takeover after the final plan read cannot close
   * under a stale claim). It can narrow the window further, for example by
   * comparing the issue's update time; the planner re-reads just before.
   */
  closeSourceIssue(
    expected: ProvisionalResolutionCloseExpectation,
  ): Promise<void>;
  /** Post the unclaim marker of the coordination claim, per the claim protocol. */
  releaseCoordinationClaim(claim: {
    readonly claimId: string;
    readonly agentId: string;
    readonly branch: string;
  }): Promise<void>;
}

/** Who produced an input event. Only a user-origin event can answer. */
export type ConfirmationInputOrigin = 'user' | 'assistant' | 'tool' | 'unknown';

export type ConfirmationTerminalEvent =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'eof' }
  | { readonly kind: 'cancelled' };

/** The agent's reading of a user's conversation reply. */
export type ConfirmationInterpretation =
  | { readonly response: 'accepted' }
  | {
      readonly response: 'rework';
      readonly requestedOptionId: string;
      readonly rationale: string;
    }
  | { readonly response: 'declined' }
  | { readonly response: 'none' };

/**
 * An actual input event. A pending question never produces one by itself:
 * the caller reports what the user did, and `none` or `timeout` mean the user
 * did nothing.
 */
export type ConfirmationInput =
  | {
      readonly channel: 'terminal';
      readonly origin: ConfirmationInputOrigin;
      /** True only when a prompt was displayed to a person at a terminal. */
      readonly interactive: boolean;
      readonly event: ConfirmationTerminalEvent;
    }
  | {
      readonly channel: 'conversation';
      readonly origin: ConfirmationInputOrigin;
      readonly message: string;
      readonly interpretation: ConfirmationInterpretation;
    }
  | { readonly channel: 'timeout' }
  | { readonly channel: 'none' };

export type ConfirmationPendingReason =
  | 'no-input'
  | 'timeout'
  | 'cancelled'
  | 'eof'
  | 'default-no'
  | 'declined'
  | 'unrecognized'
  | 'generic-request'
  | 'input-not-from-user'
  | 'non-interactive-terminal';

export type ConfirmationAnswer =
  | {
      readonly kind: 'accepted';
      readonly channel: 'terminal' | 'conversation';
      readonly answerText: string;
    }
  | {
      readonly kind: 'rework';
      readonly channel: 'terminal' | 'conversation';
      readonly answerText: string;
      readonly requestedOptionId: string;
      readonly rationale: string;
    }
  | { readonly kind: 'pending'; readonly reason: ConfirmationPendingReason };

const TERMINAL_REWORK_PATTERN = /^option\s+(\S+)\s+(\S.*)$/iu;

function pending(reason: ConfirmationPendingReason): ConfirmationAnswer {
  return { kind: 'pending', reason };
}

/**
 * Read one input event as an answer. Only an interactive terminal line typed
 * by a user (`y` or `yes`) or a user-origin conversation reply that the agent
 * classified can accept. N, Enter, EOF, cancellation, a timeout, missing
 * input, an unrecognized line, a non-user origin, and a terminal that showed
 * no prompt all leave the source pending. The adapter never creates input.
 *
 * It does not identify who supplied the bytes: a TTY is a prompt capability,
 * not authentication, and a dishonest authorized caller is outside the
 * guarantee.
 */
// audit:ignore-dead-export: no production caller until the command and GitHub store wiring lands (follow-up of roadmap #4528, not yet filed); tests lock the input rules until then
export function readConfirmationAnswer(
  input: ConfirmationInput | null | undefined,
  alternativeIds: readonly string[],
): ConfirmationAnswer {
  if (!input || input.channel === 'none') return pending('no-input');
  if (input.channel === 'timeout') return pending('timeout');
  if (input.origin !== 'user') return pending('input-not-from-user');
  if (input.channel === 'conversation') {
    // The actual reply is kept verbatim; trimming serves only the checks.
    const message = input.message;
    if (message.trim() === '') return pending('no-input');
    const reading = input.interpretation;
    if (reading.response === 'accepted') {
      return { kind: 'accepted', channel: 'conversation', answerText: message };
    }
    if (reading.response === 'declined') return pending('declined');
    if (reading.response === 'rework') {
      if (
        !alternativeIds.includes(reading.requestedOptionId) ||
        reading.rationale.trim() === ''
      ) {
        return pending('unrecognized');
      }
      return {
        kind: 'rework',
        channel: 'conversation',
        answerText: message,
        requestedOptionId: reading.requestedOptionId,
        rationale: reading.rationale.trim(),
      };
    }
    return pending('generic-request');
  }
  if (!input.interactive) return pending('non-interactive-terminal');
  const event = input.event;
  if (event.kind === 'eof') return pending('eof');
  if (event.kind === 'cancelled') return pending('cancelled');
  const text = event.text.trim();
  if (text === '') return pending('default-no');
  if (/^(?:y|yes)$/iu.test(text)) {
    return { kind: 'accepted', channel: 'terminal', answerText: event.text };
  }
  if (/^(?:n|no|nope)$/iu.test(text)) return pending('declined');
  const rework = TERMINAL_REWORK_PATTERN.exec(text);
  if (rework?.[1] && rework[2] && alternativeIds.includes(rework[1])) {
    return {
      kind: 'rework',
      channel: 'terminal',
      answerText: event.text,
      requestedOptionId: rework[1],
      rationale: rework[2].trim(),
    };
  }
  return pending('unrecognized');
}

export interface ProvisionalResolutionPresentation {
  readonly question: string;
  readonly source: {
    readonly repository: string;
    readonly issueNumber: number;
    readonly title: string;
    readonly bodySha256: string;
  };
  readonly bundleGeneration: number;
  readonly decisions: readonly {
    readonly decisionGeneration: number;
    readonly status: ReplayedProvisionalDecision['status'];
    readonly question: string;
    readonly selectedOption: JsonRecord;
    /** Each alternative carries its consequences and the rework it implies. */
    readonly alternatives: readonly JsonRecord[];
    readonly result: JsonRecord;
  }[];
}

type JsonRecord = Record<string, unknown>;

interface ResolutionRequestBase {
  readonly repository: string;
  readonly issueNumber: number;
  /** The coordination claim this session holds for the operator-directed review. */
  readonly claimId: string;
  /** The agent and branch named by that claim's marker, checked with its ID. */
  readonly agentId: string;
  readonly branch: string;
  /** Caller-verified evidence for every rework-authored record in history. */
  readonly verifiedReworkRoadmaps: readonly VerifiedProvisionalReworkRoadmap[];
}

export interface ProvisionalResolveRequest extends ResolutionRequestBase {
  readonly type: 'resolve';
  /** The decision generations of the current bundle this answer applies to. */
  readonly decisionGenerations: readonly number[];
  /** What the user actually did, or nothing. Never an assistant assertion. */
  readonly input?: ConfirmationInput | null;
  /** SHA-256 of the presentation the input answered. */
  readonly answeredPresentationSha256?: string;
  /** Later work that relied on the prior results, for a rework handoff. */
  readonly downstreamResults?: readonly string[];
}

/** Caller-verified authoring facts a rework-authored record needs. */
export interface ProvisionalReworkAuthoringEvidence {
  readonly owner: {
    readonly trusted: boolean;
    readonly fresh: boolean;
    readonly setId: string;
    readonly sessionId: string;
    readonly anchor: string;
  };
  readonly roadmap: {
    readonly audited: boolean;
    /**
     * The title and body digest of the source as it was when the audit began,
     * captured by the caller before it read the roadmap and its children. A
     * copy taken from a later read would make the freshness check meaningless.
     */
    readonly auditedSource: {
      readonly title: string;
      readonly bodySha256: string;
    };
    readonly issueNumber: number;
    readonly markerId: string;
    readonly url: string;
    readonly publishedCommentId: string;
    readonly publishedAt: string;
  };
  /** The real child issues of the rework roadmap, each wired under it. */
  readonly children: readonly {
    readonly issueNumber: number;
    readonly wired: boolean;
  }[];
}

export interface ProvisionalReworkAuthoredRequest
  extends ResolutionRequestBase {
  readonly type: 'rework-authored';
  readonly authoring: ProvisionalReworkAuthoringEvidence;
}

export type ProvisionalResolutionRequest =
  | ProvisionalResolveRequest
  | ProvisionalReworkAuthoredRequest;

export type ProvisionalResolutionStepKind =
  | 'append-answer'
  | 'append-confirmation'
  | 'append-rework-request'
  | 'append-rework-authored'
  | 'close-source'
  | 'release-claim';

export type ProvisionalResolutionOutcome =
  | 'confirmed-closed'
  | 'pending-released'
  | 'rework-handoff-recorded'
  | 'rework-authored';

export interface ProvisionalResolutionResult {
  readonly state: 'planned' | 'applied' | 'reconciled' | 'refused';
  readonly action?: ProvisionalDecisionAction;
  readonly outcome?: ProvisionalResolutionOutcome;
  readonly reason?: string;
  /** The step a dry run would take next. */
  readonly nextStep?: ProvisionalResolutionStepKind;
  /** The writes this run completed, in order. */
  readonly steps: readonly ProvisionalResolutionStepKind[];
  readonly recordIds: readonly string[];
  readonly presentation?: ProvisionalResolutionPresentation;
  readonly presentationSha256?: string;
  /**
   * On a planned result: true when the user still has to be asked, false when
   * the step resumes a persisted answer or finishes the lifecycle, so the
   * presentation is context and no prompt is needed.
   */
  readonly needsUserAnswer?: boolean;
  /** Notes about writes that threw but were proven by a fresh read, or ignored input. */
  readonly warnings?: readonly string[];
}

interface ClaimIdentity {
  readonly claimId: string;
  readonly agentId: string;
  readonly branch: string;
}

type ResolutionStep =
  | {
      readonly kind: 'append-answer';
      readonly body: string;
    }
  | {
      readonly kind:
        | 'append-confirmation'
        | 'append-rework-request'
        | 'append-rework-authored';
      readonly record: ProvisionalDecisionRecord;
    }
  | {
      readonly kind: 'close-source';
      /** What the plan evaluated; the store closes only while it still holds. */
      readonly expected: ProvisionalResolutionCloseExpectation;
    }
  | {
      readonly kind: 'release-claim';
      readonly claim: ClaimIdentity;
      readonly outcome: ProvisionalResolutionOutcome;
      readonly reason?: string;
    };

type ResolutionPlan =
  | {
      readonly kind: 'step';
      readonly step: ResolutionStep;
      readonly presentation?: ProvisionalResolutionPresentation;
      readonly presentationSha256?: string;
      /** True when the user still has to be asked; false on a resume step. */
      readonly needsUserAnswer?: boolean;
      readonly warnings?: readonly string[];
    }
  | {
      readonly kind: 'done';
      readonly outcome: ProvisionalResolutionOutcome;
      readonly reason: string;
    }
  | { readonly kind: 'refused'; readonly result: ProvisionalResolutionResult };

const ANSWER_MARKER = PROVISIONAL_DECISION_ANSWER_MARKER;
const PREVIEW_ANSWER_ID = '900000000000001';
const PREVIEW_RECORD_ID = '900000000000002';

function resolutionRefusal(
  action: Exclude<ProvisionalDecisionAction, 'reconcile'>,
  reason: string,
  extra: Partial<ProvisionalResolutionResult> = {},
): ResolutionPlan {
  return {
    kind: 'refused',
    result: {
      state: 'refused',
      action,
      reason,
      steps: [],
      recordIds: [],
      ...extra,
    },
  };
}

/** The answer's identity without the source's update time, which any edit moves. */
function answerStepDigest(body: string): string {
  const parsed = parseProvisionalDecisionAnswerComment(body);
  if (!parsed.ok) return bodySha256(body);
  const { source, ...rest } = parsed.answer;
  const { updatedAt: _updatedAt, ...snapshot } = source.snapshot;
  return bodySha256(digestJson({ ...rest, source: { ...source, snapshot } }));
}

function stepKey(step: ResolutionStep): string {
  switch (step.kind) {
    case 'append-answer':
      return `answer:${answerStepDigest(step.body)}`;
    case 'close-source':
      return 'close';
    case 'release-claim':
      return `release:${step.claim.claimId}`;
    default:
      return `record:${step.record.recordId}:${recordStepDigest(step.record)}`;
  }
}

/** The record's whole content except the source update time any edit moves. */
function recordStepDigest(record: ProvisionalDecisionRecord): string {
  const { updatedAt: _updatedAt, ...snapshot } = record.source.snapshot;
  return bodySha256(
    digestJson({ ...record, source: { ...record.source, snapshot } }),
  );
}

/** Key order by code unit, so the digest is the same in every process. */
function digestJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(digestJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${digestJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function presentationSha256(
  presentation: ProvisionalResolutionPresentation,
): string {
  return bodySha256(digestJson(presentation));
}

function uuidFromSeed(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function asRecord(value: unknown): JsonRecord {
  return (value ?? {}) as JsonRecord;
}

function buildPresentation(
  decisions: readonly ReplayedProvisionalDecision[],
  source: ProvisionalDecisionSource,
  bundleGeneration: number,
): ProvisionalResolutionPresentation {
  const ordered = [...decisions].sort(
    (left, right) => left.decisionGeneration - right.decisionGeneration,
  );
  return {
    question: PROVISIONAL_CONFIRMATION_QUESTION,
    source: {
      repository: source.repository,
      issueNumber: source.issueNumber,
      title: source.snapshot.title,
      bodySha256: source.snapshot.bodySha256,
    },
    bundleGeneration,
    decisions: ordered.map((decision) => {
      const selection = decision.selection.event;
      const alternatives = (selection.feasibleAlternatives ??
        []) as JsonRecord[];
      return {
        decisionGeneration: decision.decisionGeneration,
        status: decision.status,
        question: String(selection.question),
        selectedOption: asRecord(selection.selectedOption),
        alternatives: alternatives.map((alternative) => ({
          id: alternative.id,
          description: alternative.description,
          consequences: alternative.consequences,
          reworkImpact: alternative.reversalOrMigration,
        })),
        result: asRecord(decision.workCompleted?.event.result),
      };
    }),
  };
}

function presentedBundleFor(
  decisions: readonly ReplayedProvisionalDecision[],
): ProvisionalDecisionAnswer['presentedBundle'] {
  return [...decisions]
    .sort((left, right) => left.decisionGeneration - right.decisionGeneration)
    .map((decision) => {
      const selection = decision.selection.event;
      return {
        decisionGeneration: decision.decisionGeneration,
        question: String(selection.question),
        selectedOptionId: String(asRecord(selection.selectedOption).id),
        feasibleAlternativeIds: (
          (selection.feasibleAlternatives ?? []) as JsonRecord[]
        )
          .map((alternative) => String(alternative.id))
          .sort(),
        workCompletedRecordId: decision.workCompleted?.recordId ?? '',
        result: asRecord(decision.workCompleted?.event.result),
      };
    });
}

interface ResolutionContext {
  readonly request: ProvisionalResolutionRequest;
  readonly history: ProvisionalDecisionHistoryRead;
  readonly source: ProvisionalDecisionSource;
  readonly sourceState: ProvisionalDecisionSourceStateRead;
  readonly verifiedAt: string;
  readonly verifiedWork: readonly VerifiedProvisionalWork[];
  readonly lineage: readonly VerifiedProvisionalDecisionClaim[];
  readonly active: ClaimIdentity | null;
  /** The claim that was active once the comment at `index` had been posted. */
  readonly activeClaimAt: (index: number) => ClaimIdentity | null;
}

function replayContext(
  context: ResolutionContext,
  extra: readonly ProvisionalDecisionHistoryComment[] = [],
  options: {
    readonly currentSource?: ProvisionalDecisionSource;
    readonly evidence?: readonly VerifiedProvisionalReworkRoadmap[];
  } = {},
): ProvisionalDecisionReplayResult {
  return replayProvisionalDecisionHistory({
    comments: [...context.history.comments, ...extra].map((comment) => ({
      ...comment,
      trustedAuthor: comment.trustedAuthor === true,
      edited: comment.edited !== false,
    })),
    completeHistory: context.history.complete === true,
    currentSource: options.currentSource ?? context.source,
    verifiedClaimLineage: context.lineage,
    verifiedWork: context.verifiedWork,
    verifiedReworkRoadmaps:
      options.evidence ?? context.request.verifiedReworkRoadmaps,
  });
}

/** A virtual trailing comment, so a candidate is checked by the real replay. */
function previewComment(
  context: ResolutionContext,
  id: string,
  body: string,
): ProvisionalDecisionHistoryComment {
  const last = context.history.comments.at(-1)?.createdAt;
  const createdAt =
    last && Date.parse(last) > Date.parse(context.verifiedAt)
      ? last
      : context.verifiedAt;
  return {
    id,
    url: `https://github.com/${context.source.repository}/issues/${context.source.issueNumber}#issuecomment-${id}`,
    body,
    authorLogin: 'resolution-preview',
    createdAt,
    edited: false,
    trustedAuthor: true,
  };
}

function implementationClaimIds(
  replay: ProvisionalDecisionReplayResult,
): Set<string> {
  const ids = new Set<string>();
  for (const decision of replay.decisions) {
    for (const record of [
      decision.selection,
      decision.workStarted,
      decision.workCompleted,
    ]) {
      for (const claim of record?.claimLineage ?? []) ids.add(claim.claimId);
    }
  }
  return ids;
}

function baseRecord(
  context: ResolutionContext,
  bundleGeneration: number,
  decisionGeneration: number,
  eventType: string,
  answerUrl: string,
  event: Record<string, unknown>,
): ProvisionalDecisionRecord {
  return {
    schemaVersion: 1,
    recordId: recordIdFor(
      context.request.repository,
      context.request.issueNumber,
      bundleGeneration,
      decisionGeneration,
      eventType,
    ),
    source: context.source,
    bundleGeneration,
    decisionGeneration,
    claimLineage: toClaimLineage(context.lineage),
    evidenceReferences: [answerUrl],
    event,
  } as unknown as ProvisionalDecisionRecord;
}

function reworkHandoffFor(
  context: ResolutionContext,
  bundle: readonly ReplayedProvisionalDecision[],
  bundleGeneration: number,
  downstream: readonly string[],
): ProvisionalReworkHandoff {
  const stored = bundle
    .map(
      (decision) =>
        asRecord(decision.reworkRequested?.event.reworkRequest).handoff as
          | ProvisionalReworkHandoff
          | undefined,
    )
    .filter((handoff): handoff is ProvisionalReworkHandoff => !!handoff);
  const existing = stored[0];
  // Every known downstream result stays: the stored ones, then the new ones.
  const downstreamResults = [
    ...new Set([
      ...stored.flatMap((handoff) => handoff.downstreamResults),
      ...downstream,
    ]),
  ];
  const prior = presentedBundleFor(bundle).map((entry) => ({
    decisionGeneration: entry.decisionGeneration,
    workCompletedRecordId: entry.workCompletedRecordId,
    reference: String(asRecord(entry.result).reference),
  }));
  if (existing) return { ...existing, priorResults: prior, downstreamResults };
  const seed = `${normalizeRepository(context.request.repository)}|${context.request.issueNumber}|${bundleGeneration}`;
  return {
    handoffId: `handoff-${bodySha256(`${seed}|handoff`).slice(0, 32)}`,
    authoringSetId: `set-${uuidFromSeed(`${seed}|set`)}`,
    authoringSessionId: `session-${uuidFromSeed(`${seed}|session`)}`,
    anchor: `${context.source.repository}#${context.source.issueNumber}`,
    priorResults: prior,
    downstreamResults,
  };
}

/** A JSON escape keeps an at-sign in the user's words from notifying anyone. */
function escapeMentions(jsonText: string): string {
  return jsonText.replaceAll('@', '\\u0040');
}

function answerBodyFor(answer: ProvisionalDecisionAnswer): string {
  const json = escapeMentions(JSON.stringify(answer));
  return `${ANSWER_MARKER}\n${PROVISIONAL_DECISION_ANSWER_NOTE}\n${json}`;
}

/** The candidate record an answer would back for one decision, if any. */
function recordForAnswer(
  context: ResolutionContext,
  bundle: readonly ReplayedProvisionalDecision[],
  bundleGeneration: number,
  decisionGeneration: number,
  answer: ProvisionalDecisionAnswer,
  answerUrl: string,
  answerCreatedAt: string,
): {
  readonly kind: 'append-confirmation' | 'append-rework-request';
  readonly record: ProvisionalDecisionRecord;
} | null {
  if (answer.response === 'accepted') {
    return {
      kind: 'append-confirmation',
      record: baseRecord(
        context,
        bundleGeneration,
        decisionGeneration,
        'confirmed',
        answerUrl,
        {
          type: 'confirmed',
          confirmation: {
            commentUrl: answerUrl,
            response: 'accepted',
            confirmedAt: answerCreatedAt,
          },
        },
      ),
    };
  }
  if (!answer.requestedOptionId || !answer.rationale) return null;
  return {
    kind: 'append-rework-request',
    record: baseRecord(
      context,
      bundleGeneration,
      decisionGeneration,
      'rework-requested',
      answerUrl,
      {
        type: 'rework-requested',
        reworkRequest: {
          commentUrl: answerUrl,
          requestedAt: answerCreatedAt,
          requestedOptionId: answer.requestedOptionId,
          rationale: answer.rationale,
          handoff: reworkHandoffFor(
            context,
            bundle,
            bundleGeneration,
            answer.downstreamResults ?? [],
          ),
        },
      },
    ),
  };
}

function recordComment(
  context: ResolutionContext,
  record: ProvisionalDecisionRecord,
): ProvisionalDecisionHistoryComment {
  return previewComment(context, PREVIEW_RECORD_ID, recordCommentBody(record));
}

function replayAccepts(
  replay: ProvisionalDecisionReplayResult,
  bundleGeneration: number,
  decisionGeneration: number,
  status: ReplayedProvisionalDecision['status'],
): boolean {
  return (
    replay.valid &&
    replay.decisions.find(
      (decision) =>
        decision.bundleGeneration === bundleGeneration &&
        decision.decisionGeneration === decisionGeneration,
    )?.status === status
  );
}

function readContextFailure(error: unknown): ResolutionPlan {
  return resolutionRefusal(
    'recovery-hold',
    `fresh read failed: ${errorText(error)}`,
  );
}

async function readResolutionContext(
  request: ProvisionalResolutionRequest,
  store: ProvisionalResolutionStore,
): Promise<ResolutionContext | ResolutionPlan> {
  let history: ProvisionalDecisionHistoryRead;
  let sourceRead: ProvisionalDecisionSourceIssueRead;
  let sourceState: ProvisionalDecisionSourceStateRead;
  let verifiedAt: string;
  try {
    [history, sourceRead, sourceState] = await Promise.all([
      store.readHistory(),
      store.readSourceIssue(),
      store.readSourceState(),
    ]);
    const parsedDate = parseServerDate(history.serverDate);
    if (history.complete !== true || !parsedDate) {
      return resolutionRefusal(
        'recovery-hold',
        'history is incomplete or its server Date is invalid',
      );
    }
    verifiedAt = parsedDate;
  } catch (error) {
    return readContextFailure(error);
  }
  let verifiedWork: VerifiedProvisionalWork[];
  try {
    verifiedWork = await rebuildHistoricalWork(history, store);
  } catch (error) {
    return resolutionRefusal(
      'recovery-hold',
      `historical completion verification failed: ${errorText(error)}`,
    );
  }
  const holder: {
    released?: readonly VerifiedProvisionalDecisionClaim[];
  } = {};
  const folded = resolveClaimFold(history, store, (lineage) => {
    holder.released = lineage;
  });
  if (folded && 'failure' in folded) {
    return resolutionRefusal(
      'recovery-hold',
      `claim lineage could not be verified: ${folded.failure}`,
    );
  }
  const lineage = folded?.lineage ?? holder.released;
  if (!lineage) {
    return resolutionRefusal(
      'recovery-hold',
      'claim lineage could not be verified',
    );
  }
  return {
    request,
    history,
    source: sourceFromRead(
      {
        repository: request.repository,
        issueNumber: request.issueNumber,
      } as RequestBase,
      sourceRead,
    ),
    sourceState,
    verifiedAt,
    verifiedWork,
    lineage,
    active: folded?.active ?? null,
    activeClaimAt: (index) => {
      const truncated = {
        ...history,
        comments: history.comments.slice(0, index + 1),
      };
      const result = resolveClaimFold(truncated, store);
      return result && !('failure' in result) ? result.active : null;
    },
  };
}

function evidenceCountMatches(
  context: ResolutionContext,
  evidence: readonly VerifiedProvisionalReworkRoadmap[],
): boolean {
  const ids = context.history.comments.flatMap((comment) => {
    if (comment.trustedAuthor !== true || comment.edited !== false) return [];
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    return parsed.ok && parsed.record.event.type === 'rework-authored'
      ? [parsed.record.recordId]
      : [];
  });
  return (
    evidence.length === ids.length &&
    ids.every(
      (recordId) =>
        evidence.filter((item) => item.recordId === recordId).length === 1,
    )
  );
}

function firstClaimGateFailure(
  context: ResolutionContext,
  replay: ProvisionalDecisionReplayResult,
): ResolutionPlan | null {
  const active = context.active;
  if (!active) return null;
  if (active.claimId !== context.request.claimId) {
    return resolutionRefusal(
      'fix-input',
      'a different claim is active; reconcile its release before a new resolution',
    );
  }
  if (
    active.agentId !== context.request.agentId ||
    active.branch !== context.request.branch
  ) {
    return resolutionRefusal(
      'fix-input',
      'the active claim marker names a different agent or branch than the request',
    );
  }
  if (implementationClaimIds(replay).has(active.claimId)) {
    return resolutionRefusal(
      'fix-input',
      'the active claim ran the implementation; release it and use a separate coordination claim',
    );
  }
  return null;
}

function releaseStep(
  context: ResolutionContext,
  outcome: ProvisionalResolutionOutcome,
  reason?: string,
): ResolutionPlan {
  const active = context.active;
  if (!active) return { kind: 'done', outcome, reason: reason ?? 'complete' };
  return {
    kind: 'step',
    step: {
      kind: 'release-claim',
      claim: active,
      outcome,
      ...(reason ? { reason } : {}),
    },
  };
}

function answeredUnderCoordinationClaim(
  context: ResolutionContext,
  commentIndex: number,
  answer: ProvisionalDecisionAnswer,
  implementationClaims: ReadonlySet<string>,
): boolean {
  const active = context.activeClaimAt(commentIndex);
  return (
    active !== null &&
    !implementationClaims.has(active.claimId) &&
    answer.claimIds.at(-1) === active.claimId
  );
}

function alternativeIdsOf(
  bundle: readonly ReplayedProvisionalDecision[],
  decisionGeneration: number,
): string[] {
  return (
    (bundle.find(
      (decision) => decision.decisionGeneration === decisionGeneration,
    )?.selection.event.feasibleAlternatives ?? []) as JsonRecord[]
  ).map((alternative) => String(alternative.id));
}

/** Pending reasons that are a deliberate no, an abort, or an unclear reply. */
const CONFLICTING_PENDING_REASONS: ReadonlySet<ConfirmationPendingReason> =
  new Set(['declined', 'default-no', 'eof', 'cancelled', 'unrecognized']);

interface PersistedResponse {
  readonly response: 'accepted' | 'rework';
  readonly requestedOptionId?: string;
}

/**
 * Whether a reading contradicts a persisted response. A no, abort, or unclear
 * reading contradicts it only when `pendingConflicts` is true. The up-front
 * check passes false while another targeted decision is still undecided,
 * where such a reading just keeps that decision pending; a valid persisted
 * answer that covers the undecided decision always passes true.
 */
function inputConflictsWithAnswer(
  reading: ConfirmationAnswer,
  answer: PersistedResponse,
  pendingConflicts: boolean,
): boolean {
  if (reading.kind === 'accepted') return answer.response !== 'accepted';
  if (reading.kind === 'rework') {
    return (
      answer.response !== 'rework' ||
      answer.requestedOptionId !== reading.requestedOptionId
    );
  }
  return pendingConflicts && CONFLICTING_PENDING_REASONS.has(reading.reason);
}

/** True once the user has actually said something, even a no or an abort. */
function userHasAnswered(reading: ConfirmationAnswer): boolean {
  return (
    reading.kind !== 'pending' ||
    CONFLICTING_PENDING_REASONS.has(reading.reason)
  );
}

/** What the records already say about each targeted, resolved decision. */
function persistedResponses(
  bundle: readonly ReplayedProvisionalDecision[],
  targets: readonly number[],
): PersistedResponse[] {
  return targets.flatMap((generation): PersistedResponse[] => {
    const decision = bundle.find(
      (item) => item.decisionGeneration === generation,
    );
    if (decision?.status === 'confirmed') {
      return [{ response: 'accepted' as const }];
    }
    if (
      decision?.status === 'rework-requested' ||
      decision?.status === 'rework-authored'
    ) {
      return [
        {
          response: 'rework' as const,
          requestedOptionId: String(
            asRecord(decision.reworkRequested?.event.reworkRequest)
              .requestedOptionId,
          ),
        },
      ];
    }
    return [];
  });
}

async function planResolve(
  context: ResolutionContext,
  request: ProvisionalResolveRequest,
): Promise<ResolutionPlan> {
  if (!evidenceCountMatches(context, request.verifiedReworkRoadmaps)) {
    return resolutionRefusal(
      'recovery-hold',
      'verified rework evidence is missing or duplicated',
    );
  }
  const replay = replayContext(context);
  if (!replay.valid) {
    return resolutionRefusal(
      'recovery-hold',
      `decision history replay refused: ${replay.issues[0]?.code ?? 'unknown'}`,
    );
  }
  const bundleGeneration = replay.decisions.reduce(
    (latest, decision) => Math.max(latest, decision.bundleGeneration),
    0,
  );
  const bundle = replay.decisions.filter(
    (decision) => decision.bundleGeneration === bundleGeneration,
  );
  if (bundle.length === 0) {
    return resolutionRefusal('none', 'the source has no provisional decision');
  }
  if (bundle.some((decision) => !decision.workCompleted)) {
    return resolutionRefusal(
      'none',
      'the current bundle still has decisions without verified completed work',
    );
  }
  const known = new Set(bundle.map((decision) => decision.decisionGeneration));
  const targets = [...new Set(request.decisionGenerations)];
  if (targets.length === 0 || targets.some((target) => !known.has(target))) {
    return resolutionRefusal(
      'fix-input',
      'decisionGenerations must name decisions of the current bundle',
    );
  }
  const claimFailure = firstClaimGateFailure(context, replay);
  if (claimFailure) return claimFailure;

  const statusOf = (generation: number) =>
    bundle.find((decision) => decision.decisionGeneration === generation)
      ?.status;
  const unresolved = targets
    .filter((generation) => statusOf(generation) === 'confirmation-pending')
    .sort((left, right) => left - right);

  // A persisted confirmation or rework request cannot be undone, so an
  // explicit conflicting input is refused before any write for these targets.
  const persisted = persistedResponses(bundle, targets);
  if (persisted.length > 0) {
    const reading = readConfirmationAnswer(
      request.input,
      targets.flatMap((generation) => alternativeIdsOf(bundle, generation)),
    );
    if (
      persisted.some((answer) =>
        inputConflictsWithAnswer(reading, answer, unresolved.length === 0),
      )
    ) {
      return resolutionRefusal(
        'fix-input',
        'a confirmation or rework request is already persisted for these decisions and the new input conflicts with it; resume without a new input',
      );
    }
  }

  if (unresolved.length === 0) {
    if (bundle.every((decision) => decision.status === 'confirmed')) {
      if (context.sourceState.state === 'open') {
        if (!context.active) {
          return resolutionRefusal(
            'fix-input',
            'an active coordination claim is required to close the source',
          );
        }
        return {
          kind: 'step',
          step: {
            kind: 'close-source',
            expected: {
              state: 'open',
              title: context.source.snapshot.title,
              bodySha256: context.source.snapshot.bodySha256,
              claim: context.active,
            },
          },
        };
      }
      if (context.sourceState.stateReason !== 'completed') {
        return resolutionRefusal(
          'recovery-hold',
          `the source is closed as ${context.sourceState.stateReason ?? 'an unknown reason'}, not completed; reconcile it before releasing the claim`,
        );
      }
      return releaseStep(
        context,
        'confirmed-closed',
        'bundle confirmed and source closed',
      );
    }
    // Same-source rework needs the source open for its authoring pass.
    if (
      context.sourceState.state === 'closed' &&
      bundle.some((decision) => decision.status === 'rework-requested')
    ) {
      return resolutionRefusal(
        'recovery-hold',
        `the source is closed (${context.sourceState.stateReason ?? 'an unknown reason'}) while a rework request awaits authoring; reopen it before releasing the claim`,
      );
    }
    const reworking = bundle.some(
      (decision) => decision.status === 'rework-requested',
    );
    const finished = bundle.every(
      (decision) =>
        decision.status === 'confirmed' ||
        decision.status === 'rework-authored',
    );
    if (bundle.some((decision) => decision.status === 'rework-authored')) {
      return releaseStep(
        context,
        finished
          ? 'rework-authored'
          : reworking
            ? 'rework-handoff-recorded'
            : 'pending-released',
        finished
          ? 'rework authoring is already recorded'
          : 'rework authoring is recorded for some decisions; others have no final state',
      );
    }
    return releaseStep(
      context,
      reworking ? 'rework-handoff-recorded' : 'pending-released',
      reworking
        ? 'rework handoff recorded; authoring acquisition may follow the release'
        : 'other decisions of the bundle remain pending',
    );
  }

  if (context.sourceState.state === 'closed') {
    return resolutionRefusal(
      'none',
      'the source is already closed while its bundle is unconfirmed',
    );
  }
  if (!context.active) {
    return resolutionRefusal(
      'fix-input',
      'an active coordination claim is required to resolve the source',
    );
  }
  const presentation = buildPresentation(
    bundle,
    context.source,
    bundleGeneration,
  );
  const digest = presentationSha256(presentation);
  const target = unresolved[0] as number;
  const implementationClaims = implementationClaimIds(replay);

  // An existing valid answer is durable: the first one wins. A new input may
  // agree with it or be absent, but an explicit conflicting input is refused,
  // because a confirmation cannot be undone.
  for (const comment of context.history.comments) {
    if (
      !comment.body.startsWith(ANSWER_MARKER) ||
      comment.trustedAuthor !== true ||
      comment.edited !== false ||
      !comment.authorLogin
    ) {
      continue;
    }
    const parsed = parseProvisionalDecisionAnswerComment(comment.body);
    if (
      !parsed.ok ||
      parsed.answer.presentedQuestion !== PROVISIONAL_CONFIRMATION_QUESTION ||
      // Only an answer recorded while a coordination claim was active, never
      // one the implementation session wrote or one posted between two claims.
      !answeredUnderCoordinationClaim(
        context,
        context.history.comments.indexOf(comment),
        parsed.answer,
        implementationClaims,
      )
    ) {
      continue;
    }
    const covered = unresolved.filter((generation) =>
      (
        parsed.answer.appliesToDecisionGenerations ??
        parsed.answer.decisionGenerations
      ).includes(generation),
    );
    if (
      covered.length === 0 ||
      (parsed.answer.response === 'rework' && covered.length !== 1)
    ) {
      continue;
    }
    const existingTarget = covered[0] as number;
    const candidate = recordForAnswer(
      context,
      bundle,
      bundleGeneration,
      existingTarget,
      parsed.answer,
      comment.url,
      comment.createdAt,
    );
    if (!candidate) continue;
    const preview = replayContext(context, [
      recordComment(context, candidate.record),
    ]);
    if (
      !replayAccepts(
        preview,
        bundleGeneration,
        existingTarget,
        parsed.answer.response === 'accepted'
          ? 'confirmed'
          : 'rework-requested',
      )
    ) {
      continue;
    }
    const reading = readConfirmationAnswer(
      request.input,
      alternativeIdsOf(bundle, existingTarget),
    );
    if (inputConflictsWithAnswer(reading, parsed.answer, true)) {
      return resolutionRefusal(
        'fix-input',
        'a valid answer is already persisted for this decision and the new input conflicts with it; resume without a new input',
        { presentation, presentationSha256: digest },
      );
    }
    const recordedDownstream =
      (
        asRecord(candidate.record.event.reworkRequest).handoff as
          | ProvisionalReworkHandoff
          | undefined
      )?.downstreamResults ?? [];
    const ignored = (request.downstreamResults ?? []).filter(
      (reference) => !recordedDownstream.includes(reference),
    );
    return {
      kind: 'step',
      step: { kind: candidate.kind, record: candidate.record },
      presentation,
      presentationSha256: digest,
      needsUserAnswer: false,
      ...(ignored.length > 0
        ? {
            warnings: [
              'the request named downstream results that the persisted answer or the bundle handoff does not record, or that an acceptance cannot carry; they were not added',
            ],
          }
        : {}),
    };
  }

  const answer = readConfirmationAnswer(
    request.input,
    alternativeIdsOf(bundle, target),
  );
  if (answer.kind === 'pending') {
    const released = releaseStep(
      context,
      bundle.some((decision) => decision.status === 'rework-requested')
        ? 'rework-handoff-recorded'
        : 'pending-released',
      `no further confirmation was given (${answer.reason}); the undecided decisions stay confirmation-pending`,
    );
    return released.kind === 'step'
      ? {
          ...released,
          presentation,
          presentationSha256: digest,
          needsUserAnswer: !userHasAnswered(answer),
        }
      : released;
  }
  if (request.answeredPresentationSha256 !== digest) {
    return resolutionRefusal(
      'fix-input',
      request.answeredPresentationSha256 === undefined
        ? 'answeredPresentationSha256 is required with an input'
        : 'the answer was given for a presentation that no longer matches the current bundle',
      { presentation, presentationSha256: digest },
    );
  }
  if (answer.kind === 'rework' && unresolved.length !== 1) {
    return resolutionRefusal(
      'fix-input',
      'an alternate preference applies to exactly one decision per answer',
    );
  }
  const answerRecord: ProvisionalDecisionAnswer = {
    schemaVersion: 1,
    source: context.source,
    bundleGeneration,
    decisionGenerations: bundle
      .map((decision) => decision.decisionGeneration)
      .sort((left, right) => left - right),
    claimIds: context.lineage.map((claim) => claim.claimId),
    presentedBundle: presentedBundleFor(bundle),
    response: answer.kind === 'accepted' ? 'accepted' : 'rework',
    ...(answer.kind === 'rework'
      ? {
          requestedOptionId: answer.requestedOptionId,
          rationale: answer.rationale,
          ...((request.downstreamResults ?? []).length > 0
            ? { downstreamResults: [...(request.downstreamResults ?? [])] }
            : {}),
        }
      : {}),
    appliesToDecisionGenerations: [...unresolved],
    presentedQuestion: PROVISIONAL_CONFIRMATION_QUESTION,
    answerText: answer.answerText,
  };
  const body = answerBodyFor(answerRecord);
  const virtualAnswer = previewComment(context, PREVIEW_ANSWER_ID, body);
  const candidate = recordForAnswer(
    context,
    bundle,
    bundleGeneration,
    target,
    answerRecord,
    virtualAnswer.url,
    virtualAnswer.createdAt,
  );
  const preview = candidate
    ? replayContext(context, [
        virtualAnswer,
        recordComment(context, candidate.record),
      ])
    : null;
  if (
    !candidate ||
    !preview ||
    !replayAccepts(
      preview,
      bundleGeneration,
      target,
      answer.kind === 'accepted' ? 'confirmed' : 'rework-requested',
    )
  ) {
    return resolutionRefusal(
      'fix-input',
      `the answer does not verify against the current bundle: ${preview?.issues[0]?.code ?? 'unknown'}`,
      { presentation, presentationSha256: digest },
    );
  }
  return {
    kind: 'step',
    step: { kind: 'append-answer', body },
    presentation,
    presentationSha256: digest,
    needsUserAnswer: false,
  };
}

function authoringGateFailure(
  evidence: ProvisionalReworkAuthoringEvidence,
  handoff: ProvisionalReworkHandoff,
  source: ProvisionalDecisionSource,
): string | null {
  const { owner, roadmap, children } = evidence;
  if (owner.trusted !== true || owner.fresh !== true) {
    return 'the authoring owner is not verified as trusted and fresh';
  }
  if (
    owner.setId !== handoff.authoringSetId ||
    owner.sessionId !== handoff.authoringSessionId ||
    owner.anchor.toLowerCase() !== handoff.anchor.toLowerCase()
  ) {
    return 'the authoring owner does not match the recorded handoff';
  }
  if (
    roadmap.audited !== true ||
    roadmap.issueNumber !== source.issueNumber ||
    roadmap.markerId.trim() === ''
  ) {
    return 'the source is not an audited rework roadmap';
  }
  if (
    roadmap.auditedSource?.title !== source.snapshot.title ||
    roadmap.auditedSource?.bodySha256 !== source.snapshot.bodySha256
  ) {
    return 'the source changed after the roadmap and its children were audited';
  }
  const numbers = children.map((child) => child.issueNumber);
  if (
    children.length === 0 ||
    numbers.some(
      (number) =>
        !Number.isSafeInteger(number) ||
        number < 1 ||
        number === source.issueNumber,
    ) ||
    new Set(numbers).size !== numbers.length ||
    children.some((child) => child.wired !== true)
  ) {
    return 'the rework children are not real, distinct, and wired under the roadmap';
  }
  return null;
}

/**
 * Evidence for rework-authored records this flow already wrote, derived from
 * the same caller-verified authoring facts, so a retry or a multi-decision
 * bundle does not need the caller to re-supply it.
 */
function derivedReworkEvidence(
  context: ResolutionContext,
  request: ProvisionalReworkAuthoredRequest,
): VerifiedProvisionalReworkRoadmap[] {
  const evidence = [...request.verifiedReworkRoadmaps];
  let latest: ProvisionalDecisionSource | null = null;
  for (const comment of context.history.comments) {
    if (comment.trustedAuthor !== true || comment.edited !== false) continue;
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    if (!parsed.ok) continue;
    const record = parsed.record;
    const roadmap = asRecord(record.event.reworkRoadmap);
    if (
      record.event.type === 'rework-authored' &&
      latest &&
      !evidence.some((item) => item.recordId === record.recordId) &&
      roadmap.authoringSetId === request.authoring.owner.setId &&
      roadmap.roadmapMarkerId === request.authoring.roadmap.markerId &&
      roadmap.url === request.authoring.roadmap.url
    ) {
      evidence.push({
        recordId: record.recordId,
        sourceBefore: latest,
        sourceAfter: record.source,
        roadmapIssueNumber: Number(roadmap.roadmapIssueNumber),
        roadmapMarkerId: String(roadmap.roadmapMarkerId),
        authoringSetId: String(roadmap.authoringSetId),
        url: String(roadmap.url),
        publishedCommentId: request.authoring.roadmap.publishedCommentId,
        publishedAt: request.authoring.roadmap.publishedAt,
      });
    }
    latest = record.source;
  }
  return evidence;
}

async function planReworkAuthored(
  context: ResolutionContext,
  request: ProvisionalReworkAuthoredRequest,
): Promise<ResolutionPlan> {
  if (context.active) {
    return resolutionRefusal(
      'fix-input',
      'the coordination claim is still active; reconcile its release first',
    );
  }
  const known = derivedReworkEvidence(context, request);
  if (!evidenceCountMatches(context, known)) {
    return resolutionRefusal(
      'recovery-hold',
      'verified rework evidence is missing or duplicated',
    );
  }
  // The decisions are read against the latest recorded source, because the
  // authoring pass may already have rewritten the source body.
  let latestRecorded: ProvisionalDecisionSource | null = null;
  for (const comment of context.history.comments) {
    if (comment.trustedAuthor !== true || comment.edited !== false) continue;
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    if (parsed.ok) latestRecorded = parsed.record.source;
  }
  if (!latestRecorded) {
    return resolutionRefusal('none', 'the source has no provisional decision');
  }
  const basis = replayContext(context, [], {
    currentSource: latestRecorded,
    evidence: known,
  });
  if (!basis.valid) {
    return resolutionRefusal(
      'recovery-hold',
      `decision history replay refused: ${basis.issues[0]?.code ?? 'unknown'}`,
    );
  }
  const bundleGeneration = basis.decisions.reduce(
    (latest, decision) => Math.max(latest, decision.bundleGeneration),
    0,
  );
  const bundle = basis.decisions.filter(
    (decision) => decision.bundleGeneration === bundleGeneration,
  );
  const awaiting = bundle
    .filter((decision) => decision.status === 'rework-requested')
    .sort((left, right) => left.decisionGeneration - right.decisionGeneration);
  if (awaiting.length === 0) {
    const authored = bundle.some(
      (decision) => decision.status === 'rework-authored',
    );
    const unfinished = bundle.some(
      (decision) =>
        decision.status !== 'confirmed' &&
        decision.status !== 'rework-authored',
    );
    if (authored && unfinished) {
      return resolutionRefusal(
        'none',
        'the bundle still has decisions without a final state',
      );
    }
    if (authored && replayContext(context, [], { evidence: known }).valid) {
      return {
        kind: 'done',
        outcome: 'rework-authored',
        reason: 'rework authoring is already recorded',
      };
    }
    return resolutionRefusal(
      'none',
      'no rework request is waiting for its authoring record',
    );
  }
  const target = awaiting[0] as ReplayedProvisionalDecision;
  const namesRequestingClaim = bundle.some((decision) => {
    const named = decision.reworkRequested?.claimLineage.at(-1);
    return (
      named?.claimId === request.claimId &&
      named.agentId === request.agentId &&
      named.branch === request.branch
    );
  });
  if (!namesRequestingClaim) {
    return resolutionRefusal(
      'fix-input',
      'the request does not name a coordination claim that recorded a rework request of this bundle',
    );
  }
  if (
    !bundle.some((decision) => decision.status === 'rework-authored') &&
    latestRecorded.snapshot.title === context.source.snapshot.title &&
    latestRecorded.snapshot.bodySha256 === context.source.snapshot.bodySha256
  ) {
    return resolutionRefusal(
      'fix-input',
      'the source has not been rewritten into the rework roadmap',
    );
  }
  const handoff = asRecord(target.reworkRequested?.event.reworkRequest)
    .handoff as ProvisionalReworkHandoff | undefined;
  if (!handoff) {
    return resolutionRefusal(
      'fix-input',
      'the rework request recorded no handoff identity',
    );
  }
  const gate = authoringGateFailure(request.authoring, handoff, context.source);
  if (gate) return resolutionRefusal('fix-input', gate);
  const candidate = baseRecord(
    context,
    target.bundleGeneration,
    target.decisionGeneration,
    'rework-authored',
    request.authoring.roadmap.url,
    {
      type: 'rework-authored',
      reworkRoadmap: {
        roadmapIssueNumber: request.authoring.roadmap.issueNumber,
        roadmapMarkerId: request.authoring.roadmap.markerId,
        authoringSetId: request.authoring.owner.setId,
        url: request.authoring.roadmap.url,
      },
    },
  );
  const evidence: VerifiedProvisionalReworkRoadmap = {
    recordId: candidate.recordId,
    sourceBefore: latestRecorded,
    sourceAfter: context.source,
    roadmapIssueNumber: request.authoring.roadmap.issueNumber,
    roadmapMarkerId: request.authoring.roadmap.markerId,
    authoringSetId: request.authoring.owner.setId,
    url: request.authoring.roadmap.url,
    publishedCommentId: request.authoring.roadmap.publishedCommentId,
    publishedAt: request.authoring.roadmap.publishedAt,
  };
  const preview = replayContext(context, [recordComment(context, candidate)], {
    evidence: [...known, evidence],
  });
  if (
    !replayAccepts(
      preview,
      target.bundleGeneration,
      target.decisionGeneration,
      'rework-authored',
    )
  ) {
    return resolutionRefusal(
      'fix-input',
      `the authoring evidence does not verify: ${preview.issues[0]?.code ?? 'unknown'}`,
    );
  }
  return {
    kind: 'step',
    step: { kind: 'append-rework-authored', record: candidate },
  };
}

async function planResolution(
  request: ProvisionalResolutionRequest,
  store: ProvisionalResolutionStore,
): Promise<ResolutionPlan> {
  const context = await readResolutionContext(request, store);
  if ('kind' in context) return context;
  return request.type === 'resolve'
    ? planResolve(context, request)
    : planReworkAuthored(context, request);
}

/**
 * Whether a fresh read shows the step's own content in place: a trusted,
 * unedited comment with the same answer or record content, or a source closed
 * as completed. Release steps are proven by `releaseVerified` instead.
 */
function stepLanded(step: ResolutionStep, context: ResolutionContext): boolean {
  const trusted = (comment: ProvisionalDecisionHistoryComment) =>
    comment.trustedAuthor === true && comment.edited === false;
  switch (step.kind) {
    case 'append-answer': {
      const wanted = answerStepDigest(step.body);
      return context.history.comments.some(
        (comment) =>
          trusted(comment) && answerStepDigest(comment.body) === wanted,
      );
    }
    case 'close-source':
      return (
        context.sourceState.state === 'closed' &&
        context.sourceState.stateReason === 'completed'
      );
    case 'release-claim':
      return context.active === null;
    default: {
      const wanted = recordStepDigest(step.record);
      return rawRecordMatches(
        context.history.comments,
        step.record.recordId,
      ).some((comment) => {
        const parsed = parseStoredRecord(comment);
        return (
          trusted(comment) &&
          parsed !== null &&
          recordStepDigest(parsed) === wanted
        );
      });
    }
  }
}

async function executeStep(
  step: ResolutionStep,
  store: ProvisionalResolutionStore,
): Promise<void> {
  switch (step.kind) {
    case 'append-answer':
      await store.appendAnswerBody(step.body);
      return;
    case 'close-source':
      await store.closeSourceIssue(step.expected);
      return;
    case 'release-claim':
      await store.releaseCoordinationClaim(step.claim);
      return;
    default:
      await store.appendRecordBody(
        step.record.recordId,
        escapeMentions(recordCommentBody(step.record)),
      );
  }
}

function plannedResult(
  plan: Extract<ResolutionPlan, { kind: 'step' }>,
  steps: readonly ProvisionalResolutionStepKind[],
  recordIds: readonly string[],
): ProvisionalResolutionResult {
  return {
    state: 'planned',
    nextStep: plan.step.kind,
    steps,
    recordIds,
    needsUserAnswer: plan.needsUserAnswer ?? false,
    ...(plan.presentation
      ? {
          presentation: plan.presentation,
          presentationSha256: plan.presentationSha256 as string,
        }
      : {}),
    ...(plan.warnings?.length ? { warnings: plan.warnings } : {}),
  };
}

/**
 * A backstop only: every loop turn must make visible progress (a repeated step
 * is a hold), so a valid bundle of any realistic size settles well inside it.
 */
const DEFAULT_RESOLUTION_STEP_BOUND = 1024;

export interface ProvisionalResolutionOptions {
  /** Defaults to false. Only true may write. */
  readonly apply?: boolean;
  /** The backstop on loop turns; defaults to a generous value. */
  readonly maxSteps?: number;
}

async function releaseVerified(
  request: ProvisionalResolutionRequest,
  store: ProvisionalResolutionStore,
): Promise<boolean> {
  try {
    const context = await readResolutionContext(request, store);
    if ('kind' in context) return false;
    return (
      context.active === null || context.active.claimId !== request.claimId
    );
  } catch {
    return false;
  }
}

/**
 * Resolve a confirmation-pending source, or record its rework authoring. The
 * default is read-only: it reports the next step and the presentation to ask
 * about. With `apply`, each write is preceded by a second fresh plan that must
 * name the same step, and followed by a fresh read that must show it.
 */
// audit:ignore-dead-export: no production caller until the command and GitHub store wiring lands (follow-up of roadmap #4528, not yet filed); tests lock the lifecycle until then
export async function runProvisionalResolution(
  request: ProvisionalResolutionRequest,
  store: ProvisionalResolutionStore,
  options: ProvisionalResolutionOptions = {},
): Promise<ProvisionalResolutionResult> {
  const steps: ProvisionalResolutionStepKind[] = [];
  const recordIds: string[] = [];
  const warnings: string[] = [];
  const out = (
    result: ProvisionalResolutionResult,
  ): ProvisionalResolutionResult =>
    warnings.length > 0 ? { ...result, warnings: [...warnings] } : result;
  const hold = (
    reason: string,
    extra: Partial<ProvisionalResolutionResult> = {},
  ): ProvisionalResolutionResult =>
    out({
      state: 'refused',
      action: 'recovery-hold',
      reason,
      steps,
      recordIds,
      ...extra,
    });
  let previousKey: string | null = null;
  const bound = options.maxSteps ?? DEFAULT_RESOLUTION_STEP_BOUND;
  for (let iteration = 0; iteration < bound; iteration += 1) {
    const plan = await planResolution(request, store);
    if (plan.kind === 'refused') {
      return out({ ...plan.result, steps, recordIds });
    }
    if (plan.kind === 'done') {
      return out(
        steps.length > 0
          ? {
              state: 'applied',
              outcome: plan.outcome,
              reason: plan.reason,
              steps,
              recordIds,
            }
          : {
              state: 'reconciled',
              action: 'reconcile',
              outcome: plan.outcome,
              reason: plan.reason,
              steps,
              recordIds,
            },
      );
    }
    for (const warning of plan.warnings ?? []) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    const key = stepKey(plan.step);
    if (key === previousKey) {
      return hold(
        `the ${plan.step.kind} write is not visible in a fresh read; inspect the source before retrying`,
      );
    }
    if (options.apply !== true) {
      return out(plannedResult(plan, steps, recordIds));
    }

    const again = await planResolution(request, store);
    if (again.kind !== 'step' || stepKey(again.step) !== key) {
      return hold(
        again.kind === 'refused'
          ? `the plan changed before the write; nothing was written: ${again.result.reason ?? 'refused'}`
          : 'the plan changed before the write; nothing was written',
      );
    }
    try {
      await executeStep(plan.step, store);
    } catch (error) {
      if (
        plan.step.kind === 'release-claim' &&
        !(await releaseVerified(request, store))
      ) {
        return out({
          state: 'reconciled',
          action: 'reconcile',
          reason: `release of the coordination claim is uncertain: ${errorText(error)}`,
          nextStep: 'release-claim',
          steps,
          recordIds,
        });
      }
      if (plan.step.kind === 'release-claim') {
        warnings.push(
          `the release-claim write threw (${errorText(error)}) but a fresh read shows it landed`,
        );
        steps.push('release-claim');
        return out({
          state: 'applied',
          outcome: plan.step.outcome,
          reason: plan.step.reason ?? 'complete',
          steps,
          recordIds,
        });
      }
      // Count the step only when a fresh read shows its content in place.
      const fresh = await readResolutionContext(request, store);
      if ('kind' in fresh) {
        return hold(
          `the ${plan.step.kind} write is uncertain: ${errorText(error)}; the fresh read refused: ${fresh.kind === 'refused' ? (fresh.result.reason ?? 'refused') : 'unavailable'}`,
        );
      }
      if (!stepLanded(plan.step, fresh)) {
        return hold(
          `the ${plan.step.kind} write is uncertain: ${errorText(error)}; read the history before retrying`,
        );
      }
      warnings.push(
        `the ${plan.step.kind} write threw (${errorText(error)}) but a fresh read shows it landed`,
      );
    }
    steps.push(plan.step.kind);
    if ('record' in plan.step) recordIds.push(plan.step.record.recordId);

    if (plan.step.kind === 'release-claim') {
      if (!(await releaseVerified(request, store))) {
        return out({
          state: 'reconciled',
          action: 'reconcile',
          reason:
            'the coordination claim release is not confirmed by a fresh read',
          nextStep: 'release-claim',
          steps,
          recordIds,
        });
      }
      return out({
        state: 'applied',
        outcome: plan.step.outcome,
        reason: plan.step.reason ?? 'complete',
        steps,
        recordIds,
      });
    }
    previousKey = key;
  }
  return hold('the resolution did not settle within its step bound');
}
