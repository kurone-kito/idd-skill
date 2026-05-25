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

const DEFAULT_MARKER_PREFIX = "idd-skill";
export const DEFAULT_AUTOPILOT_SUITABILITY_FLOOR = 3;

/**
 * Parse the authored autopilot-suitability score from an issue body.
 *
 * Returns an integer 1-5 when the body carries a single coherent
 * `<!-- {prefix}-autopilot-suitability: N -->` marker. Returns null
 * (fail-safe = "no score") when the marker is absent, non-integer,
 * out of the 1-5 range, or present more than once with disagreeing
 * values. A null score must never cause an issue to be skipped; the
 * caller evaluates it the normal way.
 */
export function parseAutopilotSuitability(body, markerPrefix = DEFAULT_MARKER_PREFIX) {
  const prefix = typeof markerPrefix === "string" && markerPrefix.length > 0
    ? markerPrefix
    : DEFAULT_MARKER_PREFIX;
  const regex = new RegExp(
    `<!--\\s*${escapeRegex(prefix)}-autopilot-suitability:\\s*([^\\s>]+)\\s*-->`,
    "gi",
  );
  const text = String(body ?? "");
  const values = new Set();
  let sawInvalid = false;
  let match = regex.exec(text);
  while (match) {
    const raw = match[1];
    if (/^\d+$/.test(raw)) {
      const value = Number.parseInt(raw, 10);
      if (value >= 1 && value <= 5) {
        values.add(value);
      } else {
        sawInvalid = true;
      }
    } else {
      sawInvalid = true;
    }
    match = regex.exec(text);
  }
  // Fail-safe: any invalid token, or conflicting values, yields no score.
  if (sawInvalid || values.size !== 1) {
    return null;
  }
  return [...values][0];
}

/**
 * Normalize a configured floor to an integer 1-5, falling back to the
 * default (3) for anything out of range or non-integer.
 */
export function normalizeAutopilotSuitabilityFloor(floor) {
  if (Number.isInteger(floor) && floor >= 1 && floor <= 5) {
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
 * - Candidates whose score is present and `< floor` are moved to
 *   `routedToHuman` (kept visible, never discarded), preserving their
 *   original relative order.
 * - The remaining candidates (score `>= floor`, or no score) are
 *   stable-sorted by effective score descending, where a missing
 *   score uses the floor as a neutral baseline so unscored (e.g.
 *   pre-existing) issues are never buried and never skipped.
 *
 * @param {Array} items
 * @param {{floor?: number, enabled?: boolean, getScore: (item: any) => (number|null)}} options
 * @returns {{ranked: Array, routedToHuman: Array}}
 */
export function rankAndRouteBySuitability(items, options = {}) {
  const list = Array.isArray(items) ? [...items] : [];
  const getScore = typeof options.getScore === "function" ? options.getScore : () => null;
  if (options.enabled === false) {
    return { ranked: list, routedToHuman: [] };
  }
  const floor = normalizeAutopilotSuitabilityFloor(options.floor);

  // Compute each item's score exactly once and reuse it for both routing
  // and ranking, so a non-trivial or non-deterministic getScore cannot
  // produce inconsistent decisions. Any non-finite value (null, NaN, …)
  // is treated as "no score".
  const scored = list.map((item, index) => {
    const raw = getScore(item);
    return { item, index, score: Number.isFinite(raw) ? raw : null };
  });

  const routedToHuman = [];
  const eligible = [];
  for (const entry of scored) {
    if (entry.score !== null && entry.score < floor) {
      routedToHuman.push(entry);
    } else {
      eligible.push(entry);
    }
  }

  const ranked = eligible
    .sort((left, right) =>
      ((right.score ?? floor) - (left.score ?? floor)) || (left.index - right.index))
    .map((entry) => entry.item);

  return { ranked, routedToHuman: routedToHuman.map((entry) => entry.item) };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
