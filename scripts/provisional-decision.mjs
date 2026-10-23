#!/usr/bin/env node
// idd-generated-from: src/scripts/provisional-decision.mts
//
// The scripts/provisional-decision.mjs copy is generated from this source by
// `pnpm run build`. Edit this .mts file, never the generated copy.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mjs';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mjs';
import { ghApiJson, ghText, readGithubRepoDefaultBranch } from './gh-exec.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import {
  fetchEncodedPolicySchemaAtTrustedRef,
  loadTrustedIddConfig,
  readTrustedDangerouslyAutoDecide,
  selectTrustedConfigRef,
} from './idd-config.mjs';
import { operationalMarkerPrefix } from './marker-helpers.mjs';
import {
  normalizePolicyConfig,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mjs';
import {
  filterTrustedClaimFamilyEvents,
  parseClaimComment,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';
import {
  PROVISIONAL_DECISION_RECORD_MARKER,
  parseProvisionalDecisionRecordComment,
  replayProvisionalDecisionHistory,
} from './provisional-decision-state.mjs';

const FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--action': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--nonce': { type: 'string' },
  '--input': { type: 'string' },
  '--bundle-generation': { type: 'string' },
  '--decision-generation': { type: 'string' },
  '--pull-request': { type: 'string' },
  '--expected-head-sha': { type: 'string' },
  '--apply': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
};
const USAGE = `Usage: idd-provisional-decision --issue <n> --action <select|start|complete> --claim-id <id> --agent-id <id> --nonce <token> [options]

Dry-run is the default. Pass --apply to persist one append-only transition.
Read --input as JSON: select takes question/option comparison/criteria;
start takes planReference; complete takes criteriaEvidence. Start and complete
also require --bundle-generation and --decision-generation. Complete requires
--pull-request unless it is reconciling an existing completion record.
`;
function isoNow(deps) {
  const value = deps.now();
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error('clock returned an invalid timestamp');
  }
  return new Date(value).toISOString();
}
function sourceFor(item, repository) {
  const title = item.title.trim();
  const body = item.body ?? '';
  const updatedAt = String(item.updatedAt ?? '');
  if (!title || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error('issue source snapshot is incomplete');
  }
  return {
    repository,
    issueNumber: item.number,
    snapshot: {
      title,
      bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      updatedAt: new Date(updatedAt).toISOString(),
    },
  };
}
function normalizedLogin(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
export function resolveTrustedProvisionalDecisionCollaboratorMarkerLogins(
  comments,
  enabled,
  getPermission,
  additionalLogins = [],
) {
  if (!enabled) return [];
  const markerAuthors = [
    ...new Set(
      [
        ...comments
          .filter(
            (comment) =>
              operationalMarkerPrefix(comment.body) !== null ||
              comment.body.startsWith(PROVISIONAL_DECISION_RECORD_MARKER),
          )
          .map((comment) => normalizedLogin(comment.authorLogin)),
        ...additionalLogins.map(normalizedLogin),
      ].filter(Boolean),
    ),
  ];
  return markerAuthors.filter((login) => {
    try {
      const result = getPermission(login);
      if (result.outcome !== 'found') return false;
      const permission = result.permission.toLowerCase();
      const roleName = result.roleName.toLowerCase();
      return (
        ['admin', 'maintain', 'write'].includes(permission) ||
        ['admin', 'maintain', 'write'].includes(roleName)
      );
    } catch {
      return false;
    }
  });
}
function commentUrl(issueUrl, id) {
  return `${issueUrl}#issuecomment-${id}`;
}
function pendingOperationDirectory(owner, repo, issueNumber) {
  const pathApi = process.platform === 'win32' ? win32 : posix;
  const configuredRoot =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA?.trim()
      : process.env.XDG_STATE_HOME?.trim();
  const usableRoot =
    configuredRoot &&
    pathApi.isAbsolute(configuredRoot) &&
    (process.platform === 'win32' || !configuredRoot.startsWith('//'))
      ? configuredRoot
      : process.platform === 'win32'
        ? pathApi.join(homedir(), 'AppData', 'Local')
        : pathApi.join(homedir(), '.local', 'state');
  const scope = createHash('sha256')
    .update(`${owner.toLowerCase()}/${repo.toLowerCase()}#${issueNumber}`)
    .digest('hex');
  return pathApi.join(
    usableRoot,
    'idd-skill',
    'provisional-decision-operations',
    scope,
  );
}
function pendingOperationPath(deps, issueNumber, recordId) {
  if (!/^pd1-[0-9a-f]{64}$/u.test(recordId)) {
    throw new Error('pending operation has an invalid record ID');
  }
  return join(
    pendingOperationDirectory(deps.owner, deps.repo, issueNumber),
    `${recordId}.json`,
  );
}
function sameSourceIdentity(left, right) {
  return (
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.issueNumber === right.issueNumber &&
    left.snapshot.bodySha256 === right.snapshot.bodySha256
  );
}
function readPendingOperation(deps, issueNumber, recordId) {
  if (!/^pd1-[0-9a-f]{64}$/u.test(recordId)) {
    return { status: 'none' };
  }
  let path;
  try {
    path = pendingOperationPath(deps, issueNumber, recordId);
  } catch (error) {
    return {
      status: 'unreadable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'none' };
    }
    return {
      status: 'unreadable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const value = JSON.parse(source);
    if (
      value.schemaVersion !== 1 ||
      value.recordId !== recordId ||
      typeof value.body !== 'string'
    ) {
      throw new Error('pending operation file has an invalid envelope');
    }
    const parsed = parseProvisionalDecisionRecordComment(value.body);
    if (!parsed.ok || parsed.record.recordId !== recordId) {
      throw new Error('pending operation file has an invalid record body');
    }
    let attempted = false;
    try {
      readFileSync(`${path}.attempted`, 'utf8');
      attempted = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return {
      status: 'found',
      operation: {
        body: value.body,
        record: parsed.record,
        attempted,
        path,
      },
    };
  } catch (error) {
    return {
      status: 'unreadable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
function preparePendingOperation(deps, issueNumber, recordId, body) {
  const existing = readPendingOperation(deps, issueNumber, recordId);
  if (existing.status === 'unreadable') {
    return { ok: false, error: existing.error };
  }
  if (existing.status === 'found') {
    return { ok: true, operation: existing.operation };
  }
  try {
    const path = pendingOperationPath(deps, issueNumber, recordId);
    mkdirSync(pendingOperationDirectory(deps.owner, deps.repo, issueNumber), {
      recursive: true,
      mode: 0o700,
    });
    const contents = JSON.stringify({ schemaVersion: 1, recordId, body });
    try {
      writeFileSync(path, contents, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const raced = readPendingOperation(deps, issueNumber, recordId);
      if (raced.status === 'found') {
        return { ok: true, operation: raced.operation };
      }
      return {
        ok: false,
        error:
          raced.status === 'unreadable'
            ? raced.error
            : 'pending operation disappeared during preparation',
      };
    }
    const parsed = parseProvisionalDecisionRecordComment(body);
    if (!parsed.ok) {
      return { ok: false, error: 'prepared operation body is invalid' };
    }
    return {
      ok: true,
      operation: { body, record: parsed.record, attempted: false, path },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
function markPendingOperationAttempted(operation) {
  try {
    writeFileSync(
      `${operation.path}.attempted`,
      `${operation.record.recordId}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}
function clearPendingOperation(deps, issueNumber, recordId) {
  try {
    const path = pendingOperationPath(deps, issueNumber, recordId);
    rmSync(path, { force: true });
    rmSync(`${path}.attempted`, { force: true });
  } catch {
    // The verified remote record remains authoritative if local cleanup fails.
  }
}
function pendingOperationReport(input, state, label, target, message) {
  return makeReport(
    input,
    'partial',
    state.replay.status,
    target,
    [
      {
        name: 'uncertain-operation-reconciliation',
        passed: false,
        detail: message,
      },
    ],
    label,
    labelsContain(state.item.labels, label),
    false,
    false,
    'Reread the complete issue history and reconcile this operation. Do not post a new transition while its outcome is unresolved.',
  );
}
function buildFreshState(issueNumber, deps, options = {}) {
  const item = deps.getWorkItem(issueNumber);
  if (!item) throw new Error(`issue #${issueNumber} was not found`);
  if (
    item.number !== issueNumber ||
    (item.state !== 'OPEN' && !(options.allowClosed && item.state === 'CLOSED'))
  ) {
    throw new Error(
      options.allowClosed
        ? `issue #${issueNumber} is neither open nor closed`
        : `issue #${issueNumber} is not open`,
    );
  }
  const issueUrl =
    item.htmlUrl ||
    `https://github.com/${deps.owner}/${deps.repo}/issues/${issueNumber}`;
  const source = sourceFor(item, `${deps.owner}/${deps.repo}`);
  const rawComments = deps.listComments(issueNumber);
  const comments = rawComments.map((entry) => {
    if (entry.lastEditedAt === undefined) {
      throw new Error(
        `comment #${entry.id} has no resolved lastEditedAt state`,
      );
    }
    if (!Number.isFinite(Date.parse(entry.createdAt))) {
      throw new Error(`comment #${entry.id} has an invalid createdAt`);
    }
    const authorLogin = entry.authorLogin || null;
    return {
      id: String(entry.id),
      url: commentUrl(issueUrl, String(entry.id)),
      body: entry.body,
      authorLogin,
      createdAt: new Date(entry.createdAt).toISOString(),
      edited: entry.lastEditedAt !== null,
      trustedAuthor: false,
    };
  });
  const viewerLogin = normalizedLogin(deps.viewerLogin());
  const authority = deps.readAuthority(issueNumber, rawComments, viewerLogin);
  if (authority.status === 'unreadable') {
    throw new Error(
      authority.error || 'trusted repository policy is unreadable',
    );
  }
  const actors = new Set(authority.trustedMarkerActors.map(normalizedLogin));
  const trustedComments = comments.map((comment) => ({
    ...comment,
    trustedAuthor: Boolean(
      comment.authorLogin && actors.has(normalizedLogin(comment.authorLogin)),
    ),
  }));
  const claimEvents = filterTrustedClaimFamilyEvents(
    rawComments.map((entry) => ({
      id: String(entry.id),
      body: entry.body,
      createdAt: entry.createdAt,
      author: { login: entry.authorLogin },
      lastEditedAt: entry.lastEditedAt,
    })),
    (login) => actors.has(normalizedLogin(login)),
  );
  const claims = [];
  for (const event of claimEvents) {
    const claim = parseClaimComment(event.body ?? '', event.createdAt ?? '');
    if (!claim) continue;
    if (event.id === undefined || event.id === null) {
      throw new Error('trusted claim marker has no comment ID');
    }
    claims.push({
      claimId: claim.claimId,
      agentId: claim.agentId,
      branch: claim.branch,
      claimedAt: new Date(claim.createdAt).toISOString(),
      ...(claim.supersedes === 'none' ? {} : { supersedes: claim.supersedes }),
      commentId: String(event.id),
    });
  }
  const records = [];
  for (const comment of trustedComments) {
    if (!comment.body.startsWith(PROVISIONAL_DECISION_RECORD_MARKER)) continue;
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    if (parsed.ok) records.push({ record: parsed.record, comment });
  }
  const verifiedWork = verifyHistoricalCompletions(records, source, deps);
  const replay = replayProvisionalDecisionHistory({
    comments: trustedComments,
    completeHistory: true,
    currentSource: source,
    verifiedClaimLineage: claims,
    verifiedWork,
    verifiedReworkRoadmaps: [],
  });
  return {
    item,
    source,
    comments: trustedComments,
    verifiedClaimLineage: claims,
    records,
    replay,
    authority,
    viewerLogin,
    issueUrl,
  };
}
function recordById(records, recordId) {
  return records.filter(({ record }) => record.recordId === recordId);
}
function isTerminal(status) {
  return status === 'confirmed' || status === 'rework-authored';
}
function nextSelectionGeneration(replay) {
  if (replay.decisions.length === 0) {
    return { bundleGeneration: 1, decisionGeneration: 1 };
  }
  const latestBundle = Math.max(
    ...replay.decisions.map((decision) => decision.bundleGeneration),
  );
  const bundleDecisions = replay.decisions.filter(
    (decision) => decision.bundleGeneration === latestBundle,
  );
  if (
    bundleDecisions.some((decision) => decision.status === 'rework-requested')
  ) {
    throw new Error('the current decision bundle is awaiting rework authoring');
  }
  if (bundleDecisions.every((decision) => isTerminal(decision.status))) {
    return { bundleGeneration: latestBundle + 1, decisionGeneration: 1 };
  }
  if (bundleDecisions.some((decision) => isTerminal(decision.status))) {
    throw new Error(
      'the current decision bundle has mixed terminal and open decisions',
    );
  }
  return {
    bundleGeneration: latestBundle,
    decisionGeneration:
      Math.max(
        ...bundleDecisions.map((decision) => decision.decisionGeneration),
      ) + 1,
  };
}
function stableRecordId(
  source,
  bundleGeneration,
  decisionGeneration,
  eventType,
) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        source.repository.toLowerCase(),
        source.issueNumber,
        source.snapshot.bodySha256,
        bundleGeneration,
        decisionGeneration,
        eventType,
      ]),
      'utf8',
    )
    .digest('hex');
  return `pd1-${digest}`;
}
function buildRecord(
  state,
  lineage,
  bundleGeneration,
  decisionGeneration,
  event,
  evidenceReferences,
) {
  const id = stableRecordId(
    state.source,
    bundleGeneration,
    decisionGeneration,
    String(event.type ?? ''),
  );
  return {
    schemaVersion: 1,
    recordId: id,
    source: state.source,
    bundleGeneration,
    decisionGeneration,
    claimLineage: lineage.map(({ commentId: _commentId, ...claim }) => claim),
    evidenceReferences: [...evidenceReferences],
    event: event,
  };
}
function serializedRecord(record) {
  const body = `${PROVISIONAL_DECISION_RECORD_MARKER}\n${JSON.stringify(record)}`;
  const parsed = parseProvisionalDecisionRecordComment(body);
  if (!parsed.ok) {
    throw new Error(
      `record does not satisfy the shared schema: ${parsed.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return body;
}
function exactRecord(state, record, body) {
  const matches = recordById(state.records, record.recordId);
  if (matches.length === 0) return 'absent';
  if (matches.length !== 1 || matches[0]?.comment.body !== body)
    return 'conflict';
  return 'exact';
}
function labelsContain(labels, name) {
  if (!Array.isArray(labels)) return false;
  return labels.some((entry) => {
    if (typeof entry === 'string') return entry === name;
    return (
      typeof entry === 'object' &&
      entry !== null &&
      String(entry.name ?? '') === name
    );
  });
}
function failReport(
  issueNumber,
  action,
  status,
  checks,
  labelName,
  labelPresent = false,
  nextAction = 'Resolve the failed check, then rerun a fresh dry-run.',
  target = null,
) {
  return {
    schemaVersion: 1,
    issueNumber,
    action,
    outcome: 'refused',
    decisionStatus: status,
    target,
    checks,
    label: {
      name: labelName,
      present: labelPresent,
      applied: false,
      verified: labelPresent,
    },
    finalized: false,
    nextAction,
  };
}
function commentClaimLineageAt(state, commentId) {
  const commentIndex = state.comments.findIndex(
    (comment) => comment.id === commentId,
  );
  if (commentIndex < 0)
    throw new Error('record comment is missing from history');
  return state.verifiedClaimLineage.filter((claim) => {
    const claimIndex = state.comments.findIndex(
      (comment) => comment.id === claim.commentId,
    );
    return claimIndex >= 0 && claimIndex < commentIndex;
  });
}
function parsePullRequestNumber(reference) {
  const match = reference.match(/\/pull\/(\d+)(?:$|[/?#])/u);
  return match ? parseCanonicalIntegerOrNull(match[1]) : null;
}
function verifyHistoricalCompletions(records, source, deps) {
  const work = [];
  for (const { record } of records) {
    if (record.event.type !== 'work-completed') continue;
    const result = record.event.result;
    if (result?.kind !== 'merged-pull-request') continue;
    const reference = String(result.reference ?? '');
    const pullRequest = parsePullRequestNumber(reference);
    if (!pullRequest) continue;
    const evidence = deps.verifyPullRequest({
      issueNumber: source.issueNumber,
      pullRequest,
      expectedHeadSha: String(result.headSha ?? ''),
      expectedMergeCommitSha: String(result.mergeCommitSha ?? ''),
      verifiedAt: String(result.verifiedAt ?? ''),
    });
    const selection = records.find(
      (entry) =>
        entry.record.event.type === 'selected' &&
        entry.record.bundleGeneration === record.bundleGeneration &&
        entry.record.decisionGeneration === record.decisionGeneration,
    );
    const criteria =
      selection?.record.event.type === 'selected' &&
      Array.isArray(selection.record.event.executionCriteria)
        ? selection.record.event.executionCriteria.length
        : Number.POSITIVE_INFINITY;
    const evidenceReferences = record.evidenceReferences;
    const criterionEvidenceReferences = Number.isFinite(criteria)
      ? evidenceReferences.slice(-criteria)
      : [];
    const criteriaReferenced =
      Number.isFinite(criteria) &&
      criteria > 0 &&
      evidenceReferences.length >= criteria + 1 &&
      evidenceReferences[0] === reference &&
      criterionEvidenceReferences.length === criteria &&
      criterionEvidenceReferences.every((reference) => isHttpUrl(reference));
    if (!evidence.verified || !criteriaReferenced) continue;
    work.push({
      source: record.source,
      bundleGeneration: record.bundleGeneration,
      decisionGeneration: record.decisionGeneration,
      reference,
      verifiedAt: String(result.verifiedAt),
      headSha: String(result.headSha),
      mergeCommitSha: String(result.mergeCommitSha),
      executionCriteriaSatisfied: true,
    });
  }
  return work;
}
function isHttpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//u.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname && !url.username && !url.password);
  } catch {
    return false;
  }
}
function findDecision(state, bundleGeneration, decisionGeneration) {
  return state.replay.decisions.find(
    (decision) =>
      decision.bundleGeneration === bundleGeneration &&
      decision.decisionGeneration === decisionGeneration,
  );
}
function completionDecisionIsCurrent(
  state,
  bundleGeneration,
  decisionGeneration,
  expectedStatus,
) {
  const decision = findDecision(state, bundleGeneration, decisionGeneration);
  return Boolean(
    decision?.workStarted &&
      decision.status === expectedStatus &&
      !decision.confirmation &&
      !decision.reworkRequested &&
      !decision.reworkAuthored,
  );
}
function completionReplayIsPending(state, target, label) {
  return Boolean(
    target &&
      state.item.state === 'OPEN' &&
      state.authority.needsDecisionLabelName === label &&
      state.replay.valid &&
      state.replay.status === 'confirmation-pending' &&
      completionDecisionIsCurrent(
        state,
        target.bundleGeneration,
        target.decisionGeneration,
        'confirmation-pending',
      ),
  );
}
function criteriaEvidence(payload, criteria) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      references: [],
      detail: 'completion input must be an object',
    };
  }
  const entries = payload.criteriaEvidence;
  if (!Array.isArray(entries)) {
    return {
      valid: false,
      references: [],
      detail: 'criteriaEvidence must be an array',
    };
  }
  const seen = new Set();
  const referencesByCriterion = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        valid: false,
        references: [...referencesByCriterion.values()],
        detail: 'criterion evidence entry is malformed',
      };
    }
    const row = entry;
    if (
      typeof row.criterion !== 'string' ||
      !criteria.includes(row.criterion) ||
      seen.has(row.criterion) ||
      row.passed !== true ||
      !isHttpUrl(row.reference)
    ) {
      return {
        valid: false,
        references: [...referencesByCriterion.values()],
        detail:
          'each criterion needs one passing result and an HTTP(S) evidence URL',
      };
    }
    seen.add(row.criterion);
    referencesByCriterion.set(row.criterion, row.reference);
  }
  const valid = seen.size === criteria.length;
  const references = criteria.map(
    (criterion) => referencesByCriterion.get(criterion) ?? '',
  );
  return {
    valid,
    references,
    detail: valid
      ? 'every selected execution criterion has a passing evidence reference'
      : 'one or more selected execution criteria have no evidence entry',
  };
}
function recordForGeneration(
  records,
  bundleGeneration,
  decisionGeneration,
  eventType,
) {
  return records.find(
    ({ record }) =>
      record.bundleGeneration === bundleGeneration &&
      record.decisionGeneration === decisionGeneration &&
      record.event.type === eventType,
  );
}
function makeReport(
  input,
  outcome,
  status,
  target,
  checks,
  labelName,
  labelPresent,
  labelApplied,
  finalized,
  nextAction,
) {
  return {
    schemaVersion: 1,
    issueNumber: input.issueNumber,
    action: input.action,
    outcome,
    decisionStatus: status,
    target,
    checks,
    label: {
      name: labelName,
      present: labelPresent,
      applied: labelApplied,
      verified: labelPresent,
    },
    finalized,
    nextAction,
  };
}
function rejectIfInvalidReplay(input, state, checks) {
  if (state.replay.valid) {
    checks.push({
      name: 'complete-replay',
      passed: true,
      detail: `current lifecycle is ${state.replay.status}`,
    });
    return null;
  }
  checks.push({
    name: 'complete-replay',
    passed: false,
    detail: state.replay.issues.map((issue) => issue.message).join('; '),
  });
  return failReport(
    input.issueNumber,
    input.action,
    'invalid',
    checks,
    state.authority.needsDecisionLabelName,
    labelsContain(state.item.labels, state.authority.needsDecisionLabelName),
    'Repair the invalid or incomplete record history before retrying.',
  );
}
function ensureSourceOpenForCompletion(
  input,
  deps,
  state,
  target,
  checks,
  label,
  pullRequest,
  evidence,
) {
  if (state.item.state === 'OPEN') {
    checks.push({
      name: 'source-open',
      passed: true,
      detail: 'the source issue is open before completion persistence',
    });
    return { state };
  }
  checks.push({
    name: 'source-open',
    passed: false,
    detail:
      'the verified merged PR closed the source issue; completion must reopen it before persistence',
  });
  if (!input.apply) {
    return {
      report: makeReport(
        input,
        'planned',
        state.replay.status,
        target,
        checks,
        label,
        labelsContain(state.item.labels, label),
        false,
        false,
        'Rerun with --apply to reopen the verified source issue before recording completion and its decision label.',
      ),
    };
  }
  const expectedDecision = findDecision(
    state,
    target.bundleGeneration,
    target.decisionGeneration,
  );
  if (
    !expectedDecision ||
    (expectedDecision.status !== 'in-progress' &&
      expectedDecision.status !== 'confirmation-pending')
  ) {
    checks.push({
      name: 'completion-lifecycle-current',
      passed: false,
      detail: 'the decision is no longer awaiting completion',
    });
    return {
      report: failReport(
        input.issueNumber,
        input.action,
        state.replay.status,
        checks,
        label,
        labelsContain(state.item.labels, label),
        'Follow the current confirmation or rework lifecycle; do not reopen for completion.',
        target,
      ),
    };
  }
  const expectedStatus = expectedDecision.status;
  let reopenAttempted = false;
  try {
    const fresh = buildFreshState(input.issueNumber, deps, {
      allowClosed: true,
    });
    const freshDecision = findDecision(
      fresh,
      target.bundleGeneration,
      target.decisionGeneration,
    );
    if (
      fresh.source.snapshot.bodySha256 !== state.source.snapshot.bodySha256 ||
      !fresh.replay.valid ||
      !freshDecision?.workStarted ||
      !completionDecisionIsCurrent(
        fresh,
        target.bundleGeneration,
        target.decisionGeneration,
        expectedStatus,
      )
    ) {
      throw new Error(
        'source or started-decision replay changed before reopening',
      );
    }
    if (!assertTrustedRecordAuthor(fresh, checks)) {
      return {
        report: failReport(
          input.issueNumber,
          input.action,
          fresh.replay.status,
          checks,
          label,
          labelsContain(fresh.item.labels, label),
          'Use a trusted marker actor before reopening the source issue.',
          target,
        ),
      };
    }
    if (fresh.item.state === 'OPEN') {
      checks.push({
        name: 'source-open',
        passed: true,
        detail:
          'the source was reopened before this helper attempted its mutation',
      });
      return { state: fresh };
    }
    const currentEvidence = deps.verifyPullRequest({
      issueNumber: input.issueNumber,
      pullRequest,
      expectedHeadSha: evidence.headSha,
      expectedMergeCommitSha: evidence.mergeCommitSha,
      verifiedAt: evidence.verifiedAt,
    });
    if (!currentEvidence.verified) {
      throw new Error(
        `merged deliverable changed before source reopening: ${currentEvidence.reason}`,
      );
    }
    if (!assertCurrentClaim(input, deps, checks)) {
      return {
        report: failReport(
          input.issueNumber,
          input.action,
          fresh.replay.status,
          checks,
          label,
          labelsContain(fresh.item.labels, label),
          'Reacquire the current claim before reopening the source issue.',
          target,
        ),
      };
    }
    reopenAttempted = true;
    deps.reopenWorkItem(input.issueNumber);
    const after = buildFreshState(input.issueNumber, deps, {
      allowClosed: true,
    });
    if (
      after.item.state !== 'OPEN' ||
      after.source.snapshot.bodySha256 !== state.source.snapshot.bodySha256 ||
      !after.replay.valid ||
      !completionDecisionIsCurrent(
        after,
        target.bundleGeneration,
        target.decisionGeneration,
        expectedStatus,
      )
    ) {
      throw new Error(
        'source reopen did not read back as open with valid history',
      );
    }
    checks.push({
      name: 'source-open',
      passed: true,
      detail:
        'the issue reopen was read back; the source remains open for confirmation',
    });
    return { state: after };
  } catch (error) {
    let after = null;
    try {
      after = buildFreshState(input.issueNumber, deps, { allowClosed: true });
    } catch {
      /* unresolved */
    }
    const reopened = Boolean(
      after &&
        after.item.state === 'OPEN' &&
        after.source.snapshot.bodySha256 === state.source.snapshot.bodySha256 &&
        after.replay.valid &&
        completionDecisionIsCurrent(
          after,
          target.bundleGeneration,
          target.decisionGeneration,
          expectedStatus,
        ),
    );
    checks.push({
      name: 'source-open-recovery',
      passed: reopened,
      detail: reopened
        ? 'the issue was found open after an uncertain reopen response'
        : error instanceof Error
          ? error.message
          : String(error),
    });
    if (reopened && after) return { state: after };
    return {
      report: makeReport(
        input,
        reopenAttempted ? 'partial' : 'refused',
        after?.replay.status ?? state.replay.status,
        target,
        checks,
        label,
        after
          ? labelsContain(after.item.labels, label)
          : labelsContain(state.item.labels, label),
        false,
        false,
        'Keep the decision incomplete; verify the source issue state, then rerun the same completion after it is open.',
      ),
    };
  }
}
function assertCurrentClaim(input, deps, checks) {
  try {
    deps.assertClaim({
      issueNumber: input.issueNumber,
      claimId: input.claimId,
      agentId: input.agentId,
      nonce: input.nonce,
      cwd: deps.cwd,
    });
    checks.push({
      name: 'owned-claim-and-worktree',
      passed: true,
      detail:
        'the fresh claim assertion confirmed the active owner, nonce, lock, tokens, branch, and worktree',
    });
    return true;
  } catch (error) {
    checks.push({
      name: 'owned-claim-and-worktree',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
function assertTrustedRecordAuthor(state, checks) {
  const trusted = state.authority.trustedMarkerActors.some(
    (actor) => normalizedLogin(actor) === state.viewerLogin,
  );
  checks.push({
    name: 'record-author',
    passed: trusted,
    detail: trusted
      ? 'authenticated GitHub viewer is a trusted marker actor'
      : 'authenticated GitHub viewer is not a trusted marker actor',
  });
  return trusted;
}
function validateSelectionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      references: [],
      detail: 'selection input must be an object',
    };
  }
  const value = payload;
  const references = Array.isArray(value.evidenceReferences)
    ? value.evidenceReferences.filter(isHttpUrl)
    : [];
  const event = {
    type: 'selected',
    question: value.question,
    selectedOption: value.selectedOption,
    feasibleAlternatives: value.feasibleAlternatives,
    executionCriteria: value.executionCriteria,
  };
  const valid =
    typeof value.question === 'string' &&
    value.question.trim().length > 0 &&
    value.selectedOption !== undefined &&
    Array.isArray(value.feasibleAlternatives) &&
    value.feasibleAlternatives.length >= 1 &&
    Array.isArray(value.executionCriteria) &&
    value.executionCriteria.length >= 1 &&
    Array.isArray(value.evidenceReferences) &&
    references.length === value.evidenceReferences.length &&
    references.length >= 1;
  if (!valid) {
    return {
      valid: false,
      references,
      detail:
        'selection requires a question, full selected option, at least one compared feasible alternative, execution criteria, and evidence URLs',
    };
  }
  return {
    valid: true,
    event,
    references,
    detail: 'selection comparison and execution criteria are present',
  };
}
function isValidPullRequestLink(references, issueNumber) {
  return (
    Array.isArray(references) &&
    references.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      return Number(entry.number) === issueNumber;
    })
  );
}
function selectAction(input, deps) {
  const checks = [];
  let state;
  try {
    state = buildFreshState(input.issueNumber, deps);
  } catch (error) {
    checks.push({
      name: 'fresh-source-and-history',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return failReport(
      input.issueNumber,
      input.action,
      'invalid',
      checks,
      'status:needs-decision',
    );
  }
  const label = state.authority.needsDecisionLabelName;
  const labelPresent = labelsContain(state.item.labels, label);
  const invalidReplay = rejectIfInvalidReplay(input, state, checks);
  if (invalidReplay) return invalidReplay;
  if (!assertCurrentClaim(input, deps, checks)) {
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
    );
  }
  const selection = validateSelectionPayload(input.payload);
  checks.push({
    name: 'selection-contract',
    passed: selection.valid,
    detail: selection.detail,
  });
  if (!selection.valid || !selection.event) {
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
    );
  }
  let next;
  try {
    next = nextSelectionGeneration(state.replay);
  } catch (error) {
    checks.push({
      name: 'generation-current',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Resolve the current bundle lifecycle before adding another selection.',
    );
  }
  const bundleGeneration = input.bundleGeneration ?? next.bundleGeneration;
  const decisionGeneration =
    input.decisionGeneration ?? next.decisionGeneration;
  const operationId = stableRecordId(
    state.source,
    bundleGeneration,
    decisionGeneration,
    'selected',
  );
  const existingComment = recordById(state.records, operationId)[0]?.comment;
  const record = buildRecord(
    state,
    existingComment
      ? commentClaimLineageAt(state, existingComment.id)
      : state.verifiedClaimLineage,
    bundleGeneration,
    decisionGeneration,
    selection.event,
    selection.references,
  );
  let body;
  try {
    body = serializedRecord(record);
  } catch (error) {
    checks.push({
      name: 'selection-contract',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
    );
  }
  const target = {
    bundleGeneration,
    decisionGeneration,
    recordId: record.recordId,
  };
  const existing = exactRecord(state, record, body);
  if (existing === 'conflict') {
    checks.push({
      name: 'operation-identity',
      passed: false,
      detail: 'the stable recordId already exists with different content',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Investigate the existing recordId; never post a second selection for this generation.',
      target,
    );
  }
  if (existing === 'exact') {
    checks.push({
      name: 'operation-identity',
      passed: true,
      detail: 'the exact selection record already exists',
    });
    checks.push({
      name: 'trusted-provisional-opt-in',
      passed: true,
      detail:
        'existing selection is replayed; the opt-in only gates a new selection write',
    });
    const currentDecision = findDecision(
      state,
      bundleGeneration,
      decisionGeneration,
    );
    const implementationAllowed =
      currentDecision?.status === 'selected' ||
      currentDecision?.status === 'in-progress';
    checks.push({
      name: 'selection-lifecycle',
      passed: implementationAllowed,
      detail: currentDecision
        ? `the current decision is ${currentDecision.status}`
        : 'the recorded selection is missing from replayed decisions',
    });
    return makeReport(
      input,
      'reconciled',
      state.replay.status,
      target,
      checks,
      label,
      labelPresent,
      false,
      false,
      currentDecision?.status === 'selected'
        ? 'The selection is recorded; persist work-started before beginning implementation.'
        : currentDecision?.status === 'in-progress'
          ? 'Work is already recorded as started; continue under its recorded criteria and active claim.'
          : 'This decision is terminal or awaiting rework; do not continue implementation. Follow its confirmation or rework lifecycle.',
    );
  }
  if (
    bundleGeneration !== next.bundleGeneration ||
    decisionGeneration !== next.decisionGeneration
  ) {
    checks.push({
      name: 'generation-current',
      passed: false,
      detail:
        'requested generations do not match the next current bundle transition',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Use the generation returned by a fresh dry-run; do not skip a bundle generation.',
      target,
    );
  }
  if (!state.authority.enabled) {
    checks.push({
      name: 'trusted-provisional-opt-in',
      passed: false,
      detail:
        'dangerouslyAutoDecide is not explicitly true in trusted repository policy',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Enable the repository opt-in through its trusted policy decision before selecting a provisional option.',
      target,
    );
  }
  checks.push({
    name: 'trusted-provisional-opt-in',
    passed: true,
    detail: `trusted repository policy enables provisional decisions at ${state.authority.ref}`,
  });
  if (
    !state.authority.trustedMarkerActors.some(
      (actor) => normalizedLogin(actor) === state.viewerLogin,
    )
  ) {
    checks.push({
      name: 'record-author',
      passed: false,
      detail: 'authenticated GitHub viewer is not a trusted marker actor',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Use an authorized trusted marker actor or update trusted repository policy.',
    );
  }
  checks.push({
    name: 'record-author',
    passed: true,
    detail: 'authenticated GitHub viewer is a trusted marker actor',
  });
  checks.push({
    name: 'generation-current',
    passed: true,
    detail: 'record generation is the next current bundle transition',
  });
  if (!input.apply) {
    return makeReport(
      input,
      'planned',
      state.replay.status,
      target,
      checks,
      label,
      labelPresent,
      false,
      false,
      'Review the planned selection record, then rerun with --apply to persist it.',
    );
  }
  let postAttempted = false;
  try {
    const fresh = buildFreshState(input.issueNumber, deps);
    const freshNext = nextSelectionGeneration(fresh.replay);
    if (
      fresh.source.snapshot.bodySha256 !== state.source.snapshot.bodySha256 ||
      fresh.source.snapshot.title !== state.source.snapshot.title ||
      !fresh.replay.valid ||
      !fresh.authority.enabled ||
      freshNext.bundleGeneration !== bundleGeneration ||
      freshNext.decisionGeneration !== decisionGeneration ||
      !fresh.authority.trustedMarkerActors.some(
        (actor) => normalizedLogin(actor) === fresh.viewerLogin,
      ) ||
      exactRecord(fresh, record, body) !== 'absent'
    ) {
      throw new Error(
        'source, policy, bundle generation, or selection identity changed immediately before the write',
      );
    }
    if (!assertCurrentClaim(input, deps, checks)) {
      return failReport(
        input.issueNumber,
        input.action,
        fresh.replay.status,
        checks,
        label,
        labelsContain(fresh.item.labels, label),
        'The claim changed before POST; reacquire through the normal claim gates.',
      );
    }
    postAttempted = true;
    const post = deps.postComment(input.issueNumber, body);
    const after = buildFreshState(input.issueNumber, deps);
    const exact = exactRecord(after, record, body);
    if (exact !== 'exact' || !after.replay.valid) {
      checks.push({
        name: 'post-readback-and-replay',
        passed: false,
        detail:
          'POST returned but exact record readback or replay did not verify',
      });
      return makeReport(
        input,
        'partial',
        after.replay.status,
        target,
        checks,
        label,
        labelsContain(after.item.labels, label),
        false,
        false,
        `Inspect comment ${post.htmlUrl}; do not implement until the exact record replays as selected.`,
      );
    }
    checks.push({
      name: 'post-readback-and-replay',
      passed: true,
      detail: `comment #${post.id} was read back and the complete history replays`,
    });
    return makeReport(
      input,
      'applied',
      after.replay.status,
      target,
      checks,
      label,
      labelsContain(after.item.labels, label),
      false,
      false,
      'Selection is persisted; implementation may start only under the recorded criteria and active claim.',
    );
  } catch (error) {
    if (!postAttempted) {
      checks.push({
        name: 'prewrite-revalidation',
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return failReport(
        input.issueNumber,
        input.action,
        state.replay.status,
        checks,
        label,
        labelPresent,
        'Resolve the source or policy drift, then rerun a fresh dry-run; no record was posted.',
        target,
      );
    }
    let after = null;
    try {
      after = buildFreshState(input.issueNumber, deps);
    } catch {
      // The original POST outcome cannot be reconciled without a fresh read.
    }
    const reconciled = after
      ? exactRecord(after, record, body) === 'exact' && after.replay.valid
      : false;
    checks.push({
      name: 'uncertain-post-recovery',
      passed: reconciled,
      detail: reconciled
        ? 'the exact operation was found and replayed after an uncertain POST'
        : error instanceof Error
          ? error.message
          : String(error),
    });
    return makeReport(
      input,
      reconciled ? 'reconciled' : 'partial',
      after?.replay.status ?? state.replay.status,
      target,
      checks,
      label,
      after ? labelsContain(after.item.labels, label) : labelPresent,
      false,
      false,
      reconciled
        ? 'The exact selection transition is already persisted; do not repost it.'
        : 'The POST outcome is unresolved; reread the complete history and do not implement or repost until the same operation is reconciled.',
    );
  }
}
function startAction(input, deps) {
  const checks = [];
  let state;
  try {
    state = buildFreshState(input.issueNumber, deps);
  } catch (error) {
    checks.push({
      name: 'fresh-source-and-history',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return failReport(
      input.issueNumber,
      input.action,
      'invalid',
      checks,
      'status:needs-decision',
    );
  }
  const label = state.authority.needsDecisionLabelName;
  const labelPresent = labelsContain(state.item.labels, label);
  const target = targetForInput(input, checks, state.source, 'work-started');
  if (!target)
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
    );
  const invalidReplay = rejectIfInvalidReplay(input, state, checks);
  if (invalidReplay) return invalidReplay;
  const decision = findDecision(
    state,
    target.bundleGeneration,
    target.decisionGeneration,
  );
  const existing = recordForGeneration(
    state.records,
    target.bundleGeneration,
    target.decisionGeneration,
    'work-started',
  );
  const payload =
    input.payload && typeof input.payload === 'object' ? input.payload : {};
  const planReference = payload.planReference;
  if (existing) {
    if (!decision || !assertCurrentClaim(input, deps, checks)) {
      return failReport(
        input.issueNumber,
        input.action,
        state.replay.status,
        checks,
        label,
        labelPresent,
        'Revalidate the current claim before resuming the persisted work-start transition.',
        target,
      );
    }
    checks.push({
      name: 'operation-identity',
      passed: true,
      detail:
        'a work-started transition already exists; the same operation will be replayed',
    });
    const pending = readPendingOperation(
      deps,
      input.issueNumber,
      existing.record.recordId,
    );
    if (
      pending.status === 'unreadable' ||
      (pending.status === 'found' &&
        pending.operation.body !== existing.comment.body)
    ) {
      return pendingOperationReport(
        input,
        state,
        label,
        { ...target, recordId: existing.record.recordId },
        pending.status === 'unreadable'
          ? pending.error
          : 'the persisted work-start record differs from the locally journaled operation',
      );
    }
    if (
      typeof planReference === 'string' &&
      planReference !== existing.record.event.planReference
    ) {
      checks.push({
        name: 'plan-reference',
        passed: false,
        detail:
          'retry planReference differs from the persisted work-started record',
      });
      return failReport(
        input.issueNumber,
        input.action,
        state.replay.status,
        checks,
        label,
        labelPresent,
        'Use the persisted work-started operation; do not change its plan reference.',
        target,
      );
    }
    if (pending.status === 'found') {
      clearPendingOperation(deps, input.issueNumber, existing.record.recordId);
    }
    return makeReport(
      input,
      'reconciled',
      state.replay.status,
      target,
      checks,
      label,
      labelPresent,
      false,
      false,
      'Work is already recorded as started; continue from the persisted plan without reposting.',
    );
  }
  if (decision?.status !== 'selected') {
    checks.push({
      name: 'selection-state',
      passed: false,
      detail: 'the target decision is not waiting for work to start',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Select and verify the decision before starting work.',
      target,
    );
  }
  if (!state.authority.enabled) {
    checks.push({
      name: 'trusted-provisional-opt-in',
      passed: false,
      detail:
        'new work cannot start without current trusted dangerouslyAutoDecide=true',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Wait for the trusted repository opt-in or an authorized decision lifecycle update.',
      target,
    );
  }
  checks.push({
    name: 'trusted-provisional-opt-in',
    passed: true,
    detail: `trusted policy enables new provisional work at ${state.authority.ref}`,
  });
  if (!isHttpUrl(planReference)) {
    checks.push({
      name: 'plan-reference',
      passed: false,
      detail: 'planReference must be an HTTP(S) URL',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Provide the reviewed implementation plan URL.',
      target,
    );
  }
  if (!assertCurrentClaim(input, deps, checks)) {
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
    );
  }
  let record = buildRecord(
    state,
    state.verifiedClaimLineage,
    target.bundleGeneration,
    target.decisionGeneration,
    { type: 'work-started', startedAt: isoNow(deps), planReference },
    [planReference],
  );
  let body = serializedRecord(record);
  const operationTarget = { ...target, recordId: record.recordId };
  const pending = readPendingOperation(
    deps,
    input.issueNumber,
    record.recordId,
  );
  if (pending.status === 'unreadable') {
    return pendingOperationReport(
      input,
      state,
      label,
      operationTarget,
      pending.error,
    );
  }
  if (pending.status === 'found') {
    const priorEvent = pending.operation.record.event;
    const sameOperation =
      sameSourceIdentity(pending.operation.record.source, record.source) &&
      pending.operation.record.bundleGeneration === record.bundleGeneration &&
      pending.operation.record.decisionGeneration ===
        record.decisionGeneration &&
      priorEvent.type === 'work-started' &&
      priorEvent.planReference === planReference;
    if (!sameOperation) {
      return pendingOperationReport(
        input,
        state,
        label,
        operationTarget,
        'the unresolved work-start operation does not match the current source, generation, or plan reference',
      );
    }
    record = pending.operation.record;
    body = pending.operation.body;
    if (pending.operation.attempted) {
      return pendingOperationReport(
        input,
        state,
        label,
        operationTarget,
        'a prior work-start POST was attempted but its exact record is not yet visible in full history',
      );
    }
    checks.push({
      name: 'operation-identity',
      passed: true,
      detail:
        'reusing the exact persisted work-start payload from the prior dry run',
    });
  }
  if (!input.apply) {
    return makeReport(
      input,
      'planned',
      state.replay.status,
      operationTarget,
      checks,
      label,
      labelPresent,
      false,
      false,
      'Review the work-start transition and rerun with --apply to record it.',
    );
  }
  let postAttempted = false;
  try {
    const fresh = buildFreshState(input.issueNumber, deps);
    const freshDecision = findDecision(
      fresh,
      target.bundleGeneration,
      target.decisionGeneration,
    );
    if (
      !fresh.replay.valid ||
      fresh.source.snapshot.bodySha256 !== state.source.snapshot.bodySha256 ||
      !fresh.authority.enabled ||
      !fresh.authority.trustedMarkerActors.some(
        (actor) => normalizedLogin(actor) === fresh.viewerLogin,
      ) ||
      freshDecision?.status !== 'selected' ||
      recordForGeneration(
        fresh.records,
        target.bundleGeneration,
        target.decisionGeneration,
        'work-started',
      )
    ) {
      throw new Error(
        'source, policy, decision generation, or work-start identity changed immediately before the write',
      );
    }
    if (!assertCurrentClaim(input, deps, checks)) {
      return failReport(
        input.issueNumber,
        input.action,
        fresh.replay.status,
        checks,
        label,
        labelsContain(fresh.item.labels, label),
        'The claim changed before POST; reacquire through the normal claim gates.',
        operationTarget,
      );
    }
    const prepared = preparePendingOperation(
      deps,
      input.issueNumber,
      record.recordId,
      body,
    );
    if (!prepared.ok) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        operationTarget,
        prepared.error,
      );
    }
    if (prepared.operation.attempted) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        operationTarget,
        'a prior work-start POST was attempted but its exact record is not yet visible in full history',
      );
    }
    const preparedEvent = prepared.operation.record.event;
    if (
      !sameSourceIdentity(prepared.operation.record.source, record.source) ||
      prepared.operation.record.bundleGeneration !== record.bundleGeneration ||
      prepared.operation.record.decisionGeneration !==
        record.decisionGeneration ||
      preparedEvent.type !== 'work-started' ||
      preparedEvent.planReference !== planReference
    ) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        operationTarget,
        'the prepared work-start payload no longer matches the current source, generation, or plan reference',
      );
    }
    record = prepared.operation.record;
    body = prepared.operation.body;
    if (!markPendingOperationAttempted(prepared.operation)) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        operationTarget,
        'another invocation already attempted this work-start operation',
      );
    }
    postAttempted = true;
    const post = deps.postComment(input.issueNumber, body);
    const after = buildFreshState(input.issueNumber, deps);
    if (exactRecord(after, record, body) !== 'exact' || !after.replay.valid) {
      checks.push({
        name: 'post-readback-and-replay',
        passed: false,
        detail:
          'POST returned but exact work-start record readback or replay failed',
      });
      return makeReport(
        input,
        'partial',
        after.replay.status,
        operationTarget,
        checks,
        label,
        labelsContain(after.item.labels, label),
        false,
        false,
        `Inspect comment ${post.htmlUrl}; do not begin new work until the record replays as in-progress.`,
      );
    }
    checks.push({
      name: 'post-readback-and-replay',
      passed: true,
      detail: `comment #${post.id} was read back and the complete history replays`,
    });
    clearPendingOperation(deps, input.issueNumber, record.recordId);
    return makeReport(
      input,
      'applied',
      after.replay.status,
      operationTarget,
      checks,
      label,
      labelsContain(after.item.labels, label),
      false,
      false,
      'Work start is persisted; continue under the reviewed plan and normal IDD gates.',
    );
  } catch (error) {
    if (!postAttempted) {
      checks.push({
        name: 'prewrite-revalidation',
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return failReport(
        input.issueNumber,
        input.action,
        state.replay.status,
        checks,
        label,
        labelPresent,
        'Resolve source or policy drift, then rerun a fresh dry-run; no record was posted.',
        operationTarget,
      );
    }
    let after = null;
    try {
      after = buildFreshState(input.issueNumber, deps);
    } catch {
      /* unresolved */
    }
    const reconciled = after
      ? exactRecord(after, record, body) === 'exact' && after.replay.valid
      : false;
    if (reconciled) {
      clearPendingOperation(deps, input.issueNumber, record.recordId);
    }
    checks.push({
      name: 'uncertain-post-recovery',
      passed: reconciled,
      detail: reconciled
        ? 'the exact work-start operation was found and replayed'
        : error instanceof Error
          ? error.message
          : String(error),
    });
    return makeReport(
      input,
      reconciled ? 'reconciled' : 'partial',
      after?.replay.status ?? state.replay.status,
      operationTarget,
      checks,
      label,
      after ? labelsContain(after.item.labels, label) : labelPresent,
      false,
      false,
      reconciled
        ? 'The work-start transition is already persisted; do not repost.'
        : 'The POST outcome is unresolved; reread the full history and do not start work until the same operation is reconciled.',
    );
  }
}
function targetForInput(input, checks, source, eventType) {
  if (!input.bundleGeneration || !input.decisionGeneration) {
    checks.push({
      name: 'target-generation',
      passed: false,
      detail:
        'bundle and decision generations are required for start and complete',
    });
    return null;
  }
  return {
    bundleGeneration: input.bundleGeneration,
    decisionGeneration: input.decisionGeneration,
    recordId: stableRecordId(
      source,
      input.bundleGeneration,
      input.decisionGeneration,
      eventType,
    ),
  };
}
function completeAction(input, deps) {
  const checks = [];
  let state;
  try {
    state = buildFreshState(input.issueNumber, deps, { allowClosed: true });
  } catch (error) {
    checks.push({
      name: 'fresh-source-and-history',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return failReport(
      input.issueNumber,
      input.action,
      'invalid',
      checks,
      'status:needs-decision',
    );
  }
  const label = state.authority.needsDecisionLabelName;
  let labelPresent = labelsContain(state.item.labels, label);
  const targetInput = targetForInput(
    input,
    checks,
    state.source,
    'work-completed',
  );
  if (!targetInput)
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
    );
  const invalidReplay = rejectIfInvalidReplay(input, state, checks);
  if (invalidReplay) return invalidReplay;
  const decision = findDecision(
    state,
    targetInput.bundleGeneration,
    targetInput.decisionGeneration,
  );
  if (!decision?.workStarted) {
    checks.push({
      name: 'work-started-state',
      passed: false,
      detail: 'the target has no verified work-started transition',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Record and replay work-started before completing the decision.',
      targetInput,
    );
  }
  if (
    decision.confirmation ||
    decision.reworkRequested ||
    decision.reworkAuthored ||
    (decision.status !== 'in-progress' &&
      decision.status !== 'confirmation-pending')
  ) {
    checks.push({
      name: 'transition-order',
      passed: false,
      detail: 'the target decision is already terminal or awaiting rework',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Resume through the confirmation or rework lifecycle owned by issue #4536.',
      targetInput,
    );
  }
  if (!assertCurrentClaim(input, deps, checks)) {
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
    );
  }
  if (!assertTrustedRecordAuthor(state, checks)) {
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Use a trusted marker actor to persist completion.',
      targetInput,
    );
  }
  const selectionEvent = decision.selection.event;
  const criteria = Array.isArray(selectionEvent.executionCriteria)
    ? selectionEvent.executionCriteria.filter(
        (entry) => typeof entry === 'string',
      )
    : [];
  const existing = recordForGeneration(
    state.records,
    targetInput.bundleGeneration,
    targetInput.decisionGeneration,
    'work-completed',
  );
  let pullRequest = input.pullRequest;
  if (existing) {
    const result = existing.record.event.result;
    const recordedPr = parsePullRequestNumber(String(result.reference ?? ''));
    if (
      !recordedPr ||
      (pullRequest !== undefined && pullRequest !== recordedPr)
    ) {
      checks.push({
        name: 'operation-identity',
        passed: false,
        detail:
          'existing completion record does not match the requested pull request',
      });
      return failReport(
        input.issueNumber,
        input.action,
        state.replay.status,
        checks,
        label,
        labelPresent,
        'Rerun with the pull request already recorded for this generation.',
        targetInput,
      );
    }
    pullRequest = recordedPr;
    checks.push({
      name: 'operation-identity',
      passed: true,
      detail:
        'a completion record already exists; retry will reconcile its label without reposting',
    });
    const pending = readPendingOperation(
      deps,
      input.issueNumber,
      existing.record.recordId,
    );
    if (
      pending.status === 'found' &&
      pending.operation.body !== existing.comment.body
    ) {
      return pendingOperationReport(
        input,
        state,
        label,
        { ...targetInput, recordId: existing.record.recordId },
        'the persisted completion record differs from the locally journaled operation',
      );
    }
  }
  const pending = existing
    ? { status: 'none' }
    : readPendingOperation(deps, input.issueNumber, targetInput.recordId);
  if (pending.status === 'unreadable') {
    return pendingOperationReport(
      input,
      state,
      label,
      targetInput,
      pending.error,
    );
  }
  if (pending.status === 'found' && pending.operation.attempted) {
    return pendingOperationReport(
      input,
      state,
      label,
      targetInput,
      'a prior completion POST was attempted but its exact record is not yet visible in full history',
    );
  }
  const pendingRecord =
    pending.status === 'found' ? pending.operation.record : null;
  if (!pullRequest) {
    checks.push({
      name: 'deliverable',
      passed: false,
      detail:
        'pull request number is required for independent completion verification',
    });
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Provide --pull-request for the merged deliverable.',
      targetInput,
    );
  }
  let evidence = deps.verifyPullRequest({
    issueNumber: input.issueNumber,
    pullRequest,
    ...(input.expectedHeadSha
      ? { expectedHeadSha: input.expectedHeadSha }
      : {}),
    ...(existing || pendingRecord
      ? {
          expectedHeadSha: String(
            (existing?.record ?? pendingRecord)?.event.result?.headSha ?? '',
          ),
          expectedMergeCommitSha: String(
            (existing?.record ?? pendingRecord)?.event.result?.mergeCommitSha ??
              '',
          ),
          verifiedAt: String(
            (existing?.record ?? pendingRecord)?.event.result?.verifiedAt ?? '',
          ),
        }
      : {}),
  });
  checks.push({
    name: 'merged-deliverable-and-required-validation',
    passed: evidence.verified,
    detail: evidence.reason,
  });
  if (
    !evidence.verified ||
    !evidence.reference ||
    !evidence.verifiedAt ||
    !evidence.headSha ||
    !evidence.mergeCommitSha
  ) {
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Resolve the linked PR merge, head, or required-check failure and rerun from a fresh read.',
      targetInput,
    );
  }
  if (existing) {
    const existingRecord = existing.record;
    const recordId = existingRecord.recordId;
    const target = { ...targetInput, recordId };
    if (!state.replay.valid || decision.status !== 'confirmation-pending') {
      checks.push({
        name: 'completion-replay',
        passed: false,
        detail: 'persisted completion does not replay as confirmation-pending',
      });
      return failReport(
        input.issueNumber,
        input.action,
        state.replay.status,
        checks,
        label,
        labelPresent,
        'Repair or inspect the persisted completion before applying the decision label.',
        target,
      );
    }
    const sourceOpen = ensureSourceOpenForCompletion(
      input,
      deps,
      state,
      target,
      checks,
      label,
      pullRequest,
      evidence,
    );
    if ('report' in sourceOpen) return sourceOpen.report;
    state = sourceOpen.state;
    labelPresent = labelsContain(state.item.labels, label);
    clearPendingOperation(deps, input.issueNumber, existingRecord.recordId);
    if (!labelPresent && !input.apply) {
      checks.push({
        name: 'needs-decision-label',
        passed: false,
        detail: `${label} is absent; apply will add and read it back`,
      });
      return makeReport(
        input,
        'planned',
        state.replay.status,
        target,
        checks,
        label,
        false,
        false,
        false,
        'The completion record is already present; rerun with --apply to reconcile the configured label.',
      );
    }
    return ensureCompletionLabel(
      input,
      deps,
      state,
      existingRecord,
      target,
      checks,
      true,
      label,
      labelPresent,
    );
  }
  const criteriaCheck = criteriaEvidence(input.payload, criteria);
  checks.push({
    name: 'execution-criteria',
    passed: criteriaCheck.valid,
    detail: criteriaCheck.detail,
  });
  if (!criteriaCheck.valid) {
    return failReport(
      input.issueNumber,
      input.action,
      state.replay.status,
      checks,
      label,
      labelPresent,
      'Provide one passing evidence URL for every selected execution criterion.',
      targetInput,
    );
  }
  const sourceOpen = ensureSourceOpenForCompletion(
    input,
    deps,
    state,
    targetInput,
    checks,
    label,
    pullRequest,
    evidence,
  );
  if ('report' in sourceOpen) return sourceOpen.report;
  state = sourceOpen.state;
  labelPresent = labelsContain(state.item.labels, label);
  let record = buildRecord(
    state,
    state.verifiedClaimLineage,
    targetInput.bundleGeneration,
    targetInput.decisionGeneration,
    {
      type: 'work-completed',
      result: {
        kind: 'merged-pull-request',
        reference: evidence.reference,
        verifiedAt: evidence.verifiedAt,
        headSha: evidence.headSha,
        mergeCommitSha: evidence.mergeCommitSha,
      },
    },
    [
      evidence.reference,
      ...(evidence.checkReferences ?? []),
      ...criteriaCheck.references,
    ],
  );
  let body = serializedRecord(record);
  const target = { ...targetInput, recordId: record.recordId };
  if (pending.status === 'found') {
    const sameOperation =
      sameSourceIdentity(pending.operation.record.source, record.source) &&
      pending.operation.record.bundleGeneration === record.bundleGeneration &&
      pending.operation.record.decisionGeneration ===
        record.decisionGeneration &&
      JSON.stringify(pending.operation.record.evidenceReferences) ===
        JSON.stringify(record.evidenceReferences) &&
      JSON.stringify(pending.operation.record.event) ===
        JSON.stringify(record.event);
    if (!sameOperation) {
      return pendingOperationReport(
        input,
        state,
        label,
        target,
        'the prepared completion payload no longer matches current deliverable and criteria evidence',
      );
    }
    record = pending.operation.record;
    body = pending.operation.body;
    checks.push({
      name: 'operation-identity',
      passed: true,
      detail:
        'reusing the exact persisted completion payload from the prior attempt',
    });
  }
  if (!input.apply) {
    return makeReport(
      input,
      'planned',
      state.replay.status,
      target,
      checks,
      label,
      labelPresent,
      false,
      false,
      'Review the merged deliverable and criteria evidence, then rerun with --apply.',
    );
  }
  let postAttempted = false;
  try {
    const fresh = buildFreshState(input.issueNumber, deps, {
      allowClosed: true,
    });
    if (!assertTrustedRecordAuthor(fresh, checks)) {
      return failReport(
        input.issueNumber,
        input.action,
        fresh.replay.status,
        checks,
        label,
        labelsContain(fresh.item.labels, label),
        'Use a trusted marker actor to persist completion.',
        target,
      );
    }
    if (
      fresh.item.state !== 'OPEN' ||
      !fresh.replay.valid ||
      fresh.source.snapshot.bodySha256 !== state.source.snapshot.bodySha256 ||
      !completionDecisionIsCurrent(
        fresh,
        target.bundleGeneration,
        target.decisionGeneration,
        'in-progress',
      ) ||
      recordForGeneration(
        fresh.records,
        target.bundleGeneration,
        target.decisionGeneration,
        'work-completed',
      )
    ) {
      throw new Error(
        'source, replay, work-start, or completion identity changed before completion persistence',
      );
    }
    if (!assertCurrentClaim(input, deps, checks)) {
      return failReport(
        input.issueNumber,
        input.action,
        fresh.replay.status,
        checks,
        label,
        labelsContain(fresh.item.labels, label),
        'The claim changed before POST; reacquire through the normal claim gates.',
        target,
      );
    }
    evidence = deps.verifyPullRequest({
      issueNumber: input.issueNumber,
      pullRequest,
      expectedHeadSha: evidence.headSha,
      expectedMergeCommitSha: evidence.mergeCommitSha,
      verifiedAt: evidence.verifiedAt,
    });
    if (!evidence.verified) {
      throw new Error(
        `deliverable changed before completion persistence: ${evidence.reason}`,
      );
    }
    const prepared = preparePendingOperation(
      deps,
      input.issueNumber,
      record.recordId,
      body,
    );
    if (!prepared.ok) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        target,
        prepared.error,
      );
    }
    if (prepared.operation.attempted) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        target,
        'a prior completion POST was attempted but its exact record is not yet visible in full history',
      );
    }
    const storedResult = prepared.operation.record.event.result;
    const storedEvent = prepared.operation.record.event;
    const matchesCurrentEvidence =
      prepared.operation.record.recordId === record.recordId &&
      sameSourceIdentity(prepared.operation.record.source, record.source) &&
      prepared.operation.record.bundleGeneration === record.bundleGeneration &&
      prepared.operation.record.decisionGeneration ===
        record.decisionGeneration &&
      JSON.stringify(prepared.operation.record.evidenceReferences) ===
        JSON.stringify(record.evidenceReferences) &&
      storedEvent.type === 'work-completed' &&
      storedResult.kind === 'merged-pull-request' &&
      storedResult.reference === evidence.reference &&
      storedResult.headSha === evidence.headSha &&
      storedResult.mergeCommitSha === evidence.mergeCommitSha &&
      typeof storedResult.verifiedAt === 'string';
    if (!matchesCurrentEvidence) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        target,
        'the prepared completion payload no longer matches current deliverable and criteria evidence',
      );
    }
    evidence = deps.verifyPullRequest({
      issueNumber: input.issueNumber,
      pullRequest,
      expectedHeadSha: String(storedResult.headSha),
      expectedMergeCommitSha: String(storedResult.mergeCommitSha),
      verifiedAt: String(storedResult.verifiedAt),
    });
    if (!evidence.verified) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        target,
        `the persisted completion evidence could not be independently reverified: ${evidence.reason}`,
      );
    }
    const reverifiedMatchesStored =
      evidence.reference === storedResult.reference &&
      evidence.headSha === storedResult.headSha &&
      evidence.mergeCommitSha === storedResult.mergeCommitSha &&
      evidence.verifiedAt === storedResult.verifiedAt;
    if (!reverifiedMatchesStored) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        target,
        'the independent deliverable verification no longer matches the prepared completion record',
      );
    }
    record = prepared.operation.record;
    body = prepared.operation.body;
    if (!markPendingOperationAttempted(prepared.operation)) {
      return pendingOperationReport(
        input,
        fresh,
        label,
        target,
        'another invocation already attempted this completion operation',
      );
    }
    postAttempted = true;
    const post = deps.postComment(input.issueNumber, body);
    const after = buildFreshState(input.issueNumber, deps);
    const recordPresent = exactRecord(after, record, body) === 'exact';
    if (
      !recordPresent ||
      !after.replay.valid ||
      after.replay.status !== 'confirmation-pending'
    ) {
      checks.push({
        name: 'post-readback-and-replay',
        passed: false,
        detail:
          'POST returned but the exact completion did not replay as confirmation-pending',
      });
      return makeReport(
        input,
        'partial',
        after.replay.status,
        target,
        checks,
        label,
        labelsContain(after.item.labels, label),
        false,
        false,
        `Inspect comment ${post.htmlUrl}; keep the source open and do not confirm until replay is valid.`,
      );
    }
    checks.push({
      name: 'post-readback-and-replay',
      passed: true,
      detail: `comment #${post.id} was read back and verified completion replays as confirmation-pending`,
    });
    clearPendingOperation(deps, input.issueNumber, record.recordId);
    return ensureCompletionLabel(
      input,
      deps,
      after,
      record,
      target,
      checks,
      false,
      label,
      labelsContain(after.item.labels, label),
    );
  } catch (error) {
    if (!postAttempted) {
      checks.push({
        name: 'prewrite-revalidation',
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return failReport(
        input.issueNumber,
        input.action,
        state.replay.status,
        checks,
        label,
        labelPresent,
        'Resolve source, claim, or deliverable drift, then rerun a fresh dry-run; no completion record was posted.',
        target,
      );
    }
    let after = null;
    try {
      after = buildFreshState(input.issueNumber, deps);
    } catch {
      /* unresolved */
    }
    const matches = after ? recordById(after.records, record.recordId) : [];
    const exact = matches.length === 1 && matches[0]?.comment.body === body;
    const replayed = Boolean(
      exact &&
        after?.replay.valid &&
        after.replay.status === 'confirmation-pending',
    );
    if (replayed) {
      clearPendingOperation(deps, input.issueNumber, record.recordId);
    }
    checks.push({
      name: 'uncertain-post-recovery',
      passed: replayed,
      detail: replayed
        ? 'the exact completion operation was found and replayed after an uncertain POST'
        : error instanceof Error
          ? error.message
          : String(error),
    });
    if (!replayed || !after || !matches[0]) {
      return makeReport(
        input,
        'partial',
        after?.replay.status ?? state.replay.status,
        target,
        checks,
        label,
        after ? labelsContain(after.item.labels, label) : labelPresent,
        false,
        false,
        'The completion POST is unresolved; reread the full history and do not close the source or repost a different operation.',
      );
    }
    return ensureCompletionLabel(
      input,
      deps,
      after,
      matches[0].record,
      target,
      checks,
      true,
      label,
      labelsContain(after.item.labels, label),
    );
  }
}
function ensureCompletionLabel(
  input,
  deps,
  state,
  record,
  target,
  checks,
  reconciled,
  label,
  labelPresent,
) {
  try {
    state = buildFreshState(input.issueNumber, deps);
    labelPresent = labelsContain(state.item.labels, label);
  } catch (error) {
    checks.push({
      name: 'completion-lifecycle-readback',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return makeReport(
      input,
      'partial',
      state.replay.status,
      target,
      checks,
      label,
      false,
      false,
      false,
      'The completion record is durable, but the current open source state could not be verified; reread the issue before retrying.',
    );
  }
  if (!completionReplayIsPending(state, target, label)) {
    checks.push({
      name: 'completion-lifecycle-current',
      passed: false,
      detail:
        'the completion is no longer pending explicit confirmation; the current lifecycle must be followed',
    });
    return makeReport(
      input,
      'partial',
      state.replay.status,
      target,
      checks,
      label,
      labelPresent,
      false,
      false,
      'Do not treat this completion as finalized; follow the current confirmation or rework lifecycle.',
    );
  }
  let applied = false;
  if (labelPresent) {
    checks.push({
      name: 'needs-decision-label',
      passed: true,
      detail: `${label} is present on the open source issue`,
    });
    return makeReport(
      input,
      reconciled ? 'reconciled' : 'applied',
      'confirmation-pending',
      target,
      checks,
      label,
      true,
      false,
      true,
      'The source remains open with its needs-decision label; await explicit confirmation through the separate lifecycle.',
    );
  }
  if (!input.apply) {
    checks.push({
      name: 'needs-decision-label',
      passed: false,
      detail: `${label} is absent; dry-run made no label change`,
    });
    return makeReport(
      input,
      'planned',
      'confirmation-pending',
      target,
      checks,
      label,
      false,
      false,
      false,
      'Rerun with --apply to add and verify the configured needs-decision label.',
    );
  }
  try {
    const fresh = buildFreshState(input.issueNumber, deps);
    if (!assertTrustedRecordAuthor(fresh, checks)) {
      return makeReport(
        input,
        'partial',
        fresh.replay.status,
        target,
        checks,
        label,
        labelsContain(fresh.item.labels, label),
        false,
        false,
        'The completion record is durable, but the authenticated viewer is not a trusted marker actor; rerun with a trusted actor to reconcile the label.',
      );
    }
    if (
      fresh.item.state !== 'OPEN' ||
      fresh.source.snapshot.bodySha256 !== state.source.snapshot.bodySha256 ||
      !fresh.replay.valid ||
      fresh.replay.status !== 'confirmation-pending' ||
      fresh.authority.needsDecisionLabelName !== label ||
      recordById(fresh.records, record.recordId).length !== 1
    ) {
      throw new Error(
        'source state or completion replay changed before label application',
      );
    }
    if (!assertCurrentClaim(input, deps, checks)) {
      checks.push({
        name: 'needs-decision-label',
        passed: false,
        detail: 'claim lost before label application',
      });
      return makeReport(
        input,
        'partial',
        fresh.replay.status,
        target,
        checks,
        label,
        labelsContain(fresh.item.labels, label),
        false,
        false,
        'The completion record is durable, but label application is held; reacquire the claim and rerun to reconcile.',
      );
    }
    deps.addLabel(input.issueNumber, label);
    applied = true;
    const after = buildFreshState(input.issueNumber, deps);
    const present = labelsContain(after.item.labels, label);
    const completionStillValid = completionReplayIsPending(
      after,
      target,
      label,
    );
    checks.push({
      name: 'needs-decision-label',
      passed: present && completionStillValid && after.item.state === 'OPEN',
      detail:
        present && completionStillValid && after.item.state === 'OPEN'
          ? `${label} was read back on the open source issue`
          : `label or confirmation-pending postcondition failed; present=${present}, issueState=${after.item.state}`,
    });
    return makeReport(
      input,
      present && completionStillValid && after.item.state === 'OPEN'
        ? reconciled
          ? 'reconciled'
          : 'applied'
        : 'partial',
      after.replay.status,
      target,
      checks,
      label,
      present,
      applied,
      present && completionStillValid && after.item.state === 'OPEN',
      present && completionStillValid && after.item.state === 'OPEN'
        ? 'The source remains open with its needs-decision label; await explicit confirmation through the separate lifecycle.'
        : 'The completion record is durable but finalization is incomplete; reread issue state and label, then rerun the same operation.',
    );
  } catch (error) {
    let after = null;
    try {
      after = buildFreshState(input.issueNumber, deps);
    } catch {
      /* unresolved */
    }
    const present = after ? labelsContain(after.item.labels, label) : false;
    const finalized = Boolean(
      after && present && completionReplayIsPending(after, target, label),
    );
    checks.push({
      name: 'needs-decision-label-recovery',
      passed: finalized,
      detail: finalized
        ? 'the label was found after an uncertain label-write result'
        : error instanceof Error
          ? error.message
          : String(error),
    });
    return makeReport(
      input,
      finalized ? 'reconciled' : 'partial',
      after?.replay.status ?? 'confirmation-pending',
      target,
      checks,
      label,
      present,
      applied,
      finalized,
      finalized
        ? 'The same completion and label are now verified; await explicit confirmation.'
        : 'Completion is recorded but label state is partial or unreadable; keep the source open and rerun this same generation to reconcile.',
    );
  }
}
function productionDependencies(owner, repo, cwd) {
  const port = createGithubProviderAdapter(owner, repo);
  return {
    owner,
    repo,
    cwd,
    getWorkItem: (issueNumber) => port.getWorkItem(issueNumber),
    listComments: (issueNumber) =>
      port.listWorkItemComments(issueNumber, { includeEditState: true }),
    postComment: (issueNumber, body) =>
      postProvisionalDecisionCommentOnce(owner, repo, issueNumber, body),
    reopenWorkItem: (issueNumber) => {
      const response = ghApiJson(
        `repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          extraArgs: ['--method', 'PATCH', '--input', '-'],
          input: JSON.stringify({ state: 'open' }),
        },
      );
      if (String(response?.state ?? '').toUpperCase() !== 'OPEN') {
        throw new Error('source issue reopen did not return state OPEN');
      }
    },
    readAuthority: (_issueNumber, comments = [], viewerLogin = '') => {
      const ref = selectTrustedConfigRef(
        '',
        readGithubRepoDefaultBranch(owner, repo),
      );
      const fetchConfig = (fetchOwner, fetchRepo, fetchRef) =>
        ghText([
          'api',
          `repos/${fetchOwner}/${fetchRepo}/contents/.github/idd/config.json?ref=${encodeURIComponent(fetchRef)}`,
          '--jq',
          '.content',
        ]);
      const fetchSchema = (fetchOwner, fetchRepo, fetchRef) =>
        fetchEncodedPolicySchemaAtTrustedRef(fetchOwner, fetchRepo, fetchRef);
      const autoDecide = readTrustedDangerouslyAutoDecide({
        owner,
        repo,
        baseRefName: ref,
        readDefaultBranch: () => ref,
        fetchEncodedConfig: fetchConfig,
        fetchEncodedPolicySchema: fetchSchema,
      });
      const config = loadTrustedIddConfig(
        owner,
        repo,
        ref,
        fetchConfig,
        undefined,
        { userGlobalFallback: false },
      );
      const normalized = normalizePolicyConfig(config);
      const trusted = resolveTrustedMarkerActors({
        envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
        config,
      }).actors;
      const allowCollaboratorMarkers = resolveCollaboratorMarkerTrust(
        config,
        process.env.IDD_TRUST_COLLABORATOR_MARKERS,
      );
      const collaboratorMarkers =
        allowCollaboratorMarkers && comments.length > 0
          ? resolveTrustedProvisionalDecisionCollaboratorMarkerLogins(
              comments,
              true,
              (login) => port.getCollaboratorPermission(login),
              [viewerLogin],
            )
          : [];
      return {
        status: autoDecide.status,
        enabled: autoDecide.enabled,
        ref,
        trustedMarkerActors: [...new Set([...trusted, ...collaboratorMarkers])],
        allowCollaboratorMarkers,
        needsDecisionLabelName: normalized.labels.needsDecisionLabelName,
        ...(autoDecide.error ? { error: autoDecide.error } : {}),
      };
    },
    viewerLogin: () => port.resolveViewerLogin(),
    assertClaim: ({ issueNumber, claimId, agentId, nonce, cwd: worktree }) => {
      const root = resolveBundleRoot(import.meta.dirname);
      const script = join(root, 'bin', 'idd-resume-claim-routing.mjs');
      const result = spawnSync(
        process.execPath,
        [
          script,
          '--issue',
          String(issueNumber),
          '--claim-id',
          claimId,
          '--nonce',
          nonce,
          '--assert',
          '--worktree',
          worktree,
          '--format',
          'json',
        ],
        {
          cwd: worktree,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      if (result.status !== 0 || result.error) {
        throw new Error(
          String(
            result.stderr ||
              result.error?.message ||
              `claim assertion exited ${result.status}`,
          ).trim(),
        );
      }
      let report;
      try {
        report = JSON.parse(result.stdout);
      } catch {
        throw new Error('claim assertion did not return JSON');
      }
      if (
        report.state !== 'already_owned' ||
        report.action !== 'keep' ||
        report.active_claim?.claim_id !== claimId ||
        report.active_claim?.agent_id !== agentId
      ) {
        throw new Error(
          'fresh claim assertion did not confirm exact ownership',
        );
      }
    },
    verifyPullRequest: (request) => {
      try {
        const snapshot = port.getChangeRequestReadinessSnapshot(
          request.pullRequest,
        );
        if (!snapshot.url || !isHttpUrl(snapshot.url)) {
          return {
            verified: false,
            reason: 'pull request URL is missing or invalid',
          };
        }
        if (
          !isValidPullRequestLink(
            snapshot.closingIssuesReferences,
            request.issueNumber,
          )
        ) {
          return {
            verified: false,
            reason: `pull request does not close issue #${request.issueNumber}`,
          };
        }
        const outcome = port.getChangeRequestOutcomeAtRepo(
          owner,
          repo,
          request.pullRequest,
        );
        const meta = port.getMergedChangeRequestMeta(request.pullRequest);
        if (outcome?.state !== 'MERGED' || !outcome.mergedAt || !meta?.merged) {
          return {
            verified: false,
            reason:
              'pull request is not merged; a closed-unmerged PR is not completion',
          };
        }
        const headSha = meta.headRefOid || outcome.headRefOid;
        const mergeCommitSha = meta.mergeCommitOid;
        if (!isFullSha(headSha) || !isFullSha(mergeCommitSha)) {
          return {
            verified: false,
            reason:
              'merged pull request is missing full head or merge commit SHA evidence',
          };
        }
        if (
          (request.expectedHeadSha && request.expectedHeadSha !== headSha) ||
          (request.expectedMergeCommitSha &&
            request.expectedMergeCommitSha !== mergeCommitSha) ||
          (request.verifiedAt &&
            !Number.isFinite(Date.parse(request.verifiedAt)))
        ) {
          return {
            verified: false,
            reason:
              'pull request head, merge commit, or recorded verification time is stale',
          };
        }
        const checks = port.listRequiredChecksSummary(request.pullRequest);
        const badChecks = checks.checks.filter(
          (check) =>
            !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(
              check.state.toUpperCase(),
            ) || !check.completedAt,
        );
        if (badChecks.length > 0) {
          return {
            verified: false,
            reason: `required validation is failing or incomplete: ${badChecks.map((check) => `${check.name}=${check.state || 'unknown'}`).join(', ')}`,
          };
        }
        const finalMeta = port.getMergedChangeRequestMeta(request.pullRequest);
        const finalHead = port.getChangeRequestHeadShaAtRepo(
          owner,
          repo,
          request.pullRequest,
        );
        if (
          !finalMeta?.merged ||
          finalMeta.headRefOid !== headSha ||
          finalMeta.mergeCommitOid !== mergeCommitSha ||
          finalHead !== headSha
        ) {
          return {
            verified: false,
            reason:
              'pull request head or merge evidence changed during verification',
          };
        }
        return {
          verified: true,
          reason: checks.noRequiredChecksConfigured
            ? 'linked PR is merged with a stable current head and no failing required checks are configured'
            : `linked PR is merged with stable current head and ${checks.checks.length} passing required check(s)`,
          reference: snapshot.url,
          verifiedAt: request.verifiedAt || new Date().toISOString(),
          headSha,
          mergeCommitSha,
          checkReferences: [`${snapshot.url}/checks`],
        };
      } catch (error) {
        return {
          verified: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    addLabel: (issueNumber, labelName) => {
      ghApiJson(`repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
        extraArgs: ['--method', 'POST', '--input', '-'],
        input: JSON.stringify({ labels: [labelName] }),
      });
    },
    now: () => new Date().toISOString(),
  };
}
function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value);
}
function parseInput(argv) {
  const parsed = parseCliArgs(argv, FLAG_SPEC);
  const args = parsed.values;
  if (parsed.help) return { help: true };
  const issueNumber = parseCanonicalIntegerOrNull(
    typeof args.issue === 'string' ? args.issue : undefined,
  );
  if (!issueNumber)
    throw markCliUsageError(
      new Error('--issue is required and must be a positive integer'),
    );
  const action = String(args.action ?? '');
  if (!['select', 'start', 'complete'].includes(action)) {
    throw markCliUsageError(
      new Error('--action must be select, start, or complete'),
    );
  }
  const claimId = String(args['claim-id'] ?? '').trim();
  const agentId = String(args['agent-id'] ?? '').trim();
  const nonce = String(args.nonce ?? '').trim();
  if (!claimId || !agentId || !nonce) {
    throw markCliUsageError(
      new Error('--claim-id, --agent-id, and --nonce are required'),
    );
  }
  let payload = {};
  if (typeof args.input === 'string') {
    try {
      payload = JSON.parse(readFileSync(resolve(args.input), 'utf8'));
    } catch (error) {
      throw markCliUsageError(
        new Error(
          `cannot read JSON input: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  } else if (action !== 'complete') {
    throw markCliUsageError(
      new Error('--input is required for select and start'),
    );
  }
  const bundleGeneration =
    parseCanonicalIntegerOrNull(
      typeof args['bundle-generation'] === 'string'
        ? args['bundle-generation']
        : undefined,
    ) ?? undefined;
  const decisionGeneration =
    parseCanonicalIntegerOrNull(
      typeof args['decision-generation'] === 'string'
        ? args['decision-generation']
        : undefined,
    ) ?? undefined;
  if (Boolean(bundleGeneration) !== Boolean(decisionGeneration)) {
    throw markCliUsageError(
      new Error(
        '--bundle-generation and --decision-generation must be supplied together',
      ),
    );
  }
  if (action !== 'select' && (!bundleGeneration || !decisionGeneration)) {
    throw markCliUsageError(
      new Error(
        '--bundle-generation and --decision-generation are required for start and complete',
      ),
    );
  }
  const pullRequest =
    parseCanonicalIntegerOrNull(
      typeof args['pull-request'] === 'string'
        ? args['pull-request']
        : undefined,
    ) ?? undefined;
  const expectedHeadSha =
    typeof args['expected-head-sha'] === 'string'
      ? args['expected-head-sha'].toLowerCase()
      : undefined;
  if (expectedHeadSha && !isFullSha(expectedHeadSha)) {
    throw markCliUsageError(
      new Error('--expected-head-sha must be a full 40-character SHA'),
    );
  }
  return {
    help: false,
    input: {
      issueNumber,
      action: action,
      apply: args.apply === true,
      claimId,
      agentId,
      nonce,
      ...(bundleGeneration ? { bundleGeneration } : {}),
      ...(decisionGeneration ? { decisionGeneration } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      ...(expectedHeadSha ? { expectedHeadSha } : {}),
      payload,
    },
  };
}
function main() {
  const parsed = parseInput(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const repository = resolveCurrentGithubRepository();
  const dependencies = productionDependencies(
    repository.owner,
    repository.repo,
    process.cwd(),
  );
  const report = runProvisionalDecision(parsed.input, dependencies);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.outcome === 'refused' || report.outcome === 'partial') {
    return { exitCode: 1, kind: 'gate', message: report.nextAction };
  }
  return 0;
}
export function runProvisionalDecision(input, deps) {
  if (input.action === 'select') return selectAction(input, deps);
  if (input.action === 'start') return startAction(input, deps);
  return completeAction(input, deps);
}
export function postProvisionalDecisionCommentOnce(
  owner,
  repo,
  issueNumber,
  body,
  request = ghApiJson,
) {
  // The helper performs full-history readback and replay after an uncertain
  // result. The provider adapter's generic comment writer retries transient
  // failures, which could post the same transition before that replay runs.
  const response = request(
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      extraArgs: ['--method', 'POST', '--input', '-'],
      input: JSON.stringify({ body }),
    },
  );
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('comment POST returned a malformed response');
  }
  const row = response;
  const id = Number(row.id);
  const htmlUrl = String(row.html_url ?? '');
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !isHttpUrl(htmlUrl) ||
    String(row.body ?? '') !== body
  ) {
    throw new Error(
      'comment POST response did not verify the exact submitted body',
    );
  }
  return { id, htmlUrl };
}
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('provisional-decision', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}
