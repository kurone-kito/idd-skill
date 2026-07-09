// idd-generated-from: src/scripts/marker-helpers.mts
//
// The scripts/marker-helpers.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Operational-marker rendering and parsing (wave 1 of the protocol-helpers
// split; see #1209): the render*/parse* functions for the claim, watermark,
// baseline, advisory-wait, forced-handoff, and external-check-waiver
// HTML-comment markers, plus the marker-field validation helpers they
// share. The protocol-helpers module re-exports every name below (a plain
// `export * from` re-export), so existing call sites are unaffected.
//
// Layering: this module MUST NOT import from protocol-helpers — that would
// form an import cycle, since protocol-helpers imports from here. Gate-level
// aggregation that folds many markers together with trust/policy context
// (summarizeExternalCheckWaivers, summarizeAdvisoryWaitMarkers,
// resolveLatestReviewWatermark, deriveIddAgentLogins, and friends) stays in
// protocol-helpers on purpose: those depend on the broader trusted-actor
// resolution machinery there (normalizeTrustedMarkerLogins and friends), and
// moving them here would force exactly that forbidden back-import. Only the
// single-marker parse/render primitives move in this wave.

/** Operational marker matcher entry. */
interface OperationalMarker {
  label: string;
  pattern: RegExp;
  startPattern?: RegExp;
  /**
   * Anchored at the same `^` position as `pattern`, with the same field
   * validation, but without the trailing `OPTIONAL_IDD_VISIBLE_NOTE_PATTERN`
   * group and `$` end anchor: matches whenever the body's first bytes are a
   * structurally valid marker token (see #1316), regardless of what -- if
   * anything -- follows. `detectMalformedOperationalMarker` uses the gap
   * between this and `pattern` to tell three cases apart:
   *   - `pattern` matches -> well-formed marker (token + optional single
   *     note, nothing more).
   *   - `pattern` fails but this matches -> marker-shaped prefix with
   *     content appended after the note (the malformed case this issue
   *     surfaces).
   *   - Neither matches -> not marker-shaped at all, including a marker
   *     merely quoted or embedded mid-prose (anti-spoofing: both patterns
   *     require the token to be the literal first bytes of the body, so a
   *     preamble before it defeats both).
   * Only defined for the note-bearing markers (`claimed-by`, `unclaimed-by`,
   * `review-watermark`, `review-baseline`); `advisory-wait`,
   * `forced-handoff`, and `idd-external-check-waiver` do not use the shared
   * note-optional grammar this field targets.
   */
  malformedPrefixPattern?: RegExp;
}

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

const ISO8601_UTC_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;
const OPTIONAL_IDD_VISIBLE_NOTE_PATTERN = String.raw`(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)`;

const OPERATIONAL_MARKERS: OperationalMarker[] = [
  {
    label: '<!-- claimed-by:',
    pattern:
      /^<!--\s*claimed-by:\s+\S+\s+\S+\s+supersedes:\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+branch:\s+[^\s>]+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    malformedPrefixPattern:
      /^<!--\s*claimed-by:\s+\S+\s+\S+\s+supersedes:\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+branch:\s+[^\s>]+\s*-->/i,
  },
  {
    label: '<!-- unclaimed-by:',
    pattern:
      /^<!--\s*unclaimed-by:\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    malformedPrefixPattern:
      /^<!--\s*unclaimed-by:\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->/i,
  },
  {
    label: '<!-- review-watermark:',
    pattern:
      /^<!--\s*review-watermark:\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+\S+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    malformedPrefixPattern:
      /^<!--\s*review-watermark:\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+\S+\s*-->/i,
  },
  {
    label: '<!-- review-baseline:',
    pattern:
      /^<!--\s*review-baseline:\s+\S+\s+\S+\s+\S+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    malformedPrefixPattern: /^<!--\s*review-baseline:\s+\S+\s+\S+\s+\S+\s*-->/i,
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

export const IDD_AGENT_DERIVED_MARKERS: ReadonlySet<string> = new Set([
  '<!-- claimed-by:',
  '<!-- unclaimed-by:',
  '<!-- review-watermark:',
  '<!-- review-baseline:',
  'advisory-wait:',
  'advisory-wait-recovery:',
  '<!-- advisory-wait:',
]);

const FORCED_HANDOFF_CONTEXT_SCOPES = new Set(['issue-only', 'issue-plus-pr']);
const FORCED_HANDOFF_LINKED_PR_PATTERN = /^(?:[1-9]\d*|https?:\/\/[^\s<>"]+)$/;

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

/**
 * Detects a `claimed-by` / `unclaimed-by` / `review-watermark` /
 * `review-baseline` comment whose body starts with a structurally valid
 * marker token (and, when present, a well-formed note) but carries content
 * appended after that -- for example a well-intentioned human rationale
 * tacked onto an otherwise-canonical claim comment. Such a body already
 * fails `operationalMarkerPrefix`'s whole-body anchor and is therefore
 * never treated as a live marker for state resolution (`parseClaimComment`,
 * `resolveActiveClaim`, and friends keep returning `null` / ignoring it,
 * unchanged by this function's existence); this gives a caller that wants
 * one a **distinct** "malformed marker" signal instead of the comment
 * silently reading as ordinary, unremarkable content (#1316).
 *
 * Returns the matching marker's `label` (e.g. `'<!-- claimed-by:'`) when the
 * body is malformed in that specific way, or `null` when the body is either
 * a well-formed marker (not malformed) or not marker-shaped at all.
 *
 * Anti-spoofing is preserved: like `pattern`, `malformedPrefixPattern`
 * anchors `^` at byte 0 with no leading-whitespace tolerance, so a marker
 * merely quoted or embedded mid-prose -- i.e. not literally the first bytes
 * of the body -- matches neither pattern and is never flagged here.
 */
export function detectMalformedOperationalMarker(body: string): string | null {
  if (operationalMarkerPrefix(body) !== null) {
    // Already a well-formed marker (or otherwise-recognized marker type) --
    // not malformed. Checking this first avoids double-classifying the
    // happy path that `parseClaimComment` and friends already handle.
    return null;
  }
  const marker = OPERATIONAL_MARKERS.find((candidate) =>
    candidate.malformedPrefixPattern?.test(body),
  );
  return marker ? marker.label : null;
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

function isValidForcedHandoffOperationalMarker(body: string): boolean {
  return parseForcedHandoffComment(body, '') !== null;
}

export function isValidIsoTimestamp(value: unknown): value is string {
  const time = Date.parse(value as string);
  if (!Number.isFinite(time)) return false;
  const normalize = (ts: string) => ts.replace('.000Z', 'Z');
  return normalize(new Date(time).toISOString()) === normalize(value as string);
}
