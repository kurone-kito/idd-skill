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

import {
  dispositionNamesAdvisoryBot,
  isAdvisoryNonReviewNotice,
  isNonReviewNoticeDisposition,
  normalizeTrustedMarkerLogins,
  resolveActiveClaim,
} from './protocol-helpers.mts';

const DEFAULT_ADVISORY_BOT_LOGINS = [
  'coderabbitai[bot]',
  'chatgpt-codex-connector[bot]',
];

export interface NoticeComment {
  id: string | number;
  login: string;
  body: string;
  createdAt: string;
}

export interface PlannedDisposition {
  noticeId: string | number;
  botLogin: string;
  reason: string;
  body: string;
}

export interface SkippedNotice {
  noticeId: string | number;
  botLogin: string;
  reason: string;
}

export interface DispositionPlan {
  headSha: string;
  planned: PlannedDisposition[];
  skipped: SkippedNotice[];
}

export interface AppliedDisposition {
  noticeId: string | number;
  commentId: number;
}

export interface FailedDisposition {
  noticeId: string | number;
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
    botsWithCompletedHeadReview?: unknown[] | null;
  } = {},
): DispositionPlan {
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(
      options.advisoryBotLogins ?? DEFAULT_ADVISORY_BOT_LOGINS,
    ),
  );
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  // Advisory bots that already have a completed review of the current HEAD (a
  // distinct, non-notice review). Per the E6 "re-validate just before posting"
  // rule, their notice must not be rejected: the gate accepts that review, and
  // a later-timestamped `did not review HEAD` rejection could filter it out.
  const botsWithCompletedHeadReview = new Set(
    normalizeTrustedMarkerLogins(options.botsWithCompletedHeadReview ?? []),
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

  // Trusted IDD non-review-notice dispositions, grouped per advisory bot login
  // they name (so each bot's existing dispositions only cover its own notices).
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
    for (const botLogin of advisoryBotLogins) {
      if (dispositionNamesAdvisoryBot(comment.body, botLogin)) {
        dispositionCountByBot.set(
          botLogin,
          (dispositionCountByBot.get(botLogin) ?? 0) + 1,
        );
        break;
      }
    }
  }

  const planned: PlannedDisposition[] = [];
  const skipped: SkippedNotice[] = [];
  const coveredByBot = new Map<string, number>();
  for (const comment of comments) {
    if (
      !advisoryBotLogins.has(comment.login) ||
      !isAdvisoryNonReviewNotice(comment.body)
    ) {
      continue;
    }
    if (botsWithCompletedHeadReview.has(comment.login)) {
      // The bot has a completed review of the current HEAD; accept that review
      // separately and leave the notice un-rejected (E6 race re-validation).
      skipped.push({
        noticeId: comment.id,
        botLogin: comment.login,
        reason: 'completed-review-present',
      });
      continue;
    }
    const alreadyCovered = coveredByBot.get(comment.login) ?? 0;
    if (alreadyCovered < (dispositionCountByBot.get(comment.login) ?? 0)) {
      // An existing trusted disposition naming this bot already covers a notice;
      // attribute it (oldest-first) and skip this one as idempotent.
      coveredByBot.set(comment.login, alreadyCovered + 1);
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
  --advisory-bot-logins a,b      advisory bot logins (default: coderabbit + codex)
  --apply                        post the dispositions (default: dry-run)
  -h, --help                     show this help
`;

/**
 * Resolve the active claim id on an issue using the shared
 * `resolveActiveClaim` state machine, scoped to trusted marker authors. This
 * reuses the canonical claim parsing/validation (superseding, release,
 * forced-handoff) and — crucially — ignores claim markers posted by untrusted
 * authors, so a copied/forged `claimed-by` marker cannot satisfy revalidation.
 */
function resolveActiveClaimId(
  owner: string,
  repo: string,
  issue: number,
  isTrustedAuthor: (login: string) => boolean,
): string | null {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${issue}/comments`,
  ]) as { body?: string; created_at?: string; user?: { login?: string } }[];
  const events = comments.map((comment) => ({
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  }));
  return resolveActiveClaim(events, isTrustedAuthor)?.claimId ?? null;
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

const COMPLETED_REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
]);

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
  const advisoryBotLogins =
    args.advisoryBotLogins.length > 0 ? args.advisoryBotLogins : undefined;

  const headSha = ghText([
    'api',
    `repos/${owner}/${repo}/pulls/${pr}`,
    '--jq',
    '.head.sha',
  ]);

  // Build a plan from a fresh read of the PR's comments and reviews. Called once
  // for dry-run and again immediately before --apply posts, so a disposition (or
  // a completed review) another session raced in is reflected just-in-time.
  const planNow = (): DispositionPlan => {
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
    const reviews = ghJsonPaginated([
      'api',
      `repos/${owner}/${repo}/pulls/${pr}/reviews`,
    ]) as {
      user?: { login?: string };
      body?: string;
      commit_id?: string;
      state?: string;
    }[];
    // A bot that posted a real (non-notice) review of the current HEAD has
    // "reviewed HEAD" — its notice must not be rejected (see buildDispositionPlan).
    const botsWithCompletedHeadReview = Array.from(
      new Set(
        reviews
          .filter(
            (review) =>
              review.commit_id === headSha &&
              COMPLETED_REVIEW_STATES.has(String(review.state ?? '')) &&
              !isAdvisoryNonReviewNotice(review.body ?? ''),
          )
          .map((review) => review.user?.login ?? '')
          .filter(Boolean),
      ),
    );
    return buildDispositionPlan(
      { headSha, comments },
      { advisoryBotLogins, trustedMarkerLogins, botsWithCompletedHeadReview },
    );
  };

  if (!args.apply) {
    process.stdout.write(
      `${JSON.stringify({ mode: 'dry-run', prNumber: pr, ...planNow() }, null, 2)}\n`,
    );
    process.exit(0);
  }

  // --apply: re-validate the active claim immediately before posting, scoped to
  // trusted marker authors so a forged claim marker cannot satisfy the gate.
  const trustedAuthors = new Set(
    trustedMarkerLogins.map((login) => login.toLowerCase()),
  );
  const activeClaimId = resolveActiveClaimId(
    owner,
    repo,
    args.claimIssue as number,
    (login) =>
      trustedAuthors.has(
        String(login ?? '')
          .trim()
          .toLowerCase(),
      ),
  );
  if (activeClaimId !== args.claimId) {
    process.stderr.write(
      `claim revalidation failed: active claim is "${activeClaimId ?? 'none'}", expected "${args.claimId}"\n`,
    );
    process.exit(1);
  }

  // Re-plan from a fresh read AFTER claim revalidation, so the post loop never
  // re-posts a disposition (or rejects a notice whose bot just reviewed HEAD)
  // that raced in since the dry-run.
  const plan = planNow();
  const applied: { noticeId: string | number; commentId: number }[] = [];
  const failed: { noticeId: string | number; error: string }[] = [];
  for (const item of plan.planned) {
    let posted: { id: number } | null = null;
    for (let attempt = 0; attempt < 2 && !posted; attempt += 1) {
      try {
        posted = postDisposition(owner, repo, pr, item.body);
      } catch (error) {
        if (attempt === 1) {
          failed.push({
            noticeId: item.noticeId,
            error: (error as Error).message,
          });
        }
      }
    }
    if (posted) {
      applied.push({ noticeId: item.noticeId, commentId: posted.id });
    }
  }

  const status = failed.length > 0 ? 'failed' : 'applied';
  process.stdout.write(
    `${JSON.stringify({ mode: 'apply', prNumber: pr, headSha, status, applied, failed, skipped: plan.skipped }, null, 2)}\n`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}
