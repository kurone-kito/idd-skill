#!/usr/bin/env node

// idd-generated-from: src/scripts/provisional-decision-command.mts
//
// The scripts/provisional-decision-command.mjs copy is generated from this
// file by `pnpm run build`. Edit this source, never the generated copy.
//
// The provisional-decision command (issue #4799, from roadmap #4722). It reads
// one request JSON file, derives every trust field from a trusted source, and
// runs the planner. A dry run is the default: only `--apply` may append a
// record or apply the completion label.

import { readFileSync } from 'node:fs';
import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  type HelperCliResult,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  readTrustedAutoDecideWithConfig,
  type TrustedAutoDecideReport,
} from './idd-config.mts';
import {
  type ProvisionalDecisionBaseline,
  type ProvisionalDecisionCommandRequest,
  type ProvisionalDecisionCommandResult,
  type ProvisionalDecisionOption,
  type ProvisionalDecisionPlan,
  type ProvisionalDecisionStore,
  runProvisionalDecisionCommand,
} from './provisional-decision.mts';
import { createGithubProvisionalDecisionStore } from './provisional-decision-github.mts';
import {
  type ProvisionalDecisionRecord,
  parseProvisionalDecisionRecordComment,
} from './provisional-decision-state.mts';

const PROVISIONAL_DECISION_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--repo': { type: 'string' },
  '--request': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

const USAGE = `Usage:
  node scripts/provisional-decision-command.mjs --issue <n> --repo <owner/repo> --request <path> [--apply]

Run one provisional-decision transition for an IDD issue. The request file is
JSON. The command derives the trust fields itself: the trusted
dangerouslyAutoDecide master switch, the option comparison, the baseline of a
work transition (from the stored record), and the rework roadmaps. A request
file that supplies any of them is refused. Without --apply the command plans
only and writes nothing.

Options:
  --issue <n>          the source issue number
  --repo <owner/repo>  the repository that owns the issue
  --request <path>     the request JSON file
  --apply              append the record and apply the completion label
  --help, -h           show this help

Request fields by "type":
  all:            type, claimId, worktreeBranch, evidenceUrl (optional)
  selected:       baseline {title, bodySha256}, selectedOption,
                  feasibleAlternatives, executionCriteria (optional).
                  bodySha256 is the hex SHA-256 of the issue body's UTF-8
                  bytes, read when the options were reviewed.
  work-started:   planCommentUrl (optional)
  work-completed: verifiedHeadSha, executionCriteriaSatisfied,
                  pullRequestUrl (optional)

Output: one JSON line on stdout with state, action, reason, recordId,
commentUrl, and a plan summary when the planner made one.
Exit codes: 0 planned, applied, or refused with action none (nothing to do
yet); 2 reconciled (the record already exists; read state and action on
stdout) or a usage error (message on stderr); 3 recovery-hold (inspect
before any retry); 4 fix-input (correct the request or the issue, then
re-run).
`;

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;

type RequestType = ProvisionalDecisionCommandRequest['type'];

type RawRequest = Readonly<Record<string, unknown>>;

interface CommandArgs {
  readonly help: false;
  readonly issueNumber: number;
  readonly repository: string;
  readonly requestPath: string;
  readonly apply: boolean;
}

/** A request-file problem the operator must fix. Reported as exit 4. */
class RequestInputError extends Error {}

const COMMON_REQUEST_KEYS = [
  'type',
  'claimId',
  'worktreeBranch',
  'evidenceUrl',
] as const;

const REQUEST_KEYS_BY_TYPE: Readonly<Record<RequestType, readonly string[]>> = {
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
export function parseCommandArgs(
  argv: readonly string[],
): CommandArgs | { readonly help: true } {
  const { values, help } = parseCliArgs(argv, PROVISIONAL_DECISION_FLAG_SPEC);
  if (help) return { help: true };
  const issueToken = values.issue as string | undefined;
  const repository = values.repo as string | undefined;
  const requestPath = values.request as string | undefined;
  if (issueToken === undefined || repository === undefined) {
    throw new CommandUsageError('--issue and --repo are required');
  }
  if (requestPath === undefined) {
    throw new CommandUsageError('--request is required');
  }
  let issueNumber: number;
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

function readRequestJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new RequestInputError(
      `cannot read --request: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestInputError('--request is not valid JSON');
  }
}

function isPlainObject(value: unknown): value is RawRequest {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(raw: RawRequest, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestInputError(`request field "${key}" must be a string`);
  }
  return value;
}

function optionalString(raw: RawRequest, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new RequestInputError(`request field "${key}" must be a string`);
  }
  return value;
}

function requireBoolean(raw: RawRequest, key: string): boolean {
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
] as const;

const OPTION_OPTIONAL_TEXT_KEYS = [
  'rationale',
  'comparison',
  'rejectionReason',
] as const;

/** Check one decision option's text fields and keep only the known keys. */
function parseOption(value: unknown, field: string): ProvisionalDecisionOption {
  if (!isPlainObject(value)) {
    throw new RequestInputError(`request field "${field}" must be an object`);
  }
  const option: Record<string, string> = {};
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
  return option as unknown as ProvisionalDecisionOption;
}

function parseOptionArray(value: unknown): ProvisionalDecisionOption[] {
  if (!Array.isArray(value)) {
    throw new RequestInputError(
      'request field "feasibleAlternatives" must be an array',
    );
  }
  return value.map((item, index) =>
    parseOption(item, `feasibleAlternatives[${index}]`),
  );
}

function parseBaseline(value: unknown): ProvisionalDecisionBaseline {
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
function validateRequestShape(raw: unknown): {
  readonly type: RequestType;
  readonly raw: RawRequest;
} {
  if (!isPlainObject(raw)) {
    throw new RequestInputError('--request must hold a JSON object');
  }
  const type = raw.type;
  if (typeof type !== 'string' || !Object.hasOwn(REQUEST_KEYS_BY_TYPE, type)) {
    throw new RequestInputError(
      'request field "type" must be selected, work-started, or work-completed',
    );
  }
  const requestType = type as RequestType;
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
function authorityFrom(report: TrustedAutoDecideReport): boolean {
  return (
    report.master === 'enabled' && report.classes.decisionIssue === 'enabled'
  );
}

/**
 * Re-check the authority before every append and label write. The planner's
 * gates use the trust read taken at the start, so a revocation between that
 * read and a write must still block the write.
 */
function authorityCheckedStore(
  store: ProvisionalDecisionStore,
  authorityNow: () => boolean,
): ProvisionalDecisionStore {
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
async function latestStoredRecord(
  store: ProvisionalDecisionStore,
): Promise<ProvisionalDecisionRecord | null> {
  const history = await store.readHistory();
  // An incomplete or undated history is an unreliable read. It is reported as
  // a read failure (a recovery hold), not as a request error.
  if (!history.complete || !Number.isFinite(Date.parse(history.serverDate))) {
    throw new Error('the issue history read was incomplete or undated');
  }
  let latest: ProvisionalDecisionRecord | null = null;
  for (const comment of history.comments) {
    if (!comment.trustedAuthor || comment.edited) continue;
    const parsed = parseProvisionalDecisionRecordComment(comment.body);
    if (parsed.ok) latest = parsed.record;
  }
  return latest;
}

interface BuildContext {
  readonly repository: string;
  readonly issueNumber: number;
  readonly policyTrusted: boolean;
  readonly store: ProvisionalDecisionStore;
}

/** Build the planner request, deriving every trust field from trusted reads. */
async function buildRequest(
  shape: { readonly type: RequestType; readonly raw: RawRequest },
  context: BuildContext,
): Promise<ProvisionalDecisionCommandRequest> {
  const { raw, type } = shape;
  const base = {
    repository: context.repository,
    issueNumber: context.issueNumber,
    claimId: requireNonEmptyString(raw, 'claimId'),
    worktreeBranch: requireNonEmptyString(raw, 'worktreeBranch'),
    policyTrusted: context.policyTrusted,
    verifiedReworkRoadmaps: [] as const,
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
  const baseline: ProvisionalDecisionBaseline = {
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

function evidenceUrlField(raw: RawRequest): { evidenceUrl?: string } {
  const evidenceUrl = optionalString(raw, 'evidenceUrl');
  return evidenceUrl === undefined ? {} : { evidenceUrl };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/** One stdout line: the planner's state, with the plan minus its history. */
interface CommandReport {
  readonly state: string;
  readonly action: string | null;
  readonly reason: string | null;
  readonly recordId: string | null;
  readonly commentUrl: string | null;
  readonly apply: boolean;
  readonly plan: Record<string, unknown> | null;
}

function summarizePlan(plan: ProvisionalDecisionPlan): Record<string, unknown> {
  const { history, ...rest } = plan;
  return { ...rest, historyComments: history.comments.length };
}

function reportFor(
  result: ProvisionalDecisionCommandResult,
  apply: boolean,
): CommandReport {
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

/** The injectable boundaries: trust read, store factory, and stdout. */
export interface ProvisionalDecisionCliDeps {
  readonly writeStdout: (text: string) => void;
  readonly readTrust: typeof readTrustedAutoDecideWithConfig;
  readonly createStore: typeof createGithubProvisionalDecisionStore;
}

export const DEFAULT_PROVISIONAL_DECISION_CLI_DEPS: ProvisionalDecisionCliDeps =
  {
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    readTrust: readTrustedAutoDecideWithConfig,
    createStore: createGithubProvisionalDecisionStore,
  };

function writeReport(
  report: CommandReport,
  deps: ProvisionalDecisionCliDeps,
): void {
  deps.writeStdout(`${JSON.stringify(report)}\n`);
}

/**
 * Report a failed read while deriving the baseline as a recovery hold (exit 3),
 * in the same stdout shape as a planner result.
 */
function readFailureOutcome(
  error: unknown,
  apply: boolean,
  deps: ProvisionalDecisionCliDeps,
): HelperCliResult {
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

/** The exit code and envelope kind for a planner result. */
function outcomeFor(result: ProvisionalDecisionCommandResult): HelperCliResult {
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
function requestInputOutcome(
  error: RequestInputError,
  apply: boolean,
  deps: ProvisionalDecisionCliDeps,
) {
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
    kind: 'usage' as const,
    message: error.message,
  };
}

/**
 * Run the command for one argv. Exported so a test can drive the whole flow
 * against a stub store and trust read; the bin entry passes the real deps.
 */
export async function runProvisionalDecisionCommandCli(
  argv: readonly string[],
  deps: ProvisionalDecisionCliDeps = DEFAULT_PROVISIONAL_DECISION_CLI_DEPS,
): Promise<HelperCliResult> {
  let args: CommandArgs | { readonly help: true };
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

  let shape: { readonly type: RequestType; readonly raw: RawRequest };
  try {
    shape = validateRequestShape(readRequestJson(args.requestPath));
  } catch (error) {
    if (error instanceof RequestInputError) {
      return requestInputOutcome(error, args.apply, deps);
    }
    throw error;
  }

  const [owner, repo] = args.repository.split('/') as [string, string];
  // The trusted read is the #4529 authority; the store reads trusted markers
  // from the same snapshot, never from the working tree.
  const trust = deps.readTrust({ owner, repo });
  const store = deps.createStore({
    repository: args.repository,
    issueNumber: args.issueNumber,
    policy: trust.policyConfig,
  });

  const policyTrusted = authorityFrom(trust.report);
  let request: ProvisionalDecisionCommandRequest;
  try {
    request = await buildRequest(shape, {
      repository: args.repository,
      issueNumber: args.issueNumber,
      policyTrusted,
      store,
    });
  } catch (error) {
    if (error instanceof RequestInputError) {
      return requestInputOutcome(error, args.apply, deps);
    }
    // A failed history read is a read the planner would also report as a
    // recovery hold, so it gets the same structured report and exit 3.
    return readFailureOutcome(error, args.apply, deps);
  }

  const guarded = authorityCheckedStore(store, () =>
    authorityFrom(deps.readTrust({ owner, repo }).report),
  );
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
      (error: unknown) => {
        process.stderr.write(
          `idd-provisional-decision: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
  }
}
