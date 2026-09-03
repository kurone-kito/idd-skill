// idd-generated-from: src/scripts/advisory-wait-policy.mts
//
// The scripts/advisory-wait-policy.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { readFileSync } from 'node:fs';

import { isValidIsoTimestamp } from './marker-helpers.mts';
import { loadJson, validateConfigSection } from './validate-schemas.mts';

export const DEFAULT_ADVISORY_REQUEST_CAP = 30;
export const DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES = 30;
export const DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES = 10;
export const DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES = 2;
export const DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN = 'copilot';
// #1571: the default primary bot's GraphQL login (`copilot`) and its REST
// `requested_reviewers` account login differ -- `gh pr edit --add-reviewer`/
// `--remove-reviewer` resolve bot logins via GraphQL and some `gh` versions
// reject the bot login outright, so E14 falls back to this REST identity
// (see idd-review-fix.instructions.md's gh-then-REST fallback).
export const DEFAULT_ADVISORY_PRIMARY_BOT_REST_LOGIN =
  'copilot-pull-request-reviewer[bot]';
// Shared last-resort fallback for the plural `advisoryBotLogins` config key
// (distinct from the singular primary-bot-login default above): used by both
// `merged-pr-feedback-sweep.mts` and `disposition-non-review-notices.mts` so
// the two stay aligned on which identities count as advisory bots when
// `.github/idd/config.json` configures none. A single source avoids the
// drift risk of two independently-maintained literals (see PR #1490 review).
export const DEFAULT_ADVISORY_BOT_LOGINS = [
  'coderabbitai[bot]',
  'chatgpt-codex-connector[bot]',
];
// 24h, matching the `claim-stale-age` and external-check-waiver
// `maxValidity` defaults so this gate uses a familiar timescale.
export const DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES = 1440;
// #1511: bounded same-HEAD advisory reroll budget -- a small, deliberately
// conservative default. The empirical basis (200 merged PRs, #1511's issue
// body) shows a fresh same-SHA re-review often drops straight to zero, but
// K=1 is sometimes insufficient, so 2 balances recovering the common case
// against not hammering the bot when a residual is genuinely flat.
export const DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP = 2;
// #1572: bounded per-PR-HEAD Copilot stall-recovery cycle cap, accounted
// independently of both DEFAULT_ADVISORY_REQUEST_CAP (ordinary re-review
// requests) and DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP (same-HEAD reroll
// budget, #1511). A "recovery cycle" is one trusted, claim-bound,
// current-HEAD-bound `advisory-recovery` marker -- see
// `buildCopilotRecoverySummary` in advisory-wait-state.mts. Small and
// conservative like the reroll cap default, for the same reason: this is a
// terminal-eligibility budget, not a routine retry budget.
export const DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP = 2;
// #1572: 12h terminal unavailability window, matching the `claim-stale-age`
// and external-check-waiver `maxValidity` distributed defaults so this gate
// uses the same familiar timescale as other terminal/escalation windows in
// this repository.
export const DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES = 720;
// #2335: off by default (unset), so an adopter that never sets
// `advisoryWait.secondaryQuietWindow` sees unchanged pre-merge-readiness
// behavior. See `buildSecondaryQuietWindowStatus` below.
export const DEFAULT_ADVISORY_SECONDARY_QUIET_WINDOW_MINUTES = 0;
// #1570: the `idd-advisory-convergence` required-check selector name, shared
// between advisory-convergence.mts (the CI-gate consumer, which re-exports
// this under its own established `ADVISORY_CONVERGENCE_CHECK_SELECTOR` name
// for backward compatibility) and protocol-helpers.mts's
// `buildPreMergeReadinessSummary` (the F2/F3 direct-evidence consumer, which
// filters external-check-waiver evidence by this same selector for the
// terminal-unavailability waiver check). A single source avoids the two
// consumers silently drifting on the registered selector string.
export const DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR =
  'idd-advisory-convergence';
export const ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT = 'phase-specific';
export const ADVISORY_CAP_EXHAUSTED_ROUTES = new Set([
  'phase-specific',
  'hold',
]);
const POLICY_SCHEMA = loadJson('schemas/policy.schema.json');

/**
 * True when `config`'s `advisoryWait` section passes {@link POLICY_SCHEMA}
 * validation (or the section is absent) -- the same gate every `read*`
 * wrapper below applies to a freshly-parsed file before calling its
 * `resolve*` sibling. Exported so a caller that already holds a parsed
 * config from a source other than a local file (`pre-merge-readiness.mts`'s
 * trusted-ref read, #2373) can apply the identical validate-or-default rule
 * instead of duplicating this schema check.
 */
export function advisoryWaitSectionIsValid(config: unknown): boolean {
  return (
    validateConfigSection(config, POLICY_SCHEMA, 'advisoryWait').length === 0
  );
}

interface AdvisoryWaitPolicy {
  requestCap: number;
  pendingWindowMinutes: number;
  settledWindowMinutes: number;
  pollIntervalMinutes: number;
  capExhaustedRoute: string;
}

export function readAdvisoryWaitPolicy(
  path: string = '.github/idd/config.json',
): AdvisoryWaitPolicy {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    // Scoped to the advisoryWait subtree (#1359): an unrelated invalid
    // field elsewhere in the document must not zero out an otherwise-valid
    // advisoryWait section.
    if (
      validateConfigSection(config, POLICY_SCHEMA, 'advisoryWait').length > 0
    ) {
      return resolveAdvisoryWaitPolicy({});
    }
    return resolveAdvisoryWaitPolicy(config);
  } catch {
    return resolveAdvisoryWaitPolicy({});
  }
}

export function resolveAdvisoryWaitPolicy(
  config: unknown = {},
): AdvisoryWaitPolicy {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;

  return {
    requestCap: normalizeConfiguredPositiveInteger(
      advisoryWait.requestCap,
      DEFAULT_ADVISORY_REQUEST_CAP,
    ),
    pendingWindowMinutes: normalizeConfiguredDurationMinutes(
      advisoryWait.pendingWindow,
      DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES,
    ),
    settledWindowMinutes: normalizeConfiguredDurationMinutes(
      advisoryWait.settledWindow,
      DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES,
    ),
    pollIntervalMinutes: normalizeConfiguredDurationMinutes(
      advisoryWait.pollInterval,
      DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES,
    ),
    capExhaustedRoute: normalizeConfiguredCapExhaustedRoute(
      advisoryWait.capExhaustedRoute,
    ),
  };
}

function normalizeConfiguredPrimaryBotLogin(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
}

/**
 * Resolve the configured primary advisory bot login from a parsed policy
 * object, defaulting to Copilot so the advisory-wait gate is behavior-
 * preserving when `advisoryWait.primaryBotLogin` is absent. Kept separate
 * from {@link resolveAdvisoryWaitPolicy} so the timing-policy shape stays a
 * stable five-key object.
 */
export function resolveAdvisoryPrimaryBotLogin(config: unknown = {}): string {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;
  return normalizeConfiguredPrimaryBotLogin(advisoryWait.primaryBotLogin);
}

/**
 * Read the configured primary advisory bot login from a policy file, failing
 * closed to Copilot when the file is missing, unreadable, or schema-invalid.
 */
export function readAdvisoryPrimaryBotLogin(
  path: string = '.github/idd/config.json',
): string {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    // Scoped to the advisoryWait subtree (#1359); see readAdvisoryWaitPolicy.
    if (
      validateConfigSection(config, POLICY_SCHEMA, 'advisoryWait').length > 0
    ) {
      return DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
    }
    return resolveAdvisoryPrimaryBotLogin(config);
  } catch {
    return DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  }
}

/**
 * Resolve the REST API identity for the configured primary advisory bot
 * (#1571), used only when the `gh pr edit --add-reviewer` /
 * `--remove-reviewer` GraphQL mutation fails to resolve a bot login (E14's
 * documented gh-then-REST fallback; see
 * idd-review-fix.instructions.md#e14). For the default Copilot bot, the REST
 * identity differs from the GraphQL login; a configured non-default bot's
 * REST login equals its GraphQL login, since a configured login is already a
 * real account login. Pure and fails closed to the default REST login when
 * `primaryBotLogin` is blank.
 */
export function resolveAdvisoryBotRestLogin(
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
): string {
  const normalized = normalizeConfiguredPrimaryBotLogin(primaryBotLogin);
  return normalized === DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN
    ? DEFAULT_ADVISORY_PRIMARY_BOT_REST_LOGIN
    : normalized;
}

/**
 * Normalize a configured secondary advisory bot login. Unlike the primary
 * (which fails closed to Copilot), the secondary is OPTIONAL: an absent,
 * blank, or non-string value resolves to `''` so an unconfigured secondary
 * stays fully disabled — the supplement never fires and behavior is identical
 * to the primary-only path.
 */
function normalizeConfiguredSecondaryBotLogin(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : '';
}

/**
 * Resolve the OPTIONAL secondary advisory bot login from a parsed policy
 * object, returning `''` (disabled) when `advisoryWait.secondaryBotLogin` is
 * absent. The secondary is a non-gating supplement, so it has no Copilot
 * default — absence must read as "no secondary".
 */
export function resolveAdvisorySecondaryBotLogin(config: unknown = {}): string {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;
  return normalizeConfiguredSecondaryBotLogin(advisoryWait.secondaryBotLogin);
}

/**
 * Read the OPTIONAL secondary advisory bot login from a policy file, failing
 * closed to `''` (disabled) when the file is missing, unreadable, or
 * schema-invalid.
 */
export function readAdvisorySecondaryBotLogin(
  path: string = '.github/idd/config.json',
): string {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    // Scoped to the advisoryWait subtree (#1359); see readAdvisoryWaitPolicy.
    if (
      validateConfigSection(config, POLICY_SCHEMA, 'advisoryWait').length > 0
    ) {
      return '';
    }
    return resolveAdvisorySecondaryBotLogin(config);
  } catch {
    return '';
  }
}

/**
 * Resolve the configured advisory-convergence deadline (in minutes) from a
 * parsed policy object. Once a PR HEAD has gone this long without a
 * zero-item Copilot review, `advisory-convergence.mts`'s only pass path is a
 * valid maintainer external-check waiver for that HEAD. Kept separate from
 * {@link resolveAdvisoryWaitPolicy} for the same reason the bot-login
 * resolvers are separate: it is not part of the five-key active-wait timing
 * shape, and defaults to Copilot-advisory-preserving behavior when absent.
 */
export function resolveAdvisoryConvergenceDeadlineMinutes(
  config: unknown = {},
): number {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;
  return normalizeConfiguredDurationMinutes(
    advisoryWait.convergenceDeadline,
    DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  );
}

/**
 * Read the configured advisory-convergence deadline from a policy file,
 * failing closed to the 24h default when the file is missing, unreadable, or
 * schema-invalid.
 */
export function readAdvisoryConvergenceDeadlineMinutes(
  path: string = '.github/idd/config.json',
): number {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    // Scoped to the advisoryWait subtree (#1359); see readAdvisoryWaitPolicy.
    if (
      validateConfigSection(config, POLICY_SCHEMA, 'advisoryWait').length > 0
    ) {
      return DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES;
    }
    return resolveAdvisoryConvergenceDeadlineMinutes(config);
  } catch {
    return DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES;
  }
}

/**
 * Resolve the configured bounded same-HEAD advisory reroll cap (#1511) from
 * a parsed policy object. Kept separate from {@link resolveAdvisoryWaitPolicy}
 * for the same reason the deadline/bot-login resolvers are separate: it is
 * not part of the five-key active-wait timing shape, and it defaults to a
 * fixed, conservative cap when absent.
 */
export function resolveAdvisorySameHeadRerollCap(config: unknown = {}): number {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;
  return normalizeConfiguredPositiveInteger(
    advisoryWait.sameHeadRerollCap,
    DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP,
  );
}

/**
 * Read the configured bounded same-HEAD advisory reroll cap from a policy
 * file, failing closed to the default cap when the file is missing,
 * unreadable, or schema-invalid.
 */
export function readAdvisorySameHeadRerollCap(
  path: string = '.github/idd/config.json',
): number {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    // Scoped to the advisoryWait subtree (#1359); see readAdvisoryWaitPolicy.
    if (
      validateConfigSection(config, POLICY_SCHEMA, 'advisoryWait').length > 0
    ) {
      return DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP;
    }
    return resolveAdvisorySameHeadRerollCap(config);
  } catch {
    return DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP;
  }
}

/**
 * Read the configured bounded per-PR-HEAD Copilot stall-recovery cycle cap
 * from a policy file, failing closed to the default cap when the file is
 * missing, unreadable, or schema-invalid.
 */
export function readAdvisoryRecoveryCycleCap(
  path: string = '.github/idd/config.json',
): number {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    // Scoped to the advisoryWait subtree (#1359); see readAdvisoryWaitPolicy.
    if (
      validateConfigSection(config, POLICY_SCHEMA, 'advisoryWait').length > 0
    ) {
      return DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP;
    }
    return resolveAdvisoryRecoveryCycleCap(config);
  } catch {
    return DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP;
  }
}

/**
 * Resolve the configured bounded per-PR-HEAD Copilot stall-recovery cycle cap
 * (#1572) from a parsed policy object. Kept separate from
 * {@link resolveAdvisoryWaitPolicy} for the same reason the deadline/reroll-cap
 * resolvers are separate: it is not part of the five-key active-wait timing
 * shape, and it defaults to a fixed, conservative cap when absent. Accounted
 * independently of {@link resolveAdvisoryWaitPolicy}'s `requestCap` and
 * {@link resolveAdvisorySameHeadRerollCap} -- a distinct counter for a
 * distinct (terminal-eligibility) budget.
 */
export function resolveAdvisoryRecoveryCycleCap(config: unknown = {}): number {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;
  return normalizeConfiguredPositiveInteger(
    advisoryWait.recoveryCycleCap,
    DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  );
}

/**
 * Read the configured 12h terminal-unavailability window (in minutes) from a
 * policy file, failing closed to the default window when the file is
 * missing, unreadable, or schema-invalid.
 */
export function readAdvisoryTerminalWindowMinutes(
  path: string = '.github/idd/config.json',
): number {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    // Scoped to the advisoryWait subtree (#1359); see readAdvisoryWaitPolicy.
    if (
      validateConfigSection(config, POLICY_SCHEMA, 'advisoryWait').length > 0
    ) {
      return DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES;
    }
    return resolveAdvisoryTerminalWindowMinutes(config);
  } catch {
    return DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES;
  }
}

/**
 * Resolve the configured 12h terminal-unavailability window (in minutes,
 * #1572) from a parsed policy object. Kept separate from
 * {@link resolveAdvisoryWaitPolicy} for the same reason the pending/settled
 * windows are not: this window gates a distinct terminal `COPILOT_UNAVAILABLE`
 * signal (see advisory-wait-state.mts's `buildCopilotRecoverySummary`), not
 * the active-wait poll loop.
 */
export function resolveAdvisoryTerminalWindowMinutes(
  config: unknown = {},
): number {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;
  return normalizeConfiguredDurationMinutes(
    advisoryWait.terminalWindow,
    DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  );
}

/**
 * Resolve the OPTIONAL `advisoryWait.providerOutage.terminalWindow` override
 * (#2554, in minutes) from a parsed policy object. Returns `null` -- not a
 * fallback default -- when unset, unparseable, or non-positive: "not
 * configured" here means "no override applies" (the caller falls through to
 * the unconditional {@link resolveAdvisoryTerminalWindowMinutes} value), not
 * "apply the same value the base resolver would produce anyway."
 */
export function resolveProviderOutageTerminalWindowMinutes(
  config: unknown = {},
): number | null {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;
  const providerOutage = (advisoryWait.providerOutage ?? {}) as Record<
    string,
    unknown
  >;
  const milliseconds = parseConfiguredDurationToMs(
    providerOutage.terminalWindow,
  );
  return milliseconds && milliseconds > 0 ? milliseconds / 60000 : null;
}

/**
 * Resolve the EFFECTIVE terminal-unavailability window (#2554, in minutes):
 * the unconditional {@link resolveAdvisoryTerminalWindowMinutes} value,
 * unless `declarationActive` is true AND
 * `advisoryWait.providerOutage.terminalWindow` is configured to something
 * SHORTER, in which case the declaration-scoped value applies instead.
 * Clamped with `Math.min` rather than substituted outright (Copilot review,
 * PR #2564): this is a shortening mechanism only -- see this module's own
 * "#2554: declaration-scoped terminal-window override" doc comments above --
 * so a misconfigured override longer than the base window must never widen
 * it during a declared outage. `recoveryCycleCap` is unaffected -- this
 * override is scoped to the terminal window alone.
 *
 * `declarationActive` is caller-supplied rather than recomputed here: proving
 * it needs live `resolveProviderOutageDeclaration` (provider-outage-
 * declaration.mts) evidence (declaration-target comments, actor authority,
 * `now`), none of which this otherwise-pure resolver has access to. A caller
 * that cannot prove a currently-valid declaration must pass `false`, which
 * fails closed to the unconditional base value -- matching every other
 * resolver in this module's "ambiguous input never widens behavior"
 * contract.
 */
export function resolveEffectiveAdvisoryTerminalWindowMinutes({
  config = {},
  declarationActive = false,
}: {
  config?: unknown;
  declarationActive?: boolean;
} = {}): number {
  const base = resolveAdvisoryTerminalWindowMinutes(config);
  if (!declarationActive) return base;
  const override = resolveProviderOutageTerminalWindowMinutes(config);
  return override !== null ? Math.min(base, override) : base;
}

/**
 * Read the OPTIONAL `advisoryWait.secondaryQuietWindow` (#2335) from a policy
 * file, failing closed to the off (unset) default when the file is missing,
 * unreadable, or schema-invalid.
 */
export function readAdvisorySecondaryQuietWindowMinutes(
  path: string = '.github/idd/config.json',
): number {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    // Scoped to the advisoryWait subtree (#1359); see readAdvisoryWaitPolicy.
    if (
      validateConfigSection(config, POLICY_SCHEMA, 'advisoryWait').length > 0
    ) {
      return DEFAULT_ADVISORY_SECONDARY_QUIET_WINDOW_MINUTES;
    }
    return resolveAdvisorySecondaryQuietWindowMinutes(config);
  } catch {
    return DEFAULT_ADVISORY_SECONDARY_QUIET_WINDOW_MINUTES;
  }
}

/**
 * Resolve the OPTIONAL `advisoryWait.secondaryQuietWindow` (#2335, in
 * minutes) from a parsed policy object. Kept separate from
 * {@link resolveAdvisoryWaitPolicy} for the same reason the deadline/
 * terminal-window resolvers are separate: it is not part of the five-key
 * active-wait timing shape, and it defaults to `0` (off) when absent,
 * unparseable, or negative -- `normalizeConfiguredDurationMinutes` already
 * falls back to the default for every one of those cases, since the shared
 * duration parser has no negative-duration syntax to accept in the first
 * place.
 */
export function resolveAdvisorySecondaryQuietWindowMinutes(
  config: unknown = {},
): number {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;
  return normalizeConfiguredDurationMinutes(
    advisoryWait.secondaryQuietWindow,
    DEFAULT_ADVISORY_SECONDARY_QUIET_WINDOW_MINUTES,
  );
}

/**
 * The `advisoryWait.secondaryQuietWindow` gate status (#2335), in the shape
 * `pre-merge-readiness` publishes it as `secondaryQuietWindow`.
 */
export interface SecondaryQuietWindowStatus {
  minutes: number;
  anchorAt: string;
  elapsedMinutes: number | null;
  elapsed: boolean;
  remainingMinutes: number | null;
  declined: boolean;
}

// #2544: once the secondary bot has posted a genuine (non-notice) review
// for the current HEAD, #2335's "might still be mid-review" risk no longer
// applies -- only a short confirmation buffer remains, anchored on the
// bot's OWN settlement signal rather than the full window anchored on
// general PR activity (which unrelated later activity could otherwise keep
// re-extending). #2330's own motivating evidence (a second finding landing
// 34s and 2m after a zero-unresolved snapshot) sets the buffer floor; 5
// minutes gives comfortable margin above the largest observed value while
// staying far short of the full configured window.
const SECONDARY_QUIET_WINDOW_SETTLED_BUFFER_MINUTES = 5;

/**
 * Shared elapsed/remaining-minutes arithmetic for a quiet-window anchor.
 * Extracted so `buildSecondaryQuietWindowStatus`'s unsettled path (anchored
 * on `effectiveMaxActivityUpdatedAt`) and its #2544 settled-buffer path
 * (anchored on `secondaryBotSettledAt`) compute identically and cannot
 * drift apart.
 */
function computeQuietWindowElapsed({
  minutes,
  anchorAt,
  now,
}: {
  minutes: number;
  anchorAt: string;
  now: string;
}): SecondaryQuietWindowStatus {
  const nowMs = Date.parse(now);
  const anchorMs = Date.parse(anchorAt);
  const elapsedMinutes =
    Number.isFinite(nowMs) && Number.isFinite(anchorMs)
      ? nowMs < anchorMs
        ? 0
        : Math.floor((nowMs - anchorMs) / 60000)
      : null;
  const elapsed = elapsedMinutes !== null && elapsedMinutes >= minutes;
  const remainingMinutes =
    elapsedMinutes !== null ? Math.max(0, minutes - elapsedMinutes) : null;
  return {
    minutes,
    anchorAt,
    elapsedMinutes,
    elapsed,
    remainingMinutes,
    declined: false,
  };
}

/**
 * Build the `advisoryWait.secondaryQuietWindow` gate status (#2335): once
 * the E-phase convergence conditions are already met -- no unresolved
 * review item, every disposition recorded -- a slower secondary advisory
 * bot (`advisoryWait.secondaryBotLogin`) can still land a finding after a
 * snapshot already looked converged (measured on PR #2330: findings landed
 * 34s and 2m after a zero-unresolved judgement). This gate requires the
 * configured window to have elapsed since the last SUBSTANTIVE activity
 * before treating the review as settled.
 *
 * Stateless by design: rather than persisting "when convergence was first
 * observed," this anchors on `effectiveMaxActivityUpdatedAt` --
 * `buildActivitySnapshotSummary`'s already-computed
 * `effective.maxActivityUpdatedAt` (protocol-helpers.mts), the same
 * non-ack-only activity ceiling `ackOnlyPostDisposition` already uses. That
 * value stays fresh while a genuinely unresolved item exists (an unresolved
 * thread's raw activity always feeds it, protocol-helpers.mts's
 * `threadEffective`) and stabilizes once every item is either
 * resolved-with-disposition or was never opened -- a disposition reply, a
 * watermark, and a courtesy advisory-bot ack all leave it unchanged too (the
 * first legitimately anchors it, the watermark is filtered out before
 * classification runs, and the ack is excluded as ack-only) -- so "elapsed
 * since that anchor" already equals "elapsed since convergence was reached"
 * without a second, independently-drifting timestamp to persist.
 *
 * #2544: `secondaryBotSettledAt` -- when it is a valid ISO timestamp --
 * switches the gate to the shorter settled buffer above, anchored on that
 * timestamp instead of `effectiveMaxActivityUpdatedAt`. The buffer never
 * exceeds the operator's own configured `minutes` (via `Math.min`), so a
 * repository that configures a window shorter than the buffer is never
 * kept waiting longer than what it explicitly asked for. Omitted or
 * invalid (the pre-#2544 default for every existing caller) falls through
 * to the unchanged, unsettled path -- byte-identical behavior.
 *
 * #2547: `secondaryBotDeclined: true` skips the wait entirely (`elapsed:
 * true`, same as the off/no-anchor branches below) once the secondary bot
 * has definitively declined to review this exact HEAD (a rate-limit /
 * skip-review notice, no genuine comment after it) -- #2335's "might still
 * be mid-review" protection has nothing left to protect once the bot has
 * already, conclusively, said it will not review this commit. Checked
 * immediately after the `minutes <= 0` short-circuit and before
 * `secondaryBotSettledAt`, since the two flags are mutually exclusive by
 * construction (`computeSecondaryAdvisoryReviewSettlement` never reports
 * both `settled` and `declined` true for the same call) -- the ordering
 * only matters for which unconditional-pass branch a reader sees, not for
 * any behavioral overlap.
 *
 * A zero/absent `minutes` (the off/unset default) or a missing/invalid
 * anchor (nothing to anchor on yet) reports `elapsed: true` unconditionally
 * -- this gate must never itself block when unconfigured, and must never
 * block on the absence of any activity to measure. The `minutes <= 0`
 * short-circuit is checked BEFORE `secondaryBotSettledAt` is ever
 * consulted, so the off default stays unconditional regardless of
 * settlement evidence. A positive but non-integer `minutes` is floored --
 * the config-sourced path (`resolveAdvisorySecondaryQuietWindowMinutes`)
 * never produces one (every ISO-duration unit it accepts converts to a
 * whole number of minutes), but this function's own `minutes` parameter is
 * untyped, and a fractional value would otherwise leak into
 * `elapsedMinutes`/`remainingMinutes` as non-integers, contradicting the
 * whole-minute contract those fields keep elsewhere in this report.
 */
export function buildSecondaryQuietWindowStatus({
  minutes,
  effectiveMaxActivityUpdatedAt,
  secondaryBotSettledAt,
  secondaryBotDeclined,
  now,
}: {
  minutes?: unknown;
  effectiveMaxActivityUpdatedAt?: unknown;
  secondaryBotSettledAt?: unknown;
  secondaryBotDeclined?: unknown;
  now: string;
}): SecondaryQuietWindowStatus {
  const resolvedMinutes =
    Number.isFinite(minutes) && Number(minutes) > 0
      ? Math.floor(Number(minutes))
      : 0;
  const anchorAtRaw = String(effectiveMaxActivityUpdatedAt ?? '');
  const anchorValid = isValidIsoTimestamp(anchorAtRaw);
  if (resolvedMinutes <= 0) {
    return {
      minutes: resolvedMinutes,
      anchorAt: anchorValid ? anchorAtRaw : 'none',
      elapsedMinutes: null,
      elapsed: true,
      remainingMinutes: 0,
      declined: false,
    };
  }

  if (secondaryBotDeclined === true) {
    return {
      minutes: resolvedMinutes,
      anchorAt: 'declined',
      elapsedMinutes: null,
      elapsed: true,
      remainingMinutes: 0,
      declined: true,
    };
  }

  const settledAtRaw = String(secondaryBotSettledAt ?? '');
  if (isValidIsoTimestamp(settledAtRaw)) {
    return computeQuietWindowElapsed({
      minutes: Math.min(
        resolvedMinutes,
        SECONDARY_QUIET_WINDOW_SETTLED_BUFFER_MINUTES,
      ),
      anchorAt: settledAtRaw,
      now,
    });
  }

  if (!anchorValid) {
    return {
      minutes: resolvedMinutes,
      anchorAt: 'none',
      elapsedMinutes: null,
      elapsed: true,
      remainingMinutes: 0,
      declined: false,
    };
  }
  return computeQuietWindowElapsed({
    minutes: resolvedMinutes,
    anchorAt: anchorAtRaw,
    now,
  });
}

export function normalizeAdvisoryWaitRuntimeOptions(
  options: unknown = {},
): AdvisoryWaitPolicy {
  const o = (options ?? {}) as Record<string, unknown>;
  return {
    requestCap: normalizePositiveInteger(
      o.requestCap,
      DEFAULT_ADVISORY_REQUEST_CAP,
    ),
    pendingWindowMinutes: normalizePositiveNumber(
      o.pendingWindowMinutes,
      DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES,
    ),
    settledWindowMinutes: normalizePositiveNumber(
      o.settledWindowMinutes,
      DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES,
    ),
    pollIntervalMinutes: normalizePositiveNumber(
      o.pollIntervalMinutes,
      DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES,
    ),
    capExhaustedRoute: normalizeCapExhaustedRoute(o.capExhaustedRoute),
  };
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeConfiguredPositiveInteger(
  value: unknown,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeConfiguredDurationMinutes(
  value: unknown,
  fallback: number,
): number {
  const milliseconds = parseConfiguredDurationToMs(value);
  return milliseconds && milliseconds > 0 ? milliseconds / 60000 : fallback;
}

function normalizeConfiguredCapExhaustedRoute(value: unknown): string {
  return typeof value === 'string' && ADVISORY_CAP_EXHAUSTED_ROUTES.has(value)
    ? value
    : ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT;
}

function normalizeCapExhaustedRoute(value: unknown): string {
  const route = String(value ?? '').trim();
  return ADVISORY_CAP_EXHAUSTED_ROUTES.has(route)
    ? route
    : ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT;
}

function parseConfiguredDurationToMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(value);
  if (!match) return null;
  const hasTimeDesignator = value.includes('T');
  const hasAnyTimeUnit = match[2] !== undefined || match[3] !== undefined;
  if (hasTimeDesignator && !hasAnyTimeUnit) return null;
  const days = Number.parseInt(match[1] ?? '0', 10);
  const hours = Number.parseInt(match[2] ?? '0', 10);
  const minutes = Number.parseInt(match[3] ?? '0', 10);
  const totalMilliseconds = ((days * 24 + hours) * 60 + minutes) * 60000;
  if (totalMilliseconds <= 0 || totalMilliseconds % 60000 !== 0) {
    return null;
  }
  return totalMilliseconds;
}

/**
 * The `idd-advisory-convergence` waiver precondition, in the shape
 * `pre-merge-readiness` publishes it as
 * `advisoryConvergenceWaiverPrecondition`.
 */
export interface AdvisoryConvergenceWaiverPrecondition {
  checkSelector: string;
  deadlineMinutes: number;
  headCommittedAt: string;
  elapsedMinutes: number | null;
  deadlinePassed: boolean;
  terminalUnavailable: boolean;
  open: boolean;
}

/**
 * Build the `idd-advisory-convergence` waiver precondition (#2021) from its
 * two independent openers: a deadline anchored on the current HEAD commit's
 * own timestamp, and proven terminal Copilot unavailability (#1570).
 *
 * Extracted from `pre-merge-readiness`'s reducer (#2328) so every consumer
 * reads one implementation. `external-check-waiver.mts` accepted and posted
 * a waiver while this precondition was closed, disagreeing with the gate it
 * is supposed to predict; a second copy of this arithmetic is exactly how
 * that disagreement arose, so callers must not re-derive it.
 *
 * `terminalUnavailable` is supplied by the caller rather than computed here:
 * proving it needs trusted advisory-wait recovery-marker state, which not
 * every caller has. A caller that cannot evaluate it passes `false` and must
 * report the resulting verdict as "deadline not passed" rather than as a bare
 * closed hatch, since the terminal opener may still be open unseen.
 *
 * `deadlineOpensAt` is the deadline path's open moment as a real timestamp
 * (#2034), used to override a waiver's active-since cutoff. It is empty
 * unless the deadline itself has passed: the terminal path has no equivalent
 * anchor and intentionally falls back to the waiver comment's own
 * `createdAt`.
 */
export function buildAdvisoryConvergenceWaiverPrecondition({
  headCommittedAt,
  deadlineMinutes,
  terminalUnavailable = false,
  now,
}: {
  headCommittedAt?: unknown;
  deadlineMinutes?: unknown;
  terminalUnavailable?: boolean;
  now: string;
}): {
  precondition: AdvisoryConvergenceWaiverPrecondition;
  deadlineOpensAt: string;
} {
  const resolvedDeadlineMinutes = Number.isFinite(deadlineMinutes)
    ? Number(deadlineMinutes)
    : DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES;
  const resolvedHeadCommittedAt = String(headCommittedAt ?? '');
  const headCommittedAtValid = isValidIsoTimestamp(resolvedHeadCommittedAt);
  // Clamped exactly as `minutesBetweenIso` does, which is what
  // `pre-merge-readiness` used before this extraction and what
  // `advisory-convergence.mts` still uses: a HEAD commit dated ahead of the
  // runner clock yields 0, never a negative elapsed. Subtracting directly
  // would make this shared report disagree with the gate on a clock-skewed
  // or deliberately future-dated commit.
  const nowMs = Date.parse(now);
  const headMs = Date.parse(resolvedHeadCommittedAt);
  const elapsedMinutes =
    headCommittedAtValid && Number.isFinite(nowMs) && Number.isFinite(headMs)
      ? nowMs < headMs
        ? 0
        : Math.floor((nowMs - headMs) / 60000)
      : null;
  const deadlinePassed =
    elapsedMinutes !== null && elapsedMinutes >= resolvedDeadlineMinutes;
  const resolvedTerminalUnavailable = terminalUnavailable === true;

  return {
    precondition: {
      checkSelector: DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
      deadlineMinutes: resolvedDeadlineMinutes,
      headCommittedAt: resolvedHeadCommittedAt || 'none',
      elapsedMinutes,
      deadlinePassed,
      terminalUnavailable: resolvedTerminalUnavailable,
      open: deadlinePassed || resolvedTerminalUnavailable,
    },
    deadlineOpensAt:
      deadlinePassed && headCommittedAtValid
        ? new Date(
            new Date(resolvedHeadCommittedAt).getTime() +
              resolvedDeadlineMinutes * 60000,
          ).toISOString()
        : '',
  };
}
