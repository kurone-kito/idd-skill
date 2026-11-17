#!/usr/bin/env node
// idd-generated-from: src/scripts/provisional-decision-command.mts
//
// The scripts/provisional-decision-command.mjs copy is generated from this
// file by `pnpm run build`. Edit this source, never the generated copy.
//
// The provisional-decision command (issue #4799, from roadmap #4722). It reads
// one request JSON file, derives every trust field from a trusted source, and
// runs the planner, or, for a `resolve` request (issue #5276), the
// confirmation-pending resolution. A dry run is the default: only `--apply`
// may write.
import { readFileSync } from 'node:fs';
import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { readTrustedAutoDecideWithConfig } from './idd-config.mjs';
import {
  readActiveClaimFromHistory,
  runProvisionalDecisionCommand,
  runProvisionalResolution,
} from './provisional-decision.mjs';
import { createGithubProvisionalDecisionStore } from './provisional-decision-github.mjs';
import { parseProvisionalDecisionRecordComment } from './provisional-decision-state.mjs';

const PROVISIONAL_DECISION_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--repo': { type: 'string' },
  '--request': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
};
const USAGE = `Usage:
  node scripts/provisional-decision-command.mjs --issue <n> --repo <owner/repo> --request <path> [--apply]

Run one provisional-decision transition for an IDD issue (type selected,
work-started, or work-completed), or resolve a confirmation-pending source
(type resolve). The request file is JSON. The command derives the trust fields
itself: for a transition, the trusted dangerouslyAutoDecide master switch, the
option comparison, the baseline of a work transition (from the stored record),
and the rework roadmaps; for resolve, the rework roadmaps. A request file that
supplies any of them is refused. Without --apply the command plans only and
writes nothing.

Options:
  --issue <n>          the source issue number
  --repo <owner/repo>  the repository that owns the issue
  --request <path>     the request JSON file
  --apply              write: append the record and apply the completion label
                       (a transition), or run the resolution writes (resolve)
  --help, -h           show this help

Request fields by "type":
  all transitions: type, claimId, worktreeBranch, evidenceUrl (optional)
  selected:       baseline {title, bodySha256}, selectedOption,
                  feasibleAlternatives, executionCriteria (optional).
                  bodySha256 is the hex SHA-256 of the issue body's UTF-8
                  bytes, read when the options were reviewed.
  work-started:   planCommentUrl (optional)
  work-completed: verifiedHeadSha, executionCriteriaSatisfied,
                  pullRequestUrl (optional)
  resolve:        type, claimId, agentId, branch (the coordination claim this
                  session holds for the review), decisionGenerations (the
                  decisions of the current bundle the answer applies to),
                  input (optional), answeredPresentationSha256 (optional),
                  downstreamResults (optional array of strings)

The resolve action asks whether the implemented choices were acceptable and acts
only on an actual answer. A dry run reports the next step and needsUserAnswer,
and the presentation and its digest when there is one; show the presentation
and ask only when needsUserAnswer is true. Without an actual answer, --apply only releases the coordination claim
and leaves the source pending, so run the dry run first. The action reads no
opt-in switch, so it still works when dangerouslyAutoDecide is off, but it needs
a readable trusted repository policy. The rework-authored request is not run by
this command.
resolve input is what the user actually did, never an assistant assertion or
agent-fed text. One of:
  {"channel":"conversation","origin":"user","message":"...",
   "interpretation":{"response":"accepted" | "declined" | "none"}}
  {"channel":"conversation","origin":"user","message":"...",
   "interpretation":{"response":"rework","requestedOptionId":"...","rationale":"..."}}
  {"channel":"terminal","origin":"user","interactive":true,
   "event":{"kind":"line","text":"y"} | {"kind":"eof"} | {"kind":"cancelled"}}
  {"channel":"timeout"} or {"channel":"none"}

Output: one JSON line on stdout. A transition reports state, action, reason,
recordId, commentUrl, and a plan summary when the planner made one; resolve
reports state, action, outcome, reason, nextStep, steps, recordIds,
needsUserAnswer, presentation, presentationSha256, and warnings. Both carry
apply.
Exit codes: 0 planned, applied, or refused with action none (nothing to do
yet); 2 reconciled (the record already exists, a resolve run finds everything
done, or a resolve step that nextStep names is still to do: read its reason,
then run again; read state and action on stdout) or a usage error (message on
stderr); 3 recovery-hold (inspect before any retry); 4
fix-input (correct the request or the issue, then re-run).
`;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
/** A request-file problem the operator must fix. Reported as exit 4. */
class RequestInputError extends Error {}
const COMMON_REQUEST_KEYS = [
  'type',
  'claimId',
  'worktreeBranch',
  'evidenceUrl',
];
const REQUEST_KEYS_BY_TYPE = {
  selected: [
    ...COMMON_REQUEST_KEYS,
    'baseline',
    'selectedOption',
    'feasibleAlternatives',
    'executionCriteria',
  ],
  'work-started': [...COMMON_REQUEST_KEYS, 'planCommentUrl'],
  'work-completed': [
    ...COMMON_REQUEST_KEYS,
    'pullRequestUrl',
    'verifiedHeadSha',
    'executionCriteriaSatisfied',
  ],
  resolve: [
    'type',
    'claimId',
    'agentId',
    'branch',
    'decisionGenerations',
    'input',
    'answeredPresentationSha256',
    'downstreamResults',
  ],
};
/**
 * A missing or malformed value, reported as exit 2. An unknown flag is not one
 * of these: the flag parser throws it and it exits 1, as the contract table
 * requires (issue #4799).
 */
class CommandUsageError extends Error {}
/**
 * Parse the command's argv. Every value flag is required, so a bare call and a
 * call without `--issue`, `--repo`, or `--request` is a usage error.
 */
export function parseCommandArgs(argv) {
  const { values, help } = parseCliArgs(argv, PROVISIONAL_DECISION_FLAG_SPEC);
  if (help) return { help: true };
  const issueToken = values.issue;
  const repository = values.repo;
  const requestPath = values.request;
  if (issueToken === undefined || repository === undefined) {
    throw new CommandUsageError('--issue and --repo are required');
  }
  if (requestPath === undefined) {
    throw new CommandUsageError('--request is required');
  }
  let issueNumber;
  try {
    issueNumber = parseCanonicalIntegerOrThrow(issueToken, '--issue', 1);
  } catch {
    throw new CommandUsageError('--issue must be a positive integer');
  }
  if (!Number.isSafeInteger(issueNumber)) {
    throw new CommandUsageError('--issue must be a positive integer');
  }
  const segments = repository.split('/');
  if (
    !REPOSITORY_PATTERN.test(repository) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new CommandUsageError('--repo must be owner/repo');
  }
  return {
    help: false,
    issueNumber,
    repository,
    requestPath,
    apply: values.apply === true,
  };
}
function readRequestJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new RequestInputError(
      `cannot read --request: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestInputError('--request is not valid JSON');
  }
}
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requireNonEmptyString(raw, key) {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestInputError(`request field "${key}" must be a string`);
  }
  return value;
}
function optionalString(raw, key) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new RequestInputError(`request field "${key}" must be a string`);
  }
  return value;
}
function requireBoolean(raw, key) {
  const value = raw[key];
  if (typeof value !== 'boolean') {
    throw new RequestInputError(`request field "${key}" must be a boolean`);
  }
  return value;
}
const OPTION_TEXT_KEYS = [
  'id',
  'description',
  'feasibilityRationale',
  'requirementFit',
  'consequences',
  'verification',
  'reversalOrMigration',
];
const OPTION_OPTIONAL_TEXT_KEYS = [
  'rationale',
  'comparison',
  'rejectionReason',
];
/** Check one decision option's text fields and keep only the known keys. */
function parseOption(value, field) {
  if (!isPlainObject(value)) {
    throw new RequestInputError(`request field "${field}" must be an object`);
  }
  const option = {};
  for (const key of OPTION_TEXT_KEYS) {
    const text = value[key];
    if (typeof text !== 'string' || text.trim() === '') {
      throw new RequestInputError(
        `request field "${field}.${key}" must be a non-empty string`,
      );
    }
    option[key] = text;
  }
  for (const key of OPTION_OPTIONAL_TEXT_KEYS) {
    const text = value[key];
    if (text === undefined) continue;
    if (typeof text !== 'string') {
      throw new RequestInputError(
        `request field "${field}.${key}" must be a string`,
      );
    }
    option[key] = text;
  }
  return option;
}
function parseOptionArray(value) {
  if (!Array.isArray(value)) {
    throw new RequestInputError(
      'request field "feasibleAlternatives" must be an array',
    );
  }
  return value.map((item, index) =>
    parseOption(item, `feasibleAlternatives[${index}]`),
  );
}
function parseBaseline(value) {
  if (!isPlainObject(value)) {
    throw new RequestInputError('request field "baseline" must be an object');
  }
  return {
    title: requireNonEmptyString(value, 'title'),
    bodySha256: requireNonEmptyString(value, 'bodySha256'),
  };
}
/**
 * Check the request's shape. The command derives trust fields and the
 * repository itself, so any field outside the type's list is refused, which
 * keeps a caller from supplying a trust value through the file.
 */
function validateRequestShape(raw) {
  if (!isPlainObject(raw)) {
    throw new RequestInputError('--request must hold a JSON object');
  }
  const type = raw.type;
  if (typeof type !== 'string' || !Object.hasOwn(REQUEST_KEYS_BY_TYPE, type)) {
    throw new RequestInputError(
      'request field "type" must be selected, work-started, work-completed, or resolve',
    );
  }
  const requestType = type;
  const allowed = REQUEST_KEYS_BY_TYPE[requestType];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new RequestInputError(
        `request field "${key}" is not allowed for type ${requestType}; the command derives trust fields, the repository, and the issue number itself`,
      );
    }
  }
  return { type: requestType, raw };
}
/**
 * The authority to act: the master `dangerouslyAutoDecide` switch and the
 * decision-issue class must both be enabled. An unreadable report is not.
 */
function authorityFrom(report) {
  return (
    report.master === 'enabled' && report.classes.decisionIssue === 'enabled'
  );
}
/**
 * A fingerprint of the trusted authority and config. Null when the authority
 * is not enabled. A write proceeds only while the fingerprint still matches the
 * one taken at planning, so a change to the trusted config (marker actors, the
 * label) blocks the write, not only a switch turning off.
 */
function trustFingerprint(snapshot) {
  if (!authorityFrom(snapshot.report)) return null;
  return JSON.stringify(snapshot.policyConfig ?? null);
}
/**
 * Re-check the authority before every append and label write. The planner's
 * gates use the trust read taken at the start, so a revocation between that
 * read and a write must still block the write.
 */
function authorityCheckedStore(store, authorityNow) {
  return {
    // The planner reads claim trust and the label name from this policy, so
    // the wrapper must carry it, not fall back to the working-tree config.
    policy: store.policy,
    readHistory: () => store.readHistory(),
    readSourceIssue: () => store.readSourceIssue(),
    readPullRequest: (url) => store.readPullRequest(url),
    async appendRecordBody(recordId, body) {
      if (!authorityNow()) {
        throw new Error(
          'trusted decision authority was withdrawn before the record append',
        );
      }
      return store.appendRecordBody(recordId, body);
    },
    async applyOrReadDecisionLabel(input) {
      if (input.apply && !authorityNow()) {
        throw new Error(
          'trusted decision authority was withdrawn before the label write',
        );
      }
      return store.applyOrReadDecisionLabel(input);
    },
  };
}
/** The newest trusted, parseable decision record on the issue, if any. */
async function latestStoredRecord(store) {
  const history = await store.readHistory();
  // An incomplete or undated history is an unreliable read. It is reported as
  // a read failure (a recovery hold), not as a request error.
  if (!history.complete || !Number.isFinite(Date.parse(history.serverDate))) {
    throw new Error('the issue history read was incomplete or undated');
  }
  let latest = null;
  for (const comment of history.comments) {
    if (!comment.trustedAuthor || comment.edited) continue;
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    if (parsed.ok) latest = parsed.record;
  }
  return latest;
}
/** Build the planner request, deriving every trust field from trusted reads. */
async function buildRequest(shape, context) {
  const { raw, type } = shape;
  const base = {
    repository: context.repository,
    issueNumber: context.issueNumber,
    claimId: requireNonEmptyString(raw, 'claimId'),
    worktreeBranch: requireNonEmptyString(raw, 'worktreeBranch'),
    policyTrusted: context.policyTrusted,
    verifiedReworkRoadmaps: [],
    ...evidenceUrlField(raw),
  };
  if (type === 'selected') {
    const selectedOption =
      raw.selectedOption === undefined
        ? undefined
        : parseOption(raw.selectedOption, 'selectedOption');
    const alternatives =
      raw.feasibleAlternatives === undefined
        ? undefined
        : parseOptionArray(raw.feasibleAlternatives);
    const criteria = raw.executionCriteria;
    if (criteria !== undefined && !isStringArray(criteria)) {
      throw new RequestInputError(
        'request field "executionCriteria" must be an array of strings',
      );
    }
    return {
      ...base,
      type,
      // Presence only: an option and at least one alternative were supplied.
      // The planner's record checks validate the content it writes.
      optionComparisonValid:
        selectedOption !== undefined &&
        alternatives !== undefined &&
        alternatives.length > 0,
      baseline: parseBaseline(raw.baseline),
      ...(selectedOption === undefined ? {} : { selectedOption }),
      ...(alternatives === undefined
        ? {}
        : { feasibleAlternatives: alternatives }),
      ...(criteria === undefined ? {} : { executionCriteria: criteria }),
    };
  }
  // A work transition inherits its baseline and option-comparison validity
  // from the stored record: the record was validated when the decision was
  // selected. The planner still compares the baseline with the live source.
  const stored = await latestStoredRecord(context.store);
  if (stored === null) {
    throw new RequestInputError(
      'no trusted provisional-decision record exists on this issue',
    );
  }
  const baseline = {
    title: stored.source.snapshot.title,
    bodySha256: stored.source.snapshot.bodySha256,
  };
  if (type === 'work-started') {
    const planCommentUrl = optionalString(raw, 'planCommentUrl');
    return {
      ...base,
      type,
      optionComparisonValid: true,
      baseline,
      ...(planCommentUrl === undefined ? {} : { planCommentUrl }),
    };
  }
  const pullRequestUrl = optionalString(raw, 'pullRequestUrl');
  return {
    ...base,
    type,
    optionComparisonValid: true,
    baseline,
    verifiedHeadSha: requireNonEmptyString(raw, 'verifiedHeadSha'),
    executionCriteriaSatisfied: requireBoolean(
      raw,
      'executionCriteriaSatisfied',
    ),
    ...(pullRequestUrl === undefined ? {} : { pullRequestUrl }),
  };
}
function evidenceUrlField(raw) {
  const evidenceUrl = optionalString(raw, 'evidenceUrl');
  return evidenceUrl === undefined ? {} : { evidenceUrl };
}
function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}
const CONFIRMATION_ORIGINS = ['user', 'assistant', 'tool', 'unknown'];
/** Refuse a key outside the list, so a request cannot smuggle extra fields. */
function allowOnlyKeys(raw, allowed, field) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new RequestInputError(
        `request field "${field}" has an unknown key "${key}"`,
      );
    }
  }
}
function requireObject(value, field) {
  if (!isPlainObject(value)) {
    throw new RequestInputError(`request field "${field}" must be an object`);
  }
  return value;
}
function requireString(raw, key, field) {
  const value = raw[key];
  if (typeof value !== 'string') {
    throw new RequestInputError(
      `request field "${field}.${key}" must be a string`,
    );
  }
  return value;
}
function parseOrigin(raw) {
  const origin = raw.origin;
  const known = CONFIRMATION_ORIGINS.find((candidate) => candidate === origin);
  if (known === undefined) {
    throw new RequestInputError(
      'request field "input.origin" must be user, assistant, tool, or unknown',
    );
  }
  return known;
}
function parseTerminalEvent(value) {
  const event = requireObject(value, 'input.event');
  if (event.kind === 'line') {
    allowOnlyKeys(event, ['kind', 'text'], 'input.event');
    return { kind: 'line', text: requireString(event, 'text', 'input.event') };
  }
  if (event.kind === 'eof' || event.kind === 'cancelled') {
    allowOnlyKeys(event, ['kind'], 'input.event');
    return { kind: event.kind };
  }
  throw new RequestInputError(
    'request field "input.event.kind" must be line, eof, or cancelled',
  );
}
function parseInterpretation(value) {
  const reading = requireObject(value, 'input.interpretation');
  if (
    reading.response === 'accepted' ||
    reading.response === 'declined' ||
    reading.response === 'none'
  ) {
    allowOnlyKeys(reading, ['response'], 'input.interpretation');
    return { response: reading.response };
  }
  if (reading.response === 'rework') {
    allowOnlyKeys(
      reading,
      ['response', 'requestedOptionId', 'rationale'],
      'input.interpretation',
    );
    return {
      response: 'rework',
      requestedOptionId: requireString(
        reading,
        'requestedOptionId',
        'input.interpretation',
      ),
      rationale: requireString(reading, 'rationale', 'input.interpretation'),
    };
  }
  throw new RequestInputError(
    'request field "input.interpretation.response" must be accepted, declined, none, or rework',
  );
}
/**
 * Check the reported input event's whole shape. The planner's reader
 * dereferences its fields without checks, so a malformed event must stop here
 * as a request error, not as a thrown TypeError. The event is still what the
 * caller reports: nothing here can tell who typed it.
 */
function parseConfirmationInput(value) {
  const input = requireObject(value, 'input');
  if (input.channel === 'none' || input.channel === 'timeout') {
    allowOnlyKeys(input, ['channel'], 'input');
    return { channel: input.channel };
  }
  if (input.channel === 'terminal') {
    allowOnlyKeys(
      input,
      ['channel', 'origin', 'interactive', 'event'],
      'input',
    );
    if (typeof input.interactive !== 'boolean') {
      throw new RequestInputError(
        'request field "input.interactive" must be a boolean',
      );
    }
    return {
      channel: 'terminal',
      origin: parseOrigin(input),
      interactive: input.interactive,
      event: parseTerminalEvent(input.event),
    };
  }
  if (input.channel === 'conversation') {
    allowOnlyKeys(
      input,
      ['channel', 'origin', 'message', 'interpretation'],
      'input',
    );
    return {
      channel: 'conversation',
      origin: parseOrigin(input),
      message: requireString(input, 'message', 'input'),
      interpretation: parseInterpretation(input.interpretation),
    };
  }
  throw new RequestInputError(
    'request field "input.channel" must be terminal, conversation, timeout, or none',
  );
}
function parseDecisionGenerations(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => Number.isSafeInteger(item) && item >= 1)
  ) {
    throw new RequestInputError(
      'request field "decisionGenerations" must be a non-empty array of positive integers',
    );
  }
  return value;
}
/**
 * Build the resolution request. The rework roadmaps stay derived as none, so a
 * source that already holds a rework-authored record is a recovery hold until
 * the store can verify that evidence itself.
 */
function buildResolveRequest(raw, context) {
  const downstream = raw.downstreamResults;
  if (downstream !== undefined && !isStringArray(downstream)) {
    throw new RequestInputError(
      'request field "downstreamResults" must be an array of strings',
    );
  }
  const answeredPresentationSha256 = optionalString(
    raw,
    'answeredPresentationSha256',
  );
  return {
    type: 'resolve',
    repository: context.repository,
    issueNumber: context.issueNumber,
    claimId: requireNonEmptyString(raw, 'claimId'),
    agentId: requireNonEmptyString(raw, 'agentId'),
    branch: requireNonEmptyString(raw, 'branch'),
    verifiedReworkRoadmaps: [],
    decisionGenerations: parseDecisionGenerations(raw.decisionGenerations),
    input:
      raw.input === undefined || raw.input === null
        ? null
        : parseConfirmationInput(raw.input),
    ...(answeredPresentationSha256 === undefined
      ? {}
      : { answeredPresentationSha256 }),
    ...(downstream === undefined ? {} : { downstreamResults: downstream }),
  };
}
function summarizePlan(plan) {
  const { history, ...rest } = plan;
  return { ...rest, historyComments: history.comments.length };
}
function reportFor(result, apply) {
  return {
    state: result.state,
    action: result.action ?? null,
    reason: result.reason ?? null,
    recordId: result.recordId,
    commentUrl: result.commentUrl === '' ? null : result.commentUrl,
    apply,
    plan: result.plan ? summarizePlan(result.plan) : null,
  };
}
export const DEFAULT_PROVISIONAL_DECISION_CLI_DEPS = {
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  readTrust: readTrustedAutoDecideWithConfig,
  createStore: createGithubProvisionalDecisionStore,
};
function writeReport(report, deps) {
  deps.writeStdout(`${JSON.stringify(report)}\n`);
}
/**
 * Report a failed read while deriving the baseline as a recovery hold (exit 3),
 * in the same stdout shape as a planner result.
 */
function readFailureOutcome(error, apply, deps) {
  const detail = error instanceof Error ? error.message : String(error);
  const reason = `could not read the issue history to derive the baseline: ${detail}`;
  writeReport(
    {
      state: 'refused',
      action: 'recovery-hold',
      reason,
      recordId: null,
      commentUrl: null,
      apply,
      plan: null,
    },
    deps,
  );
  return { exitCode: 3, kind: 'gate', message: reason };
}
/** The exit code and envelope kind for a planner or resolution result. */
function outcomeFor(result) {
  if (result.state === 'refused' && result.action === 'recovery-hold') {
    return {
      exitCode: 3,
      kind: 'gate',
      message: result.reason ?? 'recovery hold: inspect before any retry',
    };
  }
  if (result.state === 'refused' && result.action === 'fix-input') {
    return {
      exitCode: 4,
      kind: 'usage',
      message: result.reason ?? 'fix the request or the issue, then re-run',
    };
  }
  if (result.state === 'reconciled') return 2;
  return 0;
}
/** Report a request-input problem in the same stdout shape, as exit 4. */
function requestInputOutcome(error, apply, deps) {
  writeReport(
    {
      state: 'refused',
      action: 'fix-input',
      reason: error.message,
      recordId: null,
      commentUrl: null,
      apply,
      plan: null,
    },
    deps,
  );
  return {
    exitCode: 4,
    kind: 'usage',
    message: error.message,
  };
}
/**
 * A fingerprint of what a resolution trusts: the trusted policy snapshot
 * without the auto-decide keys. A resolution reads no opt-in switch, so a
 * switch turning on or off never blocks it, while a change to the trusted
 * marker actors or claim timing does. Null when the snapshot is unreadable.
 */
function policyFingerprint(snapshot) {
  if (snapshot.policyConfig === null) return null;
  const {
    dangerouslyAutoDecide: _master,
    autoDecide: _classes,
    ...rest
  } = snapshot.policyConfig;
  return JSON.stringify(rest);
}
/**
 * Re-check the trusted policy before every resolution write. The planner and
 * the store trust the snapshot read at the start, so a change between that read
 * and a write must still block the write.
 */
function policyCheckedResolutionStore(store, stillTrusted, claim) {
  const check = (write) => {
    if (!stillTrusted()) {
      throw new Error(`the trusted policy changed before the ${write}`);
    }
  };
  // Every answer and record append happens under the coordination claim. The
  // store re-checks the claim for the close and the release itself; the
  // appends carry no claim, so this re-read, right before the write, keeps a
  // displaced session from appending after a takeover. The rework-authored
  // append is not run by this command: it needs the claim released.
  const requireActiveClaim = async () => {
    const history = await store.readHistory();
    if (!history.complete) {
      throw new Error('cannot append after incomplete history');
    }
    const active = readActiveClaimFromHistory(history, store);
    if (
      active?.claimId !== claim.claimId ||
      active.agentId !== claim.agentId ||
      active.branch !== claim.branch
    ) {
      throw new Error('the coordination claim is no longer the active claim');
    }
  };
  return {
    policy: store.policy,
    readHistory: () => store.readHistory(),
    readSourceIssue: () => store.readSourceIssue(),
    readSourceState: () => store.readSourceState(),
    readPullRequest: (url) => store.readPullRequest(url),
    async applyOrReadDecisionLabel(input) {
      if (input.apply) check('label write');
      return store.applyOrReadDecisionLabel(input);
    },
    async appendRecordBody(recordId, body) {
      check('record append');
      await requireActiveClaim();
      return store.appendRecordBody(recordId, body);
    },
    async appendAnswerBody(body) {
      check('answer append');
      await requireActiveClaim();
      return store.appendAnswerBody(body);
    },
    async appendReworkAuthoredBody(recordId, body, expected) {
      check('rework record append');
      return store.appendReworkAuthoredBody(recordId, body, expected);
    },
    async closeSourceIssue(expected) {
      check('source close');
      return store.closeSourceIssue(expected);
    },
    async releaseCoordinationClaim(claim) {
      check('claim release');
      return store.releaseCoordinationClaim(claim);
    },
  };
}
/** One stdout line for a resolution: the result's own fields, plus `apply`. */
function writeResolutionReport(result, apply, deps) {
  deps.writeStdout(
    `${JSON.stringify({
      ...result,
      action: result.action ?? null,
      reason: result.reason ?? null,
      apply,
    })}\n`,
  );
}
/** A refusal before any resolution read, in the resolution's stdout shape. */
function resolutionRefusalOutcome(action, reason, apply, deps) {
  const result = {
    state: 'refused',
    action,
    reason,
    steps: [],
    recordIds: [],
  };
  writeResolutionReport(result, apply, deps);
  return outcomeFor(result);
}
/** Run the `resolve` action: ask whether the choices were acceptable, and act. */
async function runResolveAction(raw, args, deps) {
  let request;
  try {
    request = buildResolveRequest(raw, {
      repository: args.repository,
      issueNumber: args.issueNumber,
    });
  } catch (error) {
    if (error instanceof RequestInputError) {
      return resolutionRefusalOutcome(
        'fix-input',
        error.message,
        args.apply,
        deps,
      );
    }
    throw error;
  }
  const [owner, repo] = args.repository.split('/');
  // Trusted marker actors come from the trusted snapshot, never the working
  // tree. A resolution reads no opt-in switch, but it cannot run without them.
  const trust = deps.readTrust({ owner, repo });
  const startFingerprint = policyFingerprint(trust);
  if (startFingerprint === null) {
    return resolutionRefusalOutcome(
      'recovery-hold',
      `the trusted repository policy is absent or unreadable: ${trust.report.error ?? 'no policy document'}`,
      args.apply,
      deps,
    );
  }
  const store = policyCheckedResolutionStore(
    deps.createStore({
      repository: args.repository,
      issueNumber: args.issueNumber,
      policy: trust.policyConfig,
    }),
    () =>
      policyFingerprint(deps.readTrust({ owner, repo })) === startFingerprint,
    {
      claimId: request.claimId,
      agentId: request.agentId,
      branch: request.branch,
    },
  );
  const result = await runProvisionalResolution(request, store, {
    apply: args.apply,
  });
  writeResolutionReport(result, args.apply, deps);
  return outcomeFor(result);
}
/**
 * Run the command for one argv. Exported so a test can drive the whole flow
 * against a stub store and trust read; the bin entry passes the real deps.
 */
export async function runProvisionalDecisionCommandCli(
  argv,
  deps = DEFAULT_PROVISIONAL_DECISION_CLI_DEPS,
) {
  let args;
  try {
    args = parseCommandArgs(argv);
  } catch (error) {
    if (error instanceof CommandUsageError) {
      return { exitCode: 2, kind: 'usage', message: error.message };
    }
    throw error;
  }
  if (args.help) {
    deps.writeStdout(USAGE);
    return 0;
  }
  let rawJson;
  try {
    rawJson = readRequestJson(args.requestPath);
  } catch (error) {
    if (error instanceof RequestInputError) {
      return requestInputOutcome(error, args.apply, deps);
    }
    throw error;
  }
  // A resolve request is refused in the resolve shape, whichever check fails.
  const wantsResolve = isPlainObject(rawJson) && rawJson.type === 'resolve';
  let shape;
  try {
    shape = validateRequestShape(rawJson);
  } catch (error) {
    if (error instanceof RequestInputError) {
      return wantsResolve
        ? resolutionRefusalOutcome('fix-input', error.message, args.apply, deps)
        : requestInputOutcome(error, args.apply, deps);
    }
    throw error;
  }
  const { type: requestType, raw: rawRequest } = shape;
  if (requestType === 'resolve') {
    return runResolveAction(rawRequest, args, deps);
  }
  const [owner, repo] = args.repository.split('/');
  // The trusted read is the #4529 authority; the store reads trusted markers
  // from the same snapshot, never from the working tree.
  const trust = deps.readTrust({ owner, repo });
  const store = deps.createStore({
    repository: args.repository,
    issueNumber: args.issueNumber,
    policy: trust.policyConfig,
  });
  const policyTrusted = authorityFrom(trust.report);
  const startFingerprint = trustFingerprint(trust);
  let request;
  try {
    request = await buildRequest(
      { type: requestType, raw: rawRequest },
      {
        repository: args.repository,
        issueNumber: args.issueNumber,
        policyTrusted,
        store,
      },
    );
  } catch (error) {
    if (error instanceof RequestInputError) {
      return requestInputOutcome(error, args.apply, deps);
    }
    // A failed history read is a read the planner would also report as a
    // recovery hold, so it gets the same structured report and exit 3.
    return readFailureOutcome(error, args.apply, deps);
  }
  const guarded = authorityCheckedStore(store, () => {
    const now = trustFingerprint(deps.readTrust({ owner, repo }));
    return now !== null && now === startFingerprint;
  });
  const result = await runProvisionalDecisionCommand(request, guarded, {
    apply: args.apply,
  });
  writeReport(reportFor(result, args.apply), deps);
  return outcomeFor(result);
}
if (import.meta.main) {
  const runFromProcess = () =>
    runProvisionalDecisionCommandCli(process.argv.slice(2));
  if (isHelperErrorEnvelopeEnabled()) {
    void runHelperCli('idd-provisional-decision', runFromProcess);
  } else {
    void runFromProcess().then(
      (outcome) => {
        if (typeof outcome !== 'number' && outcome.kind === 'usage') {
          process.stderr.write(
            `idd-provisional-decision: ${outcome.message ?? 'usage'}\n`,
          );
        }
        applyHelperCliOutcomeWhenDisabled(outcome);
      },
      (error) => {
        process.stderr.write(
          `idd-provisional-decision: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
  }
}
