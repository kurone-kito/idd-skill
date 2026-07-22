// idd-generated-from: src/scripts/advisory-wait-policy.mts
//
// The scripts/advisory-wait-policy.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { readFileSync } from 'node:fs';
import { loadJson, validateConfigSection } from './validate-schemas.mjs';
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
export const ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT = 'phase-specific';
export const ADVISORY_CAP_EXHAUSTED_ROUTES = new Set([
  'phase-specific',
  'hold',
]);
const POLICY_SCHEMA = loadJson('schemas/policy.schema.json');
export function readAdvisoryWaitPolicy(path = '.github/idd/config.json') {
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
export function resolveAdvisoryWaitPolicy(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};
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
function normalizeConfiguredPrimaryBotLogin(value) {
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
export function resolveAdvisoryPrimaryBotLogin(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};
  return normalizeConfiguredPrimaryBotLogin(advisoryWait.primaryBotLogin);
}
/**
 * Read the configured primary advisory bot login from a policy file, failing
 * closed to Copilot when the file is missing, unreadable, or schema-invalid.
 */
export function readAdvisoryPrimaryBotLogin(path = '.github/idd/config.json') {
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
  primaryBotLogin = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
) {
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
function normalizeConfiguredSecondaryBotLogin(value) {
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
export function resolveAdvisorySecondaryBotLogin(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};
  return normalizeConfiguredSecondaryBotLogin(advisoryWait.secondaryBotLogin);
}
/**
 * Read the OPTIONAL secondary advisory bot login from a policy file, failing
 * closed to `''` (disabled) when the file is missing, unreadable, or
 * schema-invalid.
 */
export function readAdvisorySecondaryBotLogin(
  path = '.github/idd/config.json',
) {
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
export function resolveAdvisoryConvergenceDeadlineMinutes(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};
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
  path = '.github/idd/config.json',
) {
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
export function resolveAdvisorySameHeadRerollCap(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};
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
  path = '.github/idd/config.json',
) {
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
export function readAdvisoryRecoveryCycleCap(path = '.github/idd/config.json') {
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
export function resolveAdvisoryRecoveryCycleCap(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};
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
  path = '.github/idd/config.json',
) {
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
export function resolveAdvisoryTerminalWindowMinutes(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};
  return normalizeConfiguredDurationMinutes(
    advisoryWait.terminalWindow,
    DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  );
}
export function normalizeAdvisoryWaitRuntimeOptions(options = {}) {
  const o = options ?? {};
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
function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
function normalizeConfiguredPositiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function normalizeConfiguredDurationMinutes(value, fallback) {
  const milliseconds = parseConfiguredDurationToMs(value);
  return milliseconds && milliseconds > 0 ? milliseconds / 60000 : fallback;
}
function normalizeConfiguredCapExhaustedRoute(value) {
  return typeof value === 'string' && ADVISORY_CAP_EXHAUSTED_ROUTES.has(value)
    ? value
    : ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT;
}
function normalizeCapExhaustedRoute(value) {
  const route = String(value ?? '').trim();
  return ADVISORY_CAP_EXHAUSTED_ROUTES.has(route)
    ? route
    : ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT;
}
function parseConfiguredDurationToMs(value) {
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
