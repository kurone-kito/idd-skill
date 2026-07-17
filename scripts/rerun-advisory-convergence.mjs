#!/usr/bin/env node
// idd-generated-from: src/scripts/rerun-advisory-convergence.mts
//
// The scripts/rerun-advisory-convergence.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Read-only rerun-plan helper for stuck `idd-advisory-convergence` rollups
// (#1431). Automates the manual recovery documented in
// `idd-ci.instructions.md` §Rerun mechanics (#1381, extended by #1424): a
// PR HEAD can accumulate several `idd-advisory-convergence` check-run
// instances (the check fires on pull_request + pull_request_review +
// pull_request_review_comment, and `cancel-in-progress` cancels most of
// them), and the required-check rollup can stay pinned to a stale
// non-passing instance even after the real verdict converges. This helper
// fetches every check-run instance for the current HEAD via the commit
// check-runs API (not the recent-runs list, which can page the target run
// out of view -- see the module-level `fetchCheckRunsForRef` doc comment),
// classifies each instance, and prints the exact sequential `gh run rerun`
// recovery plan. It never calls `gh run rerun` (or any other mutating
// command) itself; a mutating `--apply` mode is a deliberate follow-up
// (out of scope here).
//
// Classification (five states -- the issue's three named buckets, `pass` /
// `rerun-eligible` / `bot-gated-skip`, are a subset here; `pending` and
// `unresolved` are additional fail-safe states so a live run is never
// force-classified into either "skip forever" or "safe to rerun", and an
// unresolvable run identity is reported instead of silently guessed or
// silently dropped):
//   - `pass`: conclusion is success/neutral/skipped -- no action needed.
//   - `pending`: still queued/in_progress (no conclusion yet) -- reported,
//     excluded from the plan (rerunning a live run cancels it, not helps).
//   - `bot-gated-skip`: conclusion is `action_required`, OR the underlying
//     workflow run's actor/triggering_actor is a bot (`type === "Bot"` is
//     the primary signal; a configured advisory-bot login is a defensive
//     fallback) -- rerunning re-enters `action_required` per #1424, so this
//     needs a non-bot trigger or maintainer approval, never a rerun.
//   - `unresolved`: the run id could not be parsed from the check-run's
//     URL, or the per-run lookup itself failed -- reported for manual
//     inspection, never silently dropped and never placed in the plan
//     (fail-closed: an instance this helper cannot positively verify as
//     safe is never recommended for rerun).
//   - `rerun-eligible`: non-pass, terminal, non-bot, resolved -- goes into
//     the ordered rerun plan.
//
// Reuse map (no duplicated identity/config logic):
//   - `readAdvisoryPrimaryBotLogin`, `isCopilotReviewerLogin`,
//     `resolveAdvisoryBotLogins` -- the same bot-identity configuration and
//     matching every advisory-wait/-convergence helper already uses.
//   - `ghText`, `isCliExecution` -- shared `gh` execution + CLI-entry-point
//     guard (gh-exec.mts).
//   - `parsePaginatedGhNdjson` -- shared NDJSON pagination parser
//     (protocol-helpers.mts), reused directly here rather than through
//     `ghApiJson`'s `paginate` mode: that mode hardcodes `--jq '.[]'` for a
//     bare top-level array, but the commit check-runs endpoint's shape is
//     `{ total_count, check_runs: [...] }`, so this file's own
//     `fetchCheckRunsForRef` passes `--jq '.check_runs[]'` instead.
//
// This helper never mutates GitHub state: it only reads check-run/run data
// and prints a diagnosis plus a plan of commands for a human (or a future
// --apply follow-up) to execute.
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  readAdvisoryPrimaryBotLogin,
} from './advisory-wait-policy.mjs';
import { ghApiJson, ghText, isCliExecution } from './gh-exec.mjs';
import { loadIddConfig } from './idd-config.mjs';
import { isValidIsoTimestamp } from './marker-helpers.mjs';
import {
  isCopilotReviewerLogin,
  parsePaginatedGhNdjson,
  resolveAdvisoryBotLogins,
} from './protocol-helpers.mjs';
/** The check name this helper diagnoses. Matches
 * `ADVISORY_CONVERGENCE_CHECK_SELECTOR` in advisory-convergence.mts;
 * duplicated as a literal here (not imported) to keep this read-only
 * helper's dependency surface limited to what it actually needs --
 * advisory-convergence.mts pulls in the full claim/waiver/disposition
 * machinery this helper has no use for. */
export const RERUN_PLAN_CHECK_NAME = 'idd-advisory-convergence';
/** Check-run `conclusion` values treated as pass-equivalent, matching
 * `idd-ci.instructions.md`'s normalized required-check states. */
const PASS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
/** Check-run `status` values meaning "has not concluded yet". Only
 * consulted when `conclusion` is absent -- a completed run always reports
 * a conclusion, so this set is only reached pre-completion. */
const PENDING_STATUSES = new Set([
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending',
]);
/** Workflow-run trigger events this helper trusts to reliably refresh the
 * PR's required-check rollup on rerun, matching the events
 * `idd-advisory-convergence` itself subscribes to (its own header comment,
 * mirrored in `idd-ci.instructions.md` §Rerun mechanics): `pull_request`,
 * `pull_request_review`, `pull_request_review_comment`. A run triggered by
 * any other event -- most notably `workflow_dispatch` -- has no
 * `pull_request` context of its own and is documented as NOT reliably
 * associated with the PR's HEAD SHA, so rerunning it would not dependably
 * clear a stuck rollup even though the run itself is otherwise a plain,
 * non-bot failure. */
const PULL_REQUEST_FAMILY_EVENTS = new Set([
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
]);
const PLAN_CAVEAT =
  'Rerun the rerun-eligible instances ONE AT A TIME, in the order listed below, waiting for each `gh run rerun` to finish before starting the next -- rerunning several concurrently makes them cancel each other via the shared concurrency group.';
/**
 * Compute the deterministic rerun-plan verdict from already-fetched and
 * already-enriched check-run instances. Pure (no I/O), so it is directly
 * unit-testable with fixtures -- mirrors
 * `computeAdvisoryConvergenceVerdict` (advisory-convergence.mts).
 */
export function computeRerunPlan(input, options) {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  // Lowercased before validating, so a mixed-/upper-case 40-hex SHA is
  // accepted (normalized), matching advisory-convergence.mts's own rule.
  const prHeadSha = String(input.prHeadSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
    throw new Error('prHeadSha must be a 40-character hexadecimal commit SHA');
  }
  const checkName =
    String(input.checkName ?? '').trim() || RERUN_PLAN_CHECK_NAME;
  const owner = String(input.owner ?? '').trim();
  const repo = String(input.repo ?? '').trim();
  const primaryBotLogin =
    String(options.primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const advisoryBotLogins = normalizeLoginList(options.advisoryBotLogins ?? []);
  const classifyOptions = { primaryBotLogin, advisoryBotLogins };
  const instances = (input.instances ?? []).map((instance) =>
    classifyInstance(instance, classifyOptions),
  );
  const counts = {
    pass: 0,
    pending: 0,
    botGatedSkip: 0,
    unresolved: 0,
    rerunEligible: 0,
    total: instances.length,
  };
  for (const instance of instances) {
    if (instance.classification === 'pass') counts.pass += 1;
    else if (instance.classification === 'pending') counts.pending += 1;
    else if (instance.classification === 'bot-gated-skip')
      counts.botGatedSkip += 1;
    else if (instance.classification === 'unresolved') counts.unresolved += 1;
    else counts.rerunEligible += 1;
  }
  return {
    protocolVersion: '1',
    prNumber: Number(input.prNumber),
    prHeadSha,
    checkName,
    now,
    instances,
    counts,
    plan: buildOrderedPlan(instances, owner, repo),
    planCaveat: PLAN_CAVEAT,
  };
}
function normalizeLoginList(logins) {
  return logins
    .map((login) =>
      String(login ?? '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}
/**
 * Classify one check-run instance. Evaluated as a strict, ordered decision
 * list -- see the module header for the rationale behind each state and
 * why `pending`/`unresolved` exist beyond the issue's three named buckets.
 */
function classifyInstance(instance, options) {
  const status = String(instance.status ?? '')
    .trim()
    .toLowerCase();
  const conclusion = instance.conclusion
    ? String(instance.conclusion).trim().toLowerCase()
    : null;
  // 1. Pass-equivalent -- no action needed.
  if (conclusion && PASS_CONCLUSIONS.has(conclusion)) {
    return {
      ...instance,
      classification: 'pass',
      reason: `conclusion "${conclusion}" is pass-equivalent`,
    };
  }
  // 2. Still running -- rerunning a live run cancels it, never helps.
  if (!conclusion && PENDING_STATUSES.has(status)) {
    return {
      ...instance,
      classification: 'pending',
      reason: `status "${status}" has not concluded yet; rerunning a live run would cancel it instead of recovering it`,
    };
  }
  // 3. Bot-gated: action_required conclusion, or a bot-triggered actor.
  // Either signal alone is sufficient (matches the issue's literal
  // "bot-triggered / action_required" acceptance wording).
  const botTriggered = isBotTriggered(instance, options);
  if (conclusion === 'action_required' || botTriggered) {
    const actorDescription =
      instance.triggeringActorLogin ?? instance.actorLogin ?? 'unknown actor';
    const reason =
      conclusion === 'action_required' && botTriggered
        ? `conclusion is "action_required" and the triggering actor (${actorDescription}) is a bot; rerunning re-enters action_required (#1424) -- needs a non-bot trigger or maintainer approval`
        : conclusion === 'action_required'
          ? 'conclusion is "action_required"; rerunning without a non-bot trigger or maintainer approval re-enters action_required (#1424)'
          : `triggering actor (${actorDescription}) is a bot; rerunning re-enters action_required (#1424) -- needs a non-bot trigger or maintainer approval`;
    return { ...instance, classification: 'bot-gated-skip', reason };
  }
  // 4. Fail closed on an unresolvable run identity -- never guess.
  if (instance.runId === null) {
    return {
      ...instance,
      classification: 'unresolved',
      reason:
        "could not parse a workflow run id from this check-run's URL; inspect manually",
    };
  }
  if (instance.runLookupFailed) {
    return {
      ...instance,
      classification: 'unresolved',
      reason:
        'the underlying workflow run could not be fetched (network/permission/transient failure); inspect manually',
    };
  }
  // 5. Fail closed on a completed run with no conclusion (malformed/
  // unexpected payload) -- never assume it is safe to rerun.
  if (!conclusion) {
    return {
      ...instance,
      classification: 'unresolved',
      reason: `status "${status}" reported no conclusion; inspect manually`,
    };
  }
  // 6. Fail closed on a non-pull_request-family trigger event (most
  // commonly workflow_dispatch): rerunning it is not documented as a
  // reliable way to refresh the PR's required-check rollup, so never
  // recommend it -- see idd-ci.instructions.md Rerun mechanics.
  const runEvent = String(instance.runEvent ?? '')
    .trim()
    .toLowerCase();
  if (!PULL_REQUEST_FAMILY_EVENTS.has(runEvent)) {
    return {
      ...instance,
      classification: 'unresolved',
      reason: runEvent
        ? `triggering event "${runEvent}" is not pull_request-family (pull_request / pull_request_review / pull_request_review_comment); rerunning it is not a reliable way to refresh the PR's required-check rollup -- inspect manually`
        : 'triggering event is unknown; inspect manually rather than assuming it is safe to rerun',
    };
  }
  // 7. Non-pass, terminal, non-bot, resolved, pull_request-family --
  // safe to rerun.
  return {
    ...instance,
    classification: 'rerun-eligible',
    reason: `conclusion "${conclusion}" is non-passing, non-bot, and resolved (event "${runEvent}"); safe to rerun`,
  };
}
/**
 * `true` when the check-run instance's underlying workflow run was
 * triggered by a bot actor. `type === "Bot"` (checked on both `actor` and
 * `triggering_actor`) is the primary signal -- GitHub sets this
 * consistently for App/bot accounts regardless of login spelling. A
 * configured-login match (`isCopilotReviewerLogin` for the primary
 * advisory bot, or membership in the resolved `advisoryBotLogins` list)
 * is a defensive fallback for a payload that omits `type`.
 */
function isBotTriggered(instance, options) {
  if (instance.actorType === 'Bot' || instance.triggeringActorType === 'Bot') {
    return true;
  }
  const actorLogin = String(instance.actorLogin ?? '')
    .trim()
    .toLowerCase();
  const triggeringLogin = String(instance.triggeringActorLogin ?? '')
    .trim()
    .toLowerCase();
  if (
    (actorLogin &&
      isCopilotReviewerLogin(actorLogin, options.primaryBotLogin)) ||
    (triggeringLogin &&
      isCopilotReviewerLogin(triggeringLogin, options.primaryBotLogin))
  ) {
    return true;
  }
  const configuredBots = new Set(options.advisoryBotLogins);
  return configuredBots.has(actorLogin) || configuredBots.has(triggeringLogin);
}
/**
 * Build the ordered, deduplicated-by-run-id rerun plan from already-
 * classified instances. A `gh run rerun <id>` targets a workflow run, not
 * a check-run entry, so two check-run instances that resolved to the same
 * run id collapse into a single plan entry. Ordered by earliest known
 * `startedAt` (empty/unknown sorts first, as the more cautious default),
 * then numeric run id, so the output is deterministic across runs with the
 * same input.
 *
 * `owner`/`repo` are embedded as `-R owner/repo` on each generated command
 * (when both are non-empty) so the plan is safe to run from outside the
 * checkout this helper itself was invoked from -- `gh run rerun <id>` alone
 * resolves its target repository from the caller's cwd/`GH_REPO`, not from
 * whatever `--owner`/`--repo` this helper was given.
 */
function buildOrderedPlan(instances, owner, repo) {
  const repoFlag = owner && repo ? ` -R ${owner}/${repo}` : '';
  const eligible = instances.filter(
    (instance) => instance.classification === 'rerun-eligible',
  );
  const byRunId = new Map();
  for (const instance of eligible) {
    // rerun-eligible is only ever reached with a resolved, non-null runId
    // (see classifyInstance step 4), but guard defensively rather than
    // trusting that invariant silently.
    const runId = String(instance.runId ?? '').trim();
    if (!runId) continue;
    const list = byRunId.get(runId) ?? [];
    list.push(instance);
    byRunId.set(runId, list);
  }
  const entries = [...byRunId.entries()].map(([runId, items]) => {
    const startedAts = items
      .map((item) => item.startedAt)
      .filter((value) => Boolean(value))
      .sort();
    return {
      runId,
      command: `gh run rerun ${runId}${repoFlag}`,
      checkRunIds: items.map((item) => item.checkRunId),
      startedAt: startedAts[0] ?? '',
    };
  });
  entries.sort((left, right) => {
    if (left.startedAt !== right.startedAt) {
      return left.startedAt < right.startedAt ? -1 : 1;
    }
    const leftId = Number(left.runId);
    const rightId = Number(right.runId);
    if (
      Number.isFinite(leftId) &&
      Number.isFinite(rightId) &&
      leftId !== rightId
    ) {
      return leftId - rightId;
    }
    return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
  });
  return entries;
}
/**
 * Parse a workflow run id out of a GitHub Actions check-run `html_url` (or
 * `details_url`) such as
 * `https://github.com/{owner}/{repo}/actions/runs/<run-id>/job/<job-id>` --
 * the same URL shape `idd-ci.instructions.md`'s Rerun mechanics already
 * document extracting a run id from. Returns `null` (fails closed) rather
 * than guessing when the URL does not match.
 */
export function parseRunIdFromUrl(url) {
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(String(url ?? ''));
  return match ? match[1] : null;
}
export function parseArgs(argv) {
  const parsed = {
    prNumber: null,
    owner: '',
    repo: '',
    now: '',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--pr') {
      parsed.prNumber = Number.parseInt(value ?? '', 10);
      index += 1;
      continue;
    }
    if (token === '--owner') {
      parsed.owner = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--repo') {
      parsed.repo = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--now') {
      parsed.now = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  if (!Number.isInteger(parsed.prNumber) || (parsed.prNumber ?? 0) < 1) {
    parsed.prNumber = null;
  }
  return parsed;
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/rerun-advisory-convergence.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--now <ISO8601>] [--help]

Read-only: fetches every "${RERUN_PLAN_CHECK_NAME}" check-run instance for
the PR's current HEAD SHA (commit check-runs API, paged -- not the
recent-runs list, which can page the target run out of view), classifies
each as pass / pending / bot-gated-skip / unresolved / rerun-eligible, and
prints the ordered sequential "gh run rerun <id>" recovery plan for the
rerun-eligible instances. Never calls "gh run rerun" (or any other
mutating command) itself.
`);
}
const defaultDeps = { collect: collectFromGitHub };
/**
 * Parse argv, collect evidence (via `deps.collect`, real `gh` calls by
 * default), and compute the plan. Mirrors `runAdvisoryConvergence`'s DI
 * pattern (advisory-convergence.mts) so tests can substitute a fake
 * `collect` instead of shelling out to `gh`.
 */
export function runRerunAdvisoryConvergence(argv, deps = defaultDeps) {
  const args = parseArgs(argv);
  if (args.help) {
    return { plan: null, help: true };
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }
  const { input, options } = deps.collect(args);
  const plan = computeRerunPlan(input, options);
  return { plan, help: false };
}
/**
 * Fetch every check-run instance named `checkName` for `ref` via the
 * commit check-runs API, paginated.
 *
 * Deliberately NOT the recent-runs / workflow-runs list
 * (`GET /repos/{owner}/{repo}/actions/runs?head_sha=...`): that list is
 * ordered across every workflow in the repository, so a specific run for
 * a busy SHA can sit many pages deep -- exactly the "paged out of the
 * recent-runs window" problem the issue calls out. This endpoint is
 * scoped to the single commit and check name instead, via the documented
 * `check_name` query parameter.
 *
 * `--method GET` is required alongside the `-f check_name=...` field:
 * `gh api` defaults to POST as soon as any `-f`/`-F` value is present
 * (its own `--help` text: "The default HTTP request method is GET
 * normally and POST if any parameters were added"), and this endpoint
 * only accepts GET -- an unqualified `-f` here silently sends a POST that
 * 404s, confirmed against the live API while fixing #1431. `--method GET`
 * is what makes `-f` append to the query string instead.
 *
 * `-f filter=all` is required alongside `check_name`: this endpoint's own
 * `filter` query parameter defaults to `latest`, which -- per GitHub's own
 * documented behavior, confirmed empirically against this repo's actual
 * PR history during review -- collapses same-named check runs down to
 * only the most-recently-completed instance, silently dropping exactly
 * the older non-passing instance this helper exists to recover. Without
 * `filter=all`, `instances` can (and did, in the reproduction above) omit
 * real check-run instances even though `--paginate` runs correctly.
 *
 * Not built on {@link ghApiJson}'s own `paginate` option: that option
 * hardcodes `--jq '.[]'`, which assumes a bare top-level array, but this
 * endpoint's shape is `{ total_count, check_runs: [...] }` -- so this
 * function passes `--jq '.check_runs[]'` directly and reuses the same
 * {@link parsePaginatedGhNdjson} parser `ghApiJson` uses internally.
 */
export function buildCheckRunsForRefArgs(owner, repo, ref, checkName) {
  const path = `repos/${owner}/${repo}/commits/${ref}/check-runs`;
  return [
    'api',
    path,
    '--method',
    'GET',
    '-f',
    `check_name=${checkName}`,
    '-f',
    'filter=all',
    '--paginate',
    '--jq',
    '.check_runs[]',
  ];
}
/**
 * Resolve the URL used to extract a check-run's workflow-run id, preferring
 * `details_url` over `html_url`. For a GitHub-Actions-created check run
 * (which `idd-advisory-convergence` always is) the two are typically
 * identical, but the Checks API's own field semantics make `html_url` the
 * one more likely to diverge to a non-Actions permalink (e.g. a
 * `/checks/<check_run_id>`-shaped URL) -- `details_url` is documented as
 * "the full details of the check" and is the one this repo's own
 * `idd-ci.instructions.md` Rerun mechanics already document extracting a
 * run id from. Preferring it first costs nothing when the two agree and
 * avoids a spurious `unresolved` classification when they do not.
 */
export function resolveCheckRunUrl(run) {
  return String(run.details_url ?? run.html_url ?? '');
}
function fetchCheckRunsForRef(owner, repo, ref, checkName) {
  const raw = execFileSync(
    'gh',
    buildCheckRunsForRefArgs(owner, repo, ref, checkName),
    { encoding: 'utf8' },
  );
  return parsePaginatedGhNdjson(raw);
}
function collectFromGitHub(args) {
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const repoRef = `${owner}/${repo}`;
  const prHeadSha = ghText([
    'pr',
    'view',
    String(args.prNumber),
    '-R',
    repoRef,
    '--json',
    'headRefOid',
    '--jq',
    '.headRefOid',
  ]).toLowerCase();
  const rawCheckRuns = fetchCheckRunsForRef(
    owner,
    repo,
    prHeadSha,
    RERUN_PLAN_CHECK_NAME,
  );
  // Resolve each unique run id exactly once (a direct by-ID GET, never a
  // list scan -- see fetchCheckRunsForRef's doc comment for why lists are
  // avoided here).
  const runIdsToResolve = [
    ...new Set(
      rawCheckRuns
        .map((run) => parseRunIdFromUrl(resolveCheckRunUrl(run)))
        .filter((id) => id !== null),
    ),
  ];
  const runMetaById = new Map();
  for (const runId of runIdsToResolve) {
    try {
      const runPayload = ghApiJson(
        `repos/${owner}/${repo}/actions/runs/${runId}`,
      );
      runMetaById.set(runId, {
        event: runPayload.event ? String(runPayload.event) : null,
        actorLogin: runPayload.actor?.login ?? null,
        actorType: runPayload.actor?.type ?? null,
        triggeringActorLogin: runPayload.triggering_actor?.login ?? null,
        triggeringActorType: runPayload.triggering_actor?.type ?? null,
      });
    } catch {
      runMetaById.set(runId, null);
    }
  }
  const instances = rawCheckRuns.map((run) => {
    const url = resolveCheckRunUrl(run);
    const runId = parseRunIdFromUrl(url);
    const meta = runId !== null ? runMetaById.get(runId) : undefined;
    return {
      checkRunId: String(run.id ?? ''),
      status: String(run.status ?? ''),
      conclusion: run.conclusion ? String(run.conclusion) : null,
      htmlUrl: url,
      startedAt: run.started_at ? String(run.started_at) : null,
      completedAt: run.completed_at ? String(run.completed_at) : null,
      runId,
      runLookupFailed: runId !== null && meta === null,
      runEvent: meta?.event ?? null,
      actorLogin: meta?.actorLogin ?? null,
      actorType: meta?.actorType ?? null,
      triggeringActorLogin: meta?.triggeringActorLogin ?? null,
      triggeringActorType: meta?.triggeringActorType ?? null,
    };
  });
  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const rawConfig = loadIddConfig();
  const { logins: advisoryBotLogins } = resolveAdvisoryBotLogins({
    envValue: process.env.IDD_ADVISORY_BOT_LOGINS,
    config: rawConfig,
  });
  return {
    input: {
      prNumber: Number(args.prNumber),
      prHeadSha,
      checkName: RERUN_PLAN_CHECK_NAME,
      owner,
      repo,
      instances,
    },
    options: {
      now: args.now || new Date().toISOString().replace('.000Z', 'Z'),
      primaryBotLogin,
      advisoryBotLogins,
    },
  };
}
// CLI: emit the plan as JSON plus a human-readable ordered command list.
// Guarded behind isCliExecution(import.meta.url) (shared, see gh-exec.mts)
// so importing this module (for unit tests) never parses process.argv,
// prints usage, or makes a `gh` call.
if (isCliExecution(import.meta.url)) {
  const { plan, help } = runRerunAdvisoryConvergence(process.argv.slice(2));
  if (help) {
    printHelp();
  } else if (plan) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (plan.plan.length > 0) {
      process.stdout.write(
        '\nSequential recovery plan (run one at a time; wait for each to finish before the next):\n',
      );
      plan.plan.forEach((entry, index) => {
        process.stdout.write(`  ${index + 1}. ${entry.command}\n`);
      });
      process.stdout.write(`\n${plan.planCaveat}\n`);
    } else {
      process.stdout.write('\nNo rerun-eligible instances; nothing to do.\n');
    }
  }
  // Set exitCode and let the process end naturally instead of calling
  // process.exit(0) directly: an explicit exit() can terminate the process
  // before a large stdout write finishes flushing through a pipe (a
  // well-established Node.js footgun, confirmed empirically during
  // review), silently truncating the emitted JSON or recovery plan.
  process.exitCode = 0;
}
