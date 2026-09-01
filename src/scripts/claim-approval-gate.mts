#!/usr/bin/env node
// idd-generated-from: src/scripts/claim-approval-gate.mts
//
// The scripts/claim-approval-gate.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { parseCliArgs } from './cli-args.mts';
import { loadPolicyConfig } from './idd-config.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type { ProviderPort } from './provider-port.mts';

const APPROVAL_POLICIES = new Set([
  'owners-and-maintainers-only',
  'all-write-permission-actors',
]);
const APPROVAL_POLICY_DEFAULT = 'owners-and-maintainers-only';

interface PermissionResult {
  known: boolean;
  permission: string;
  error: string;
}

type ResolvePermission = (login: string) => unknown;

interface NormalizedIssue {
  authorLogin: string;
  authorAssociation: string;
  labels: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

interface NormalizedComment {
  authorLogin: string;
  body: string;
  createdAt: string | null;
}

interface TimelineEvent {
  event?: unknown;
  label?: unknown;
  created_at?: unknown;
  changes?: { title?: unknown; body?: unknown };
}

interface TimelineState {
  known: boolean;
  events: TimelineEvent[];
}

interface PolicyState {
  skipIssueAuthorApprovalGate: boolean;
  maintainerApprovalActorPolicy: string;
  approvalSignals: { readyLabelName: string; labelFreshnessMode: string };
  source: string;
}

interface Check {
  id: string;
  name: string;
  result: string;
  evidence?: string;
}

interface ReadyLabelState {
  approved: boolean;
  present: boolean;
  freshnessUnknown: boolean;
  evidence: string;
}

interface ApprovalCommentState {
  comment: NormalizedComment | null;
  permissionUnknown: boolean;
  totalCandidates: number;
}

interface EvaluateInput {
  issue?: unknown;
  comments?: unknown;
  timeline?: unknown;
  policy?: unknown;
  generatedPlanUpdatedAt?: unknown;
}

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
const CLAIM_APPROVAL_GATE_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--policy': { type: 'string' },
  '--gh-token': { type: 'string' },
  '--token': { type: 'string' },
  '--generated-plan-updated-at': { type: 'string' },
  '--verbose': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  runCli();
}

export function evaluateClaimApprovalGate(
  input: EvaluateInput,
  options: { resolvePermission?: ResolvePermission } = {},
) {
  const issue = normalizeIssue(input.issue);
  const comments = normalizeComments(input.comments);
  const timelineState = normalizeTimeline(input.timeline);
  const policyState = normalizePolicy(input.policy);
  const generatedPlanState = detectGeneratedPlanUpdateAt({
    comments,
    override: input.generatedPlanUpdatedAt,
  });
  const resolvePermission: ResolvePermission =
    typeof options.resolvePermission === 'function'
      ? options.resolvePermission
      : () => ({
          known: false,
          permission: '',
          error: 'permission resolver missing',
        });

  const checks: Check[] = [];
  const gateEnabled = !policyState.skipIssueAuthorApprovalGate;
  checks.push({
    id: 'gate_enabled',
    name: 'Issue-author gate enabled',
    result: gateEnabled ? 'pass' : 'fail',
    evidence: gateEnabled
      ? 'skipIssueAuthorApprovalGate is not true.'
      : 'skipIssueAuthorApprovalGate=true; gate bypassed.',
  });

  if (!gateEnabled) {
    return {
      approved: true,
      reason: 'gate-disabled',
      gateEnabled: false,
      policy: {
        skipIssueAuthorApprovalGate: true,
        maintainerApprovalActorPolicy:
          policyState.maintainerApprovalActorPolicy,
        approvalSignals: policyState.approvalSignals,
        source: policyState.source,
      },
      checks,
    };
  }

  const ambiguity: string[] = [];
  let permissionAmbiguity = false;
  const issueAuthor = issue.authorLogin;
  const authorPermission = issueAuthor
    ? normalizePermissionResult(resolvePermission(issueAuthor))
    : { known: false, permission: '', error: 'issue author missing' };
  const associationSelfAuthorized = authorAssociationSelfAuthorizes(
    issue.authorAssociation,
    policyState.maintainerApprovalActorPolicy,
  );
  const authorSelfAuthorized =
    isAuthorizedByPolicy(
      authorPermission.permission,
      policyState.maintainerApprovalActorPolicy,
    ) ||
    (!authorPermission.known && associationSelfAuthorized);
  if (!authorPermission.known && !associationSelfAuthorized) {
    ambiguity.push('issue-author-permission-unavailable');
    permissionAmbiguity = true;
  }
  checks.push({
    id: 'author_self_authorized',
    name: 'Issue author self-authorized',
    result: authorSelfAuthorized ? 'pass' : 'fail',
    evidence: authorSelfAuthorized
      ? authorPermission.known
        ? `Issue author ${issueAuthor} satisfies policy ${policyState.maintainerApprovalActorPolicy}.`
        : `Issue author ${issueAuthor} author_association ${issue.authorAssociation} satisfies policy ${policyState.maintainerApprovalActorPolicy} without a collaborators-permission read (#2148).`
      : `Issue author ${issueAuthor || '(missing)'} does not satisfy policy ${policyState.maintainerApprovalActorPolicy}.`,
  });

  const latestSubstantiveEditAt = resolveLatestSubstantiveEditAt(
    issue,
    timelineState,
  );
  const freshnessAnchor = maxTimestamp(
    latestSubstantiveEditAt,
    generatedPlanState.updatedAt,
  );
  const freshnessDeterminable =
    latestSubstantiveEditAt !== null && generatedPlanState.known;
  const readyLabelState = resolveReadyLabelApproval({
    issue,
    timelineState,
    policy: policyState,
    freshnessAnchor,
    freshnessDeterminable,
  });
  if (readyLabelState.freshnessUnknown) {
    ambiguity.push('ready-label-freshness-unavailable');
  }
  checks.push({
    id: 'ready_label_present',
    name: 'Configured ready label approval',
    result: readyLabelState.approved ? 'pass' : 'fail',
    evidence: readyLabelState.evidence,
  });

  const approvalCommentState = findLatestReadyApprovalComment({
    comments,
    policy: policyState.maintainerApprovalActorPolicy,
    resolvePermission,
  });
  if (approvalCommentState.permissionUnknown) {
    ambiguity.push('approval-comment-permission-unavailable');
    permissionAmbiguity = true;
  }

  let readyCommentFresh = false;
  if (
    approvalCommentState.comment &&
    freshnessDeterminable &&
    freshnessAnchor
  ) {
    readyCommentFresh =
      compareIso(approvalCommentState.comment.createdAt, freshnessAnchor) > 0;
  }
  checks.push({
    id: 'ready_comment_fresh',
    name: 'Fresh maintainer approval comment',
    result: readyCommentFresh ? 'pass' : 'fail',
    evidence: buildReadyCommentEvidence({
      approvalCommentState,
      freshnessDeterminable,
      freshnessAnchor,
    }),
  });

  const timelineKnown = timelineState.known;
  if (!timelineKnown) {
    ambiguity.push('issue-timeline-unavailable');
  }
  if (!generatedPlanState.known) {
    ambiguity.push('generated-plan-freshness-unavailable');
  }

  const ambiguityBlocking =
    ambiguity.length > 0 &&
    !authorSelfAuthorized &&
    !readyLabelState.approved &&
    !readyCommentFresh;
  checks.push({
    id: 'ambiguity_guard',
    name: 'Fail-closed ambiguity guard',
    result: ambiguityBlocking ? 'fail' : 'pass',
    evidence: ambiguityBlocking
      ? `Approval state is ambiguous: ${ambiguity.join(', ')}`
      : ambiguity.length > 0
        ? `Ambiguity present but bypassed by explicit/author approval: ${ambiguity.join(', ')}`
        : 'No ambiguity detected.',
  });

  const approved =
    authorSelfAuthorized ||
    readyLabelState.approved ||
    (readyCommentFresh && !ambiguityBlocking);
  return {
    approved,
    reason: deriveReason({
      approved,
      authorSelfAuthorized,
      readyLabelApproved: readyLabelState.approved,
      readyLabelFreshnessUnknown: readyLabelState.freshnessUnknown,
      readyCommentFresh,
      hasAuthorizedReadyComment: Boolean(approvalCommentState.comment),
      ambiguityBlocking,
      permissionAmbiguity,
      freshnessDeterminable,
    }),
    gateEnabled: true,
    policy: {
      skipIssueAuthorApprovalGate: false,
      maintainerApprovalActorPolicy: policyState.maintainerApprovalActorPolicy,
      approvalSignals: policyState.approvalSignals,
      source: policyState.source,
    },
    checks,
  };
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
  const rawIssue = port.getWorkItem(args.issue ?? 0);
  if (!rawIssue) {
    throw new Error(`issue #${args.issue} not found`);
  }
  // Remapped back to the raw REST (snake_case) shape normalizeIssue() and
  // the output block below both already expect -- ProviderWorkItem's
  // camelCase fields (and getWorkItem's uppercased state) are a port-level
  // convention, not this file's pre-migration contract.
  const issue = {
    number: rawIssue.number,
    title: rawIssue.title,
    state: rawIssue.state.toLowerCase(),
    html_url: rawIssue.htmlUrl,
    url: rawIssue.url,
    user: rawIssue.user as { login?: unknown } | undefined,
    author_association: rawIssue.authorAssociation,
    labels: rawIssue.labels,
    created_at: rawIssue.createdAt,
    updated_at: rawIssue.updatedAt,
  };
  const comments = port.listWorkItemComments(args.issue ?? 0).map((c) => ({
    user: { login: c.authorLogin },
    body: c.body,
    created_at: c.createdAt,
  }));
  const timelineState = fetchIssueTimeline(port, args.issue ?? 0);
  const policy = loadPolicy(args.policy);
  const permissionCache = new Map<string, PermissionResult>();
  const resolvePermission: ResolvePermission = (login) =>
    resolveCollaboratorPermission({
      owner,
      repo,
      login,
      cache: permissionCache,
    });

  const result = evaluateClaimApprovalGate(
    {
      issue,
      comments,
      timeline: timelineState.events,
      policy: policy.config,
      generatedPlanUpdatedAt: args.generatedPlanUpdatedAt,
    },
    { resolvePermission },
  );
  const output = {
    repository: { owner, repo },
    issue: {
      number: Number.parseInt(String(issue.number), 10),
      title: String(issue.title ?? ''),
      state: String(issue.state ?? ''),
      url: String(issue.html_url ?? issue.url ?? ''),
      author: String(issue.user?.login ?? ''),
    },
    approved: result.approved,
    reason: result.reason,
    gateEnabled: result.gateEnabled,
    policy: result.policy,
    checks: args.verbose
      ? result.checks
      : result.checks.map((check) => ({
          id: check.id,
          name: check.name,
          result: check.result,
        })),
    timelineAvailable: timelineState.known,
    timelineParseError: timelineState.parseError,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

interface ParsedArgs {
  issue: number | null;
  owner: string;
  repo: string;
  policy: string;
  ghToken: string;
  generatedPlanUpdatedAt: string;
  verbose: boolean;
  help: boolean;
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

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(argv, CLAIM_APPROVAL_GATE_FLAG_SPEC);
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
    // matching the pre-migration contract exactly: this file's own
    // "!Number.isInteger(args.issue) || (args.issue ?? 0) <= 0" post-check
    // (in runCli, unchanged) already rejects a non-canonical result, so
    // tightening at this layer would be an untested, out-of-scope
    // behavior change for this behavior-preserving migration (see #1451).
    issue: issueToken === undefined ? null : Number.parseInt(issueToken, 10),
    owner: (values.owner as string | undefined) ?? '',
    repo: (values.repo as string | undefined) ?? '',
    policy: (values.policy as string | undefined) ?? '',
    ghToken: ghToken ?? '',
    generatedPlanUpdatedAt:
      (values['generated-plan-updated-at'] as string | undefined) ?? '',
    verbose: values.verbose as boolean,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/claim-approval-gate.mjs --issue <number> [--gh-token <token>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--generated-plan-updated-at <ISO8601>] [--verbose]
  Deprecated aliases (one release): --token -> --gh-token

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "issue": {"number": 393, "title": "...", "state": "OPEN", "url": "...", "author": "..."},
  "approved": true,
  "reason": "gate-disabled|author-self-authorized|ready-label-present|ready-comment-fresh|approval-missing|approval-ambiguous|approval-comment-stale|freshness-undetermined",
  "gateEnabled": true,
  "policy": {"skipIssueAuthorApprovalGate": false, "maintainerApprovalActorPolicy": "owners-and-maintainers-only", "approvalSignals": {"readyLabelName": "idd:ready", "labelFreshnessMode": "presence-only"}, "source": ".github/idd/config.json"},
  "checks": [{"id":"gate_enabled","name":"Issue-author gate enabled","result":"pass|fail","evidence":"..."}],
  "timelineAvailable": true
}
`);
}

function normalizeIssue(issue: unknown): NormalizedIssue {
  const i = issue as
    | {
        user?: { login?: unknown };
        author_association?: unknown;
        labels?: unknown;
        created_at?: unknown;
        updated_at?: unknown;
      }
    | null
    | undefined;
  return {
    authorLogin: String(i?.user?.login ?? '')
      .trim()
      .toLowerCase(),
    authorAssociation: String(i?.author_association ?? '')
      .trim()
      .toLowerCase(),
    labels: normalizeLabels(i?.labels),
    createdAt: normalizeIso(i?.created_at),
    updatedAt: normalizeIso(i?.updated_at),
  };
}

function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  return (labels as unknown[])
    .map((label) =>
      typeof label === 'string'
        ? label
        : ((label as { name?: unknown })?.name ?? ''),
    )
    .map((label) => String(label).trim().toLowerCase())
    .filter(Boolean);
}

function normalizeComments(comments: unknown): NormalizedComment[] {
  if (!Array.isArray(comments)) {
    return [];
  }
  return (comments as unknown[])
    .map((comment) => ({
      authorLogin: String(
        (comment as { user?: { login?: unknown } })?.user?.login ?? '',
      )
        .trim()
        .toLowerCase(),
      body: String((comment as { body?: unknown })?.body ?? ''),
      createdAt: normalizeIso(
        (comment as { created_at?: unknown })?.created_at,
      ),
    }))
    .filter((comment) => comment.createdAt !== null);
}

function normalizeTimeline(timeline: unknown): TimelineState {
  if (!Array.isArray(timeline)) {
    return { known: false, events: [] };
  }
  return { known: true, events: timeline as TimelineEvent[] };
}

function normalizePolicy(policy: unknown): PolicyState {
  const normalized = normalizePolicyConfig(policy);
  return {
    skipIssueAuthorApprovalGate: normalized.skipIssueAuthorApprovalGate,
    maintainerApprovalActorPolicy: APPROVAL_POLICIES.has(
      normalized.maintainerApprovalActorPolicy,
    )
      ? normalized.maintainerApprovalActorPolicy
      : APPROVAL_POLICY_DEFAULT,
    approvalSignals: {
      readyLabelName: String(normalized.approvalSignals.readyLabelName ?? '')
        .trim()
        .toLowerCase(),
      labelFreshnessMode: String(
        normalized.approvalSignals.labelFreshnessMode ?? 'presence-only',
      ),
    },
    source: String(
      (policy as { source?: unknown } | null)?.source ??
        '.github/idd/config.json',
    ),
  };
}

function resolveReadyLabelApproval({
  issue,
  timelineState,
  policy,
  freshnessAnchor,
  freshnessDeterminable,
}: {
  issue: NormalizedIssue;
  timelineState: TimelineState;
  policy: PolicyState;
  freshnessAnchor: string | null;
  freshnessDeterminable: boolean;
}): ReadyLabelState {
  const readyLabelName = policy.approvalSignals.readyLabelName;
  const labelDisplayName = readyLabelName || 'idd:ready';
  const hasReadyLabel = issue.labels.includes(readyLabelName);

  if (!hasReadyLabel) {
    return {
      approved: false,
      present: false,
      freshnessUnknown: false,
      evidence: `Configured ready label ${labelDisplayName} is absent.`,
    };
  }

  if (policy.approvalSignals.labelFreshnessMode !== 'event-freshness') {
    return {
      approved: true,
      present: true,
      freshnessUnknown: false,
      evidence: `Configured ready label ${labelDisplayName} is present; labelFreshnessMode=presence-only.`,
    };
  }

  if (!timelineState.known) {
    return {
      approved: false,
      present: true,
      freshnessUnknown: true,
      evidence: `Configured ready label ${labelDisplayName} is present, but the issue timeline is unavailable for label freshness checks.`,
    };
  }

  if (!freshnessDeterminable || !freshnessAnchor) {
    return {
      approved: false,
      present: true,
      freshnessUnknown: true,
      evidence: `Configured ready label ${labelDisplayName} is present, but the freshness anchor could not be determined.`,
    };
  }

  const latestLabelEvent = findLatestReadyLabelEvent(
    timelineState.events,
    readyLabelName,
  );
  if (latestLabelEvent?.event !== 'labeled') {
    return {
      approved: false,
      present: true,
      freshnessUnknown: true,
      evidence: `Configured ready label ${labelDisplayName} is present, but no matching label application event was found in the issue timeline.`,
    };
  }

  const fresh = compareIso(latestLabelEvent.createdAt, freshnessAnchor) > 0;
  return {
    approved: fresh,
    present: true,
    freshnessUnknown: false,
    evidence: `Configured ready label ${labelDisplayName} was last applied at ${latestLabelEvent.createdAt}; freshness anchor is ${freshnessAnchor}.`,
  };
}

function detectGeneratedPlanUpdateAt({
  comments,
  override,
}: {
  comments: NormalizedComment[];
  override: unknown;
}): { known: boolean; updatedAt: string | null } {
  const overrideIso = normalizeIso(override);
  if (override && !overrideIso) {
    return { known: false, updatedAt: null };
  }
  if (overrideIso) {
    return { known: true, updatedAt: overrideIso };
  }
  if (!Array.isArray(comments)) {
    return { known: false, updatedAt: null };
  }
  const generatedPlanComments = comments
    .filter((comment) => /\bgenerated[- ]plan\b/i.test(comment.body))
    .map((comment) => comment.createdAt)
    .filter(Boolean);
  return { known: true, updatedAt: maxTimestamp(...generatedPlanComments) };
}

function resolveLatestSubstantiveEditAt(
  issue: NormalizedIssue,
  timelineState: TimelineState,
): string | null {
  if (!timelineState.known) {
    return null;
  }
  const editedAt = timelineState.events
    .filter((event) => String(event?.event ?? '') === 'edited')
    .filter((event) => event?.changes?.title || event?.changes?.body)
    .map((event) => normalizeIso(event?.created_at))
    .filter(Boolean);
  return maxTimestamp(issue.createdAt, ...editedAt);
}

interface NormalizedLabelEvent {
  event: string;
  labelName: string;
  createdAt: string | null;
}

function findLatestReadyLabelEvent(
  events: unknown,
  readyLabelName: string,
): NormalizedLabelEvent | null {
  if (!Array.isArray(events)) {
    return null;
  }
  const relevant = (events as TimelineEvent[])
    .map((event) => ({
      event: String(event?.event ?? '')
        .trim()
        .toLowerCase(),
      labelName: normalizeLabelName(event?.label),
      createdAt: normalizeIso(event?.created_at),
    }))
    .filter((event) => event.createdAt !== null)
    .filter((event) => event.event === 'labeled' || event.event === 'unlabeled')
    .filter((event) => event.labelName === readyLabelName)
    .sort((left, right) => compareIso(left.createdAt, right.createdAt));
  return relevant.length > 0 ? relevant[relevant.length - 1] : null;
}

function normalizeLabelName(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }
  return String((value as { name?: unknown } | null)?.name ?? '')
    .trim()
    .toLowerCase();
}

function findLatestReadyApprovalComment({
  comments,
  policy,
  resolvePermission,
}: {
  comments: NormalizedComment[];
  policy: string;
  resolvePermission: ResolvePermission;
}): ApprovalCommentState {
  const readyCandidates = comments.filter((comment) =>
    hasReadySignal(comment.body),
  );
  let permissionUnknown = false;
  const authorized: NormalizedComment[] = [];

  for (const candidate of readyCandidates) {
    const permission = normalizePermissionResult(
      resolvePermission(candidate.authorLogin),
    );
    if (!permission.known) {
      permissionUnknown = true;
      continue;
    }
    if (isAuthorizedByPolicy(permission.permission, policy)) {
      authorized.push(candidate);
    }
  }

  authorized.sort((left, right) => compareIso(left.createdAt, right.createdAt));
  return {
    comment: authorized.length > 0 ? authorized[authorized.length - 1] : null,
    permissionUnknown,
    totalCandidates: readyCandidates.length,
  };
}

function hasReadySignal(body: unknown): boolean {
  const trimmed = String(body ?? '').trim();
  if (trimmed === 'IDD ready') {
    return true;
  }
  return String(body ?? '')
    .split(/\r?\n/)
    .some((line) => line.trim() === 'IDD ready');
}

function buildReadyCommentEvidence({
  approvalCommentState,
  freshnessDeterminable,
  freshnessAnchor,
}: {
  approvalCommentState: ApprovalCommentState;
  freshnessDeterminable: boolean;
  freshnessAnchor: string | null;
}): string {
  if (!approvalCommentState.comment) {
    return approvalCommentState.totalCandidates > 0
      ? 'Ready comments exist but none came from an authorized actor.'
      : 'No standalone IDD ready comment found.';
  }
  if (!freshnessDeterminable || !freshnessAnchor) {
    return 'Ready comment found, but freshness anchor could not be determined.';
  }
  return `Latest authorized ready comment at ${approvalCommentState.comment.createdAt}; freshness anchor is ${freshnessAnchor}.`;
}

function deriveReason(state: {
  approved: boolean;
  authorSelfAuthorized: boolean;
  readyLabelApproved: boolean;
  readyLabelFreshnessUnknown: boolean;
  readyCommentFresh: boolean;
  hasAuthorizedReadyComment: boolean;
  ambiguityBlocking: boolean;
  permissionAmbiguity: boolean;
  freshnessDeterminable: boolean;
}): string {
  if (!state.approved) {
    if (state.permissionAmbiguity) {
      return 'approval-ambiguous';
    }
    if (state.readyLabelFreshnessUnknown) {
      return 'freshness-undetermined';
    }
    if (!state.freshnessDeterminable) {
      return 'freshness-undetermined';
    }
    if (state.ambiguityBlocking) {
      return 'approval-ambiguous';
    }
    if (state.hasAuthorizedReadyComment && state.readyCommentFresh === false) {
      return 'approval-comment-stale';
    }
    return 'approval-missing';
  }
  if (state.authorSelfAuthorized) {
    return 'author-self-authorized';
  }
  if (state.readyLabelApproved) {
    return 'ready-label-present';
  }
  if (state.readyCommentFresh) {
    return 'ready-comment-fresh';
  }
  return 'gate-disabled';
}

/** #2148: live issue `author_association` is enough for self-authorization
 * when the collaborators-permission endpoint is unavailable. OWNER is
 * always sufficient; MEMBER is accepted under the default
 * owners-and-maintainers-only policy (the observed payload for an org
 * owner when REST /permission 503s). */
function authorAssociationSelfAuthorizes(
  association: string,
  policy: string,
): boolean {
  if (association === 'owner') {
    return true;
  }
  if (association === 'member') {
    return (
      policy === 'owners-and-maintainers-only' ||
      policy === 'all-write-permission-actors'
    );
  }
  return false;
}

function isAuthorizedByPolicy(permission: string, policy: string): boolean {
  if (policy === 'all-write-permission-actors') {
    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  }
  return permission === 'admin' || permission === 'maintain';
}

function normalizePermissionResult(value: unknown): PermissionResult {
  if (!value || typeof value !== 'object') {
    return { known: false, permission: '', error: 'invalid permission result' };
  }
  const v = value as { permission?: unknown; known?: unknown; error?: unknown };
  const permission = String(v.permission ?? '')
    .trim()
    .toLowerCase();
  return {
    known: Boolean(v.known),
    permission,
    error: String(v.error ?? ''),
  };
}

function normalizeIso(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function compareIso(left: string | null, right: string | null): number {
  const leftTime = new Date(left as string).getTime();
  const rightTime = new Date(right as string).getTime();
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return 0;
  }
  return leftTime - rightTime;
}

function maxTimestamp(...values: (string | null | undefined)[]): string | null {
  const normalized = values
    .filter(Boolean)
    .map((value) => normalizeIso(value))
    .filter((value): value is string => value !== null);
  if (normalized.length === 0) {
    return null;
  }
  normalized.sort(compareIso);
  return normalized[normalized.length - 1];
}

function fetchIssueTimeline(
  port: ProviderPort,
  issueNumber: number,
): { known: boolean; events: unknown; parseError: string } {
  try {
    const events = port.getWorkItemTimeline(issueNumber);
    return { known: true, events, parseError: '' };
  } catch (error) {
    // #1692: a `SyntaxError` means the gh call itself succeeded but its
    // output could not be parsed -- a bug, not a legitimate "timeline
    // unavailable" case (missing issue, permission denial, network
    // failure, all of which throw from `runGh` before parsing is ever
    // reached). Surface it via `parseError` instead of silently
    // collapsing into the same `known: false` shape a genuine absence
    // produces, so it stays visible in the CLI's JSON output rather than
    // being indistinguishable from "no timeline data".
    const parseError = error instanceof SyntaxError ? error.message : '';
    return { known: false, events: [], parseError };
  }
}

function resolveCollaboratorPermission({
  owner,
  repo,
  login,
  cache,
}: {
  owner: string;
  repo: string;
  login: unknown;
  cache: Map<string, PermissionResult>;
}): PermissionResult {
  const normalized = String(login ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return { known: false, permission: '', error: 'empty login' };
  }
  const cached = cache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }
  const outcome = createGithubProviderAdapter(
    owner,
    repo,
  ).getCollaboratorPermission(normalized);
  if (outcome.outcome === 'not-collaborator') {
    const notCollaborator: PermissionResult = {
      known: true,
      permission: 'none',
      error: '',
    };
    cache.set(normalized, notCollaborator);
    return notCollaborator;
  }
  if (outcome.outcome === 'error') {
    // Reconstructed (not outcome.error.message) to keep this file's
    // pre-migration wording byte-exact -- see ProviderCollaboratorPermissionResult's
    // `httpStatus` doc comment. `?? 0` matches the pre-migration
    // ghApiJsonWithStatus's own "status could not be determined" sentinel.
    const unknownResult: PermissionResult = {
      known: false,
      permission: '',
      error: `permission lookup failed: ${outcome.httpStatus ?? 0}`,
    };
    cache.set(normalized, unknownResult);
    return unknownResult;
  }
  const known = outcome.permission.length > 0;
  const resolved: PermissionResult = {
    known,
    permission: outcome.permission,
    error: known ? '' : 'permission missing in response',
  };
  cache.set(normalized, resolved);
  return resolved;
}

// Read-and-parse failure semantics (explicit path throws; default path
// silently falls back only on ENOENT) are converged in idd-config.mts's
// loadPolicyConfig (#1721); this helper keeps its own shape normalization —
// normalizePolicyConfig's full defaults on a missing/absent config, and the
// `source` field embedded in `config` so normalizePolicy() (below) can read
// it back out of the value evaluateClaimApprovalGate receives.
function loadPolicy(policyPath: string): { source: string; config: unknown } {
  const { path: source, config: rawConfig } = loadPolicyConfig(policyPath);
  const normalized = normalizePolicyConfig(rawConfig);
  return {
    source,
    config: {
      ...normalized,
      source,
    },
  };
}
