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
// notices already dispositioned so a re-run is idempotent.
//
// It also auto-dispositions the CodeRabbit summary walkthrough (#1122): a
// completed-review regular comment that recurs on every autopilot PR and the
// gate scores through its general updatedAt-aware 1:1 pairing. Unlike a notice it
// is `**Accepted**` (not `**Rejected**`), and because CodeRabbit edits the summary
// each re-review the helper re-dispositions the CURRENT summary per HEAD by
// timestamp (not a count carry-forward), so a stale acceptance can never mask a
// finding folded into a later summary body.
//
// It is fail-closed: only classifier-recognized notices and the exact summary
// marker are dispositioned; real reviews and review threads are never touched.
import { execFileSync } from 'node:child_process';
import { parseCliArgs } from './cli-args.mjs';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mjs';
import { ghText } from './gh-exec.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  advisoryBotIdentityToken,
  compareIsoTimestamps,
  DEFAULT_ADVISORY_BOT_LOGINS,
  dispositionNamesAdvisoryBot,
  effectiveRegularCommentActivityAt,
  isAdvisoryNonReviewNotice,
  isNonReviewNoticeDisposition,
  isReviewSummaryComment,
  isReviewSummaryDisposition,
  normalizeTrustedMarkerLogins,
  resolveActiveClaimForWriteGate,
  resolveAdvisoryBotLogins,
} from './protocol-helpers.mjs';
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
 * Build the canonical `**Accepted**` disposition body for a CodeRabbit summary
 * walkthrough (#1122): marker-first, naming the bot by its GitHub **login** and
 * the current head SHA. The login form (`coderabbitai[bot]`) is deliberate — it
 * does not contain the standalone word "CodeRabbit", so the gate's
 * `classifyRegularBotComment` createdAt-based RESOLVED path (which requires
 * `/\bCodeRabbit\b/`) never permanently clears the summary; clearing happens only
 * through the general updatedAt-aware pairing, giving the safer per-HEAD
 * re-disposition. The `summary walkthrough` phrase is what `isReviewSummaryDisposition`
 * keys on, so keep the two in lockstep.
 */
export function buildSummaryDispositionBody(botLogin, headSha) {
  return `**Accepted** — ${botLogin} summary walkthrough at HEAD ${headSha}; actionable comments, if any, are dispositioned as their own review threads`;
}
/**
 * Plan the dispositions for a PR's regular comments. Pure: takes the fetched
 * comments and returns which advisory non-review notices need a disposition and
 * which already have one. Per advisory bot, the count of trusted IDD non-review
 * notice dispositions naming that bot covers that many of its notices
 * (oldest-first); the remainder are planned. This mirrors the gate's
 * author-scoped 1:1 carry-forward, so the helper never posts a disposition the
 * gate would not credit and never double-posts on a re-run.
 *
 * It also plans an `**Accepted**` for the CodeRabbit summary walkthrough (#1122),
 * which the gate scores through its general updatedAt-aware 1:1 pairing rather
 * than the notice carry-forward. The summary is re-dispositioned per HEAD by
 * timestamp: it is skipped only when a trusted summary disposition naming the bot
 * is strictly newer than the summary's updatedAt-aware activity (and skipped
 * outright when CodeRabbit already reports "No actionable comments were
 * generated", which the gate classifies RESOLVED). The two paths are disjoint:
 * notices are `**Rejected**`, summaries are `**Accepted**`, and neither
 * disposition predicate matches the other.
 */
export function buildDispositionPlan(input, options = {}) {
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
      // Preserve updatedAt so the summary-walkthrough path can score the summary
      // and its dispositions through `effectiveRegularCommentActivityAt`,
      // matching the gate's updatedAt-aware pairing.
      updatedAt: String(comment.updatedAt ?? ''),
    }))
    .sort((left, right) => {
      // Oldest-first, with a deterministic tie-breaker so the oldest-first
      // pairing is stable: comments with equal (or invalid) timestamps fall back
      // to the monotonic comment id, and an invalid timestamp sorts last.
      const leftTime = Date.parse(left.createdAt);
      const rightTime = Date.parse(right.createdAt);
      const leftValid = !Number.isNaN(leftTime);
      const rightValid = !Number.isNaN(rightTime);
      if (leftValid && rightValid && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      if (leftValid !== rightValid) {
        return leftValid ? -1 : 1;
      }
      return left.id - right.id;
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
  // Every persistent advisory non-review notice needs its own `**Rejected**`
  // disposition, EVEN when the bot also has a completed review of the current
  // HEAD: `summarizeDispositionEvidenceForGate` keeps the notice in its
  // outstanding set until a notice-disposition naming that bot carries it, and
  // that disposition is consumed only by the notice (never clears the separate
  // completed review). So the helper always plans an undispositioned notice;
  // the completed review is accepted as its own item by the E6 flow.
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
  // CodeRabbit summary walkthrough auto-disposition (#1122). Separate from the
  // notice path above: the gate scores the summary through its general
  // updatedAt-aware 1:1 timestamp pairing (not the notice carry-forward), and
  // CodeRabbit edits the summary on each re-review, so re-disposition the CURRENT
  // summary per HEAD by timestamp. Mirror the gate's greedy oldest-first pairing:
  // each summary consumes at most ONE trusted summary disposition that names the
  // bot AND is strictly newer than the summary's updatedAt-aware activity; an
  // uncovered summary is planned. Greedy consumption (not a bare existence check)
  // means two coexisting summaries with a single newer disposition leave the
  // second one planned — matching the gate and erring toward posting (an extra
  // unpaired `**Accepted**` is inert, while under-posting strands the gate).
  const summaryDispositions = comments
    .filter(
      (comment) =>
        trustedMarkerLogins.has(comment.login) &&
        isReviewSummaryDisposition({ body: comment.body }),
    )
    .map((comment) => ({
      body: comment.body,
      activityAt: effectiveRegularCommentActivityAt(comment),
      consumed: false,
    }));
  // The gate pairs greedily across the GLOBAL outstanding set, so a summary's
  // `**Accepted**` marker can be consumed by an OLDER undispositioned non-agent
  // comment (a human reviewer or a non-notice bot), leaving the summary still
  // flagged. The helper only models summary↔summary-disposition pairing, so when
  // such an older comment exists it must NOT treat the summary as covered — it
  // errs toward posting (#1122). Notices are excluded because the gate carves
  // them and their dispositions out of the general pool; agent-authored comments
  // (operational markers, digests, the dispositions themselves) are excluded via
  // `trustedMarkerLogins`; other summaries are handled by the greedy pass above.
  const markerCouldBeStolen = (dispositionActivityAt) =>
    comments.some(
      (other) =>
        !trustedMarkerLogins.has(other.login) &&
        !isAdvisoryNonReviewNotice(other.body) &&
        !isReviewSummaryComment(other.body) &&
        compareIsoTimestamps(
          effectiveRegularCommentActivityAt(other),
          dispositionActivityAt,
        ) < 0,
    );
  for (const comment of comments) {
    const identity = advisoryBotIdentityToken(comment.login);
    if (
      !advisoryBotIdentities.has(identity) ||
      !isReviewSummaryComment(comment.body) ||
      // A notice (rate-limit / usage-limit) that also carries the summary marker
      // is dispositioned `**Rejected**` by the notice path above; never also
      // `**Accepted**` it here, so a comment id gets at most one disposition.
      isAdvisoryNonReviewNotice(comment.body)
    ) {
      continue;
    }
    // The gate already classifies a "No actionable comments were generated"
    // summary as RESOLVED, so it never enters `missingRegularComments` and needs
    // no disposition — auto-posting one would add brand-new noise.
    if (/No actionable comments were generated/i.test(comment.body)) {
      skipped.push({
        noticeId: comment.id,
        botLogin: comment.login,
        reason: 'summary-resolved-no-actionable-comments',
      });
      continue;
    }
    const summaryActivityAt = effectiveRegularCommentActivityAt(comment);
    // Consume the oldest unconsumed disposition naming this bot that is strictly
    // newer than the summary, mirroring the gate's greedy `markerCursor`.
    const cover = summaryDispositions.find(
      (disposition) =>
        !disposition.consumed &&
        dispositionNamesAdvisoryBot(disposition.body, comment.login) &&
        compareIsoTimestamps(disposition.activityAt, summaryActivityAt) > 0,
    );
    // Skip only when the marker is both newer than the summary AND cannot be
    // stolen by an older non-agent comment under the gate's global pairing.
    if (cover && !markerCouldBeStolen(cover.activityAt)) {
      cover.consumed = true;
      skipped.push({
        noticeId: comment.id,
        botLogin: comment.login,
        reason: 'already-dispositioned',
      });
      continue;
    }
    planned.push({
      noticeId: comment.id,
      botLogin: comment.login,
      reason: 'summary walkthrough',
      body: buildSummaryDispositionBody(comment.login, headSha),
    });
  }
  return { headSha, planned, skipped };
}
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
const DISPOSITION_NON_REVIEW_NOTICES_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--claim-issue': { type: 'string' },
  '--claim-id': { type: 'string', default: '' },
  '--agent-id': { type: 'string', default: '' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--advisory-bot-logins': { type: 'string', default: '' },
  '--apply': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
};
function splitList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
/**
 * Restores this file's pre-#1450 permissive `Number.parseInt` contract:
 * absent resolves to `null` (the original `pr: null` / `claimIssue: null`
 * default, never overwritten when the flag is absent); present feeds the
 * raw token straight to `Number.parseInt`, which accepts trailing-garbage
 * ("42abc" -> 42) and leading-zero ("007" -> 7) tokens the same way the
 * original hand-rolled `Number.parseInt(next(), 10)` always did.
 * `cli-args.mts`'s `parseCanonicalIntegerOrNull` is a poor substitute here:
 * its canonical-pattern regex rejects those same tokens outright, which is
 * a real contract change a CodeRabbit review on PR #1466 caught -- #1450's
 * acceptance criteria protect the post-parse integer contract as-is, only
 * flag *syntax* (missing/flag-shaped values, unknown flags) is meant to
 * tighten. The downstream `!Number.isInteger(...) || (... ?? 0) <= 0`
 * guards below already treat `NaN` (an invalid parseInt result) the same
 * as `null`, so this restores the exact original resolved value, not just
 * an equivalent downstream verdict.
 */
function parseLenientIntegerOrNull(token) {
  return token === undefined ? null : Number.parseInt(token, 10);
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    DISPOSITION_NON_REVIEW_NOTICES_FLAG_SPEC,
  );
  return {
    pr: parseLenientIntegerOrNull(values.pr),
    owner: values.owner,
    repo: values.repo,
    claimIssue: parseLenientIntegerOrNull(values['claim-issue']),
    claimId: values['claim-id'],
    agentId: values['agent-id'],
    trustedMarkerLogins: splitList(values['trusted-marker-logins']),
    advisoryBotLogins: splitList(values['advisory-bot-logins']),
    apply: values.apply,
    help,
  };
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
const USAGE = `usage: node scripts/disposition-non-review-notices.mjs --pr <number> [options]

Detect advisory non-review notices and the CodeRabbit summary walkthrough on a PR
and emit (default) or post (--apply) the canonical E6 disposition: a marker-first
\`**Rejected** — {bot} did not review HEAD …\` per notice, and a marker-first
\`**Accepted** — {bot} summary walkthrough …\` per current summary (re-dispositioned
per HEAD). Idempotent and fail-closed.

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
/**
 * Re-fetch the claim issue and decide whether the supplied claim id is still the
 * active claim. Scoped to trusted marker authors via the shared
 * `resolveActiveClaimForWriteGate` state machine (so a copied/forged
 * `claimed-by` marker from an untrusted author cannot satisfy the gate). A
 * forced-handoff marker is honored only when it is an operator-approved,
 * authorized handoff (forced-handoff mode enabled, `forced-by` is an
 * authorized maintainer, and the comment author matches `forced-by`);
 * otherwise the original claim stays active and an unauthorized/forged
 * successor `--claim-id` still fails the `=== claimId` comparison. This is an
 * issue-scoped revalidation (`expectedLinkedPrs: null`), so a legitimate
 * issue-only handoff is accepted. Aborting on a contested claim is always
 * safe (the manual E6 path remains).
 */
function claimStillActive(
  owner,
  repo,
  issue,
  claimId,
  isTrustedAuthor,
  forcedHandoffOptions,
) {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${issue}/comments`,
  ]);
  const events = comments.map((comment) => ({
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  }));
  const active = resolveActiveClaimForWriteGate(events, {
    isTrustedAuthor,
    forcedHandoffEnabled: forcedHandoffOptions.forcedHandoffEnabled,
    // Issue-scoped revalidation: accept a legitimate issue-only handoff.
    expectedLinkedPrs: null,
    isAuthorizedForcedHandoff: (forcedBy) =>
      forcedHandoffOptions.isAuthorizedForcedHandoff(forcedBy),
    requireAuthorMatchesForcedBy: true,
  });
  return active?.claimId === claimId;
}
function postDisposition(owner, repo, pr, body) {
  // A disposition body is plain text starting with `**Rejected**` (notice) or
  // `**Accepted**` (summary walkthrough) — not an HTML-comment-first marker — so
  // the `-f body=` field path posts it reliably; gh sends `{"body": <value>}` to
  // the comments API.
  return ghJson([
    'api',
    '--method',
    'POST',
    `repos/${owner}/${repo}/issues/${pr}/comments`,
    '-f',
    `body=${body}`,
  ]);
}
/** Ids of all comments on the PR authored by `viewerLogin`. */
function viewerCommentIds(owner, repo, pr, viewerLogin) {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${pr}/comments`,
  ]);
  const ids = new Set();
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
  owner,
  repo,
  pr,
  body,
  viewerLogin,
  knownIds,
) {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${pr}/comments`,
  ]);
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
if (import.meta.main) {
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
  // Build a plan from a fresh read of the PR's HEAD and comments. Called once
  // for dry-run and again immediately before --apply posts, so a HEAD advance or
  // a disposition another session raced in is reflected just-in-time (the apply
  // path never reuses the dry-run snapshot).
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
      // The issues-comments API returns updated_at (bumped when CodeRabbit edits
      // its summary); the summary path scores it through the gate's
      // updatedAt-aware activity.
      updatedAt: comment.updated_at ?? '',
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
  // Resolve the forced-handoff policy and build the collaborator-permission
  // cache ONCE per CLI invocation (not per revalidation loop): re-reading
  // .github/idd/config.json and re-hitting the collaborators API on every
  // post would be a needless I/O hot path. Mirrors force-handoff.mjs and the
  // audit-pr-cleanup readActiveClaim comment.
  const forcedHandoffEnabled = readForcedHandoffMode() === 'human-gated';
  const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  const forcedHandoffPermissionCache = new Map();
  const forcedHandoffOptions = {
    forcedHandoffEnabled,
    isAuthorizedForcedHandoff: (forcedBy) =>
      isAuthorizedForcedHandoffActor(
        owner,
        repo,
        forcedBy,
        forcedHandoffAuthorityPolicy,
        forcedHandoffPermissionCache,
      ),
  };
  const revalidateClaim = () =>
    claimStillActive(
      owner,
      repo,
      claimIssue,
      args.claimId,
      isTrustedAuthor,
      forcedHandoffOptions,
    );
  if (!revalidateClaim()) {
    process.stderr.write(
      `claim revalidation failed: "${args.claimId}" is no longer the active claim on issue #${claimIssue}\n`,
    );
    process.exit(1);
  }
  // Re-plan from a fresh read AFTER claim revalidation, so the post loop never
  // re-posts a disposition that raced in since the dry-run.
  const plan = planNow();
  const applied = [];
  const failed = [];
  // Track every viewer-authored comment id we know about (pre-existing plus the
  // ones we post), so a post-failure recovery attributes a NEW comment to the
  // current notice instead of an earlier notice with an identical body.
  const knownViewerCommentIds = viewerCommentIds(owner, repo, pr, viewerLogin);
  let claimLost = false;
  for (let index = 0; index < plan.planned.length; index += 1) {
    const item = plan.planned[index];
    if (!revalidateClaim()) {
      // Claim lost mid-loop: stop writing and surface the current AND all
      // remaining notices as failed rather than posting them under a claim we no
      // longer hold, so the apply report names every notice left un-dispositioned.
      claimLost = true;
      for (const remaining of plan.planned.slice(index)) {
        failed.push({
          noticeId: remaining.noticeId,
          error: 'claim revalidation failed before post',
        });
      }
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
