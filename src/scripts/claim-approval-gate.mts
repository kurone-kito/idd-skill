#!/usr/bin/env node
// idd-generated-from: src/scripts/claim-approval-gate.mts
//
// The scripts/claim-approval-gate.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { parseCliArgs } from './cli-args.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';

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
  const authorSelfAuthorized = isAuthorizedByPolicy(
    authorPermission.permission,
    policyState.maintainerApprovalActorPolicy,
  );
  if (!authorPermission.known) {
    ambiguity.push('issue-author-permission-unavailable');
    permissionAmbiguity = true;
  }
  checks.push({
    id: 'author_self_authorized',
    name: 'Issue author self-authorized',
    result: authorSelfAuthorized ? 'pass' : 'fail',
    evidence: authorSelfAuthorized
      ? `Issue author ${issueAuthor} satisfies policy ${policyState.maintainerApprovalActorPolicy}.`
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
  if (args.token) {
    process.env.GH_TOKEN = args.token;
    process.env.GITHUB_TOKEN = args.token;
  }

  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repoRef = `${owner}/${repo}`;
  const issue = ghJson(['api', `repos/${repoRef}/issues/${args.issue}`]) as {
    number?: unknown;
    title?: unknown;
    state?: unknown;
    html_url?: unknown;
    url?: unknown;
    user?: { login?: unknown };
  };
  const comments = ghApiJson(
    `repos/${repoRef}/issues/${args.issue}/comments`,
    true,
  );
  const timelineState = fetchIssueTimeline(repoRef, args.issue ?? 0);
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
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

interface ParsedArgs {
  issue: number | null;
  owner: string;
  repo: string;
  policy: string;
  token: string;
  generatedPlanUpdatedAt: string;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(argv, CLAIM_APPROVAL_GATE_FLAG_SPEC);
  const issueToken = values.issue as string | undefined;
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
    token: (values.token as string | undefined) ?? '',
    generatedPlanUpdatedAt:
      (values['generated-plan-updated-at'] as string | undefined) ?? '',
    verbose: values.verbose as boolean,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/claim-approval-gate.mjs --issue <number> [--token <token>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--generated-plan-updated-at <ISO8601>] [--verbose]

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
  repoRef: string,
  issueNumber: number,
): { known: boolean; events: unknown } {
  try {
    const events = ghApiJson(
      `repos/${repoRef}/issues/${issueNumber}/timeline`,
      true,
      ['-H', 'Accept: application/vnd.github+json'],
    );
    return { known: true, events };
  } catch {
    return { known: false, events: [] };
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
  const result = ghApiJsonWithStatus(
    `repos/${owner}/${repo}/collaborators/${encodeURIComponent(normalized)}/permission`,
  );
  if (result.status === 404) {
    const notCollaborator: PermissionResult = {
      known: true,
      permission: 'none',
      error: '',
    };
    cache.set(normalized, notCollaborator);
    return notCollaborator;
  }
  if (result.status !== 200) {
    const unknownResult: PermissionResult = {
      known: false,
      permission: '',
      error: `permission lookup failed: ${result.status}`,
    };
    cache.set(normalized, unknownResult);
    return unknownResult;
  }
  const permission = String(
    (result.body as { permission?: unknown } | null)?.permission ?? '',
  )
    .trim()
    .toLowerCase();
  const known = permission.length > 0;
  const resolved: PermissionResult = {
    known,
    permission,
    error: known ? '' : 'permission missing in response',
  };
  cache.set(normalized, resolved);
  return resolved;
}

function loadPolicy(policyPath: string): { source: string; config: unknown } {
  const source = policyPath || '.github/idd/config.json';
  try {
    const raw = JSON.parse(readFileSync(source, 'utf8'));
    const normalized = normalizePolicyConfig(raw);
    return {
      source,
      config: {
        ...normalized,
        source,
      },
    };
  } catch {
    return {
      source,
      config: {
        skipIssueAuthorApprovalGate: false,
        maintainerApprovalActorPolicy: APPROVAL_POLICY_DEFAULT,
        source,
      },
    };
  }
}

function ghApiJson(
  path: string,
  paginate = false,
  extraArgs: string[] = [],
): unknown {
  const args = ['api', path, ...extraArgs];
  if (paginate) {
    args.push('--paginate');
  }
  return JSON.parse(runGh(args).trim() || '[]');
}

function ghApiJsonWithStatus(path: string): {
  status: number;
  body: unknown;
} {
  try {
    const body = JSON.parse(runGh(['api', path]).trim() || '{}');
    return { status: 200, body };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? '');
    const httpStatus = Number.parseInt(
      /HTTP\s+(\d+)/.exec(stderr)?.[1] ?? '0',
      10,
    );
    if (httpStatus > 0) {
      return { status: httpStatus, body: null };
    }
    return { status: 0, body: null };
  }
}

function ghJson(args: string[]): unknown {
  return JSON.parse(runGh(args).trim() || '{}');
}

function runGh(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? '').trim();
    if (stderr) {
      const wrapped = new Error(`gh command failed: ${stderr}`) as Error & {
        stderr?: string;
      };
      wrapped.stderr = stderr;
      throw wrapped;
    }
    throw error;
  }
}
