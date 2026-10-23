// idd-generated-from: src/scripts/provisional-decision-state.mts
//
// The scripts/provisional-decision-state.mjs copy is generated from this
// source by `pnpm run build`. Edit this .mts, never the generated .mjs. See
// docs/typescript-sources.md.
/**
 * Pure parser and replay evaluator for the append-only provisional-decision
 * record stream. GitHub metadata, trusted-author policy, claim lineage, and
 * verified work are resolved by the caller and supplied as evidence.
 */
export const PROVISIONAL_DECISION_RECORD_MARKER =
  '<!-- idd-provisional-decision-record:v1 -->';
export const PROVISIONAL_DECISION_ANSWER_MARKER =
  '<!-- idd-provisional-decision-agent-answer:v1 -->';
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactObject(value, required, optional, path, issues) {
  if (!isObject(value)) {
    issues.push({
      code: 'object-required',
      path,
      message: 'Expected an object.',
    });
    return undefined;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      issues.push({
        code: 'required-field',
        path: `${path}.${key}`,
        message: 'Required field is missing.',
      });
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({
        code: 'unexpected-field',
        path: `${path}.${key}`,
        message: 'Field is not allowed by the closed record shape.',
      });
    }
  }
  return value;
}
function nonEmptyString(value, path, issues) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push({
      code: 'string-required',
      path,
      message: 'Expected a non-empty string.',
    });
    return false;
  }
  return true;
}
function dateTime(value, path, issues) {
  if (typeof value !== 'string' || !parseRfc3339Instant(value)) {
    issues.push({
      code: 'date-time-required',
      path,
      message: 'Expected an RFC 3339 date-time.',
    });
    return false;
  }
  return true;
}
function daysBeforeYear(year) {
  return (
    365 * year +
    Math.floor((year + 3) / 4) -
    Math.floor((year + 99) / 100) +
    Math.floor((year + 399) / 400)
  );
}
function parseRfc3339Instant(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const daysInMonth = monthLengths[month - 1];
  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }
  const daysInPriorMonths = monthLengths
    .slice(0, month - 1)
    .reduce((total, length) => total + length, 0);
  const daysSinceEpoch =
    daysBeforeYear(year) + daysInPriorMonths + day - 1 - daysBeforeYear(1970);
  const offsetSign = match[8] === '+' ? 1 : match[8] === '-' ? -1 : 0;
  const offsetSeconds = offsetSign * (offsetHour * 60 + offsetMinute) * 60;
  return {
    epochSeconds:
      daysSinceEpoch * 86400 +
      hour * 3600 +
      minute * 60 +
      second -
      offsetSeconds,
    fraction: (match[7] ?? '').replace(/0+$/u, ''),
  };
}
function compareDateTimes(left, right) {
  const leftInstant = parseRfc3339Instant(left);
  const rightInstant = parseRfc3339Instant(right);
  if (!leftInstant || !rightInstant) return undefined;
  if (leftInstant.epochSeconds !== rightInstant.epochSeconds) {
    return leftInstant.epochSeconds < rightInstant.epochSeconds ? -1 : 1;
  }
  const fractionLength = Math.max(
    leftInstant.fraction.length,
    rightInstant.fraction.length,
  );
  for (let index = 0; index < fractionLength; index += 1) {
    const leftDigit = leftInstant.fraction[index] ?? '0';
    const rightDigit = rightInstant.fraction[index] ?? '0';
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}
function commentPrecedes(earlier, later, commentIndexes) {
  const timeOrder = compareDateTimes(earlier.createdAt, later.createdAt);
  if (timeOrder === undefined) return false;
  if (timeOrder !== 0) return timeOrder < 0;
  const earlierIndex = commentIndexes.get(earlier.id);
  const laterIndex = commentIndexes.get(later.id);
  return (
    earlierIndex !== undefined &&
    laterIndex !== undefined &&
    earlierIndex < laterIndex
  );
}
function httpUrl(value, path, issues) {
  if (typeof value !== 'string' || /\s/u.test(value)) {
    issues.push({
      code: 'url-required',
      path,
      message: 'Expected an HTTP(S) URL.',
    });
    return false;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname
    ) {
      return true;
    }
  } catch {
    // Report the uniform shape error below.
  }
  issues.push({
    code: 'url-required',
    path,
    message: 'Expected an HTTP(S) URL.',
  });
  return false;
}
function positiveSafeInteger(value, path, issues) {
  if (!Number.isSafeInteger(value) || value < 1) {
    issues.push({
      code: 'positive-safe-integer-required',
      path,
      message: 'Expected a positive safe integer.',
    });
    return false;
  }
  return true;
}
function checkStringFields(value, keys, path, issues) {
  for (const key of keys) nonEmptyString(value[key], `${path}.${key}`, issues);
}
function validateSource(value, path, issues) {
  const source = exactObject(
    value,
    ['repository', 'issueNumber', 'snapshot'],
    [],
    path,
    issues,
  );
  if (!source) return;
  if (
    typeof source.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository)
  ) {
    issues.push({
      code: 'repository-invalid',
      path: `${path}.repository`,
      message: 'Expected an owner/repository slug.',
    });
  }
  positiveSafeInteger(source.issueNumber, `${path}.issueNumber`, issues);
  const snapshot = exactObject(
    source.snapshot,
    ['title', 'bodySha256', 'updatedAt'],
    [],
    `${path}.snapshot`,
    issues,
  );
  if (!snapshot) return;
  nonEmptyString(snapshot.title, `${path}.snapshot.title`, issues);
  if (
    typeof snapshot.bodySha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(snapshot.bodySha256)
  ) {
    issues.push({
      code: 'sha256-required',
      path: `${path}.snapshot.bodySha256`,
      message: 'Expected a lowercase SHA-256 digest.',
    });
  }
  dateTime(snapshot.updatedAt, `${path}.snapshot.updatedAt`, issues);
}
function validateClaimLineage(value, path, issues, commentIndexes) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({
      code: 'claim-lineage-required',
      path,
      message: 'Expected a non-empty claim lineage.',
    });
    return;
  }
  const ids = new Set();
  let priorClaimedAt;
  let priorCommentIndex;
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const claim = exactObject(
      entry,
      ['claimId', 'agentId', 'branch', 'claimedAt'],
      commentIndexes ? ['supersedes', 'commentId'] : ['supersedes'],
      entryPath,
      issues,
    );
    if (!claim) return;
    let commentIndex;
    if (claim.commentId !== undefined) {
      nonEmptyString(claim.commentId, `${entryPath}.commentId`, issues);
      if (typeof claim.commentId === 'string') {
        commentIndex = commentIndexes?.get(claim.commentId);
        if (commentIndexes && commentIndex === undefined) {
          issues.push({
            code: 'claim-comment-missing',
            path: `${entryPath}.commentId`,
            message:
              'A verified claim comment must appear in the complete history.',
          });
        }
      }
    }
    checkStringFields(
      claim,
      ['claimId', 'agentId', 'branch'],
      entryPath,
      issues,
    );
    if (
      typeof claim.branch === 'string' &&
      !/^issue\/[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(claim.branch)
    ) {
      issues.push({
        code: 'branch-invalid',
        path: `${entryPath}.branch`,
        message: 'Expected a canonical issue branch.',
      });
    }
    dateTime(claim.claimedAt, `${entryPath}.claimedAt`, issues);
    if (typeof claim.claimedAt === 'string') {
      const timeOrder =
        priorClaimedAt === undefined
          ? undefined
          : compareDateTimes(claim.claimedAt, priorClaimedAt);
      if (
        timeOrder !== undefined &&
        (timeOrder < 0 ||
          (commentIndexes !== undefined &&
            timeOrder === 0 &&
            (commentIndex === undefined ||
              priorCommentIndex === undefined ||
              commentIndex <= priorCommentIndex)))
      ) {
        issues.push({
          code: 'claim-lineage-order-invalid',
          path: `${entryPath}.claimedAt`,
          message:
            commentIndexes === undefined
              ? 'Claims must be in non-decreasing server-time order.'
              : 'Claims must be in server-time order, using comment order when timestamps tie.',
        });
      }
      if (parseRfc3339Instant(claim.claimedAt)) {
        priorClaimedAt = claim.claimedAt;
        priorCommentIndex = commentIndex;
      }
    }
    if (claim.supersedes !== undefined)
      nonEmptyString(claim.supersedes, `${entryPath}.supersedes`, issues);
    if (typeof claim.claimId === 'string') {
      if (ids.has(claim.claimId)) {
        issues.push({
          code: 'duplicate-claim-id',
          path: `${entryPath}.claimId`,
          message: 'Claim IDs must be unique in a lineage.',
        });
      }
      ids.add(claim.claimId);
    }
  });
}
function validateOption(value, path, alternative, issues) {
  const required = [
    'id',
    'description',
    'feasibilityRationale',
    'requirementFit',
    'consequences',
    'verification',
    'reversalOrMigration',
    ...(alternative ? ['comparison', 'rejectionReason'] : ['rationale']),
  ];
  const option = exactObject(value, required, [], path, issues);
  if (option) checkStringFields(option, required, path, issues);
}
function validateEvent(value, issues) {
  if (!isObject(value) || typeof value.type !== 'string') {
    issues.push({
      code: 'event-required',
      path: '$.event',
      message: 'Expected an event object with a type.',
    });
    return;
  }
  const event = value;
  switch (event.type) {
    case 'selected': {
      const shape = exactObject(
        event,
        [
          'type',
          'question',
          'selectedOption',
          'feasibleAlternatives',
          'executionCriteria',
        ],
        [],
        '$.event',
        issues,
      );
      if (!shape) return;
      nonEmptyString(shape.question, '$.event.question', issues);
      validateOption(
        shape.selectedOption,
        '$.event.selectedOption',
        false,
        issues,
      );
      if (
        !Array.isArray(shape.feasibleAlternatives) ||
        shape.feasibleAlternatives.length === 0
      ) {
        issues.push({
          code: 'alternatives-required',
          path: '$.event.feasibleAlternatives',
          message: 'At least one feasible alternative is required.',
        });
      } else {
        const alternativeIds = new Set();
        shape.feasibleAlternatives.forEach((alternative, index) => {
          const path = `$.event.feasibleAlternatives[${index}]`;
          validateOption(alternative, path, true, issues);
          if (isObject(alternative) && typeof alternative.id === 'string') {
            if (
              alternative.id ===
                (isObject(shape.selectedOption)
                  ? shape.selectedOption.id
                  : undefined) ||
              alternativeIds.has(alternative.id)
            ) {
              issues.push({
                code: 'duplicate-option-id',
                path: `${path}.id`,
                message: 'Option IDs must be unique within a decision.',
              });
            }
            alternativeIds.add(alternative.id);
          }
        });
      }
      if (
        !Array.isArray(shape.executionCriteria) ||
        shape.executionCriteria.length === 0
      ) {
        issues.push({
          code: 'execution-criteria-required',
          path: '$.event.executionCriteria',
          message: 'At least one execution criterion is required.',
        });
      } else {
        shape.executionCriteria.forEach((criterion, index) => {
          nonEmptyString(
            criterion,
            `$.event.executionCriteria[${index}]`,
            issues,
          );
        });
      }
      return;
    }
    case 'work-started': {
      const shape = exactObject(
        event,
        ['type', 'startedAt', 'planReference'],
        [],
        '$.event',
        issues,
      );
      if (shape) {
        dateTime(shape.startedAt, '$.event.startedAt', issues);
        httpUrl(shape.planReference, '$.event.planReference', issues);
      }
      return;
    }
    case 'work-completed': {
      const shape = exactObject(
        event,
        ['type', 'result'],
        [],
        '$.event',
        issues,
      );
      if (!shape) return;
      if (!isObject(shape.result)) {
        issues.push({
          code: 'result-required',
          path: '$.event.result',
          message: 'Expected a completion result object.',
        });
        return;
      }
      const result = shape.result;
      if (result.kind === 'merged-pull-request') {
        exactObject(
          result,
          ['kind', 'reference', 'verifiedAt', 'headSha', 'mergeCommitSha'],
          [],
          '$.event.result',
          issues,
        );
        httpUrl(result.reference, '$.event.result.reference', issues);
        dateTime(result.verifiedAt, '$.event.result.verifiedAt', issues);
        if (
          typeof result.headSha !== 'string' ||
          !/^[0-9a-f]{40}$/u.test(result.headSha)
        ) {
          issues.push({
            code: 'sha-required',
            path: '$.event.result.headSha',
            message: 'Expected a lowercase commit SHA.',
          });
        }
        if (
          typeof result.mergeCommitSha !== 'string' ||
          !/^[0-9a-f]{40}$/u.test(result.mergeCommitSha)
        ) {
          issues.push({
            code: 'sha-required',
            path: '$.event.result.mergeCommitSha',
            message: 'Expected a lowercase commit SHA.',
          });
        }
      } else if (result.kind === 'other') {
        exactObject(
          result,
          ['kind', 'reference', 'verifiedAt'],
          [],
          '$.event.result',
          issues,
        );
        httpUrl(result.reference, '$.event.result.reference', issues);
        dateTime(result.verifiedAt, '$.event.result.verifiedAt', issues);
      } else {
        issues.push({
          code: 'completion-kind-invalid',
          path: '$.event.result.kind',
          message: 'Expected merged-pull-request or other.',
        });
      }
      return;
    }
    case 'confirmed': {
      const shape = exactObject(
        event,
        ['type', 'confirmation'],
        [],
        '$.event',
        issues,
      );
      if (!shape) return;
      const confirmation = exactObject(
        shape.confirmation,
        ['commentUrl', 'response', 'confirmedAt'],
        ['confirmedBy'],
        '$.event.confirmation',
        issues,
      );
      if (!confirmation) return;
      httpUrl(
        confirmation.commentUrl,
        '$.event.confirmation.commentUrl',
        issues,
      );
      if (confirmation.response !== 'accepted') {
        issues.push({
          code: 'confirmation-response-invalid',
          path: '$.event.confirmation.response',
          message: 'Only an explicit accepted response is valid.',
        });
      }
      dateTime(
        confirmation.confirmedAt,
        '$.event.confirmation.confirmedAt',
        issues,
      );
      if (confirmation.confirmedBy !== undefined)
        nonEmptyString(
          confirmation.confirmedBy,
          '$.event.confirmation.confirmedBy',
          issues,
        );
      return;
    }
    case 'rework-requested': {
      const shape = exactObject(
        event,
        ['type', 'reworkRequest'],
        [],
        '$.event',
        issues,
      );
      if (!shape) return;
      const request = exactObject(
        shape.reworkRequest,
        ['commentUrl', 'requestedAt', 'requestedOptionId', 'rationale'],
        [],
        '$.event.reworkRequest',
        issues,
      );
      if (!request) return;
      httpUrl(request.commentUrl, '$.event.reworkRequest.commentUrl', issues);
      dateTime(
        request.requestedAt,
        '$.event.reworkRequest.requestedAt',
        issues,
      );
      checkStringFields(
        request,
        ['requestedOptionId', 'rationale'],
        '$.event.reworkRequest',
        issues,
      );
      return;
    }
    case 'rework-authored': {
      const shape = exactObject(
        event,
        ['type', 'reworkRoadmap'],
        [],
        '$.event',
        issues,
      );
      if (!shape) return;
      const roadmap = exactObject(
        shape.reworkRoadmap,
        ['roadmapIssueNumber', 'roadmapMarkerId', 'authoringSetId', 'url'],
        [],
        '$.event.reworkRoadmap',
        issues,
      );
      if (!roadmap) return;
      positiveSafeInteger(
        roadmap.roadmapIssueNumber,
        '$.event.reworkRoadmap.roadmapIssueNumber',
        issues,
      );
      checkStringFields(
        roadmap,
        ['roadmapMarkerId', 'authoringSetId'],
        '$.event.reworkRoadmap',
        issues,
      );
      httpUrl(roadmap.url, '$.event.reworkRoadmap.url', issues);
      return;
    }
    default:
      issues.push({
        code: 'event-type-unsupported',
        path: '$.event.type',
        message: `Unsupported event type: ${event.type}.`,
      });
  }
}
function validateRecordShape(value) {
  const issues = [];
  const record = exactObject(
    value,
    [
      'schemaVersion',
      'recordId',
      'source',
      'bundleGeneration',
      'decisionGeneration',
      'claimLineage',
      'evidenceReferences',
      'event',
    ],
    [],
    '$',
    issues,
  );
  if (!record) return issues;
  if (record.schemaVersion !== 1) {
    issues.push({
      code: 'schema-version-unsupported',
      path: '$.schemaVersion',
      message: 'Only schema version 1 is supported.',
    });
  }
  if (
    typeof record.recordId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(record.recordId)
  ) {
    issues.push({
      code: 'record-id-invalid',
      path: '$.recordId',
      message: 'Expected a stable record ID.',
    });
  }
  validateSource(record.source, '$.source', issues);
  positiveSafeInteger(record.bundleGeneration, '$.bundleGeneration', issues);
  positiveSafeInteger(
    record.decisionGeneration,
    '$.decisionGeneration',
    issues,
  );
  validateClaimLineage(record.claimLineage, '$.claimLineage', issues);
  if (
    !Array.isArray(record.evidenceReferences) ||
    record.evidenceReferences.length === 0
  ) {
    issues.push({
      code: 'evidence-required',
      path: '$.evidenceReferences',
      message: 'At least one evidence reference is required.',
    });
  } else {
    record.evidenceReferences.forEach((reference, index) => {
      httpUrl(reference, `$.evidenceReferences[${index}]`, issues);
    });
  }
  validateEvent(record.event, issues);
  return issues;
}
function isPositiveSafeIntegerToken(token) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(
    token,
  );
  if (!match || match[1] === '-') return false;
  const exponentText = match[4] ?? '0';
  const exponentDigits =
    exponentText.replace(/^[+-]/u, '').replace(/^0+/u, '') || '0';
  if (exponentDigits.length > 4) return false;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024)
    return false;
  const coefficientText = `${match[2]}${match[3] ?? ''}`;
  const coefficient = BigInt(coefficientText);
  if (coefficient === 0n) return false;
  const scale = (match[3]?.length ?? 0) - exponent;
  let value;
  if (scale > 0) {
    if (scale > 1024) return false;
    const divisor = 10n ** BigInt(scale);
    if (coefficient % divisor !== 0n) return false;
    value = coefficient / divisor;
  } else {
    if (-scale > 1024) return false;
    value = coefficient * 10n ** BigInt(-scale);
  }
  return value <= BigInt(Number.MAX_SAFE_INTEGER);
}
function unsafeNumberTokens(json) {
  const unsafe = [];
  const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u;
  let index = 0;
  while (index < json.length) {
    const character = json[index];
    if (character === '"') {
      index++;
      while (index < json.length) {
        if (json[index] === '\\') index += 2;
        else if (json[index] === '"') {
          index++;
          break;
        } else index++;
      }
      continue;
    }
    if (
      character === '-' ||
      (character !== undefined && /\d/u.test(character))
    ) {
      const token = numberPattern.exec(json.slice(index))?.[0];
      if (token) {
        if (!isPositiveSafeIntegerToken(token)) unsafe.push(token);
        index += token.length;
        continue;
      }
    }
    index++;
  }
  return unsafe;
}
function duplicateJsonKeys(json) {
  const duplicates = [];
  const objectKeys = [];
  let index = 0;
  while (index < json.length) {
    const character = json[index];
    if (character === '"') {
      const start = index++;
      while (index < json.length) {
        if (json[index] === '\\') index += 2;
        else if (json[index] === '"') {
          index++;
          break;
        } else index++;
      }
      let separator = index;
      while (separator < json.length && /\s/u.test(json[separator] ?? ''))
        separator++;
      const keys = objectKeys.at(-1);
      if (keys && json[separator] === ':') {
        const key = JSON.parse(json.slice(start, index));
        if (keys.has(key)) duplicates.push(key);
        else keys.add(key);
      }
      continue;
    }
    if (character === '{') objectKeys.push(new Set());
    else if (character === '}') objectKeys.pop();
    index++;
  }
  return duplicates;
}
function parseMarkedJson(body, marker, issues) {
  if (!body.startsWith(marker)) {
    issues.push({
      code: 'marker-required',
      path: '$',
      message: 'The canonical marker must begin at byte zero.',
    });
    return undefined;
  }
  let payload = body.slice(marker.length);
  if (payload.startsWith('\r\n')) payload = payload.slice(2);
  else if (payload.startsWith('\n')) payload = payload.slice(1);
  else {
    issues.push({
      code: 'marker-separator-required',
      path: '$',
      message: 'The marker must be followed by a newline.',
    });
    return undefined;
  }
  if (payload.trim().length === 0) {
    issues.push({
      code: 'json-required',
      path: '$',
      message: 'The marked comment must contain one JSON value.',
    });
    return undefined;
  }
  for (const token of unsafeNumberTokens(payload)) {
    issues.push({
      code: 'integer-token-unsafe',
      path: '$',
      message: `Numeric token ${token} is not a positive safe integer.`,
    });
  }
  if (issues.length > 0) return undefined;
  try {
    const parsed = JSON.parse(payload);
    for (const key of duplicateJsonKeys(payload)) {
      issues.push({
        code: 'json-duplicate-key',
        path: '$',
        message: `JSON object keys must be unique; duplicate key ${JSON.stringify(key)}.`,
      });
    }
    return issues.length === 0 ? parsed : undefined;
  } catch (error) {
    issues.push({
      code: 'json-invalid',
      path: '$',
      message: error instanceof Error ? error.message : 'Invalid JSON.',
    });
    return undefined;
  }
}
/** Parse one canonical provisional-decision record comment. */
export function parseProvisionalDecisionRecordComment(body) {
  const parseIssues = [];
  const value = parseMarkedJson(
    body,
    PROVISIONAL_DECISION_RECORD_MARKER,
    parseIssues,
  );
  if (parseIssues.length > 0) return { ok: false, issues: parseIssues };
  const issues = validateRecordShape(value);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, record: value };
}
function validateAnswerShape(value) {
  const issues = [];
  const answer = exactObject(
    value,
    [
      'schemaVersion',
      'source',
      'bundleGeneration',
      'decisionGenerations',
      'claimIds',
      'presentedBundle',
      'response',
      'answerText',
    ],
    ['requestedOptionId', 'rationale'],
    '$',
    issues,
  );
  if (!answer) return issues;
  if (answer.schemaVersion !== 1) {
    issues.push({
      code: 'schema-version-unsupported',
      path: '$.schemaVersion',
      message: 'Only answer version 1 is supported.',
    });
  }
  validateSource(answer.source, '$.source', issues);
  positiveSafeInteger(answer.bundleGeneration, '$.bundleGeneration', issues);
  if (
    !Array.isArray(answer.decisionGenerations) ||
    answer.decisionGenerations.length === 0
  ) {
    issues.push({
      code: 'decision-generations-required',
      path: '$.decisionGenerations',
      message: 'At least one decision generation is required.',
    });
  } else {
    const seen = new Set();
    answer.decisionGenerations.forEach((generation, index) => {
      positiveSafeInteger(
        generation,
        `$.decisionGenerations[${index}]`,
        issues,
      );
      if (typeof generation === 'number') {
        if (seen.has(generation))
          issues.push({
            code: 'duplicate-decision-generation',
            path: `$.decisionGenerations[${index}]`,
            message: 'Decision generations must be unique.',
          });
        seen.add(generation);
      }
    });
  }
  if (!Array.isArray(answer.claimIds) || answer.claimIds.length === 0) {
    issues.push({
      code: 'claim-ids-required',
      path: '$.claimIds',
      message: 'At least one verified claim ID is required.',
    });
  } else {
    const seen = new Set();
    answer.claimIds.forEach((claimId, index) => {
      nonEmptyString(claimId, `$.claimIds[${index}]`, issues);
      if (typeof claimId === 'string') {
        if (seen.has(claimId))
          issues.push({
            code: 'duplicate-claim-id',
            path: `$.claimIds[${index}]`,
            message: 'Claim IDs must be unique.',
          });
        seen.add(claimId);
      }
    });
  }
  if (
    !Array.isArray(answer.presentedBundle) ||
    answer.presentedBundle.length === 0
  ) {
    issues.push({
      code: 'presented-bundle-required',
      path: '$.presentedBundle',
      message: 'The presented bundle must contain every current decision.',
    });
  } else {
    answer.presentedBundle.forEach((entry, index) => {
      const path = `$.presentedBundle[${index}]`;
      const decision = exactObject(
        entry,
        [
          'decisionGeneration',
          'question',
          'selectedOptionId',
          'feasibleAlternativeIds',
          'workCompletedRecordId',
          'result',
        ],
        [],
        path,
        issues,
      );
      if (!decision) return;
      positiveSafeInteger(
        decision.decisionGeneration,
        `${path}.decisionGeneration`,
        issues,
      );
      checkStringFields(
        decision,
        ['question', 'selectedOptionId', 'workCompletedRecordId'],
        path,
        issues,
      );
      if (
        !Array.isArray(decision.feasibleAlternativeIds) ||
        decision.feasibleAlternativeIds.length === 0
      ) {
        issues.push({
          code: 'alternatives-required',
          path: `${path}.feasibleAlternativeIds`,
          message:
            'The presented decision must include its feasible alternatives.',
        });
      } else {
        decision.feasibleAlternativeIds.forEach((id, alternativeIndex) => {
          nonEmptyString(
            id,
            `${path}.feasibleAlternativeIds[${alternativeIndex}]`,
            issues,
          );
        });
      }
      if (!isObject(decision.result)) {
        issues.push({
          code: 'result-required',
          path: `${path}.result`,
          message:
            'The presented decision must include verified completion evidence.',
        });
      }
    });
  }
  if (answer.response === 'accepted') {
    if (
      answer.requestedOptionId !== undefined ||
      answer.rationale !== undefined
    ) {
      issues.push({
        code: 'answer-response-shape-invalid',
        path: '$',
        message: 'An accepted response cannot carry rework fields.',
      });
    }
  } else if (answer.response === 'rework') {
    nonEmptyString(answer.requestedOptionId, '$.requestedOptionId', issues);
    nonEmptyString(answer.rationale, '$.rationale', issues);
  } else {
    issues.push({
      code: 'answer-response-invalid',
      path: '$.response',
      message: 'Expected accepted or rework.',
    });
  }
  nonEmptyString(answer.answerText, '$.answerText', issues);
  return issues;
}
function parseAnswerComment(body) {
  const parseIssues = [];
  const value = parseMarkedJson(
    body,
    PROVISIONAL_DECISION_ANSWER_MARKER,
    parseIssues,
  );
  if (parseIssues.length > 0) return { ok: false, issues: parseIssues };
  const issues = validateAnswerShape(value);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, answer: value };
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
function sameValue(left, right) {
  return stableJson(left) === stableJson(right);
}
function sameRepositoryName(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}
function sameGitHubIssuePathname(left, right) {
  const leftParts = left.split('/');
  const rightParts = right.split('/');
  return (
    leftParts.length >= 4 &&
    leftParts.length === rightParts.length &&
    leftParts[0] === '' &&
    rightParts[0] === '' &&
    sameRepositoryName(
      `${leftParts[1]}/${leftParts[2]}`,
      `${rightParts[1]}/${rightParts[2]}`,
    ) &&
    leftParts.slice(3).join('/') === rightParts.slice(3).join('/')
  );
}
function sameGitHubIssueUrl(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === 'https:' &&
      rightUrl.protocol === 'https:' &&
      leftUrl.hostname === 'github.com' &&
      rightUrl.hostname === 'github.com' &&
      leftUrl.port === '' &&
      rightUrl.port === '' &&
      leftUrl.username === '' &&
      rightUrl.username === '' &&
      leftUrl.password === '' &&
      rightUrl.password === '' &&
      leftUrl.search === rightUrl.search &&
      leftUrl.hash === rightUrl.hash &&
      sameGitHubIssuePathname(leftUrl.pathname, rightUrl.pathname)
    );
  } catch {
    return false;
  }
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
function sameSourceContent(left, right) {
  return (
    sameRepositoryName(left.repository, right.repository) &&
    left.issueNumber === right.issueNumber &&
    left.snapshot.title === right.snapshot.title &&
    left.snapshot.bodySha256 === right.snapshot.bodySha256
  );
}
function claimLineageAt(verifiedClaims, createdAt, commentId, commentIndexes) {
  if (!parseRfc3339Instant(createdAt)) return undefined;
  const eventIndex = commentIndexes.get(commentId);
  if (eventIndex === undefined) return undefined;
  const claimsAtEvent = [];
  const appendClaim = (claim) => {
    claimsAtEvent.push({
      claimId: claim.claimId,
      agentId: claim.agentId,
      branch: claim.branch,
      claimedAt: claim.claimedAt,
      ...(claim.supersedes === undefined
        ? {}
        : { supersedes: claim.supersedes }),
    });
  };
  for (const claim of verifiedClaims) {
    const timeOrder = compareDateTimes(claim.claimedAt, createdAt);
    if (timeOrder === undefined) return undefined;
    if (timeOrder < 0) {
      appendClaim(claim);
    } else if (timeOrder > 0) {
      break;
    } else {
      if (!claim.commentId) return undefined;
      const claimIndex = commentIndexes.get(claim.commentId);
      if (claimIndex === undefined) return undefined;
      if (claimIndex < eventIndex) {
        appendClaim(claim);
      } else {
        break;
      }
    }
  }
  return claimsAtEvent.length > 0 ? claimsAtEvent : undefined;
}
function claimLineageMatchesAt(
  recordClaims,
  verifiedClaims,
  createdAt,
  recordCommentId,
  commentIndexes,
) {
  const claimsAtEvent = claimLineageAt(
    verifiedClaims,
    createdAt,
    recordCommentId,
    commentIndexes,
  );
  if (!claimsAtEvent) return false;
  return sameValue(recordClaims, claimsAtEvent);
}
function sameWorkResult(record, evidence, source) {
  const recordResult = resultFor(record);
  return (
    recordResult !== undefined &&
    sameSourceContent(evidence.source, source) &&
    evidence.bundleGeneration === record.bundleGeneration &&
    evidence.decisionGeneration === record.decisionGeneration &&
    evidence.executionCriteriaSatisfied &&
    recordResult.reference === evidence.reference &&
    recordResult.verifiedAt === evidence.verifiedAt &&
    (recordResult.headSha === undefined ||
      recordResult.headSha === evidence.headSha) &&
    (recordResult.mergeCommitSha === undefined ||
      recordResult.mergeCommitSha === evidence.mergeCommitSha)
  );
}
function workVerificationPrecedesCompletion(
  startedRecord,
  record,
  completionComment,
) {
  if (startedRecord.event.type !== 'work-started') return false;
  const result = resultFor(record);
  if (!result || typeof result.verifiedAt !== 'string') return false;
  const startOrder = compareDateTimes(
    startedRecord.event.startedAt,
    result.verifiedAt,
  );
  const timeOrder = compareDateTimes(
    result.verifiedAt,
    completionComment.createdAt,
  );
  return (
    startOrder !== undefined &&
    startOrder <= 0 &&
    timeOrder !== undefined &&
    timeOrder <= 0
  );
}
function workStartTimeFitsLifecycle(record, selectionComment, startComment) {
  if (record.event.type !== 'work-started') return false;
  const afterSelection = compareDateTimes(
    selectionComment.createdAt,
    record.event.startedAt,
  );
  const beforeStartRecord = compareDateTimes(
    record.event.startedAt,
    startComment.createdAt,
  );
  return (
    afterSelection !== undefined &&
    afterSelection <= 0 &&
    beforeStartRecord !== undefined &&
    beforeStartRecord <= 0
  );
}
function resultFor(record) {
  return record.event.type === 'work-completed' && isObject(record.event.result)
    ? record.event.result
    : undefined;
}
function sourceIssueUrl(source) {
  return `https://github.com/${source.repository}/issues/${source.issueNumber}`;
}
function matchesVerifiedReworkRoadmap(
  record,
  recordComment,
  requestComment,
  input,
  sourceBefore,
  sourceAfter,
  commentIndexes,
) {
  if (record.event.type !== 'rework-authored') return false;
  const roadmap = record.event.reworkRoadmap;
  if (!isObject(roadmap)) return false;
  return input.verifiedReworkRoadmaps.some((evidence) => {
    const publicationComment = input.comments.find(
      (comment) => comment.id === evidence.publishedCommentId,
    );
    const publicationMatches =
      publicationComment?.trustedAuthor &&
      Boolean(publicationComment.authorLogin) &&
      !publicationComment.edited &&
      commentBelongsToSource(publicationComment, input.currentSource) &&
      compareDateTimes(publicationComment.createdAt, evidence.publishedAt) ===
        0 &&
      commentPrecedes(requestComment, publicationComment, commentIndexes) &&
      commentPrecedes(publicationComment, recordComment, commentIndexes);
    return (
      publicationMatches &&
      sameRepositoryName(sourceBefore.repository, sourceAfter.repository) &&
      sourceBefore.issueNumber === sourceAfter.issueNumber &&
      evidence.recordId === record.recordId &&
      sameSourceContent(evidence.sourceBefore, sourceBefore) &&
      sameSourceContent(evidence.sourceAfter, sourceAfter) &&
      sameSourceContent(record.source, sourceAfter) &&
      evidence.roadmapIssueNumber === sourceAfter.issueNumber &&
      evidence.roadmapMarkerId === roadmap.roadmapMarkerId &&
      evidence.authoringSetId === roadmap.authoringSetId &&
      sameGitHubIssueUrl(evidence.url, sourceIssueUrl(sourceAfter)) &&
      roadmap.roadmapIssueNumber === evidence.roadmapIssueNumber &&
      sameGitHubIssueUrl(roadmap.url, evidence.url)
    );
  });
}
function validateVerifiedReworkRoadmaps(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push({
      code: 'rework-evidence-invalid',
      path,
      message: 'Expected independently verified rework-roadmap evidence.',
    });
    return;
  }
  const recordIds = new Set();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const evidence = exactObject(
      entry,
      [
        'recordId',
        'sourceBefore',
        'sourceAfter',
        'roadmapIssueNumber',
        'roadmapMarkerId',
        'authoringSetId',
        'url',
        'publishedCommentId',
        'publishedAt',
      ],
      [],
      entryPath,
      issues,
    );
    if (!evidence) return;
    checkStringFields(
      evidence,
      ['recordId', 'roadmapMarkerId', 'authoringSetId', 'publishedCommentId'],
      entryPath,
      issues,
    );
    validateSource(evidence.sourceBefore, `${entryPath}.sourceBefore`, issues);
    validateSource(evidence.sourceAfter, `${entryPath}.sourceAfter`, issues);
    positiveSafeInteger(
      evidence.roadmapIssueNumber,
      `${entryPath}.roadmapIssueNumber`,
      issues,
    );
    httpUrl(evidence.url, `${entryPath}.url`, issues);
    dateTime(evidence.publishedAt, `${entryPath}.publishedAt`, issues);
    if (typeof evidence.recordId === 'string') {
      if (recordIds.has(evidence.recordId)) {
        issues.push({
          code: 'duplicate-rework-evidence',
          path: `${entryPath}.recordId`,
          message: 'A rework record may have only one verified evidence item.',
        });
      }
      recordIds.add(evidence.recordId);
    }
  });
}
function commentBelongsToSource(comment, source) {
  try {
    const url = new URL(comment.url);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      sameGitHubIssuePathname(
        url.pathname,
        `/${source.repository}/issues/${source.issueNumber}`,
      ) &&
      url.hash === `#issuecomment-${comment.id}`
    );
  } catch {
    return false;
  }
}
function answerPresentation(decisions) {
  const presentation = [];
  const ordered = [...decisions].sort(
    (left, right) =>
      left.selection.record.decisionGeneration -
      right.selection.record.decisionGeneration,
  );
  for (const decision of ordered) {
    const completionEvent = decision.workCompleted;
    if (!completionEvent) return undefined;
    const selection = decision.selection.record;
    const selectedOption = selection.event.selectedOption;
    const alternatives = selection.event.feasibleAlternatives;
    const completion = completionEvent.record;
    const result = resultFor(completion);
    if (!result) return undefined;
    presentation.push({
      decisionGeneration: selection.decisionGeneration,
      question: selection.event.question,
      selectedOptionId: selectedOption.id,
      feasibleAlternativeIds: alternatives
        .map((alternative) => alternative.id)
        .sort(),
      workCompletedRecordId: completion.recordId,
      result,
    });
  }
  return presentation;
}
function validateAnswerBinding(
  answer,
  source,
  answerClaimLineage,
  recordClaimLineage,
  bundleGeneration,
  decisions,
) {
  const expectedDecisions = decisions
    .map((decision) => decision.selection.record.decisionGeneration)
    .sort((a, b) => a - b);
  const answerDecisions = [...answer.decisionGenerations].sort((a, b) => a - b);
  const answerClaims = [...answer.claimIds];
  const expectedClaims = answerClaimLineage?.map((claim) => claim.claimId);
  const answerLineageIsRecordPrefix =
    answerClaimLineage !== undefined &&
    answerClaimLineage.length <= recordClaimLineage.length &&
    answerClaimLineage.every((claim, index) =>
      sameValue(claim, recordClaimLineage[index]),
    );
  if (
    !sameSourceContent(answer.source, source) ||
    answer.bundleGeneration !== bundleGeneration ||
    !sameValue(answerDecisions, expectedDecisions) ||
    !expectedClaims ||
    !answerLineageIsRecordPrefix ||
    !sameValue(answerClaims, expectedClaims)
  )
    return false;
  const expectedPresentation = answerPresentation(decisions);
  return (
    expectedPresentation !== undefined &&
    sameValue(answer.presentedBundle, expectedPresentation)
  );
}
function answerFollowsEveryCompletion(
  answerComment,
  recordComment,
  decisions,
  commentIndexes,
) {
  const answerIndex = commentIndexes.get(answerComment.id);
  const recordIndex = commentIndexes.get(recordComment.id);
  if (answerIndex === undefined || recordIndex === undefined) return false;
  return (
    answerIndex < recordIndex &&
    decisions.every((decision) => {
      if (!decision.workCompleted) return false;
      const completionIndex = commentIndexes.get(
        decision.workCompleted.comment.id,
      );
      return completionIndex !== undefined && completionIndex < answerIndex;
    })
  );
}
function createReplayIssue(code, message, commentId) {
  return {
    code,
    path: commentId === undefined ? '$' : `comments[${commentId}]`,
    message,
  };
}
function invalidResult(issues) {
  return { valid: false, status: 'invalid', decisions: [], issues };
}
function decisionStatus(decision) {
  if (decision.reworkAuthored) return 'rework-authored';
  if (decision.reworkRequested) return 'rework-requested';
  if (decision.confirmation) return 'confirmed';
  if (decision.workCompleted) return 'confirmation-pending';
  if (decision.workStarted) return 'in-progress';
  return 'selected';
}
/**
 * Replay a complete, oldest-first issue-comment history without network or
 * prompt access. The caller owns API pagination, author trust, edit checks,
 * claim verification, and independent work verification.
 */
// audit:ignore-dead-export: runtime consumer is tracked in issue #4536
export function replayProvisionalDecisionHistory(input) {
  const issues = [];
  if (!input.completeHistory) {
    return invalidResult([
      createReplayIssue(
        'history-incomplete',
        'The complete issue-comment history was not verified.',
      ),
    ]);
  }
  if (!input.verifiedClaimLineage.length) {
    return invalidResult([
      createReplayIssue(
        'claim-lineage-unverified',
        'No trusted claim lineage was supplied.',
      ),
    ]);
  }
  const commentsByUrl = new Map();
  const commentIndexes = new Map();
  const commentIds = new Set();
  let priorCreatedAt;
  for (const [commentIndex, comment] of input.comments.entries()) {
    const validCreatedAt = dateTime(
      comment.createdAt,
      `comments[${comment.id}].createdAt`,
      issues,
    );
    const createdAtOrder =
      validCreatedAt && priorCreatedAt !== undefined
        ? compareDateTimes(comment.createdAt, priorCreatedAt)
        : undefined;
    if (createdAtOrder !== undefined && createdAtOrder < 0) {
      issues.push(
        createReplayIssue(
          'history-order-invalid',
          'Comments must be in complete oldest-first server order.',
          comment.id,
        ),
      );
    }
    if (validCreatedAt) priorCreatedAt = comment.createdAt;
    const urlKey = commentUrlKey(comment.url);
    if (commentIds.has(comment.id) || commentsByUrl.has(urlKey)) {
      issues.push(
        createReplayIssue(
          'duplicate-comment',
          'Comment IDs and URLs must be unique in the complete history.',
          comment.id,
        ),
      );
    }
    commentIds.add(comment.id);
    commentsByUrl.set(urlKey, comment);
    commentIndexes.set(comment.id, commentIndex);
  }
  if (issues.length) return invalidResult(issues);
  const currentSourceIssues = [];
  validateSource(input.currentSource, '$.currentSource', currentSourceIssues);
  validateClaimLineage(
    input.verifiedClaimLineage,
    '$.verifiedClaimLineage',
    currentSourceIssues,
    commentIndexes,
  );
  validateVerifiedReworkRoadmaps(
    input.verifiedReworkRoadmaps,
    '$.verifiedReworkRoadmaps',
    currentSourceIssues,
  );
  if (currentSourceIssues.length) return invalidResult(currentSourceIssues);
  const recordComments = [];
  const recordIds = new Set();
  for (const comment of input.comments) {
    if (comment.body.startsWith(PROVISIONAL_DECISION_RECORD_MARKER)) {
      if (!comment.trustedAuthor || !comment.authorLogin) continue;
      if (
        comment.edited ||
        !commentBelongsToSource(comment, input.currentSource)
      ) {
        issues.push(
          createReplayIssue(
            'record-authority-invalid',
            'A canonical record must be unedited and API-authored by a trusted marker actor.',
            comment.id,
          ),
        );
        continue;
      }
      const parsed = parseProvisionalDecisionRecordComment(comment.body);
      if (!parsed.ok) {
        issues.push(
          ...parsed.issues.map((issue) => ({
            ...issue,
            path: `comments[${comment.id}]${issue.path.slice(1)}`,
          })),
        );
        continue;
      }
      if (recordIds.has(parsed.record.recordId)) {
        issues.push(
          createReplayIssue(
            'duplicate-record-id',
            `Duplicate record ID ${parsed.record.recordId}.`,
            comment.id,
          ),
        );
        continue;
      }
      recordIds.add(parsed.record.recordId);
      if (
        !claimLineageMatchesAt(
          parsed.record.claimLineage,
          input.verifiedClaimLineage,
          comment.createdAt,
          comment.id,
          commentIndexes,
        )
      ) {
        issues.push(
          createReplayIssue(
            'claim-binding-mismatch',
            'The record claim lineage does not match the verified claims active when it was posted.',
            comment.id,
          ),
        );
      }
      recordComments.push({ comment, record: parsed.record });
    }
  }
  if (issues.length) return invalidResult(issues);
  if (recordComments.length === 0)
    return { valid: true, status: 'none', decisions: [], issues: [] };
  const firstRecord = recordComments.at(0);
  if (!firstRecord)
    return { valid: true, status: 'none', decisions: [], issues: [] };
  const originSource = firstRecord.record.source;
  const reworkSources = new Map();
  const requestComments = new Map();
  let latestSource = originSource;
  for (const { comment, record } of recordComments) {
    const decisionKey = `${record.bundleGeneration}:${record.decisionGeneration}`;
    if (
      record.event.type === 'rework-requested' &&
      !requestComments.has(decisionKey)
    ) {
      requestComments.set(decisionKey, comment);
    }
    const sourceBefore = latestSource;
    if (!sameSourceContent(record.source, sourceBefore)) {
      const requestComment = requestComments.get(decisionKey);
      if (
        requestComment !== undefined &&
        matchesVerifiedReworkRoadmap(
          record,
          comment,
          requestComment,
          input,
          sourceBefore,
          record.source,
          commentIndexes,
        )
      ) {
        latestSource = record.source;
      } else {
        issues.push(
          createReplayIssue(
            'source-binding-mismatch',
            'A source-content transition must match independently verified rework authoring.',
            comment.id,
          ),
        );
      }
    }
    reworkSources.set(record.recordId, {
      sourceBefore,
      sourceAfter: record.source,
    });
  }
  if (!sameSourceContent(latestSource, input.currentSource)) {
    issues.push(
      createReplayIssue(
        'source-binding-mismatch',
        'The current source content does not match the latest verified rework transition.',
        recordComments.at(-1)?.comment.id,
      ),
    );
  }
  if (issues.length) return invalidResult(issues);
  const states = new Map();
  let latestBundleGeneration = 0;
  for (const entry of recordComments) {
    const { record, comment } = entry;
    const key = `${record.bundleGeneration}:${record.decisionGeneration}`;
    const event = record.event;
    if (record.bundleGeneration < latestBundleGeneration) {
      issues.push(
        createReplayIssue(
          'bundle-generation-regression',
          'A later bundle generation cannot be followed by records from an older generation.',
          comment.id,
        ),
      );
      continue;
    }
    if (record.bundleGeneration > latestBundleGeneration) {
      if (latestBundleGeneration > 0) {
        const priorBundle = [...states.values()].filter(
          (state) =>
            state.selection.record.bundleGeneration === latestBundleGeneration,
        );
        const priorBundleClosed =
          priorBundle.length > 0 &&
          priorBundle.every(
            (state) => state.confirmation || state.reworkAuthored,
          );
        if (!priorBundleClosed) {
          issues.push(
            createReplayIssue(
              'bundle-generation-overlap',
              'A new bundle generation cannot replace an unconfirmed bundle before its rework roadmap is recorded.',
              comment.id,
            ),
          );
          continue;
        }
      }
      latestBundleGeneration = record.bundleGeneration;
    }
    const existing = states.get(key);
    if (event.type === 'selected') {
      if (existing) {
        issues.push(
          createReplayIssue(
            'duplicate-selection',
            'A decision generation may be selected only once.',
            comment.id,
          ),
        );
        continue;
      }
      const closedBundle = [...states.values()].some(
        (state) =>
          state.selection.record.bundleGeneration === record.bundleGeneration &&
          (state.confirmation || state.reworkRequested || state.reworkAuthored),
      );
      if (closedBundle) {
        issues.push(
          createReplayIssue(
            'bundle-generation-closed',
            'A bundle cannot accept new decisions after confirmation or rework begins; start a new bundle generation.',
            comment.id,
          ),
        );
        continue;
      }
      states.set(key, { selection: entry });
      continue;
    }
    if (!existing) {
      issues.push(
        createReplayIssue(
          'transition-without-selection',
          `${event.type} has no preceding selection for this generation.`,
          comment.id,
        ),
      );
      continue;
    }
    const prior =
      existing.reworkAuthored ??
      existing.reworkRequested ??
      existing.confirmation ??
      existing.workCompleted ??
      existing.workStarted ??
      existing.selection;
    const transitionOrder = compareDateTimes(
      comment.createdAt,
      prior.comment.createdAt,
    );
    if (transitionOrder === undefined || transitionOrder < 0) {
      issues.push(
        createReplayIssue(
          'transition-order-invalid',
          `${event.type} precedes its prior lifecycle event.`,
          comment.id,
        ),
      );
      continue;
    }
    if (event.type === 'work-started') {
      if (
        existing.workStarted ||
        existing.workCompleted ||
        existing.confirmation ||
        existing.reworkRequested ||
        existing.reworkAuthored
      ) {
        issues.push(
          createReplayIssue(
            'work-started-conflict',
            'Work may start once before completion or rework.',
            comment.id,
          ),
        );
      } else if (
        !workStartTimeFitsLifecycle(record, existing.selection.comment, comment)
      ) {
        issues.push(
          createReplayIssue(
            'work-start-time-order-invalid',
            'The declared work start must follow selection and be no later than its start record.',
            comment.id,
          ),
        );
      } else existing.workStarted = entry;
      continue;
    }
    if (event.type === 'work-completed') {
      if (
        !existing.workStarted ||
        existing.workCompleted ||
        existing.confirmation ||
        existing.reworkRequested ||
        existing.reworkAuthored
      ) {
        issues.push(
          createReplayIssue(
            'work-completion-order-invalid',
            'Completion requires one preceding work-started event.',
            comment.id,
          ),
        );
        continue;
      }
      if (
        !workVerificationPrecedesCompletion(
          existing.workStarted.record,
          record,
          comment,
        )
      ) {
        issues.push(
          createReplayIssue(
            'work-verification-order-invalid',
            'Work must start no later than independent verification, which must precede its completion record.',
            comment.id,
          ),
        );
        continue;
      }
      if (
        !input.verifiedWork.some((evidence) =>
          sameWorkResult(record, evidence, record.source),
        )
      ) {
        issues.push(
          createReplayIssue(
            'work-evidence-insufficient',
            'Completion has no matching independently verified evidence satisfying its execution criteria.',
            comment.id,
          ),
        );
        continue;
      }
      existing.workCompleted = entry;
      continue;
    }
    if (event.type === 'confirmed') {
      if (
        !existing.workCompleted ||
        existing.reworkRequested ||
        existing.reworkAuthored
      ) {
        issues.push(
          createReplayIssue(
            'confirmation-order-invalid',
            'Confirmation requires completed work and no active rework request.',
            comment.id,
          ),
        );
        continue;
      }
      const confirmation = event.confirmation;
      const url = confirmation.commentUrl;
      const answerComment = commentsByUrl.get(commentUrlKey(url));
      if (
        answerComment?.trustedAuthor !== true ||
        !answerComment.authorLogin ||
        answerComment.edited ||
        !commentBelongsToSource(answerComment, input.currentSource) ||
        !answerComment.body.startsWith(PROVISIONAL_DECISION_ANSWER_MARKER)
      ) {
        issues.push(
          createReplayIssue(
            'confirmation-answer-untrusted',
            'The referenced answer comment is missing, unmarked, edited, or not API-authored by a trusted recorder.',
            comment.id,
          ),
        );
        continue;
      }
      const parsedAnswer = parseAnswerComment(answerComment.body);
      if (!parsedAnswer.ok) {
        issues.push(
          ...parsedAnswer.issues.map((issue) => ({
            ...issue,
            path: `comments[${answerComment.id}]${issue.path.slice(1)}`,
          })),
        );
        continue;
      }
      const bundleGeneration = record.bundleGeneration;
      const currentBundle = [...states.values()].filter(
        (state) => state.selection.record.bundleGeneration === bundleGeneration,
      );
      const answerConfirmationOrder = compareDateTimes(
        answerComment.createdAt,
        confirmation.confirmedAt,
      );
      const answerRecordOrder = compareDateTimes(
        answerComment.createdAt,
        comment.createdAt,
      );
      if (
        answerConfirmationOrder !== 0 ||
        answerRecordOrder === undefined ||
        answerRecordOrder > 0
      ) {
        issues.push(
          createReplayIssue(
            'confirmation-time-mismatch',
            'The answer comment creation time must match confirmedAt and precede its record.',
            comment.id,
          ),
        );
        continue;
      }
      if (currentBundle.some((state) => !state.workCompleted)) {
        issues.push(
          createReplayIssue(
            'confirmation-bundle-incomplete',
            'Every decision in the current bundle must have verified completion before this decision can be confirmed.',
            comment.id,
          ),
        );
        continue;
      }
      if (
        !answerFollowsEveryCompletion(
          answerComment,
          comment,
          currentBundle,
          commentIndexes,
        )
      ) {
        issues.push(
          createReplayIssue(
            'confirmation-time-mismatch',
            'The answer must follow every completed-work record in the bundle and precede its confirmation record.',
            comment.id,
          ),
        );
        continue;
      }
      const answerClaimLineage = claimLineageAt(
        input.verifiedClaimLineage,
        answerComment.createdAt,
        answerComment.id,
        commentIndexes,
      );
      if (
        !validateAnswerBinding(
          parsedAnswer.answer,
          record.source,
          answerClaimLineage,
          record.claimLineage,
          bundleGeneration,
          currentBundle,
        )
      ) {
        issues.push(
          createReplayIssue(
            'confirmation-scope-mismatch',
            'The referenced answer does not present and bind the complete current source, bundle, claim, decision, and work scope.',
            comment.id,
          ),
        );
        continue;
      }
      if (parsedAnswer.answer.response !== 'accepted') {
        issues.push(
          createReplayIssue(
            'confirmation-answer-not-accepted',
            'The referenced answer records an alternate preference, not acceptance of the completed bundle.',
            comment.id,
          ),
        );
        continue;
      }
      if (existing.confirmation) {
        issues.push(
          createReplayIssue(
            'duplicate-confirmation',
            'A decision generation may be confirmed only once.',
            comment.id,
          ),
        );
        continue;
      }
      existing.confirmation = entry;
      continue;
    }
    if (event.type === 'rework-requested') {
      if (
        !existing.workCompleted ||
        existing.confirmation ||
        existing.reworkRequested ||
        existing.reworkAuthored
      ) {
        issues.push(
          createReplayIssue(
            'rework-request-order-invalid',
            'Rework requires completed, unconfirmed work and may be requested only once.',
            comment.id,
          ),
        );
        continue;
      }
      const request = event.reworkRequest;
      const selectionEvent = existing.selection.record.event;
      const selectedOptionId = selectionEvent.selectedOption.id;
      const alternateIds = selectionEvent.feasibleAlternatives.map(
        (option) => option.id,
      );
      if (
        request.requestedOptionId === selectedOptionId ||
        !alternateIds.includes(request.requestedOptionId)
      ) {
        issues.push(
          createReplayIssue(
            'rework-option-invalid',
            'Rework must select a recorded feasible alternative.',
            comment.id,
          ),
        );
        continue;
      }
      const answerComment = commentsByUrl.get(
        commentUrlKey(request.commentUrl),
      );
      if (
        answerComment?.trustedAuthor !== true ||
        !answerComment.authorLogin ||
        answerComment.edited ||
        !commentBelongsToSource(answerComment, input.currentSource) ||
        !answerComment.body.startsWith(PROVISIONAL_DECISION_ANSWER_MARKER)
      ) {
        issues.push(
          createReplayIssue(
            'rework-answer-untrusted',
            'The rework request must reference an unedited, trusted, scoped answer comment.',
            comment.id,
          ),
        );
        continue;
      }
      const parsedAnswer = parseAnswerComment(answerComment.body);
      if (!parsedAnswer.ok) {
        issues.push(
          ...parsedAnswer.issues.map((issue) => ({
            ...issue,
            path: `comments[${answerComment.id}]${issue.path.slice(1)}`,
          })),
        );
        continue;
      }
      const bundleGeneration = record.bundleGeneration;
      const currentBundle = [...states.values()].filter(
        (state) => state.selection.record.bundleGeneration === bundleGeneration,
      );
      const answerClaimLineage = claimLineageAt(
        input.verifiedClaimLineage,
        answerComment.createdAt,
        answerComment.id,
        commentIndexes,
      );
      const answerRequestOrder = compareDateTimes(
        answerComment.createdAt,
        request.requestedAt,
      );
      const answerRecordOrder = compareDateTimes(
        answerComment.createdAt,
        comment.createdAt,
      );
      if (
        currentBundle.some((state) => !state.workCompleted) ||
        parsedAnswer.answer.response !== 'rework' ||
        parsedAnswer.answer.requestedOptionId !== request.requestedOptionId ||
        parsedAnswer.answer.rationale !== request.rationale ||
        answerRequestOrder !== 0 ||
        answerRecordOrder === undefined ||
        answerRecordOrder > 0 ||
        !answerFollowsEveryCompletion(
          answerComment,
          comment,
          currentBundle,
          commentIndexes,
        ) ||
        !validateAnswerBinding(
          parsedAnswer.answer,
          record.source,
          answerClaimLineage,
          record.claimLineage,
          bundleGeneration,
          currentBundle,
        )
      ) {
        issues.push(
          createReplayIssue(
            'rework-answer-scope-mismatch',
            'The rework answer must explicitly request this feasible option for the complete current bundle and precede its record.',
            comment.id,
          ),
        );
        continue;
      }
      existing.reworkRequested = entry;
      continue;
    }
    if (event.type === 'rework-authored') {
      if (!existing.reworkRequested || existing.reworkAuthored) {
        issues.push(
          createReplayIssue(
            'rework-roadmap-order-invalid',
            'A rework roadmap requires one preceding rework request.',
            comment.id,
          ),
        );
        continue;
      }
      const roadmap = event.reworkRoadmap;
      const source = record.source;
      const reworkSource = reworkSources.get(record.recordId);
      const expectedUrl = sourceIssueUrl(source);
      if (
        roadmap.roadmapIssueNumber !== source.issueNumber ||
        !sameGitHubIssueUrl(roadmap.url, expectedUrl) ||
        !reworkSource ||
        !matchesVerifiedReworkRoadmap(
          record,
          comment,
          existing.reworkRequested.comment,
          input,
          reworkSource.sourceBefore,
          reworkSource.sourceAfter,
          commentIndexes,
        )
      ) {
        issues.push(
          createReplayIssue(
            'rework-roadmap-unverified',
            'The rework roadmap must match independently verified authoring and same-source evidence.',
            comment.id,
          ),
        );
        continue;
      }
      existing.reworkAuthored = entry;
    }
  }
  if (issues.length) return invalidResult(issues);
  const allStates = [...states.values()].sort((left, right) => {
    const bundle =
      left.selection.record.bundleGeneration -
      right.selection.record.bundleGeneration;
    return (
      bundle ||
      left.selection.record.decisionGeneration -
        right.selection.record.decisionGeneration
    );
  });
  const currentBundleGeneration = Math.max(
    ...allStates.map((state) => state.selection.record.bundleGeneration),
  );
  const currentBundle = allStates.filter(
    (state) =>
      state.selection.record.bundleGeneration === currentBundleGeneration,
  );
  const decisions = allStates.map((state) => ({
    bundleGeneration: state.selection.record.bundleGeneration,
    decisionGeneration: state.selection.record.decisionGeneration,
    selection: state.selection.record,
    ...(state.workStarted ? { workStarted: state.workStarted.record } : {}),
    ...(state.workCompleted
      ? { workCompleted: state.workCompleted.record }
      : {}),
    ...(state.confirmation ? { confirmation: state.confirmation.record } : {}),
    ...(state.reworkRequested
      ? { reworkRequested: state.reworkRequested.record }
      : {}),
    ...(state.reworkAuthored
      ? { reworkAuthored: state.reworkAuthored.record }
      : {}),
    status: decisionStatus(state),
  }));
  let status;
  if (
    currentBundle.some((state) => state.reworkRequested || state.reworkAuthored)
  ) {
    status =
      currentBundle.some((state) => state.reworkAuthored) &&
      currentBundle.every((state) => state.confirmation || state.reworkAuthored)
        ? 'rework-authored'
        : 'rework-requested';
  } else if (currentBundle.every((state) => state.confirmation))
    status = 'confirmed';
  else if (currentBundle.every((state) => state.workCompleted))
    status = 'confirmation-pending';
  else if (
    currentBundle.some((state) => state.workStarted || state.workCompleted)
  )
    status = 'in-progress';
  else status = 'selected';
  return { valid: true, status, decisions, issues: [] };
}
