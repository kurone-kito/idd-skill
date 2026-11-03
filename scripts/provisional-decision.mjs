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
function resolveClaimFold(history) {
  const config = loadIddConfig();
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
    lastEditedAt: comment.edited ? comment.createdAt : null,
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
      comment.trustedAuthor &&
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
      lastEditedAt: comment.edited ? comment.createdAt : null,
      trustedAuthor: comment.trustedAuthor,
    })),
    completeHistory: history.complete,
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
  if (!trace.activeClaim) return null;
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
function contentComparable(record) {
  const copy = structuredClone(record);
  const mutable = copy;
  delete mutable.claimLineage;
  if (mutable.source?.repository) {
    mutable.source.repository = normalizeRepository(mutable.source.repository);
  }
  if (mutable.source?.snapshot) delete mutable.source.snapshot.updatedAt;
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
    decision.selection.evidenceReferences.includes(evidenceUrl),
  );
}
function baselineMatches(baseline, source) {
  return (
    baseline.title === source.snapshot.title &&
    baseline.bodySha256 === source.snapshot.bodySha256
  );
}
function chooseLabelName() {
  const config = loadIddConfig();
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
    if (!comment.trustedAuthor || comment.edited || !comment.authorLogin)
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
  if (!request.policyTrusted)
    return 'trusted dangerouslyAutoDecide policy is not enabled';
  if (!request.optionComparisonValid)
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
      (comment) => comment.url === request.planCommentUrl,
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
    if (!request.executionCriteriaSatisfied)
      return 'execution criteria are not satisfied';
    if (pullRequest?.state !== 'merged' || !pullRequest.requiredChecksPassing) {
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
/** Read-only steps 0 through 7 of the provisional-decision write protocol. */
// audit:ignore-dead-export: consumed by the command child #4799
export async function runProvisionalDecisionCommand(request, store) {
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
    if (!history.complete || !parsedDate) {
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
  const folded = resolveClaimFold(history);
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
    if (!comment.trustedAuthor || comment.edited) return [];
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
    comments: history.comments,
    completeHistory: history.complete,
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
    (comment) => comment.url === evidenceUrl,
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
          (comment) => comment.url === request.planCommentUrl,
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
      !pullRequest.requiredChecksPassing
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
    if (!sameIdComment.trustedAuthor || sameIdComment.edited) {
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
    const earlyGateFailure = !request.policyTrusted
      ? 'trusted dangerouslyAutoDecide policy is not enabled'
      : !request.optionComparisonValid
        ? 'option comparison has not been validated'
        : request.worktreeBranch !== folded.active.branch
          ? 'worktree branch does not match the active claim'
          : request.claimId !== folded.active.claimId
            ? 'a different claim is active'
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
      const label = await store.applyOrReadDecisionLabel({
        labelName: chooseLabelName(),
        apply: false,
      });
      existingPlan = {
        commentId: sameIdComment.id,
        commentUrl: sameIdComment.url,
        labelPresent: label.present,
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
      if (request.type === 'work-completed' && !label.present) {
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
