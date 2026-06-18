#!/usr/bin/env node
// idd-generated-from: src/scripts/merged-pr-feedback-sweep.mts
//
// The scripts/merged-pr-feedback-sweep.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Read-only helper: scan MERGED PRs for unresolved / unaddressed advisory
// feedback (review threads still open, and non-IDD-agent comments / review
// bodies that never received a later IDD-agent disposition). It only DETECTS
// and prints JSON — no minimization, no posting, no issue creation. The
// output is the input an operator hands to the issue-authoring skill, which
// re-verifies each candidate against current `main` and drafts follow-ups.
//
// This is the recurring counterpart of the one-time audit in #910 and the
// chosen recovery path from #909 (advisory-wait stays Copilot-only).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  hasFreshDisposition,
  isDispositionComment,
  isKnownReviewBot,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  resolveAdvisoryBotLogins,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
function authorLogin(node) {
  return String(node?.author?.login ?? node?.user?.login ?? '')
    .trim()
    .toLowerCase();
}
function commentTimestamp(node) {
  return node.createdAt ?? node.created_at ?? null;
}
function excerpt(body, max = 160) {
  const flat = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
function isLaterThan(a, b) {
  if (!a || !b) {
    return false;
  }
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    return false;
  }
  return ta > tb;
}
function maxTimestamp(values) {
  let best = null;
  for (const value of values) {
    if (value && (best === null || isLaterThan(value, best))) {
      best = value;
    }
  }
  return best;
}
function isDispositionBody(body) {
  const trimmed = String(body ?? '').trimStart();
  return (
    isDispositionComment({ body }) ||
    trimmed.startsWith('**Awaiting maintainer decision**')
  );
}
// Normalize a comma-separated login list; returns null when empty so callers
// can fall through to the next source in their precedence chain.
function resolveLoginList(value) {
  const tokens = value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.length > 0 ? normalizeTrustedMarkerLogins(tokens) : null;
}
// IDD bookkeeping comments are not reviewer feedback.
function isIddBookkeeping(body, author, isTrusted) {
  // IDD HTML-comment bookkeeping markers (cleanup-evidence, plan, digest,
  // roadmap-audit, …) are posted by the agent or by CI automation such as
  // github-actions, never by a reviewer; exclude them regardless of author.
  if (
    String(body ?? '')
      .trimStart()
      .startsWith('<!-- idd-')
  ) {
    return true;
  }
  // Operational-state markers (claimed-by / review-watermark / advisory-wait
  // / …) count only from a trusted marker author; an untrusted look-alike is
  // left in as surfacing context.
  return operationalMarkerPrefix(body ?? '') !== null && isTrusted(author);
}
// ---------------------------------------------------------------------------
// Pure sweep builder (the testable core — no network)
// ---------------------------------------------------------------------------
export function buildMergedPrFeedbackSweep(prs, options) {
  const idd = new Set(
    options.iddAgentLogins.map((login) => login.toLowerCase()),
  );
  const trusted = new Set(
    options.trustedMarkerActors.map((login) => login.toLowerCase()),
  );
  const advisory = new Set(
    options.advisoryBotLogins.map((login) => login.toLowerCase()),
  );
  const isIdd = (login) => idd.has(login);
  const isTrusted = (login) => trusted.has(login);
  const isAdvisoryBot = (login) =>
    isKnownReviewBot(login) || advisory.has(login);
  const findings = [];
  for (const pr of prs) {
    const unresolvedThreads = collectUnresolvedThreads(
      pr.threads ?? [],
      isIdd,
      isAdvisoryBot,
    );
    const unaddressedComments = collectUnaddressedComments(
      pr.comments ?? [],
      pr.reviews ?? [],
      isIdd,
      isTrusted,
      isAdvisoryBot,
    );
    if (unresolvedThreads.length === 0 && unaddressedComments.length === 0) {
      continue;
    }
    findings.push({
      number: pr.number,
      mergedAt: pr.mergedAt ?? null,
      mergeCommit: pr.mergeCommit ?? null,
      unresolvedThreads,
      unaddressedComments,
    });
  }
  return {
    prs: findings,
    summary: {
      prCount: prs.length,
      flaggedPrCount: findings.length,
      unresolvedThreadCount: findings.reduce(
        (total, pr) => total + pr.unresolvedThreads.length,
        0,
      ),
      unaddressedCommentCount: findings.reduce(
        (total, pr) => total + pr.unaddressedComments.length,
        0,
      ),
    },
  };
}
function collectUnresolvedThreads(threads, isIdd, isAdvisoryBot) {
  const out = [];
  for (const thread of threads) {
    // Only threads left open at merge time.
    if (thread.isResolved !== false) {
      continue;
    }
    const nodes = thread.comments?.nodes ?? [];
    const origin = nodes[0];
    const originAuthor = authorLogin(origin);
    // A thread the IDD agent itself opened is not reviewer feedback.
    if (originAuthor && isIdd(originAuthor)) {
      continue;
    }
    out.push({
      url: origin?.url ?? null,
      author: originAuthor || null,
      advisoryBot: isAdvisoryBot(originAuthor),
      path: thread.path ?? null,
      bodyExcerpt: excerpt(origin?.body),
      // `hasFreshDisposition` recognizes Accepted/Rejected; OR-in an IDD
      // `**Awaiting maintainer decision**` reply so AMD threads match the
      // comment-path disposition handling.
      dispositioned:
        hasFreshDisposition(
          { isResolved: thread.isResolved, comments: thread.comments },
          { isDispositionAuthor: isIdd },
        ) || threadHasIddAmd(thread, isIdd),
    });
  }
  return out;
}
function threadHasIddAmd(thread, isIdd) {
  return (thread.comments?.nodes ?? []).some(
    (comment) =>
      isIdd(authorLogin(comment)) &&
      String(comment.body ?? '')
        .trimStart()
        .startsWith('**Awaiting maintainer decision**'),
  );
}
function collectUnaddressedComments(
  comments,
  reviews,
  isIdd,
  isTrusted,
  isAdvisoryBot,
) {
  // A non-IDD item counts as addressed only when a later IDD-agent
  // *disposition* (Accepted / Rejected / Awaiting maintainer decision)
  // exists — markers and plain replies do not address feedback.
  const latestDispositionAt = maxTimestamp(
    comments
      .filter(
        (comment) =>
          isIdd(authorLogin(comment)) && isDispositionBody(comment.body),
      )
      .map(commentTimestamp),
  );
  const out = [];
  for (const comment of comments) {
    const author = authorLogin(comment);
    // IDD-agent comments (incl. their dispositions) are excluded by author
    // here, so a disposition marker is treated specially only when the agent
    // wrote it. A non-IDD reviewer who opens a comment with "**Rejected**" is
    // still surfaced as feedback.
    if (!author || isIdd(author)) {
      continue;
    }
    // IDD bookkeeping is not feedback: a trusted operational-state marker,
    // or any `<!-- idd-… -->` comment (e.g. cleanup-evidence / plan / digest,
    // which CI automation such as github-actions also posts).
    if (isIddBookkeeping(comment.body, author, isTrusted)) {
      continue;
    }
    if (isLaterThan(latestDispositionAt, commentTimestamp(comment))) {
      continue;
    }
    out.push({
      url: comment.url ?? comment.html_url ?? null,
      author,
      advisoryBot: isAdvisoryBot(author),
      kind: 'comment',
      bodyExcerpt: excerpt(comment.body),
    });
  }
  for (const review of reviews) {
    if (review.state !== 'CHANGES_REQUESTED') {
      continue;
    }
    const author = authorLogin(review);
    if (!author || isIdd(author)) {
      continue;
    }
    if (isLaterThan(latestDispositionAt, review.submittedAt ?? null)) {
      continue;
    }
    out.push({
      url: review.url ?? null,
      author,
      advisoryBot: isAdvisoryBot(author),
      kind: 'review',
      bodyExcerpt: excerpt(review.body),
    });
  }
  return out;
}
function parseArgs(argv) {
  const parsed = {
    since: null,
    days: null,
    prNumbers: [],
    limit: 100,
    owner: '',
    repo: '',
    trustedMarkerLogins: '',
    advisoryBotLogins: '',
    iddAgentLogins: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`missing value for ${token}`);
      }
      index += 1;
      return value;
    };
    const nextInt = () => {
      const raw = next();
      const value = Number.parseInt(raw, 10);
      if (
        !Number.isFinite(value) ||
        String(value) !== raw.trim() ||
        value < 1
      ) {
        throw new Error(`${token} expects a positive integer, got "${raw}"`);
      }
      return value;
    };
    switch (token) {
      case '--since':
        parsed.since = next();
        break;
      case '--days':
        parsed.days = nextInt();
        break;
      case '--pr':
        parsed.prNumbers.push(nextInt());
        break;
      case '--prs':
        for (const part of next().split(',')) {
          const trimmed = part.trim();
          const value = Number.parseInt(trimmed, 10);
          if (
            !Number.isFinite(value) ||
            String(value) !== trimmed ||
            value < 1
          ) {
            throw new Error(
              `--prs expects comma-separated positive integers, got "${part}"`,
            );
          }
          parsed.prNumbers.push(value);
        }
        break;
      case '--limit':
        parsed.limit = nextInt();
        break;
      case '--owner':
        parsed.owner = next();
        break;
      case '--repo':
        parsed.repo = next();
        break;
      case '--trusted-marker-logins':
        parsed.trustedMarkerLogins = next();
        break;
      case '--advisory-bot-logins':
        parsed.advisoryBotLogins = next();
        break;
      case '--idd-agent-logins':
        parsed.iddAgentLogins = next();
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  return parsed;
}
function resolveSinceDate(args) {
  if (args.since) {
    return args.since;
  }
  if (args.days && args.days > 0) {
    const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000;
    return new Date(cutoff).toISOString().slice(0, 10);
  }
  return null;
}
function loadIddConfig() {
  try {
    return JSON.parse(readFileSync('.github/idd/config.json', 'utf8'));
  } catch {
    return null;
  }
}
function runGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}
function ghGraphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) {
      continue;
    }
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  return JSON.parse(runGh(args).trim() || '{}');
}
function listMergedPrNumbers(repoRef, sinceDate, limit) {
  const args = [
    'pr',
    'list',
    '-R',
    repoRef,
    '--state',
    'merged',
    '--json',
    'number,mergedAt',
    '--limit',
    String(limit),
  ];
  if (sinceDate) {
    args.push('--search', `merged:>=${sinceDate}`);
  }
  const raw = runGh(args).trim();
  const items = raw ? JSON.parse(raw) : [];
  return items;
}
// Page a single `pullRequest` connection to completion so large PRs cannot
// silently truncate at 100 items (which would hide unresolved threads or a
// later disposition comment and produce a false negative). Per-thread reply
// pagination is intentionally left at first:100 — a thread with 100+ replies
// is pathological and only affects the advisory `dispositioned` flag, not
// whether the thread surfaces.
function fetchAllNodes(owner, repo, number, field, nodeFields) {
  const out = [];
  let after = null;
  for (;;) {
    const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
      repository(owner:$owner,name:$repo){ pullRequest(number:$number){
        ${field}(first:100,after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ${nodeFields} } }
      } }
    }`;
    const result = ghGraphql(query, { owner, repo, number, after });
    const conn = result?.data?.repository?.pullRequest?.[field];
    out.push(...(conn?.nodes ?? []));
    if (!conn?.pageInfo?.hasNextPage) {
      break;
    }
    // Fail fast rather than silently truncate: a missing cursor on a
    // has-next-page response would reintroduce the false negative this
    // pagination exists to prevent.
    if (!conn.pageInfo.endCursor) {
      throw new Error(
        `pagination for ${field} on PR #${number} reported hasNextPage with no endCursor`,
      );
    }
    after = conn.pageInfo.endCursor;
  }
  return out;
}
function fetchMergedPr(owner, repo, number) {
  const metaQuery = `query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){ pullRequest(number:$number){
      number merged mergedAt mergeCommit{ oid }
    } }
  }`;
  const meta = ghGraphql(metaQuery, { owner, repo, number });
  const pr = meta?.data?.repository?.pullRequest;
  if (!pr?.merged) {
    return null;
  }
  return {
    number: pr.number ?? number,
    mergedAt: pr.mergedAt ?? null,
    mergeCommit: pr.mergeCommit?.oid ?? null,
    comments: fetchAllNodes(
      owner,
      repo,
      number,
      'comments',
      'body url createdAt author{ login }',
    ),
    reviews: fetchAllNodes(
      owner,
      repo,
      number,
      'reviews',
      'body url state submittedAt author{ login }',
    ),
    threads: fetchAllNodes(
      owner,
      repo,
      number,
      'reviewThreads',
      'isResolved path comments(first:100){ nodes{ body url createdAt author{ login } } }',
    ),
  };
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  const owner =
    args.owner ||
    runGh(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']).trim();
  const repo =
    args.repo ||
    runGh(['repo', 'view', '--json', 'name', '--jq', '.name']).trim();
  const repoRef = `${owner}/${repo}`;
  const iddConfig = loadIddConfig();
  const { actors: trustedMarkerActors } = resolveTrustedMarkerActors({
    flagValue: args.trustedMarkerLogins,
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: iddConfig,
  });
  const { logins: advisoryBotLogins } = resolveAdvisoryBotLogins({
    flagValue: args.advisoryBotLogins,
    envValue: process.env.IDD_ADVISORY_BOT_LOGINS,
    config: iddConfig,
  });
  // The IDD agent accounts whose comments are treated as dispositions and
  // whose own comments are not feedback. Distinct from trusted-marker actors:
  // a human maintainer can be a trusted-marker actor whose review feedback we
  // still want to surface. Defaults to the trusted-marker actors (the agent
  // posts under that identity in this repo); override with --idd-agent-logins
  // or IDD_AGENT_LOGINS when the agent runs under a separate account.
  const iddAgentLogins =
    resolveLoginList(args.iddAgentLogins) ??
    resolveLoginList(process.env.IDD_AGENT_LOGINS ?? '') ??
    trustedMarkerActors;
  const sinceDate = resolveSinceDate(args);
  const targets =
    args.prNumbers.length > 0
      ? args.prNumbers.map((number) => ({ number }))
      : listMergedPrNumbers(repoRef, sinceDate, args.limit);
  const prs = [];
  for (const target of targets) {
    const pr = fetchMergedPr(owner, repo, target.number);
    if (pr) {
      prs.push(pr);
    }
  }
  const result = buildMergedPrFeedbackSweep(prs, {
    trustedMarkerActors,
    advisoryBotLogins,
    iddAgentLogins,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        sweepWindow: {
          since: sinceDate,
          days: args.days,
          explicitPrs: args.prNumbers.length > 0 ? args.prNumbers : null,
          prCount: result.summary.prCount,
        },
        trustedMarkerActors,
        advisoryBotLogins,
        iddAgentLogins,
        prs: result.prs,
        summary: result.summary,
      },
      null,
      2,
    )}\n`,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
