// idd-generated-from: src/scripts/merged-pr-feedback-sweep.mts
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
      dispositioned: hasFreshDisposition(
        { isResolved: thread.isResolved, comments: thread.comments },
        { isDispositionAuthor: isIdd },
      ),
    });
  }
  return out;
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
    if (!author || isIdd(author)) {
      continue;
    }
    if (isDispositionBody(comment.body)) {
      continue;
    }
    // A trusted IDD operational marker is bookkeeping, not feedback.
    if (operationalMarkerPrefix(comment.body ?? '') && isTrusted(author)) {
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
    switch (token) {
      case '--since':
        parsed.since = next();
        break;
      case '--days':
        parsed.days = Number.parseInt(next(), 10);
        break;
      case '--pr':
        parsed.prNumbers.push(Number.parseInt(next(), 10));
        break;
      case '--prs':
        for (const part of next().split(',')) {
          const value = Number.parseInt(part.trim(), 10);
          if (!Number.isNaN(value)) {
            parsed.prNumbers.push(value);
          }
        }
        break;
      case '--limit':
        parsed.limit = Number.parseInt(next(), 10);
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
const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      number
      merged
      mergedAt
      mergeCommit{ oid }
      comments(first:100){ nodes{ body url createdAt author{ login } } }
      reviews(first:100){ nodes{ body url state submittedAt author{ login } } }
      reviewThreads(first:100){ nodes{
        isResolved
        path
        comments(first:100){ nodes{ body url createdAt author{ login } } }
      } }
    }
  }
}`;
function fetchMergedPr(owner, repo, number) {
  const result = ghGraphql(PR_QUERY, { owner, repo, number });
  const pr = result?.data?.repository?.pullRequest;
  if (!pr?.merged) {
    return null;
  }
  return {
    number: pr.number,
    mergedAt: pr.mergedAt ?? null,
    mergeCommit: pr.mergeCommit?.oid ?? null,
    threads: pr.reviewThreads?.nodes ?? [],
    comments: pr.comments?.nodes ?? [],
    reviews: pr.reviews?.nodes ?? [],
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
    // In this workflow the IDD agent posts dispositions under the trusted
    // marker actor identity, so the disposition authors are those actors.
    iddAgentLogins: trustedMarkerActors,
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
