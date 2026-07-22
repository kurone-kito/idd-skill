#!/usr/bin/env node
// idd-generated-from: src/scripts/advisory-wait-state.mts
//
// The scripts/advisory-wait-state.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';

import {
  DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  readAdvisoryPrimaryBotLogin,
  readAdvisoryRecoveryCycleCap,
  readAdvisorySecondaryBotLogin,
  readAdvisoryTerminalWindowMinutes,
  readAdvisoryWaitPolicy,
} from './advisory-wait-policy.mts';
import { parseCliArgs } from './cli-args.mts';
import { ghText, safeGhText } from './gh-exec.mts';
import { loadIddConfig } from './idd-config.mts';
import type { TrustedMarkerActorResolution } from './protocol-helpers.mts';
import {
  buildAdvisoryWaitSummary,
  compareIsoTimestamps,
  isValidIsoTimestamp,
  normalizeTrustedMarkerLogins,
  parseAdvisoryRecoveryComment,
  parsePaginatedGhNdjson,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  body?: string | null;
  created_at?: string | null;
  user?: GhAuthorPayload | null;
}

/** PR review payload fields consumed by the advisory-wait summary. */
interface ReviewPayload {
  state?: string | null;
  user?: GhAuthorPayload | null;
  submitted_at?: string | null;
  commit_id?: string | null;
}

/** Timeline event payload fields consumed by the Copilot coverage check. */
interface TimelineEventPayload {
  event?: string | null;
  sha?: string | null;
  commit_id?: string | null;
  requested_reviewer?: GhAuthorPayload | null;
}

/** Parsed CLI arguments. */
interface AdvisoryWaitStateArgs {
  prNumber: number | null;
  owner: string;
  repo: string;
  trustedMarkerLogins: string;
  claimId: string;
  agentId: string;
  now: string;
  help: boolean;
}

/** Minimal comment shape consumed by {@link buildCopilotRecoverySummary}. */
interface CopilotRecoveryCommentLike {
  author?: { login?: string | null } | null;
  body?: string | null;
  createdAt?: string | null;
}

/**
 * `#1572` terminal Copilot-unavailability state: the recovery-cycle cap
 * accounting, the trusted terminal clock anchor, and the fail-closed
 * `COPILOT_UNAVAILABLE` / `NOT_TERMINAL` determination. Deliberately a
 * standalone object -- the existing `outcome` / `f3Outcome` fields computed
 * by the untouched `buildAdvisoryWaitSummary` never read from it, and it
 * never reads from or feeds any advisory-satisfied field. Consumers may
 * treat `state: "COPILOT_UNAVAILABLE"` only as waiver *eligibility*
 * (idd-advisory-wait.instructions.md), never as advisory satisfaction on
 * its own.
 */
export interface CopilotRecoverySummary {
  /** Configured per-PR-HEAD recovery-cycle cap (default 2). */
  cap: number;
  /**
   * Count of trusted, active-claim-bound, current-HEAD-bound
   * `advisory-recovery` markers. A completed cycle is counted by marker
   * *presence*, never by the largest embedded `attempt` number (that field
   * is a diagnostic only).
   */
  completedCycleCount: number;
  /** `max(cap - completedCycleCount, 0)`. */
  remainingBudget: number;
  /** `completedCycleCount >= cap`. */
  capExhausted: boolean;
  /** Configured terminal-unavailability window in minutes (default 720). */
  terminalWindowMinutes: number;
  /**
   * GitHub `created_at` of the *earliest* trusted, bound, current-HEAD
   * `advisory-recovery` marker; `''` when none exists. Embedded marker
   * timestamps are diagnostics only and never move this anchor -- only the
   * GitHub-assigned comment `created_at` counts, mirroring the
   * `review-watermark` / claim-heartbeat clock rule elsewhere in this
   * protocol.
   */
  clockAnchor: string;
  /** Minutes between `clockAnchor` and `now`; `0` when there is no anchor. */
  elapsedMinutes: number;
  /** `clockAnchor !== '' && elapsedMinutes >= terminalWindowMinutes`. */
  windowElapsed: boolean;
  /**
   * `true` only when both a claim id and an agent id were supplied to bind
   * the active claim. Without both, no marker can be proven to belong to
   * the current claim, so evidence is incomplete and the state fails closed
   * to `NOT_TERMINAL`.
   */
  activeClaimProvided: boolean;
  /** `COPILOT_UNAVAILABLE` only when every proof condition holds; else `NOT_TERMINAL`. */
  state: 'NOT_TERMINAL' | 'COPILOT_UNAVAILABLE';
  /** Machine-readable reason for the current `state`. */
  reason: string;
}

const COPILOT_RECOVERY_REASONS = {
  activeClaimNotProvided: 'active-claim-not-provided',
  noTrustedRecoveryMarkers: 'no-trusted-recovery-markers',
  capNotExhausted: 'recovery-cap-not-exhausted',
  windowNotElapsed: 'terminal-window-not-elapsed',
  currentHeadReviewExists: 'current-head-review-exists',
  copilotUnavailable:
    'recovery-cap-exhausted-and-terminal-window-elapsed-and-no-current-head-review',
} as const;

function minutesBetweenIso(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 60000);
}

/**
 * Compute the `#1572` terminal Copilot stall-recovery state from
 * already-fetched PR comments plus the already-computed
 * `buildAdvisoryWaitSummary` evidence (`prHeadSha`, `lastCopilotCommit`).
 * Pure and network-free -- issues no `gh` calls of its own, so calling it
 * twice with the same input is trivially idempotent, and its output is a
 * deterministic function of the observed marker *set* (order-independent),
 * matching `findActivationNonceWinner`'s and `summarizeAdvisoryWaitMarkers`'s
 * shared "re-read must reconverge" design.
 *
 * A candidate `advisory-wait-recovery:` comment counts as one completed
 * recovery cycle only when ALL of the following hold -- any single failure
 * excludes it from both `completedCycleCount` and `clockAnchor` (fail
 * closed; never a whole-computation abort):
 *  - the comment author is a trusted marker actor (else: untrusted);
 *  - the body parses as the BOUND form via `parseAdvisoryRecoveryComment`
 *    (a malformed body, or the legacy unbound 3-field form, both parse to
 *    `null`: malformed / unbound);
 *  - the marker's `agentId` equals the supplied `agentId` (else:
 *    foreign-agent);
 *  - the marker's `claimId` equals the supplied `claimId` (else:
 *    mismatched-claim);
 *  - the marker's `headSha` equals `prHeadSha` (else: mismatched-HEAD,
 *    including both an earlier and a later HEAD than the current one);
 *  - the comment's GitHub `created_at` validates as an ISO 8601 UTC
 *    timestamp (else: ambiguous-created-at -- excluded from BOTH counting
 *    and anchoring, never counted with a missing anchor contribution).
 */
export function buildCopilotRecoverySummary(
  {
    comments = [],
    prHeadSha,
    lastCopilotCommit,
  }: {
    comments?: CopilotRecoveryCommentLike[];
    prHeadSha: string;
    lastCopilotCommit: string;
  },
  options: {
    now: string;
    trustedMarkerLogins?: unknown[] | null;
    claimId?: string | null;
    agentId?: string | null;
    recoveryCycleCap?: number;
    terminalWindowMinutes?: number;
  },
): CopilotRecoverySummary {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  const normalizedPrHeadSha = String(prHeadSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedPrHeadSha)) {
    throw new Error('prHeadSha must be a 40-character lowercase commit SHA');
  }

  const cap = normalizePositiveIntegerOption(
    options.recoveryCycleCap,
    DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  );
  const terminalWindowMinutes = normalizePositiveNumberOption(
    options.terminalWindowMinutes,
    DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  );
  const trustedLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const claimId = String(options.claimId ?? '').trim();
  const agentId = String(options.agentId ?? '').trim();
  const activeClaimProvided = claimId !== '' && agentId !== '';

  let completedCycleCount = 0;
  let clockAnchor = '';

  if (activeClaimProvided) {
    for (const comment of comments) {
      const login = String(comment?.author?.login ?? '')
        .trim()
        .toLowerCase();
      if (!trustedLogins.has(login)) {
        continue; // untrusted
      }
      const marker = parseAdvisoryRecoveryComment(
        String(comment?.body ?? ''),
        String(comment?.createdAt ?? ''),
      );
      if (!marker) {
        continue; // malformed or the legacy unbound form
      }
      if (marker.agentId !== agentId) {
        continue; // foreign-agent
      }
      if (marker.claimId !== claimId) {
        continue; // mismatched-claim
      }
      if (marker.headSha !== normalizedPrHeadSha) {
        continue; // mismatched-HEAD (earlier or later)
      }
      if (!isValidIsoTimestamp(marker.createdAt)) {
        // Ambiguous server createdAt (parse helpers set this to 'none' when
        // the caller-supplied timestamp did not validate): exclude from
        // BOTH cycle counting and clock anchoring, not anchoring alone.
        // Otherwise an evidence gap could still consume recovery-cycle
        // budget without ever contributing a trustworthy clock anchor,
        // contradicting the "both counting and anchoring must be derived
        // from trusted server-created_at evidence" fail-closed contract.
        continue;
      }
      completedCycleCount += 1;
      if (
        !clockAnchor ||
        compareIsoTimestamps(marker.createdAt, clockAnchor) < 0
      ) {
        clockAnchor = marker.createdAt;
      }
    }
  }

  const remainingBudget = Math.max(cap - completedCycleCount, 0);
  const capExhausted = completedCycleCount >= cap;
  const elapsedMinutes = clockAnchor ? minutesBetweenIso(clockAnchor, now) : 0;
  const windowElapsed =
    clockAnchor !== '' && elapsedMinutes >= terminalWindowMinutes;
  const currentHeadReviewExists =
    String(lastCopilotCommit ?? '').toLowerCase() === normalizedPrHeadSha;

  let state: CopilotRecoverySummary['state'] = 'NOT_TERMINAL';
  let reason: string;
  if (!activeClaimProvided) {
    reason = COPILOT_RECOVERY_REASONS.activeClaimNotProvided;
  } else if (clockAnchor === '') {
    reason = COPILOT_RECOVERY_REASONS.noTrustedRecoveryMarkers;
  } else if (!capExhausted) {
    reason = COPILOT_RECOVERY_REASONS.capNotExhausted;
  } else if (!windowElapsed) {
    reason = COPILOT_RECOVERY_REASONS.windowNotElapsed;
  } else if (currentHeadReviewExists) {
    reason = COPILOT_RECOVERY_REASONS.currentHeadReviewExists;
  } else {
    state = 'COPILOT_UNAVAILABLE';
    reason = COPILOT_RECOVERY_REASONS.copilotUnavailable;
  }

  return {
    cap,
    completedCycleCount,
    remainingBudget,
    capExhausted,
    terminalWindowMinutes,
    clockAnchor,
    elapsedMinutes,
    windowElapsed,
    activeClaimProvided,
    state,
    reason,
  };
}

function normalizePositiveIntegerOption(
  value: unknown,
  fallback: number,
): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizePositiveNumberOption(
  value: unknown,
  fallback: number,
): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * JSON state document printed by this CLI: the advisory-wait gate
 * evidence summary plus the trusted-marker actor provenance fields.
 */
export type AdvisoryWaitStateReport = ReturnType<
  typeof buildAdvisoryWaitSummary
> & {
  trustedMarkerActors: string[];
  trustedMarkerActorsSource: TrustedMarkerActorResolution['source'];
  copilotRecovery: CopilotRecoverySummary;
};

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls main() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see ci-wait-policy.mts's identical note).
const ADVISORY_WAIT_STATE_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  // #1572: OPTIONAL. When both --claim-id and --agent-id are supplied, the
  // `copilotRecovery` section binds to the active claim; when either is
  // absent, `copilotRecovery` fails closed to NOT_TERMINAL with
  // reason: active-claim-not-provided, and every other field this CLI
  // already prints is unaffected.
  '--claim-id': { type: 'string', default: '' },
  '--agent-id': { type: 'string', default: '' },
  '--now': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  main();
}

// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or make a
// `gh` call.
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }

  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const repoRef = `${owner}/${repo}`;
  const viewerLogin = safeGhText([
    'api',
    'user',
    '--jq',
    '.login',
  ]).toLowerCase();
  const { actors: configuredTrustedActors, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
      config: loadIddConfig(),
    });

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
  ]);

  const reviews = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/reviews`,
    true,
  ) as ReviewPayload[];
  const requestedReviewers = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/requested_reviewers`,
    false,
  ) as { users?: GhAuthorPayload[] | null };
  const timelineEvents = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/timeline`,
    true,
    ['-H', 'Accept: application/vnd.github+json'],
  ) as TimelineEventPayload[];
  const comments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
    true,
  ) as IssueCommentPayload[];

  const collaboratorTrustEnabled = isTruthy(
    process.env.IDD_TRUST_COLLABORATOR_MARKERS,
  );
  const trustedMarkerLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
    ...(collaboratorTrustEnabled
      ? resolveTrustedCollaboratorMarkerLogins(owner, repo, comments)
      : []),
  ]);
  const advisoryWaitPolicy = readAdvisoryWaitPolicy();
  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const secondaryBotLogin = readAdvisorySecondaryBotLogin();

  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha,
      reviews,
      requestedReviewers: requestedReviewers.users ?? [],
      timelineEvents,
      comments: comments.map(normalizeComment),
    },
    {
      now: args.now || new Date().toISOString().replace('.000Z', 'Z'),
      requestCap: advisoryWaitPolicy.requestCap,
      pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
      settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
      pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
      capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
      primaryBotLogin,
      secondaryBotLogin,
      viewerLogin,
      configuredTrustedActors,
      collaboratorTrustEnabled,
      trustedMarkerLogins,
    },
  );

  // Reuse summary.now (not a fresh new Date() call) so both computations
  // agree on the exact same instant.
  const copilotRecovery = buildCopilotRecoverySummary(
    {
      comments: comments.map(normalizeComment),
      prHeadSha,
      lastCopilotCommit: summary.lastCopilotCommit,
    },
    {
      now: summary.now,
      trustedMarkerLogins,
      claimId: args.claimId,
      agentId: args.agentId,
      recoveryCycleCap: readAdvisoryRecoveryCycleCap(),
      terminalWindowMinutes: readAdvisoryTerminalWindowMinutes(),
    },
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ...summary,
        trustedMarkerActors: configuredTrustedActors,
        trustedMarkerActorsSource,
        copilotRecovery,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Restores this file's pre-#1450 permissive `Number.parseInt` contract:
 * `Number.parseInt` accepts trailing-garbage ("42abc" -> 42) and
 * leading-zero ("007" -> 7) tokens the same way the original hand-rolled
 * `Number.parseInt(value ?? '', 10)` always did, then the original's own
 * `!Number.isInteger(...) || (... ?? 0) < 1` post-check collapses an
 * invalid or absent value to `null`. `cli-args.mts`'s
 * `parseCanonicalIntegerOrNull` is a poor substitute: its canonical-pattern
 * regex rejects those same permissive tokens outright, which is a real
 * contract change a CodeRabbit review on PR #1466 caught -- #1450's
 * acceptance criteria protect the post-parse integer contract as-is, only
 * flag *syntax* (missing/flag-shaped values, unknown flags) is meant to
 * tighten.
 */
function parseLenientPositiveIntegerOrNull(
  token: string | undefined,
): number | null {
  const value = Number.parseInt(token ?? '', 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

export function parseArgs(argv: string[]): AdvisoryWaitStateArgs {
  const { values, help } = parseCliArgs(argv, ADVISORY_WAIT_STATE_FLAG_SPEC);
  return {
    prNumber: parseLenientPositiveIntegerOrNull(
      values.pr as string | undefined,
    ),
    owner: values.owner as string,
    repo: values.repo as string,
    trustedMarkerLogins: values['trusted-marker-logins'] as string,
    claimId: values['claim-id'] as string,
    agentId: values['agent-id'] as string,
    now: values.now as string,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/advisory-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--claim-id <id> --agent-id <id>] [--now <ISO8601>]

--claim-id / --agent-id are OPTIONAL (#1572): when both are supplied, the
copilotRecovery section in the output binds recovery-cycle accounting and the
terminal clock to that active claim. When either is absent, copilotRecovery
fails closed to NOT_TERMINAL with reason: active-claim-not-provided.
`);
}

function normalizeComment(comment: IssueCommentPayload) {
  return {
    author: { login: comment.user?.login ?? '' },
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
  };
}

function resolveTrustedCollaboratorMarkerLogins(
  owner: string,
  repo: string,
  comments: IssueCommentPayload[],
): string[] {
  const advisoryAuthors = [
    ...new Set(
      comments
        .filter((comment) => advisoryMarkerComment(comment.body ?? ''))
        .map((comment) => comment.user?.login ?? '')
        .filter(Boolean),
    ),
  ];

  return advisoryAuthors.filter((login) => {
    const permission = safeGhText([
      'api',
      `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      '--jq',
      '.permission',
    ]).toLowerCase();

    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}

function advisoryMarkerComment(body: string): boolean {
  const normalized = String(body ?? '');
  return (
    normalized.startsWith('advisory-wait:') ||
    normalized.startsWith('advisory-wait-recovery:') ||
    normalized.startsWith('<!-- advisory-wait:')
  );
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}

function ghApiJson(
  path: string,
  paginate = false,
  extraArgs: string[] = [],
): unknown {
  const args = ['api', path, ...extraArgs];
  if (paginate) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    args.splice(1, 0, '--paginate', '--jq', '.[]');
    return parsePaginatedGhNdjson(
      execFileSync('gh', args, { encoding: 'utf8' }),
    );
  }
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}
