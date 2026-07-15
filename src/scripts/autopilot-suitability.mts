// idd-generated-from: src/scripts/autopilot-suitability.mts
//
// The scripts/autopilot-suitability.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Shared autopilot-suitability score parsing and discovery
// ranking/routing. Consumed by:
//
// - scripts/discover-orphan-filter.mjs (A0-O candidate list)
// - scripts/discover-roadmap-graph.mjs (A1.5/A2 node enumeration)
//
// The score is the authored 1-5 autopilot-suitability marker defined
// in skills/issue-authoring/references/contract.md. It is an
// advisory ranking/routing hint only — it never replaces the A4.5
// suitability gate or the A5 claim safety checks, which still run on
// whatever candidate is selected.

const DEFAULT_MARKER_PREFIX = 'idd-skill';
export const DEFAULT_AUTOPILOT_SUITABILITY_FLOOR = 3;

interface RankOptions<T> {
  floor?: number;
  enabled?: boolean;
  routeBelowFloor?: boolean;
  getScore?: (item: T) => number | null;
}

/**
 * Detection shape for the authored autopilot-suitability marker:
 * whether a marker is present at all, its coherent integer value (1-5)
 * or null, and whether the present marker is malformed.
 */
export interface AutopilotSuitabilityMarkerDetection {
  present: boolean;
  value: number | null;
  malformed: boolean;
}

/**
 * Canonical parser for the authored
 * `<!-- {prefix}-autopilot-suitability: N -->` marker.
 *
 * Returns `{ present, value, malformed }`:
 * - `present` is false only when no marker appears in the body.
 * - `value` is the single coherent integer 1-5, or null (fail-safe =
 *   "no score") when the marker is absent, non-integer, out of the 1-5
 *   range, or repeated with disagreeing values.
 * - `malformed` is true when a marker is present but its value is not a
 *   single coherent 1-5 score.
 *
 * `parseAutopilotSuitability` and `idd-doctor` both parse the marker
 * through this one implementation so the regex and fail-safe rules never
 * drift between the discovery rankers and the doctor consistency check.
 */
export function parseAutopilotSuitabilityMarker(
  body: unknown,
  markerPrefix: string = DEFAULT_MARKER_PREFIX,
): AutopilotSuitabilityMarkerDetection {
  const prefix =
    typeof markerPrefix === 'string' && markerPrefix.length > 0
      ? markerPrefix
      : DEFAULT_MARKER_PREFIX;
  const regex = new RegExp(
    `<!--\\s*${escapeRegex(prefix)}-autopilot-suitability:\\s*([^\\s>]+)\\s*-->`,
    'gi',
  );
  const text = String(body ?? '');
  // Stream matches with regex.exec so an untrusted, marker-heavy body
  // stays O(1) memory (no per-match arrays), and fail fast on the first
  // invalid token or first value that conflicts with an earlier one.
  let present = false;
  let value: number | null = null;
  let match = regex.exec(text);
  while (match) {
    present = true;
    const raw = match[1];
    const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
    // Fail-safe: any invalid token, or a value disagreeing with an
    // earlier coherent one, yields no score.
    if (
      !isAutopilotSuitabilityScore(parsed) ||
      (value !== null && parsed !== value)
    ) {
      return { present: true, value: null, malformed: true };
    }
    value = parsed;
    match = regex.exec(text);
  }
  if (!present) {
    return { present: false, value: null, malformed: false };
  }
  return { present: true, value, malformed: false };
}

/**
 * Parse the authored autopilot-suitability score from an issue body.
 *
 * Returns an integer 1-5 when the body carries a single coherent
 * `<!-- {prefix}-autopilot-suitability: N -->` marker. Returns null
 * (fail-safe = "no score") when the marker is absent, non-integer,
 * out of the 1-5 range, or present more than once with disagreeing
 * values. A null score must never cause an issue to be skipped; the
 * caller evaluates it the normal way. Thin value-only view over
 * {@link parseAutopilotSuitabilityMarker}.
 */
export function parseAutopilotSuitability(
  body: unknown,
  markerPrefix: string = DEFAULT_MARKER_PREFIX,
): number | null {
  return parseAutopilotSuitabilityMarker(body, markerPrefix).value;
}

/**
 * Normalize a configured floor to an integer 1-5, falling back to the
 * default (3) for anything out of range or non-integer.
 */
export function normalizeAutopilotSuitabilityFloor(floor: unknown): number {
  if (
    typeof floor === 'number' &&
    Number.isInteger(floor) &&
    floor >= 1 &&
    floor <= 5
  ) {
    return floor;
  }
  return DEFAULT_AUTOPILOT_SUITABILITY_FLOOR;
}

/**
 * Rank a candidate list by autopilot-suitability score and route
 * below-floor candidates out to a human bucket.
 *
 * - `enabled: false` is a kill-switch: the items are returned
 *   unchanged with an empty routedToHuman bucket.
 * - Ranking always runs (when enabled): items are stable-sorted by
 *   effective score descending, where a missing score uses the floor as
 *   a neutral baseline so unscored (e.g. pre-existing) issues are never
 *   buried. Ties keep input order, so callers that need a domain
 *   tie-break (e.g. lowest issue number) pre-sort the input by that key.
 * - Routing is **opt-in** via `routeBelowFloor` (the autopilot-run
 *   behavior). When true, candidates whose score is present and
 *   `< floor` are moved to `routedToHuman` (kept visible, never
 *   discarded). When false (the attended-safe default), below-floor
 *   candidates stay in `ranked` — they simply sort to the bottom by
 *   their real score — so attended discovery never loses a selectable
 *   issue.
 */
export function rankAndRouteBySuitability<T>(
  items: T[],
  options: RankOptions<T> = {},
): { ranked: T[]; routedToHuman: T[] } {
  const list = Array.isArray(items) ? [...items] : [];
  const getScore =
    typeof options.getScore === 'function'
      ? options.getScore
      : (): number | null => null;
  if (options.enabled === false) {
    return { ranked: list, routedToHuman: [] };
  }
  const floor = normalizeAutopilotSuitabilityFloor(options.floor);
  const routeBelowFloor = options.routeBelowFloor === true;

  // Compute each item's score exactly once and reuse it for both routing
  // and ranking, so a non-trivial or non-deterministic getScore cannot
  // produce inconsistent decisions. Defensively normalize here too:
  // anything that is not an integer 1-5 (null, NaN, 0, 6, 2.5, …) is
  // treated as "no score", upholding the fail-safe rule regardless of
  // what the caller's getScore returns.
  const scored = list.map((item, index) => {
    const raw = getScore(item);
    return {
      item,
      index,
      score: isAutopilotSuitabilityScore(raw) ? raw : null,
    };
  });

  const routedToHuman: typeof scored = [];
  const eligible: typeof scored = [];
  for (const entry of scored) {
    if (routeBelowFloor && entry.score !== null && entry.score < floor) {
      routedToHuman.push(entry);
    } else {
      eligible.push(entry);
    }
  }

  const ranked = eligible
    .sort(
      (left, right) =>
        (right.score ?? floor) - (left.score ?? floor) ||
        // Scored-before-unscored at a tie (written A4 Step 2 rule): a
        // genuinely-scored candidate never ranks below an unscored one
        // defaulted to the floor. `entry.score` is already normalized to
        // "coherent 1-5 or null" above, so `!== null` is the same
        // "genuinely scored" notion `compareUnionLeaves` derives from
        // `isAutopilotSuitabilityScore`, reused rather than reimplemented.
        // Applied before the caller's pre-sorted index order (which
        // carries the effort-hint / issue-number tie-breakers), so those
        // softer tie-breakers never outrank a real score.
        Number(right.score !== null) - Number(left.score !== null) ||
        left.index - right.index,
    )
    .map((entry) => entry.item);

  return { ranked, routedToHuman: routedToHuman.map((entry) => entry.item) };
}

/**
 * True when `value` is a valid authored autopilot-suitability score:
 * an integer in the inclusive range 1-5.
 */
export function isAutopilotSuitabilityScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
