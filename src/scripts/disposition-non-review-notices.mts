#!/usr/bin/env node
// idd-generated-from: src/scripts/disposition-non-review-notices.mts
//
// The scripts/disposition-non-review-notices.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Auto-disposition advisory non-review notices on a PR (E6 PATH B). Every
// autopilot PR draws advisory-bot rate-limit / usage-limit notices that are
// dispositioned deterministically as `**Rejected** — {bot} did not review HEAD
// {sha} ({reason}); this is not a completed review` — marker-first (#1038), one
// per notice (the F2/F3 gate pairs 1:1 by count), naming the bot's login so the
// #1018 author-scoped carry-forward attributes it. This helper detects those
// notices with the single-sourced `isAdvisoryNonReviewNotice` classifier and
// emits (dry-run) or posts (`--apply`) the canonical disposition, skipping
// notices already dispositioned so a re-run is idempotent. It is fail-closed:
// only classifier-recognized notices are dispositioned; real reviews and review
// threads are never touched.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  advisoryBotIdentityToken,
  dispositionNamesAdvisoryBot,
  isAdvisoryNonReviewNotice,
  isNonReviewNoticeDisposition,
  normalizeTrustedMarkerLogins,
  parseForcedHandoffComment,
  resolveActiveClaim,
  resolveAdvisoryBotLogins,
} from './protocol-helpers.mts';

const DEFAULT_ADVISORY_BOT_LOGINS = [
  'coderabbitai[bot]',
  'chatgpt-codex-connector[bot]',
];

export interface NoticeComment {
  id: number;
  login: string;
  body: string;
  createdAt: string;
}

export interface PlannedDisposition {
  noticeId: number;
  botLogin: string;
  reason: string;
  body: string;
}

export interface SkippedNotice {
  noticeId: number;
  botLogin: string;
  reason: string;
}

export interface DispositionPlan {
  headSha: string;
  planned: PlannedDisposition[];
  skipped: SkippedNotice[];
}

export interface AppliedDisposition {
  noticeId: number;
  commentId: number;
}

export interface FailedDisposition {
  noticeId: number;
  error: string;
}

/** The CLI output envelope for both `dry-run` and `--apply` modes. */
export interface DispositionReport {
  mode: 'dry-run' | 'apply';
  prNumber: number;
  headSha: string;
  planned?: PlannedDisposition[];
  status?: 'applied' | 'failed';
  applied?: AppliedDisposition[];
  failed?: FailedDisposition[];
  skipped: SkippedNotice[];
}

/**
 * Derive the short `({reason})` clause for a non-review notice from its body.
 * Tightly tied to the categories `isAdvisoryNonReviewNotice` recognizes; falls
 * back to a generic label so an unrecognized-but-classified notice still gets a
 * coherent disposition.
 */
export function noticeReason(body: unknown): string {
  const text = String(body ?? '');
  if (/rate limited by coderabbit\.ai|Review limit reached/i.test(text)) {
    return 'review limit reached / rate limited';
  }
  if (/Codex usage limits/i.test(text)) {
    return 'Codex usage limits for code reviews reached';
  }
  return 'advisory non-review notice';
}

/**
 * Build the canonical E6 non-review-notice disposition body: marker-first,
 * naming the bot's GitHub login (for the #1018 author-scoped carry-forward) and
 * the current head SHA.
 */
export function buildDispositionBody(
  botLogin: string,
  headSha: string,
  reason: string,
): string {
  return `**Rejected** — ${botLogin} did not review HEAD ${headSha} (${reason}); this is not a completed review`;
}

/**
 * Plan the dispositions for a PR's regular comments. Pure: takes the fetched
 * comments and returns which advisory non-review notices need a disposition and
 * which already have one. Per advisory bot, the count of trusted IDD non-review
 * notice dispositions naming that bot covers that many of its notices
 * (oldest-first); the remainder are planned. This mirrors the gate's
 * author-scoped 1:1 carry-forward, so the helper never posts a disposition the
 * gate would not credit and never double-posts on a re-run.
 */
export function buildDispositionPlan(
  input: { headSha: string; comments: NoticeComment[] },
  options: {
    advisoryBotLogins?: unknown[] | null;
    trustedMarkerLogins?: unknown[] | null;
  } = {},
): DispositionPlan {
  // Key all advisory-bot comparisons by the suffix-insensitive identity token
  // (`coderabbitai[bot]` and `coderabbitai` collapse to one identity, matching
  // `dispositionNamesAdvisoryBot`), so a notice/disposition authored under
  // either variant counts against the same bot.
  const advisoryBotIdentities = new Set(
    normalizeTrustedMarkerLogins(
      options.advisoryBotLogins ?? DEFAULT_ADVISORY_BOT_LOGINS,
    ).map(advisoryBotIdentityToken),
  );
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const headSha = String(input.headSha ?? '');

  const comments = (Array.isArray(input.comments) ? input.comments : [])
    .map((comment) => ({
      id: comment.id,
      login: String(comment.login ?? '')
        .trim()
        .toLowerCase(),
      body: String(comment.body ?? ''),
      createdAt: String(comment.createdAt ?? ''),
    }))
    .sort((left, right) => {
      const delta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return Number.isNaN(delta) ? 0 : delta;
    });

  // Trusted IDD non-review-notice dispositions, grouped per advisory bot
  // identity they name (so each bot's existing dispositions only cover its own
  // notices).
  const dispositionCountByBot = new Map<string, number>();
  for (const comment of comments) {
    if (
      !trustedMarkerLogins.has(comment.login) ||
      !isNonReviewNoticeDisposition({ body: comment.body })
    ) {
      continue;
    }
    // Count a disposition toward at most ONE bot it names. The F2/F3 gate
    // consumes a notice disposition at most once, so a combined marker naming
    // several bots must not be credited as covering one notice per bot (that
    // would let the helper skip notices the gate still blocks on).
    for (const identity of advisoryBotIdentities) {
      if (dispositionNamesAdvisoryBot(comment.body, identity)) {
        dispositionCountByBot.set(
          identity,
          (dispositionCountByBot.get(identity) ?? 0) + 1,
        );
        break;
      }
    }
  }

  // Every persistent advisory non-review notice needs its own `**Rejected**`
  // disposition, EVEN when the bot also has a completed review of the current
  // HEAD: `summarizeDispositionEvidenceForGate` keeps the notice in its
  // outstanding set until a notice-disposition naming that bot carries it, and
  // that disposition is consumed only by the notice (never clears the separate
  // completed review). So the helper always plans an undispositioned notice;
  // the completed review is accepted as its own item by the E6 flow.
  const planned: PlannedDisposition[] = [];
  const skipped: SkippedNotice[] = [];
  const coveredByBot = new Map<string, number>();
  for (const comment of comments) {
    const identity = advisoryBotIdentityToken(comment.login);
    if (
      !advisoryBotIdentities.has(identity) ||
      !isAdvisoryNonReviewNotice(comment.body)
    ) {
      continue;
    }
    const alreadyCovered = coveredByBot.get(identity) ?? 0;
    if (alreadyCovered < (dispositionCountByBot.get(identity) ?? 0)) {
      // An existing trusted disposition naming this bot already covers a notice;
      // attribute it (oldest-first) and skip this one as idempotent.
      coveredByBot.set(identity, alreadyCovered + 1);
      skipped.push({
        noticeId: comment.id,
        botLogin: comment.login,
        reason: 'already-dispositioned',
      });
      continue;
    }
    const reason = noticeReason(comment.body);
    planned.push({
      noticeId: comment.id,
      botLogin: comment.login,
      reason,
      body: buildDispositionBody(comment.login, headSha, reason),
    });
  }

  return { headSha, planned, skipped };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface CliArgs {
  pr: number | null;
  owner: string;
  repo: string;
  claimIssue: number | null;
  claimId: string;
  agentId: string;
  trustedMarkerLogins: string[];
  advisoryBotLogins: string[];
  apply: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    pr: null,
    owner: '',
    repo: '',
    claimIssue: null,
    claimId: '',
    agentId: '',
    trustedMarkerLogins: [],
    advisoryBotLogins: [],
    apply: false,
    help: false,
  };
  const splitList = (value: string): string[] =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = (): string => {
      index += 1;
      return argv[index] ?? '';
    };
    switch (flag) {
      case '--pr':
        args.pr = Number.parseInt(next(), 10);
        break;
      case '--owner':
        args.owner = next();
        break;
      case '--repo':
        args.repo = next();
        break;
      case '--claim-issue':
        args.claimIssue = Number.parseInt(next(), 10);
        break;
      case '--claim-id':
        args.claimId = next();
        break;
      case '--agent-id':
        args.agentId = next();
        break;
      case '--trusted-marker-logins':
        args.trustedMarkerLogins = splitList(next());
        break;
      case '--advisory-bot-logins':
        args.advisoryBotLogins = splitList(next());
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function ghText(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function ghJson(args: string[]): unknown {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

/**
 * Fetch a paginated list endpoint as an array. `gh api --paginate` concatenates
 * one JSON array per page, so a >1-page response is not a single JSON document;
 * `--jq '.[]'` flattens each page to one JSON value per line (NDJSON), which we
 * parse line-by-line. (`--slurp` would be simpler but needs gh >= 2.48.0; Ubuntu
 * 24.04 LTS ships gh 2.45.0, so the repo standardizes on `--jq '.[]'`.)
 */
function ghJsonPaginated(args: string[]): unknown[] {
  const out = execFileSync('gh', [...args, '--paginate', '--jq', '.[]'], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return moduleUrl === `file://${entry}` || moduleUrl.endsWith(entry);
}

const USAGE = `usage: node scripts/disposition-non-review-notices.mjs --pr <number> [options]

Detect advisory non-review notices on a PR and emit (default) or post
(--apply) the canonical E6 \`**Rejected** — {bot} did not review HEAD …\`
disposition, one marker-first comment per notice. Idempotent and fail-closed.

  --pr <number>                  PR number (required)
  --owner <owner>                repo owner (default: gh repo view)
  --repo <repo>                  repo name (default: gh repo view)
  --claim-issue <number>         issue carrying the active claim (required with --apply)
  --claim-id <claim-id>          active claim id to re-validate (required with --apply)
  --agent-id <agent-id>          current session agent id
  --trusted-marker-logins a,b    logins whose existing dispositions count
                                 (default: your gh login, so re-runs are idempotent)
  --advisory-bot-logins a,b      advisory bot logins (default: flag > IDD_ADVISORY_BOT_LOGINS
                                 > .github/idd/config.json > coderabbit + codex)
  --apply                        post the dispositions (default: dry-run)
  -h, --help                     show this help
`;

function loadIddConfig(): { advisoryBotLogins?: unknown } | null {
  try {
    return JSON.parse(readFileSync('.github/idd/config.json', 'utf8')) as {
      advisoryBotLogins?: unknown;
    };
  } catch {
    return null;
  }
}

/**
 * Re-fetch the claim issue and decide whether the supplied claim id is still the
 * active claim. Scoped to trusted marker authors via the shared
 * `resolveActiveClaim` state machine (so a copied/forged `claimed-by` marker
 * from an untrusted author cannot satisfy the gate), and fails closed on any
 * `forced-handoff` marker that targets this claim — regardless of the marker's
 * author, since an authorizing maintainer is typically not in the trusted set.
 * Aborting on a contested claim is always safe (the manual E6 path remains).
 */
function claimStillActive(
  owner: string,
  repo: string,
  issue: number,
  claimId: string,
  isTrustedAuthor: (login: string) => boolean,
): boolean {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${issue}/comments`,
  ]) as { body?: string; created_at?: string; user?: { login?: string } }[];
  for (const comment of comments) {
    const forcedHandoff = parseForcedHandoffComment(
      comment.body ?? '',
      comment.created_at ?? '',
    );
    if (forcedHandoff && forcedHandoff.oldClaimId === claimId) {
      return false;
    }
  }
  const events = comments.map((comment) => ({
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  }));
  return resolveActiveClaim(events, isTrustedAuthor)?.claimId === claimId;
}

function postDisposition(
  owner: string,
  repo: string,
  pr: number,
  body: string,
): { id: number } {
  // A disposition body is plain text starting with `**Rejected**` (not an
  // HTML-comment-first marker), so the `-f body=` field path posts it
  // reliably; gh sends `{"body": <value>}` to the comments API.
  return ghJson([
    'api',
    '--method',
    'POST',
    `repos/${owner}/${repo}/issues/${pr}/comments`,
    '-f',
    `body=${body}`,
  ]) as { id: number };
}

/** Ids of all comments on the PR authored by `viewerLogin`. */
function viewerCommentIds(
  owner: string,
  repo: string,
  pr: number,
  viewerLogin: string,
): Set<number> {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${pr}/comments`,
  ]) as { id: number; user?: { login?: string } }[];
  const ids = new Set<number>();
  for (const comment of comments) {
    if ((comment.user?.login ?? '').trim().toLowerCase() === viewerLogin) {
      ids.add(comment.id);
    }
  }
  return ids;
}

/**
 * After a failed create, find a viewer-authored comment with this exact body
 * whose id is NOT in `knownIds` — i.e., one created since posting began. Two
 * notices from the same bot on the same HEAD share an identical canonical body,
 * so keying recovery on a NEW comment id (not body uniqueness) is what stops the
 * helper from mistaking an earlier notice's marker for a failed create, which
 * would under-count the markers the F2/F3 1:1 pairing needs.
 */
function recoverPostedDisposition(
  owner: string,
  repo: string,
  pr: number,
  body: string,
  viewerLogin: string,
  knownIds: Set<number>,
): { id: number } | null {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${pr}/comments`,
  ]) as { id: number; user?: { login?: string }; body?: string }[];
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (
      !knownIds.has(comment.id) &&
      (comment.user?.login ?? '').trim().toLowerCase() === viewerLogin &&
      (comment.body ?? '') === body
    ) {
      return { id: comment.id };
    }
  }
  return null;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !Number.isInteger(args.pr) || (args.pr ?? 0) <= 0) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  // Fail closed: --apply mutates PR state, so the active-claim revalidation is
  // mandatory. Missing/invalid claim inputs must abort before any read or write
  // rather than silently bypassing the gate.
  if (
    args.apply &&
    (!Number.isInteger(args.claimIssue) ||
      (args.claimIssue ?? 0) <= 0 ||
      !args.claimId)
  ) {
    process.stderr.write(
      '--apply requires --claim-issue and --claim-id for the mandatory claim revalidation\n',
    );
    process.exit(1);
  }
  const pr = args.pr as number;
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);

  // Default the trusted disposition authors to this gh login. Existing
  // dispositions only count toward idempotency when their author is trusted, so
  // without this default a re-run would not recognize its own prior posts and
  // would double-post. The same trusted set scopes claim revalidation below.
  const viewerLogin = ghText(['api', 'user', '--jq', '.login']).toLowerCase();
  const trustedMarkerLogins =
    args.trustedMarkerLogins.length > 0
      ? args.trustedMarkerLogins
      : [viewerLogin];
  // Resolve advisory bot logins from flag > env > config (the same sources the
  // sibling helpers use), falling back to the CodeRabbit/Codex defaults so a
  // repo that configures custom advisory bots is not silently omitted.
  const resolvedAdvisoryBotLogins = resolveAdvisoryBotLogins({
    flagValue: args.advisoryBotLogins,
    envValue: process.env.IDD_ADVISORY_BOT_LOGINS,
    config: loadIddConfig(),
  }).logins;
  const advisoryBotLogins =
    resolvedAdvisoryBotLogins.length > 0
      ? resolvedAdvisoryBotLogins
      : DEFAULT_ADVISORY_BOT_LOGINS;

  // Build a plan from a fresh read of the PR's HEAD and comments. Called once
  // for dry-run and again immediately before --apply posts, so a HEAD advance or
  // a disposition another session raced in is reflected just-in-time (the apply
  // path never reuses the dry-run snapshot).
  const planNow = (): DispositionPlan => {
    const headSha = ghText([
      'api',
      `repos/${owner}/${repo}/pulls/${pr}`,
      '--jq',
      '.head.sha',
    ]);
    const rawComments = ghJsonPaginated([
      'api',
      `repos/${owner}/${repo}/issues/${pr}/comments`,
    ]) as {
      id: number;
      user?: { login?: string };
      body?: string;
      created_at?: string;
    }[];
    const comments: NoticeComment[] = rawComments.map((comment) => ({
      id: comment.id,
      login: comment.user?.login ?? '',
      body: comment.body ?? '',
      createdAt: comment.created_at ?? '',
    }));
    return buildDispositionPlan(
      { headSha, comments },
      { advisoryBotLogins, trustedMarkerLogins },
    );
  };

  if (!args.apply) {
    process.stdout.write(
      `${JSON.stringify({ mode: 'dry-run', prNumber: pr, ...planNow() }, null, 2)}\n`,
    );
    process.exit(0);
  }

  // --apply: revalidate the active claim immediately before EACH post, scoped to
  // trusted marker authors and failing closed on a forced handoff. Re-checking
  // per post means a claim released, superseded, or handed off mid-loop stops
  // the remaining writes instead of posting under a lost claim.
  const claimIssue = args.claimIssue as number;
  const trustedAuthors = new Set(
    trustedMarkerLogins.map((login) => login.toLowerCase()),
  );
  const isTrustedAuthor = (login: string): boolean =>
    trustedAuthors.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
  const revalidateClaim = (): boolean =>
    claimStillActive(owner, repo, claimIssue, args.claimId, isTrustedAuthor);

  if (!revalidateClaim()) {
    process.stderr.write(
      `claim revalidation failed: "${args.claimId}" is no longer the active claim on issue #${claimIssue}\n`,
    );
    process.exit(1);
  }

  // Re-plan from a fresh read AFTER claim revalidation, so the post loop never
  // re-posts a disposition that raced in since the dry-run.
  const plan = planNow();
  const applied: AppliedDisposition[] = [];
  const failed: FailedDisposition[] = [];
  // Track every viewer-authored comment id we know about (pre-existing plus the
  // ones we post), so a post-failure recovery attributes a NEW comment to the
  // current notice instead of an earlier notice with an identical body.
  const knownViewerCommentIds = viewerCommentIds(owner, repo, pr, viewerLogin);
  let claimLost = false;
  for (const item of plan.planned) {
    if (!revalidateClaim()) {
      // Claim lost mid-loop: stop writing and surface the remaining notices as
      // failed rather than posting them under a claim we no longer hold.
      claimLost = true;
      failed.push({
        noticeId: item.noticeId,
        error: 'claim revalidation failed before post',
      });
      break;
    }
    let posted: { id: number } | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2 && !posted; attempt += 1) {
      try {
        posted = postDisposition(owner, repo, pr, item.body);
      } catch (error) {
        lastError = error as Error;
        // The create may have landed server-side despite the nonzero exit;
        // re-read (by NEW comment id) before any retry so we never double-post.
        posted = recoverPostedDisposition(
          owner,
          repo,
          pr,
          item.body,
          viewerLogin,
          knownViewerCommentIds,
        );
      }
    }
    if (posted) {
      knownViewerCommentIds.add(posted.id);
      applied.push({ noticeId: item.noticeId, commentId: posted.id });
    } else {
      failed.push({
        noticeId: item.noticeId,
        error: lastError?.message ?? 'unknown error',
      });
    }
  }

  const status = failed.length > 0 ? 'failed' : 'applied';
  process.stdout.write(
    `${JSON.stringify({ mode: 'apply', prNumber: pr, headSha: plan.headSha, status, applied, failed, skipped: plan.skipped }, null, 2)}\n`,
  );
  process.exit(claimLost || failed.length > 0 ? 1 : 0);
}
