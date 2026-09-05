#!/usr/bin/env node
// idd-generated-from: src/scripts/advisory-comment-debounce.mts
//
// The scripts/advisory-comment-debounce.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Debounce check for `.github/workflows/idd-advisory-convergence-comment.yml`
// (#2643, following #2638's Groom-hearing decision). On PR #2628 that
// workflow's unconditional `rerun-advisory-convergence.mjs --apply` call
// fired 30 times in ~15 minutes, exhausting every same-HEAD instance's
// one-time rerun budget mid-burst. This CLI answers "has a newer
// IDD-originated comment/review event landed on this PR since my own
// triggering event?" after waiting a short quiet window -- if so, the
// caller should skip its own `--apply` call and let the later-triggered
// run (which asks the same question) handle it instead.
//
// Pure decision logic (`evaluateDebounceSkip`) is separated from live
// data collection, mirroring `stalled-session-quiet-check.mts`'s shape,
// so the decision is unit-testable without a live PR or a real wait.
import { appendFileSync } from 'node:fs';
import { parseDurationToMs } from './ci-wait-policy.mjs';
import { parseCliArgs } from './cli-args.mjs';
import {
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghText,
} from './gh-exec.mjs';
import { parsePaginatedGhNdjson } from './protocol-helpers.mjs';
import {
  classifyReviewCommentOrigin,
  resolveMarkerPrefix,
} from './review-comment-origin.mjs';

const DEFAULT_QUIET_WINDOW_MS = 45_000;
/**
 * True when `left` is strictly after `right` (both ISO8601). Invalid
 * timestamps compare as not-after (fail-safe: never treats an
 * unparsable event as "newer").
 */
function isAfter(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    return false;
  }
  return leftMs > rightMs;
}
/**
 * Decide whether to skip this run's own `--apply` call.
 *
 * `laterEvents` is the full candidate set (this CLI's live caller passes
 * every issue/review comment on the PR, not a pre-filtered set) --
 * events at or before `triggeredAt` are excluded here, not by the
 * caller, so a caller that forgets to pre-filter still gets the correct
 * answer. `skip` is true only when at least one strictly-newer event
 * classifies as IDD-originated via {@link classifyReviewCommentOrigin}
 * (imported, not reimplemented, so this never drifts from the existing
 * "Classify review comment" workflow step's own classification).
 */
export function evaluateDebounceSkip(input) {
  const laterCandidates = input.laterEvents.filter((event) =>
    isAfter(event.createdAt, input.triggeredAt),
  );
  const laterIddOriginated = laterCandidates
    .filter(
      (event) =>
        classifyReviewCommentOrigin(event.body, input.markerPrefix)
          .iddOriginated,
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (laterIddOriginated.length === 0) {
    return {
      skip: false,
      reason: 'no-newer-idd-originated-event',
      newerIddOriginatedEventAt: null,
      evidence: {
        laterEventCount: laterCandidates.length,
        laterIddOriginatedCount: 0,
      },
    };
  }
  const latest = laterIddOriginated.at(-1);
  return {
    skip: true,
    reason: 'newer-idd-originated-event',
    newerIddOriginatedEventAt: latest.createdAt,
    evidence: {
      laterEventCount: laterCandidates.length,
      laterIddOriginatedCount: laterIddOriginated.length,
    },
  };
}
const ADVISORY_COMMENT_DEBOUNCE_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--triggered-at': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--gh-token': { type: 'string', default: '' },
  '--marker-prefix': { type: 'string', default: '' },
  '--quiet-window-ms': { type: 'string', default: '' },
  '--now': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
};
if (import.meta.main) {
  runCli();
}
function runCli() {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    ADVISORY_COMMENT_DEBOUNCE_FLAG_SPEC,
  );
  if (help) {
    printUsage();
    process.exit(0);
  }
  const prToken = values.pr;
  const pr = prToken === undefined ? Number.NaN : Number.parseInt(prToken, 10);
  if (!Number.isInteger(pr) || pr <= 0) {
    fail_('--pr is required and must be a positive integer');
  }
  const triggeredAt = values['triggered-at'];
  if (!triggeredAt || Number.isNaN(Date.parse(triggeredAt))) {
    fail_('--triggered-at is required and must be a valid ISO8601 timestamp');
  }
  const ghToken = values['gh-token'];
  if (ghToken) {
    process.env.GH_TOKEN = ghToken;
    process.env.GITHUB_TOKEN = ghToken;
  }
  const owner =
    values.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repo =
    values.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repository = `${owner}/${repo}`;
  const quietWindowMs =
    parseDurationOrMsToken(values['quiet-window-ms']) ??
    DEFAULT_QUIET_WINDOW_MS;
  // Wait the quiet window before re-querying: give any in-flight
  // qualifying comment/review event time to land, so the re-query below
  // reflects the same "has anything newer arrived" question the design
  // intends, not a snapshot taken the instant this run started.
  waitMs(quietWindowMs);
  const markerPrefix = resolveMarkerPrefix(values['marker-prefix'] ?? '');
  const laterEvents = collectCandidateEvents(repository, pr);
  const result = evaluateDebounceSkip({
    triggeredAt,
    laterEvents,
    markerPrefix,
  });
  const output = {
    repository: { owner, repo },
    pr,
    triggeredAt,
    quietWindowMs,
    now: values.now || new Date().toISOString(),
    ...result,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `skip=${result.skip ? 'true' : 'false'}\n`);
  }
}
function parseDurationOrMsToken(token) {
  const trimmed = (token ?? '').trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return parseDurationToMs(trimmed);
}
function waitMs(ms) {
  if (ms <= 0) {
    return;
  }
  // Deliberately synchronous (Atomics.wait, not setTimeout+await): this
  // CLI's entire body runs top-level in `runCli()`, and a GitHub Actions
  // job step has nothing else useful to do while waiting -- a blocking
  // wait keeps this file free of async/await plumbing that every other
  // function in it (and its sibling `stalled-session-quiet-check.mts`)
  // does not otherwise need.
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}
function collectCandidateEvents(repository, pr) {
  const events = [];
  // Prefer updated_at over created_at (falling back when absent): an
  // edited comment's created_at still names its original post time, so
  // using it alone would misorder an edit against the trigger's own
  // updated_at-based TRIGGERED_AT (the workflow step passes that in).
  // updated_at equals created_at for a never-edited comment, so this is
  // safe for the common case too (#2650 review, Copilot).
  const issueComments = ghPaginatedJson([
    'api',
    `repos/${repository}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    '.[] | {createdAt: (.updated_at // .created_at), body: .body}',
  ]);
  for (const c of issueComments) {
    if (typeof c.createdAt === 'string') {
      events.push({ createdAt: c.createdAt, body: String(c.body ?? '') });
    }
  }
  const reviewComments = ghPaginatedJson([
    'api',
    `repos/${repository}/pulls/${pr}/comments`,
    '--paginate',
    '--jq',
    '.[] | {createdAt: (.updated_at // .created_at), body: .body}',
  ]);
  for (const rc of reviewComments) {
    if (typeof rc.createdAt === 'string') {
      events.push({ createdAt: rc.createdAt, body: String(rc.body ?? '') });
    }
  }
  return events;
}
function ghPaginatedJson(args) {
  if (!args.includes('--paginate') || !args.includes('--jq')) {
    throw new Error(
      `ghPaginatedJson requires both --paginate and --jq in args, got: ${args.join(' ')}`,
    );
  }
  return parsePaginatedGhNdjson(
    ghText(args, {
      ...GH_TEXT_LOOP_TIMEOUT_OPTIONS,
      timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS,
    }),
  );
}
function fail_(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}
function printUsage() {
  process.stdout.write(`Usage:
  node scripts/advisory-comment-debounce.mjs --pr <number> --triggered-at <ISO8601>
    [--owner <owner>] [--repo <repo>] [--gh-token <token>]
    [--marker-prefix <prefix>] [--quiet-window-ms <ms>|<ISO8601 duration>]
    [--now <ISO8601>]

Waits a short quiet window, then checks whether an IDD-originated
comment/review event has landed on the PR since --triggered-at. Prints
JSON {skip, reason, newerIddOriginatedEventAt, evidence, ...} and, when
$GITHUB_OUTPUT is set, writes skip=true|false there. Exit 0 on a
successful check (including skip=false); non-zero on a usage error or a
live-data collection failure (safe: the caller's own subsequent \`if:\`
step is then skipped by GitHub Actions' default sequential-failure
behavior, so a transient failure here never forces the caller's own
subsequent apply step to run unverified).
`);
}
