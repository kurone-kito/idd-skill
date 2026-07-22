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
const ISO8601_UTC_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;
const OPTIONAL_IDD_VISIBLE_NOTE_PATTERN = String.raw`(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)`;
const OPERATIONAL_MARKERS = [
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
    label: '<!-- activation-nonce:',
    pattern:
      /^<!--\s*activation-nonce:\s+\S+\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    malformedPrefixPattern:
      /^<!--\s*activation-nonce:\s+\S+\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->/i,
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
    // #1511: bounded same-HEAD advisory reroll request marker. PLAIN-TEXT,
    // same shape as advisory-wait: (no visible note), so it is excluded from
    // activity/currency/watermark computations exactly like advisory-wait /
    // advisory-wait-recovery already are -- otherwise the agent's own
    // reroll-request comment would pollute review-currency logic the same
    // way a stray bot ack would (see the ack-only-convergence rationale).
    // Deliberately a DISTINCT prefix from advisory-wait: so it never counts
    // toward REQUEST_CAP / REQUEST_MARKER_COUNT (separateness is a named
    // acceptance criterion of #1511).
    label: 'advisory-reroll:',
    pattern:
      /^advisory-reroll:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/,
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
export const IDD_AGENT_DERIVED_MARKERS = new Set([
  '<!-- claimed-by:',
  '<!-- unclaimed-by:',
  '<!-- activation-nonce:',
  '<!-- review-watermark:',
  '<!-- review-baseline:',
  'advisory-wait:',
  'advisory-wait-recovery:',
  '<!-- advisory-wait:',
  'advisory-reroll:',
]);
const FORCED_HANDOFF_CONTEXT_SCOPES = new Set(['issue-only', 'issue-plus-pr']);
const FORCED_HANDOFF_LINKED_PR_PATTERN = /^(?:[1-9]\d*|https?:\/\/[^\s<>"]+)$/;
export function parseClaimComment(body, createdAt) {
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
export function parseActivationNonceComment(body, createdAt) {
  const match = body
    .trimEnd()
    .match(
      new RegExp(
        `^<!--\\s*activation-nonce:\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(${ISO8601_UTC_PATTERN.source})\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
        'i',
      ),
    );
  if (!match || !isValidIsoTimestamp(match[4])) {
    return null;
  }
  return {
    agentId: match[1],
    claimId: match[2],
    nonce: match[3],
    createdAt,
  };
}
/**
 * Resolve the winning activation nonce among `events` for `claimId`: the
 * lexicographically earliest nonce (`.sort()`) among every trusted
 * `activation-nonce` marker parsed from `events` whose `claimId` matches.
 * This is a pure function of the observed nonce *set* (not post order or
 * timestamp), so two sessions that both activated the same claim-id compute
 * the identical winner once each has re-read the same trusted comment
 * stream (#1522). `events` must already be trust-filtered by the caller --
 * this function does no author checks of its own. Returns `null` when no
 * matching `activation-nonce` marker exists -- callers must treat that as
 * "no comparison possible," not a mismatch (#1522 AC3).
 */
export function findActivationNonceWinner(events, claimId) {
  const nonces = events
    .map((event) =>
      parseActivationNonceComment(event.body ?? '', event.createdAt ?? ''),
    )
    .filter((marker) => Boolean(marker) && marker?.claimId === claimId)
    .map((marker) => marker.nonce)
    .sort();
  return nonces.length > 0 ? nonces[0] : null;
}
export function parseReleaseComment(body) {
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
export function parseForcedHandoffComment(body, createdAt) {
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
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  return normalizeForcedHandoffPayload(payload, { createdAt });
}
export function normalizeForcedHandoffPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload;
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
export function renderForcedHandoffConsentNote(payload) {
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
export function renderForcedHandoffComment(payload) {
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
function normalizeExternalCheckWaiverField(value) {
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
function encodeExternalCheckWaiverField(value) {
  return encodeURIComponent(value);
}
function decodeExternalCheckWaiverField(value) {
  try {
    return decodeURIComponent(String(value ?? '').trim());
  } catch {
    return '';
  }
}
function renderExternalCheckWaiverNote(normalized) {
  const actor = normalizeNonWhitespaceToken(normalized.actor) || 'idd-operator';
  return [
    `_${actor}: external check waiver for IDD F phase on \`${normalized.checkSelector}\``,
    `until \`${normalized.expiresAt}\` (reason: ${normalized.reason})._`,
  ].join(' ');
}
export function renderExternalCheckWaiverComment(payload) {
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
function normalizeMarkerCount(value) {
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
function normalizeMarkerIsoOrNone(value) {
  const token = normalizeNonWhitespaceToken(value);
  if (token === '' || token === 'none') {
    return 'none';
  }
  return normalizeIsoTimestamp(token) || null;
}
export function renderClaimedByMarker(payload) {
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
export function renderActivationNonceMarker(payload) {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const nonce = normalizeNonWhitespaceToken(payload?.nonce);
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  if (!agentId || !claimId || !nonce || !timestamp) {
    throw new Error('invalid activation-nonce marker payload');
  }
  return [
    `<!-- activation-nonce: ${agentId} ${claimId} ${nonce} ${timestamp} -->`,
    '',
    `_${agentId}: claim activation nonce — IDD automation marker. Do not edit._`,
  ].join('\n');
}
export function renderReviewWatermarkMarker(payload) {
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
export function renderReviewBaselineMarker(payload) {
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
export function renderUnclaimedByMarker(payload) {
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
export function renderAdvisoryWaitMarker(payload) {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  if (!agentId || !/^[0-9a-f]{40}$/.test(headSha) || !timestamp) {
    throw new Error('invalid advisory-wait marker payload');
  }
  return `advisory-wait: ${agentId} ${headSha} ${timestamp}`;
}
export function renderAdvisoryWaitRecoveryMarker(payload) {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  if (!agentId || !/^[0-9a-f]{40}$/.test(headSha) || !timestamp) {
    throw new Error('invalid advisory-wait-recovery marker payload');
  }
  return `advisory-wait-recovery: ${agentId} ${headSha} ${timestamp}`;
}
// #1511: advisory-reroll is ALSO a PLAIN-TEXT marker (no visible note), same
// reasoning as advisory-wait/advisory-wait-recovery above -- AW6's recognizer
// anchors on `\s*$` with no trailing note. It carries the PR HEAD SHA (not a
// claim id), matching the advisory-wait family's shape exactly, since it is
// the same "which HEAD is this about" question, just for a distinct bounded
// budget kept separate from REQUEST_CAP.
export function renderAdvisoryRerollMarker(payload) {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  if (!agentId || !/^[0-9a-f]{40}$/.test(headSha) || !timestamp) {
    throw new Error('invalid advisory-reroll marker payload');
  }
  return `advisory-reroll: ${agentId} ${headSha} ${timestamp}`;
}
export function parseExternalCheckWaiverComment(body, createdAt) {
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
export function parseReviewWatermarkComment(body, createdAt) {
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
export function operationalMarkerPrefix(body) {
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
export function operationalMarkerPrefixByStart(body) {
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
 * Detects a `claimed-by` / `unclaimed-by` / `activation-nonce` /
 * `review-watermark` / `review-baseline` comment whose body starts with a
 * structurally valid marker token but whose whole body does not match the
 * canonical, strict
 * `pattern` -- for **any** reason: content appended directly after the
 * token with no note, a well-intentioned human rationale appended after an
 * otherwise-canonical token + note (the motivating case), a note that does
 * not satisfy the required note grammar (e.g. missing the required `IDD`
 * word), or any other departure from the canonical token-then-optional-
 * single-note shape. Such a body already fails `operationalMarkerPrefix`'s
 * whole-body anchor and is therefore never treated as a live marker for
 * state resolution (`parseClaimComment`, `resolveActiveClaim`, and friends
 * keep returning `null` / ignoring it, unchanged by this function's
 * existence); this gives a caller that wants one a **distinct** "malformed
 * marker" signal instead of the comment silently reading as ordinary,
 * unremarkable content (#1316).
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
export function detectMalformedOperationalMarker(body) {
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
function normalizeNonWhitespaceToken(value) {
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
function pickPayloadValue(payload, ...keys) {
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) {
      return payload[key];
    }
  }
  return undefined;
}
function hasConflictingPayloadAliases(payload, firstKey, secondKey) {
  if (!Object.hasOwn(payload, firstKey) || !Object.hasOwn(payload, secondKey)) {
    return false;
  }
  return (
    String(payload[firstKey] ?? '').trim() !==
    String(payload[secondKey] ?? '').trim()
  );
}
function normalizeBranchToken(value) {
  const token = normalizeNonWhitespaceToken(value);
  if (!token || token.includes('>')) {
    return '';
  }
  return token;
}
function normalizeForcedHandoffReason(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.includes('-->')) {
    return '';
  }
  return trimmed;
}
function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || !isValidIsoTimestamp(trimmed)) {
    return '';
  }
  return trimmed;
}
function normalizeSecondPrecisionIsoTimestamp(value) {
  const timestamp = normalizeIsoTimestamp(value);
  if (!timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
    return '';
  }
  return timestamp;
}
function normalizeContextScope(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return FORCED_HANDOFF_CONTEXT_SCOPES.has(trimmed) ? trimmed : '';
}
function normalizeLinkedPr(value) {
  const token = normalizeNonWhitespaceToken(value);
  if (!token || !FORCED_HANDOFF_LINKED_PR_PATTERN.test(token)) {
    return '';
  }
  return token;
}
function isValidForcedHandoffOperationalMarker(body) {
  return parseForcedHandoffComment(body, '') !== null;
}
export function isValidIsoTimestamp(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const normalize = (ts) => ts.replace('.000Z', 'Z');
  return normalize(new Date(time).toISOString()) === normalize(value);
}
