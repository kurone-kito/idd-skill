// idd-generated-from: src/scripts/protocol-helpers.mts
//
// The scripts/protocol-helpers.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { Buffer } from 'node:buffer';
import {
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  normalizeAdvisoryWaitRuntimeOptions,
} from './advisory-wait-policy.mts';
import {
  getReviewEscalationChangesRequestedPolicy,
  parseIsoDurationToMs,
} from './policy-helpers.mts';

// ---------------------------------------------------------------------------
// Structural input shapes (GitHub REST/GraphQL payloads as consumed here).
// ---------------------------------------------------------------------------

/** Author reference embedded in GitHub comment/review payloads. */
interface AuthorRef {
  login?: string | null;
}

/** Issue/PR comment as consumed by the protocol helpers. */
interface CommentLike {
  id?: string | number | null;
  body?: string | null;
  author?: AuthorRef | null;
  user?: AuthorRef | null;
  createdAt?: string | null;
  created_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
  url?: string | null;
}

/** Review-thread reply node (GraphQL `reviewThreads` comment). */
interface ThreadCommentLike {
  id?: string | number | null;
  body?: string | null;
  author?: AuthorRef | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  pullRequestReview?: { id?: string | null } | null;
}

/** Review thread (GraphQL `reviewThreads` node). */
interface ThreadLike {
  id?: string | null;
  isResolved?: boolean | null;
  updatedAt?: string | null;
  reviewerReopenedAt?: string | null;
  comments?: {
    nodes?: ThreadCommentLike[] | null;
    pageInfo?: { hasNextPage?: boolean | null } | null;
  } | null;
}

/** PR review object (REST or GraphQL shape). */
interface ReviewLike {
  state?: string | null;
  author?: AuthorRef | null;
  user?: AuthorRef | null;
  submittedAt?: string | null;
  submitted_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  createdAt?: string | null;
  commitId?: string | null;
  commit_id?: string | null;
}

/** CI status-check entry. */
interface CheckLike {
  name?: string | null;
  state?: string | null;
  completedAt?: string | null;
}

/** PR timeline event as consumed by the Copilot-coverage helpers. */
interface TimelineEventLike {
  event?: string | null;
  sha?: string | null;
  commit_id?: string | null;
  requested_reviewer?: AuthorRef | null;
}

/** Requested reviewer entry (login string or reviewer object). */
type RequestedReviewerLike =
  | string
  | { login?: string | null; user?: AuthorRef | null }
  | null
  | undefined;

/** Identity fields shared by required-reviewer references. */
interface RequiredReviewerRef {
  type?: unknown;
  id?: unknown;
  login?: unknown;
  slug?: unknown;
  team?: unknown;
  name?: unknown;
}

/** Required-reviewer rule entry (string or nested reviewer object). */
type RequiredReviewerLike =
  | string
  | (RequiredReviewerRef & {
      reviewer?: RequiredReviewerRef | null;
      minimum_approvals?: unknown;
      min_approvals?: unknown;
      file_patterns?: unknown[] | null;
      filePatterns?: unknown[] | null;
    })
  | null
  | undefined;

/** Required status-check entry in rules or classic protection payloads. */
type RawRequiredCheckLike =
  | string
  | {
      app_id?: unknown;
      integration_id?: unknown;
      source?: unknown;
      context?: unknown;
      name?: unknown;
      check?: unknown;
    }
  | null
  | undefined;

/** Check-bearing parameters object (rules or classic protection). */
interface RequiredCheckParametersLike {
  required_status_checks?: RawRequiredCheckLike[] | null;
  required_checks?: RawRequiredCheckLike[] | null;
  checks?: RawRequiredCheckLike[] | null;
  contexts?: RawRequiredCheckLike[] | null;
}

/** Branch rule entry from the rules API. */
interface BranchRuleLike {
  type?: string | null;
  ruleset_id?: unknown;
  ruleset_source_type?: unknown;
  source_type?: unknown;
  ruleset_source?: unknown;
  source?: unknown;
  parameters?:
    | (RequiredCheckParametersLike & {
        required_approving_review_count?: unknown;
        require_code_owner_review?: unknown;
        required_review_thread_resolution?: unknown;
        required_reviewers?: RequiredReviewerLike[] | null;
        workflows?: unknown;
      })
    | null;
}

/** Branch ruleset entry from the rulesets API. */
interface BranchRulesetLike {
  id?: unknown;
  ruleset_id?: unknown;
  current_user_can_bypass?: unknown;
  bypass_actors?: unknown;
}

/** Classic branch-protection payload. */
interface BranchProtectionLike {
  required_pull_request_reviews?: {
    require_code_owner_reviews?: unknown;
    require_code_owner_review?: unknown;
    required_approving_review_count?: unknown;
    bypass_pull_request_allowances?: {
      users?: (string | { login?: unknown } | null)[] | null;
      teams?: (string | { slug?: unknown } | null)[] | null;
      apps?: (string | { slug?: unknown; app_slug?: unknown } | null)[] | null;
    } | null;
  } | null;
  required_conversation_resolution?: { enabled?: unknown } | null;
  required_status_checks?: RequiredCheckParametersLike | null;
}

/** Parsed CODEOWNERS rule line. */
interface CodeownersRule {
  pattern: string;
  users: string[];
  teams: string[];
  emails: string[];
}

/** Operational marker matcher entry. */
interface OperationalMarker {
  label: string;
  pattern: RegExp;
  startPattern?: RegExp;
}

/** Live-status digest field inputs (validated at render time). */
export interface LiveStatusDigestFields {
  phase?: unknown;
  claim?: unknown;
  branch?: unknown;
  lastChecked?: unknown;
  openBlockers?: unknown;
  nextAction?: unknown;
  authoritativeBy?: unknown;
}

/** Inputs for the advisory-wait outcome state machine. */
interface AdvisoryWaitOutcomeInput {
  lastCopilotCommit?: string | null;
  prHeadSha?: string | null;
  copilotPending?: boolean;
  copilotPendingCoversHead?: boolean;
  sameHeadMarkerPresent?: boolean;
  requestMarkerCount: number;
  elapsedMinutes: number;
  requestCap?: number;
  pendingWindowMinutes?: number;
  settledWindowMinutes?: number;
}

/** Normalized required-reviewer requirement row. */
interface ReviewerRequirement {
  identity: string;
  minimumApprovals: number;
  filePatterns: string[];
}

// ---------------------------------------------------------------------------
// Protocol data shapes crossing module boundaries.
// ---------------------------------------------------------------------------

/** Parsed `<!-- claimed-by: ... -->` claim marker. */
export interface ParsedClaimMarker {
  agentId: string;
  claimId: string;
  supersedes: string;
  branch: string;
  createdAt: string;
}

/** Parsed `<!-- unclaimed-by: ... -->` release marker. */
export interface ParsedReleaseMarker {
  agentId: string;
  claimId: string;
}

/** Parsed `<!-- forced-handoff: {...} -->` marker payload. */
export interface ParsedForcedHandoffMarker {
  oldAgentId: string;
  oldClaimId: string;
  newAgentId: string;
  newClaimId: string;
  branch: string;
  linkedPr?: string;
  forcedBy: string;
  reason: string;
  timestamp: string;
  contextScope: string;
  createdAt?: string;
}

/** Parsed `<!-- idd-external-check-waiver: ... -->` marker. */
export interface ParsedExternalCheckWaiver {
  agentId: string;
  claimId: string;
  headSha: string;
  checkSelector: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
}

/** Parsed `<!-- review-watermark: ... -->` marker. */
export interface ParsedReviewWatermark {
  agentId: string;
  claimId: string;
  headSha: string;
  maxActivityUpdatedAt: string;
  totalItemCount: number;
  latestCiCompletedAt: string;
  createdAt: string;
}

/** Classification of a standalone advisory-bot comment. */
export interface CommentClassification {
  classifier: 'RESOLVED' | 'OUTDATED';
  reason: string;
}

/** Generic route decision returned by the gate evaluators. */
export interface RouteDecision {
  route: string;
  reason: string;
}

/** Trusted-marker actor resolution with its provenance. */
export interface TrustedMarkerActorResolution {
  actors: string[];
  source: 'flag' | 'env' | 'config' | 'none';
}

/** Union of trusted-marker actors collected across sources. */
export interface TrustedMarkerActorSourceMix {
  actors: string[];
  sources: string[];
}

/** Advisory-bot login resolution with its provenance. */
export interface AdvisoryBotLoginResolution {
  logins: string[];
  source: 'flag' | 'env' | 'config' | 'none';
}

/** External-check waiver evidence grouped by validity bucket. */
export interface ExternalCheckWaiverEvidence {
  valid: {
    authorLogin: string;
    checkSelector: string;
    reason: string;
    expiresAt: string;
  }[];
  expired: { authorLogin: string; checkSelector: string; expiresAt: string }[];
  wrongHead: {
    authorLogin: string;
    checkSelector: string;
    waiverHeadSha: string;
  }[];
  wrongClaim: {
    authorLogin: string;
    checkSelector: string;
    waiverClaimId: string;
  }[];
  unauthorized: {
    authorLogin: string;
    checkSelector: string;
    expiresAt: string;
  }[];
  malformed: { authorLogin: string; bodyPreview: string }[];
  /**
   * Waivers that passed every validity check but name a check the policy
   * never declared waivable (`ciGate.externalChecks.waivable`); they are
   * excluded from `valid` and never fold a check into `requiredChecksPassing`.
   */
  notConfigured: {
    authorLogin: string;
    checkSelector: string;
    expiresAt: string;
  }[];
}

/** Classification outcome for a single review thread at the gate. */
export interface ReviewThreadGateClassification {
  classification:
    | 'resolved'
    | 'actionable-blocking'
    | 'amd-blocking'
    | 'awaiting-reviewer'
    | 'conversation-resolve-agent'
    | 'conversation-resolve-author';
}

/** Aggregated review-thread gate counts. */
export interface ReviewThreadsGateSummary {
  actionableCount: number;
  awaitingReviewerCount: number;
  amdBlockingCount: number;
  conversationResolveAgentCount: number;
  conversationResolveAuthorCount: number;
  classifications: {
    id: string | null | undefined;
    classification: ReviewThreadGateClassification['classification'];
  }[];
}

/** Unreplied regular-comment summary for the merge gate. */
export interface RegularCommentsGateSummary {
  count: number;
  items: {
    id: string;
    authorLogin: string;
    createdAt: string;
    bodyPreview: string;
  }[];
}

/** Disposition-evidence gate outcome (E7 evidence at F2/F3). */
export interface DispositionEvidenceSummary {
  route: 'return-to-e1' | 'proceed';
  reason: string;
  blockingCount: number;
  missingRegularCommentCount: number;
  missingThreadCount: number;
  // Advisory-only (#978): true when there is at least one blocking item and
  // every blocking item is an ack-only-post-disposition resolved thread (no
  // missing regular comments, no non-ack thread). Lets autopilot deterministically
  // override a `return-to-e1` whose sole cause is post-disposition advisory-bot
  // acks. Never changes `route`; never relaxes the backstop for any other cause.
  soleCauseAckOnlyPostDisposition: boolean;
  missingRegularComments: {
    id: string;
    authorLogin: string;
    createdAt: string;
    bodyPreview: string;
  }[];
  // `ackOnlyPostDisposition` is advisory-only: true when this blocking resolved
  // thread blocks solely because of post-disposition advisory-bot ack-only
  // activity newer than the snapshot boundary. It never changes the entry's
  // `reason` or the summary `route`.
  missingThreads: {
    id: string;
    isResolved: boolean;
    reason: string;
    ackOnlyPostDisposition: boolean;
  }[];
}

/** Advisory-wait marker counts split by marker-author trust. */
export interface AdvisoryWaitMarkerSummary {
  sameHeadMarkerPresent: boolean;
  earliestSameHeadAt: string;
  sameHeadMarkerCount: number;
  requestMarkerCount: number;
  trustedSameHeadMarkerCount: number;
  untrustedSameHeadMarkerCount: number;
  trustedRequestMarkerCount: number;
  untrustedRequestMarkerCount: number;
}

/** Claim-validation outcome for the merge gate. */
export interface ClaimValidationSummary {
  expectedClaimId: string;
  expectedAgentId: string;
  activeClaimPresent: boolean;
  activeClaim: {
    agentId: string;
    claimId: string;
    supersedes: string;
    branch: string;
    createdAt: string;
  };
  matchesExpectedClaim: boolean;
  claimLost: boolean;
  reason: string;
}

/** Claim-stream resolution callbacks and policies. */
interface ClaimResolutionOptions {
  isTrustedAuthor?: (login: string) => boolean;
  isForcedHandoffEnabled?: (
    forcedHandoff: ParsedForcedHandoffMarker,
    event: CommentLike,
  ) => boolean;
  isAuthorizedForcedHandoff?: (
    forcedBy: string,
    forcedHandoff: ParsedForcedHandoffMarker,
    event: CommentLike,
  ) => boolean;
  isStale?: (activeCreatedAt: string, nextCreatedAt: string) => boolean;
  requireAuthorMatchesForcedBy?: boolean;
  onAnomalousHeartbeat?: (info: {
    agentId: string;
    claimId: string;
    activeBranch: string;
    heartbeatBranch: string;
    createdAt: string | null | undefined;
  }) => void;
  onIgnoredForcedHandoff?: (info: {
    reason: string;
    forcedHandoff: ParsedForcedHandoffMarker;
    event: CommentLike;
  }) => void;
}

/** Fully-defaulted form of {@link ClaimResolutionOptions}. */
type NormalizedClaimResolutionOptions = Required<ClaimResolutionOptions>;

const ISO8601_UTC_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;
const OPTIONAL_IDD_VISIBLE_NOTE_PATTERN = String.raw`(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)`;

export const LIVE_STATUS_DIGEST_MARKER = '<!-- idd-live-status: current -->';

const OPERATIONAL_MARKERS: OperationalMarker[] = [
  {
    label: '<!-- claimed-by:',
    pattern:
      /^<!--\s*claimed-by:\s+\S+\s+\S+\s+supersedes:\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+branch:\s+[^\s>]+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
  },
  {
    label: '<!-- unclaimed-by:',
    pattern:
      /^<!--\s*unclaimed-by:\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
  },
  {
    label: '<!-- review-watermark:',
    pattern:
      /^<!--\s*review-watermark:\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+\S+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
  },
  {
    label: '<!-- review-baseline:',
    pattern:
      /^<!--\s*review-baseline:\s+\S+\s+\S+\s+\S+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
  },
  {
    label: 'advisory-wait:',
    pattern:
      /^advisory-wait:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/,
  },
  {
    label: 'advisory-wait-recovery:',
    pattern:
      /^advisory-wait-recovery:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/,
  },
  {
    label: '<!-- advisory-wait:',
    pattern: /^<!--\s*advisory-wait:\s+\S+\s+[0-9a-f]{40}\s+\S+\s*-->\s*$/,
  },
  {
    label: '<!-- forced-handoff:',
    pattern: /^\s*<!--\s*forced-handoff:\s*\{[\s\S]*\}\s*-->[\s\S]*$/i,
    startPattern: /^<!--\s*forced-handoff:/i,
  },
  {
    label: '<!-- idd-external-check-waiver:',
    pattern:
      /^<!--\s*idd-external-check-waiver:\s+\S+\s+\S+\s+[0-9a-f]{40}\s+check:\S+\s+reason:\S+\s+expires:\S+\s*-->[\s\S]*$/i,
    startPattern: /^<!--\s*idd-external-check-waiver:/i,
  },
];

const IDD_AGENT_DERIVED_MARKERS = new Set([
  '<!-- claimed-by:',
  '<!-- unclaimed-by:',
  '<!-- review-watermark:',
  '<!-- review-baseline:',
  'advisory-wait:',
  'advisory-wait-recovery:',
  '<!-- advisory-wait:',
]);

const REVIEW_BOT_LOGINS = new Set([
  'coderabbitai',
  'coderabbitai[bot]',
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
]);

const UNSAFE_TEXT_RULES = [
  {
    pattern: /\*\*Awaiting maintainer decision\*\*/i,
    reason: 'contains an awaiting-maintainer-decision marker',
  },
  {
    pattern: /\bactive hold\b/i,
    reason: 'contains active hold context',
  },
  {
    pattern:
      /\bfailed[- ]ci\b|\bfailing ci\b|\bci failure\b|\bci failed\b|\bfailed checks?\b/i,
    reason: 'contains failed-CI context',
  },
];
const AMD_MARKER_PATTERN = /^\*\*Awaiting maintainer decision\*\*/i;
const FORCED_HANDOFF_CONTEXT_SCOPES = new Set(['issue-only', 'issue-plus-pr']);
const FORCED_HANDOFF_LINKED_PR_PATTERN = /^(?:[1-9]\d*|https?:\/\/[^\s<>"]+)$/;

export function parsePaginatedGhNdjson(raw: unknown): unknown[] {
  const text = String(raw ?? '').trim();
  if (!text) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const value: unknown = JSON.parse(line);
      return Array.isArray(value) ? value : [value];
    });
}

export function parseClaimComment(
  body: string,
  createdAt: string,
): ParsedClaimMarker | null {
  const match = body
    .trimEnd()
    .match(
      new RegExp(
        `^<!--\\s*claimed-by:\\s+(\\S+)\\s+(\\S+)\\s+supersedes:\\s+(\\S+)\\s+(${ISO8601_UTC_PATTERN.source})\\s+branch:\\s+([^\\s>]+)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
        'i',
      ),
    );
  if (!match || !isValidIsoTimestamp(match[4])) {
    return null;
  }
  return {
    agentId: match[1],
    claimId: match[2],
    supersedes: match[3],
    branch: match[5],
    createdAt,
  };
}

export function parseReleaseComment(body: string): ParsedReleaseMarker | null {
  const match = body
    .trimEnd()
    .match(
      new RegExp(
        `^<!--\\s*unclaimed-by:\\s+(\\S+)\\s+(\\S+)\\s+(${ISO8601_UTC_PATTERN.source})\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
        'i',
      ),
    );
  if (!match || !isValidIsoTimestamp(match[3])) {
    return null;
  }
  return {
    agentId: match[1],
    claimId: match[2],
  };
}

export function parseForcedHandoffComment(
  body: string,
  createdAt: string,
): ParsedForcedHandoffMarker | null {
  const trimmed = body.trimStart().trimEnd();
  const markerMatch = trimmed.match(/^<!--\s*forced-handoff:\s*/i);
  if (!markerMatch) {
    return null;
  }

  const markerEnd = trimmed.indexOf('-->');
  if (markerEnd < 0) {
    return null;
  }

  const visibleNote = trimmed.slice(markerEnd + 3);
  const visibleText = visibleNote
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!--[\s\S]*$/g, ' ')
    .trim();
  if (!visibleText) {
    return null;
  }

  const payloadText = trimmed.slice(markerMatch[0].length, markerEnd).trim();
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }

  return normalizeForcedHandoffPayload(payload, { createdAt });
}

export function normalizeForcedHandoffPayload(
  payload: unknown,
  options: { createdAt?: unknown } = {},
): ParsedForcedHandoffMarker | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;

  if (
    hasConflictingPayloadAliases(record, 'oldAgentId', 'old-agent-id') ||
    hasConflictingPayloadAliases(record, 'oldClaimId', 'old-claim-id') ||
    hasConflictingPayloadAliases(record, 'newAgentId', 'new-agent-id') ||
    hasConflictingPayloadAliases(record, 'newClaimId', 'new-claim-id') ||
    hasConflictingPayloadAliases(record, 'forcedBy', 'forced-by') ||
    hasConflictingPayloadAliases(record, 'linkedPr', 'linked-pr') ||
    hasConflictingPayloadAliases(record, 'contextScope', 'context-scope')
  ) {
    return null;
  }

  const oldAgentId = normalizeNonWhitespaceToken(
    pickPayloadValue(record, 'oldAgentId', 'old-agent-id'),
  );
  const oldClaimId = normalizeNonWhitespaceToken(
    pickPayloadValue(record, 'oldClaimId', 'old-claim-id'),
  );
  const newAgentId = normalizeNonWhitespaceToken(
    pickPayloadValue(record, 'newAgentId', 'new-agent-id'),
  );
  const newClaimId = normalizeNonWhitespaceToken(
    pickPayloadValue(record, 'newClaimId', 'new-claim-id'),
  );
  const branch = normalizeBranchToken(pickPayloadValue(record, 'branch'));
  const forcedBy = normalizeNonWhitespaceToken(
    pickPayloadValue(record, 'forcedBy', 'forced-by'),
  );
  const reason = normalizeForcedHandoffReason(
    pickPayloadValue(record, 'reason'),
  );
  const timestamp = normalizeSecondPrecisionIsoTimestamp(
    pickPayloadValue(record, 'timestamp'),
  );
  const contextScope = normalizeContextScope(
    pickPayloadValue(record, 'contextScope', 'context-scope'),
  );
  const linkedPr = normalizeLinkedPr(
    pickPayloadValue(record, 'linkedPr', 'linked-pr'),
  );
  const createdAt = normalizeSecondPrecisionIsoTimestamp(options.createdAt);

  if (
    !oldAgentId ||
    !oldClaimId ||
    !newAgentId ||
    !newClaimId ||
    !branch ||
    !forcedBy ||
    !reason ||
    !timestamp ||
    !contextScope
  ) {
    return null;
  }

  if (oldClaimId === newClaimId) {
    return null;
  }

  if (contextScope === 'issue-plus-pr' && !linkedPr) {
    return null;
  }

  if (contextScope === 'issue-only' && linkedPr) {
    return null;
  }

  return {
    oldAgentId,
    oldClaimId,
    newAgentId,
    newClaimId,
    branch,
    ...(linkedPr ? { linkedPr } : {}),
    forcedBy,
    reason,
    timestamp,
    contextScope,
    ...(createdAt ? { createdAt } : {}),
  };
}

export function renderForcedHandoffConsentNote(payload: unknown): string {
  const normalized = normalizeForcedHandoffPayload(payload);
  if (!normalized) {
    throw new Error('invalid forced handoff payload');
  }

  if (normalized.contextScope === 'issue-plus-pr') {
    const linkedPr = normalized.linkedPr ?? '';
    const prReference = /^\d+$/.test(linkedPr) ? `#${linkedPr}` : linkedPr;
    return [
      `Forced handoff approved by ${normalized.forcedBy}. I verified that the current`,
      'owning session or agent is unavailable. This transfers ownership away',
      `from claim \`${normalized.oldClaimId}\` on branch \`${normalized.branch}\` for PR ${prReference}.`,
      'If the prior session resumes, it must stop immediately and must not',
      'push, comment, resolve review state, or merge until a maintainer',
      'reassigns ownership.',
    ].join('\n');
  }

  return [
    `Forced handoff approved by ${normalized.forcedBy}. I verified that the current`,
    'owning session or agent is unavailable. This transfers ownership away',
    `from claim \`${normalized.oldClaimId}\` on branch \`${normalized.branch}\`.`,
    'If the prior session resumes, it must stop immediately and must not',
    'push, comment, resolve review state, or merge until a maintainer',
    'reassigns ownership.',
  ].join('\n');
}

export function renderForcedHandoffComment(payload: unknown): string {
  const normalized = normalizeForcedHandoffPayload(payload);
  if (!normalized) {
    throw new Error('invalid forced handoff payload');
  }

  const markerPayload = {
    'old-agent-id': normalized.oldAgentId,
    'old-claim-id': normalized.oldClaimId,
    'new-agent-id': normalized.newAgentId,
    'new-claim-id': normalized.newClaimId,
    branch: normalized.branch,
    ...(normalized.linkedPr ? { 'linked-pr': normalized.linkedPr } : {}),
    'forced-by': normalized.forcedBy,
    reason: normalized.reason,
    timestamp: normalized.timestamp,
    'context-scope': normalized.contextScope,
  };

  return `<!-- forced-handoff: ${JSON.stringify(markerPayload)} -->\n\n${renderForcedHandoffConsentNote(normalized)}`;
}

function normalizeExternalCheckWaiverField(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    /[\r\n]/.test(trimmed) ||
    trimmed.includes('<!--') ||
    trimmed.includes('-->')
  ) {
    return '';
  }
  return trimmed;
}

function encodeExternalCheckWaiverField(value: string): string {
  return encodeURIComponent(value);
}

function decodeExternalCheckWaiverField(value: unknown): string {
  try {
    return decodeURIComponent(String(value ?? '').trim());
  } catch {
    return '';
  }
}

function renderExternalCheckWaiverNote(normalized: {
  actor?: unknown;
  checkSelector: string;
  reason: string;
  expiresAt: string;
}): string {
  const actor = normalizeNonWhitespaceToken(normalized.actor) || 'idd-operator';
  return [
    `_${actor}: external check waiver for IDD F phase on \`${normalized.checkSelector}\``,
    `until \`${normalized.expiresAt}\` (reason: ${normalized.reason})._`,
  ].join(' ');
}

export function renderExternalCheckWaiverComment(
  payload:
    | {
        agentId?: unknown;
        claimId?: unknown;
        headSha?: unknown;
        checkSelector?: unknown;
        check?: unknown;
        reason?: unknown;
        expiresAt?: unknown;
        expires?: unknown;
        actor?: unknown;
      }
    | null
    | undefined,
): string {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const checkSelector = normalizeExternalCheckWaiverField(
    payload?.checkSelector ?? payload?.check,
  );
  const reason = normalizeExternalCheckWaiverField(payload?.reason);
  const expiresAt = normalizeIsoTimestamp(
    payload?.expiresAt ?? payload?.expires,
  );

  if (
    !agentId ||
    !claimId ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    !checkSelector ||
    !reason ||
    !expiresAt
  ) {
    throw new Error('invalid external check waiver payload');
  }

  const encodedCheck = encodeExternalCheckWaiverField(checkSelector);
  const encodedReason = encodeExternalCheckWaiverField(reason);

  return [
    `<!-- idd-external-check-waiver: ${agentId} ${claimId} ${headSha} check:${encodedCheck} reason:${encodedReason} expires:${expiresAt} -->`,
    '',
    renderExternalCheckWaiverNote({
      actor: payload?.actor,
      checkSelector,
      reason,
      expiresAt,
    }),
  ].join('\n');
}

// --- Per-cycle marker body renderers (#900) ---
//
// Pure, network-free renderers for the three operational markers an agent
// posts every cycle. Each returns the exact ready-to-post body (HTML marker
// token + visible "Do not edit" note); the agent still posts it via the
// documented HTTP path, so the read-only-by-default / instructions-only
// fallback is unaffected. The written formats in idd-overview-core (claim)
// and idd-review-snapshot (watermark/baseline) remain canonical.

function normalizeMarkerCount(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  const trimmed = String(value ?? '').trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  // The watermark parser reads the count back with Number.parseInt; reject
  // magnitudes beyond the safe-integer range, which would not round-trip to
  // the same value (and as a JS number would stringify to exponential form
  // that the parser's `\d+` count pattern rejects outright).
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? trimmed : null;
}

// `none` or a valid ISO timestamp (matching the watermark parser's
// none-or-ISO contract); null signals an invalid value the caller rejects.
function normalizeMarkerIsoOrNone(value: unknown): string | null {
  const token = normalizeNonWhitespaceToken(value);
  if (token === '' || token === 'none') {
    return 'none';
  }
  return normalizeIsoTimestamp(token) || null;
}

export function renderClaimedByMarker(payload: {
  agentId?: unknown;
  claimId?: unknown;
  supersedes?: unknown;
  timestamp?: unknown;
  branch?: unknown;
}): string {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const supersedesToken = normalizeNonWhitespaceToken(payload?.supersedes);
  // Normalize any case-variant of the sentinel to lowercase `none`. The claim
  // parser matches case-insensitively, but the claim lifecycle
  // (`applyClaimEvent`) accepts a fresh claim only when `supersedes === 'none'`
  // exactly, so an emitted `None`/`NONE` would round-trip into a claim that is
  // silently ignored. Real claim IDs (never a case-variant of `none`) pass
  // through verbatim.
  const supersedes =
    supersedesToken === '' || supersedesToken.toLowerCase() === 'none'
      ? 'none'
      : supersedesToken;
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  const branch = normalizeBranchToken(payload?.branch);
  if (!agentId || !claimId || !timestamp || !branch) {
    throw new Error('invalid claimed-by marker payload');
  }
  return [
    `<!-- claimed-by: ${agentId} ${claimId} supersedes: ${supersedes} ${timestamp} branch: ${branch} -->`,
    '',
    `_${agentId}: issue claim — IDD automation marker. Do not edit._`,
  ].join('\n');
}

export function renderReviewWatermarkMarker(payload: {
  agentId?: unknown;
  claimId?: unknown;
  headSha?: unknown;
  maxActivityAt?: unknown;
  totalItemCount?: unknown;
  ciCompletedAt?: unknown;
}): string {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const maxActivityAt = normalizeMarkerIsoOrNone(payload?.maxActivityAt);
  const totalItemCount = normalizeMarkerCount(payload?.totalItemCount);
  const ciCompletedAt = normalizeMarkerIsoOrNone(payload?.ciCompletedAt);
  if (
    !agentId ||
    !claimId ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    maxActivityAt === null ||
    totalItemCount === null ||
    ciCompletedAt === null
  ) {
    throw new Error('invalid review-watermark marker payload');
  }
  return [
    `<!-- review-watermark: ${agentId} ${claimId} ${headSha} ${maxActivityAt} ${totalItemCount} ${ciCompletedAt} -->`,
    '',
    `_${agentId}: review triage snapshot — IDD automation marker. Do not edit._`,
  ].join('\n');
}

export function renderReviewBaselineMarker(payload: {
  agentId?: unknown;
  claimId?: unknown;
  sha?: unknown;
}): string {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const sha = normalizeNonWhitespaceToken(payload?.sha).toLowerCase();
  if (!agentId || !claimId || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('invalid review-baseline marker payload');
  }
  return [
    `<!-- review-baseline: ${agentId} ${claimId} ${sha} -->`,
    '',
    `_${agentId}: critique baseline — IDD automation marker. Do not edit._`,
  ].join('\n');
}

// --- Write-side companion renderers (#1047) ---
//
// The post-idd-marker helper POSTs the same operational markers an agent emits
// per cycle, so it needs a renderer for every type it can post. claim /
// watermark / baseline already have renderers above; these three cover the
// remaining post-idd-marker types so the body formats stay single-sourced.

export function renderUnclaimedByMarker(payload: {
  agentId?: unknown;
  claimId?: unknown;
  timestamp?: unknown;
}): string {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  if (!agentId || !claimId || !timestamp) {
    throw new Error('invalid unclaimed-by marker payload');
  }
  return [
    `<!-- unclaimed-by: ${agentId} ${claimId} ${timestamp} -->`,
    '',
    `_${agentId}: issue claim released — IDD automation marker. Do not edit._`,
  ].join('\n');
}

// advisory-wait / advisory-wait-recovery are PLAIN-TEXT markers (no visible
// note): the AW2 / shell-fallback recognizers anchor on `-->$` / `\s*$`, so a
// trailing visible note would break them. They carry the PR HEAD SHA (not a
// claim id) per the AW3 protocol.
export function renderAdvisoryWaitMarker(payload: {
  agentId?: unknown;
  headSha?: unknown;
  timestamp?: unknown;
}): string {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  if (!agentId || !/^[0-9a-f]{40}$/.test(headSha) || !timestamp) {
    throw new Error('invalid advisory-wait marker payload');
  }
  return `advisory-wait: ${agentId} ${headSha} ${timestamp}`;
}

export function renderAdvisoryWaitRecoveryMarker(payload: {
  agentId?: unknown;
  headSha?: unknown;
  timestamp?: unknown;
}): string {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  if (!agentId || !/^[0-9a-f]{40}$/.test(headSha) || !timestamp) {
    throw new Error('invalid advisory-wait-recovery marker payload');
  }
  return `advisory-wait-recovery: ${agentId} ${headSha} ${timestamp}`;
}

function matchCheckSelectorLocal(
  name: unknown,
  selector: unknown,
  matchMode?: 'exact' | 'glob',
): boolean {
  const n = String(name ?? '').trim();
  const s = String(selector ?? '').trim();
  if (!n || !s) return false;
  // An explicit matchMode wins; otherwise infer glob from a `*` in the
  // selector (the legacy behavior every existing two-argument caller relies
  // on, e.g. waiver-selector vs check-name coverage matching).
  const useGlob =
    matchMode === undefined ? s.includes('*') : matchMode === 'glob';
  if (useGlob) {
    const source = s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${source}$`).test(n);
  }
  return n === s;
}

/**
 * True when a concrete check `name` matches any configured waivable selector,
 * honoring each selector's own `matchMode`. Used to gate whether a present
 * check sits on the policy's waivable surface.
 */
function isCheckNameConfiguredWaivable(
  name: unknown,
  waivableSelectors: { selector?: unknown; matchMode?: unknown }[],
): boolean {
  return waivableSelectors.some((sel) =>
    matchCheckSelectorLocal(
      name,
      sel?.selector,
      sel?.matchMode === 'glob' ? 'glob' : 'exact',
    ),
  );
}

/**
 * True when a waiver's `checkSelector` can name a check that the policy
 * declared waivable. Unlike a concrete check name, a waiver selector may
 * itself be a glob, so this tests both directions: the waiver selector
 * against each configured pattern, and each configured selector against the
 * waiver pattern (glob inferred from `*`). Either direction means the two
 * selectors can resolve to a common check — e.g. a glob waiver `Code*`
 * overlaps an exact waivable `CodeRabbit`. This mirrors the creation-path
 * gate in `planExternalCheckWaiver`, which validates glob waivers against the
 * actual matched checks, so a legitimately created waiver is not wrongly
 * bucketed as `notConfigured` at consumption.
 */
function waiverSelectorOverlapsConfiguredWaivable(
  waiverSelector: unknown,
  waivableSelectors: { selector?: unknown; matchMode?: unknown }[],
): boolean {
  return waivableSelectors.some(
    (sel) =>
      matchCheckSelectorLocal(
        waiverSelector,
        sel?.selector,
        sel?.matchMode === 'glob' ? 'glob' : 'exact',
      ) || matchCheckSelectorLocal(sel?.selector, waiverSelector),
  );
}

export function summarizeExternalCheckWaivers(
  comments: CommentLike[] | null | undefined,
  {
    prHeadSha = '',
    activeClaimId = '',
    trustedMarkerLogins = [],
    now = '',
    waivableSelectors = null,
    maxValidity = '',
  }: {
    prHeadSha?: string;
    activeClaimId?: unknown;
    trustedMarkerLogins?: unknown[];
    now?: string;
    waivableSelectors?: { selector?: unknown; matchMode?: unknown }[] | null;
    // Configured `ciGate.externalCheckWaivers.maxValidity` (ISO-8601 duration).
    // An empty/unparseable value leaves the consume-side window check off, so
    // direct callers that omit it keep the legacy behavior; the F2/F3 gate
    // always threads the policy value (default `PT24H`).
    maxValidity?: string;
  } = {},
): ExternalCheckWaiverEvidence {
  const trustedSet = new Set(normalizeTrustedMarkerLogins(trustedMarkerLogins));
  const nowMs = isValidIsoTimestamp(now) ? new Date(now).getTime() : Date.now();
  const headShaLower = String(prHeadSha).toLowerCase();
  const activeClaimLower = String(activeClaimId);
  const maxValidityMs = parseIsoDurationToMs(maxValidity);

  const valid: ExternalCheckWaiverEvidence['valid'] = [];
  const expired: ExternalCheckWaiverEvidence['expired'] = [];
  const wrongHead: ExternalCheckWaiverEvidence['wrongHead'] = [];
  const wrongClaim: ExternalCheckWaiverEvidence['wrongClaim'] = [];
  const unauthorized: ExternalCheckWaiverEvidence['unauthorized'] = [];
  const malformed: ExternalCheckWaiverEvidence['malformed'] = [];
  const notConfigured: ExternalCheckWaiverEvidence['notConfigured'] = [];

  for (const comment of comments ?? []) {
    const body = String(comment?.body ?? '');
    // Prefilter on a marker-start, case-insensitive match aligned with
    // parseExternalCheckWaiverComment's anchor — a case-sensitive substring
    // skipped odd-cased markers and misclassified prose mentions as malformed.
    if (!/^<!--\s*idd-external-check-waiver:/i.test(body)) continue;

    const authorLogin = String(
      comment?.author?.login ?? comment?.user?.login ?? '',
    )
      .trim()
      .toLowerCase();
    const createdAt = String(comment?.created_at ?? comment?.createdAt ?? '');
    const parsed = parseExternalCheckWaiverComment(body, createdAt);

    if (!parsed) {
      malformed.push({ authorLogin, bodyPreview: body.slice(0, 120) });
      continue;
    }

    if (!trustedSet.has(authorLogin)) {
      unauthorized.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }

    // Fail closed on an empty head SHA: an unbound waiver must never ride
    // along when the gate cannot prove it targets the current PR HEAD.
    if (!headShaLower || parsed.headSha !== headShaLower) {
      wrongHead.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        waiverHeadSha: parsed.headSha,
      });
      continue;
    }

    // Fail closed on an empty active claim: when no claim resolves at the gate
    // (`activeClaimLower === ''`), a waiver cannot be bound to an owner and is
    // rejected rather than passing unbound.
    if (!activeClaimLower || parsed.claimId !== activeClaimLower) {
      wrongClaim.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        waiverClaimId: parsed.claimId,
      });
      continue;
    }

    const expiresMs = new Date(parsed.expiresAt).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      expired.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }

    // Re-enforce the configured maxValidity window at consume time. Authoring
    // already clamps `expiresAt - createdAt` (planExternalCheckWaiver's
    // withinMaxValidity), but a hand-edited or policy-drifted marker can still
    // carry an over-long window, so the shared merge gate re-checks it and
    // fails closed when the creation timestamp is unknown (`createdAt: 'none'`).
    if (typeof maxValidityMs === 'number' && Number.isFinite(maxValidityMs)) {
      const createdMs = new Date(parsed.createdAt).getTime();
      if (
        !Number.isFinite(createdMs) ||
        expiresMs - createdMs > maxValidityMs
      ) {
        expired.push({
          authorLogin,
          checkSelector: parsed.checkSelector,
          expiresAt: parsed.expiresAt,
        });
        continue;
      }
    }

    // When the policy declares its waivable surface, a valid waiver still only
    // counts when its selector can name a configured-waivable check; otherwise
    // it is reported but never folds a check in. The overlap test treats the
    // waiver selector as a possible glob so a `Code*` waiver still matches an
    // exact `CodeRabbit` surface. A null/undefined list disables the gate
    // (legacy callers), an empty list waives nothing.
    if (
      Array.isArray(waivableSelectors) &&
      !waiverSelectorOverlapsConfiguredWaivable(
        parsed.checkSelector,
        waivableSelectors,
      )
    ) {
      notConfigured.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }

    valid.push({
      authorLogin,
      checkSelector: parsed.checkSelector,
      reason: parsed.reason,
      expiresAt: parsed.expiresAt,
    });
  }

  return {
    valid,
    expired,
    wrongHead,
    wrongClaim,
    unauthorized,
    malformed,
    notConfigured,
  };
}

export function parseExternalCheckWaiverComment(
  body: string,
  createdAt: string,
): ParsedExternalCheckWaiver | null {
  const match = body
    .trimEnd()
    .match(
      new RegExp(
        `^<!--\\s*idd-external-check-waiver:\\s+(\\S+)\\s+(\\S+)\\s+([0-9a-f]{40})\\s+check:(\\S+)\\s+reason:(\\S+)\\s+expires:(\\S+)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
        'i',
      ),
    );
  if (!match) {
    return null;
  }

  const checkSelector = normalizeExternalCheckWaiverField(
    decodeExternalCheckWaiverField(match[4]),
  );
  const reason = normalizeExternalCheckWaiverField(
    decodeExternalCheckWaiverField(match[5]),
  );
  const expiresAt = normalizeIsoTimestamp(match[6]);
  if (!checkSelector || !reason || !expiresAt) {
    return null;
  }

  return {
    agentId: match[1],
    claimId: match[2],
    headSha: match[3].toLowerCase(),
    checkSelector,
    reason,
    expiresAt,
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : 'none',
  };
}

export function parseReviewWatermarkComment(
  body: string,
  createdAt: string,
): ParsedReviewWatermark | null {
  const match = body
    .trimEnd()
    .match(
      new RegExp(
        `^<!--\\s*review-watermark:\\s+(\\S+)\\s+(\\S+)\\s+([0-9a-f]{40})\\s+(\\S+)\\s+(\\d+)\\s+(\\S+)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
        'i',
      ),
    );
  if (!match) {
    return null;
  }

  const maxActivityUpdatedAt = match[4];
  const latestCiCompletedAt = match[6];
  if (
    maxActivityUpdatedAt !== 'none' &&
    !isValidIsoTimestamp(maxActivityUpdatedAt)
  ) {
    return null;
  }
  if (
    latestCiCompletedAt !== 'none' &&
    !isValidIsoTimestamp(latestCiCompletedAt)
  ) {
    return null;
  }

  const totalItemCount = Number.parseInt(match[5], 10);
  if (!Number.isInteger(totalItemCount) || totalItemCount < 0) {
    return null;
  }

  return {
    agentId: match[1],
    claimId: match[2],
    headSha: match[3],
    maxActivityUpdatedAt,
    totalItemCount,
    latestCiCompletedAt,
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : 'none',
  };
}

export function operationalMarkerPrefix(body: string): string | null {
  const normalized = body.trimEnd();
  const marker = OPERATIONAL_MARKERS.find((candidate) =>
    candidate.pattern.test(normalized),
  );
  if (!marker) {
    return null;
  }
  if (
    marker.label === '<!-- forced-handoff:' &&
    !isValidForcedHandoffOperationalMarker(normalized)
  ) {
    return null;
  }
  return marker.label;
}

export function operationalMarkerPrefixByStart(body: string): string | null {
  const normalized = body.trimStart();
  const marker = OPERATIONAL_MARKERS.find(
    (candidate) =>
      candidate.startPattern?.test(normalized) ??
      normalized.startsWith(candidate.label),
  );
  if (!marker) {
    return null;
  }
  if (
    marker.label === '<!-- forced-handoff:' &&
    !isValidForcedHandoffOperationalMarker(normalized)
  ) {
    return null;
  }
  return marker.label;
}

export function findLiveStatusDigestComments(
  comments: CommentLike[],
): CommentLike[] {
  return comments.filter((comment) => {
    return firstLine(comment.body ?? '') === LIVE_STATUS_DIGEST_MARKER;
  });
}

export function renderLiveStatusDigest(fields: LiveStatusDigestFields): string {
  const normalized = normalizeLiveStatusDigestFields(fields);
  return `${LIVE_STATUS_DIGEST_MARKER}

| Field | Value |
| --- | --- |
| Phase | ${escapeMarkdownTableCell(normalized.phase)} |
| Claim | ${escapeMarkdownTableCell(normalized.claim)} |
| Branch | ${escapeMarkdownTableCell(normalized.branch)} |
| Last checked | ${escapeMarkdownTableCell(normalized.lastChecked)} |
| Open blockers | ${escapeMarkdownTableCell(normalized.openBlockers)} |
| Next action | ${escapeMarkdownTableCell(normalized.nextAction)} |
| Authoritative by | ${escapeMarkdownTableCell(normalized.authoritativeBy)} |
`;
}

export function planLiveStatusDigestUpsert(
  comments: CommentLike[],
  fields: LiveStatusDigestFields,
) {
  const matches = findLiveStatusDigestComments(comments);
  const nextBody = renderLiveStatusDigest(fields);

  if (matches.length > 1) {
    return {
      action: 'duplicate',
      canApply: false,
      body: null,
      duplicates: matches.map((comment) => ({
        id: comment.id ?? null,
        url: comment.html_url ?? comment.url ?? null,
        createdAt: comment.created_at ?? comment.createdAt ?? null,
        updatedAt: comment.updated_at ?? comment.updatedAt ?? null,
      })),
      repairPath: [
        'Multiple current live status digest comments were found.',
        'Do not delete or minimize any audit history during unattended execution.',
        'Use trusted markers and GitHub state for workflow decisions until a maintainer selects one current digest and converts stale duplicate markers to non-current digest text.',
      ].join(' '),
    };
  }

  if (matches.length === 0) {
    return {
      action: 'create',
      canApply: true,
      body: nextBody,
      duplicates: [],
    };
  }

  const [current] = matches;
  if (sameDigestBody(current.body ?? '', nextBody)) {
    return {
      action: 'noop',
      canApply: true,
      body: nextBody,
      commentId: current.id ?? null,
      url: current.html_url ?? current.url ?? null,
      duplicates: [],
    };
  }

  return {
    action: 'update',
    canApply: true,
    body: nextBody,
    commentId: current.id ?? null,
    url: current.html_url ?? current.url ?? null,
    duplicates: [],
  };
}

/** Minimal upsert-plan shape consumed by {@link applyDigestUpsert}. */
export interface DigestUpsertPlanLike {
  action: string;
  body: string | null;
  commentId?: string | number | null;
  url?: string | null;
}

/** Result of a comment create/update GitHub mutation. */
export interface DigestCommentMutationResult {
  id?: string | number | null;
  html_url?: string | null;
  url?: string | null;
}

/** Injected side effects for {@link applyDigestUpsert}. */
export interface DigestUpsertIo<P extends DigestUpsertPlanLike> {
  skipClaimCheck: boolean;
  refetchAndPlan: () => P;
  assertClaim: () => void;
  createComment: (body: string | null) => DigestCommentMutationResult;
  updateComment: (
    commentId: string | number,
    body: string | null,
  ) => DigestCommentMutationResult;
}

/** Outcome of {@link applyDigestUpsert}. */
export interface DigestUpsertOutcome<P extends DigestUpsertPlanLike> {
  planned: P;
  outcome: 'duplicate' | 'created' | 'updated' | 'noop';
  commentId?: string | number | null;
  url?: string | null;
}

/**
 * Orchestrate the apply-time live-status-digest upsert: re-fetch and
 * re-plan against the latest comments, then revalidate the active claim
 * immediately before the create/update mutation, so a claim release or
 * takeover that lands during the replan's network fetch is caught before
 * the write. The side-effecting I/O is injected so the ordering invariant
 * — replan, then claim check, then mutation, and no write when the claim
 * check throws — is unit-testable apart from the live `gh` calls.
 */
export function applyDigestUpsert<P extends DigestUpsertPlanLike>(
  io: DigestUpsertIo<P>,
): DigestUpsertOutcome<P> {
  const planned = io.refetchAndPlan();
  if (planned.action === 'duplicate') {
    return { planned, outcome: 'duplicate' };
  }
  if (!io.skipClaimCheck) {
    io.assertClaim();
  }
  if (planned.action === 'create') {
    const created = io.createComment(planned.body);
    return {
      planned,
      outcome: 'created',
      commentId: created.id ?? null,
      url: created.html_url ?? created.url ?? null,
    };
  }
  if (planned.action === 'update') {
    if (planned.commentId === undefined || planned.commentId === null) {
      throw new Error(
        'cannot update digest because the current comment id is missing',
      );
    }
    const updated = io.updateComment(planned.commentId, planned.body);
    return {
      planned,
      outcome: 'updated',
      commentId: updated.id ?? planned.commentId,
      url: updated.html_url ?? updated.url ?? planned.url ?? null,
    };
  }
  return { planned, outcome: 'noop' };
}

export function unsafeTextReason(body: string): string | null {
  for (const rule of UNSAFE_TEXT_RULES) {
    if (rule.pattern.test(body)) {
      return rule.reason;
    }
  }
  return null;
}

export function isKnownReviewBot(login: string): boolean {
  const normalized = login.toLowerCase();
  return (
    REVIEW_BOT_LOGINS.has(normalized) ||
    normalized.startsWith('copilot-pull-request-reviewer')
  );
}

export function isCodeRabbitLogin(login: string): boolean {
  const normalized = login.toLowerCase();
  return normalized === 'coderabbitai' || normalized === 'coderabbitai[bot]';
}

// The exact CodeRabbit summary-walkthrough marker. CodeRabbit prefixes its
// auto-generated review summary with this HTML comment (distinct from the
// `rate limited by coderabbit.ai` notice marker). Single-sourced here so the
// comment-minimization classifier (`classifyRegularBotComment`) and the
// disposition-evidence summary predicate (`isReviewSummaryComment`) recognize
// byte-for-byte the same marker and cannot drift.
export const CODERABBIT_SUMMARY_MARKER =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';

export function classifyRegularBotComment(
  comment: CommentLike,
  comments: CommentLike[],
  threads: ThreadLike[],
  options: { isDispositionAuthor?: (login: string) => boolean } = {},
): CommentClassification | null {
  const author = comment.author?.login ?? '';
  if (!isCodeRabbitLogin(author)) {
    return null;
  }

  if (hasUnresolvedKnownBotThreads(threads)) {
    return null;
  }

  const body = (comment.body ?? '').trimStart();

  if (body.startsWith(CODERABBIT_SUMMARY_MARKER)) {
    if (/No actionable comments were generated/i.test(body)) {
      return {
        classifier: 'RESOLVED',
        reason: 'CodeRabbit completed summary reported no actionable comments',
      };
    }
    if (
      hasExplicitDispositionAfter(comment, comments, {
        isDispositionAuthor: options.isDispositionAuthor,
      }) ||
      hasCompletedBotThreadDispositions(threads, isCodeRabbitLogin, {
        isDispositionAuthor: options.isDispositionAuthor,
      })
    ) {
      return {
        classifier: 'RESOLVED',
        reason:
          'CodeRabbit completed summary has matched IDD disposition evidence',
      };
    }
    return null;
  }

  if (
    body.startsWith('<!-- This is an auto-generated reply by CodeRabbit -->')
  ) {
    if (
      /\b(Review triggered|Sure! I'll review|I'll review)\b/i.test(body) &&
      hasExplicitDispositionAfter(comment, comments, {
        isDispositionAuthor: options.isDispositionAuthor,
      })
    ) {
      return {
        classifier: 'OUTDATED',
        reason:
          'stale CodeRabbit review-trigger acknowledgement after completed review',
      };
    }
  }

  return null;
}

export function indexLatestGatingReviewsByAuthor(reviews: ReviewLike[]) {
  const index = new Map<
    string,
    ReviewLike & { submittedAt: string; submitted_at: string }
  >();
  for (const review of reviews) {
    const state = String(review.state ?? '');
    if (state === 'COMMENTED' || state === 'PENDING') {
      continue;
    }
    const author = review.author?.login?.toLowerCase();
    if (!author) {
      continue;
    }
    const effectiveSubmittedAt = normalizeGatingReviewTimestamp(review, state);
    if (!effectiveSubmittedAt) {
      continue;
    }
    const current = index.get(author);
    const currentTime = current
      ? Date.parse(current.submittedAt ?? current.submitted_at ?? '')
      : Number.NEGATIVE_INFINITY;
    const reviewTime = Date.parse(effectiveSubmittedAt);
    if (!current || reviewTime >= currentTime) {
      index.set(author, {
        ...review,
        submittedAt: effectiveSubmittedAt,
        submitted_at: effectiveSubmittedAt,
      });
    }
  }
  return index;
}

export function indexThreadsByReview(
  threads: ThreadLike[],
  options: { isDispositionAuthor?: (login: string) => boolean } = {},
) {
  const index = new Map<
    string,
    {
      total: number;
      unresolved: number;
      missingDisposition: number;
      incomplete: boolean;
      threadIds: (string | null | undefined)[];
    }
  >();

  for (const thread of threads) {
    const reviewIds = new Set(
      (thread.comments?.nodes ?? [])
        .map((comment) => comment.pullRequestReview?.id)
        .filter(Boolean) as string[],
    );

    for (const reviewId of reviewIds) {
      const current = index.get(reviewId) ?? {
        total: 0,
        unresolved: 0,
        missingDisposition: 0,
        incomplete: false,
        threadIds: [],
      };
      current.total += 1;
      if (!thread.isResolved) {
        current.unresolved += 1;
      }
      if (
        !hasFreshDisposition(thread, {
          isDispositionAuthor: options.isDispositionAuthor,
        })
      ) {
        current.missingDisposition += 1;
      }
      if (thread.comments?.pageInfo?.hasNextPage) {
        current.incomplete = true;
      }
      current.threadIds.push(thread.id);
      index.set(reviewId, current);
    }
  }

  return index;
}

export function routeRejectedChangesRequestedReview(input: {
  policyConfig?: unknown;
  reviewState?: string | null;
  reviewerDisposition?: string | null;
  maintainerDisposition?: string | null;
  now?: string | null;
  rejectionCommentCreatedAt?: string | null;
  escalationCommentCreatedAt?: string | null;
}): RouteDecision {
  const escalationPolicy = getReviewEscalationChangesRequestedPolicy(
    input?.policyConfig ?? {},
  );
  const firstEscalationWindowMs = escalationPolicy.escalateAfterMs;
  const postEscalationWindowMs = escalationPolicy.releaseAfterEscalationMs;
  const totalWindowLabel = formatDurationLabel(
    firstEscalationWindowMs + postEscalationWindowMs,
  );
  const firstWindowLabel = formatDurationLabel(firstEscalationWindowMs);

  const reviewState = String(input.reviewState ?? '');
  if (reviewState !== 'CHANGES_REQUESTED') {
    return {
      route: 'proceed',
      reason: 'changes-requested state already cleared',
    };
  }

  const reviewerDisposition = String(input.reviewerDisposition ?? 'none');
  if (reviewerDisposition === 'disagreed') {
    return {
      route: 'return-to-e1',
      reason:
        'reviewer disagreed with the rejection and the feedback must return to triage',
    };
  }
  if (reviewerDisposition === 'agreed-state-cleared') {
    return {
      route: 'hold-await-state-clear',
      reason:
        'reviewer agreement alone does not clear a changes-requested state',
    };
  }
  if (reviewerDisposition === 'agreed-state-unchanged') {
    return {
      route: 'hold-await-state-clear',
      reason:
        'reviewer agreement alone does not clear a changes-requested state',
    };
  }

  const maintainerDisposition = String(input.maintainerDisposition ?? 'none');
  if (maintainerDisposition === 'agreed-state-unchanged') {
    return {
      route: 'hold-await-state-clear',
      reason:
        'maintainer agreement does not clear the original changes-requested state',
    };
  }

  const elapsedMs =
    Date.parse(input.now ?? '') -
    Date.parse(input.rejectionCommentCreatedAt ?? '');
  if (!Number.isFinite(elapsedMs)) {
    return {
      route: 'hold-for-evidence',
      reason:
        'elapsed time cannot be computed for the rejected changes-requested review',
    };
  }

  if (elapsedMs < firstEscalationWindowMs) {
    return {
      route: 'hold-before-escalation',
      reason: `still within the first ${firstWindowLabel} after the rejection reply`,
    };
  }

  const escalationElapsedMs =
    Date.parse(input.now ?? '') -
    Date.parse(input.escalationCommentCreatedAt ?? '');
  if (!Number.isFinite(escalationElapsedMs)) {
    return {
      route: 'escalate-maintainer',
      reason: `the changes-requested review is still blocking after ${firstWindowLabel} with no reviewer response`,
    };
  }
  if (escalationElapsedMs < postEscalationWindowMs) {
    return {
      route: 'hold-after-escalation',
      reason: `still within ${formatDurationLabel(postEscalationWindowMs)} of the maintainer escalation comment`,
    };
  }
  return {
    route: 'label-and-release',
    reason: `the changes-requested review is still blocking after ${totalWindowLabel} with no escalation response`,
  };
}

function formatDurationLabel(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '0 minutes';
  }
  if (milliseconds % (60 * 60 * 1000) === 0) {
    const hours = milliseconds / (60 * 60 * 1000);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (milliseconds % (60 * 1000) === 0) {
    const minutes = milliseconds / (60 * 1000);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = milliseconds / 1000;
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

export function diffReviewSnapshot(
  snapshot: {
    headSha?: string | null;
    maxActivityUpdatedAt?: string | null;
    totalItemCount?: number | string | null;
    latestPassingCiCompletedAt?: string | null;
    latestCiCompletedAt?: string | null;
  },
  live: {
    headSha?: string | null;
    maxActivityUpdatedAt?: string | null;
    totalItemCount?: number | string | null;
    latestPassingCiCompletedAt?: string | null;
    latestCiCompletedAt?: string | null;
    ackOnly?: {
      items?: { kind?: string | null; activityAt?: string | null }[] | null;
      dispositionsPresent?: boolean | null;
    } | null;
    effective?: {
      maxActivityUpdatedAt?: string | null;
      totalItemCount?: number | null;
    } | null;
  },
): RouteDecision {
  if (String(live.headSha ?? '') !== String(snapshot.headSha ?? '')) {
    return { route: 'return-to-e1', reason: 'head-changed' };
  }

  const snapshotMax = normalizeComparableTimestamp(
    snapshot.maxActivityUpdatedAt,
  );
  const liveMax = normalizeComparableTimestamp(live.maxActivityUpdatedAt);
  const snapshotCount = Number(snapshot.totalItemCount ?? 0);
  const liveCount = Number(live.totalItemCount ?? 0);
  // Structural ack-only carve-out (#858): when the only activity newer
  // than the snapshot is post-disposition advisory-bot acknowledgement
  // evidence, fall back to the effective values instead of re-opening.
  // Absent evidence keeps the legacy behavior unchanged (fail-closed).
  const ackItems = Array.isArray(live.ackOnly?.items) ? live.ackOnly.items : [];
  const ackEvidencePresent =
    live.ackOnly?.dispositionsPresent === true && ackItems.length > 0;
  const effectiveMax = normalizeComparableTimestamp(
    live.effective?.maxActivityUpdatedAt ?? 'none',
  );
  let ackOnlyApplied = false;
  if (snapshotMax === 'none' && liveCount > 0) {
    return { route: 'return-to-e1', reason: 'snapshot-was-empty-now-nonempty' };
  }
  if (
    typeof snapshotMax === 'number' &&
    liveCount > 0 &&
    (liveMax === null || liveMax === 'none')
  ) {
    return { route: 'return-to-e1', reason: 'missing-live-activity-evidence' };
  }
  if (
    typeof snapshotMax === 'number' &&
    typeof liveMax === 'number' &&
    liveMax > snapshotMax
  ) {
    const effectiveCurrent =
      ackEvidencePresent &&
      typeof live.effective === 'object' &&
      live.effective !== null &&
      (effectiveMax === 'none' ||
        (typeof effectiveMax === 'number' && effectiveMax <= snapshotMax));
    if (!effectiveCurrent) {
      return { route: 'return-to-e1', reason: 'newer-activity' };
    }
    ackOnlyApplied = true;
  }
  if (liveCount > snapshotCount) {
    // Only ack comments newer than the snapshot max may explain count
    // growth; older acks were already inside the snapshot's count.
    const ackNewerCount = ackItems.filter(
      (item) =>
        item.kind === 'comment' &&
        isValidIsoTimestamp(item.activityAt) &&
        typeof snapshotMax === 'number' &&
        compareIsoTimestamps(item.activityAt, snapshot.maxActivityUpdatedAt) >
          0,
    ).length;
    if (!(ackEvidencePresent && liveCount - ackNewerCount <= snapshotCount)) {
      return { route: 'return-to-e1', reason: 'same-timestamp-count-growth' };
    }
    ackOnlyApplied = true;
  }

  const snapshotCi = normalizeComparableTimestamp(
    snapshot.latestPassingCiCompletedAt ?? snapshot.latestCiCompletedAt,
  );
  const liveCi = normalizeComparableTimestamp(
    live.latestPassingCiCompletedAt ?? live.latestCiCompletedAt,
  );
  if (snapshotCi === null || liveCi === null) {
    return { route: 'return-to-e1', reason: 'missing-ci-evidence' };
  }
  if (snapshotCi !== liveCi) {
    return { route: 'return-to-e1', reason: 'ci-pass-drift' };
  }

  return {
    route: 'proceed',
    reason: ackOnlyApplied ? 'ack-only-post-disposition' : 'snapshot-current',
  };
}

export function classifyReviewThreadForGate(
  thread: ThreadLike,
  options: {
    iddAgentLogins?: unknown[] | null;
    prAuthorLogin?: string | null;
    requiresConversationResolution?: boolean;
  } = {},
): ReviewThreadGateClassification {
  if (thread.isResolved) {
    return { classification: 'resolved' };
  }
  if (thread.comments?.pageInfo?.hasNextPage) {
    return { classification: 'actionable-blocking' };
  }

  const comments = thread.comments?.nodes ?? [];
  const latestComment = comments.at(-1) ?? null;
  const latestCommentAt = normalizeComparableTimestamp(
    latestComment?.createdAt,
  );
  const latestAuthor = String(latestComment?.author?.login ?? '').toLowerCase();
  const iddAgentLogins = new Set(
    (options.iddAgentLogins ?? [])
      .map((login) => String(login ?? '').toLowerCase())
      .filter(Boolean),
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '').toLowerCase();
  const latestIsIddAgent = iddAgentLogins.has(latestAuthor);
  const latestIsPrAuthor =
    Boolean(prAuthorLogin) && latestAuthor === prAuthorLogin;
  let latestAmdIndex = -1;
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    const authorLogin = String(comment.author?.login ?? '').toLowerCase();
    if (
      iddAgentLogins.has(authorLogin) &&
      AMD_MARKER_PATTERN.test(String(comment.body ?? '').trimStart())
    ) {
      latestAmdIndex = index;
    }
  }
  const reviewerReopenedAt = normalizeComparableTimestamp(
    inferReviewerReopenedAt(thread),
  );
  const reopenedAfterLatestComment =
    typeof reviewerReopenedAt === 'number' &&
    (typeof latestCommentAt !== 'number' ||
      reviewerReopenedAt > latestCommentAt);
  const amdAwaitsMaintainer =
    latestAmdIndex >= 0 &&
    !reopenedAfterLatestComment &&
    !comments.slice(latestAmdIndex + 1).some((comment) => {
      const authorLogin = String(comment.author?.login ?? '').toLowerCase();
      return !iddAgentLogins.has(authorLogin) && authorLogin !== prAuthorLogin;
    });

  if (amdAwaitsMaintainer) {
    return { classification: 'amd-blocking' };
  }

  if (!(latestIsIddAgent || latestIsPrAuthor)) {
    return { classification: 'actionable-blocking' };
  }

  if (reopenedAfterLatestComment) {
    return { classification: 'actionable-blocking' };
  }

  if (options.requiresConversationResolution) {
    if (latestIsIddAgent) {
      return { classification: 'conversation-resolve-agent' };
    }
    return { classification: 'conversation-resolve-author' };
  }

  return { classification: 'awaiting-reviewer' };
}

export function summarizeReviewThreadsForGate(
  threads: ThreadLike[],
  options: {
    iddAgentLogins?: unknown[] | null;
    prAuthorLogin?: string | null;
    requiresConversationResolution?: boolean;
  } = {},
): ReviewThreadsGateSummary {
  const summary: ReviewThreadsGateSummary = {
    actionableCount: 0,
    awaitingReviewerCount: 0,
    amdBlockingCount: 0,
    conversationResolveAgentCount: 0,
    conversationResolveAuthorCount: 0,
    classifications: [],
  };

  for (const thread of threads) {
    const result = classifyReviewThreadForGate(thread, options);
    if (result.classification === 'resolved') {
      continue;
    }

    summary.classifications.push({
      id: thread.id,
      classification: result.classification,
    });

    if (result.classification === 'actionable-blocking') {
      summary.actionableCount += 1;
      continue;
    }
    if (result.classification === 'amd-blocking') {
      summary.amdBlockingCount += 1;
      summary.actionableCount += 1;
      continue;
    }
    if (result.classification === 'awaiting-reviewer') {
      summary.awaitingReviewerCount += 1;
      continue;
    }
    if (result.classification === 'conversation-resolve-agent') {
      summary.actionableCount += 1;
      summary.conversationResolveAgentCount += 1;
      continue;
    }
    if (result.classification === 'conversation-resolve-author') {
      summary.actionableCount += 1;
      summary.conversationResolveAuthorCount += 1;
    }
  }

  return summary;
}

function inferReviewerReopenedAt(thread: ThreadLike): string {
  const explicit = String(thread.reviewerReopenedAt ?? '');
  if (isValidIsoTimestamp(explicit)) {
    return explicit;
  }
  return '';
}

export function hasFreshDisposition(
  thread: ThreadLike,
  options: { isDispositionAuthor?: (login: string) => boolean } = {},
): boolean {
  // IMPORTANT: The default disposition-author predicate rejects known bots but accepts any human.
  // For F2/F3 merge-gate contexts (E7 disposition evidence), callers MUST pass
  // options.isDispositionAuthor with an IDD-scoped predicate (e.g., via summarizeDispositionEvidenceForGate).
  // Callers that require IDD-only dispositions (e.g., audit-pr-cleanup) should pass:
  //   { isDispositionAuthor: (login) => iddAgentLogins.has(login) }
  // This design trades stricter default behavior for backward compatibility with utility functions.
  const dispositionAuthorPredicate =
    typeof options.isDispositionAuthor === 'function'
      ? options.isDispositionAuthor
      : (login: string) => !isKnownReviewBot(login);
  const comments = thread.comments?.nodes ?? [];
  // A resolved thread may be terminally dispositioned with the documented
  // `**Rejection confirmed by maintainer**` marker instead of a fresh
  // `**Rejected**` re-post; recognize it as a disposition ONLY when the thread
  // is resolved (an unresolved thread still needs an explicit disposition).
  const threadResolved = Boolean(thread.isResolved);
  const isDisposition = (comment: { body?: string | null }): boolean =>
    isDispositionComment(comment) ||
    (threadResolved && isRejectionConfirmedDisposition(comment));
  const latestFeedbackAt = maxIsoTimestamp(
    comments
      .filter((comment) => {
        const authorLogin = String(comment.author?.login ?? '')
          .trim()
          .toLowerCase();
        return !(
          isDisposition(comment) && dispositionAuthorPredicate(authorLogin)
        );
      })
      .map((comment) => effectiveThreadCommentActivityAt(comment))
      .filter(isValidIsoTimestamp),
  );

  return comments.some((comment) => {
    const authorLogin = String(comment.author?.login ?? '')
      .trim()
      .toLowerCase();
    if (!(isDisposition(comment) && dispositionAuthorPredicate(authorLogin))) {
      return false;
    }
    const dispositionActivityAt = effectiveThreadCommentActivityAt(comment);
    if (!isValidIsoTimestamp(dispositionActivityAt)) {
      return false;
    }
    return (
      !latestFeedbackAt ||
      compareIsoTimestamps(dispositionActivityAt, latestFeedbackAt) > 0
    );
  });
}

// A disposition marker may carry a single interior punctuation char `[.!:]`
// immediately before the closing `**` — `**Accepted.**` (natural English
// "Accepted. Fixed in…"), `**Accepted:**`, `**Accepted!**`, and the `Rejected`
// equivalents — so a reply that punctuates the marker is still recognized. The
// tolerance is bounded to that one char before `**`, so an interior-text body
// like `**Accepted by reviewer, but…**` is NOT matched (fail-closed: a false
// positive is a false merge). Start-anchored (`^`), so the marker must be the
// first bytes of the body each caller passes: `isDispositionComment` uses
// `trimEnd()` only, so leading whitespace is NOT stripped (preserving the
// marker-first-bytes contract), while the notice / summary predicates below
// `trimStart()` first.
const DISPOSITION_ACCEPTED_PREFIX_RE = /^\*\*Accepted[.!:]?\*\*/;
const DISPOSITION_REJECTED_PREFIX_RE = /^\*\*Rejected[.!:]?\*\*/;

export function isDispositionComment(comment: {
  body?: string | null;
}): boolean {
  const body = (comment.body ?? '').trimEnd();
  return (
    DISPOSITION_ACCEPTED_PREFIX_RE.test(body) ||
    DISPOSITION_REJECTED_PREFIX_RE.test(body)
  );
}

// Terminal AMD-rejection marker. When a maintainer agrees with a rejection the
// agent replies `**Rejection confirmed by maintainer** — {summary}` and resolves
// the thread, with no separate `**Rejected**` re-post (per
// idd-review-triage.instructions.md). Mirrors the regex in
// review-disposition-verify so the F2/F3 gate recognizes the same marker.
const REJECTION_CONFIRMED_BY_MAINTAINER_RE =
  /^\*\*Rejection confirmed by maintainer\*\*\s+—/;

export function isRejectionConfirmedDisposition(comment: {
  body?: string | null;
}): boolean {
  return REJECTION_CONFIRMED_BY_MAINTAINER_RE.test(
    (comment.body ?? '').trimStart(),
  );
}

export function isIddDispositionComment(comment: CommentLike): boolean {
  const author = comment.author?.login ?? '';
  return isDispositionComment(comment) && !isKnownReviewBot(author);
}

// #1018 non-review-notice carry-forward classifiers.
//
// An advisory **non-review notice** — an advisory bot reporting it did not
// review the current HEAD (rate-limit / usage-quota exhaustion / review-limit) —
// carries no review result and is always dispositioned `**Rejected** — {bot} did
// not review HEAD …` per the E6 non-review-notice rule. The gate uses the two
// tight, fail-closed predicates below to let such a disposition carry forward
// across HEAD changes (see `summarizeDispositionEvidenceForGate`), so a Codex
// `updatedAt` bump or a re-posted CodeRabbit rate-limit summary does not re-flag
// `missing-disposition-evidence` for a notice the agent already rejected.
//
// Both intentionally **under-match**: an unrecognized notice merely keeps the
// existing per-push re-disposition churn (safe), while a false positive could
// carry a stale disposition onto a real review (a false merge). Only
// machine-generated, bot-specific signals match, and the notice predicate is
// evaluated solely on advisory-bot-authored comments at the gate, so a human
// reviewer comment is never reclassified as a notice.
const ADVISORY_NON_REVIEW_NOTICE_PATTERNS: RegExp[] = [
  // CodeRabbit rate-limit notice: the machine-generated marker (distinct from
  // the `summarize by coderabbit.ai` review marker) and its warning heading.
  /<!--\s*This is an auto-generated comment:\s*rate limited by coderabbit\.ai\s*-->/i,
  /^[>\s]*#{1,6}\s*Review limit reached\b/im,
  // Codex usage / quota exhaustion for code reviews.
  /\bCodex usage limits for code reviews\b/i,
  /\breached your Codex usage limits\b/i,
];

export function isAdvisoryNonReviewNotice(body: unknown): boolean {
  const text = String(body ?? '');
  if (!text) {
    return false;
  }
  return ADVISORY_NON_REVIEW_NOTICE_PATTERNS.some((pattern) =>
    pattern.test(text),
  );
}

// A trusted IDD disposition of a non-review notice: the canonical
// `**Rejected** — {bot} did not review HEAD {sha} ({reason}); this is not a
// completed review` reply. Requires the `**Rejected**` prefix (a notice is
// always rejected, never accepted) and the `did not review HEAD` phrase that
// names the notice, so an ordinary rejection of reviewer feedback is excluded.
export function isNonReviewNoticeDisposition(comment: {
  body?: string | null;
}): boolean {
  const body = (comment.body ?? '').trimStart();
  return (
    DISPOSITION_REJECTED_PREFIX_RE.test(body) &&
    /\bdid not review HEAD\b/i.test(body)
  );
}

// #1122 CodeRabbit summary-walkthrough auto-disposition classifiers.
//
// The CodeRabbit summary walkthrough is a regular comment whose body starts with
// `CODERABBIT_SUMMARY_MARKER`. Unlike a non-review notice it IS a completed
// review, so it is dispositioned `**Accepted**` (never `**Rejected**`). The gate
// scores it through its general updatedAt-aware 1:1 pairing, and CodeRabbit edits
// the summary on each re-review, so the disposition-non-review-notices helper
// re-dispositions the CURRENT summary per HEAD rather than carrying an old
// acceptance forward (a stale carry-forward could mask a finding folded into a
// later summary body — the "a false positive is a false merge" hazard).

// True when a regular comment is a CodeRabbit summary walkthrough. Detection is
// start-anchored on the exact single-sourced marker (after trimming leading
// whitespace) so a comment that merely quotes the marker in prose is not matched.
export function isReviewSummaryComment(body: unknown): boolean {
  return String(body ?? '')
    .trimStart()
    .startsWith(CODERABBIT_SUMMARY_MARKER);
}

// A trusted IDD disposition of a CodeRabbit summary walkthrough: the canonical
// `**Accepted** — {bot} summary walkthrough …` reply the helper posts. Requires
// the `**Accepted**` prefix (a summary is a completed review, so it is accepted,
// never rejected) AND the `summary walkthrough` phrase, so an ordinary acceptance
// of reviewer feedback is excluded. Tightly matched to `buildSummaryDispositionBody`
// so a loose acceptance can never be miscredited (which would under-post and
// strand the gate).
export function isReviewSummaryDisposition(comment: {
  body?: string | null;
}): boolean {
  const body = (comment.body ?? '').trimStart();
  return (
    DISPOSITION_ACCEPTED_PREFIX_RE.test(body) &&
    /\bsummary walkthrough\b/i.test(body)
  );
}

// The stable identity token of an advisory bot, used to attribute a non-review
// notice disposition to the bot it rejected. The `[bot]` suffix GitHub appends
// is dropped so the token matches whether a login is stored as `coderabbitai`
// or `coderabbitai[bot]`.
export function advisoryBotIdentityToken(login: unknown): string {
  return String(login ?? '')
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, '');
}

// True when a non-review-notice disposition body names the given advisory bot's
// GitHub login, so the gate can attribute a carry-forward to exactly one bot
// even when several advisory bots are configured. Fail-closed: an empty token or
// a disposition that does not contain the login carries nothing forward.
export function dispositionNamesAdvisoryBot(
  dispositionBody: unknown,
  noticeAuthorLogin: string,
): boolean {
  const token = advisoryBotIdentityToken(noticeAuthorLogin);
  if (!token) {
    return false;
  }
  return String(dispositionBody ?? '')
    .toLowerCase()
    .includes(token);
}

export function classifyCiChecks(checks: CheckLike[]) {
  const normalized = checks.map((check) => ({
    name: check.name,
    state: String(check.state ?? '').toUpperCase(),
    completedAt: check.completedAt ?? null,
  }));

  const failed = normalized.filter((check) => check.state === 'FAILURE');
  if (failed.length > 0) {
    return { status: 'failed', failed };
  }

  const pending = normalized.filter((check) => {
    return (
      check.state === 'QUEUED' ||
      check.state === 'IN_PROGRESS' ||
      check.state === 'WAITING'
    );
  });
  if (pending.length > 0) {
    return { status: 'pending', pending };
  }

  const passing = normalized.filter((check) => {
    return ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'NOT_APPLICABLE'].includes(
      check.state,
    );
  });

  return {
    status: passing.length === normalized.length ? 'success' : 'unknown',
    passing,
    unknown: normalized.filter((check) => !passing.includes(check)),
  };
}

/**
 * Match a review/reviewer login against the configured primary advisory bot.
 *
 * `primaryBotLogin` defaults to Copilot so existing callers stay behavior-
 * preserving. For the Copilot default the historical dual match is kept
 * (the exact `copilot` actor plus the `copilot-pull-request-reviewer*` GitHub
 * App login family). A non-Copilot configured login is matched by exact
 * normalized (trimmed, lower-cased) equality, since an arbitrary bot login has
 * no analogous prefix family.
 */
export function isCopilotReviewerLogin(
  login: unknown,
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
): boolean {
  const normalized = String(login ?? '')
    .trim()
    .toLowerCase();
  const configured =
    String(primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  if (configured === DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN) {
    return (
      normalized === 'copilot' ||
      normalized.startsWith('copilot-pull-request-reviewer')
    );
  }
  return normalized === configured;
}

export function findLastCopilotReviewCommit(
  reviews: ReviewLike[],
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
): string {
  const latest = reviews
    .filter((review) =>
      isCopilotReviewerLogin(
        review.user?.login ?? review.author?.login ?? '',
        primaryBotLogin,
      ),
    )
    .map((review) => ({
      submittedAt: review.submitted_at ?? review.submittedAt ?? '',
      commitId: review.commit_id ?? review.commitId ?? '',
    }))
    .sort((left, right) =>
      compareIsoTimestamps(left.submittedAt, right.submittedAt),
    )
    .at(-1);

  return latest?.commitId ?? '';
}

export function isCopilotPending(
  requestedReviewers: RequestedReviewerLike[],
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
): boolean {
  return requestedReviewers.some((reviewer) => {
    if (typeof reviewer === 'string') {
      return isCopilotReviewerLogin(reviewer, primaryBotLogin);
    }
    return isCopilotReviewerLogin(
      reviewer?.login ?? reviewer?.user?.login ?? '',
      primaryBotLogin,
    );
  });
}

export function computeCopilotPendingCoversHead(
  timelineEvents: TimelineEventLike[],
  prHeadSha: string,
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
): boolean {
  let headIndex = -1;
  let requestIndex = -1;

  timelineEvents.forEach((event, index) => {
    const eventName = String(event?.event ?? '');
    if (eventName === 'committed') {
      const sha = String(event?.sha ?? event?.commit_id ?? '');
      if (sha === prHeadSha) {
        headIndex = index;
      }
      return;
    }

    if (eventName === 'review_requested') {
      const reviewerLogin = event?.requested_reviewer?.login ?? '';
      if (isCopilotReviewerLogin(reviewerLogin, primaryBotLogin)) {
        requestIndex = index;
      }
    }
  });

  return headIndex !== -1 && requestIndex !== -1 && requestIndex > headIndex;
}

/**
 * True when the OPTIONAL secondary advisory bot has already been requested for
 * the current HEAD — i.e. a `review_requested` event for `secondaryBotLogin`
 * follows the current HEAD's `committed` event in the PR timeline. This is the
 * once-per-HEAD guard for the non-gating secondary supplement (issue #1099),
 * reusing the same timeline evidence as {@link computeCopilotPendingCoversHead}
 * so no new marker is needed: when HEAD advances, the new `committed` event
 * sits after the prior secondary request and the guard resets to `false`.
 *
 * The secondary is matched by exact normalized login equality (NOT the Copilot
 * family). An empty `secondaryBotLogin` short-circuits to `false` so an
 * unconfigured secondary never matches anything.
 */
export function computeSecondaryRequestedForHead(
  timelineEvents: TimelineEventLike[],
  prHeadSha: string,
  secondaryBotLogin: string,
): boolean {
  const configured = String(secondaryBotLogin ?? '')
    .trim()
    .toLowerCase();
  if (configured === '') {
    return false;
  }

  let headIndex = -1;
  let requestIndex = -1;

  timelineEvents.forEach((event, index) => {
    const eventName = String(event?.event ?? '');
    if (eventName === 'committed') {
      const sha = String(event?.sha ?? event?.commit_id ?? '');
      if (sha === prHeadSha) {
        headIndex = index;
      }
      return;
    }

    if (eventName === 'review_requested') {
      const reviewerLogin = String(event?.requested_reviewer?.login ?? '')
        .trim()
        .toLowerCase();
      if (reviewerLogin === configured) {
        requestIndex = index;
      }
    }
  });

  return headIndex !== -1 && requestIndex !== -1 && requestIndex > headIndex;
}

export function normalizeTrustedMarkerLogins(
  logins: unknown[] | null | undefined,
): string[] {
  return [
    ...new Set(
      (logins ?? [])
        .map((login) =>
          String(login ?? '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Resolve the trusted marker actors for a read-only evidence helper.
 *
 * Precedence is strict: an explicit `--trusted-marker-logins` flag wins over
 * the `IDD_TRUSTED_MARKER_ACTORS` env var, which wins over the
 * `trustedMarkerActors` array declared in `.github/idd/config.json`. The flag
 * and env var are CSV strings (or arrays); `config` is the parsed policy
 * object. The returned `source` records which input supplied the value so the
 * helper can emit it as auditable JSON evidence.
 */
export function resolveTrustedMarkerActors({
  flagValue = '',
  envValue = '',
  config = null,
}: {
  flagValue?: string | string[];
  envValue?: string | string[];
  config?: { trustedMarkerActors?: unknown } | null;
} = {}): TrustedMarkerActorResolution {
  const fromFlag = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(flagValue),
  );
  if (fromFlag.length > 0) {
    return { actors: fromFlag, source: 'flag' };
  }
  const fromEnv = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(envValue),
  );
  if (fromEnv.length > 0) {
    return { actors: fromEnv, source: 'env' };
  }
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(config?.trustedMarkerActors)
      ? config.trustedMarkerActors
      : [],
  );
  if (fromConfig.length > 0) {
    return { actors: fromConfig, source: 'config' };
  }
  return { actors: [], source: 'none' };
}

function trustedMarkerActorTokens(value: unknown): unknown[] {
  return Array.isArray(value) ? value : String(value ?? '').split(',');
}

export function unionTrustedMarkerActorSources({
  envValue = '',
  config = null,
  extraActors = [],
  extraSource = '',
}: {
  envValue?: string | string[];
  config?: { trustedMarkerActors?: unknown } | null;
  extraActors?: unknown[];
  extraSource?: string;
} = {}): TrustedMarkerActorSourceMix {
  const sources: string[] = [];
  const actors: string[] = [];
  const extras = normalizeTrustedMarkerLogins(extraActors);
  if (extras.length > 0) {
    actors.push(...extras);
    if (extraSource) {
      sources.push(extraSource);
    }
  }
  const fromEnv = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(envValue),
  );
  if (fromEnv.length > 0) {
    actors.push(...fromEnv);
    sources.push('env');
  }
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(config?.trustedMarkerActors)
      ? config.trustedMarkerActors
      : [],
  );
  if (fromConfig.length > 0) {
    actors.push(...fromConfig);
    sources.push('config');
  }
  return { actors: normalizeTrustedMarkerLogins(actors), sources };
}

export function resolveAdvisoryBotLogins({
  flagValue = '',
  envValue = '',
  config = null,
}: {
  flagValue?: string | string[];
  envValue?: string | string[];
  config?: { advisoryBotLogins?: unknown } | null;
} = {}): AdvisoryBotLoginResolution {
  const fromFlag = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(flagValue),
  );
  if (fromFlag.length > 0) {
    return { logins: fromFlag, source: 'flag' };
  }
  const fromEnv = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(envValue),
  );
  if (fromEnv.length > 0) {
    return { logins: fromEnv, source: 'env' };
  }
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(config?.advisoryBotLogins) ? config.advisoryBotLogins : [],
  );
  if (fromConfig.length > 0) {
    return { logins: fromConfig, source: 'config' };
  }
  return { logins: [], source: 'none' };
}

export function deriveIddAgentLogins({
  viewerLogin = '',
  iddAgentLogins = [],
  trustedMarkerLogins = [],
  operationalComments = [],
}: {
  viewerLogin?: string;
  iddAgentLogins?: unknown[] | null;
  trustedMarkerLogins?: unknown[] | null;
  operationalComments?: CommentLike[] | null;
} = {}): string[] {
  const trustedLogins = new Set(
    normalizeTrustedMarkerLogins(trustedMarkerLogins),
  );
  const derivedLogins = [viewerLogin, ...(iddAgentLogins ?? [])];

  for (const comment of operationalComments ?? []) {
    const authorLogin = String(
      comment?.author?.login ?? comment?.user?.login ?? '',
    )
      .trim()
      .toLowerCase();
    const body = String(comment?.body ?? '');
    const markerPrefix = operationalMarkerPrefix(body);
    if (
      !trustedLogins.has(authorLogin) ||
      !markerPrefix ||
      !IDD_AGENT_DERIVED_MARKERS.has(markerPrefix)
    ) {
      continue;
    }
    derivedLogins.push(authorLogin);
  }

  return normalizeTrustedMarkerLogins(derivedLogins);
}

export function summarizeAdvisoryWaitMarkers(
  comments: CommentLike[],
  prHeadSha: string,
  trustedMarkerLogins: unknown[] | null | undefined,
): AdvisoryWaitMarkerSummary {
  const trustedLogins = new Set(
    normalizeTrustedMarkerLogins(trustedMarkerLogins),
  );
  let earliestSameHeadAt = '';
  let trustedSameHeadMarkerCount = 0;
  let trustedRequestMarkerCount = 0;
  let untrustedSameHeadMarkerCount = 0;
  let untrustedRequestMarkerCount = 0;

  for (const comment of comments) {
    const body = String(comment?.body ?? '').trimEnd();
    const login = String(comment?.author?.login ?? comment?.user?.login ?? '')
      .trim()
      .toLowerCase();
    const trusted = trustedLogins.has(login);
    const isSameHeadMarker = advisoryWaitMarkerMatchesHead(body, prHeadSha);
    const isRequestMarker = advisoryWaitRequestMarker(body);

    if (isSameHeadMarker) {
      if (trusted) {
        trustedSameHeadMarkerCount += 1;
        const createdAt = String(
          comment?.createdAt ?? comment?.created_at ?? '',
        );
        if (
          isValidIsoTimestamp(createdAt) &&
          (!earliestSameHeadAt ||
            compareIsoTimestamps(createdAt, earliestSameHeadAt) < 0)
        ) {
          earliestSameHeadAt = createdAt;
        }
      } else {
        untrustedSameHeadMarkerCount += 1;
      }
    }

    if (isRequestMarker) {
      if (trusted) {
        trustedRequestMarkerCount += 1;
      } else {
        untrustedRequestMarkerCount += 1;
      }
    }
  }

  return {
    sameHeadMarkerPresent: trustedSameHeadMarkerCount > 0,
    earliestSameHeadAt,
    sameHeadMarkerCount: trustedSameHeadMarkerCount,
    requestMarkerCount: trustedRequestMarkerCount,
    trustedSameHeadMarkerCount,
    untrustedSameHeadMarkerCount,
    trustedRequestMarkerCount,
    untrustedRequestMarkerCount,
  };
}

export function evaluateAdvisoryWaitOutcome(
  input: AdvisoryWaitOutcomeInput,
): string {
  const { requestCap, pendingWindowMinutes, settledWindowMinutes } =
    normalizeAdvisoryWaitRuntimeOptions(input);

  if (input.lastCopilotCommit === input.prHeadSha) {
    return 'SATISFIED';
  }

  if (input.copilotPending) {
    if (!input.sameHeadMarkerPresent) {
      return input.copilotPendingCoversHead
        ? 'RECOVERY_NEEDED'
        : input.requestMarkerCount >= requestCap
          ? 'CAP_EXHAUSTED'
          : 'REQUEST_NEEDED';
    }
    return input.elapsedMinutes >= pendingWindowMinutes ? 'SATISFIED' : 'WAIT';
  }

  if (!input.sameHeadMarkerPresent) {
    return input.requestMarkerCount >= requestCap
      ? 'CAP_EXHAUSTED'
      : 'REQUEST_NEEDED';
  }

  return input.elapsedMinutes >= settledWindowMinutes ? 'SATISFIED' : 'WAIT';
}

// F3 deliberately has a separate outcome from evaluateAdvisoryWaitOutcome:
// once Copilot is no longer pending (review submitted or cancelled), F3
// treats the advisory wait as SATISFIED so a settled-but-not-re-reviewed
// HEAD can merge, even while the shared `outcome` still routes E14/F2 to
// REQUEST_NEEDED. F3 reads f3Outcome exclusively when helper output is
// valid; see idd-advisory-wait.instructions.md §1 (F3-specific interpretation).
export function evaluateAdvisoryWaitF3Outcome(
  input: AdvisoryWaitOutcomeInput,
): string {
  if (input.lastCopilotCommit === input.prHeadSha || !input.copilotPending) {
    return 'SATISFIED';
  }
  return evaluateAdvisoryWaitOutcome(input);
}

export function buildAdvisoryWaitSummary(
  {
    prHeadSha,
    reviews = [],
    requestedReviewers = [],
    timelineEvents = [],
    comments = [],
  }: {
    prHeadSha: string;
    reviews?: ReviewLike[];
    requestedReviewers?: RequestedReviewerLike[];
    timelineEvents?: TimelineEventLike[];
    comments?: CommentLike[];
  },
  options: {
    now?: string;
    trustedMarkerLogins?: unknown[] | null;
    configuredTrustedActors?: unknown[] | null;
    viewerLogin?: string | null;
    collaboratorTrustEnabled?: boolean;
    requestCap?: number;
    pendingWindowMinutes?: number;
    settledWindowMinutes?: number;
    pollIntervalMinutes?: number;
    capExhaustedRoute?: string;
    primaryBotLogin?: string;
    secondaryBotLogin?: string;
  } = {},
) {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  if (!/^[0-9a-f]{40}$/.test(String(prHeadSha ?? ''))) {
    throw new Error('prHeadSha must be a 40-character lowercase commit SHA');
  }

  const trustedMarkerLogins = normalizeTrustedMarkerLogins(
    options.trustedMarkerLogins ?? [],
  );
  const configuredTrustedActors = normalizeTrustedMarkerLogins(
    options.configuredTrustedActors ?? [],
  );
  const primaryBotLogin =
    String(options.primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const markerSummary = summarizeAdvisoryWaitMarkers(
    comments,
    prHeadSha,
    trustedMarkerLogins,
  );
  const elapsedMinutes = markerSummary.sameHeadMarkerPresent
    ? minutesBetweenIso(markerSummary.earliestSameHeadAt, now)
    : 0;
  const lastCopilotCommit = findLastCopilotReviewCommit(
    reviews,
    primaryBotLogin,
  );
  const copilotPending = isCopilotPending(requestedReviewers, primaryBotLogin);
  const copilotPendingCoversHead = computeCopilotPendingCoversHead(
    timelineEvents,
    prHeadSha,
    primaryBotLogin,
  );
  const {
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
    pollIntervalMinutes,
    capExhaustedRoute,
  } = normalizeAdvisoryWaitRuntimeOptions(options);

  const outcomeInput = {
    lastCopilotCommit,
    prHeadSha,
    copilotPending,
    copilotPendingCoversHead,
    sameHeadMarkerPresent: markerSummary.sameHeadMarkerPresent,
    requestMarkerCount: markerSummary.requestMarkerCount,
    elapsedMinutes,
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
  };
  const outcome = evaluateAdvisoryWaitOutcome(outcomeInput);
  const f3Outcome = evaluateAdvisoryWaitF3Outcome(outcomeInput);

  // Optional NON-GATING secondary advisory bot (issue #1099). Resolved AFTER
  // `outcome` and never fed into `outcomeInput`, so it can never satisfy or
  // alter the primary advisory-wait gate (contract a). A secondary equal to the
  // primary is treated as unconfigured (misconfiguration guard).
  const secondaryBotLogin = String(options.secondaryBotLogin ?? '')
    .trim()
    .toLowerCase();
  const secondaryConfigured =
    secondaryBotLogin !== '' && secondaryBotLogin !== primaryBotLogin;
  // Once per HEAD, read from the GitHub timeline (a `review_requested` for the
  // secondary after the current HEAD's `committed` event) — no marker is posted
  // for the secondary, so it never receives a primary `advisory-wait` marker
  // and never burns the primary cap (contract b).
  const secondaryAlreadyRequested =
    secondaryConfigured &&
    computeSecondaryRequestedForHead(
      timelineEvents,
      prHeadSha,
      secondaryBotLogin,
    );
  // Request the secondary once per HEAD only when a follow-up pass is genuinely
  // needed (the primary has not reviewed HEAD) AND the primary is
  // cap-exhausted, or stalled/rate-limited (the wait was closed by the elapsed
  // settle/pending window rather than by a HEAD review). REQUEST_NEEDED (primary
  // still requestable), WAIT (still in-window), and RECOVERY_NEEDED (active
  // recovery) deliberately do not trigger the supplement.
  const secondaryRequestNeeded =
    secondaryConfigured &&
    !secondaryAlreadyRequested &&
    lastCopilotCommit !== prHeadSha &&
    (outcome === 'CAP_EXHAUSTED' ||
      (outcome === 'SATISFIED' && markerSummary.sameHeadMarkerPresent));

  return {
    protocolVersion: '1',
    prHeadSha,
    lastCopilotCommit,
    copilotPending,
    copilotPendingCoversHead,
    outcome,
    f3Outcome,
    secondaryBotLogin: secondaryConfigured ? secondaryBotLogin : '',
    secondaryRequestNeeded,
    now,
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
    pollIntervalMinutes,
    capExhaustedRoute,
    elapsedMinutes,
    sameHeadMarkerPresent: markerSummary.sameHeadMarkerPresent,
    earliestSameHeadAt: markerSummary.earliestSameHeadAt,
    sameHeadMarkerCount: markerSummary.sameHeadMarkerCount,
    requestMarkerCount: markerSummary.requestMarkerCount,
    trustedMarkerSummary: {
      viewerLogin: String(options.viewerLogin ?? '')
        .trim()
        .toLowerCase(),
      configuredTrustedActors,
      collaboratorTrustEnabled: Boolean(options.collaboratorTrustEnabled),
      trustedMarkerLogins,
      trustedSameHeadMarkerCount: markerSummary.trustedSameHeadMarkerCount,
      untrustedSameHeadMarkerCount: markerSummary.untrustedSameHeadMarkerCount,
      trustedRequestMarkerCount: markerSummary.trustedRequestMarkerCount,
      untrustedRequestMarkerCount: markerSummary.untrustedRequestMarkerCount,
    },
  };
}

export function buildActivitySnapshotSummary(
  {
    comments = [],
    reviews = [],
    threads = [],
    checks = [],
  }: {
    comments?: CommentLike[];
    reviews?: ReviewLike[];
    threads?: ThreadLike[];
    checks?: CheckLike[];
  },
  options: {
    trustedMarkerLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    dispositionAuthorLogins?: unknown[] | null;
    advisoryBotLoginsSource?: unknown;
  } = {},
) {
  const trustedMarkerLogins = new Set(
    (options.trustedMarkerLogins ?? [])
      .map((login) =>
        String(login ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const dispositionAuthorLogins = new Set(
    normalizeTrustedMarkerLogins(options.dispositionAuthorLogins ?? []),
  );
  // An advisory bot can never anchor "dispositions exist": its own
  // **Accepted**/**Rejected**-shaped replies must not start the
  // post-disposition window that classifies its later acks.
  for (const login of advisoryBotLogins) {
    dispositionAuthorLogins.delete(login);
  }
  const isAdvisoryBot = (login: unknown) =>
    isConfiguredAdvisoryBotLogin(login, advisoryBotLogins);
  const isDispositionAuthor = (login: unknown) =>
    dispositionAuthorLogins.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );

  const filteredComments = comments.filter((comment) => {
    if (!trustedMarkerLogins.has((comment.author?.login ?? '').toLowerCase())) {
      return true;
    }
    return operationalMarkerPrefixByStart(comment.body ?? '') === null;
  });

  // Structural ack-only evidence (#858): the posting moment of the latest
  // disposition by a configured disposition author opens the window;
  // comments and resolved-thread replies are classified per item below.
  // Dispositions are not SHA-bound here — the head-changed check in
  // diffReviewSnapshot plus the unchanged disposition-evidence and
  // unreplied-comment gates backstop that residual.
  const dispositionCreatedAts = [
    ...filteredComments
      .filter(
        (comment) =>
          isDispositionAuthor(comment.author?.login) &&
          isDispositionComment(comment),
      )
      .map((comment) => comment.createdAt),
    ...threads.flatMap((thread) =>
      (thread.comments?.nodes ?? [])
        .filter(
          (comment) =>
            isDispositionAuthor(comment.author?.login) &&
            isDispositionComment(comment),
        )
        .map((comment) => comment.createdAt),
    ),
  ].filter(isValidIsoTimestamp);
  const latestDispositionAt = maxIsoTimestamp(dispositionCreatedAts) ?? null;

  const isAckOnlyComment = (comment: CommentLike) => {
    if (!latestDispositionAt) {
      return false;
    }
    if (!isAdvisoryBot(comment.author?.login)) {
      return false;
    }
    if (isDispositionComment(comment)) {
      return false;
    }
    const activityAt = comment.updatedAt ?? comment.createdAt;
    if (!isValidIsoTimestamp(activityAt)) {
      return false;
    }
    return compareIsoTimestamps(activityAt, latestDispositionAt) > 0;
  };
  const ackOnlyComments = filteredComments.filter(isAckOnlyComment);
  const ackOnlyCommentSet = new Set(ackOnlyComments);

  // On a resolved thread whose latest reply chain contains a disposition,
  // later advisory-bot replies are structurally ack-only; the effective
  // thread activity is recomputed from the remaining replies. Reopened
  // (unresolved) threads always keep their raw activity.
  const threadEffective = threads.map((thread) => {
    const nodes = thread.comments?.nodes ?? [];
    const threadDispositionAt =
      maxIsoTimestamp(
        nodes
          .filter(
            (comment) =>
              isDispositionAuthor(comment.author?.login) &&
              isDispositionComment(comment),
          )
          .map((comment) => comment.createdAt)
          .filter(isValidIsoTimestamp),
      ) ?? null;
    // Per-reply attribution needs the reply timeline: when a caller
    // populates thread.updatedAt we cannot tell whether it reflects an
    // ack or substantive activity, so fail closed and keep raw activity
    // (production normalizers blank thread.updatedAt to opt in).
    if (
      !thread.isResolved ||
      !threadDispositionAt ||
      isValidIsoTimestamp(thread.updatedAt ?? '')
    ) {
      return { activityAt: threadActivityAt(thread), ackReplies: [] };
    }
    const ackReplies = nodes.filter((comment) => {
      if (!isAdvisoryBot(comment.author?.login)) {
        return false;
      }
      if (isDispositionComment(comment)) {
        return false;
      }
      const activityAt = effectiveThreadCommentActivityAt(comment);
      return (
        isValidIsoTimestamp(activityAt) &&
        compareIsoTimestamps(activityAt, threadDispositionAt) > 0
      );
    });
    if (ackReplies.length === 0) {
      return { activityAt: threadActivityAt(thread), ackReplies: [] };
    }
    const ackReplySet = new Set(ackReplies);
    const keptActivities = nodes
      .filter((comment) => !ackReplySet.has(comment))
      .flatMap((comment) => [comment.updatedAt, comment.createdAt])
      .filter(isValidIsoTimestamp);
    return { activityAt: maxIsoTimestamp(keptActivities), ackReplies };
  });
  const ackOnlyThreadReplies = threadEffective.flatMap(
    (entry) => entry.ackReplies,
  );

  const commentActivities = filteredComments
    .map((comment) => comment.updatedAt ?? comment.createdAt)
    .filter(isValidIsoTimestamp);
  const reviewActivities = reviews
    .map((review) => review.updatedAt ?? review.submittedAt ?? review.createdAt)
    .filter(isValidIsoTimestamp);
  const threadActivities = threads
    .map((thread) => threadActivityAt(thread))
    .filter(isValidIsoTimestamp);

  const latestCiCompletedAt =
    maxIsoTimestamp(
      checks.map((check) => check.completedAt).filter(isCompletedCiTimestamp),
    ) ?? 'none';

  const latestPassingCiCompletedAt =
    maxIsoTimestamp(
      checks
        .filter((check) => {
          const state = String(check.state ?? '').toUpperCase();
          return ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'NOT_APPLICABLE'].includes(
            state,
          );
        })
        .map((check) => check.completedAt)
        .filter(isCompletedCiTimestamp),
    ) ?? 'none';

  const maxActivityUpdatedAt =
    maxIsoTimestamp([
      ...commentActivities,
      ...reviewActivities,
      ...threadActivities,
    ]) ?? 'none';

  const effectiveCommentActivities = filteredComments
    .filter((comment) => !ackOnlyCommentSet.has(comment))
    .map((comment) => comment.updatedAt ?? comment.createdAt)
    .filter(isValidIsoTimestamp);
  const effectiveThreadActivities = threadEffective
    .map((entry) => entry.activityAt)
    .filter(isValidIsoTimestamp);
  const effectiveMaxActivityUpdatedAt =
    maxIsoTimestamp([
      ...effectiveCommentActivities,
      ...reviewActivities,
      ...effectiveThreadActivities,
    ]) ?? 'none';

  const describeAckItem = (
    kind: string,
    comment: CommentLike | ThreadCommentLike,
    activityAt: unknown,
  ) => ({
    kind,
    id: String(comment.id ?? ''),
    author: String(comment.author?.login ?? '')
      .trim()
      .toLowerCase(),
    activityAt: isValidIsoTimestamp(activityAt) ? activityAt : 'none',
    bodyPreview: String(comment.body ?? '').slice(0, 120),
  });

  return {
    totalItemCount: filteredComments.length + reviews.length + threads.length,
    maxActivityUpdatedAt,
    latestCiCompletedAt,
    latestPassingCiCompletedAt,
    counts: {
      comments: filteredComments.length,
      reviews: reviews.length,
      threads: threads.length,
    },
    ackOnly: {
      advisoryBotLogins: [...advisoryBotLogins].sort(),
      source: String(options.advisoryBotLoginsSource ?? 'none'),
      dispositionsPresent: Boolean(latestDispositionAt),
      latestDispositionAt: latestDispositionAt ?? 'none',
      items: [
        ...ackOnlyComments.map((comment) =>
          describeAckItem(
            'comment',
            comment,
            comment.updatedAt ?? comment.createdAt,
          ),
        ),
        ...ackOnlyThreadReplies.map((comment) =>
          describeAckItem(
            'thread-reply',
            comment,
            effectiveThreadCommentActivityAt(comment),
          ),
        ),
      ],
    },
    effective: {
      maxActivityUpdatedAt: effectiveMaxActivityUpdatedAt,
      totalItemCount:
        filteredComments.length -
        ackOnlyComments.length +
        reviews.length +
        threads.length,
    },
  };
}

export function resolveLatestReviewWatermark(
  comments: CommentLike[],
  options: {
    expectedClaimId?: unknown;
    isTrustedAuthor?: (login: string) => boolean;
  } = {},
): ParsedReviewWatermark | null {
  const expectedClaimId = String(options.expectedClaimId ?? '').trim();
  const isTrustedAuthor = options.isTrustedAuthor ?? (() => true);

  let latest: ParsedReviewWatermark | null = null;
  for (const comment of comments) {
    if (!isTrustedAuthor(comment.author?.login ?? comment.user?.login ?? '')) {
      continue;
    }

    const parsed = parseReviewWatermarkComment(
      comment.body ?? '',
      comment.createdAt ?? comment.created_at ?? '',
    );
    if (!parsed) {
      continue;
    }
    if (expectedClaimId && parsed.claimId !== expectedClaimId) {
      continue;
    }
    const parsedCreatedAt = normalizeComparableTimestamp(parsed.createdAt);
    if (parsedCreatedAt === null || parsedCreatedAt === 'none') {
      continue;
    }
    const latestCreatedAt = normalizeComparableTimestamp(
      latest?.createdAt ?? 'none',
    );
    if (
      latestCreatedAt === null ||
      latestCreatedAt === 'none' ||
      parsedCreatedAt > latestCreatedAt
    ) {
      latest = parsed;
    }
  }

  return latest;
}

export function summarizeRegularCommentsForGate(
  comments: CommentLike[],
  options: {
    iddAgentLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    trustedMarkerLogins?: unknown[] | null;
    threads?: ThreadLike[] | null;
  } = {},
): RegularCommentsGateSummary {
  const iddAgentLogins = new Set(
    normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []),
  );
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const threads = Array.isArray(options.threads) ? options.threads : [];

  const normalized = comments
    .map((comment, inputIndex) => ({
      id: String(comment.id ?? ''),
      authorLogin: String(comment.author?.login ?? comment.user?.login ?? '')
        .trim()
        .toLowerCase(),
      body: String(comment.body ?? ''),
      createdAt: String(comment.createdAt ?? comment.created_at ?? ''),
      updatedAt: String(comment.updatedAt ?? comment.updated_at ?? ''),
      inputIndex,
    }))
    .filter((comment) => isValidIsoTimestamp(comment.createdAt))
    .map((comment) => ({
      ...comment,
      activityAt: effectiveRegularCommentActivityAt(comment),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.activityAt);
      const rightTime = Date.parse(right.activityAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.inputIndex - right.inputIndex;
    })
    .map((comment, sortedIndex) => ({ ...comment, sortedIndex }));

  const lastIddReplyAt = normalized.reduce((latestTimestamp, comment) => {
    if (
      isOperationalOrDigestCommentForGate(
        comment.body,
        comment.authorLogin,
        trustedMarkerLogins,
      ) ||
      !iddAgentLogins.has(comment.authorLogin)
    ) {
      return latestTimestamp;
    }
    if (
      !latestTimestamp ||
      compareIsoTimestamps(comment.createdAt, latestTimestamp) > 0
    ) {
      return comment.createdAt;
    }
    return latestTimestamp;
  }, '');

  const classificationComments = normalized.map((comment) => ({
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
  }));

  const items = normalized
    .filter(
      (comment) =>
        !isOperationalOrDigestCommentForGate(
          comment.body,
          comment.authorLogin,
          trustedMarkerLogins,
        ),
    )
    .filter((comment) => !iddAgentLogins.has(comment.authorLogin))
    .filter(
      (comment) =>
        !lastIddReplyAt ||
        compareIsoTimestamps(lastIddReplyAt, comment.activityAt) <= 0,
    )
    .filter((comment) => {
      if (!isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins)) {
        return true;
      }
      return (
        classifyRegularBotComment(
          {
            author: { login: comment.authorLogin },
            body: comment.body,
            createdAt: comment.createdAt,
          },
          classificationComments,
          threads,
          {
            isDispositionAuthor: (login) =>
              iddAgentLogins.has(
                String(login ?? '')
                  .trim()
                  .toLowerCase(),
              ),
          },
        ) === null
      );
    })
    .map((comment) => ({
      id: comment.id,
      authorLogin: comment.authorLogin,
      createdAt: comment.createdAt,
      bodyPreview: buildBodyPreview(comment.body),
    }));

  return {
    count: items.length,
    items,
  };
}

export function summarizeDispositionEvidenceForGate(
  {
    comments = [],
    threads = [],
  }: { comments?: CommentLike[]; threads?: ThreadLike[] },
  options: {
    iddAgentLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    trustedMarkerLogins?: unknown[] | null;
    prAuthorLogin?: string | null;
    snapshotBoundaryAt?: string | null;
  } = {},
): DispositionEvidenceSummary {
  const iddAgentLogins = new Set(
    normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []),
  );
  // The review-snapshot boundary (the active watermark's
  // max-activity-updatedAt). A resolved thread whose newest external feedback
  // predates it was settled before the snapshot and is out of E7 scope.
  const snapshotBoundaryAt = isValidIsoTimestamp(options.snapshotBoundaryAt)
    ? String(options.snapshotBoundaryAt)
    : null;
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '')
    .trim()
    .toLowerCase();

  const normalizedComments = comments
    .map((comment, inputIndex) => ({
      id: String(comment.id ?? ''),
      authorLogin: String(comment.author?.login ?? comment.user?.login ?? '')
        .trim()
        .toLowerCase(),
      body: String(comment.body ?? ''),
      createdAt: String(comment.createdAt ?? comment.created_at ?? ''),
      updatedAt: String(comment.updatedAt ?? comment.updated_at ?? ''),
      inputIndex,
    }))
    .filter((comment) => isValidIsoTimestamp(comment.createdAt))
    .map((comment) => ({
      ...comment,
      activityAt: effectiveRegularCommentActivityAt(comment),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.activityAt);
      const rightTime = Date.parse(right.activityAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.inputIndex - right.inputIndex;
    })
    .map((comment, sortedIndex) => ({ ...comment, sortedIndex }));

  const classificationComments = normalizedComments.map((comment) => ({
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
  }));

  const outstandingComments = normalizedComments
    .filter(
      (comment) =>
        !isOperationalOrDigestCommentForGate(
          comment.body,
          comment.authorLogin,
          trustedMarkerLogins,
        ),
    )
    .filter((comment) => !iddAgentLogins.has(comment.authorLogin))
    .filter((comment) => {
      if (!isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins)) {
        return true;
      }
      return (
        classifyRegularBotComment(
          {
            author: { login: comment.authorLogin },
            body: comment.body,
            createdAt: comment.createdAt,
          },
          classificationComments,
          threads,
          {
            isDispositionAuthor: (login) =>
              iddAgentLogins.has(
                String(login ?? '')
                  .trim()
                  .toLowerCase(),
              ),
          },
        ) === null
      );
    });

  const dispositionComments = normalizedComments.filter(
    (comment) =>
      iddAgentLogins.has(comment.authorLogin) &&
      isDispositionComment({ body: comment.body }),
  );

  // #1018 non-review-notice carry-forward (fail-closed, author-scoped). A
  // persistent advisory non-review notice already dispositioned `**Rejected** —
  // {bot-login} did not review HEAD …` keeps that disposition across HEAD changes
  // while the bot still has not reviewed any HEAD: a Codex `updatedAt` bump or a
  // re-posted CodeRabbit rate-limit summary must not re-flag
  // `missing-disposition-evidence` for a notice the agent already rejected.
  //
  // Each carry-forward is matched strictly WITHIN one advisory-bot identity: a
  // notice carries forward only against a notice-disposition whose body names
  // that same bot's GitHub login. This repository can configure several advisory
  // bots at once (CodeRabbit + a Codex connector), so a count/order-only pairing
  // could credit bot A's disposition to bot B's still-undispositioned notice and
  // suppress a real blocker. An unattributable disposition (one that names no
  // configured bot login) carries nothing forward — the original re-disposition
  // churn, which is safe. Matched notices leave the outstanding set and the
  // matched notice-dispositions leave the general disposition pool, so a notice
  // disposition never also clears an unrelated regular comment and the notice's
  // bumped activity can never strand its disposition. The guard re-checks the
  // current notice body, so a notice the bot later replaces with a real review no
  // longer matches and still needs a fresh disposition. Any unmatched notice or
  // disposition falls through to the unchanged 1:1 pairing.
  const noticeDispositions = dispositionComments.filter((comment) =>
    isNonReviewNoticeDisposition({ body: comment.body }),
  );
  const outstandingNotices = outstandingComments.filter(
    (comment) =>
      isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) &&
      isAdvisoryNonReviewNotice(comment.body),
  );
  const carriedNoticeIndexes = new Set<number>();
  const consumedNoticeDispositionIndexes = new Set<number>();
  const noticesByAuthor = new Map<string, typeof outstandingNotices>();
  for (const notice of outstandingNotices) {
    const list = noticesByAuthor.get(notice.authorLogin) ?? [];
    list.push(notice);
    noticesByAuthor.set(notice.authorLogin, list);
  }
  // Sort the bot logins so disposition consumption is deterministic when a single
  // disposition body could name more than one configured bot (it is consumed by
  // the lexicographically-first matching author only).
  for (const authorLogin of [...noticesByAuthor.keys()].sort()) {
    const notices = noticesByAuthor.get(authorLogin) ?? [];
    const matchingDispositions = noticeDispositions.filter(
      (disposition) =>
        !consumedNoticeDispositionIndexes.has(disposition.sortedIndex) &&
        dispositionNamesAdvisoryBot(disposition.body, authorLogin),
    );
    const carry = Math.min(notices.length, matchingDispositions.length);
    for (let index = 0; index < carry; index += 1) {
      carriedNoticeIndexes.add(notices[index].sortedIndex);
      consumedNoticeDispositionIndexes.add(
        matchingDispositions[index].sortedIndex,
      );
    }
  }

  // Count-based 1:1 pairing for the trailing-marker rule: a single later IDD
  // disposition marker addresses at most ONE earlier regular comment, so one
  // trailing marker cannot clear several distinct comments that each still
  // lack a disposition.
  // Walk the outstanding comments oldest-first and greedily consume the
  // earliest disposition marker strictly newer than each (markers that are not
  // newer than the current comment cannot address it or any later comment).
  const dispositionTimes = dispositionComments
    .filter(
      (comment) => !consumedNoticeDispositionIndexes.has(comment.sortedIndex),
    )
    .map((comment) => comment.activityAt)
    .filter(isValidIsoTimestamp)
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  let markerCursor = 0;
  const missing: typeof outstandingComments = [];
  for (const comment of outstandingComments) {
    if (carriedNoticeIndexes.has(comment.sortedIndex)) {
      continue;
    }
    while (
      markerCursor < dispositionTimes.length &&
      compareIsoTimestamps(
        dispositionTimes[markerCursor],
        comment.activityAt,
      ) <= 0
    ) {
      markerCursor += 1;
    }
    if (markerCursor < dispositionTimes.length) {
      markerCursor += 1;
    } else {
      missing.push(comment);
    }
  }

  const missingRegularComments = missing.map((comment) => ({
    id: comment.id || `comment-${comment.sortedIndex + 1}`,
    authorLogin: comment.authorLogin || 'unknown',
    createdAt: comment.createdAt,
    bodyPreview: buildBodyPreview(comment.body),
  }));

  // #978 advisory-only diagnostic: a blocking resolved thread is
  // "ack-only-post-disposition" when a thread-local IDD disposition exists and
  // EVERY external comment newer than BOTH the snapshot boundary (so it re-blocks
  // the gate) AND the disposition is an advisory-bot, non-disposition courtesy
  // ack. Reuses the review-currency carve-out's recognition shape (advisory-bot
  // predicate driven by `advisoryBotLogins`, no hard-coded logins;
  // post-disposition ack). Fails closed (false) without a snapshot boundary,
  // without a thread-local disposition, or for unresolved threads, and never
  // changes the gate route.
  const isThreadAckOnlyPostDisposition = (thread: ThreadLike): boolean => {
    if (!thread.isResolved || !snapshotBoundaryAt) {
      return false;
    }
    const nodes = thread.comments?.nodes ?? [];
    // Recognize the same dispositions `hasFreshDisposition` accepts on a
    // resolved thread (the gate that already decided this thread blocks): a
    // `**Accepted**`/`**Rejected**` marker OR the terminal
    // `**Rejection confirmed by maintainer**` marker, anchored by effective
    // activity (`updatedAt`-preferring) so an edited disposition is dated
    // consistently. The thread is already known resolved here.
    const threadDispositionAt = maxIsoTimestamp(
      nodes
        .filter(
          (comment) =>
            iddAgentLogins.has(
              String(comment.author?.login ?? '')
                .trim()
                .toLowerCase(),
            ) &&
            (isDispositionComment({ body: String(comment.body ?? '') }) ||
              isRejectionConfirmedDisposition({
                body: String(comment.body ?? ''),
              })),
        )
        .map((comment) => effectiveThreadCommentActivityAt(comment))
        .filter(isValidIsoTimestamp),
    );
    if (!threadDispositionAt) {
      return false;
    }
    // The blocking activity is external feedback newer than BOTH the snapshot
    // boundary (so it actually re-blocks the gate) AND the thread disposition
    // (so already-dispositioned feedback predating the ack does not disqualify
    // the signal). When the disposition lands after the boundary, the
    // post-disposition bound is what isolates the genuine ack.
    const postDispositionBlockingFeedback = nodes.filter((comment) => {
      const authorLogin = String(comment.author?.login ?? '')
        .trim()
        .toLowerCase();
      if (
        !authorLogin ||
        iddAgentLogins.has(authorLogin) ||
        authorLogin === prAuthorLogin
      ) {
        return false;
      }
      const activityAt = effectiveThreadCommentActivityAt(comment);
      return (
        isValidIsoTimestamp(activityAt) &&
        compareIsoTimestamps(activityAt, snapshotBoundaryAt) > 0 &&
        compareIsoTimestamps(activityAt, threadDispositionAt) > 0
      );
    });
    if (postDispositionBlockingFeedback.length === 0) {
      return false;
    }
    // Each remaining item must be a pure advisory-bot courtesy ack: an
    // advisory-bot author whose body is neither a `**Accepted**`/`**Rejected**`
    // marker nor the terminal `**Rejection confirmed by maintainer**` marker.
    return postDispositionBlockingFeedback.every(
      (comment) =>
        isConfiguredAdvisoryBotLogin(
          comment.author?.login,
          advisoryBotLogins,
        ) &&
        !isDispositionComment({ body: String(comment.body ?? '') }) &&
        !isRejectionConfirmedDisposition({ body: String(comment.body ?? '') }),
    );
  };

  const missingThreads = (threads ?? [])
    .map((thread, index) => {
      const commentsInThread = thread.comments?.nodes ?? [];
      const hasExternalFeedback = commentsInThread.some((comment) => {
        const authorLogin = String(comment.author?.login ?? '')
          .trim()
          .toLowerCase();
        return (
          authorLogin &&
          !iddAgentLogins.has(authorLogin) &&
          authorLogin !== prAuthorLogin
        );
      });
      if (!hasExternalFeedback) {
        return null;
      }
      if (thread.comments?.pageInfo?.hasNextPage) {
        return {
          id: String(thread.id ?? '') || `thread-${index + 1}`,
          isResolved: Boolean(thread.isResolved),
          reason: 'incomplete-thread-comments',
          ackOnlyPostDisposition: false,
        };
      }
      if (
        hasFreshDisposition(thread, {
          isDispositionAuthor: (login) =>
            iddAgentLogins.has(
              String(login ?? '')
                .trim()
                .toLowerCase(),
            ),
        })
      ) {
        return null;
      }
      // E1 only snapshots UNRESOLVED non-awaiting threads, and E7 only requires
      // dispositions for snapshot items. A thread that is already resolved and
      // whose newest external feedback predates the review-snapshot boundary was
      // settled out-of-band (or resolved by the reviewer) and must not block; a
      // resolved thread with external feedback newer than the boundary (e.g.
      // freshly reopened) still requires a disposition.
      if (thread.isResolved && snapshotBoundaryAt) {
        const newestFeedbackAt = maxIsoTimestamp(
          commentsInThread
            .filter((comment) => {
              const authorLogin = String(comment.author?.login ?? '')
                .trim()
                .toLowerCase();
              return (
                authorLogin &&
                !iddAgentLogins.has(authorLogin) &&
                authorLogin !== prAuthorLogin
              );
            })
            .map((comment) => effectiveThreadCommentActivityAt(comment))
            .filter(isValidIsoTimestamp),
        );
        if (
          !newestFeedbackAt ||
          compareIsoTimestamps(newestFeedbackAt, snapshotBoundaryAt) <= 0
        ) {
          return null;
        }
      }
      return {
        id: String(thread.id ?? '') || `thread-${index + 1}`,
        isResolved: Boolean(thread.isResolved),
        reason: thread.isResolved
          ? 'missing-fresh-disposition'
          : 'unresolved-without-fresh-disposition',
        ackOnlyPostDisposition: isThreadAckOnlyPostDisposition(thread),
      };
    })
    .filter(Boolean) as DispositionEvidenceSummary['missingThreads'];

  const blockingCount = missingRegularComments.length + missingThreads.length;
  // #978: the sole blocking cause is post-disposition advisory-bot ack-only
  // activity. True only when something blocks AND every blocking item is an
  // ack-only-post-disposition resolved thread (no missing regular comments, no
  // non-ack thread). The guard implies missingThreads is non-empty, so `.every`
  // is never vacuously true.
  const soleCauseAckOnlyPostDisposition =
    blockingCount > 0 &&
    missingRegularComments.length === 0 &&
    missingThreads.every((entry) => entry.ackOnlyPostDisposition === true);
  return {
    route: blockingCount > 0 ? 'return-to-e1' : 'proceed',
    reason: blockingCount > 0 ? 'missing-disposition-evidence' : 'complete',
    blockingCount,
    missingRegularCommentCount: missingRegularComments.length,
    missingThreadCount: missingThreads.length,
    soleCauseAckOnlyPostDisposition,
    missingRegularComments,
    missingThreads,
  };
}

export function summarizeBranchReviewRequirements(
  branchRules: BranchRuleLike[] = [],
  branchProtection: BranchProtectionLike = {},
) {
  const requiredCheckNames = new Set<string>();
  const requiredReviewerLogins = new Set<string>();
  const requiredReviewerTeams = new Set<string>();
  const requiredReviewerRequirements: ReviewerRequirement[] = [];
  const classicBypassPullRequestUserLogins = new Set<string>();
  const classicBypassPullRequestTeamSlugs = new Set<string>();
  const classicBypassPullRequestAppSlugs = new Set<string>();

  let requiredApprovingReviewCount = 0;
  let requireCodeOwnerReview = false;
  let classicRequireCodeOwnerReview = false;
  let requiresConversationResolution = false;
  let requiredCheckSourcePinned = false;

  for (const rule of branchRules) {
    if (rule?.type === 'pull_request') {
      const parameters = rule.parameters ?? {};
      requiredApprovingReviewCount = Math.max(
        requiredApprovingReviewCount,
        Number(parameters.required_approving_review_count ?? 0) || 0,
      );
      requireCodeOwnerReview =
        requireCodeOwnerReview || Boolean(parameters.require_code_owner_review);
      requiresConversationResolution =
        requiresConversationResolution ||
        Boolean(parameters.required_review_thread_resolution);

      for (const reviewer of parameters.required_reviewers ?? []) {
        const requirement = extractRequiredReviewerRequirement(reviewer);
        if (!requirement.identity) {
          continue;
        }
        requiredReviewerRequirements.push(requirement);
        if (requirement.identity.includes('/')) {
          requiredReviewerTeams.add(requirement.identity);
        } else {
          requiredReviewerLogins.add(requirement.identity);
        }
      }
      continue;
    }

    if (rule?.type === 'required_status_checks') {
      const checkMetadata = summarizeRequiredCheckMetadata(
        rule.parameters ?? {},
      );
      requiredCheckSourcePinned =
        requiredCheckSourcePinned || checkMetadata.sourcePinned;
      for (const name of checkMetadata.names) {
        requiredCheckNames.add(name);
      }
      continue;
    }

    if (rule?.type === 'workflows') {
      requiredCheckSourcePinned = true;
    }
  }

  const protectionReviews =
    branchProtection.required_pull_request_reviews ?? {};
  classicRequireCodeOwnerReview =
    Boolean(protectionReviews.require_code_owner_reviews) ||
    Boolean(protectionReviews.require_code_owner_review);
  for (const user of protectionReviews.bypass_pull_request_allowances?.users ??
    []) {
    const login = typeof user === 'string' ? user : user?.login;
    for (const normalizedLogin of normalizeTrustedMarkerLogins([login])) {
      classicBypassPullRequestUserLogins.add(normalizedLogin);
    }
  }
  for (const team of protectionReviews.bypass_pull_request_allowances?.teams ??
    []) {
    const slug = typeof team === 'string' ? team : team?.slug;
    for (const normalizedSlug of normalizeTrustedMarkerLogins([slug])) {
      classicBypassPullRequestTeamSlugs.add(normalizedSlug);
    }
  }
  for (const app of protectionReviews.bypass_pull_request_allowances?.apps ??
    []) {
    const slug = typeof app === 'string' ? app : (app?.slug ?? app?.app_slug);
    for (const normalizedSlug of normalizeTrustedMarkerLogins([slug])) {
      classicBypassPullRequestAppSlugs.add(normalizedSlug);
    }
  }
  requiredApprovingReviewCount = Math.max(
    requiredApprovingReviewCount,
    Number(protectionReviews.required_approving_review_count ?? 0) || 0,
  );
  requireCodeOwnerReview =
    requireCodeOwnerReview || classicRequireCodeOwnerReview;
  requiresConversationResolution =
    requiresConversationResolution ||
    Boolean(branchProtection.required_conversation_resolution?.enabled);

  const protectionCheckMetadata = summarizeRequiredCheckMetadata(
    branchProtection.required_status_checks ?? {},
  );
  requiredCheckSourcePinned =
    requiredCheckSourcePinned || protectionCheckMetadata.sourcePinned;
  for (const name of protectionCheckMetadata.names) {
    requiredCheckNames.add(name);
  }

  return {
    requiredApprovingReviewCount,
    requireCodeOwnerReview,
    classicRequireCodeOwnerReview,
    classicBypassPullRequestUserLogins: [
      ...classicBypassPullRequestUserLogins,
    ].sort(),
    classicBypassPullRequestTeamSlugs: [
      ...classicBypassPullRequestTeamSlugs,
    ].sort(),
    classicBypassPullRequestAppSlugs: [
      ...classicBypassPullRequestAppSlugs,
    ].sort(),
    requiresConversationResolution,
    requiredCheckSourcePinned,
    requiredReviewerLogins: [...requiredReviewerLogins].sort(),
    requiredReviewerTeams: [...requiredReviewerTeams].sort(),
    requiredReviewerRequirements,
    requiredCheckNames: [...requiredCheckNames].sort(),
  };
}

export function summarizeRequiredChecks(
  checks: CheckLike[] = [],
  branchRules: BranchRuleLike[] = [],
  branchProtection: BranchProtectionLike = {},
  {
    waivers = null,
    waivableSelectors = null,
  }: {
    waivers?: { valid?: { checkSelector?: unknown }[] | null } | null;
    waivableSelectors?: { selector?: unknown; matchMode?: unknown }[] | null;
  } = {},
) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const requiredCheckNames = branchReviewRequirements.requiredCheckNames;
  const requiredCheckNameSet = new Set(requiredCheckNames);
  const validWaivers = waivers?.valid ?? [];
  const SUCCESS_STATES = new Set([
    'SUCCESS',
    'SKIPPED',
    'NEUTRAL',
    'NOT_APPLICABLE',
  ]);

  const normalizedChecks = checks.map((check) => {
    const name = String(check.name ?? '');
    const state = String(check.state ?? '').toUpperCase();
    const coveredByWaiver =
      !SUCCESS_STATES.has(state) &&
      validWaivers.some((w) =>
        matchCheckSelectorLocal(name, w.checkSelector),
      ) &&
      // The check must also sit on the policy's waivable surface. A
      // null/undefined list keeps the legacy behavior with no gate; an empty
      // configured list covers nothing.
      (!Array.isArray(waivableSelectors) ||
        isCheckNameConfiguredWaivable(name, waivableSelectors));
    return {
      name,
      state,
      completedAt: String(check.completedAt ?? ''),
      coveredByWaiver,
    };
  });

  const matchedRequiredChecks = normalizedChecks.filter((check) =>
    requiredCheckNameSet.has(check.name),
  );
  const presentNames = new Set(
    matchedRequiredChecks.map((check) => check.name),
  );
  const missingRequiredCheckNames = requiredCheckNames.filter(
    (name) => !presentNames.has(name),
  );

  let status = 'unknown';
  if (requiredCheckNames.length > 0) {
    const effectiveChecks = matchedRequiredChecks.map((c) =>
      c.coveredByWaiver ? { ...c, state: 'SKIPPED' } : c,
    );
    const ciClassification = classifyCiChecks(effectiveChecks);
    status =
      missingRequiredCheckNames.length > 0
        ? 'missing'
        : ciClassification.status;
    if (
      status === 'success' &&
      branchReviewRequirements.requiredCheckSourcePinned
    ) {
      status = 'unknown';
    }
  }

  return {
    status,
    noRequiredChecksConfigured:
      requiredCheckNames.length === 0 &&
      !branchReviewRequirements.requiredCheckSourcePinned,
    presentRunConclusion: resolvePresentRunConclusion(normalizedChecks),
    requiredCheckCount: requiredCheckNames.length,
    generatedRequiredCheckCount: matchedRequiredChecks.length,
    requiredChecksGenerated:
      requiredCheckNames.length > 0 && missingRequiredCheckNames.length === 0,
    requiredChecksPassing:
      requiredCheckNames.length > 0 && status === 'success',
    requiredCheckNames,
    missingRequiredCheckNames,
    checks: normalizedChecks.map((check) => ({
      name: check.name,
      state: check.state,
      completedAt: isValidIsoTimestamp(check.completedAt)
        ? check.completedAt
        : '',
      required: requiredCheckNameSet.has(check.name),
      ...(check.coveredByWaiver ? { coveredByWaiver: true } : {}),
    })),
  };
}

// Conclusion over *all* present check runs (waiver-covered runs count as
// skipped), used for the F2 fallback when no required checks are configured:
// an unprotected branch must not satisfy CI vacuously, so the gate inspects the
// real run conclusions instead.
function resolvePresentRunConclusion(
  normalizedChecks: {
    name: string;
    state: string;
    completedAt: string;
    coveredByWaiver: boolean;
  }[],
): string {
  if (normalizedChecks.length === 0) {
    return 'none';
  }
  const effective = normalizedChecks.map((check) =>
    check.coveredByWaiver ? { ...check, state: 'SKIPPED' } : check,
  );
  const { status } = classifyCiChecks(effective);
  if (status === 'success') {
    return 'all-passing';
  }
  if (status === 'pending') {
    return 'pending';
  }
  return 'some-failing';
}

export function resolveCodeownersForFiles(
  codeownersText: unknown,
  changedFiles: unknown[] = [],
) {
  const rules = parseCodeownersRules(codeownersText);
  return collectCodeownersForFiles(rules, changedFiles);
}

export function selectCodeownersText(payloads: unknown[] = []): string {
  for (const payload of payloads) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Object.hasOwn(payload, 'content')
    ) {
      continue;
    }
    const content = String(
      (payload as { content?: unknown }).content ?? '',
    ).replace(/\n/g, '');
    return Buffer.from(content, 'base64').toString('utf8');
  }
  return '';
}

function collectCodeownersForFiles(
  rules: CodeownersRule[],
  changedFiles: unknown[] = [],
) {
  const codeownerUsers = new Set<string>();
  const codeownerTeams = new Set<string>();
  const codeownerEmails = new Set<string>();
  const unmatchedFiles: string[] = [];

  for (const filePath of changedFiles) {
    const normalizedPath = String(filePath ?? '').replace(/^\/+/, '');
    if (!normalizedPath) {
      continue;
    }

    const owners = findCodeownersForPath(rules, normalizedPath);
    if (!owners) {
      unmatchedFiles.push(normalizedPath);
      continue;
    }
    if (!hasCodeownerOwners(owners)) {
      continue;
    }

    for (const owner of owners.users) {
      codeownerUsers.add(owner);
    }
    for (const owner of owners.teams) {
      codeownerTeams.add(owner);
    }
    for (const owner of owners.emails) {
      codeownerEmails.add(owner);
    }
  }

  return {
    ruleCount: rules.length,
    changedFileCount: changedFiles.length,
    unmatchedFiles,
    codeownerUserLogins: [...codeownerUsers].sort(),
    codeownerTeamSlugs: [...codeownerTeams].sort(),
    codeownerEmailAddresses: [...codeownerEmails].sort(),
  };
}

export function summarizeReviewerStates(
  reviews: ReviewLike[] = [],
  {
    reviewDecision = '',
    branchRules = [],
    branchRulesets = [],
    branchProtection = {},
    codeownersText = '',
    changedFiles = [],
    eligibleCodeownerUserLogins = null,
    advisoryBotLogins = [],
    prAuthorLogin = '',
    viewerLogin = '',
    viewerTeamSlugs = [],
    viewerAppSlug = '',
  }: {
    reviewDecision?: string | null;
    branchRules?: BranchRuleLike[];
    branchRulesets?: BranchRulesetLike[];
    branchProtection?: BranchProtectionLike;
    codeownersText?: string;
    changedFiles?: unknown[];
    eligibleCodeownerUserLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[];
    prAuthorLogin?: string | null;
    viewerLogin?: string | null;
    viewerTeamSlugs?: unknown[];
    viewerAppSlug?: string | null;
  } = {},
) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const requiredReviewerLogins = new Set(
    branchReviewRequirements.requiredReviewerLogins,
  );
  const advisoryBotLoginSet = new Set(
    normalizeTrustedMarkerLogins(advisoryBotLogins),
  );
  const codeownerRules = parseCodeownersRules(codeownersText);
  const codeowners = collectCodeownersForFiles(codeownerRules, changedFiles);
  const codeownerUsers = new Set(codeowners.codeownerUserLogins);
  const eligibleCodeownerUsers =
    eligibleCodeownerUserLogins === null
      ? codeownerUsers
      : new Set(
          normalizeTrustedMarkerLogins(eligibleCodeownerUserLogins).filter(
            (login) => codeownerUsers.has(login),
          ),
        );
  const normalizedReviewDecision = String(reviewDecision ?? '');

  const latestByAuthor = [...indexLatestGatingReviewsByAuthor(reviews).values()]
    .map((review) => {
      const login = String(review.author?.login ?? '')
        .trim()
        .toLowerCase();
      const isAdvisoryBot = isGateAdvisoryBotLogin(login, advisoryBotLoginSet);
      const isCodeowner = eligibleCodeownerUsers.has(login);
      const isRequiredReviewer = requiredReviewerLogins.has(login);
      return {
        login,
        state: String(review.state ?? ''),
        submittedAt: String(review.submittedAt ?? review.submitted_at ?? ''),
        isHuman: !isAdvisoryBot,
        isAdvisoryBot,
        isCodeowner,
        isRequiredReviewer,
      };
    })
    .sort((left, right) => left.login.localeCompare(right.login));

  const blockingChangesRequestedLogins = latestByAuthor
    .filter((review) => {
      return review.state === 'CHANGES_REQUESTED' && !review.isAdvisoryBot;
    })
    .map((review) => review.login);

  const humanApprovedCount = latestByAuthor.filter((review) => {
    return review.isHuman && review.state === 'APPROVED';
  }).length;
  const codeownerApproved = latestByAuthor.some((review) => {
    return review.isCodeowner && review.state === 'APPROVED';
  });
  const hasExplicitCodeownerMatches = changedFiles.some((filePath) => {
    const normalizedPath = String(filePath ?? '').replace(/^\/+/, '');
    if (!normalizedPath) {
      return false;
    }
    const owners = findCodeownersForPath(codeownerRules, normalizedPath);
    return !!owners && hasCodeownerOwners(owners);
  });
  const latestByLogin = new Map(
    latestByAuthor.map((review) => [review.login, review]),
  );
  const requiredReviewerApprovalsSatisfied =
    branchReviewRequirements.requiredReviewerRequirements.every(
      (requirement) => {
        if (
          requirement.filePatterns.length > 0 &&
          !changedFiles.some((filePath) => {
            return requirement.filePatterns.some((pattern) =>
              matchesCodeownersPattern(pattern, filePath),
            );
          })
        ) {
          return true;
        }
        if ((requirement.minimumApprovals ?? 0) <= 0) {
          return true;
        }
        if (normalizedReviewDecision === 'APPROVED') {
          return true;
        }
        if (requirement.identity.includes('/')) {
          return false;
        }
        return latestByLogin.get(requirement.identity)?.state === 'APPROVED';
      },
    );
  const codeownerSelfApproval = summarizeCodeownerSelfApproval({
    requireCodeOwnerReview: branchReviewRequirements.requireCodeOwnerReview,
    codeownerApprovalSatisfied:
      !branchReviewRequirements.requireCodeOwnerReview ||
      !hasExplicitCodeownerMatches ||
      codeownerApproved ||
      normalizedReviewDecision === 'APPROVED',
    hasExplicitCodeownerMatches,
    codeownerUserLogins: codeowners.codeownerUserLogins,
    eligibleCodeownerUserLogins:
      eligibleCodeownerUserLogins === null
        ? null
        : [...eligibleCodeownerUsers].sort(),
    codeownerTeamSlugs: codeowners.codeownerTeamSlugs,
    codeownerEmailAddresses: codeowners.codeownerEmailAddresses,
    prAuthorLogin,
    viewerLogin,
    viewerTeamSlugs,
    viewerAppSlug,
    branchRules,
    branchRulesets,
    classicRequireCodeOwnerReview:
      branchReviewRequirements.classicRequireCodeOwnerReview,
    classicBypassPullRequestUserLogins:
      branchReviewRequirements.classicBypassPullRequestUserLogins,
    classicBypassPullRequestTeamSlugs:
      branchReviewRequirements.classicBypassPullRequestTeamSlugs,
    classicBypassPullRequestAppSlugs:
      branchReviewRequirements.classicBypassPullRequestAppSlugs,
  });

  return {
    reviewDecision: normalizedReviewDecision,
    requiredApprovingReviewCount:
      branchReviewRequirements.requiredApprovingReviewCount,
    requireCodeOwnerReview: branchReviewRequirements.requireCodeOwnerReview,
    requiresConversationResolution:
      branchReviewRequirements.requiresConversationResolution,
    requiredReviewerLogins: branchReviewRequirements.requiredReviewerLogins,
    requiredReviewerTeams: branchReviewRequirements.requiredReviewerTeams,
    codeownerUserLogins: codeowners.codeownerUserLogins,
    codeownerTeamSlugs: codeowners.codeownerTeamSlugs,
    unmatchedCodeownerFiles: codeowners.unmatchedFiles,
    latestByAuthor,
    humanApprovedCount,
    requiredApprovalsSatisfied:
      requiredReviewerApprovalsSatisfied &&
      (normalizedReviewDecision === 'APPROVED' ||
        (!normalizedReviewDecision &&
          (branchReviewRequirements.requiredApprovingReviewCount === 0 ||
            humanApprovedCount >=
              branchReviewRequirements.requiredApprovingReviewCount))),
    codeownerApprovalSatisfied:
      !branchReviewRequirements.requireCodeOwnerReview ||
      !hasExplicitCodeownerMatches ||
      codeownerApproved ||
      normalizedReviewDecision === 'APPROVED',
    codeownerSelfApproval,
    humanChangesRequestedCount: blockingChangesRequestedLogins.length,
    blockingChangesRequestedLogins,
  };
}

function summarizeCodeownerSelfApproval({
  requireCodeOwnerReview,
  codeownerApprovalSatisfied,
  hasExplicitCodeownerMatches,
  codeownerUserLogins = [],
  eligibleCodeownerUserLogins = null,
  codeownerTeamSlugs = [],
  codeownerEmailAddresses = [],
  prAuthorLogin = '',
  viewerLogin = '',
  viewerTeamSlugs = [],
  viewerAppSlug = '',
  branchRules = [],
  branchRulesets = [],
  classicRequireCodeOwnerReview = false,
  classicBypassPullRequestUserLogins = [],
  classicBypassPullRequestTeamSlugs = [],
  classicBypassPullRequestAppSlugs = [],
}: {
  requireCodeOwnerReview: boolean;
  codeownerApprovalSatisfied: boolean;
  hasExplicitCodeownerMatches: boolean;
  codeownerUserLogins?: unknown[];
  eligibleCodeownerUserLogins?: unknown[] | null;
  codeownerTeamSlugs?: unknown[];
  codeownerEmailAddresses?: unknown[];
  prAuthorLogin?: string | null;
  viewerLogin?: string | null;
  viewerTeamSlugs?: unknown[];
  viewerAppSlug?: string | null;
  branchRules?: BranchRuleLike[];
  branchRulesets?: BranchRulesetLike[];
  classicRequireCodeOwnerReview?: boolean;
  classicBypassPullRequestUserLogins?: unknown[];
  classicBypassPullRequestTeamSlugs?: unknown[];
  classicBypassPullRequestAppSlugs?: unknown[];
}) {
  const normalizedAuthor = String(prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  const normalizedViewer = String(viewerLogin ?? '')
    .trim()
    .toLowerCase();
  const normalizedViewerAppSlug = String(viewerAppSlug ?? '')
    .trim()
    .toLowerCase();
  const normalizedViewerTeamSlugs =
    normalizeTrustedMarkerLogins(viewerTeamSlugs);
  const directCodeownerUserLogins =
    normalizeTrustedMarkerLogins(codeownerUserLogins);
  const eligibleDirectCodeownerUserLogins =
    eligibleCodeownerUserLogins === null
      ? directCodeownerUserLogins
      : normalizeTrustedMarkerLogins(eligibleCodeownerUserLogins).filter(
          (login) => directCodeownerUserLogins.includes(login),
        );
  const normalizedCodeownerTeamSlugs =
    normalizeTrustedMarkerLogins(codeownerTeamSlugs);
  const normalizedCodeownerEmailAddresses = normalizeTrustedMarkerLogins(
    codeownerEmailAddresses,
  );
  const classicBypassDetected = Boolean(
    Boolean(classicRequireCodeOwnerReview) &&
      ((normalizedViewer &&
        normalizeTrustedMarkerLogins(
          classicBypassPullRequestUserLogins,
        ).includes(normalizedViewer)) ||
        normalizedViewerTeamSlugs.some((slug) => {
          return normalizeTrustedMarkerLogins(
            classicBypassPullRequestTeamSlugs,
          ).includes(slug);
        }) ||
        (normalizedViewerAppSlug &&
          normalizeTrustedMarkerLogins(
            classicBypassPullRequestAppSlugs,
          ).includes(normalizedViewerAppSlug))),
  );
  const bypass = summarizeRulesetPullRequestBypass(branchRulesets, branchRules);
  const rulesetGateSatisfiedByBypass =
    bypass.relevantRulesetCount === 0 || bypass.detected;
  const classicGateSatisfiedByBypass =
    !classicRequireCodeOwnerReview || classicBypassDetected;
  const applicableBypassDetected =
    (bypass.detected || classicBypassDetected) &&
    rulesetGateSatisfiedByBypass &&
    classicGateSatisfiedByBypass;
  const applicableBypassMode = applicableBypassDetected
    ? bypass.detected
      ? bypass.mode
      : 'pull_request'
    : 'none';
  const base = {
    status: 'not_applicable',
    reason: 'codeowner-review-not-required',
    prAuthorLogin: normalizedAuthor,
    directCodeownerUserLogins,
    codeownerTeamSlugs: normalizedCodeownerTeamSlugs,
    requireCodeOwnerReview: Boolean(requireCodeOwnerReview),
    codeownerApprovalSatisfied: Boolean(codeownerApprovalSatisfied),
    bypassDetected: applicableBypassDetected,
    bypassMode: applicableBypassMode,
    currentUserCanBypass: bypass.currentUserCanBypass,
  };

  if (!requireCodeOwnerReview) {
    return base;
  }
  if (!hasExplicitCodeownerMatches) {
    return {
      ...base,
      reason: 'no-explicit-codeowner-match',
    };
  }
  if (codeownerApprovalSatisfied) {
    return {
      ...base,
      reason: 'codeowner-approval-satisfied',
    };
  }
  if (applicableBypassDetected) {
    return {
      ...base,
      status: 'clear',
      reason:
        applicableBypassMode === 'pull_request'
          ? 'pull-request-bypass-available'
          : 'ruleset-bypass-available',
    };
  }
  if (!normalizedAuthor) {
    return {
      ...base,
      status: 'possible_deadlock',
      reason: 'pr-author-unknown',
    };
  }

  const allDirectUsersAreAuthor =
    eligibleDirectCodeownerUserLogins.length > 0 &&
    eligibleDirectCodeownerUserLogins.every(
      (login) => login === normalizedAuthor,
    );
  const hasNonAuthorDirectUser = eligibleDirectCodeownerUserLogins.some(
    (login) => login !== normalizedAuthor,
  );

  if (hasNonAuthorDirectUser) {
    return {
      ...base,
      status: 'clear',
      reason: 'non-author-codeowner-available',
    };
  }
  if (normalizedCodeownerTeamSlugs.length > 0) {
    return {
      ...base,
      status: 'possible_deadlock',
      reason: 'team-codeowner-ambiguous',
    };
  }
  if (normalizedCodeownerEmailAddresses.length > 0) {
    return {
      ...base,
      status: 'possible_deadlock',
      reason: 'email-codeowner-ambiguous',
    };
  }
  if (allDirectUsersAreAuthor) {
    return {
      ...base,
      status: 'deadlock',
      reason:
        eligibleCodeownerUserLogins === null
          ? 'pr-author-is-only-direct-codeowner'
          : 'pr-author-is-only-eligible-direct-codeowner',
    };
  }

  return {
    ...base,
    status: 'possible_deadlock',
    reason: 'no-reviewable-codeowner-identity',
  };
}

function summarizeRulesetPullRequestBypass(
  branchRulesets: BranchRulesetLike[] = [],
  branchRules: BranchRuleLike[] = [],
) {
  const codeownerRulesetIds = new Set(
    (branchRules ?? [])
      .filter((rule) => {
        return (
          rule?.type === 'pull_request' &&
          Boolean(rule?.parameters?.require_code_owner_review)
        );
      })
      .map((rule) => Number.parseInt(String(rule?.ruleset_id ?? ''), 10))
      .filter(Number.isInteger),
  );
  const expectedRulesetCount = codeownerRulesetIds.size;
  const relevantRulesets = (branchRulesets ?? []).filter((ruleset) => {
    const rulesetId = Number.parseInt(
      String(ruleset?.id ?? ruleset?.ruleset_id ?? ''),
      10,
    );
    return codeownerRulesetIds.has(rulesetId);
  });
  const values = relevantRulesets
    .map((ruleset) => String(ruleset?.current_user_can_bypass ?? '').trim())
    .map((value) => {
      return ['always', 'exempt', 'never', 'pull_requests_only'].includes(value)
        ? value
        : 'unknown';
    })
    .filter(Boolean);
  let currentUserCanBypass = 'unknown';
  if (values.length > 1 && new Set(values).size > 1) {
    currentUserCanBypass = 'mixed';
  } else if (values.includes('exempt')) {
    currentUserCanBypass = 'exempt';
  } else if (values.includes('pull_requests_only')) {
    currentUserCanBypass = 'pull_requests_only';
  } else if (values.includes('always')) {
    currentUserCanBypass = 'always';
  } else if (values.includes('never')) {
    currentUserCanBypass = 'never';
  }
  const bypassValues = new Set(['always', 'exempt', 'pull_requests_only']);
  const detected =
    expectedRulesetCount > 0 &&
    relevantRulesets.length === expectedRulesetCount &&
    values.length === relevantRulesets.length &&
    values.every((value) => bypassValues.has(value));
  let mode = 'none';
  if (detected) {
    if (new Set(values).size > 1) {
      mode = 'mixed';
    } else if (values.includes('pull_requests_only')) {
      mode = 'pull_request';
    } else if (values.includes('always')) {
      mode = 'always';
    } else if (values.includes('exempt')) {
      mode = 'exempt';
    }
  }
  return {
    detected,
    mode,
    currentUserCanBypass,
    relevantRulesetCount: expectedRulesetCount,
  };
}

export function resolveRulesetDetailPath(
  owner: string,
  repo: string,
  rule: BranchRuleLike | null | undefined,
  rulesetId: unknown,
): string {
  const sourceType = String(
    rule?.ruleset_source_type ?? rule?.source_type ?? '',
  )
    .trim()
    .toLowerCase();
  if (sourceType === 'organization') {
    const source = String(rule?.ruleset_source ?? rule?.source ?? owner).trim();
    const org = source.split('/')[0] || owner;
    return `orgs/${encodeURIComponent(org)}/rulesets/${rulesetId}`;
  }
  if (sourceType === 'enterprise') {
    const source = String(rule?.ruleset_source ?? rule?.source ?? '').trim();
    const enterprise = source.split('/')[0];
    if (enterprise) {
      return `enterprises/${encodeURIComponent(enterprise)}/rulesets/${rulesetId}`;
    }
  }
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rulesets/${rulesetId}`;
}

/**
 * Build the `isForcedHandoffEnabled` gate shared by every claim-revalidation
 * path (resume routing, the merge-gate, and the write-side helpers).
 *
 * Semantics:
 *
 * - forced-handoff mode disabled → never honor;
 * - no open linked PR backs the claim (`expectedLinkedPrReferences` empty) →
 *   honor an `issue-only` (or any) handoff as before;
 * - an open linked PR backs the claim:
 *   - `issue-plus-pr` handoff → require `linkedPr` to match one of the
 *     expected PRs (unchanged behavior);
 *   - `issue-only` handoff → accept it IFF a `prFirstCommitAt` is supplied
 *     AND the handoff's `createdAt` is a valid ISO timestamp strictly before
 *     it (the handoff predates the PR, so the successor created the PR after
 *     taking over the issue). Any other `issue-only` handoff is rejected.
 *
 * The `prFirstCommitAt` parameter is the Part B extension (#1058). Callers
 * that do not pass it keep the original behavior byte-identical: an
 * `issue-only` handoff against a PR-backed claim is rejected.
 */
export function buildForcedHandoffEnableGate(options: {
  forcedHandoffEnabled: boolean;
  expectedLinkedPrReferences: Set<string>;
  prFirstCommitAt?: string | null;
}): (forcedHandoff: ParsedForcedHandoffMarker) => boolean {
  const { forcedHandoffEnabled, expectedLinkedPrReferences } = options;
  const prFirstCommitAt =
    typeof options.prFirstCommitAt === 'string' ? options.prFirstCommitAt : '';
  return (forcedHandoff: ParsedForcedHandoffMarker) => {
    if (!forcedHandoffEnabled) {
      return false;
    }
    if (expectedLinkedPrReferences.size === 0) {
      return true;
    }
    if (forcedHandoff.contextScope === 'issue-plus-pr') {
      return expectedLinkedPrReferences.has(
        normalizeLinkedPrReference(forcedHandoff.linkedPr),
      );
    }
    // issue-only handoff against a PR-backed claim: accept only when it
    // predates the PR's first commit (a robust ISO compare; either side
    // unparseable → fail closed = reject).
    return isStrictlyBeforeIso(forcedHandoff.createdAt, prFirstCommitAt);
  };
}

/**
 * Resolve the active claim for a write-side merge-gate revalidation, honoring
 * an operator-approved forced handoff while failing closed on
 * unauthorized/forged markers exactly as the Resume routing path does.
 *
 * This is the centralized, pure (no I/O) helper used by the write-side
 * helpers (disposition-non-review-notices, resolve-review-thread) so they no
 * longer ignore forced handoffs. It builds the same forced-handoff enable
 * gate as `summarizeClaimValidation` / `buildForcedHandoffEnabledGate`
 * (extended with the Part B time rule) and delegates the rest of the
 * fail-closed enforcement to `applyClaimEvent` rule 7.
 *
 * - `forcedHandoffEnabled` defaults to `false` (forced handoffs ignored).
 * - `expectedLinkedPrs` of `null`/empty marks an issue-scoped revalidation:
 *   an `issue-only` handoff is accepted (issue takeover). A non-empty set
 *   marks a PR-backed claim and applies the `issue-plus-pr` / `prFirstCommitAt`
 *   rules.
 * - `isAuthorizedForcedHandoff` defaults to an allowlist of ∅ ⇒ always false
 *   (every handoff is treated as unauthorized) when not supplied, so callers
 *   that forget to wire it fail closed.
 * - `requireAuthorMatchesForcedBy` defaults to `true` (the strict
 *   self-signed-hijack block used by Resume routing).
 */
export function resolveActiveClaimForWriteGate(
  events: CommentLike[],
  options: {
    isTrustedAuthor: (login: string) => boolean;
    forcedHandoffEnabled?: boolean;
    expectedLinkedPrs?: unknown[] | null;
    prFirstCommitAt?: string | null;
    isAuthorizedForcedHandoff?: (
      forcedBy: string,
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
    requireAuthorMatchesForcedBy?: boolean;
  },
): ParsedClaimMarker | null {
  const expectedLinkedPrReferences = new Set(
    (options.expectedLinkedPrs ?? [])
      .map((value) => normalizeLinkedPrReference(value))
      .filter(Boolean),
  );
  const isForcedHandoffEnabled = buildForcedHandoffEnableGate({
    forcedHandoffEnabled: options.forcedHandoffEnabled === true,
    expectedLinkedPrReferences,
    prFirstCommitAt: options.prFirstCommitAt ?? null,
  });
  return resolveActiveClaim(events, {
    isTrustedAuthor: options.isTrustedAuthor,
    isForcedHandoffEnabled,
    isAuthorizedForcedHandoff:
      typeof options.isAuthorizedForcedHandoff === 'function'
        ? options.isAuthorizedForcedHandoff
        : () => false,
    requireAuthorMatchesForcedBy: options.requireAuthorMatchesForcedBy ?? true,
  });
}

export function summarizeClaimValidation(
  claimEvents: CommentLike[] = [],
  options: {
    trustedMarkerLogins?: unknown[] | null;
    authorizedForcedHandoffLogins?: unknown[] | null;
    expectedLinkedPrs?: unknown[] | null;
    prFirstCommitAt?: string | null;
    expectedClaimId?: unknown;
    expectedAgentId?: unknown;
    isTrustedAuthor?: (login: string) => boolean;
    forcedHandoffEnabled?: boolean;
    isForcedHandoffEnabled?: (
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
    isAuthorizedForcedHandoff?: (
      forcedBy: string,
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
  } = {},
): ClaimValidationSummary {
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const authorizedForcedHandoffLogins = new Set(
    normalizeTrustedMarkerLogins(options.authorizedForcedHandoffLogins ?? []),
  );
  const expectedLinkedPrReferences = new Set(
    (options.expectedLinkedPrs ?? [])
      .map((value) => normalizeLinkedPrReference(value))
      .filter(Boolean),
  );
  const expectedClaimId = String(options.expectedClaimId ?? '').trim();
  const expectedAgentId = String(options.expectedAgentId ?? '').trim();
  const trustedAuthorPredicate =
    typeof options.isTrustedAuthor === 'function'
      ? options.isTrustedAuthor
      : (login: string) =>
          trustedMarkerLogins.has(
            String(login ?? '')
              .trim()
              .toLowerCase(),
          );

  const activeClaim = resolveActiveClaim(claimEvents, {
    isTrustedAuthor: trustedAuthorPredicate,
    isForcedHandoffEnabled:
      typeof options.isForcedHandoffEnabled === 'function'
        ? options.isForcedHandoffEnabled
        : buildForcedHandoffEnableGate({
            forcedHandoffEnabled: options.forcedHandoffEnabled === true,
            expectedLinkedPrReferences,
            prFirstCommitAt: options.prFirstCommitAt ?? null,
          }),
    isAuthorizedForcedHandoff:
      typeof options.isAuthorizedForcedHandoff === 'function'
        ? options.isAuthorizedForcedHandoff
        : (forcedBy: string) => {
            if (authorizedForcedHandoffLogins.size === 0) {
              return false;
            }
            return authorizedForcedHandoffLogins.has(
              String(forcedBy ?? '')
                .trim()
                .toLowerCase(),
            );
          },
  });

  let reason = 'match';
  if (!activeClaim) {
    reason = 'missing-active-claim';
  } else if (expectedClaimId && activeClaim.claimId !== expectedClaimId) {
    reason = 'claim-id-mismatch';
  } else if (expectedAgentId && activeClaim.agentId !== expectedAgentId) {
    reason = 'agent-id-mismatch';
  }

  return {
    expectedClaimId,
    expectedAgentId,
    activeClaimPresent: Boolean(activeClaim),
    activeClaim: {
      agentId: activeClaim?.agentId ?? '',
      claimId: activeClaim?.claimId ?? '',
      supersedes: activeClaim?.supersedes ?? '',
      branch: activeClaim?.branch ?? '',
      createdAt: activeClaim?.createdAt ?? '',
    },
    matchesExpectedClaim: reason === 'match',
    claimLost: reason !== 'match',
    reason,
  };
}

export function buildPreMergeReadinessSummary(
  {
    prHeadSha,
    comments = [],
    reviews = [],
    threads = [],
    checks = [],
    branchRules = [],
    branchRulesets = [],
    branchProtection = {},
    requestedReviewers = [],
    timelineEvents = [],
    claimEvents = [],
    changedFiles = [],
    codeownersText = '',
    eligibleCodeownerUserLogins = null,
    reviewDecision = '',
  }: {
    prHeadSha: string;
    comments?: CommentLike[];
    reviews?: ReviewLike[];
    threads?: ThreadLike[];
    checks?: CheckLike[];
    branchRules?: BranchRuleLike[];
    branchRulesets?: BranchRulesetLike[];
    branchProtection?: BranchProtectionLike;
    requestedReviewers?: RequestedReviewerLike[];
    timelineEvents?: TimelineEventLike[];
    claimEvents?: CommentLike[];
    changedFiles?: unknown[];
    codeownersText?: string;
    eligibleCodeownerUserLogins?: unknown[] | null;
    reviewDecision?: string | null;
  },
  options: {
    now?: string;
    trustedMarkerLogins?: unknown[] | null;
    iddAgentLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    advisoryBotLoginsSource?: unknown;
    prAuthorLogin?: string | null;
    expectedClaimId?: unknown;
    expectedAgentId?: unknown;
    viewerLogin?: string | null;
    viewerTeamSlugs?: unknown[];
    viewerAppSlug?: string | null;
    collaboratorTrustEnabled?: boolean;
    configuredTrustedActors?: unknown[] | null;
    forcedHandoffEnabled?: boolean;
    expectedLinkedPrs?: unknown[] | null;
    prFirstCommitAt?: string | null;
    authorizedForcedHandoffLogins?: unknown[] | null;
    isAuthorizedForcedHandoff?: (
      forcedBy: string,
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
    isForcedHandoffEnabled?: (
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
    activeClaimId?: unknown;
    includeDispositionEvidence?: boolean;
    requestCap?: number;
    pendingWindowMinutes?: number;
    settledWindowMinutes?: number;
    pollIntervalMinutes?: number;
    capExhaustedRoute?: string;
    primaryBotLogin?: string;
    waivableCheckSelectors?:
      | { selector?: unknown; matchMode?: unknown }[]
      | null;
    // Configured `ciGate.externalCheckWaivers.maxValidity` (ISO-8601 duration),
    // threaded to the consume-side waiver window check. Omitted by unit callers
    // (window check off); `collectPreMergeReadiness` always sources the policy
    // value (default `PT24H`).
    externalCheckWaiverMaxValidity?: string;
  } = {},
) {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  if (!/^[0-9a-f]{40}$/.test(String(prHeadSha ?? ''))) {
    throw new Error('prHeadSha must be a 40-character lowercase commit SHA');
  }

  const trustedMarkerLogins = normalizeTrustedMarkerLogins(
    options.trustedMarkerLogins ?? [],
  );
  const iddAgentLogins = normalizeTrustedMarkerLogins(
    options.iddAgentLogins ?? [],
  );
  const advisoryBotLogins = normalizeTrustedMarkerLogins(
    options.advisoryBotLogins ?? [],
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const liveSnapshot = buildActivitySnapshotSummary(
    {
      comments,
      reviews,
      threads,
      checks,
    },
    {
      trustedMarkerLogins,
      advisoryBotLogins,
      advisoryBotLoginsSource: options.advisoryBotLoginsSource,
      dispositionAuthorLogins: iddAgentLogins,
    },
  );
  const watermark = resolveLatestReviewWatermark(comments, {
    expectedClaimId: options.expectedClaimId,
    isTrustedAuthor: (login: string) =>
      trustedMarkerLogins.includes(
        String(login ?? '')
          .trim()
          .toLowerCase(),
      ),
  });
  const reviewCurrency = watermark
    ? diffReviewSnapshot(
        {
          headSha: watermark.headSha,
          maxActivityUpdatedAt: watermark.maxActivityUpdatedAt,
          totalItemCount: watermark.totalItemCount,
          latestPassingCiCompletedAt: watermark.latestCiCompletedAt,
        },
        {
          headSha: prHeadSha,
          ...liveSnapshot,
        },
      )
    : { route: 'return-to-e1', reason: 'missing-watermark' };
  const threadSummary = summarizeReviewThreadsForGate(threads, {
    iddAgentLogins,
    prAuthorLogin,
    requiresConversationResolution:
      branchReviewRequirements.requiresConversationResolution,
  });
  const unrepliedComments = summarizeRegularCommentsForGate(comments, {
    iddAgentLogins,
    advisoryBotLogins,
    trustedMarkerLogins,
    threads,
  });
  const reviewerStates = summarizeReviewerStates(reviews, {
    reviewDecision,
    branchRules,
    branchRulesets,
    branchProtection,
    codeownersText,
    changedFiles,
    eligibleCodeownerUserLogins,
    advisoryBotLogins,
    prAuthorLogin,
    viewerLogin: options.viewerLogin,
    viewerTeamSlugs: options.viewerTeamSlugs,
    viewerAppSlug: options.viewerAppSlug,
  });
  const advisoryWaitOptions = normalizeAdvisoryWaitRuntimeOptions(options);
  const advisoryWait = buildAdvisoryWaitSummary(
    {
      prHeadSha,
      reviews,
      requestedReviewers,
      timelineEvents,
      comments,
    },
    {
      now,
      ...advisoryWaitOptions,
      viewerLogin: options.viewerLogin,
      configuredTrustedActors: options.configuredTrustedActors,
      collaboratorTrustEnabled: options.collaboratorTrustEnabled,
      trustedMarkerLogins,
      primaryBotLogin: options.primaryBotLogin,
    },
  );
  const claim = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins,
    forcedHandoffEnabled: options.forcedHandoffEnabled === true,
    expectedLinkedPrs: options.expectedLinkedPrs ?? [],
    prFirstCommitAt: options.prFirstCommitAt ?? null,
    authorizedForcedHandoffLogins: options.authorizedForcedHandoffLogins,
    isAuthorizedForcedHandoff: options.isAuthorizedForcedHandoff,
    isForcedHandoffEnabled: options.isForcedHandoffEnabled,
    expectedClaimId: options.expectedClaimId,
    expectedAgentId: options.expectedAgentId,
  });
  const waivableCheckSelectors = options.waivableCheckSelectors ?? null;
  const waiverEvidence = summarizeExternalCheckWaivers(comments, {
    prHeadSha,
    activeClaimId: claim.activeClaim?.claimId ?? options.activeClaimId ?? '',
    trustedMarkerLogins,
    now,
    waivableSelectors: waivableCheckSelectors,
    maxValidity: options.externalCheckWaiverMaxValidity ?? '',
  });
  const ci = summarizeRequiredChecks(checks, branchRules, branchProtection, {
    waivers: waiverEvidence,
    waivableSelectors: waivableCheckSelectors,
  });

  const dispositionEvidence = options.includeDispositionEvidence
    ? summarizeDispositionEvidenceForGate(
        { comments, threads },
        {
          iddAgentLogins,
          advisoryBotLogins,
          trustedMarkerLogins,
          prAuthorLogin,
          snapshotBoundaryAt: watermark?.maxActivityUpdatedAt ?? null,
        },
      )
    : null;

  const summary: { dispositionEvidence?: DispositionEvidenceSummary } & Record<
    string,
    unknown
  > = {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    prHeadSha,
    now,
    reviewCurrency: {
      watermarkPresent: Boolean(watermark),
      watermark: {
        agentId: watermark?.agentId ?? '',
        claimId: watermark?.claimId ?? '',
        headSha: watermark?.headSha ?? '',
        maxActivityUpdatedAt: watermark?.maxActivityUpdatedAt ?? 'none',
        totalItemCount: watermark?.totalItemCount ?? 0,
        latestCiCompletedAt: watermark?.latestCiCompletedAt ?? 'none',
        createdAt: watermark?.createdAt ?? 'none',
      },
      live: {
        totalItemCount: liveSnapshot.totalItemCount,
        maxActivityUpdatedAt: liveSnapshot.maxActivityUpdatedAt,
        latestCiCompletedAt: liveSnapshot.latestCiCompletedAt,
        latestPassingCiCompletedAt: liveSnapshot.latestPassingCiCompletedAt,
        counts: liveSnapshot.counts,
        ackOnly: liveSnapshot.ackOnly,
        effective: liveSnapshot.effective,
      },
      comparisonRoute: reviewCurrency.route,
      comparisonReason: reviewCurrency.reason,
    },
    threads: {
      unresolvedCount: threads.filter((thread) => !thread.isResolved).length,
      actionableCount: threadSummary.actionableCount,
      awaitingReviewerCount: threadSummary.awaitingReviewerCount,
      amdBlockingCount: threadSummary.amdBlockingCount,
      conversationResolveAgentCount:
        threadSummary.conversationResolveAgentCount,
      conversationResolveAuthorCount:
        threadSummary.conversationResolveAuthorCount,
      classifications: threadSummary.classifications,
    },
    unrepliedComments,
    reviewerStates,
    advisoryWait: {
      outcome: advisoryWait.outcome,
      f3Outcome: advisoryWait.f3Outcome,
      lastCopilotCommit: advisoryWait.lastCopilotCommit,
      copilotPending: advisoryWait.copilotPending,
      copilotPendingCoversHead: advisoryWait.copilotPendingCoversHead,
      sameHeadMarkerPresent: advisoryWait.sameHeadMarkerPresent,
      earliestSameHeadAt: advisoryWait.earliestSameHeadAt,
      sameHeadMarkerCount: advisoryWait.sameHeadMarkerCount,
      requestMarkerCount: advisoryWait.requestMarkerCount,
      requestCap: advisoryWait.requestCap,
      pendingWindowMinutes: advisoryWait.pendingWindowMinutes,
      settledWindowMinutes: advisoryWait.settledWindowMinutes,
      pollIntervalMinutes: advisoryWait.pollIntervalMinutes,
      capExhaustedRoute: advisoryWait.capExhaustedRoute,
      elapsedMinutes: advisoryWait.elapsedMinutes,
    },
    ci,
    claim,
    waiverEvidence,
  };

  if (dispositionEvidence) {
    summary.dispositionEvidence = dispositionEvidence;
  }

  return summary;
}

function normalizeLiveStatusDigestFields(fields: LiveStatusDigestFields) {
  const normalized = {
    phase: normalizeDigestField(fields.phase, 'Phase'),
    claim: normalizeDigestField(fields.claim, 'Claim'),
    branch: normalizeDigestField(fields.branch, 'Branch'),
    lastChecked: normalizeDigestField(fields.lastChecked, 'Last checked'),
    openBlockers: normalizeDigestField(fields.openBlockers, 'Open blockers'),
    nextAction: normalizeDigestField(fields.nextAction, 'Next action'),
    authoritativeBy: normalizeDigestField(
      fields.authoritativeBy,
      'Authoritative by',
    ),
  };

  if (!isValidIsoTimestamp(normalized.lastChecked)) {
    throw new Error('Last checked must be an ISO 8601 UTC timestamp');
  }

  return normalized;
}

function normalizeDigestField(value: unknown, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function escapeMarkdownTableCell(value: unknown): string {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, '<br>');
}

function firstLine(value: unknown): string {
  return String(value)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/, 1)[0]
    .trimEnd();
}

function sameDigestBody(currentBody: string, nextBody: string): boolean {
  return currentBody.trimEnd() === nextBody.trimEnd();
}

export function isStaleAt(
  activeCreatedAt: string,
  nextCreatedAt: string,
): boolean {
  const staleMs = 24 * 60 * 60 * 1000;
  return (
    new Date(nextCreatedAt).getTime() - new Date(activeCreatedAt).getTime() >=
    staleMs
  );
}

function compareClaimIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function createdAtToTime(createdAt: string | null | undefined): number | null {
  const time = new Date(createdAt ?? '').getTime();
  return Number.isFinite(time) ? time : null;
}

function createdAtToSecond(
  createdAt: string | null | undefined,
): number | null {
  const time = createdAtToTime(createdAt);
  if (time === null) {
    return null;
  }
  return Math.floor(time / 1000);
}

/**
 * Robust ISO timestamp comparison: returns true only when both `left` and
 * `right` parse to valid instants and `left` is strictly before `right`. If
 * either side is missing or unparseable, returns false (fail closed). Used by
 * the forced-handoff enable gate to decide whether an `issue-only` handoff
 * predates a PR's first commit.
 */
function isStrictlyBeforeIso(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftTime = createdAtToTime(left);
  const rightTime = createdAtToTime(right);
  if (leftTime === null || rightTime === null) {
    return false;
  }
  return leftTime < rightTime;
}

export function resolveActiveClaim(
  events: CommentLike[],
  isTrustedAuthor: ClaimResolutionOptions | ((login: string) => boolean) = () =>
    true,
): ParsedClaimMarker | null {
  const options = normalizeClaimResolutionOptions(isTrustedAuthor);
  const orderedEvents = events
    .map((event, index) => {
      const claim = parseClaimComment(event.body ?? '', event.createdAt ?? '');
      return {
        event,
        index,
        claimId: claim?.claimId ?? null,
        time: createdAtToTime(event.createdAt),
        second: createdAtToSecond(event.createdAt),
      };
    })
    .sort((left, right) => {
      if (
        left.second !== null &&
        right.second !== null &&
        left.second !== right.second
      ) {
        return left.second - right.second;
      }
      if (left.second !== null && right.second === null) {
        return -1;
      }
      if (left.second === null && right.second !== null) {
        return 1;
      }

      if (
        left.second !== null &&
        right.second !== null &&
        left.claimId &&
        right.claimId &&
        left.claimId !== right.claimId
      ) {
        return compareClaimIds(left.claimId, right.claimId);
      }

      if (
        left.time !== null &&
        right.time !== null &&
        left.time !== right.time
      ) {
        return left.time - right.time;
      }

      return left.index - right.index;
    })
    .map(({ event }) => event);

  let active: ParsedClaimMarker | null = null;
  for (const event of orderedEvents) {
    active = applyClaimEvent(active, event, options);
  }
  return active;
}

export function applyClaimEvent(
  activeClaim: ParsedClaimMarker | null,
  event: CommentLike,
  options: ClaimResolutionOptions | ((login: string) => boolean) = {},
): ParsedClaimMarker | null {
  const normalizedOptions = normalizeClaimResolutionOptions(options);
  const authorLogin = event.author?.login ?? '';
  if (!normalizedOptions.isTrustedAuthor(authorLogin)) {
    return activeClaim;
  }

  const claim = parseClaimComment(event.body ?? '', event.createdAt ?? '');
  if (claim) {
    if (!activeClaim) {
      return claim.supersedes === 'none' ? claim : null;
    }

    if (
      claim.agentId === activeClaim.agentId &&
      claim.claimId === activeClaim.claimId
    ) {
      // Enforce the heartbeat branch invariant (idd-claim.instructions.md
      // rule 3.5): a heartbeat candidate whose {branch} does not exactly
      // match the active claim's {branch} is anomalous and must not
      // refresh the stale clock. Without this guard, a spurious heartbeat
      // could extend the stale clock indefinitely and block the 24h
      // stale-takeover recovery path that audit-pr-cleanup depends on.
      if (claim.branch !== activeClaim.branch) {
        normalizedOptions.onAnomalousHeartbeat({
          agentId: claim.agentId,
          claimId: claim.claimId,
          activeBranch: activeClaim.branch,
          heartbeatBranch: claim.branch,
          createdAt: event.createdAt,
        });
        return activeClaim;
      }
      return {
        ...activeClaim,
        createdAt: event.createdAt ?? activeClaim.createdAt,
      };
    }

    if (
      claim.supersedes === activeClaim.claimId &&
      normalizedOptions.isStale(activeClaim.createdAt, event.createdAt ?? '')
    ) {
      return claim;
    }

    return activeClaim;
  }

  const release = parseReleaseComment(event.body ?? '');
  if (
    release &&
    activeClaim &&
    release.agentId === activeClaim.agentId &&
    release.claimId === activeClaim.claimId
  ) {
    return null;
  }

  const forcedHandoff = parseForcedHandoffComment(
    event.body ?? '',
    event.createdAt ?? '',
  );
  if (
    forcedHandoff &&
    activeClaim &&
    forcedHandoff.oldAgentId === activeClaim.agentId &&
    forcedHandoff.oldClaimId === activeClaim.claimId &&
    forcedHandoff.branch === activeClaim.branch
  ) {
    if (!normalizedOptions.isForcedHandoffEnabled(forcedHandoff, event)) {
      normalizedOptions.onIgnoredForcedHandoff({
        reason: 'mode-disabled',
        forcedHandoff,
        event,
      });
      return activeClaim;
    }
    // Optional: bind the asserted forcedBy identity to the comment
    // author so a trusted-marker actor cannot self-attest a handoff by
    // naming an unrelated maintainer in the payload. This is the
    // strict mode used by the Resume routing path (idd-claim.instructions.md
    // rule 7). The default is off because production forced-handoff
    // markers can be posted on behalf of a maintainer by a separate
    // automation account; callers that want the strict binding (e.g.
    // resume-claim-routing.mjs) opt in via `requireAuthorMatchesForcedBy`.
    if (normalizedOptions.requireAuthorMatchesForcedBy) {
      const authorLoginLower = String(authorLogin).trim().toLowerCase();
      const forcedByLower = String(forcedHandoff.forcedBy ?? '')
        .trim()
        .toLowerCase();
      if (!authorLoginLower || authorLoginLower !== forcedByLower) {
        normalizedOptions.onIgnoredForcedHandoff({
          reason: 'author-forced-by-mismatch',
          forcedHandoff,
          event,
        });
        return activeClaim;
      }
    }
    if (
      !normalizedOptions.isAuthorizedForcedHandoff(
        forcedHandoff.forcedBy,
        forcedHandoff,
        event,
      )
    ) {
      normalizedOptions.onIgnoredForcedHandoff({
        reason: 'forced-by-unauthorized',
        forcedHandoff,
        event,
      });
      return activeClaim;
    }
    return {
      agentId: forcedHandoff.newAgentId,
      claimId: forcedHandoff.newClaimId,
      supersedes: forcedHandoff.oldClaimId,
      branch: forcedHandoff.branch,
      createdAt: forcedHandoff.createdAt ?? activeClaim.createdAt,
    };
  }

  return activeClaim;
}

function normalizeClaimResolutionOptions(
  optionsOrPredicate:
    | ClaimResolutionOptions
    | ((login: string) => boolean)
    | null
    | undefined,
): NormalizedClaimResolutionOptions {
  if (typeof optionsOrPredicate === 'function') {
    return {
      isTrustedAuthor: optionsOrPredicate,
      isForcedHandoffEnabled: () => false,
      isAuthorizedForcedHandoff: () => false,
      isStale: isStaleAt,
      requireAuthorMatchesForcedBy: false,
      onAnomalousHeartbeat: () => {},
      onIgnoredForcedHandoff: () => {},
    };
  }

  const options = optionsOrPredicate ?? {};
  return {
    isTrustedAuthor:
      typeof options.isTrustedAuthor === 'function'
        ? options.isTrustedAuthor
        : () => true,
    isForcedHandoffEnabled:
      typeof options.isForcedHandoffEnabled === 'function'
        ? options.isForcedHandoffEnabled
        : () => false,
    isAuthorizedForcedHandoff:
      typeof options.isAuthorizedForcedHandoff === 'function'
        ? options.isAuthorizedForcedHandoff
        : () => false,
    isStale:
      typeof options.isStale === 'function' ? options.isStale : isStaleAt,
    requireAuthorMatchesForcedBy: Boolean(options.requireAuthorMatchesForcedBy),
    onAnomalousHeartbeat:
      typeof options.onAnomalousHeartbeat === 'function'
        ? options.onAnomalousHeartbeat
        : () => {},
    onIgnoredForcedHandoff:
      typeof options.onIgnoredForcedHandoff === 'function'
        ? options.onIgnoredForcedHandoff
        : () => {},
  };
}

function normalizeNonWhitespaceToken(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    /\s/.test(trimmed) ||
    trimmed.includes('<!--') ||
    trimmed.includes('-->')
  ) {
    return '';
  }
  return trimmed;
}

function pickPayloadValue(
  payload: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) {
      return payload[key];
    }
  }
  return undefined;
}

function hasConflictingPayloadAliases(
  payload: Record<string, unknown>,
  firstKey: string,
  secondKey: string,
): boolean {
  if (!Object.hasOwn(payload, firstKey) || !Object.hasOwn(payload, secondKey)) {
    return false;
  }

  return (
    String(payload[firstKey] ?? '').trim() !==
    String(payload[secondKey] ?? '').trim()
  );
}

function normalizeBranchToken(value: unknown): string {
  const token = normalizeNonWhitespaceToken(value);
  if (!token || token.includes('>')) {
    return '';
  }
  return token;
}

function normalizeForcedHandoffReason(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.includes('-->')) {
    return '';
  }
  return trimmed;
}

export function normalizeLinkedPrReference(value: unknown): string {
  const token = String(value ?? '').trim();
  if (!token) {
    return '';
  }
  if (/^#?[1-9]\d*$/.test(token)) {
    return token.replace(/^#/, '');
  }
  try {
    const parsed = new URL(token);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return token.toLowerCase();
    }
    if (hostname !== 'github.com' && hostname !== 'www.github.com') {
      return token.toLowerCase();
    }
    const pathMatch = parsed.pathname.match(
      /^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/i,
    );
    if (pathMatch) {
      return pathMatch[1];
    }
  } catch {
    // Not a URL-form linked-pr reference.
  }
  return token.toLowerCase();
}

function normalizeIsoTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || !isValidIsoTimestamp(trimmed)) {
    return '';
  }
  return trimmed;
}

function normalizeSecondPrecisionIsoTimestamp(value: unknown): string {
  const timestamp = normalizeIsoTimestamp(value);
  if (!timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
    return '';
  }
  return timestamp;
}

function normalizeContextScope(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return FORCED_HANDOFF_CONTEXT_SCOPES.has(trimmed) ? trimmed : '';
}

function normalizeLinkedPr(value: unknown): string {
  const token = normalizeNonWhitespaceToken(value);
  if (!token || !FORCED_HANDOFF_LINKED_PR_PATTERN.test(token)) {
    return '';
  }
  return token;
}

export function classifyResumeRoutingCase(
  input: {
    displacedByForcedHandoff?: boolean;
    hasActiveClaim?: boolean;
    claimOwnedBySession?: boolean;
    rebaseInProgress?: boolean;
    worktreeDirty?: boolean;
    hasUsableForcedHandoffEvidence?: boolean;
    claimAgeHours: number;
    latestActivityAgeMinutes: number;
    ciState?: string | null;
  },
  options: {
    staleHours?: number;
    stallMinutes?: number;
    pendingCiStates?: string[] | null;
    terminalSafeCiStates?: string[] | null;
  } = {},
): RouteDecision {
  const staleHours = Number.isFinite(options.staleHours)
    ? (options.staleHours as number)
    : 24;
  const stallMinutes = Number.isFinite(options.stallMinutes)
    ? (options.stallMinutes as number)
    : 30;
  const pendingCiStates = new Set(
    options.pendingCiStates ?? ['queued', 'in_progress', 'waiting', 'pending'],
  );
  const terminalSafeCiStates = new Set(
    options.terminalSafeCiStates ?? ['success', 'none'],
  );

  if (input.displacedByForcedHandoff) {
    return {
      route: 'claim-lost-stop',
      reason: 'session was displaced by trusted forced-handoff evidence',
    };
  }

  if (!input.hasActiveClaim) {
    return {
      route: 'unclaimed-reclaim-required',
      reason: 'resume requires a fresh claim before continuation',
    };
  }

  if (input.claimOwnedBySession) {
    if (input.rebaseInProgress || input.worktreeDirty) {
      return {
        route: 'crash-recovery',
        reason: 'owned claim with interrupted local state',
      };
    }
    return {
      route: 'ordinary-continuation',
      reason: 'owned claim with clean local state',
    };
  }

  if (input.hasUsableForcedHandoffEvidence) {
    return {
      route: 'forced-handoff-recovery',
      reason:
        'trusted forced-handoff evidence takes precedence over stalled-session takeover',
    };
  }

  if (!Number.isFinite(input.claimAgeHours)) {
    return {
      route: 'hold-for-evidence',
      reason: 'claim age is missing for a non-owned claim',
    };
  }

  if (!Number.isFinite(input.latestActivityAgeMinutes)) {
    return {
      route: 'hold-for-evidence',
      reason: 'activity age is missing for a non-owned active claim',
    };
  }

  const ciState = String(input.ciState ?? 'none').toLowerCase();
  if (pendingCiStates.has(ciState)) {
    return {
      route: 'hold-for-evidence',
      reason: 'CI is still pending for the active non-owned claim',
    };
  }
  if (!terminalSafeCiStates.has(ciState)) {
    return {
      route: 'hold-for-evidence',
      reason: 'CI is not in a terminal-safe state for stalled-claim recovery',
    };
  }

  if (input.claimAgeHours < staleHours) {
    if (input.latestActivityAgeMinutes >= stallMinutes) {
      return {
        route: 'hold-for-evidence',
        reason: `non-owned claim is fresh and idle for >= ${stallMinutes}m, but still non-inheritable`,
      };
    }
    return {
      route: 'hold-for-evidence',
      reason: 'non-owned claim remains non-inheritable until stale',
    };
  }

  if (input.latestActivityAgeMinutes < stallMinutes) {
    return {
      route: 'hold-for-evidence',
      reason: `non-owned claim is stale but quiet-window evidence is < ${stallMinutes}m`,
    };
  }

  return {
    route: 'stale-claim-takeover',
    reason: `non-owned claim is stale at >= ${staleHours}h with quiet-window evidence >= ${stallMinutes}m`,
  };
}

function hasExplicitDispositionAfter(
  targetComment: CommentLike,
  comments: CommentLike[],
  options: { isDispositionAuthor?: (login: string) => boolean } = {},
): boolean {
  // Default accepts any non-bot human; an IDD-scoped predicate (when supplied)
  // restricts the disposition author so a reviewer-authored marker does not
  // count as a completed IDD disposition.
  const isDispositionAuthor =
    typeof options.isDispositionAuthor === 'function'
      ? options.isDispositionAuthor
      : (login: string) => !isKnownReviewBot(login);
  const targetTime = Date.parse(targetComment.createdAt ?? '');
  return comments.some((comment) => {
    const author = String(comment.author?.login ?? '')
      .trim()
      .toLowerCase();
    if (!isDispositionAuthor(author) || !isDispositionComment(comment)) {
      return false;
    }
    if (!/\bCodeRabbit\b/i.test(comment.body ?? '')) {
      return false;
    }
    const dispositionTime = Date.parse(comment.createdAt ?? '');
    return (
      Number.isFinite(targetTime) &&
      Number.isFinite(dispositionTime) &&
      dispositionTime > targetTime
    );
  });
}

function normalizeGatingReviewTimestamp(
  review: ReviewLike,
  state: string,
): string | null {
  const submittedAt = String(review.submittedAt ?? review.submitted_at ?? '');
  if (isValidIsoTimestamp(submittedAt)) {
    return submittedAt;
  }
  if (
    state !== 'APPROVED' &&
    state !== 'CHANGES_REQUESTED' &&
    state !== 'DISMISSED'
  ) {
    return null;
  }
  const updatedAt = String(review.updatedAt ?? review.updated_at ?? '');
  if (isValidIsoTimestamp(updatedAt)) {
    return updatedAt;
  }
  return null;
}

function maxIsoTimestamp(values: unknown[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    const normalized = String(value);
    if (!isValidIsoTimestamp(normalized)) {
      continue;
    }
    if (!latest || compareIsoTimestamps(normalized, latest) > 0) {
      latest = normalized;
    }
  }
  return latest;
}

function summarizeRequiredCheckMetadata(
  parameters: RequiredCheckParametersLike,
) {
  const names = new Set<string>();
  let sourcePinned = false;
  const rawChecks = [
    ...(parameters.required_status_checks ?? []),
    ...(parameters.required_checks ?? []),
    ...(parameters.checks ?? []),
    ...(parameters.contexts ?? []),
  ];

  for (const rawCheck of rawChecks) {
    if (typeof rawCheck === 'string') {
      if (rawCheck.trim()) {
        names.add(rawCheck.trim());
      }
      continue;
    }

    if (
      isSourcePinnedRequirementId(rawCheck?.app_id) ||
      isSourcePinnedRequirementId(rawCheck?.integration_id) ||
      rawCheck?.source
    ) {
      sourcePinned = true;
    }

    for (const candidate of [
      rawCheck?.context,
      rawCheck?.name,
      rawCheck?.check,
      rawCheck?.integration_id ? rawCheck?.name : '',
    ]) {
      const normalized = String(candidate ?? '').trim();
      if (normalized) {
        names.add(normalized);
        break;
      }
    }
  }

  return {
    names: [...names].sort(),
    sourcePinned,
  };
}

function extractRequiredReviewerRequirement(
  reviewer: RequiredReviewerLike,
): ReviewerRequirement {
  const record = typeof reviewer === 'string' ? undefined : reviewer;
  const reviewerRef = record?.reviewer ?? {};
  const reviewerType = String(reviewerRef.type ?? record?.type ?? '')
    .trim()
    .toLowerCase();
  const reviewerId = String(reviewerRef.id ?? record?.id ?? '').trim();
  let candidate =
    typeof reviewer === 'string'
      ? reviewer
      : (record?.login ??
        reviewerRef.login ??
        record?.slug ??
        record?.team ??
        reviewerRef.slug ??
        reviewerRef.team ??
        reviewerRef.name ??
        '');
  if (!candidate && reviewerType && reviewerId) {
    candidate = `${reviewerType}/${reviewerId}`;
  }
  return {
    identity: String(candidate ?? '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase(),
    minimumApprovals:
      Number(record?.minimum_approvals ?? record?.min_approvals ?? 1) || 0,
    filePatterns: (record?.file_patterns ?? record?.filePatterns ?? [])
      .map((pattern) => String(pattern ?? '').trim())
      .filter(Boolean),
  };
}

function parseCodeownersRules(codeownersText: unknown): CodeownersRule[] {
  return String(codeownersText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => {
      const tokens = tokenizeCodeownersLine(line);
      const pattern = tokens.shift() ?? '';
      const ownerTokens: string[] = [];
      for (const token of tokens) {
        if (token.startsWith('#')) {
          break;
        }
        ownerTokens.push(token);
      }
      const users = ownerTokens
        .filter((token) => /^@[^/\s#]+$/.test(token))
        .map((token) => token.slice(1).toLowerCase());
      const teams = ownerTokens
        .filter((token) => /^@[^/\s#]+\/[^/\s#]+$/.test(token))
        .map((token) => token.slice(1).toLowerCase());
      const emails = ownerTokens
        .filter((token) => /^[^@\s#][^\s#]*@[^\s#]+$/.test(token))
        .map((token) => token.toLowerCase());
      if (!pattern) {
        return null;
      }
      return { pattern, users, teams, emails };
    })
    .filter(Boolean) as CodeownersRule[];
}

function findCodeownersForPath(
  rules: CodeownersRule[],
  path: string,
): CodeownersRule | null {
  let latest: CodeownersRule | null = null;
  for (const rule of rules) {
    if (matchesCodeownersPattern(rule.pattern, path)) {
      latest = rule;
    }
  }
  return latest;
}

function matchesCodeownersPattern(pattern: unknown, path: unknown): boolean {
  const normalizedPattern = String(pattern ?? '').trim();
  const normalizedPath = String(path ?? '')
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
  if (!normalizedPattern || !normalizedPath) {
    return false;
  }

  let body = normalizedPattern;
  const anchored = body.startsWith('/');
  if (anchored) {
    body = body.slice(1);
  }
  const rawBody = body;
  const trailingSlashPattern = rawBody.endsWith('/');
  const lastSegment = rawBody.split('/').at(-1) ?? '';
  const anyDepthFromRoot = rawBody.startsWith('**/');
  const directoryLikePattern =
    !trailingSlashPattern &&
    !lastSegment.includes('*') &&
    !lastSegment.includes('?');

  if (trailingSlashPattern) {
    body = `${body}**`;
  }

  if (anyDepthFromRoot) {
    body = body.slice(3);
  }

  const slashAnchored =
    anchored ||
    (rawBody.includes('/') && !anyDepthFromRoot && !trailingSlashPattern);
  let source = anyDepthFromRoot || !slashAnchored ? '^(?:|.*\\/)' : '^';
  for (let index = 0; index < body.length; index += 1) {
    const triplet = body.slice(index, index + 3);
    const pair = body.slice(index, index + 2);
    if (triplet === '**/') {
      source += '(?:[^/]+/)*';
      index += 2;
      continue;
    }
    if (pair === '**') {
      source += '.*';
      index += 1;
      continue;
    }
    const character = body[index];
    if (character === '*') {
      source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(character);
  }
  if (directoryLikePattern) {
    source += '(?:/.*)?';
  }
  source += '$';

  return new RegExp(source).test(normalizedPath);
}

export function effectiveRegularCommentActivityAt(comment: {
  updatedAt?: unknown;
  createdAt: string;
}): string {
  const updatedAt = String(comment.updatedAt ?? '');
  if (
    isValidIsoTimestamp(updatedAt) &&
    compareIsoTimestamps(updatedAt, comment.createdAt) > 0
  ) {
    return updatedAt;
  }
  return comment.createdAt;
}

function isSourcePinnedRequirementId(value: unknown): boolean {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0;
}

function tokenizeCodeownersLine(line: unknown): string[] {
  const tokens: string[] = [];
  let current = '';
  let escaped = false;

  for (const character of String(line ?? '')) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === ' ' || character === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }

  if (escaped) {
    current += '\\';
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function hasCodeownerOwners(rule: CodeownersRule | null | undefined): boolean {
  return (
    (rule?.users?.length ?? 0) > 0 ||
    (rule?.teams?.length ?? 0) > 0 ||
    (rule?.emails?.length ?? 0) > 0
  );
}

// True when a PR-author login belongs to a gate-relevant advisory bot — a known
// review bot (CodeRabbit/Codex/Copilot defaults) or a configured
// `advisoryBotLogins` entry. The GitHub `[bot]` suffix is normalized
// symmetrically via `advisoryBotIdentityToken` on both the incoming login and
// each configured entry, so a custom bot matches whether the config or the
// author login stores the suffixed (`my-bot[bot]`) or suffixless (`my-bot`)
// form. Fail-closed on an empty token.
export function isGateAdvisoryBotLogin(
  login: unknown,
  advisoryBotLogins: Set<string>,
): boolean {
  const token = advisoryBotIdentityToken(login);
  if (!token) {
    return false;
  }
  return (
    isKnownReviewBot(token) ||
    isConfiguredAdvisoryBotLogin(login, advisoryBotLogins)
  );
}

// True when a login matches a **configured** `advisoryBotLogins` entry, with the
// GitHub `[bot]` suffix normalized symmetrically via `advisoryBotIdentityToken`
// on both the incoming login and each configured entry — so a custom bot matches
// whether either side stores the suffixed (`my-bot[bot]`) or suffixless
// (`my-bot`) form. Unlike `isGateAdvisoryBotLogin`, this does **not** also match
// `isKnownReviewBot`: the advisory courtesy-ack carve-outs must recognize only
// configured advisory bots, so a Copilot/known-review-bot ack is never
// reclassified as a configured-advisory-bot ack. Fail-closed on an empty token.
export function isConfiguredAdvisoryBotLogin(
  login: unknown,
  advisoryBotLogins: Set<string>,
): boolean {
  const token = advisoryBotIdentityToken(login);
  if (!token) {
    return false;
  }
  for (const configured of advisoryBotLogins) {
    if (advisoryBotIdentityToken(configured) === token) {
      return true;
    }
  }
  return false;
}

function _isOperationalOrDigestComment(body: string): boolean {
  return (
    operationalMarkerPrefix(body) !== null ||
    firstLine(body) === LIVE_STATUS_DIGEST_MARKER
  );
}

function isOperationalOrDigestCommentForGate(
  body: string,
  authorLogin: unknown,
  trustedMarkerLogins: Set<string>,
): boolean {
  const marker = operationalMarkerPrefix(body);
  if (marker === '<!-- forced-handoff:') {
    return trustedMarkerLogins.has(
      String(authorLogin ?? '')
        .trim()
        .toLowerCase(),
    );
  }
  return marker !== null || firstLine(body) === LIVE_STATUS_DIGEST_MARKER;
}

function isValidForcedHandoffOperationalMarker(body: string): boolean {
  return parseForcedHandoffComment(body, '') !== null;
}

function buildBodyPreview(body: unknown): string {
  return firstLine(String(body ?? '')).slice(0, 120);
}

function advisoryWaitMarkerMatchesHead(
  body: string,
  prHeadSha: string,
): boolean {
  return (
    new RegExp(`^advisory-wait: [^ ]+ ${escapeRegExp(prHeadSha)}(?: |$)`).test(
      body,
    ) ||
    new RegExp(
      `^advisory-wait-recovery: [^ ]+ ${escapeRegExp(prHeadSha)}(?: |$)`,
    ).test(body) ||
    new RegExp(
      `^<!-- advisory-wait: [^ ]+ ${escapeRegExp(prHeadSha)} [^ ]+ -->$`,
    ).test(body)
  );
}

function advisoryWaitRequestMarker(body: string): boolean {
  return /^advisory-wait:/.test(body) || /^<!-- advisory-wait:/.test(body);
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function minutesBetweenIso(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 60000);
}

export function compareIsoTimestamps(left: unknown, right: unknown): number {
  const leftComparable = normalizeComparableTimestamp(left);
  const rightComparable = normalizeComparableTimestamp(right);
  if (
    typeof leftComparable === 'number' &&
    typeof rightComparable === 'number'
  ) {
    if (leftComparable !== rightComparable) {
      return leftComparable - rightComparable;
    }
    return String(left ?? '').localeCompare(String(right ?? ''));
  }
  if (typeof leftComparable === 'number') {
    return 1;
  }
  if (typeof rightComparable === 'number') {
    return -1;
  }
  return String(left ?? '').localeCompare(String(right ?? ''));
}

function threadActivityAt(thread: ThreadLike): string | null | undefined {
  if (isValidIsoTimestamp(thread.updatedAt ?? '')) {
    return thread.updatedAt;
  }

  const commentTimes = (thread.comments?.nodes ?? [])
    .flatMap((comment) => [comment.updatedAt, comment.createdAt])
    .filter(isValidIsoTimestamp);

  return maxIsoTimestamp(commentTimes);
}

function effectiveThreadCommentActivityAt(
  comment:
    | { updatedAt?: string | null; createdAt?: string | null }
    | null
    | undefined,
): string {
  const updatedAt = String(comment?.updatedAt ?? '');
  if (isValidIsoTimestamp(updatedAt)) {
    return updatedAt;
  }
  const createdAt = String(comment?.createdAt ?? '');
  if (isValidIsoTimestamp(createdAt)) {
    return createdAt;
  }
  return '';
}

function hasCompletedBotThreadDispositions(
  threads: ThreadLike[],
  loginPredicate: (login: string) => boolean,
  options: { isDispositionAuthor?: (login: string) => boolean } = {},
): boolean {
  const botThreads = threads.filter((thread) => {
    return (thread.comments?.nodes ?? []).some((comment) => {
      return (
        loginPredicate(comment.author?.login ?? '') &&
        !isDispositionComment(comment)
      );
    });
  });

  return (
    botThreads.length > 0 &&
    botThreads.every((thread) => {
      return (
        thread.isResolved &&
        !thread.comments?.pageInfo?.hasNextPage &&
        hasFreshDisposition(thread, {
          isDispositionAuthor: options.isDispositionAuthor,
        })
      );
    })
  );
}

function hasUnresolvedKnownBotThreads(threads: ThreadLike[]): boolean {
  return threads.some((thread) => {
    if (thread.isResolved) {
      return false;
    }
    if (thread.comments?.pageInfo?.hasNextPage) {
      return true;
    }
    return (thread.comments?.nodes ?? []).some((comment) => {
      return isKnownReviewBot(comment.author?.login ?? '');
    });
  });
}

function isValidIsoTimestamp(value: unknown): value is string {
  const time = Date.parse(value as string);
  if (!Number.isFinite(time)) return false;
  const normalize = (ts: string) => ts.replace('.000Z', 'Z');
  return normalize(new Date(time).toISOString()) === normalize(value as string);
}

function isCompletedCiTimestamp(value: unknown): boolean {
  const timestamp = String(value ?? '');
  return timestamp !== '0001-01-01T00:00:00Z' && isValidIsoTimestamp(timestamp);
}

function normalizeComparableTimestamp(value: unknown): number | 'none' | null {
  const normalized = String(value ?? 'none');
  if (normalized === 'none') {
    return 'none';
  }
  if (!isValidIsoTimestamp(normalized)) {
    return null;
  }
  return Date.parse(normalized);
}
