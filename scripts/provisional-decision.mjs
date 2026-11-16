// idd-generated-from: src/scripts/provisional-decision.mts
//
// The scripts/provisional-decision.mjs copy is generated from this source by
// `pnpm run build`. Edit this .mts, never the generated .mjs. See
// docs/typescript-sources.md.
import { createHash } from 'node:crypto';
import { loadIddConfig } from './idd-config.mjs';
import {
  parseClaimComment,
  parseForcedHandoffComment,
} from './marker-helpers.mjs';
import {
  applyClaimEvent,
  filterTrustedClaimFamilyEvents,
  isStaleAt,
  isStaleByAge,
  orderClaimEvents,
  readClaimStaleAgeMs,
  resolveActiveClaimWithForcedHandoffTrace,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';
import { buildVerifiedClaimLineage } from './provisional-claim-lineage.mjs';
import {
  PROVISIONAL_DECISION_ANSWER_MARKER,
  parseProvisionalDecisionAnswerComment,
  parseProvisionalDecisionRecordComment,
  replayProvisionalDecisionHistory,
} from './provisional-decision-state.mjs';

const RECORD_MARKER = '<!-- idd-provisional-decision-record:v1 -->';
const DEFAULT_DECISION_LABEL = 'status:needs-decision';
function refused(action, reason, recordId = null, commentUrl = '') {
  return { state: 'refused', action, reason, recordId, commentUrl };
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function parseServerDate(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().replace('.000Z', 'Z');
}
function bodySha256(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
function normalizeRepository(repository) {
  return repository.trim().toLowerCase();
}
function sourceFromRead(request, read) {
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
function normalizeLogin(login) {
  return (login ?? '').trim().toLowerCase();
}
/** The config the planner reads: the store's trusted policy when it has one. */
function plannerConfig(store) {
  return store.policy === undefined ? loadIddConfig() : store.policy;
}
function resolveClaimFold(history, store, onNoActiveClaim) {
  const config = plannerConfig(store);
  const trustedLogins = resolveTrustedMarkerActors({ config }).actors.map(
    (login) => login.trim().toLowerCase(),
  );
  const trustedLoginSet = new Set(trustedLogins);
  const isTrustedAuthor = (login) => trustedLoginSet.has(normalizeLogin(login));
  const staleAgeMs = readClaimStaleAgeMs(config);
  const isStale =
    Number.isFinite(staleAgeMs) && staleAgeMs > 0
      ? (activeCreatedAt, nextCreatedAt) =>
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
  let trace;
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
  const lineage = [];
  const seenClaimIds = new Set();
  let active = null;
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
  const sameClaim = (left, right) =>
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
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function commentUrlKey(value) {
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
function contentComparable(record) {
  const copy = structuredClone(record);
  const mutable = copy;
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
function sameContent(left, right) {
  return (
    stableJson(contentComparable(left)) === stableJson(contentComparable(right))
  );
}
function extractRecordId(body) {
  if (!body.startsWith(RECORD_MARKER)) return null;
  let payload = body.slice(RECORD_MARKER.length);
  if (payload.startsWith('\r\n')) payload = payload.slice(2);
  else if (payload.startsWith('\n')) payload = payload.slice(1);
  else return null;
  try {
    const value = JSON.parse(payload);
    return typeof value?.recordId === 'string' ? value.recordId : null;
  } catch {
    return null;
  }
}
function recordCommentBody(record) {
  return `${RECORD_MARKER}\n${JSON.stringify(record)}`;
}
function recordIdFor(
  repository,
  issueNumber,
  bundleGeneration,
  decisionGeneration,
  eventType,
) {
  const input = `${normalizeRepository(repository)}|${issueNumber}|${bundleGeneration}|${decisionGeneration}|${eventType}`;
  return `prov-${createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32)}`;
}
function questionFromBody(body) {
  const lines = body.split(/\r?\n/u);
  const decisionHeadings = [];
  const sectionHeadings = [];
  let fence = null;
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
  const questions = [];
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
function bundleState(decisions, generation) {
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
function decisionForEvidence(replay, evidenceUrl) {
  return replay.decisions.filter((decision) =>
    decision.selection.evidenceReferences.some(
      (reference) => commentUrlKey(reference) === commentUrlKey(evidenceUrl),
    ),
  );
}
function baselineMatches(baseline, source) {
  return (
    baseline.title === source.snapshot.title &&
    baseline.bodySha256 === source.snapshot.bodySha256
  );
}
function chooseLabelName(store) {
  const config = plannerConfig(store);
  const labels = config?.labels;
  if (
    labels &&
    typeof labels === 'object' &&
    typeof labels.needsDecisionLabelName === 'string' &&
    labels.needsDecisionLabelName.trim()
  ) {
    return labels.needsDecisionLabelName.trim();
  }
  return DEFAULT_DECISION_LABEL;
}
function toClaimLineage(lineage) {
  return lineage.map(({ claimId, agentId, branch, claimedAt, supersedes }) => ({
    claimId,
    agentId,
    branch,
    claimedAt,
    ...(supersedes ? { supersedes } : {}),
  }));
}
function historicalWorkFromRecord(record) {
  if (record.event.type !== 'work-completed') return null;
  const result = record.event.result;
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
async function rebuildHistoricalWork(history, store) {
  const work = [];
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
    const completion = parsed.record.event.result;
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
  candidateRecord,
  lineage,
  verifiedAt,
  locatedDecision,
  history,
  baseline,
  existingRecord,
  pullRequest,
) {
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
  request,
  active,
  source,
  replayed,
  verifiedAt,
  history,
  pullRequest,
) {
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
  request,
  source,
  lineage,
  evidenceUrl,
  bundleGeneration,
  decisionGeneration,
  verifiedAt,
  question,
  planComment,
  pullRequest,
) {
  const event = { type: request.type };
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
  };
  const parsed = parseProvisionalDecisionRecordComment(
    recordCommentBody(record),
  );
  return {
    record,
    parseIssues: parsed.ok ? [] : parsed.issues.map((issue) => issue.code),
  };
}
function rawRecordMatches(comments, recordId) {
  return comments.filter(
    (comment) => extractRecordId(comment.body) === recordId,
  );
}
function parseStoredRecord(comment) {
  const result = parseProvisionalDecisionRecordComment(comment.body);
  return result.ok ? result.record : null;
}
function createPlan(
  candidate,
  folded,
  verifiedAt,
  located,
  statusBundle,
  history,
  baseline,
  existing,
  pullRequest,
) {
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
async function planProvisionalDecisionCommand(request, store) {
  if (request.type === 'work-completed' && !request.pullRequestUrl) {
    return refused('fix-input', 'pullRequestUrl is required before reads');
  }
  let history;
  let sourceRead;
  let pullRequest = null;
  let verifiedAt;
  try {
    [history, sourceRead] = await Promise.all([
      store.readHistory(),
      store.readSourceIssue(),
    ]);
    if (request.type === 'work-completed') {
      pullRequest = await store.readPullRequest(request.pullRequestUrl);
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
  let verifiedWork;
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
  const locatedStatus = located ? latestBundleState : null;
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
  let existingPlan = null;
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
          ? storedRecord.event.result.verifiedAt
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
function expectedStatus(request) {
  switch (request.type) {
    case 'selected':
      return 'selected';
    case 'work-started':
      return 'in-progress';
    case 'work-completed':
      return 'confirmation-pending';
  }
}
function sameLineage(left, right) {
  return stableJson(left) === stableJson(right);
}
function stepEightPlanChanged(before, after) {
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
  result,
  reason,
  recordId = result.recordId,
  commentUrl = result.commentUrl,
) {
  return refused('recovery-hold', reason, recordId, commentUrl);
}
function verifyStoredAppend(
  request,
  expected,
  expectedDecision,
  stored,
  result,
) {
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
async function applyCompletionLabel(request, store, planned) {
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
  let finalRead;
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
  request,
  store,
  options = {},
) {
  const initial = await planProvisionalDecisionCommand(request, store);
  if (options.apply !== true || initial.state !== 'planned') return initial;
  const initialPlan = initial.plan;
  let stepEight;
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
  let append;
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
  let readBack;
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
const TERMINAL_REWORK_PATTERN = /^option\s+(\S+)\s+(\S.*)$/iu;
function pending(reason) {
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
// audit:ignore-dead-export: the CLI and GitHub store wiring is the follow-up of issue #4536; tests lock the input rules until then
export function readConfirmationAnswer(input, alternativeIds) {
  if (!input || input.channel === 'none') return pending('no-input');
  if (input.channel === 'timeout') return pending('timeout');
  if (input.origin !== 'user') return pending('input-not-from-user');
  if (input.channel === 'conversation') {
    const message = input.message.trim();
    if (message === '') return pending('no-input');
    const reading = input.interpretation;
    if (reading.response === 'accepted') {
      return { kind: 'accepted', channel: 'conversation', answerText: message };
    }
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
    return { kind: 'accepted', channel: 'terminal', answerText: text };
  }
  if (/^(?:n|no)$/iu.test(text)) return pending('declined');
  const rework = TERMINAL_REWORK_PATTERN.exec(text);
  if (rework?.[1] && rework[2] && alternativeIds.includes(rework[1])) {
    return {
      kind: 'rework',
      channel: 'terminal',
      answerText: text,
      requestedOptionId: rework[1],
      rationale: rework[2].trim(),
    };
  }
  return pending('unrecognized');
}
const ANSWER_MARKER = PROVISIONAL_DECISION_ANSWER_MARKER;
const PREVIEW_ANSWER_ID = '900000000000001';
const PREVIEW_RECORD_ID = '900000000000002';
function resolutionRefusal(action, reason, extra = {}) {
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
function stepKey(step) {
  switch (step.kind) {
    case 'append-answer':
      return `answer:${bodySha256(step.body)}`;
    case 'close-source':
      return 'close';
    case 'release-claim':
      return `release:${step.claim.claimId}`;
    default:
      return `record:${step.record.recordId}`;
  }
}
function presentationSha256(presentation) {
  return bodySha256(stableJson(presentation));
}
function uuidFromSeed(seed) {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function asRecord(value) {
  return value ?? {};
}
function buildPresentation(decisions, source, bundleGeneration) {
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
      const alternatives = selection.feasibleAlternatives ?? [];
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
function presentedBundleFor(decisions) {
  return [...decisions]
    .sort((left, right) => left.decisionGeneration - right.decisionGeneration)
    .map((decision) => {
      const selection = decision.selection.event;
      return {
        decisionGeneration: decision.decisionGeneration,
        question: String(selection.question),
        selectedOptionId: String(asRecord(selection.selectedOption).id),
        feasibleAlternativeIds: (selection.feasibleAlternatives ?? [])
          .map((alternative) => String(alternative.id))
          .sort(),
        workCompletedRecordId: decision.workCompleted?.recordId ?? '',
        result: asRecord(decision.workCompleted?.event.result),
      };
    });
}
function replayContext(context, extra = [], options = {}) {
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
function previewComment(context, id, body) {
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
function implementationClaimIds(replay) {
  const ids = new Set();
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
  context,
  bundleGeneration,
  decisionGeneration,
  eventType,
  answerUrl,
  event,
) {
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
  };
}
function reworkHandoffFor(context, bundle, bundleGeneration, downstream) {
  const existing = bundle
    .map(
      (decision) =>
        asRecord(decision.reworkRequested?.event.reworkRequest).handoff,
    )
    .find((handoff) => handoff !== undefined);
  const prior = presentedBundleFor(bundle).map((entry) => ({
    decisionGeneration: entry.decisionGeneration,
    workCompletedRecordId: entry.workCompletedRecordId,
    reference: String(asRecord(entry.result).reference),
  }));
  if (existing) return { ...existing, priorResults: prior };
  const seed = `${normalizeRepository(context.request.repository)}|${context.request.issueNumber}|${bundleGeneration}`;
  return {
    handoffId: `handoff-${bodySha256(`${seed}|handoff`).slice(0, 32)}`,
    authoringSetId: `set-${uuidFromSeed(`${seed}|set`)}`,
    authoringSessionId: `session-${uuidFromSeed(`${seed}|session`)}`,
    anchor: `${context.source.repository}#${context.source.issueNumber}`,
    priorResults: prior,
    downstreamResults: [...downstream],
  };
}
function answerBodyFor(answer) {
  return `${ANSWER_MARKER}\n${JSON.stringify(answer)}`;
}
/** The candidate record an answer would back for one decision, if any. */
function recordForAnswer(
  context,
  bundle,
  bundleGeneration,
  decisionGeneration,
  answer,
  answerUrl,
  answerCreatedAt,
  downstream,
) {
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
            downstream,
          ),
        },
      },
    ),
  };
}
function recordComment(context, record) {
  return previewComment(context, PREVIEW_RECORD_ID, recordCommentBody(record));
}
function replayAccepts(replay, bundleGeneration, decisionGeneration, status) {
  return (
    replay.valid &&
    replay.decisions.find(
      (decision) =>
        decision.bundleGeneration === bundleGeneration &&
        decision.decisionGeneration === decisionGeneration,
    )?.status === status
  );
}
function readContextFailure(error) {
  return resolutionRefusal(
    'recovery-hold',
    `fresh read failed: ${errorText(error)}`,
  );
}
async function readResolutionContext(request, store) {
  let history;
  let sourceRead;
  let sourceState;
  let verifiedAt;
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
  let verifiedWork;
  try {
    verifiedWork = await rebuildHistoricalWork(history, store);
  } catch (error) {
    return resolutionRefusal(
      'recovery-hold',
      `historical completion verification failed: ${errorText(error)}`,
    );
  }
  const holder = {};
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
      },
      sourceRead,
    ),
    sourceState,
    verifiedAt,
    verifiedWork,
    lineage,
    active: folded?.active ?? null,
  };
}
function evidenceCountMatches(context, evidence) {
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
function firstClaimGateFailure(context, replay) {
  const active = context.active;
  if (!active) return null;
  if (active.claimId !== context.request.claimId) {
    return resolutionRefusal(
      'fix-input',
      'a different claim is active; reconcile its release before a new resolution',
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
function releaseStep(context, outcome, reason) {
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
async function planResolve(context, request) {
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
  const statusOf = (generation) =>
    bundle.find((decision) => decision.decisionGeneration === generation)
      ?.status;
  const unresolved = targets
    .filter((generation) => statusOf(generation) === 'confirmation-pending')
    .sort((left, right) => left - right);
  if (unresolved.length === 0) {
    if (bundle.every((decision) => decision.status === 'confirmed')) {
      if (context.sourceState.state === 'open') {
        if (!context.active) {
          return resolutionRefusal(
            'fix-input',
            'an active coordination claim is required to close the source',
          );
        }
        return { kind: 'step', step: { kind: 'close-source' } };
      }
      return releaseStep(
        context,
        'confirmed-closed',
        'bundle confirmed and source closed',
      );
    }
    if (bundle.some((decision) => decision.status === 'rework-authored')) {
      return resolutionRefusal('none', 'rework authoring is already recorded');
    }
    const reworking = bundle.some(
      (decision) => decision.status === 'rework-requested',
    );
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
  const target = unresolved[0];
  const downstream = request.downstreamResults ?? [];
  // An existing valid answer is durable: the first one wins, with no prompt.
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
    if (!parsed.ok) continue;
    if (parsed.answer.response === 'rework' && unresolved.length !== 1)
      continue;
    const candidate = recordForAnswer(
      context,
      bundle,
      bundleGeneration,
      target,
      parsed.answer,
      comment.url,
      comment.createdAt,
      downstream,
    );
    if (!candidate) continue;
    const preview = replayContext(context, [
      recordComment(context, candidate.record),
    ]);
    if (
      replayAccepts(
        preview,
        bundleGeneration,
        target,
        parsed.answer.response === 'accepted'
          ? 'confirmed'
          : 'rework-requested',
      )
    ) {
      return {
        kind: 'step',
        step: { kind: candidate.kind, record: candidate.record },
        presentation,
        presentationSha256: digest,
      };
    }
  }
  const alternativeIds = (
    bundle.find((decision) => decision.decisionGeneration === target)?.selection
      .event.feasibleAlternatives ?? []
  ).map((alternative) => String(alternative.id));
  const answer = readConfirmationAnswer(request.input, alternativeIds);
  if (answer.kind === 'pending') {
    const released = releaseStep(
      context,
      'pending-released',
      `no confirmation was given (${answer.reason}); the source stays confirmation-pending`,
    );
    return released.kind === 'step'
      ? { ...released, presentation, presentationSha256: digest }
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
  const answerRecord = {
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
    downstream,
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
  };
}
function authoringGateFailure(evidence, handoff, source) {
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
function derivedReworkEvidence(context, request) {
  const evidence = [...request.verifiedReworkRoadmaps];
  let latest = null;
  for (const comment of context.history.comments) {
    if (comment.trustedAuthor !== true || comment.edited !== false) continue;
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    if (!parsed.ok) continue;
    const record = parsed.record;
    if (
      record.event.type === 'rework-authored' &&
      latest &&
      !evidence.some((item) => item.recordId === record.recordId)
    ) {
      const roadmap = asRecord(record.event.reworkRoadmap);
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
async function planReworkAuthored(context, request) {
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
  let latestRecorded = null;
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
  const target = awaiting[0];
  const handoff = asRecord(target.reworkRequested?.event.reworkRequest).handoff;
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
  const evidence = {
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
async function planResolution(request, store) {
  const context = await readResolutionContext(request, store);
  if ('kind' in context) return context;
  return request.type === 'resolve'
    ? planResolve(context, request)
    : planReworkAuthored(context, request);
}
async function executeStep(step, store) {
  switch (step.kind) {
    case 'append-answer':
      await store.appendAnswerBody(step.body);
      return;
    case 'close-source':
      await store.closeSourceIssue();
      return;
    case 'release-claim':
      await store.releaseCoordinationClaim(step.claim);
      return;
    default:
      await store.appendRecordBody(
        step.record.recordId,
        recordCommentBody(step.record),
      );
  }
}
function plannedResult(plan, steps, recordIds) {
  return {
    state: 'planned',
    nextStep: plan.step.kind,
    steps,
    recordIds,
    ...(plan.presentation
      ? {
          presentation: plan.presentation,
          presentationSha256: plan.presentationSha256,
        }
      : {}),
  };
}
async function releaseVerified(request, store) {
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
// audit:ignore-dead-export: the CLI and GitHub store wiring is the follow-up of issue #4536; tests lock the lifecycle until then
export async function runProvisionalResolution(request, store, options = {}) {
  const steps = [];
  const recordIds = [];
  const hold = (reason, extra = {}) => ({
    state: 'refused',
    action: 'recovery-hold',
    reason,
    steps,
    recordIds,
    ...extra,
  });
  let previousKey = null;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const plan = await planResolution(request, store);
    if (plan.kind === 'refused') {
      return { ...plan.result, steps, recordIds };
    }
    if (plan.kind === 'done') {
      return steps.length > 0
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
          };
    }
    const key = stepKey(plan.step);
    if (key === previousKey) {
      return hold(
        `the ${plan.step.kind} write is not visible in a fresh read; inspect the source before retrying`,
      );
    }
    if (options.apply !== true) return plannedResult(plan, steps, recordIds);
    const again = await planResolution(request, store);
    if (again.kind !== 'step' || stepKey(again.step) !== key) {
      return hold('the plan changed before the write; nothing was written');
    }
    try {
      await executeStep(plan.step, store);
    } catch (error) {
      if (plan.step.kind === 'release-claim') {
        return {
          state: 'reconciled',
          action: 'reconcile',
          reason: `release of the coordination claim is uncertain: ${errorText(error)}`,
          steps,
          recordIds,
        };
      }
      const after = await planResolution(request, store);
      if (after.kind === 'step' && stepKey(after.step) === key) {
        return hold(
          `the ${plan.step.kind} write is uncertain: ${errorText(error)}; read the history before retrying`,
        );
      }
    }
    steps.push(plan.step.kind);
    if ('record' in plan.step) recordIds.push(plan.step.record.recordId);
    if (plan.step.kind === 'release-claim') {
      if (!(await releaseVerified(request, store))) {
        return {
          state: 'reconciled',
          action: 'reconcile',
          reason:
            'the coordination claim release is not confirmed by a fresh read',
          steps,
          recordIds,
        };
      }
      return {
        state: 'applied',
        outcome: plan.step.outcome,
        reason: plan.step.reason ?? 'complete',
        steps,
        recordIds,
      };
    }
    previousKey = key;
  }
  return hold('the resolution did not settle within its step bound');
}
