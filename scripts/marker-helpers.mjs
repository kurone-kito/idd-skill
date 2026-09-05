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
import { createMarkerRegex, escapeRegex } from './marker-regex.mjs';

const ISO8601_UTC_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;
const OPTIONAL_IDD_VISIBLE_NOTE_PATTERN = String.raw`(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)`;
const OPERATIONAL_MARKER_ENTRIES = [
  {
    label: '<!-- claimed-by:',
    pattern:
      /^<!--\s*claimed-by:\s+\S+\s+\S+\s+supersedes:\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+branch:\s+[^\s>]+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    startPattern: /^<!--\s*claimed-by:/i,
    malformedPrefixPattern:
      /^<!--\s*claimed-by:\s+\S+\s+\S+\s+supersedes:\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+branch:\s+[^\s>]+\s*-->/i,
  },
  {
    label: '<!-- unclaimed-by:',
    pattern:
      /^<!--\s*unclaimed-by:\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    startPattern: /^<!--\s*unclaimed-by:/i,
    malformedPrefixPattern:
      /^<!--\s*unclaimed-by:\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->/i,
  },
  {
    label: '<!-- activation-nonce:',
    pattern:
      /^<!--\s*activation-nonce:\s+\S+\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    startPattern: /^<!--\s*activation-nonce:/i,
    malformedPrefixPattern:
      /^<!--\s*activation-nonce:\s+\S+\s+\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*-->/i,
  },
  {
    label: '<!-- review-watermark:',
    pattern:
      /^<!--\s*review-watermark:\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+\S+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    startPattern: /^<!--\s*review-watermark:/i,
    malformedPrefixPattern:
      /^<!--\s*review-watermark:\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+\S+\s*-->/i,
  },
  {
    label: '<!-- review-baseline:',
    pattern:
      /^<!--\s*review-baseline:\s+\S+\s+\S+\s+\S+\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i,
    startPattern: /^<!--\s*review-baseline:/i,
    malformedPrefixPattern: /^<!--\s*review-baseline:\s+\S+\s+\S+\s+\S+\s*-->/i,
  },
  {
    label: 'advisory-wait:',
    pattern:
      /^advisory-wait:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/,
    // Case-sensitive on purpose (#1720): `pattern` above has no `/i`, so
    // `startPattern` must not gain one either -- widening this one would
    // loosen a marker family the issue explicitly requires to stay
    // case-sensitive on both paths.
    startPattern: /^advisory-wait:/,
  },
  {
    // #1572: the trailing ` claim:{claimId} attempt:{n}` suffix is OPTIONAL
    // here on purpose. The shipped AW3-R recovery flow
    // (idd-advisory-wait.instructions.md) already posts and consumes the
    // legacy 3-field form via post-idd-marker's `--type advisory-recovery`
    // and protocol-helpers.mts's `advisoryWaitMarkerMatchesHead` (which
    // matches on a prefix, so any well-formed suffix here stays compatible
    // with it unmodified). Making the suffix required would silently break
    // that live flow; making it optional keeps the legacy form recognized
    // (`operationalMarkerPrefix*`) while still letting a future bound
    // marker match here too. Only the bound form parses via
    // `parseAdvisoryRecoveryComment` -- the legacy form is recognized
    // (filtered as a trusted operational comment) but is NOT usable
    // recovery-cycle evidence (excluded from counting/anchoring).
    label: 'advisory-wait-recovery:',
    pattern:
      /^advisory-wait-recovery:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z(?:\s+claim:\S+\s+attempt:[1-9]\d*)?\s*$/,
    // Case-sensitive on purpose (#1720), same reasoning as advisory-wait:
    // above; also structurally distinct from it (the literal `:` sits right
    // after `-recovery`, so this never matches an `advisory-wait:` body).
    startPattern: /^advisory-wait-recovery:/,
  },
  {
    label: '<!-- advisory-wait:',
    pattern: /^<!--\s*advisory-wait:\s+\S+\s+[0-9a-f]{40}\s+\S+\s*-->\s*$/,
    // Case-sensitive on purpose (#1720): not one of the issue's four named
    // plain-text markers, but `pattern` above has no `/i` either, so this
    // must not gain case-insensitivity -- only the same internal-whitespace
    // tolerance after `<!--` that `pattern` already allows.
    startPattern: /^<!--\s*advisory-wait:/,
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
    // Case-sensitive on purpose (#1720), same reasoning as the
    // advisory-wait: entry above.
    startPattern: /^advisory-reroll:/,
  },
  {
    // #2050: disposition-aware Clause 1 escape hatch. A trusted actor posts
    // this after reading a specific primary-bot review's findings
    // (including any body-embedded `Suppressed comments (N)` section, #1880)
    // -- a whole-review acknowledgement rather than a per-finding identifier
    // scheme (see the issue's "Decision" section for why). PLAIN-TEXT, same
    // family shape as advisory-reroll: above (no visible note), for the same
    // reason: the ack comment itself must never pollute review-currency/
    // watermark computations. Same field shape as advisory-reroll:
    // (`{agentId} {headSha} {timestamp}`) -- see post-idd-marker.mts's
    // `--type review-ack`. This entry only recognizes/parses the marker's
    // shape; validity (a trusted author whose OWN `created_at` postdates the
    // latest primary-bot review's `submittedAt`) is evaluated by
    // `advisory-convergence.mts`'s `resolveHasValidReviewAck`, not here.
    label: 'review-ack:',
    pattern:
      /^review-ack:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/,
    // Case-sensitive on purpose (#1720), same reasoning as the
    // advisory-wait: entry above.
    startPattern: /^review-ack:/,
  },
  {
    // #1572: brand-new terminal marker type, no legacy form to preserve, so
    // the `claim:{claimId} attempt:{n}` binding suffix is unconditionally
    // required (unlike advisory-wait-recovery: above). PLAIN-TEXT, same
    // family shape as advisory-wait: / advisory-wait-recovery: (no visible
    // note). This issue defines the render/parse contract only; deciding
    // when to post it is out of scope (owned by the sibling execution/
    // routing tracks).
    label: 'copilot-unavailable:',
    pattern:
      /^copilot-unavailable:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+claim:\S+\s+attempt:[1-9]\d*\s*$/,
    // Case-sensitive on purpose (#1720), same reasoning as the
    // advisory-wait: entry above.
    startPattern: /^copilot-unavailable:/,
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
  {
    label: '<!-- idd-provider-outage-declaration:',
    pattern:
      /^<!--\s*idd-provider-outage-declaration:\s+\S+\s+service:\S+\s+started:\S+\s+expires:\S+\s*-->[\s\S]*$/i,
    startPattern: /^<!--\s*idd-provider-outage-declaration:/i,
  },
  {
    label: '<!-- idd-provider-outage-advanced:',
    pattern:
      /^<!--\s*idd-provider-outage-advanced:\s+\S+\s+pr:\d+\s+head:[0-9a-f]{40}\s+declared:\S+\s*-->[\s\S]*$/i,
    startPattern: /^<!--\s*idd-provider-outage-advanced:/i,
  },
  {
    label: '<!-- idd-provider-outage-park:',
    pattern:
      /^<!--\s*idd-provider-outage-park:\s+\S+\s+issue:\d+\s+service:\S+\s+head:[0-9a-f]{40}\s+claim:\S+\s+parked:\S+\s+blockers:\S+\s*-->[\s\S]*$/i,
    startPattern: /^<!--\s*idd-provider-outage-park:/i,
  },
  {
    label: '<!-- idd-local-validation-evidence:',
    pattern:
      /^<!--\s*idd-local-validation-evidence:\s+\S+\s+head:[0-9a-f]{40}\s+commands:\S+\s+covers:\S+\s+outcome:(?:pass|fail)\s*-->[\s\S]*$/i,
    startPattern: /^<!--\s*idd-local-validation-evidence:/i,
  },
];
/**
 * Frozen, exported view of {@link OPERATIONAL_MARKER_ENTRIES}. This array is
 * exported (and re-exported transitively via `protocol-helpers.mts`'s
 * `export * from './marker-helpers.mts'`) so tests can iterate every entry
 * for the case-flag-parity / label-correspondence invariants (#1720). The
 * `readonly OperationalMarker[]` type is compile-time only and does not
 * stop a JS consumer -- or a TS call site that casts around the type --
 * from mutating the array or an entry at runtime, which would silently
 * change marker recognition for every `operationalMarkerPrefix*` call
 * process-wide (this module's own three call sites included). `Object.freeze`
 * on both the array and each entry makes that mutation a no-op (throwing in
 * strict mode) instead of a silent, shared-state corruption.
 */
export const OPERATIONAL_MARKERS = Object.freeze(
  OPERATIONAL_MARKER_ENTRIES.map((marker) => Object.freeze(marker)),
);
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
  'review-ack:',
  'copilot-unavailable:',
  '<!-- idd-provider-outage-park:',
]);
// ---------------------------------------------------------------------------
// Review-reply identity stamp (#2135)
//
// Utterance identity on a visible E6/E13 reply body — not an E1 activity
// snapshot. Deliberately absent from OPERATIONAL_MARKERS and
// IDD_AGENT_DERIVED_MARKERS so F4 minimization never hides a stamped
// disposition as OUTDATED and deriveIddAgentLogins never treats the stamp
// as a first-bytes operational marker. The token rides AFTER the visible
// **Accepted** / **Rejected** prefix; first bytes stay the disposition.
// ---------------------------------------------------------------------------
/** Distributed default `markerPrefix` when config is absent. */
const DEFAULT_REVIEW_REPLY_MARKER_PREFIX = 'idd-skill';
/**
 * Suffix passed to {@link createMarkerRegex} for the reply-identity stamp.
 * Must not be `watermark` or `review-watermark` — those are the E1 snapshot.
 */
export const REVIEW_REPLY_STAMP_SUFFIX = 'review-reply';
function normalizeReviewReplyMarkerPrefix(markerPrefix) {
  const trimmed = typeof markerPrefix === 'string' ? markerPrefix.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_REVIEW_REPLY_MARKER_PREFIX;
}
/** Render `<!-- {prefix}-review-reply -->` for the configured marker prefix. */
export function renderReviewReplyStamp(
  markerPrefix = DEFAULT_REVIEW_REPLY_MARKER_PREFIX,
) {
  return `<!-- ${normalizeReviewReplyMarkerPrefix(markerPrefix)}-${REVIEW_REPLY_STAMP_SUFFIX} -->`;
}
/**
 * True when `body` carries a prefix-aware `review-reply` stamp anywhere
 * (typically after the visible disposition). Mid-body match is required:
 * the stamp is not first-bytes. The stamp has no payload, so after the
 * shared `createMarkerRegex` hit we require the matched comment to be
 * exactly `<!-- {prefix}-review-reply -->` (optional whitespace). That
 * rejects suffix extensions such as `review-reply-extra` that `\b`
 * would otherwise accept before a hyphen.
 */
export function hasReviewReplyStamp(
  body,
  markerPrefix = DEFAULT_REVIEW_REPLY_MARKER_PREFIX,
) {
  const prefix = normalizeReviewReplyMarkerPrefix(markerPrefix);
  const coarse = createMarkerRegex(prefix, REVIEW_REPLY_STAMP_SUFFIX);
  const exact = new RegExp(
    `^<!--\\s*${escapeRegex(prefix)}-${REVIEW_REPLY_STAMP_SUFFIX}\\s*-->$`,
    'i',
  );
  // createMarkerRegex is non-global and will stop at the first suffix
  // lookalike. Scan every match so an earlier `review-reply-extra` does
  // not hide a later valid stamp (and so append stays idempotent).
  const global = new RegExp(coarse.source, 'gi');
  for (const match of (body ?? '').matchAll(global)) {
    if (exact.test(match[0])) {
      return true;
    }
  }
  return false;
}
/**
 * Classify a comment as IDD-originated from the reply-identity stamp alone.
 * Ordinary human prose (`LGTM`, `thanks, fixed`) is not originated. A
 * well-formed stamp is sufficient; this does not inspect author login and
 * does not satisfy Copilot Clause 2 by itself (that still needs a valid
 * disposition body).
 */
export function isIddOriginatedReply(
  body,
  markerPrefix = DEFAULT_REVIEW_REPLY_MARKER_PREFIX,
) {
  return hasReviewReplyStamp(body, markerPrefix);
}
/**
 * Append the reply-identity stamp after a visible reply body. Empty input
 * is left unchanged. Already-stamped input is not double-stamped. The
 * visible first bytes are preserved so `isDispositionComment` still matches.
 */
export function appendReviewReplyStamp(
  body,
  markerPrefix = DEFAULT_REVIEW_REPLY_MARKER_PREFIX,
) {
  const text = body ?? '';
  if (text.trim() === '') {
    return text;
  }
  if (hasReviewReplyStamp(text, markerPrefix)) {
    return text;
  }
  return `${text.replace(/\s+$/, '')}\n\n${renderReviewReplyStamp(markerPrefix)}`;
}
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
/** Sorted activation-nonce values in `events` for `claimId`. Empty when
 * none match. `events` must already be trust-filtered. */
export function listActivationNonces(events, claimId) {
  return events
    .map((event) =>
      parseActivationNonceComment(event.body ?? '', event.createdAt ?? ''),
    )
    .filter((marker) => Boolean(marker) && marker?.claimId === claimId)
    .map((marker) => marker.nonce)
    .sort();
}
export function findActivationNonceWinner(events, claimId) {
  const nonces = listActivationNonces(events, claimId);
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
function renderProviderOutageDeclarationNote(normalized) {
  return `_${normalized.actor}: provider outage declaration for \`${normalized.service}\` until \`${normalized.expiresAt}\` — IDD automation marker. Do not edit._`;
}
/**
 * Render a `<!-- idd-provider-outage-declaration: ... -->` marker (#2320).
 * Posted to the configured `providerOutage.declarationTarget` issue by an
 * authorized actor to open a repository-scoped, time-boxed outage relief
 * window. `service` and the free-text fields reuse the same percent-encoded,
 * newline/comment-token-safe field grammar as
 * {@link renderExternalCheckWaiverComment}.
 */
export function renderProviderOutageDeclarationComment(payload) {
  const actor = normalizeNonWhitespaceToken(payload?.actor);
  const service = normalizeExternalCheckWaiverField(payload?.service);
  const startedAt = normalizeSecondPrecisionIsoTimestamp(payload?.startedAt);
  const expiresAt = normalizeSecondPrecisionIsoTimestamp(payload?.expiresAt);
  if (!actor || !service || !startedAt || !expiresAt) {
    throw new Error('invalid provider outage declaration payload');
  }
  const encodedService = encodeExternalCheckWaiverField(service);
  return [
    `<!-- idd-provider-outage-declaration: ${actor} service:${encodedService} started:${startedAt} expires:${expiresAt} -->`,
    '',
    renderProviderOutageDeclarationNote({ actor, service, expiresAt }),
  ].join('\n');
}
export function parseProviderOutageDeclarationComment(body, createdAt) {
  const match = body
    .trimEnd()
    .match(
      new RegExp(
        `^<!--\\s*idd-provider-outage-declaration:\\s+(\\S+)\\s+service:(\\S+)\\s+started:(\\S+)\\s+expires:(\\S+)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
        'i',
      ),
    );
  if (!match) {
    return null;
  }
  const actor = normalizeNonWhitespaceToken(match[1]);
  const service = normalizeExternalCheckWaiverField(
    decodeExternalCheckWaiverField(match[2]),
  );
  const startedAt = normalizeSecondPrecisionIsoTimestamp(match[3]);
  const expiresAt = normalizeSecondPrecisionIsoTimestamp(match[4]);
  if (!actor || !service || !startedAt || !expiresAt) {
    return null;
  }
  return {
    actor,
    service,
    startedAt,
    expiresAt,
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : 'none',
  };
}
/**
 * Render a `<!-- idd-provider-outage-advanced: ... -->` marker (#2320): one
 * record of a pull request advanced under an active outage declaration,
 * posted to the same declaration-target issue. `declaredAt` pins the record
 * to the specific declaration window that authorized the advancement, so a
 * post-recovery sweep can tell records from a superseded declaration apart
 * from records made under the current one.
 */
export function renderProviderOutageAdvancedComment(payload) {
  const actor = normalizeNonWhitespaceToken(payload?.actor);
  const prNumber = normalizePositiveIntegerToken(payload?.prNumber);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const declaredAt = normalizeSecondPrecisionIsoTimestamp(payload?.declaredAt);
  if (
    !actor ||
    prNumber === null ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    !declaredAt
  ) {
    throw new Error('invalid provider outage advancement payload');
  }
  return [
    `<!-- idd-provider-outage-advanced: ${actor} pr:${prNumber} head:${headSha} declared:${declaredAt} -->`,
    '',
    `_${actor}: pull request #${prNumber} advanced under an active outage declaration — IDD automation marker. Do not edit._`,
  ].join('\n');
}
export function parseProviderOutageAdvancedComment(body, createdAt) {
  const match = body
    .trimEnd()
    .match(
      new RegExp(
        `^<!--\\s*idd-provider-outage-advanced:\\s+(\\S+)\\s+pr:(\\d+)\\s+head:([0-9a-f]{40})\\s+declared:(\\S+)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
        'i',
      ),
    );
  if (!match) {
    return null;
  }
  const actor = normalizeNonWhitespaceToken(match[1]);
  const prNumber = normalizePositiveIntegerToken(match[2]);
  const declaredAt = normalizeSecondPrecisionIsoTimestamp(match[4]);
  if (!actor || prNumber === null || !declaredAt) {
    return null;
  }
  return {
    actor,
    prNumber,
    headSha: match[3].toLowerCase(),
    declaredAt,
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : 'none',
  };
}
/**
 * Render a `<!-- idd-provider-outage-park: ... -->` marker (#2321). Posted
 * to the parked pull request by the holding session before it releases the
 * originating issue's claim. `service` reuses the same percent-encoded,
 * comment-token-safe field grammar as the sibling outage markers rather than
 * hard-restricting to an enum here -- the caller validates `service` against
 * `PROVIDER_HEALTH_SERVICES` (provider-health.mts) before rendering.
 * `blockers` is the caller's own `pre-merge-readiness` blocker-gate names
 * that justified eligibility (the issue's own acceptance criteria requires
 * naming "the service and the blocking evidence") -- each entry is
 * percent-encoded individually before joining with a raw `,`, matching
 * {@link renderLocalValidationEvidenceComment}'s `covers` field exactly, so
 * a gate name containing a literal comma still round-trips.
 */
export function renderProviderOutageParkComment(payload) {
  const actor = normalizeNonWhitespaceToken(payload?.actor);
  const issueNumber = normalizePositiveIntegerToken(payload?.issueNumber);
  const service = normalizeExternalCheckWaiverField(payload?.service);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const parkedAt = normalizeSecondPrecisionIsoTimestamp(payload?.parkedAt);
  const blockersList = (
    Array.isArray(payload?.blockers) ? payload.blockers : []
  )
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  if (
    !actor ||
    issueNumber === null ||
    !service ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    !claimId ||
    !parkedAt ||
    blockersList.length === 0
  ) {
    throw new Error('invalid provider outage park payload');
  }
  const encodedService = encodeExternalCheckWaiverField(service);
  const encodedBlockers = blockersList
    .map((entry) => encodeExternalCheckWaiverField(entry))
    .join(',');
  return [
    `<!-- idd-provider-outage-park: ${actor} issue:${issueNumber} service:${encodedService} head:${headSha} claim:${claimId} parked:${parkedAt} blockers:${encodedBlockers} -->`,
    '',
    `_${actor}: pull request parked -- \`${service}\` unavailable (blockers: ${blockersList.join(', ')}), issue #${issueNumber}'s claim released -- IDD automation marker. Do not edit._`,
  ].join('\n');
}
export function parseProviderOutageParkComment(body, createdAt) {
  const match = body
    .trimEnd()
    .match(
      new RegExp(
        `^<!--\\s*idd-provider-outage-park:\\s+(\\S+)\\s+issue:(\\d+)\\s+service:(\\S+)\\s+head:([0-9a-f]{40})\\s+claim:(\\S+)\\s+parked:(\\S+)\\s+blockers:(\\S+)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
        'i',
      ),
    );
  if (!match) {
    return null;
  }
  const actor = normalizeNonWhitespaceToken(match[1]);
  const issueNumber = normalizePositiveIntegerToken(match[2]);
  const service = normalizeExternalCheckWaiverField(
    decodeExternalCheckWaiverField(match[3]),
  );
  const claimId = normalizeNonWhitespaceToken(match[5]);
  const parkedAt = normalizeSecondPrecisionIsoTimestamp(match[6]);
  // Split on the raw `,` separator BEFORE decoding each entry -- the render
  // side percent-encodes every entry individually, so a literal comma can
  // only appear here as a join separator, never inside an entry's own
  // encoded form (same invariant as parseLocalValidationEvidenceComment).
  const blockers = match[7]
    .split(',')
    .map((entry) =>
      normalizeExternalCheckWaiverField(decodeExternalCheckWaiverField(entry)),
    )
    .filter(Boolean);
  if (
    !actor ||
    issueNumber === null ||
    !service ||
    !claimId ||
    !parkedAt ||
    blockers.length === 0
  ) {
    return null;
  }
  return {
    actor,
    issueNumber,
    service,
    headSha: match[4].toLowerCase(),
    claimId,
    parkedAt,
    blockers,
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : 'none',
  };
}
/**
 * Render a `<!-- idd-local-validation-evidence: ... -->` marker (#2323).
 * Each `covers` entry is percent-encoded individually (reusing the same
 * comment-token-safe field grammar as the sibling outage markers) before
 * being joined with a raw `,`, so a check name containing a literal comma
 * still round-trips correctly -- only the join separator itself is ever a
 * raw `,` in the wire form.
 */
export function renderLocalValidationEvidenceComment(payload) {
  const actor = normalizeNonWhitespaceToken(payload?.actor);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const commandSet = normalizeExternalCheckWaiverField(payload?.commandSet);
  const coversList = (Array.isArray(payload?.covers) ? payload.covers : [])
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  const outcome = String(payload?.outcome ?? '').trim();
  if (
    !actor ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    !commandSet ||
    coversList.length === 0 ||
    (outcome !== 'pass' && outcome !== 'fail')
  ) {
    throw new Error('invalid local validation evidence payload');
  }
  const encodedCommandSet = encodeExternalCheckWaiverField(commandSet);
  // #2355 review (Copilot, CodeRabbit): encode each entry BEFORE joining --
  // encoding the joined string instead would also turn a literal comma
  // inside one entry's own name into the same `%2C` the join separator
  // produces, making a comma-containing check name indistinguishable from
  // the boundary between two entries on parse. Each encoded entry can
  // never itself contain a raw `,` (percent-encoded away), so splitting on
  // the raw `,` below is unambiguous.
  const encodedCovers = coversList
    .map((entry) => encodeExternalCheckWaiverField(entry))
    .join(',');
  return [
    `<!-- idd-local-validation-evidence: ${actor} head:${headSha} commands:${encodedCommandSet} covers:${encodedCovers} outcome:${outcome} -->`,
    '',
    `_${actor}: local validation evidence (\`${commandSet}\`, ${outcome}) for \`${headSha}\` — IDD automation marker. Do not edit._`,
  ].join('\n');
}
export function parseLocalValidationEvidenceComment(body, createdAt) {
  const match = body
    .trimEnd()
    .match(
      new RegExp(
        `^<!--\\s*idd-local-validation-evidence:\\s+(\\S+)\\s+head:([0-9a-f]{40})\\s+commands:(\\S+)\\s+covers:(\\S+)\\s+outcome:(pass|fail)\\s*-->${OPTIONAL_IDD_VISIBLE_NOTE_PATTERN}$`,
        'i',
      ),
    );
  if (!match) {
    return null;
  }
  const actor = normalizeNonWhitespaceToken(match[1]);
  const commandSet = normalizeExternalCheckWaiverField(
    decodeExternalCheckWaiverField(match[3]),
  );
  // Split on the raw `,` separator BEFORE decoding each entry -- the
  // matching render side percent-encodes every entry individually, so a
  // literal comma can only ever appear here as a join separator, never
  // inside an entry's own encoded form.
  const covers = match[4]
    .split(',')
    .map((entry) =>
      normalizeExternalCheckWaiverField(decodeExternalCheckWaiverField(entry)),
    )
    .filter(Boolean);
  if (!actor || !commandSet || covers.length === 0) {
    return null;
  }
  return {
    actor,
    headSha: match[2].toLowerCase(),
    commandSet,
    covers,
    outcome: match[5].toLowerCase(),
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : 'none',
  };
}
const AUTHORING_OWNER_MODES = new Set([
  'acquire',
  'resume',
  'bootstrap',
  'heartbeat',
  'release',
  'release-guard',
  'release-complete',
]);
const AUTHORING_PUBLICATION_INTENT_STATES = new Set([
  'pending',
  'member',
  'cleanup',
  'abandoned',
]);
// docs/issue-authoring-skill.md documents body-sha256/snapshot-sha256 as
// `<64-lowercase-hex|none>` specifically -- presence alone (accepting a
// garbage value like `body-sha256=garbage`) is not shape-valid per that
// grammar (#2628 review, Codex and Copilot both flagged this).
const AUTHORING_OWNER_DIGEST_PATTERN = /^(?:none|[0-9a-f]{64})$/;
/**
 * Parse the `field=value; field2=value2; ...` payload of a
 * `<!-- {markerPrefix}-{suffix}: ... -->` marker into a raw field map. Each
 * value is split on the first `=` only and trimmed on both sides; a field
 * with no `=` is dropped rather than treated as a key with an empty value,
 * since none of the three markers above have a valueless field. Returns
 * `null` when the marker itself is absent -- callers validate the required
 * field set and any enum values themselves, since each marker's requirement
 * differs.
 */
function parseSemicolonFieldMarker(body, markerPrefix, suffix) {
  // Anchored at `^` (position 0, not "anywhere in body") and restricted to
  // same-line whitespace between `<!--` and the prefix-suffix token: the
  // contract requires each of these three markers to be an "HTML-first"
  // comment/body line, not merely present somewhere in a longer comment or
  // pasted example -- an unanchored search would also accept a marker
  // quoted after prose, inside a fenced example, or opened across a
  // newline (`<!--\nidd-skill-authoring-owner: ...`), none of which are the
  // real marker the protocol posts (#2628 review, Codex).
  // The payload capture (and its surrounding whitespace) is restricted to
  // same-line spaces/tabs -- these are "HTML-first body line" markers in
  // their entirety, not just at their opener, so a multi-line comment
  // starting at byte 0 must not parse as well-formed either (#2628 review,
  // Copilot and Codex).
  const pattern = new RegExp(
    `^<!--[ \\t]*${escapeRegex(markerPrefix)}-${suffix}:[ \\t]*([^\\r\\n]*?)[ \\t]*-->`,
    'i',
  );
  const match = body.match(pattern);
  if (!match) {
    return null;
  }
  const fields = {};
  for (const part of match[1].split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) {
      fields[key] = value;
    }
  }
  return fields;
}
export function parseAuthoringOwnerComment(body, markerPrefix) {
  const fields = parseSemicolonFieldMarker(
    body,
    markerPrefix,
    'authoring-owner',
  );
  if (!fields) {
    return null;
  }
  const mode = fields.mode;
  if (
    !fields.target ||
    !fields.anchor ||
    !AUTHORING_OWNER_MODES.has(mode) ||
    !fields.owner ||
    !fields.set ||
    !fields.session ||
    !AUTHORING_OWNER_DIGEST_PATTERN.test(fields['body-sha256'] ?? '') ||
    !AUTHORING_OWNER_DIGEST_PATTERN.test(fields['snapshot-sha256'] ?? '') ||
    !fields.supersedes
  ) {
    return null;
  }
  return {
    target: fields.target,
    anchor: fields.anchor,
    mode: mode,
    owner: fields.owner,
    set: fields.set,
    session: fields.session,
    bodySha256: fields['body-sha256'],
    snapshotSha256: fields['snapshot-sha256'],
    supersedes: fields.supersedes,
  };
}
export function parseAuthoringPublicationComment(body, markerPrefix) {
  const fields = parseSemicolonFieldMarker(
    body,
    markerPrefix,
    'authoring-publication',
  );
  if (
    !fields ||
    !fields.target ||
    !fields.anchor ||
    !fields.set ||
    !fields.session ||
    !fields.token
  ) {
    return null;
  }
  return {
    target: fields.target,
    anchor: fields.anchor,
    set: fields.set,
    session: fields.session,
    token: fields.token,
  };
}
export function parseAuthoringPublicationIntentComment(body, markerPrefix) {
  const fields = parseSemicolonFieldMarker(
    body,
    markerPrefix,
    'authoring-publication-intent',
  );
  if (!fields) {
    return null;
  }
  const state = fields.state;
  if (
    !fields.target ||
    !fields.anchor ||
    !fields.set ||
    !fields.session ||
    !fields.token ||
    !fields.journal ||
    !fields.issue ||
    !fields.actor ||
    !AUTHORING_PUBLICATION_INTENT_STATES.has(state)
  ) {
    return null;
  }
  return {
    target: fields.target,
    anchor: fields.anchor,
    set: fields.set,
    session: fields.session,
    token: fields.token,
    journal: fields.journal,
    issue: fields.issue,
    actor: fields.actor,
    state: state,
  };
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
/**
 * Build the field-attribution suffix for a marker-payload aggregate
 * validation error (`#2247`): names every field whose check failed instead
 * of leaving the generic "invalid ... marker payload" message unattributed.
 * A field is "missing" when its raw payload value is absent, `null`, or (for
 * a string) empty after trimming; anything else that still failed its own
 * normalize/format check is "invalid" -- a non-empty but malformed value
 * (a non-ISO timestamp, a non-hex-40 SHA). Every CLI-reachable renderer
 * caller (`emit-marker.mts`, `post-idd-marker.mts`) already rejects a
 * genuinely omitted flag before this guard runs (`#1722`, `requireFlag`), so
 * this most commonly fires on the "invalid" branch in practice -- but a
 * direct (non-CLI) caller can still hit "missing", so both stay covered.
 * Returns `''` when every listed field passed (never expected to be called
 * that way, but keeps the helper a total function).
 */
function describeInvalidMarkerFields(fields) {
  const missing = [];
  const invalid = [];
  for (const { name, raw, failed } of fields) {
    if (!failed) {
      continue;
    }
    const rawMissing =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.trim() === '');
    (rawMissing ? missing : invalid).push(`"${name}"`);
  }
  const parts = [];
  if (missing.length > 0) {
    parts.push(`missing ${missing.join(', ')}`);
  }
  if (invalid.length > 0) {
    parts.push(`invalid ${invalid.join(', ')}`);
  }
  return parts.length > 0 ? `: ${parts.join('; ')}` : '';
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
    throw new Error(
      'invalid claimed-by marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'claimId', raw: payload?.claimId, failed: !claimId },
          { name: 'timestamp', raw: payload?.timestamp, failed: !timestamp },
          { name: 'branch', raw: payload?.branch, failed: !branch },
        ]),
    );
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
    throw new Error(
      'invalid activation-nonce marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'claimId', raw: payload?.claimId, failed: !claimId },
          { name: 'nonce', raw: payload?.nonce, failed: !nonce },
          { name: 'timestamp', raw: payload?.timestamp, failed: !timestamp },
        ]),
    );
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
  const headShaValid = /^[0-9a-f]{40}$/.test(headSha);
  if (
    !agentId ||
    !claimId ||
    !headShaValid ||
    maxActivityAt === null ||
    totalItemCount === null ||
    ciCompletedAt === null
  ) {
    throw new Error(
      'invalid review-watermark marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'claimId', raw: payload?.claimId, failed: !claimId },
          { name: 'headSha', raw: payload?.headSha, failed: !headShaValid },
          {
            name: 'maxActivityAt',
            raw: payload?.maxActivityAt,
            failed: maxActivityAt === null,
          },
          {
            name: 'totalItemCount',
            raw: payload?.totalItemCount,
            failed: totalItemCount === null,
          },
          {
            name: 'ciCompletedAt',
            raw: payload?.ciCompletedAt,
            failed: ciCompletedAt === null,
          },
        ]),
    );
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
  const shaValid = /^[0-9a-f]{40}$/.test(sha);
  if (!agentId || !claimId || !shaValid) {
    throw new Error(
      'invalid review-baseline marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'claimId', raw: payload?.claimId, failed: !claimId },
          { name: 'sha', raw: payload?.sha, failed: !shaValid },
        ]),
    );
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
    throw new Error(
      'invalid unclaimed-by marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'claimId', raw: payload?.claimId, failed: !claimId },
          { name: 'timestamp', raw: payload?.timestamp, failed: !timestamp },
        ]),
    );
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
  const headShaValid = /^[0-9a-f]{40}$/.test(headSha);
  if (!agentId || !headShaValid || !timestamp) {
    throw new Error(
      'invalid advisory-wait marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'headSha', raw: payload?.headSha, failed: !headShaValid },
          { name: 'timestamp', raw: payload?.timestamp, failed: !timestamp },
        ]),
    );
  }
  return `advisory-wait: ${agentId} ${headSha} ${timestamp}`;
}
/**
 * Normalize a claimed positive-integer token (e.g. an attempt number):
 * accepts a JS number or a purely-numeric string, rejects anything else
 * (fractional, negative, zero, non-numeric, or unsafe magnitude). Returns
 * `null` on any invalid input so callers can fail closed.
 */
function normalizePositiveIntegerToken(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  const trimmed = String(value ?? '').trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}
/**
 * `#1572`: extended to OPTIONALLY bind the active claim and an attempt
 * number, in addition to the original agent/HEAD/timestamp triple. Passing
 * neither `claimId` nor `attempt` renders the exact legacy 3-field body
 * (byte-for-byte unchanged, preserving the shipped AW3-R recovery flow that
 * calls this renderer today without those fields). Passing both appends the
 * bound suffix. Passing only one of the two throws -- a half-bound marker
 * would be ambiguous evidence, so this fails closed rather than silently
 * omitting the partial field.
 */
export function renderAdvisoryWaitRecoveryMarker(payload) {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  const headShaValid = /^[0-9a-f]{40}$/.test(headSha);
  if (!agentId || !headShaValid || !timestamp) {
    throw new Error(
      'invalid advisory-wait-recovery marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'headSha', raw: payload?.headSha, failed: !headShaValid },
          { name: 'timestamp', raw: payload?.timestamp, failed: !timestamp },
        ]),
    );
  }
  const claimIdProvided =
    payload?.claimId !== undefined &&
    payload?.claimId !== null &&
    payload?.claimId !== '';
  const attemptProvided =
    payload?.attempt !== undefined &&
    payload?.attempt !== null &&
    payload?.attempt !== '';
  if (!claimIdProvided && !attemptProvided) {
    return `advisory-wait-recovery: ${agentId} ${headSha} ${timestamp}`;
  }
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const attempt = normalizePositiveIntegerToken(payload?.attempt);
  if (!claimId || attempt === null) {
    throw new Error(
      'invalid advisory-wait-recovery marker payload: claimId and attempt must both be provided together',
    );
  }
  return `advisory-wait-recovery: ${agentId} ${headSha} ${timestamp} claim:${claimId} attempt:${attempt}`;
}
/**
 * `#1572`: brand-new terminal marker, no legacy unbound form -- agent,
 * claim, HEAD, and attempt number are all unconditionally required (unlike
 * {@link renderAdvisoryWaitRecoveryMarker}'s optional binding). Rendering
 * this marker does not decide *when* to post it; that policy belongs to the
 * sibling execution/routing tracks (#1571/#1570).
 */
export function renderCopilotUnavailableMarker(payload) {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const claimId = normalizeNonWhitespaceToken(payload?.claimId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const attempt = normalizePositiveIntegerToken(payload?.attempt);
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  const headShaValid = /^[0-9a-f]{40}$/.test(headSha);
  if (!agentId || !claimId || !headShaValid || attempt === null || !timestamp) {
    throw new Error(
      'invalid copilot-unavailable marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'claimId', raw: payload?.claimId, failed: !claimId },
          { name: 'headSha', raw: payload?.headSha, failed: !headShaValid },
          {
            name: 'attempt',
            raw: payload?.attempt,
            failed: attempt === null,
          },
          { name: 'timestamp', raw: payload?.timestamp, failed: !timestamp },
        ]),
    );
  }
  return `copilot-unavailable: ${agentId} ${headSha} ${timestamp} claim:${claimId} attempt:${attempt}`;
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
  const headShaValid = /^[0-9a-f]{40}$/.test(headSha);
  if (!agentId || !headShaValid || !timestamp) {
    throw new Error(
      'invalid advisory-reroll marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'headSha', raw: payload?.headSha, failed: !headShaValid },
          { name: 'timestamp', raw: payload?.timestamp, failed: !timestamp },
        ]),
    );
  }
  return `advisory-reroll: ${agentId} ${headSha} ${timestamp}`;
}
// #2050: review-ack is ALSO a PLAIN-TEXT marker (no visible note), same
// family shape as advisory-wait: / advisory-reroll: above -- a trusted actor
// posts it after reading a specific primary-bot review's findings (including
// any body-embedded suppressed-comments section), so Clause 1
// (advisory-convergence.mts) can treat that review's `suppressedCount` as
// covered without a per-finding identifier scheme. It carries the PR HEAD
// SHA (not a claim id), matching the advisory-wait/advisory-reroll shape
// exactly, though -- unlike advisory-reroll's same-HEAD filter -- Clause 1's
// own validity check does not filter on it: see
// `resolveHasValidReviewAck`'s doc comment (advisory-convergence.mts) for
// why the marker's own `created_at` compared against the review's
// `submittedAt` is sufficient on its own.
export function renderReviewAckMarker(payload) {
  const agentId = normalizeNonWhitespaceToken(payload?.agentId);
  const headSha = normalizeNonWhitespaceToken(payload?.headSha).toLowerCase();
  const timestamp = normalizeSecondPrecisionIsoTimestamp(payload?.timestamp);
  const headShaValid = /^[0-9a-f]{40}$/.test(headSha);
  if (!agentId || !headShaValid || !timestamp) {
    throw new Error(
      'invalid review-ack marker payload' +
        describeInvalidMarkerFields([
          { name: 'agentId', raw: payload?.agentId, failed: !agentId },
          { name: 'headSha', raw: payload?.headSha, failed: !headShaValid },
          { name: 'timestamp', raw: payload?.timestamp, failed: !timestamp },
        ]),
    );
  }
  return `review-ack: ${agentId} ${headSha} ${timestamp}`;
}
// #1905: the grammar's positional claim-id field
// (`{agent-id} {claim-id|none} {head-sha} ...`) already accepts an
// arbitrary non-whitespace token, so the case-insensitive literal `none`
// sentinel parses through the SAME `(\S+)` capture as any other claim id --
// no regex change needed here. `parsed.claimId` carries the token verbatim
// (case preserved); see `ParsedExternalCheckWaiver.claimId`'s doc comment
// for how the consumer resolves the sentinel.
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
    // #1693: the `i` flag accepts an uppercase-hex SHA (the documented
    // manual hand-composed fallback path), but downstream comparisons
    // (diffReviewSnapshot in protocol-helpers.mts) match exactly against
    // the always-lowercase live head SHA. Returning match[3] verbatim let a
    // hand-composed uppercase watermark parse as valid yet never satisfy
    // the F2 currency check, producing an unexplained head-changed
    // repost loop. Lowercase here, matching parseExternalCheckWaiverComment's
    // existing headSha.toLowerCase() below.
    headSha: match[3].toLowerCase(),
    maxActivityUpdatedAt,
    totalItemCount,
    latestCiCompletedAt,
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : 'none',
  };
}
/**
 * Shared parser for the bound `{prefix}: {agentId} {headSha} {timestamp}
 * claim:{claimId} attempt:{attempt}` shape used by both
 * `advisory-wait-recovery:` (when bound) and `copilot-unavailable:` (always
 * bound). Returns `null` on any structural mismatch, including the legacy
 * unbound `advisory-wait-recovery:` form -- that form is still recognized as
 * an operational marker by `OPERATIONAL_MARKERS`, but is not usable evidence
 * for recovery-cycle counting or terminal-clock anchoring (#1572 AC3: fail
 * closed, exclude rather than guess).
 */
function parseBoundAdvisoryEvidenceMarker(prefix, body) {
  const match = body.trimEnd().match(
    new RegExp(
      // Fractional seconds, when present, sit before the `Z` designator
      // per ISO 8601 (e.g. `00:00:00.123Z`) -- this must match the
      // OPERATIONAL_MARKERS `advisory-wait-recovery:` / `copilot-unavailable:`
      // patterns exactly, or a fractional embedded timestamp could be
      // recognized as an operational marker but rejected here (or vice
      // versa). `ISO8601_UTC_PATTERN` itself has no fractional-seconds
      // slot, so it is not reused for this group.
      // attempt requires a positive integer ([1-9]\d*, no leading zero,
      // no zero) -- matching OPERATIONAL_MARKERS' recognizer patterns
      // exactly, so `attempt:0` is rejected structurally by BOTH the
      // recognizer and the parser instead of being recognized as a
      // well-formed marker here and then discarded post-parse.
      `^${prefix}:\\s+(\\S+)\\s+([0-9a-f]{40})\\s+(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)\\s+claim:(\\S+)\\s+attempt:([1-9]\\d*)\\s*$`,
    ),
  );
  if (!match) {
    return null;
  }
  const attempt = Number.parseInt(match[5], 10);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    // Unreachable given the regex above already excludes 0 and non-digits;
    // kept as defense-in-depth against a future regex edit that widens the
    // attempt group without updating this guard.
    return null;
  }
  return {
    agentId: match[1],
    headSha: match[2].toLowerCase(),
    timestamp: match[3],
    claimId: match[4],
    attempt,
  };
}
/**
 * Parse a bound `advisory-wait-recovery:` marker (#1572). Returns `null` for
 * the legacy 3-field form (no claim/attempt binding) -- callers must treat
 * that as unusable recovery-cycle evidence, not a parse failure to retry.
 */
export function parseAdvisoryRecoveryComment(body, createdAt) {
  const parsed = parseBoundAdvisoryEvidenceMarker(
    'advisory-wait-recovery',
    body,
  );
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    createdAt: isValidIsoTimestamp(createdAt) ? createdAt : 'none',
  };
}
/** Parse a `copilot-unavailable:` terminal marker (#1572). */
export function parseCopilotUnavailableComment(body, createdAt) {
  const parsed = parseBoundAdvisoryEvidenceMarker('copilot-unavailable', body);
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
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
  const marker = OPERATIONAL_MARKERS.find((candidate) =>
    candidate.startPattern.test(normalized),
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
export function normalizeSecondPrecisionIsoTimestamp(value) {
  const timestamp = normalizeIsoTimestamp(value);
  if (!timestamp) {
    return '';
  }
  // Truncate a well-formed fractional-second timestamp (e.g. the millisecond
  // precision `Date#toISOString()` always emits) down to second precision
  // instead of rejecting it outright -- reusing the same canonical
  // truncation `toSecondPrecisionIso` already applies for apply-time "now"
  // values (see the comment below), rather than re-deriving it here.
  const truncated = toSecondPrecisionIso(new Date(timestamp));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(truncated)) {
    return '';
  }
  return truncated;
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
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const normalize = (ts) => ts.replace('.000Z', 'Z');
  return normalize(new Date(time).toISOString()) === normalize(value);
}
// --- Apply-time "now" normalization (#2568) ---
//
// `renderUnclaimedByMarker` and the other operational-marker renderers above
// accept a second-precision `…Z` timestamp, or a well-formed sub-second `…Z`
// value truncated down to one (#2592) -- but throw on anything else (an
// offset form, or an otherwise malformed value). A production `now`
// (`new Date().toISOString()`) always carries millisecond precision. These
// two were independently re-implemented four times across
// `idd-roadmap-audit-execute.mts`, `suitability-close-execute.mts`,
// `provider-outage-park.mts`, and `provider-outage-declaration.mts` before
// being consolidated here as the one canonical, tested implementation every
// caller now imports instead of re-deriving.
/**
 * Strip the fractional-second component `Date#toISOString()` always emits,
 * matching this repository's second-precision operational-marker
 * convention.
 */
export function toSecondPrecisionIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
/**
 * Validate and normalize an apply-time "now" value to UTC second-precision
 * ISO (`YYYY-MM-DDTHH:mm:ssZ`), or `null` when unparseable. Callers that
 * gate a mutation on this value (claim staleness, release markers) must fail
 * closed on `null` BEFORE any mutation: an unparseable value would
 * mis-evaluate staleness (`NaN` comparisons read as not-stale), and an
 * offset form (e.g. `…+09:00`) would otherwise reach
 * `renderUnclaimedByMarker` -- which throws on anything but a (possibly
 * sub-second, per #2592) `…Z` value -- and throw AFTER other side effects
 * (an evidence comment, a close) had already landed. Normalizing through
 * `toISOString()` also converts any
 * zone offset to UTC, so the single normalized value is safe for both the
 * staleness checks and the release marker.
 */
export function normalizeApplyNow(raw) {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return toSecondPrecisionIso(parsed);
}
