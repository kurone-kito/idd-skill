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
//
// cspell:ignore approv decid judg
//
// This module also holds the shared provisional-choice plan assessment
// (#4535) that A4 (discover-viability-gate) and A4.5 (suitability-triage)
// both read, so one normalized policy/plan evidence object drives both.

import { createHash } from 'node:crypto';
import { maskMarkdownForScan } from './markdown-code.mts';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
export const DEFAULT_AUTOPILOT_SUITABILITY_FLOOR = 3;

interface RankOptions<T> {
  floor?: number;
  enabled?: boolean;
  routeBelowFloor?: boolean;
  getScore?: (item: T) => number | null;
  getEffort?: (item: T) => 'S' | 'M' | 'L' | null;
  routeEffortL?: boolean;
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
 *
 * The body is masked with {@link maskMarkdownForScan} before the scan
 * (#3281; originally {@link stripMarkdownCodeRegions}), so a marker
 * merely *quoted* in prose (inside backticks, a fenced block, or an
 * indented code block — for example an issue describing this marker's
 * own syntax) cannot be mistaken for a real one and poison an otherwise
 * valid footer marker elsewhere in the body (#1614, mirroring #1121's
 * identical fix for the `roadmap-id` marker).
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
  const text = maskMarkdownForScan(String(body ?? ''));
  // Stream matches with regex.exec instead of matchAll so an untrusted,
  // marker-heavy body avoids per-match array allocation, and fail fast
  // on the first invalid token or first value that conflicts with an
  // earlier one.
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
 * - `enabled: false` is a kill-switch for score ranking and below-floor
 *   routing: the items are returned unchanged with an empty routedToHuman
 *   bucket, apart from the effort-`L` routing described next.
 * - Effort-`L` routing (#4199) is opt-in via `routeEffortL` together with
 *   `getEffort`: every item whose effort is `L` moves to `routedToHuman`,
 *   in input order, even when `enabled` is false, because effort is a
 *   separate axis from the score. Without both options, nothing changes.
 * - Ranking always runs (when enabled): items are stable-sorted by
 *   effective score descending, where a missing score uses the floor as
 *   a neutral baseline so unscored (e.g. pre-existing) issues are never
 *   buried. At a tied effective score, a genuinely-scored candidate
 *   always ranks above an unscored one defaulted to the floor (the
 *   written A4 Step 2 "scored-vs-unscored floor tie-breaker" rule,
 *   matching `compareUnionLeaves` in discover-roadmap-graph.mts). Beyond
 *   that scored-vs-unscored split, ties keep input order, so callers
 *   that need a domain tie-break (e.g. effort hint, lowest issue number)
 *   pre-sort the input by that key.
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
  // Effort-L routing (#4199) needs both options; effort is a separate axis
  // from the score, so it applies before the kill-switch below.
  const routeEffortL = options.routeEffortL === true;
  const isEffortLRouted = (item: T): boolean =>
    routeEffortL && options.getEffort?.(item) === 'L';
  if (options.enabled === false) {
    const kept: T[] = [];
    const routed: T[] = [];
    for (const item of list) {
      (isEffortLRouted(item) ? routed : kept).push(item);
    }
    return { ranked: kept, routedToHuman: routed };
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
    if (
      isEffortLRouted(entry.item) ||
      (routeBelowFloor && entry.score !== null && entry.score < floor)
    ) {
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

/**
 * Resolve the opt-in `autopilotSuitability.effortL` policy from a raw
 * config object. Returns `'refuse'` only when the field is exactly the
 * string `'refuse'`; a missing field, a non-object config or section,
 * `null`, or any other value resolves to `'allow'` (the distributed
 * default), so repositories that never set the key keep today's behavior.
 */
export function resolveEffortLPolicy(config: unknown): 'allow' | 'refuse' {
  if (typeof config !== 'object' || config === null) {
    return 'allow';
  }
  const section = (config as { autopilotSuitability?: unknown })
    .autopilotSuitability;
  if (typeof section !== 'object' || section === null) {
    return 'allow';
  }
  return (section as { effortL?: unknown }).effortL === 'refuse'
    ? 'refuse'
    : 'allow';
}

// ---------------------------------------------------------------------------
// Provisional choice plan assessment (#4535, roadmaps #4528 and #4955)
//
// A4 and A4.5 ask one question about a needs-decision source: may it advance
// to the claim-and-record path under the provisional-decision feature? The
// session compares the options and writes a structured plan. This code only
// validates that plan against the trusted policy report, the replayed record
// state and the issue itself. It never ranks options, never fills a missing
// recommendation or a missing measurement, and never edits the authored
// score. The trusted report, the replay state and the plan are injected, so
// the module reads no policy, calls no API and gains no import.
// ---------------------------------------------------------------------------

/** Where an assessed source goes next. Only `claim-and-record` relaxes anything. */
export type ProvisionalRoute =
  | 'claim-and-record'
  | 'current-route'
  | 'no-new-execution';

/** One precise reason the existing route stays. */
export interface ProvisionalBlocker {
  code: string;
  detail: string;
}

export interface ProvisionalPlanOption {
  id: string;
  description: string;
  feasibilityRationale: string;
  requirementFit: string;
  consequences: string;
  verification: string;
  reversalOrMigration: string;
}

/** One choice, in the shape of the `selected` event of the decision record. */
export interface ProvisionalPlanChoice {
  question: string;
  selectedOption: ProvisionalPlanOption & { rationale: string };
  feasibleAlternatives: (ProvisionalPlanOption & {
    comparison: string;
    rejectionReason: string;
  })[];
  executionCriteria: string[];
}

export interface ProvisionalNormalizedPlan {
  schemaVersion: 1;
  source: { repository: string; issueNumber: number; bodySha256: string };
  /** The original human-choice criteria, kept pending (never satisfied here). */
  humanChoiceCriteria: { text: string; status: 'pending' }[];
  recordedChoices: { reference: string; summary: string }[];
  choices: ProvisionalPlanChoice[];
  deliverables: { kind: string; target: string; purpose: string }[];
  evidence: string[];
  resolvedEvidenceGaps: {
    description: string;
    measurement: string;
    result: string;
    reference: string;
  }[];
  suitability: {
    lowScoreCause: 'none' | 'input-choice-only' | 'independent';
    reassessedScore: number | null;
    rationale: string | null;
  };
}

export type ProvisionalScoreRoute =
  | 'at-or-above-floor'
  | 'no-score'
  | 'ranking-disabled'
  | 'reassessed-with-plan'
  | 'below-floor';

export interface ProvisionalAssessment {
  eligible: boolean;
  route: ProvisionalRoute;
  blockers: ProvisionalBlocker[];
  policy: {
    decisionIssue: 'enabled' | 'master-off' | 'class-off' | 'unreadable';
    maxDecisionsPerClaim: number | null;
  };
  caps: {
    choices: number | null;
    /** What the latest bundle holds after selection; a fresh assessment starts a new bundle. */
    decisionGenerationsAfterSelection: number | null;
    maxDecisionsPerClaim: number | null;
  };
  score: {
    authored: number | null;
    floor: number;
    route: ProvisionalScoreRoute;
    reassessed: number | null;
  };
  source: { issueNumber: number; bodySha256: string };
  /** The auditable candidate plan; present only when `eligible`. */
  plan: ProvisionalNormalizedPlan | null;
  pendingHumanCriteria: string[];
  /** Persist and verify the `selected` record after ownership, before execution. */
  nextStep: 'claim-then-persist-selection' | null;
}

export interface ProvisionalAssessmentInput {
  issue: {
    number: number;
    body: string;
    labels?: readonly string[];
  };
  /** `owner/repo` when known; a plan that names another repository is stale. */
  repository?: string | null;
  needsDecisionLabelName: string;
  /** The fresh trusted read of the auto-decide classes (`readTrustedAutoDecide`). */
  policy: unknown;
  /** The replayed provisional record state of the source. */
  state: unknown;
  /** The session's structured plan; `undefined` when none was supplied. */
  plan: unknown;
  /** Whether the body already records an operator choice (a resolved decision). */
  bodyRecordsOperatorChoice?: boolean;
  /**
   * The paths the source declares under `## Candidate files`, as written.
   * When there are any, every file deliverable must be one of them, so the
   * plan cannot widen a decision-only source into other code changes.
   */
  candidateFiles?: readonly string[];
  /** Whether the body has a `## Candidate files` section at all. */
  candidateFilesDeclared?: boolean;
  authoredScore: number | null;
  floor: number;
  /** `false` is the ranking kill-switch; no floor routing applies. */
  suitabilityEnabled?: boolean;
  effort: 'S' | 'M' | 'L' | null;
  effortLPolicy: 'allow' | 'refuse';
}

/**
 * Edit-surface limit per effort hint. It mirrors `EFFORT_CANDIDATE_FILE_LIMITS`
 * in `audit-authored-issue.mts`, which cannot be imported here without an
 * import cycle (that module imports both A4 evaluators). A test pins the two
 * together.
 */
export const PROVISIONAL_SURFACE_LIMITS: Readonly<Record<'S' | 'M', number>> =
  Object.freeze({ S: 3, M: 8 });

const PROVISIONAL_PLAN_SCHEMA_VERSION = 1;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SELECTED_OPTION_KEYS = [
  'id',
  'description',
  'feasibilityRationale',
  'requirementFit',
  'consequences',
  'verification',
  'reversalOrMigration',
  'rationale',
] as const;
const ALTERNATIVE_OPTION_KEYS = [
  'id',
  'description',
  'feasibilityRationale',
  'requirementFit',
  'consequences',
  'verification',
  'reversalOrMigration',
  'comparison',
  'rejectionReason',
] as const;
// A source whose gaps a choice could cause names that choice somewhere in its
// body. Without any of these words the label alone does not make it a decision
// source for the purpose of relaxing a check.
const DECISION_SIGNAL_PATTERN =
  /(?<![\w-])(?:decision|decid\w*|choose|chosen|choice|options?|alternatives?|whether|tbd|undecided|open question|trade-?offs?|prefer\w*)(?![\w-])/i;
const DELIVERABLE_KINDS = ['file', 'document', 'issue-comment'];
// An execution criterion must be checkable without a person's opinion.
const SUBJECTIVE_CRITERION_PATTERN =
  /(?<![\w-])(?:feels?|looks? (?:good|right)|opinion|subjective|maintainer (?:approv\w*|prefer\w*|sign-?off|review\w*)|stakeholder|human (?:review|judg\w*|approv\w*)|manual (?:review|approval))(?![\w-])/i;
// A clause naming one of these is an approval, an external action or a
// security matter, never a product choice (#4535: judged by the actual
// requirement, not by the needs-decision label alone).
const AUTHORITY_REQUIREMENT_PATTERN =
  /(?<![\w-])(?:approv\w*|sign-?off|permissions?|authori[sz]\w*|credentials?|secrets?|tokens?|passwords?|api[- ]keys?|access|production|third-?party|external|legal|compliance|budget|vendor)(?![\w-])/i;
// A clause ends at `!`, `?`, `;`, a blank line, a list marker, or a full stop
// that ends a sentence (followed by a capital letter or the end of the text).
// A full stop inside "i.e.", "docs/x.md" or "v1.2" is not an end, so an
// authority word after one is still in the same clause: it fails closed.
const DECISION_CLAUSE_BREAK_PATTERN =
  /[!?;]|\.(?=\s+[A-Z]|\s*$)|\n[ \t]*\n|\n[ \t]*(?:[-*+]|\d+[.)])[ \t]/g;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * True when the text match at `[index, index + length)` is a decision-caused
 * signal: its own clause names no approval, sign-off, permission, credential,
 * secret, token, access, production, external, legal, compliance, budget or
 * vendor requirement. Both evaluators relax a decision phrase only through
 * this one test, and judge each phrase on its own, so a later credential or
 * sign-off phrase in the same body still fails.
 */
export function isDecisionCausedSignal(
  text: string,
  index: number,
  length: number,
): boolean {
  // The clause runs from the last break before the phrase to the first break
  // after it, found in the whole text, so no window can cut an authority word
  // off and a full stop is judged by what follows it, not by a slice's end.
  let start = 0;
  let end = text.length;
  for (const found of text.matchAll(DECISION_CLAUSE_BREAK_PATTERN)) {
    const at = found.index ?? 0;
    if (at + found[0].length <= index) {
      start = at + found[0].length;
    } else if (at >= index + length) {
      end = at;
      break;
    }
  }
  return !AUTHORITY_REQUIREMENT_PATTERN.test(text.slice(start, end));
}

// Approval-type words, used with a requirement cue to find a standing
// approval, sign-off or authorization requirement in any sentence. Broader
// authority vocabulary (credentials, access, production) stays in the clause
// test above and in A4's own patterns.
const APPROVAL_WORD_PATTERN =
  /(?<![\w-])(?:approv\w*|sign(?:s|ed|ing)?[- ]?off|authori[sz]\w*|permissions?|consent|go-ahead|grant(?:s|ed)?\s+(?:access|permission))(?![\w-])/i;
const REQUIREMENT_CUE_PATTERN =
  /(?<![\w-])(?:needs?|needed|requires?|required|requiring|requirement|must|has to|have to|pending|awaiting|awaits?|subject to|gated|blocked|depends?|until|mandatory|prerequisite|first|before|gates?|obtain|secure|seek|get|ask|wait(?:ing)?|contingent|conditional|dependent|unless|necessary|essential|compulsory|obligatory|imperative)(?![\w-])|(?<![\w-])(?:cannot|can't|do not|don't|must not|never|not)\s+(?:\w+\s+){0,4}?without(?![\w-])/i;
// A phrase that denies the approval requirement itself. A bare "not" or "no"
// elsewhere in the sentence does not count: "Do not proceed until legal
// approval is granted" and "requires legal approval, not just passing tests"
// still state the requirement. Each alternative ties the negation to the
// requirement verb and the approval word, and "without" never denies one
// ("do not ship without approval" asks for it).
const APPROVAL_WORD_SOURCE =
  '(?:approv\\w*|sign(?:s|ed|ing)?[- ]?off|authori[sz]\\w*|permissions?|consent|grant(?:s|ed)?\\s+(?:access|permission))';
// One word that is not a contrast or a join, so a denial never reaches across
// "but requires" or "and requires" into a requirement of its own.
const PLAIN_WORD = String.raw`(?:(?!(?:but|however|yet|although|though|while|whereas|except|and|then)\b)\w+\s+)`;
const NEGATED_REQUIREMENT_PATTERN = new RegExp(
  [
    // "does not need any approval", "doesn't require explicit sign-off"
    String.raw`(?<![\w-])(?:(?:does|do|did|will|would|should|shall|can|could)\s+not|doesn't|don't|didn't|won't|wouldn't)\s+(?:really\s+|actually\s+)?(?:need|require)\s+${PLAIN_WORD}{0,4}?${APPROVAL_WORD_SOURCE}`,
    // "requires no approval", "needs zero sign-off"
    String.raw`(?<![\w-])(?:needs?|needed|requires?|required|requiring)\s+(?:no|zero)\s+${PLAIN_WORD}{0,3}?${APPROVAL_WORD_SOURCE}`,
    // "no approval is needed", "approval is not required"
    String.raw`(?<![\w-])no\s+${PLAIN_WORD}{0,3}?${APPROVAL_WORD_SOURCE}\s+(?:is|are|will\s+be)\s+(?:needed|required|necessary)`,
    String.raw`(?<![\w-])${APPROVAL_WORD_SOURCE}\s+(?:is|are|will\s+be)\s+not\s+(?:needed|required|necessary)`,
    // "nothing here needs sign-off"
    String.raw`(?<![\w-])(?:nothing|none)\b[^.;]{0,60}?\b(?:needs?|requires?)\s+${PLAIN_WORD}{0,3}?${APPROVAL_WORD_SOURCE}`,
  ].join('|'),
  'gi',
);

// A person or body that can give an approval. An approval word next to one of
// these, within a few words, is a dependency on that person; the same word in
// "the authorization parser" or "the approval state machine" is software.
const APPROVER_SOURCE =
  '(?:users?|maintainers?|owners?|reviewers?|legal|teams?|stakeholders?|managers?|admins?|administrators?|operators?|humans?|persons?|people|customers?|security|approvers?|committee|board|leads?|counsel|officers?)';
const APPROVER_ADJACENT_PATTERN = new RegExp(
  [
    String.raw`(?<![\w-])${APPROVER_SOURCE}\s+(?:\w+\s+){0,2}?${APPROVAL_WORD_SOURCE}`,
    String.raw`(?<![\w-])${APPROVAL_WORD_SOURCE}\s+(?:\w+\s+){0,2}?(?:by|from)\s+(?:the\s+|a\s+)?${APPROVER_SOURCE}`,
  ].join('|'),
  'i',
);

// "requires approval", "needs sign-off", "obtain consent" and the like: a verb
// of needing, getting or waiting, then the approval word within a few words.
// "must reject" and "returns false" are not such verbs, so a criterion about
// approval software ("the authorization parser must reject an unknown role")
// is not caught.
const NEEDS_APPROVAL_PATTERN = new RegExp(
  [
    String.raw`(?<![\w-])(?:require[sd]?|requiring|needs?|needed|awaiting|awaits?|pending|obtain|obtaining|get|seek|ask|wait(?:ing)?\s+for)\s+(?:\w+\s+){0,3}?${APPROVAL_WORD_SOURCE}`,
    String.raw`(?<![\w-])${APPROVAL_WORD_SOURCE}\s+(?:is|are|will\s+be)\s+(?:required|needed|necessary|pending|essential|mandatory)`,
  ].join('|'),
  'i',
);

/**
 * True when `text` depends on an approval, sign-off or authorization that no
 * phrase in it denies: it needs one, or ties the approval to a person or body
 * that gives it. An execution criterion must be checkable by the agent, so
 * such a text is not objective, whatever its verb. A criterion about approval
 * software ("the authorization parser must reject an unknown role") is not
 * one.
 */
function mentionsApproval(text: string): boolean {
  const remaining = text.replace(NEGATED_REQUIREMENT_PATTERN, ' ');
  return (
    NEEDS_APPROVAL_PATTERN.test(remaining) ||
    APPROVER_ADJACENT_PATTERN.test(remaining)
  );
}

// A credential, a secret or production access that the work waits for: a verb
// of supplying, getting or needing, then the term within a few words, or the
// term followed by "is required". "The token parser rejects an expired token"
// names no prerequisite.
const CREDENTIAL_TERM_SOURCE =
  '(?:credentials?|secrets?|api[- ]keys?|passwords?|access\\s+tokens?|production\\s+access|third-?party\\s+access)';
const NEEDS_CREDENTIAL_PATTERN = new RegExp(
  [
    String.raw`(?<![\w-])(?:supply|supplies|supplied|provide[sd]?|providing|obtain|obtaining|get|receive[sd]?|request(?:s|ed|ing)?|ask(?:s|ed|ing)?(?:\\s+for)?|secure[sd]?|require[sd]?|requiring|needs?|needed|awaiting|awaits?|wait(?:ing)?\s+for)\s+(?:\w+\s+){0,3}?${CREDENTIAL_TERM_SOURCE}`,
    String.raw`(?<![\w-])${CREDENTIAL_TERM_SOURCE}\s+(?:is|are|will\s+be)\s+(?:required|needed|necessary|pending|essential|mandatory)`,
  ].join('|'),
  'i',
);

/** True when `text` makes a credential, secret or production access a prerequisite. */
function needsCredential(text: string): boolean {
  return NEEDS_CREDENTIAL_PATTERN.test(text);
}

/**
 * The first sentence of `text` that states an approval, sign-off or
 * authorization requirement, or `null`. A sentence qualifies when it holds an
 * approval word and a requirement cue, in either order and at any distance.
 * A phrase that denies the requirement itself ("does not need any approval")
 * is set aside first, so a prohibition or a contrast that merely holds a
 * "not" still counts, and a negation in another sentence never cancels it.
 * Pass text with code spans already masked. It is a safety net
 * under a provisional relaxation, never a parser: the plan's
 * `independentObstacles` is where a session declares such a requirement.
 */
export function findApprovalRequirementSentence(source: string): string | null {
  // A link destination or a bare URL holds `?`, `;` and `.` that are not
  // sentence ends; drop them and keep the link text.
  const text = source
    .replace(/\]\([^)\n]*\)/g, ']')
    .replace(/https?:\/\/\S+/gi, ' ');
  let start = 0;
  const sentences: string[] = [];
  for (const found of text.matchAll(DECISION_CLAUSE_BREAK_PATTERN)) {
    sentences.push(text.slice(start, found.index ?? 0));
    start = (found.index ?? 0) + found[0].length;
  }
  sentences.push(text.slice(start));
  return (
    sentences.find((sentence) => {
      const remaining = sentence.replace(NEGATED_REQUIREMENT_PATTERN, ' ');
      return (
        APPROVAL_WORD_PATTERN.test(remaining) &&
        REQUIREMENT_CUE_PATTERN.test(remaining)
      );
    }) ?? null
  );
}

// Every assessment that assessProvisionalChoicePlan returns, so a hand-built
// object of the same shape never relaxes a check.
const ASSESSED = new WeakSet<object>();

/**
 * True only for a fully clean assessment, made by assessProvisionalChoicePlan
 * in this process, that was computed for this very
 * issue: its source number and body SHA-256 must match `issue`. Anything else
 * relaxes nothing, so an assessment of one source or one body snapshot never
 * relaxes another.
 */
export function isEligibleProvisionalAssessment(
  value: unknown,
  issue: { number: number; body: string },
): value is ProvisionalAssessment {
  if (
    !(
      isPlainRecord(value) &&
      ASSESSED.has(value) &&
      value.eligible === true &&
      value.route === 'claim-and-record' &&
      Array.isArray(value.blockers) &&
      value.blockers.length === 0 &&
      isPlainRecord(value.plan) &&
      isPlainRecord(value.source)
    )
  ) {
    return false;
  }
  return (
    value.source.issueNumber === issue.number &&
    value.source.bodySha256 ===
      createHash('sha256')
        .update(String(issue.body ?? ''), 'utf8')
        .digest('hex')
  );
}

/** Reads the trusted `decisionIssue` verdict and cap from the injected report. */
function readProvisionalPolicy(report: unknown): {
  verdict: ProvisionalAssessment['policy']['decisionIssue'];
  cap: number | null;
} {
  if (!isPlainRecord(report) || report.status !== 'readable') {
    return { verdict: 'unreadable', cap: null };
  }
  const classes = isPlainRecord(report.classes) ? report.classes : null;
  const verdict = classes?.decisionIssue;
  const cap = report.maxDecisionsPerClaim;
  return {
    verdict:
      verdict === 'enabled' ||
      verdict === 'master-off' ||
      verdict === 'class-off'
        ? verdict
        : 'unreadable',
    cap:
      typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 ? cap : null,
  };
}

function stripLeadingDotSlash(path: string): string {
  return path.trim().replace(/^(?:\.\/)+/, '');
}

function normalizeForExcerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function optionDistinctKey(description: string): string {
  return description.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * What the plan reader found. `issues` are structural problems (a wrong shape,
 * a missing or unknown key). `findings` are semantic and each carries its own
 * blocker code: an evidence gap, a measurement that was not run, an obstacle other than
 * the input choice, a recorded choice that the plan does not respect.
 */
interface PlanReaderState {
  issues: string[];
  findings: ProvisionalBlocker[];
}

function readExactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  state: PlanReaderState,
): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    state.issues.push(`${path} must be an object`);
    return null;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      state.issues.push(`${path}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      state.issues.push(`${path}.${key} is not allowed`);
    }
  }
  return value;
}

function readText(
  value: unknown,
  path: string,
  state: PlanReaderState,
): string {
  const text = nonEmptyText(value);
  if (text === null) {
    state.issues.push(`${path} must be a non-empty string`);
    return '';
  }
  return text;
}

function readArray(
  value: unknown,
  path: string,
  state: PlanReaderState,
): unknown[] {
  if (Array.isArray(value)) return value;
  state.issues.push(`${path} must be an array`);
  return [];
}

function readTextList(
  value: unknown,
  path: string,
  state: PlanReaderState,
): string[] {
  return readArray(value, path, state).map((item, position) =>
    readText(item, `${path}[${position}]`, state),
  );
}

function readOption<K extends readonly string[]>(
  value: unknown,
  path: string,
  keys: K,
  state: PlanReaderState,
): Record<K[number], string> {
  const record = readExactObject(value, path, keys, [], state);
  const out = {} as Record<K[number], string>;
  for (const key of keys) {
    out[key as K[number]] = readText(record?.[key], `${path}.${key}`, state);
  }
  return out;
}

function readChoice(
  value: unknown,
  path: string,
  state: PlanReaderState,
): ProvisionalPlanChoice {
  const entry = readExactObject(
    value,
    path,
    ['question', 'selectedOption', 'feasibleAlternatives', 'executionCriteria'],
    [],
    state,
  );
  return {
    question: readText(entry?.question, `${path}.question`, state),
    selectedOption: readOption(
      entry?.selectedOption,
      `${path}.selectedOption`,
      SELECTED_OPTION_KEYS,
      state,
    ),
    feasibleAlternatives: readArray(
      entry?.feasibleAlternatives,
      `${path}.feasibleAlternatives`,
      state,
    ).map((alternative, position) =>
      readOption(
        alternative,
        `${path}.feasibleAlternatives[${position}]`,
        ALTERNATIVE_OPTION_KEYS,
        state,
      ),
    ),
    executionCriteria: readTextList(
      entry?.executionCriteria,
      `${path}.executionCriteria`,
      state,
    ),
  };
}

function readDeliverable(
  value: unknown,
  path: string,
  state: PlanReaderState,
): ProvisionalNormalizedPlan['deliverables'][number] {
  const entry = readExactObject(
    value,
    path,
    ['kind', 'target', 'purpose'],
    [],
    state,
  );
  const kind = readText(entry?.kind, `${path}.kind`, state);
  const target = readText(entry?.target, `${path}.target`, state);
  if (kind !== '' && !DELIVERABLE_KINDS.includes(kind)) {
    state.issues.push(
      `${path}.kind must be one of ${DELIVERABLE_KINDS.join(', ')}`,
    );
  }
  if (
    kind === 'file' &&
    (target.startsWith('/') ||
      /(?:^|[\\/])\.\.(?:[\\/]|$)|[\\`\n]/.test(target))
  ) {
    state.issues.push(`${path}.target must be a repository-relative path`);
  }
  return {
    kind,
    target,
    purpose: readText(entry?.purpose, `${path}.purpose`, state),
  };
}

/**
 * Reads one evidence gap. A gap closes only through an authorized measurement
 * that was actually run, with its result and the reference that proves the
 * run; every other state is a blocker, and a result is never taken on trust.
 */
function readEvidenceGap(
  value: unknown,
  path: string,
  state: PlanReaderState,
): ProvisionalNormalizedPlan['resolvedEvidenceGaps'][number] | null {
  const entry = readExactObject(
    value,
    path,
    ['description'],
    ['measurement'],
    state,
  );
  const description = readText(
    entry?.description,
    `${path}.description`,
    state,
  );
  const find = (code: string, detail: string): null => {
    state.findings.push({ code, detail: `${detail}: ${description}` });
    return null;
  };
  if (entry?.measurement === undefined) {
    return find('evidence-gap', 'an evidence gap has no measurement');
  }
  const measurement = readExactObject(
    entry.measurement,
    `${path}.measurement`,
    ['description', 'authorized', 'status'],
    ['result', 'reference'],
    state,
  );
  const measurementText = readText(
    measurement?.description,
    `${path}.measurement.description`,
    state,
  );
  const status = measurement?.status;
  const result = nonEmptyText(measurement?.result);
  const reference = nonEmptyText(measurement?.reference);
  if (measurement?.authorized !== true) {
    return find('evidence-gap', 'the measurement for a gap is not authorized');
  }
  if (status === 'unavailable') {
    return find(
      'measurement-unavailable',
      'the needed measurement is unavailable',
    );
  }
  if (status === 'proposed' && result === null) {
    return find(
      'measurement-needed',
      'an authorized measurement is proposed but not run; run it, then reassess',
    );
  }
  if (status !== 'run' || result === null || reference === null) {
    return find(
      'measurement-unverified',
      'a measurement result is claimed without a run and its reference',
    );
  }
  return { description, measurement: measurementText, result, reference };
}

function readSuitability(
  value: unknown,
  state: PlanReaderState,
): ProvisionalNormalizedPlan['suitability'] {
  const none: ProvisionalNormalizedPlan['suitability'] = {
    lowScoreCause: 'none',
    reassessedScore: null,
    rationale: null,
  };
  if (value === undefined) return none;
  const entry = readExactObject(
    value,
    'plan.suitability',
    ['lowScoreCause'],
    ['reassessedScore', 'rationale'],
    state,
  );
  const cause = entry?.lowScoreCause;
  if (
    cause !== 'none' &&
    cause !== 'input-choice-only' &&
    cause !== 'independent'
  ) {
    state.issues.push(
      'plan.suitability.lowScoreCause must be none, input-choice-only or independent',
    );
    return none;
  }
  const reassessed = entry?.reassessedScore;
  return {
    lowScoreCause: cause,
    reassessedScore: isAutopilotSuitabilityScore(reassessed)
      ? reassessed
      : null,
    rationale: nonEmptyText(entry?.rationale),
  };
}

/**
 * Validates the plan's structure and returns its normalized form, or `null`
 * when it is not even an object. Findings land in `state`; the caller turns
 * them into blockers.
 */
function readProvisionalPlan(
  raw: unknown,
  state: PlanReaderState,
): ProvisionalNormalizedPlan | null {
  const record = readExactObject(
    raw,
    'plan',
    [
      'schemaVersion',
      'source',
      'humanChoiceCriteria',
      'recordedChoices',
      'choices',
      'deliverables',
      'evidence',
      'evidenceGaps',
      'independentObstacles',
    ],
    ['suitability'],
    state,
  );
  if (record === null) return null;
  if (record.schemaVersion !== PROVISIONAL_PLAN_SCHEMA_VERSION) {
    state.issues.push(
      `plan.schemaVersion must be ${PROVISIONAL_PLAN_SCHEMA_VERSION}`,
    );
  }
  const source = readExactObject(
    record.source,
    'plan.source',
    ['repository', 'issueNumber', 'bodySha256'],
    [],
    state,
  );
  const issueNumber = source?.issueNumber;
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber)) {
    state.issues.push('plan.source.issueNumber must be an integer');
  }
  const bodySha256 = readText(
    source?.bodySha256,
    'plan.source.bodySha256',
    state,
  );
  if (bodySha256 !== '' && !SHA256_HEX_PATTERN.test(bodySha256)) {
    state.issues.push('plan.source.bodySha256 must be 64 lowercase hex digits');
  }
  const recordedChoices = readArray(
    record.recordedChoices,
    'plan.recordedChoices',
    state,
  ).map((item, position) => {
    const path = `plan.recordedChoices[${position}]`;
    const entry = readExactObject(
      item,
      path,
      ['reference', 'summary', 'respected'],
      [],
      state,
    );
    if (entry?.respected !== true) {
      state.findings.push({
        code: 'recorded-choice-contradicted',
        detail: `${path} is not respected by the plan`,
      });
    }
    return {
      reference: readText(entry?.reference, `${path}.reference`, state),
      summary: readText(entry?.summary, `${path}.summary`, state),
    };
  });
  const resolvedEvidenceGaps = readArray(
    record.evidenceGaps,
    'plan.evidenceGaps',
    state,
  ).flatMap((item, position) => {
    const gap = readEvidenceGap(item, `plan.evidenceGaps[${position}]`, state);
    return gap === null ? [] : [gap];
  });
  for (const obstacle of readTextList(
    record.independentObstacles,
    'plan.independentObstacles',
    state,
  )) {
    state.findings.push({
      code: 'independent-obstacle',
      detail: `an obstacle other than the input choice remains: ${obstacle}`,
    });
  }
  return {
    schemaVersion: PROVISIONAL_PLAN_SCHEMA_VERSION,
    source: {
      repository: readText(source?.repository, 'plan.source.repository', state),
      issueNumber: typeof issueNumber === 'number' ? issueNumber : 0,
      bodySha256,
    },
    humanChoiceCriteria: readTextList(
      record.humanChoiceCriteria,
      'plan.humanChoiceCriteria',
      state,
    ).map((text) => ({ text, status: 'pending' as const })),
    recordedChoices,
    choices: readArray(record.choices, 'plan.choices', state).map(
      (item, position) => readChoice(item, `plan.choices[${position}]`, state),
    ),
    deliverables: readArray(
      record.deliverables,
      'plan.deliverables',
      state,
    ).map((item, position) =>
      readDeliverable(item, `plan.deliverables[${position}]`, state),
    ),
    evidence: readTextList(record.evidence, 'plan.evidence', state),
    resolvedEvidenceGaps,
    suitability: readSuitability(record.suitability, state),
  };
}

/**
 * The conditions that keep the current route before any plan is read: the
 * class is not enabled or its cap is unreadable, the record state cannot be
 * replayed or already holds provisional records, the source is not a
 * needs-decision source, or effort L is refused.
 */
function provisionalPreconditionBlockers(
  input: ProvisionalAssessmentInput,
  policy: ReturnType<typeof readProvisionalPolicy>,
): ProvisionalBlocker[] {
  const blockers: ProvisionalBlocker[] = [];
  const block = (code: string, detail: string): void => {
    blockers.push({ code, detail });
  };
  if (policy.verdict === 'master-off') {
    block(
      'master-off',
      'dangerouslyAutoDecide is not true in the trusted policy',
    );
  } else if (policy.verdict === 'class-off') {
    block(
      'class-off',
      'the decisionIssue class is not enabled in the trusted policy',
    );
  } else if (policy.verdict === 'unreadable') {
    block(
      'policy-unreadable',
      'the trusted auto-decide policy could not be read',
    );
  } else if (policy.cap === null) {
    block(
      'cap-unreadable',
      'maxDecisionsPerClaim could not be read from the trusted policy',
    );
  }
  const state = input.state;
  if (
    !isPlainRecord(state) ||
    state.valid !== true ||
    typeof state.hasRecords !== 'boolean'
  ) {
    block(
      'state-unreadable',
      'the provisional record state could not be replayed',
    );
  } else {
    const decisions = Array.isArray(state.decisions) ? state.decisions : [];
    const awaitingConfirmation =
      state.status === 'confirmation-pending' ||
      decisions.some(
        (decision) =>
          isPlainRecord(decision) && decision.status === 'confirmation-pending',
      );
    if (awaitingConfirmation) {
      // Checked whether or not `hasRecords` says so: a source awaiting
      // confirmation never starts anything new.
      block(
        'pending-confirmation',
        'the recorded provisional work is complete and awaits confirmation; nothing executes again',
      );
    } else if (state.hasRecords) {
      block(
        'existing-provisional-records',
        'the source already has provisional records; Resume owns that state, not a fresh assessment',
      );
    } else if (
      (state.status !== undefined && state.status !== 'none') ||
      decisions.length > 0
    ) {
      block(
        'state-unreadable',
        'the provisional record state is inconsistent: it reports a status or decisions without records',
      );
    }
  }
  const wanted = input.needsDecisionLabelName.trim().toLowerCase();
  if (
    !(input.issue.labels ?? []).some((l) => l.trim().toLowerCase() === wanted)
  ) {
    block(
      'not-a-needs-decision-source',
      `the source does not carry the ${input.needsDecisionLabelName} label`,
    );
  }
  if (
    !DECISION_SIGNAL_PATTERN.test(
      maskMarkdownForScan(String(input.issue.body ?? ''), {
        htmlComments: 'mask',
      }),
    )
  ) {
    block(
      'no-decision-signal',
      'the source body names no choice, so its gaps are not caused by one',
    );
  }
  if (input.effort === 'L' && input.effortLPolicy === 'refuse') {
    block(
      'effort-refused',
      'effort L is refused by autopilotSuitability.effortL',
    );
  }
  return blockers;
}

/** The findings about a structurally valid plan, each with its own code. */
function provisionalPlanBlockers(
  plan: ProvisionalNormalizedPlan,
  input: ProvisionalAssessmentInput,
  bodySha256: string,
  cap: number | null,
): ProvisionalBlocker[] {
  const blockers: ProvisionalBlocker[] = [];
  const block = (code: string, detail: string): void => {
    blockers.push({ code, detail });
  };
  const repository = input.repository ?? '';
  if (
    plan.source.issueNumber !== input.issue.number ||
    plan.source.bodySha256 !== bodySha256 ||
    (repository !== '' &&
      plan.source.repository.toLowerCase() !== repository.toLowerCase())
  ) {
    block(
      'plan-stale',
      `the plan is not bound to this source snapshot; the current body SHA-256 is ${bodySha256}`,
    );
  }
  const sourceText = normalizeForExcerpt(input.issue.body);
  const inSource = (excerpt: string): boolean =>
    sourceText.includes(normalizeForExcerpt(excerpt));
  if (plan.humanChoiceCriteria.length === 0) {
    block(
      'human-criteria-missing',
      'the original human-choice criteria must be listed as pending',
    );
  }
  const foreignCriteria = plan.humanChoiceCriteria.filter(
    (criterion) => !inSource(criterion.text),
  );
  if (foreignCriteria.length > 0) {
    block(
      'criteria-not-in-source',
      `a human-choice criterion is not a verbatim excerpt of the source: ${foreignCriteria[0]?.text}`,
    );
  }
  const foreignChoices = plan.recordedChoices.filter(
    (recorded) => !inSource(recorded.reference),
  );
  if (foreignChoices.length > 0) {
    block(
      'recorded-choice-not-in-source',
      `a recorded choice is not a verbatim excerpt of the source: ${foreignChoices[0]?.reference}`,
    );
  }
  if (plan.choices.length === 0) {
    block('choices-missing', 'the plan decides no choice');
  }
  plan.choices.forEach((choice, position) => {
    const label = `choice ${position + 1}`;
    if (choice.feasibleAlternatives.length === 0) {
      block(
        'alternatives-insufficient',
        `${label} needs the selected option and at least one feasible alternative`,
      );
    }
    const options = [choice.selectedOption, ...choice.feasibleAlternatives];
    const ids = new Set(options.map((option) => option.id));
    const descriptions = new Set(
      options.map((option) => optionDistinctKey(option.description)),
    );
    if (ids.size !== options.length || descriptions.size !== options.length) {
      block(
        'options-not-distinct',
        `${label} repeats an option id or description`,
      );
    }
    const subjective = choice.executionCriteria.find((criterion) =>
      SUBJECTIVE_CRITERION_PATTERN.test(criterion),
    );
    // The selected option's verification says how its result is checked, so it
    // is read like an execution criterion.
    const checks = [
      ...choice.executionCriteria,
      choice.selectedOption.verification,
    ];
    const approvalCriterion = checks.find(mentionsApproval);
    const credentialCriterion = checks.find(needsCredential);
    if (choice.executionCriteria.length === 0) {
      block(
        'criteria-missing',
        `${label} has no objective execution criterion`,
      );
    } else if (subjective !== undefined) {
      block(
        'criteria-subjective',
        `${label} has a criterion that needs a person's opinion: ${subjective}`,
      );
    }
    if (approvalCriterion !== undefined) {
      block(
        'criteria-needs-approval',
        `${label} has an execution criterion that depends on an approval: ${approvalCriterion}`,
      );
    }
    if (credentialCriterion !== undefined) {
      block(
        'criteria-needs-credential',
        `${label} has an execution criterion that waits for a credential or access: ${credentialCriterion}`,
      );
    }
  });
  const declared = (input.candidateFiles ?? []).map(stripLeadingDotSlash);
  if (input.candidateFilesDeclared === true && declared.length === 0) {
    block(
      'candidate-files-empty',
      'the source has a Candidate files section that lists no path, so no file edit is bounded',
    );
  }
  const outside = plan.deliverables.filter(
    (deliverable) =>
      deliverable.kind === 'file' &&
      declared.length > 0 &&
      !declared.includes(stripLeadingDotSlash(deliverable.target)),
  );
  if (outside.length > 0) {
    block(
      'surface-outside-candidate-files',
      `the plan edits ${outside
        .slice(0, 5)
        .map((deliverable) => deliverable.target)
        .join(', ')}, which the source does not list under Candidate files`,
    );
  }
  const approvalDeliverable = plan.deliverables.find((deliverable) =>
    mentionsApproval(deliverable.purpose),
  );
  if (approvalDeliverable !== undefined) {
    block(
      'criteria-needs-approval',
      `a deliverable's purpose depends on an approval: ${approvalDeliverable.purpose}`,
    );
  }
  const credentialDeliverable = plan.deliverables.find((deliverable) =>
    needsCredential(deliverable.purpose),
  );
  if (credentialDeliverable !== undefined) {
    block(
      'criteria-needs-credential',
      `a deliverable's purpose waits for a credential or access: ${credentialDeliverable.purpose}`,
    );
  }
  if (plan.deliverables.length === 0) {
    block(
      'deliverables-missing',
      'the plan names no concrete edit or deliverable surface',
    );
  } else {
    const limit =
      input.effort === 'L'
        ? Number.POSITIVE_INFINITY
        : PROVISIONAL_SURFACE_LIMITS[input.effort ?? 'M'];
    if (plan.deliverables.length > limit) {
      block(
        'surface-oversized',
        `the plan names ${plan.deliverables.length} deliverables, above the ${limit} that effort ${input.effort ?? 'M'} allows`,
      );
    }
  }
  if (plan.evidence.length === 0) {
    block('evidence-missing', 'the plan cites no repository evidence');
  }
  if (
    input.bodyRecordsOperatorChoice === true &&
    plan.recordedChoices.length === 0
  ) {
    block(
      'recorded-choice-unacknowledged',
      'the source records an operator choice that the plan does not list as respected',
    );
  }
  if (cap !== null && plan.choices.length > cap) {
    block(
      'cap-exceeded',
      `the plan decides ${plan.choices.length} choices, above the trusted maxDecisionsPerClaim of ${cap}`,
    );
  }
  return blockers;
}

/**
 * Assesses one needs-decision source for the provisional claim-and-record
 * path. A4 and A4.5 call it with the same inputs and therefore get the same
 * answer. An ineligible result never loosens a check: the caller keeps the
 * current needs-decision route (or, for `no-new-execution`, starts nothing).
 */
export function assessProvisionalChoicePlan(
  input: ProvisionalAssessmentInput,
): ProvisionalAssessment {
  const body = String(input.issue.body ?? '');
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const policy = readProvisionalPolicy(input.policy);
  const floor = normalizeAutopilotSuitabilityFloor(input.floor);
  const authored = isAutopilotSuitabilityScore(input.authoredScore)
    ? input.authoredScore
    : null;
  let scoreRoute: ProvisionalScoreRoute =
    input.suitabilityEnabled === false
      ? 'ranking-disabled'
      : authored === null
        ? 'no-score'
        : authored >= floor
          ? 'at-or-above-floor'
          : 'below-floor';
  let reassessed: number | null = null;
  let plan: ProvisionalNormalizedPlan | null = null;
  const blockers = provisionalPreconditionBlockers(input, policy);
  const cap = policy.verdict === 'enabled' ? policy.cap : null;

  if (blockers.length === 0) {
    if (input.plan === undefined || input.plan === null) {
      blockers.push({
        code: 'plan-missing',
        detail: 'no provisional plan was supplied',
      });
    } else {
      const reader: PlanReaderState = { issues: [], findings: [] };
      plan = readProvisionalPlan(input.plan, reader);
      blockers.push(...reader.findings);
      if (reader.issues.length > 0) {
        blockers.push({
          code: 'plan-malformed',
          detail: reader.issues.slice(0, 8).join('; '),
        });
      } else if (plan !== null) {
        blockers.push(...provisionalPlanBlockers(plan, input, bodySha256, cap));
        // Only a score caused solely by the input choice may be reassessed
        // with the plan; the floor and the authored marker stay as they are.
        if (scoreRoute === 'below-floor') {
          const { lowScoreCause, reassessedScore, rationale } =
            plan.suitability;
          if (
            lowScoreCause === 'input-choice-only' &&
            reassessedScore !== null &&
            reassessedScore >= floor &&
            rationale !== null
          ) {
            scoreRoute = 'reassessed-with-plan';
            reassessed = reassessedScore;
          } else {
            blockers.push({
              code: 'score-below-floor',
              detail: `the authored score ${authored} is below the floor ${floor} and the plan does not show that the input choice alone causes it`,
            });
          }
        }
      }
    }
  }
  const eligible = blockers.length === 0 && plan !== null;
  const choiceCount = plan?.choices.length ?? null;
  const assessment: ProvisionalAssessment = {
    eligible,
    route: eligible
      ? 'claim-and-record'
      : blockers.some((blocker) => blocker.code === 'pending-confirmation')
        ? 'no-new-execution'
        : 'current-route',
    blockers,
    policy: { decisionIssue: policy.verdict, maxDecisionsPerClaim: cap },
    caps: {
      choices: choiceCount,
      decisionGenerationsAfterSelection: choiceCount,
      maxDecisionsPerClaim: cap,
    },
    score: { authored, floor, route: scoreRoute, reassessed },
    source: { issueNumber: input.issue.number, bodySha256 },
    plan: eligible ? plan : null,
    pendingHumanCriteria: plan?.humanChoiceCriteria.map((c) => c.text) ?? [],
    nextStep: eligible ? 'claim-then-persist-selection' : null,
  };
  ASSESSED.add(assessment);
  return assessment;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
