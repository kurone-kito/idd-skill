// idd-generated-from: src/scripts/effort.mts
//
// The scripts/effort.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Shared author-recorded effort-hint parsing for discovery selection.
// Consumed by:
//
// - scripts/discover-roadmap-graph.mjs (A2 node enumeration / union rank)
//
// The effort hint is the authored `S | M | L` size estimate defined in
// skills/issue-authoring/references/contract.md. It is a **soft**
// selection tie-breaker only (A4 Step 2, after the suitability score and
// optional desync, before the lowest-issue-number tie-break): it never
// skips, gates, or reorders candidates across suitability score bands,
// and a large issue stays fully claimable when it is the only ready work.
// Like the suitability score it is fail-safe on absence — a missing or
// invalid marker means "no effort hint" and selection behaves exactly as
// it does today.

const DEFAULT_MARKER_PREFIX = 'idd-skill';

/** The authored effort bands, smallest to largest. */
export const EFFORT_HINTS = ['S', 'M', 'L'] as const;

export type EffortHint = (typeof EFFORT_HINTS)[number];

// Ordinal used by the soft tie-breaker (lower = smaller = preferred). A
// missing or invalid hint resolves to the **neutral** middle ordinal so an
// unscored issue is neither preferred over nor de-preferred against an
// equally-ranked `M` issue; this keeps a band with no effort hints ordered
// exactly as today (by lowest issue number).
const EFFORT_ORDINALS: Record<EffortHint, number> = { S: 1, M: 2, L: 3 };
export const NEUTRAL_EFFORT_ORDINAL = 2;

/**
 * Detection shape for the authored effort marker: whether a marker is
 * present at all, its coherent `S | M | L` value or null, and whether the
 * present marker is malformed.
 */
export interface EffortMarkerDetection {
  present: boolean;
  value: EffortHint | null;
  malformed: boolean;
}

/**
 * Canonical parser for the authored `<!-- {prefix}-effort: S|M|L -->`
 * marker.
 *
 * Returns `{ present, value, malformed }`:
 * - `present` is false only when no marker appears in the body.
 * - `value` is the single coherent band (`S`, `M`, or `L`, upper-cased),
 *   or null (fail-safe = "no effort hint") when the marker is absent, not
 *   one of the bands, or repeated with disagreeing values.
 * - `malformed` is true when a marker is present but its value is not a
 *   single coherent band.
 *
 * Mirrors `parseAutopilotSuitabilityMarker` so the regex and fail-safe
 * rules stay aligned between the two authored footers.
 */
export function parseEffortMarker(
  body: unknown,
  markerPrefix: string = DEFAULT_MARKER_PREFIX,
): EffortMarkerDetection {
  const prefix =
    typeof markerPrefix === 'string' && markerPrefix.length > 0
      ? markerPrefix
      : DEFAULT_MARKER_PREFIX;
  const regex = new RegExp(
    `<!--\\s*${escapeRegex(prefix)}-effort:\\s*([^\\s>]+)\\s*-->`,
    'gi',
  );
  const text = String(body ?? '');
  // Stream matches with regex.exec so an untrusted, marker-heavy body stays
  // O(1) memory, and fail fast on the first invalid token or first value
  // that conflicts with an earlier one.
  let present = false;
  let value: EffortHint | null = null;
  let match = regex.exec(text);
  while (match) {
    present = true;
    const normalized = match[1].toUpperCase();
    // Fail-safe: any invalid token, or a value disagreeing with an earlier
    // coherent one, yields no hint.
    if (!isEffortHint(normalized) || (value !== null && normalized !== value)) {
      return { present: true, value: null, malformed: true };
    }
    value = normalized;
    match = regex.exec(text);
  }
  if (!present) {
    return { present: false, value: null, malformed: false };
  }
  return { present: true, value, malformed: false };
}

/**
 * Parse the authored effort hint from an issue body.
 *
 * Returns `S | M | L` when the body carries a single coherent
 * `<!-- {prefix}-effort: … -->` marker, or null (fail-safe = "no effort
 * hint") when the marker is absent, not one of the bands, or present more
 * than once with disagreeing values. A null hint must never cause an issue
 * to be skipped; the caller selects it the normal way. Thin value-only
 * view over {@link parseEffortMarker}.
 */
export function parseEffort(
  body: unknown,
  markerPrefix: string = DEFAULT_MARKER_PREFIX,
): EffortHint | null {
  return parseEffortMarker(body, markerPrefix).value;
}

/**
 * The soft-tie-break ordinal for an effort hint: `S` → 1, `M` → 2,
 * `L` → 3, and any non-hint (null / invalid) → the neutral middle ordinal
 * (2). Lower sorts first, so the A4 Step 2 tie-breaker prefers smaller
 * issues while leaving unscored ones in the middle and never excluding any
 * candidate.
 */
export function effortOrdinal(value: unknown): number {
  return isEffortHint(value)
    ? EFFORT_ORDINALS[value]
    : NEUTRAL_EFFORT_ORDINAL;
}

/** True when `value` is one of the authored effort bands `S | M | L`. */
export function isEffortHint(value: unknown): value is EffortHint {
  return (
    typeof value === 'string' && (EFFORT_HINTS as readonly string[]).includes(value)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
