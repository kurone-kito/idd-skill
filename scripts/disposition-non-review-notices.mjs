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
} from './protocol-helpers.mjs';

const DEFAULT_ADVISORY_BOT_LOGINS = [
  'coderabbitai[bot]',
  'chatgpt-codex-connector[bot]',
];
// CodeRabbit posts a completed review as a regular issue comment carrying this
// marker (see `classifyRegularBotComment`), not a PR review. A bot that has one
// has "reviewed" the PR, so its non-review notice must not be rejected.
const CODERABBIT_SUMMARY_MARKER =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';
/** True for a CodeRabbit completed-review summary comment. */
export function isCodeRabbitCompletedSummary(body) {
  return String(body ?? '')
    .trimStart()
    .startsWith(CODERABBIT_SUMMARY_MARKER);
}
/**
 * Derive the short `({reason})` clause for a non-review notice from its body.
 * Tightly tied to the categories `isAdvisoryNonReviewNotice` recognizes; falls
 * back to a generic label so an unrecognized-but-classified notice still gets a
 * coherent disposition.
 */
export function noticeReason(body) {
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
export function buildDispositionBody(botLogin, headSha, reason) {
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
export function buildDispositionPlan(input, options = {}) {
  // Key all advisory-bot comparisons by the suffix-insensitive identity token
  // (`coderabbitai[bot]` and `coderabbitai` collapse to one identity, matching
  // `dispositionNamesAdvisoryBot`), so a notice/review/disposition authored
  // under either variant counts against the same bot.
  const advisoryBotIdentities = new Set(
    normalizeTrustedMarkerLogins(
      options.advisoryBotLogins ?? DEFAULT_ADVISORY_BOT_LOGINS,
    ).map(advisoryBotIdentityToken),
  );
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  // Per advisory bot identity, the most recent time it produced a completed
  // review (a non-notice PR review, or a CodeRabbit summary comment). A notice
  // is left un-rejected only when a completed review landed AT OR AFTER it (the
  // notice is then stale); an OLDER review does not cover a newer notice. This
  // honours the E6 "re-validate just before posting" rule without skipping a
  // current notice merely because the bot reviewed an earlier HEAD.
  const completedReviewAtByBot = new Map();
  for (const [login, value] of Object.entries(
    options.completedReviewAtByBot ?? {},
  )) {
    const at = Date.parse(String(value ?? ''));
    if (Number.isNaN(at)) {
      continue;
    }
    const token = advisoryBotIdentityToken(login);
    completedReviewAtByBot.set(
      token,
      Math.max(
        completedReviewAtByBot.get(token) ?? Number.NEGATIVE_INFINITY,
        at,
      ),
    );
  }
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
  const dispositionCountByBot = new Map();
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
  const planned = [];
  const skipped = [];
  const coveredByBot = new Map();
  for (const comment of comments) {
    const identity = advisoryBotIdentityToken(comment.login);
    if (
      !advisoryBotIdentities.has(identity) ||
      !isAdvisoryNonReviewNotice(comment.body)
    ) {
      continue;
    }
    const reviewAt = completedReviewAtByBot.get(identity);
    const noticeAt = Date.parse(comment.createdAt);
    if (
      reviewAt !== undefined &&
      !Number.isNaN(noticeAt) &&
      reviewAt >= noticeAt
    ) {
      // A completed review landed at or after this notice, so the notice is
      // stale; accept that review separately and leave the notice un-rejected.
      skipped.push({
        noticeId: comment.id,
        botLogin: comment.login,
        reason: 'completed-review-present',
      });
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
function parseArgs(argv) {
  const args = {
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
  const splitList = (value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
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
function ghText(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}
function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}
/**
 * Fetch a paginated list endpoint as an array. `gh api --paginate` concatenates
 * one JSON array per page, so a >1-page response is not a single JSON document;
 * `--jq '.[]'` flattens each page to one JSON value per line (NDJSON), which we
 * parse line-by-line. (`--slurp` would be simpler but needs gh >= 2.48.0; Ubuntu
 * 24.04 LTS ships gh 2.45.0, so the repo standardizes on `--jq '.[]'`.)
 */
function ghJsonPaginated(args) {
  const out = execFileSync('gh', [...args, '--paginate', '--jq', '.[]'], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}
function isMainModule(moduleUrl) {
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
function loadIddConfig() {
  try {
    return JSON.parse(readFileSync('.github/idd/config.json', 'utf8'));
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
function claimStillActive(owner, repo, issue, claimId, isTrustedAuthor) {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${issue}/comments`,
  ]);
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
function postDisposition(owner, repo, pr, body) {
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
  ]);
}
/**
 * Find an already-posted disposition with this exact body authored by `viewer`.
 * Used after a failed create to detect a comment that landed server-side even
 * though `gh` exited nonzero (lost response), so a retry never double-posts a
 * marker the F2/F3 1:1 pairing would consume twice. The body is unique per
 * notice (bot + head SHA + reason), so an exact match is reliable.
 */
function findPostedDisposition(owner, repo, pr, body, viewerLogin) {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${pr}/comments`,
  ]);
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (
      (comment.user?.login ?? '').trim().toLowerCase() === viewerLogin &&
      (comment.body ?? '') === body
    ) {
      return { id: comment.id };
    }
  }
  return null;
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
  const pr = args.pr;
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
  // Build a plan from a fresh read of the PR's HEAD, comments, and reviews.
  // Called once for dry-run and again immediately before --apply posts, so a
  // HEAD advance, a disposition, or a completed review another session raced in
  // is reflected just-in-time (the apply path never reuses the dry-run snapshot).
  const planNow = () => {
    const headSha = ghText([
      'api',
      `repos/${owner}/${repo}/pulls/${pr}`,
      '--jq',
      '.head.sha',
    ]);
    const rawComments = ghJsonPaginated([
      'api',
      `repos/${owner}/${repo}/issues/${pr}/comments`,
    ]);
    const comments = rawComments.map((comment) => ({
      id: comment.id,
      login: comment.user?.login ?? '',
      body: comment.body ?? '',
      createdAt: comment.created_at ?? '',
    }));
    const reviews = ghJsonPaginated([
      'api',
      `repos/${owner}/${repo}/pulls/${pr}/reviews`,
    ]);
    // The latest time each bot produced a completed review the gate accepts: a
    // real (non-notice) PR review, or a CodeRabbit completed-summary comment
    // (CodeRabbit reviews land as regular issue comments, not PR reviews).
    // buildDispositionPlan compares these timestamps against each notice, so a
    // review only suppresses a notice it is at-or-newer than (a stale review of
    // an older HEAD does not cover a fresh notice).
    const completedReviewAtByBot = {};
    const recordCompletedReview = (login, at) => {
      const key = login.trim().toLowerCase();
      if (!key || !at) {
        return;
      }
      if (!completedReviewAtByBot[key] || completedReviewAtByBot[key] < at) {
        completedReviewAtByBot[key] = at;
      }
    };
    for (const review of reviews) {
      if (
        COMPLETED_REVIEW_STATES.has(String(review.state ?? '')) &&
        !isAdvisoryNonReviewNotice(review.body ?? '')
      ) {
        recordCompletedReview(
          review.user?.login ?? '',
          review.submitted_at ?? '',
        );
      }
    }
    for (const comment of comments) {
      if (isCodeRabbitCompletedSummary(comment.body)) {
        recordCompletedReview(comment.login, comment.createdAt);
      }
    }
    return buildDispositionPlan(
      { headSha, comments },
      { advisoryBotLogins, trustedMarkerLogins, completedReviewAtByBot },
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
  const claimIssue = args.claimIssue;
  const trustedAuthors = new Set(
    trustedMarkerLogins.map((login) => login.toLowerCase()),
  );
  const isTrustedAuthor = (login) =>
    trustedAuthors.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
  const revalidateClaim = () =>
    claimStillActive(owner, repo, claimIssue, args.claimId, isTrustedAuthor);
  if (!revalidateClaim()) {
    process.stderr.write(
      `claim revalidation failed: "${args.claimId}" is no longer the active claim on issue #${claimIssue}\n`,
    );
    process.exit(1);
  }
  // Re-plan from a fresh read AFTER claim revalidation, so the post loop never
  // re-posts a disposition (or rejects a notice whose bot just reviewed HEAD)
  // that raced in since the dry-run.
  const plan = planNow();
  const applied = [];
  const failed = [];
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
    let posted = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !posted; attempt += 1) {
      try {
        posted = postDisposition(owner, repo, pr, item.body);
      } catch (error) {
        lastError = error;
        // The create may have landed server-side despite the nonzero exit;
        // re-read before any retry so we never double-post the same marker.
        posted = findPostedDisposition(owner, repo, pr, item.body, viewerLogin);
      }
    }
    if (posted) {
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
