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
} from './protocol-helpers.mjs';

const DEFAULT_ADVISORY_BOT_LOGINS = [
  'coderabbitai[bot]',
  'chatgpt-codex-connector[bot]',
];
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
  return `**Rejected** — ${botLogin} did not review HEAD ${headSha} (${reason}); this is not a completed review.`;
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
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(
      options.advisoryBotLogins ?? DEFAULT_ADVISORY_BOT_LOGINS,
    ),
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
  // Trusted IDD non-review-notice dispositions, grouped per advisory bot login
  // they name (so each bot's existing dispositions only cover its own notices).
  const dispositionCountByBot = new Map();
  for (const comment of comments) {
    if (
      !trustedMarkerLogins.has(comment.login) ||
      !isNonReviewNoticeDisposition({ body: comment.body })
    ) {
      continue;
    }
    for (const botLogin of advisoryBotLogins) {
      if (dispositionNamesAdvisoryBot(comment.body, botLogin)) {
        dispositionCountByBot.set(
          botLogin,
          (dispositionCountByBot.get(botLogin) ?? 0) + 1,
        );
      }
    }
  }
  const planned = [];
  const skipped = [];
  const coveredByBot = new Map();
  for (const comment of comments) {
    if (
      !advisoryBotLogins.has(comment.login) ||
      !isAdvisoryNonReviewNotice(comment.body)
    ) {
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
  --claim-issue <number>         issue carrying the active claim (for --apply)
  --claim-id <claim-id>          active claim id to re-validate before --apply
  --agent-id <agent-id>          current session agent id
  --trusted-marker-logins a,b    logins whose existing dispositions count
  --advisory-bot-logins a,b      advisory bot logins (default: coderabbit + codex)
  --apply                        post the dispositions (default: dry-run)
  -h, --help                     show this help
`;
function resolveActiveClaimId(owner, repo, issue) {
  const comments = ghJson([
    'api',
    `repos/${owner}/${repo}/issues/${issue}/comments`,
    '--paginate',
  ]);
  let activeClaimId = null;
  for (const comment of comments) {
    const body = String(comment.body ?? '');
    const claimed = body.match(
      /<!--\s*claimed-by:\s*\S+\s+(\S+)\s+supersedes:/,
    );
    if (claimed) {
      activeClaimId = claimed[1];
      continue;
    }
    const unclaimed = body.match(/<!--\s*unclaimed-by:\s*\S+\s+(\S+)\s/);
    if (unclaimed && unclaimed[1] === activeClaimId) {
      activeClaimId = null;
    }
  }
  return activeClaimId;
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
if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !Number.isInteger(args.pr) || (args.pr ?? 0) <= 0) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const pr = args.pr;
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const headSha = ghText([
    'api',
    `repos/${owner}/${repo}/pulls/${pr}`,
    '--jq',
    '.head.sha',
  ]);
  const rawComments = ghJson([
    'api',
    `repos/${owner}/${repo}/issues/${pr}/comments`,
    '--paginate',
  ]);
  const comments = rawComments.map((comment) => ({
    id: comment.id,
    login: comment.user?.login ?? '',
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
  }));
  const plan = buildDispositionPlan(
    { headSha, comments },
    {
      advisoryBotLogins:
        args.advisoryBotLogins.length > 0 ? args.advisoryBotLogins : undefined,
      trustedMarkerLogins: args.trustedMarkerLogins,
    },
  );
  if (!args.apply) {
    process.stdout.write(
      `${JSON.stringify({ mode: 'dry-run', prNumber: pr, ...plan }, null, 2)}\n`,
    );
    process.exit(0);
  }
  // --apply: re-validate the active claim immediately before posting.
  if (Number.isInteger(args.claimIssue) && args.claimId) {
    const activeClaimId = resolveActiveClaimId(owner, repo, args.claimIssue);
    if (activeClaimId !== args.claimId) {
      process.stderr.write(
        `claim revalidation failed: active claim is "${activeClaimId ?? 'none'}", expected "${args.claimId}"\n`,
      );
      process.exit(1);
    }
  }
  const applied = [];
  const failed = [];
  for (const item of plan.planned) {
    let posted = null;
    for (let attempt = 0; attempt < 2 && !posted; attempt += 1) {
      try {
        posted = postDisposition(owner, repo, pr, item.body);
      } catch (error) {
        if (attempt === 1) {
          failed.push({
            noticeId: item.noticeId,
            error: error.message,
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
