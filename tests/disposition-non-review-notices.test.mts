import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type ApplyDispositionPlanDeps,
  applyDispositionPlan,
  buildCodexNoFindDispositionBody,
  buildDispositionBody,
  buildDispositionPlan,
  buildSummaryDispositionBody,
  type DispositionPlan,
  isCodexReviewSummaryCompleteForHeadSha,
  type NoticeComment,
  noticeReason,
  parseArgs,
  resolveClaimStillActive,
} from '../src/scripts/disposition-non-review-notices.mts';
import { classifyHelperError } from '../src/scripts/helper-cli-runner.mts';
import { hasReviewReplyStamp } from '../src/scripts/marker-helpers.mts';
import {
  CODERABBIT_REVIEW_IN_PROGRESS_MARKER,
  CODERABBIT_REVIEW_PAUSED_MARKER,
  dispositionNamesAdvisoryBot,
  isAdvisoryNonReviewNotice,
  isCodeRabbitAlreadyReviewedAcknowledgement,
  isCodexNoFindResultDisposition,
  isCodexNoFindResultForHeadSha,
  isDispositionComment,
  isReviewSummaryComment,
  isTerminalAdvisoryNonReviewNotice,
  renderLiveStatusDigest,
  retireLiveStatusDigestBody,
  summarizeDispositionEvidenceForGate,
  summarizeRegularCommentsForGate,
} from '../src/scripts/protocol-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const planSchema = loadJson(
  'schemas/disposition-non-review-notices.schema.json',
);

// #3270: WG_OLD_CLAIM is created at 2026-05-12T09:00:00Z; the takeover
// below lands 20h later (2026-05-13T05:00:00Z) -- squarely in the 18-24h
// gap the issue describes: stale under an 18h configured age, not stale
// under the old hardcoded 24h `resolveActiveClaimForWriteGate` silently
// fell back to when `claimStillActive` (the caller `resolveClaimStillActive`
// was extracted from) omitted `staleAgeMs`.
function claimStillActiveEvents(): {
  body: string;
  createdAt: string;
  author: { login: string };
  lastEditedAt: string | null;
}[] {
  return [
    {
      body: [
        '<!-- claimed-by: cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat -->',
        '',
        '_cli-old: issue claim — IDD automation marker._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'cli-old' },
      lastEditedAt: null,
    },
    {
      body: [
        '<!-- claimed-by: cli-new claim-20260513T050000Z-337-new supersedes: claim-20260512T090000Z-337-old 2026-05-13T05:00:00Z branch: issue/337-feat -->',
        '',
        '_cli-new: issue claim — IDD automation marker._',
      ].join('\n'),
      createdAt: '2026-05-13T05:00:00Z',
      author: { login: 'cli-new' },
      lastEditedAt: null,
    },
  ];
}

const claimStillActiveTrusted = (login: string): boolean =>
  ['cli-old', 'cli-new'].includes(login);
const claimStillActiveForcedHandoffOptions = {
  forcedHandoffEnabled: false,
  isAuthorizedForcedHandoff: () => false,
};

test('resolveClaimStillActive (#3270) recognizes a takeover claim inside a configured 18h staleAge', () => {
  assert.equal(
    resolveClaimStillActive(
      claimStillActiveEvents(),
      'claim-20260513T050000Z-337-new',
      claimStillActiveTrusted,
      claimStillActiveForcedHandoffOptions,
      18 * 60 * 60 * 1000,
    ),
    true,
  );
});

test('resolveClaimStillActive (#3270) does not recognize the same takeover when staleAgeMs is explicitly the 24h default', () => {
  assert.equal(
    resolveClaimStillActive(
      claimStillActiveEvents(),
      'claim-20260513T050000Z-337-new',
      claimStillActiveTrusted,
      claimStillActiveForcedHandoffOptions,
      24 * 60 * 60 * 1000,
    ),
    false,
  );
});

const CODEX = 'chatgpt-codex-connector[bot]';
const CODERABBIT = 'coderabbitai[bot]';
const CODEX_NOTICE =
  'You have reached your Codex usage limits for code reviews.';
// #1312: current Codex wording interposes "have been" between "usage
// limits" and "reached" — the two prior exact-phrase regexes missed this.
const CODEX_NOTICE_CURRENT_WORDING =
  'Codex usage limits have been reached for code reviews. Please check ' +
  'with the admins of this repo to increase the limits by adding credits.';
const CODERABBIT_NOTICE =
  '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> ## Review limit reached';
// #3146: the incremental-review refusal is a regular comment, but it contains
// no walkthrough or review result. Keep the fetched marker and details shape
// intact so the classifier test exercises the observed vendor payload.
const CODERABBIT_ALREADY_REVIEWED_ACK =
  '<!-- This is an auto-generated reply by CodeRabbit -->\n' +
  '<!-- CodeRabbit review command invocation: v2:abc123 -->\n' +
  '<details>\n' +
  '<summary>⚠️ Action not completed</summary>\n\n' +
  'Already reviewed the last commit. Use `@coderabbitai full review` to rerun a\n' +
  'review of the entire changeset.\n\n' +
  '> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits.\n' +
  'This command is applicable only when automatic reviews are paused.\n\n' +
  '</details>';
// #3193 (gist round 35): a distinct CodeRabbit reply shape -- the bot
// acknowledges a review-command invocation, then reports "Review rate
// limited." inside the same "Action not completed" wrapper #3146 uses,
// instead of "Already reviewed the last commit." This is a conclusive
// decline, not a retryable acknowledgement.
// The promise sentence deliberately does not contain the word "review" --
// regression coverage for a C1 delegate finding on this same change: the
// matcher must not require that specific token (#3193).
const CODERABBIT_RATE_LIMITED_ACK =
  '<!-- This is an auto-generated reply by CodeRabbit -->\n' +
  '<!-- CodeRabbit review command invocation: v2:def456 -->\n' +
  'Sure, taking a look at this now.\n\n' +
  '<details>\n' +
  '<summary>⚠️ Action not completed</summary>\n\n' +
  'Review rate limited.\n\n' +
  '> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits.\n' +
  'This command is applicable only when automatic reviews are paused.\n\n' +
  '</details>';
const CODERABBIT_SUMMARY =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n## Walkthrough\nSome walkthrough text.';
// #2161: CodeRabbit wraps a content-free skip-review notice (billing failure,
// or a repo below the star-count manual-trigger gate) in the SAME outer
// summarize-by-coderabbit.ai marker as a genuine walkthrough, distinguished
// only by this nested inner marker.
const CODERABBIT_SKIP_REVIEW =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
  '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n' +
  '> [!WARNING]\n> ## Review skipped\nReview was skipped due to path filters.';
// #3260: fixtures trimmed (exact marker HTML comments + minimal surrounding
// structure) from the live comments the issue cites, verified against their
// GraphQL `userContentEdits` revision history on 2026-09-24. PR #3196
// comment `5789875341`'s HEAD `a5a56e57` committed at 2026-09-23T07:12:24Z;
// the 07:13:25Z revision is CodeRabbit's in-progress state (no "No
// actionable comments" text), the 07:20:35Z revision is the completed
// review (with that sentence), and the 06:10:19Z revision is a genuine
// completed walkthrough without that sentence. PR #3154 comment
// `5743189569` is one of 23 (of 48 total) paused revisions, still trailing
// the "No actionable comments were generated" sentence retained from the
// prior completed review. PR #3160 comment `5747892562`'s
// 2026-09-20T11:13:47Z revision carries the in-progress marker AND that
// same stale sentence retained beneath it.
const CODERABBIT_IN_PROGRESS =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
  `${CODERABBIT_REVIEW_IN_PROGRESS_MARKER}\n\n` +
  '> [!NOTE]\n' +
  '> Currently processing new changes in this PR. This may take a few minutes, please wait...\n\n' +
  '<!-- end of auto-generated comment: review in progress by coderabbit.ai -->';
const CODERABBIT_COMPLETED_NO_ACTIONABLE =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
  '<!-- recent_review_start -->\n\n' +
  'No actionable comments were generated in the recent review. 🎉';
// PR #3160 comment `5747892562`, 2026-09-20T11:13:47Z: the in-progress
// marker AND a stale "No actionable comments" sentence retained beneath it
// from the review it superseded -- the exact shape that makes the ordering
// of buildDispositionPlan's two skip checks load-bearing.
const CODERABBIT_IN_PROGRESS_WITH_STALE_SENTENCE =
  `${CODERABBIT_IN_PROGRESS}\n\n` +
  '<!-- recent_review_start -->\n\n' +
  'No actionable comments were generated in the recent review. 🎉';
const CODERABBIT_COMPLETED_WALKTHROUGH =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
  '<!-- walkthrough_start -->\n\n' +
  '<details>\n<summary>📝 Walkthrough</summary>\n\n## Walkthrough\n\n' +
  'The policy now accepts one or more secondary advisory bot logins.\n' +
  '</details>';
const CODERABBIT_PAUSED =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
  `${CODERABBIT_REVIEW_PAUSED_MARKER}\n\n` +
  '> [!NOTE]\n> ## Reviews paused\n> \n' +
  '> It looks like this branch is under active development. To avoid ' +
  'overwhelming you with review comments due to an influx of new ' +
  'commits, CodeRabbit has automatically paused this review.\n\n' +
  '<!-- end of auto-generated comment: review paused by coderabbit.ai -->\n' +
  '<!-- recent_review_start -->\n\n' +
  'No actionable comments were generated in the recent review. 🎉';
// #2695: chatgpt-codex-connector[bot]'s own recurring review-status comment,
// edited in place on every push -- a status table against the current commit
// that cycles through "Running" and "Completed" states, analogous to
// CODERABBIT_SUMMARY above but for Codex. Modeled on the real comment body
// (kurone-kito/idd-skill#2722) rather than a guessed shape.
const CODEX_SUMMARY_RUNNING =
  '<!-- codex-pull-request-review-summary -->\n\n' +
  '## Codex Review Summary\n\n' +
  'This comment shows the latest Codex review activity on this pull request.\n\n' +
  '| Review | Status | Commit | Review trigger |\n' +
  '| --- | --- | --- | --- |\n' +
  '| 📝 **Code Review** | 🔄 **Running** | `abc1234` | PR opened |\n';
const CODEX_SUMMARY_COMPLETED =
  '<!-- codex-pull-request-review-summary -->\n\n' +
  '## Codex Review Summary\n\n' +
  'This comment shows the latest Codex review activity on this pull request.\n\n' +
  '| Review | Status | Commit | Review trigger |\n' +
  '| --- | --- | --- | --- |\n' +
  '| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-05-12T00:00:00Z">' +
  '2026-05-12T00:00:00Z</relative-time> | `abc1234` | PR opened |\n';
const CODEX_NO_FIND_RESULT =
  "Codex Review: Didn't find any major issues. You're on a roll.\n\n" +
  '**Reviewed commit:** `abc1234`\n\n' +
  '<details> <summary>ℹ️ About Codex in GitHub</summary>\n' +
  '<br/>\n\n' +
  '[Your team has set up Codex to review pull requests in this repo]' +
  '(https://chatgpt.com/codex/cloud/settings/general)\n\n' +
  'Reviews are triggered when you\n' +
  '- Open a pull request for review\n' +
  '- Mark a draft as ready\n' +
  '- Comment "@codex review" or "@codex security review".\n\n' +
  '</details>';
// A full 40-char head SHA for the cases that validate against the schema, which
// now constrains `headSha` to `^[0-9a-f]{40}$`.
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

function notice(
  id: number,
  login: string,
  body: string,
  createdAt = `2026-05-12T00:00:0${id}Z`,
  updatedAt?: string,
): NoticeComment {
  return updatedAt === undefined
    ? { id, login, body, createdAt }
    : { id, login, body, createdAt, updatedAt };
}

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: a present-but-invalid --pr resolves to NaN, matching the pre-#1450 contract', () => {
  // This file's original hand-rolled parser assigned the raw (possibly
  // NaN) Number.parseInt result directly -- it never coerced an invalid
  // value to null inside parseArgs itself, unlike advisory-wait-state.mts
  // / ci-wait-state.mts / review-activity-snapshot.mts. The caller's own
  // `!Number.isInteger(args.pr) || (args.pr ?? 0) <= 0` guard (outside
  // parseArgs) treats NaN as invalid the same way it treats null.
  const args = parseArgs(['--pr', 'not-a-number']);
  assert.ok(Number.isNaN(args.pr));
});

test('parseArgs: an absent --pr resolves to null', () => {
  const args = parseArgs(['--claim-issue', '7']);
  assert.equal(args.pr, null);
});

test('parseArgs: --pr keeps its pre-#1450 permissive Number.parseInt contract', () => {
  // Regression coverage for a CodeRabbit review finding on #1450: the
  // wrapper migration must not swap in cli-args.mts's stricter
  // canonical-pattern integer parser here, which would reject trailing-
  // garbage and leading-zero tokens the original Number.parseInt-based
  // parser always accepted.
  assert.equal(parseArgs(['--pr', '42abc']).pr, 42);
  assert.equal(parseArgs(['--pr', '007']).pr, 7);
});

test('parseArgs: a missing --claim-issue value throws', () => {
  assert.throws(() => parseArgs(['--pr', '42', '--claim-issue']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --agent-id would greedily accept '--apply' as its literal
  // value, silently leaving --apply unset (this file's own flavor of the
  // #1082 gap the shared wrapper closes structurally).
  assert.throws(() => parseArgs(['--pr', '42', '--agent-id', '--apply']));
});

test('parseArgs: rejects an unknown flag instead of silently ignoring it', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: --help is recognized without requiring --pr', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

test('buildDispositionBody is marker-first and names the bot login + head sha', () => {
  const body = buildDispositionBody(
    CODERABBIT,
    'abc1234',
    'review limit reached',
    501,
  );
  assert.ok(body.startsWith('**Rejected**'), 'marker must be first bytes');
  assert.match(body, /coderabbitai\[bot\] did not review HEAD abc1234/);
  // #1482: the canonical E6 text is followed by a trailing human-readable
  // disambiguator naming the source notice's own comment id.
  assert.match(
    body,
    /\(review limit reached\); this is not a completed review \(source: #issuecomment-501\)/,
  );
  assert.ok(hasReviewReplyStamp(body));
});

test('buildDispositionPlan produces distinguishable bodies for two same-bot, same-HEAD, same-reason notices', () => {
  // #1482 regression: before this fix, two notices from the same bot at the
  // same HEAD with the same noticeReason() category rendered byte-identical
  // **Rejected** replies -- the false "duplicate bug" alarm this issue
  // describes. The actual fix is the call-site wiring (comment.id threaded
  // into buildDispositionBody's new 4th arg), so exercise it through
  // buildDispositionPlan rather than calling buildDispositionBody directly.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(101, CODERABBIT, CODERABBIT_NOTICE, '2026-05-12T00:00:01Z'),
        notice(102, CODERABBIT, CODERABBIT_NOTICE, '2026-05-12T00:00:02Z'),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 2);
  const [first, second] = plan.planned;
  assert.notEqual(first?.body, second?.body);
  assert.match(first?.body ?? '', /\(source: #issuecomment-101\)/);
  assert.match(second?.body ?? '', /\(source: #issuecomment-102\)/);
  assert.ok(hasReviewReplyStamp(first?.body ?? ''));
  assert.ok(hasReviewReplyStamp(second?.body ?? ''));
});

test('isDispositionComment and dispositionNamesAdvisoryBot recognize the extended body', () => {
  // #1482: confirm the F2/F3 gate's underlying recognition predicates -- both
  // prefix/substring-based, never exact-body equality -- still accept a body
  // carrying the new trailing source-notice disambiguator.
  const body = buildDispositionBody(
    CODERABBIT,
    'abc1234',
    'review limit reached',
    999,
  );
  assert.ok(isDispositionComment({ body }));
  assert.ok(dispositionNamesAdvisoryBot(body, CODERABBIT));
});

test('dispositionNamesAdvisoryBot does not falsely match a bot identity equal to a fixed template word', () => {
  // A bot whose identity token equals a word from the notice template's own
  // fixed text ("review", "head") must not falsely match a disposition that
  // actually names a different bot -- the whole-body substring search this
  // replaced would incorrectly return true for both.
  const body = buildDispositionBody(
    CODERABBIT,
    'abc1234',
    'review limit reached',
    999,
  );
  assert.equal(dispositionNamesAdvisoryBot(body, 'review[bot]'), false);
  assert.equal(dispositionNamesAdvisoryBot(body, 'head[bot]'), false);
  // The real bot the body actually names still matches.
  assert.equal(dispositionNamesAdvisoryBot(body, CODERABBIT), true);
});

test('dispositionNamesAdvisoryBot requires an exact login match, not a substring of a lookalike/fork bot login -- #3466 (Copilot review, PR #3470)', () => {
  // A disposition naming a real, configured bot must not also be read as
  // naming a differently-configured lookalike whose login merely CONTAINS
  // the real bot's identity token as a substring (a whole-span
  // `.includes()` check would incorrectly return true for both).
  const codexBody = buildDispositionBody(
    'chatgpt-codex-connector[bot]',
    'abc1234',
    'usage limits',
    999,
  );
  assert.equal(
    dispositionNamesAdvisoryBot(codexBody, 'chatgpt-codex-connector-fork[bot]'),
    false,
  );
  assert.equal(
    dispositionNamesAdvisoryBot(codexBody, 'chatgpt-codex-connector[bot]'),
    true,
  );

  const forkBody = buildDispositionBody(
    'chatgpt-codex-connector-fork[bot]',
    'abc1234',
    'usage limits',
    999,
  );
  // The reverse direction: a disposition naming the FORK must not be read
  // as naming the real bot merely because the fork's login contains it.
  assert.equal(
    dispositionNamesAdvisoryBot(forkBody, 'chatgpt-codex-connector[bot]'),
    false,
  );
  assert.equal(
    dispositionNamesAdvisoryBot(forkBody, 'chatgpt-codex-connector-fork[bot]'),
    true,
  );
});

test('dispositionNamesAdvisoryBot handles the Oxford-comma three-plus-bot form -- #3466 (Copilot review, PR #3470, "previously missed")', () => {
  // The comma-then-"and" separator must collapse to a plain comma before
  // splitting, or the third bot's segment reads as "and C[bot]" and its
  // leading-token extraction sees "and" instead of the real login.
  const body =
    '**Rejected** — chatgpt-codex-connector[bot], coderabbitai[bot], and ' +
    'some-other-bot[bot] did not review HEAD abc1234 (rate limited); ' +
    'this is not a completed review';
  assert.equal(
    dispositionNamesAdvisoryBot(body, 'chatgpt-codex-connector[bot]'),
    true,
  );
  assert.equal(dispositionNamesAdvisoryBot(body, 'coderabbitai[bot]'), true);
  assert.equal(dispositionNamesAdvisoryBot(body, 'some-other-bot[bot]'), true);
  // A lookalike of the LAST bot in the Oxford-comma list must still fail --
  // confirms the fix doesn't just make the last segment match anything.
  assert.equal(
    dispositionNamesAdvisoryBot(body, 'some-other-bot-fork[bot]'),
    false,
  );
});

test('dispositionNamesAdvisoryBot still matches a login followed by a human-readable parenthetical product name', () => {
  // A hand-authored disposition may append a readable product-name aside
  // after the login for clarity ("coderabbitai[bot] (CodeRabbit)"). The
  // exact-login-match fix above must extract just the leading login token
  // rather than treating the whole segment (login plus aside) as one
  // opaque string to compare.
  const body =
    '**Rejected** — coderabbitai[bot] (CodeRabbit) did not review HEAD ' +
    'abc1234 (review limit reached); this is not a completed review';
  assert.equal(dispositionNamesAdvisoryBot(body, CODERABBIT), true);
  assert.equal(
    dispositionNamesAdvisoryBot(body, 'chatgpt-codex-connector[bot]'),
    false,
  );
});

test('dispositionNamesAdvisoryBot does not falsely match the #1482 source-notice-id suffix', () => {
  // #1482 appends "(source: #issuecomment-{id})" to every notice disposition.
  // A bot configured with an identity token equal to "issuecomment" must not
  // falsely match on that suffix, which lives outside the anchored
  // bot-login span.
  const body = buildDispositionBody(
    CODERABBIT,
    'abc1234',
    'review limit reached',
    999,
  );
  assert.match(body, /\(source: #issuecomment-999\)/);
  assert.ok(hasReviewReplyStamp(body));
  assert.equal(dispositionNamesAdvisoryBot(body, 'issuecomment[bot]'), false);
});

test('dispositionNamesAdvisoryBot does not falsely match a fixed template word in the summary-walkthrough shape', () => {
  const body = buildSummaryDispositionBody(CODERABBIT, 'abc1234');
  assert.equal(dispositionNamesAdvisoryBot(body, 'walkthrough[bot]'), false);
  assert.equal(dispositionNamesAdvisoryBot(body, 'head[bot]'), false);
  assert.equal(dispositionNamesAdvisoryBot(body, CODERABBIT), true);
});

test('dispositionNamesAdvisoryBot matches the canonical template case-insensitively', () => {
  // isNonReviewNoticeDisposition/isReviewSummaryDisposition match the "did
  // not review HEAD"/"summary walkthrough" phrase case-insensitively; the
  // anchored span regexes must do the same, or a mixed-case body that
  // passes the shape gate would silently fail to name its bot here.
  const body = buildDispositionBody(
    CODERABBIT,
    'abc1234',
    'review limit reached',
    999,
  ).replace('did not review HEAD', 'Did Not Review HEAD');
  assert.equal(dispositionNamesAdvisoryBot(body, CODERABBIT), true);
});

test('dispositionNamesAdvisoryBot returns false for a body matching neither canonical template', () => {
  // An ordinary rejection of reviewer feedback that happens to mention a
  // bot's login in prose is not a structured notice/summary disposition, so
  // it must not be attributed to that bot -- callers gate on
  // isNonReviewNoticeDisposition/isReviewSummaryDisposition first, but this
  // function must independently fail closed too.
  assert.equal(
    dispositionNamesAdvisoryBot(
      `**Rejected** — as ${CODERABBIT} noted, this needs a fix`,
      CODERABBIT,
    ),
    false,
  );
  assert.equal(dispositionNamesAdvisoryBot('', CODERABBIT), false);
  assert.equal(dispositionNamesAdvisoryBot(null, CODERABBIT), false);
});

test('Codex no-find classifier accepts only the observed terminal shape for the current HEAD', () => {
  assert.equal(
    isCodexNoFindResultForHeadSha(
      CODEX_NO_FIND_RESULT,
      `abc1234${'0'.repeat(33)}`,
    ),
    true,
  );
  assert.equal(
    isCodexNoFindResultForHeadSha(CODEX_NO_FIND_RESULT, 'def5678'),
    false,
  );
  assert.equal(
    isCodexNoFindResultForHeadSha(
      CODEX_NO_FIND_RESULT.replace(
        "Didn't find any major issues",
        'Found a major issue',
      ),
      'abc1234',
    ),
    false,
  );
  assert.equal(
    isCodexNoFindResultForHeadSha(
      `${CODEX_NO_FIND_RESULT}\n\nI found a major issue.`,
      'abc1234',
    ),
    false,
  );
  assert.equal(
    isCodexNoFindResultForHeadSha(
      CODEX_NO_FIND_RESULT.replace(
        'Reviews are triggered when you',
        'I found a major issue.\nReviews are triggered when you',
      ),
      'abc1234',
    ),
    false,
  );
  assert.equal(
    isCodexNoFindResultForHeadSha(
      CODEX_NO_FIND_RESULT.replace(
        '</details>',
        'I found a major issue.\n\n</details>',
      ),
      'abc1234',
    ),
    false,
  );
  assert.equal(
    isCodexNoFindResultForHeadSha(CODEX_SUMMARY_RUNNING, 'abc1234'),
    false,
  );
  assert.equal(
    isCodexNoFindResultForHeadSha(
      CODEX_NO_FIND_RESULT.replace(
        'https://chatgpt.com/codex/cloud/settings/general',
        'https://example.com',
      ),
      'abc1234',
    ),
    false,
  );
});

test('Codex no-find disposition names only the source Codex bot', () => {
  const body = buildCodexNoFindDispositionBody(CODEX, 'abc1234', 321);
  assert.equal(isCodexNoFindResultDisposition(body), true);
  assert.equal(dispositionNamesAdvisoryBot(body, CODEX), true);
  assert.equal(dispositionNamesAdvisoryBot(body, CODERABBIT), false);
});

test('gate agreement: the extended **Rejected** body still clears a notice from missingRegularComments', () => {
  // #1482: the embedded source-notice id must not break the F2/F3 gate's real
  // recognition path (isNonReviewNoticeDisposition + dispositionNamesAdvisoryBot,
  // both exercised inside summarizeDispositionEvidenceForGate's #1018
  // carry-forward), mirroring the existing summary-path gate-agreement tests
  // below.
  const noticeComment = {
    id: 201,
    author: { login: CODERABBIT },
    body: CODERABBIT_NOTICE,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const gateOptions = {
    iddAgentLogins: ['kurone-kito'],
    advisoryBotLogins: [CODERABBIT, CODEX],
  };
  // Before: the gate flags the undispositioned notice.
  const before = summarizeDispositionEvidenceForGate(
    { comments: [noticeComment], threads: [] },
    gateOptions,
  );
  assert.equal(before.missingRegularCommentCount, 1);

  // The helper plans the extended **Rejected** body (with the embedded source
  // comment id); post it as an IDD-agent disposition, matching the existing
  // tests' `kurone-kito` iddAgentLogins setup so this exercises the #1018
  // carry-forward path specifically (not the separate sticky-matching path).
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(
          201,
          CODERABBIT,
          CODERABBIT_NOTICE,
          '2026-05-12T00:00:00Z',
          '2026-05-12T00:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  assert.match(plan.planned[0]?.body ?? '', /\(source: #issuecomment-201\)/);
  assert.ok(hasReviewReplyStamp(plan.planned[0]?.body ?? ''));
  const disposition = {
    id: 202,
    author: { login: 'kurone-kito' },
    body: plan.planned[0]?.body ?? '',
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  // After: the gate no longer flags the notice, proving the extended body is
  // still recognized as a valid, bot-attributed disposition.
  const after = summarizeDispositionEvidenceForGate(
    { comments: [noticeComment, disposition], threads: [] },
    gateOptions,
  );
  assert.equal(after.missingRegularCommentCount, 0);
});

test('noticeReason derives the category-specific reason', () => {
  assert.equal(
    noticeReason(CODERABBIT_NOTICE),
    'review limit reached / rate limited',
  );
  assert.equal(
    noticeReason(CODEX_NOTICE),
    'Codex usage limits for code reviews reached',
  );
  assert.equal(noticeReason('something else'), 'advisory non-review notice');
  assert.equal(
    noticeReason(CODERABBIT_SKIP_REVIEW),
    'review skipped (billing failure or below the manual-trigger star-count gate)',
  );
  assert.equal(
    noticeReason(CODERABBIT_ALREADY_REVIEWED_ACK),
    'already reviewed last commit; full review required',
  );
});

test('#3146: recognizes and disposition-plans the already-reviewed refusal', () => {
  assert.equal(
    isAdvisoryNonReviewNotice(CODERABBIT_ALREADY_REVIEWED_ACK),
    true,
  );

  const firstPlan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(3146, CODERABBIT, CODERABBIT_ALREADY_REVIEWED_ACK)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(firstPlan.planned.length, 1);
  assert.equal(firstPlan.planned[0]?.botLogin, CODERABBIT);
  assert.equal(
    firstPlan.planned[0]?.reason,
    'already reviewed last commit; full review required',
  );
  assert.match(
    firstPlan.planned[0]?.body ?? '',
    /did not review HEAD abc1234 \(already reviewed last commit; full review required\)/,
  );

  const disposition = notice(
    3147,
    'kurone-kito',
    firstPlan.planned[0]?.body ?? '',
    '2026-05-12T00:01:00Z',
  );
  const secondPlan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(
          3146,
          CODERABBIT,
          CODERABBIT_ALREADY_REVIEWED_ACK,
          '2026-05-12T00:00:00Z',
        ),
        disposition,
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(secondPlan.planned.length, 0);
  assert.deepEqual(
    secondPlan.skipped.map((entry) => entry.noticeId),
    [3146],
  );
});

test('#3146: consumes repeated already-reviewed refusals one-to-one', () => {
  const refusal = (id: number, createdAt: string) => ({
    id,
    createdAt,
    body: CODERABBIT_ALREADY_REVIEWED_ACK,
    author: { login: CODERABBIT },
  });
  const disposition = {
    id: 3148,
    createdAt: '2026-05-12T00:02:00Z',
    body: buildDispositionBody(
      CODERABBIT,
      'abc1234',
      'already reviewed last commit; full review required',
      3146,
    ),
    author: { login: 'idd-bot' },
  };
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        refusal(3146, '2026-05-12T00:00:00Z'),
        refusal(3147, '2026-05-12T00:01:00Z'),
        disposition,
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: [CODERABBIT],
      prAuthorLogin: 'pr-author',
    },
  );

  assert.equal(summary.missingRegularCommentCount, 1);
  assert.deepEqual(
    summary.missingRegularComments.map((item) => item.id),
    ['3147'],
  );
});

test('#3146: does not classify similar review prose as the refusal notice', () => {
  const reviewBody =
    '<!-- This is an auto-generated reply by CodeRabbit -->\n' +
    '<!-- CodeRabbit review command invocation: v2:abc123 -->\n' +
    '<details>\n' +
    '<summary>⚠️ Action not completed</summary>\n\n' +
    'Already reviewed the last commit, and the walkthrough found one issue. ' +
    'Use `@coderabbitai full review` to rerun a review of the entire changeset.\n\n' +
    '### Walkthrough\n\nThe review identified a real concern.\n\n' +
    '</details>';
  assert.equal(isAdvisoryNonReviewNotice(reviewBody), false);
  assert.equal(isReviewSummaryComment(reviewBody), false);
});

test('#3193: recognizes the review-command rate-limited acknowledgement as a terminal notice', () => {
  assert.equal(isAdvisoryNonReviewNotice(CODERABBIT_RATE_LIMITED_ACK), true);
  assert.equal(
    isTerminalAdvisoryNonReviewNotice(CODERABBIT_RATE_LIMITED_ACK),
    true,
  );
  // Conclusive decline, not the #3146 retryable acknowledgement path.
  assert.equal(
    isCodeRabbitAlreadyReviewedAcknowledgement(CODERABBIT_RATE_LIMITED_ACK),
    false,
  );
});

test('#3193: does not classify review prose that merely mentions rate limiting as the notice', () => {
  const reviewBody =
    '<!-- This is an auto-generated reply by CodeRabbit -->\n' +
    '<!-- CodeRabbit review command invocation: v2:def456 -->\n' +
    "I'll review the latest commit now.\n\n" +
    '<details>\n' +
    '<summary>⚠️ Action not completed</summary>\n\n' +
    'This repository was previously rate limited, but the review completed ' +
    'and found one issue.\n\n' +
    '### Walkthrough\n\nThe review identified a real concern.\n\n' +
    '</details>';
  assert.equal(isAdvisoryNonReviewNotice(reviewBody), false);
  assert.equal(isTerminalAdvisoryNonReviewNotice(reviewBody), false);
});

test('#3193: the #3146 already-reviewed acknowledgement is unaffected (regression guard)', () => {
  assert.equal(
    isCodeRabbitAlreadyReviewedAcknowledgement(CODERABBIT_ALREADY_REVIEWED_ACK),
    true,
  );
  assert.equal(
    isTerminalAdvisoryNonReviewNotice(CODERABBIT_ALREADY_REVIEWED_ACK),
    false,
  );
});

test('buildDispositionPlan plans one disposition per undispositioned notice', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODEX, CODEX_NOTICE),
        notice(2, CODERABBIT, CODERABBIT_NOTICE),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 2);
  assert.deepEqual(
    plan.planned.map((entry) => entry.botLogin).sort(),
    [CODERABBIT, CODEX].sort(),
  );
  assert.equal(plan.skipped.length, 0);
  for (const entry of plan.planned) {
    assert.ok(entry.body.startsWith('**Rejected**'));
    assert.match(entry.body, /did not review HEAD abc1234/);
  }
});

test('buildDispositionPlan plans and then idempotently skips a current Codex no-find result', () => {
  const source = notice(320, CODEX, CODEX_NO_FIND_RESULT);
  const firstPlan = buildDispositionPlan(
    { headSha: 'abc1234', comments: [source] },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(firstPlan.planned.length, 1);
  assert.equal(firstPlan.planned[0]?.reason, 'Codex no-find result');
  assert.match(firstPlan.planned[0]?.body ?? '', /source: #issuecomment-320/);

  const disposition = notice(
    321,
    'kurone-kito',
    firstPlan.planned[0]?.body ?? '',
    '2026-05-12T01:00:00Z',
    '2026-05-12T01:00:00Z',
  );
  const secondPlan = buildDispositionPlan(
    { headSha: 'abc1234', comments: [source, disposition] },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.deepEqual(secondPlan.planned, []);
  assert.deepEqual(secondPlan.skipped, [
    {
      noticeId: 320,
      botLogin: CODEX,
      reason: 'already-dispositioned',
    },
  ]);
});

test('buildDispositionPlan keeps Codex sticky and no-find dispositions independently idempotent', () => {
  const headSha = `abc1234${'0'.repeat(33)}`;
  const comments = [
    notice(
      328,
      CODEX,
      CODEX_SUMMARY_COMPLETED,
      '2026-05-12T00:00:01Z',
      '2026-05-12T00:00:01Z',
    ),
    notice(
      329,
      CODEX,
      CODEX_NO_FIND_RESULT,
      '2026-05-12T00:00:02Z',
      '2026-05-12T00:00:02Z',
    ),
  ];
  const firstPlan = buildDispositionPlan(
    { headSha, comments },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.deepEqual(
    firstPlan.planned.map((item) => item.noticeId).sort((a, b) => a - b),
    [328, 329],
  );
  assert.deepEqual(
    firstPlan.planned.map((item) => item.reason).sort(),
    ['Codex no-find result', 'summary walkthrough'].sort(),
  );

  const dispositions = firstPlan.planned.map((item, index) =>
    notice(
      330 + index,
      'kurone-kito',
      item.body,
      '2026-05-12T01:00:00Z',
      '2026-05-12T01:00:00Z',
    ),
  );
  const secondPlan = buildDispositionPlan(
    { headSha, comments: [...comments, ...dispositions] },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.deepEqual(secondPlan.planned, []);
  assert.deepEqual(
    secondPlan.skipped.map((item) => item.noticeId).sort((a, b) => a - b),
    [328, 329],
  );
});

test('buildDispositionPlan ignores Codex no-find results outside the configured advisory bots', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(324, CODEX, CODEX_NO_FIND_RESULT)],
    },
    {
      advisoryBotLogins: [CODERABBIT],
      trustedMarkerLogins: ['kurone-kito'],
    },
  );
  assert.deepEqual(plan.planned, []);
  assert.deepEqual(plan.skipped, []);
});

test('gate agreement: a trusted Codex no-find disposition clears the matching source comment', () => {
  const source = {
    id: 322,
    author: { login: CODEX },
    body: CODEX_NO_FIND_RESULT,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const disposition = {
    id: 323,
    author: { login: 'kurone-kito' },
    body: buildCodexNoFindDispositionBody(CODEX, 'abc1234', 322),
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  const summary = summarizeDispositionEvidenceForGate(
    { comments: [source, disposition], threads: [] },
    {
      iddAgentLogins: [],
      advisoryBotLogins: [CODEX],
      trustedMarkerLogins: ['kurone-kito'],
      prHeadSha: 'abc1234',
    },
  );
  assert.equal(summary.missingRegularCommentCount, 0);
});

test('gate agreement: an IDD-agent Codex no-find disposition clears its source comment', () => {
  const source = {
    id: 323,
    author: { login: CODEX },
    body: CODEX_NO_FIND_RESULT,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const disposition = {
    id: 324,
    author: { login: 'idd-agent' },
    body: buildCodexNoFindDispositionBody(CODEX, 'abc1234', 323),
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  const summary = summarizeDispositionEvidenceForGate(
    { comments: [source, disposition], threads: [] },
    {
      iddAgentLogins: ['idd-agent'],
      advisoryBotLogins: [CODEX],
      trustedMarkerLogins: ['idd-agent'],
      prHeadSha: 'abc1234',
    },
  );
  assert.equal(summary.missingRegularCommentCount, 0);
});

test('gate agreement: a generic later IDD disposition cannot clear a Codex no-find source', () => {
  const source = {
    id: 325,
    author: { login: CODEX },
    body: CODEX_NO_FIND_RESULT,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const unrelatedDisposition = {
    id: 326,
    author: { login: 'idd-agent' },
    body: '**Accepted** — unrelated review feedback is resolved.',
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  const summary = summarizeDispositionEvidenceForGate(
    { comments: [source, unrelatedDisposition], threads: [] },
    {
      iddAgentLogins: ['idd-agent'],
      advisoryBotLogins: [CODEX],
      trustedMarkerLogins: ['idd-agent'],
      prHeadSha: 'abc1234',
    },
  );
  assert.equal(summary.missingRegularCommentCount, 1);
});

test('buildDispositionPlan re-plans when the no-find source is edited after its disposition', () => {
  const source = notice(
    327,
    CODEX,
    CODEX_NO_FIND_RESULT,
    '2026-05-12T00:00:00Z',
    '2026-05-12T02:00:00Z',
  );
  const disposition = notice(
    328,
    'kurone-kito',
    buildCodexNoFindDispositionBody(CODEX, 'abc1234', 327),
    '2026-05-12T01:00:00Z',
    '2026-05-12T01:00:00Z',
  );
  const plan = buildDispositionPlan(
    { headSha: 'abc1234', comments: [source, disposition] },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.deepEqual(
    plan.planned.map((item) => item.noticeId),
    [327],
  );
});

test('gate agreement requires the Codex disposition HEAD to match the current source HEAD', () => {
  const source = {
    id: 324,
    author: { login: CODEX },
    body: CODEX_NO_FIND_RESULT,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const staleDisposition = {
    id: 325,
    author: { login: 'kurone-kito' },
    body: buildCodexNoFindDispositionBody(CODEX, 'def5678', 324),
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  const summary = summarizeDispositionEvidenceForGate(
    { comments: [source, staleDisposition], threads: [] },
    {
      iddAgentLogins: ['kurone-kito'],
      advisoryBotLogins: [CODEX],
      trustedMarkerLogins: ['kurone-kito'],
      prHeadSha: 'abc1234',
    },
  );
  assert.equal(summary.missingRegularCommentCount, 1);
  assert.deepEqual(
    summary.missingRegularComments.map((comment) => comment.id),
    ['324'],
  );
});

test('gate preserves a Codex no-find disposition for an earlier HEAD', () => {
  const source = {
    id: 332,
    author: { login: CODEX },
    body: CODEX_NO_FIND_RESULT,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const disposition = {
    id: 333,
    author: { login: 'kurone-kito' },
    body: buildCodexNoFindDispositionBody(CODEX, 'abc1234', 332),
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  const summary = summarizeDispositionEvidenceForGate(
    { comments: [source, disposition], threads: [] },
    {
      advisoryBotLogins: [CODEX],
      trustedMarkerLogins: ['kurone-kito'],
      prHeadSha: 'def5678',
    },
  );
  assert.equal(summary.missingRegularCommentCount, 0);
});

test('regular-comment gate ignores a prior-HEAD Codex no-find acceptance', () => {
  const source = {
    id: 334,
    author: { login: CODEX },
    body: CODEX_NO_FIND_RESULT,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const disposition = {
    id: 335,
    author: { login: 'kurone-kito' },
    body: buildCodexNoFindDispositionBody(CODEX, 'abc1234', 334),
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  const summary = summarizeRegularCommentsForGate([source, disposition], {
    advisoryBotLogins: [CODEX],
    trustedMarkerLogins: ['kurone-kito'],
    prHeadSha: 'def5678',
  });
  assert.equal(summary.count, 0);
});

test('regular-comment gate clears a current Codex no-find disposition from an IDD agent', () => {
  const source = {
    id: 326,
    author: { login: CODEX },
    body: CODEX_NO_FIND_RESULT,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const disposition = {
    id: 327,
    author: { login: 'kurone-kito' },
    body: buildCodexNoFindDispositionBody(CODEX, 'abc1234', 326),
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  const summary = summarizeRegularCommentsForGate([source, disposition], {
    iddAgentLogins: ['kurone-kito'],
    advisoryBotLogins: [CODEX],
    trustedMarkerLogins: ['kurone-kito'],
    prHeadSha: 'abc1234',
  });
  assert.equal(summary.count, 0);
});

test('regular-comment gate keeps an undispositioned Codex no-find source after a later IDD reply', () => {
  const source = {
    id: 329,
    author: { login: CODEX },
    body: CODEX_NO_FIND_RESULT,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const unrelatedReply = {
    id: 330,
    author: { login: 'idd-agent' },
    body: 'Thanks, fixed the unrelated review feedback.',
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  const summary = summarizeRegularCommentsForGate([source, unrelatedReply], {
    iddAgentLogins: ['idd-agent'],
    advisoryBotLogins: [CODEX],
    trustedMarkerLogins: ['idd-agent'],
    prHeadSha: 'abc1234',
  });
  assert.deepEqual(
    summary.items.map((item) => item.id),
    ['329'],
  );
});

test('no-find source paths require the canonical Codex advisory identity', () => {
  const source = {
    id: 331,
    author: { login: CODERABBIT },
    body: CODEX_NO_FIND_RESULT,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const regularSummary = summarizeRegularCommentsForGate([source], {
    advisoryBotLogins: [CODERABBIT],
    prHeadSha: 'abc1234',
  });
  assert.equal(regularSummary.count, 1);
  const dispositionSummary = summarizeDispositionEvidenceForGate(
    { comments: [source], threads: [] },
    {
      advisoryBotLogins: [CODERABBIT],
      prHeadSha: 'abc1234',
    },
  );
  assert.equal(dispositionSummary.missingRegularCommentCount, 1);
});

test('buildDispositionPlan plans a rejection for the current Codex usage-limit wording', () => {
  // #1312 regression: Codex's current wording ("...have been reached...")
  // must still be recognized as a non-review notice and dispositioned.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(1, CODEX, CODEX_NOTICE_CURRENT_WORDING)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0]?.botLogin, CODEX);
  assert.ok(plan.planned[0]?.body.startsWith('**Rejected**'));
  assert.match(plan.planned[0]?.body ?? '', /did not review HEAD abc1234/);
});

test('buildDispositionPlan plans a rejection for the #1877 dashboard-pointer wording', () => {
  // #1877 regression: a third live Codex wording (observed on PR #1876,
  // 2026-08-05) points at the Codex usage dashboard instead of the
  // admin/credits sentence — must still be recognized as a non-review
  // notice and dispositioned. Literal text captured from
  // https://github.com/kurone-kito/idd-skill/pull/1876#issuecomment-5187108915.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(
          1,
          CODEX,
          'You have reached your Codex usage limits for code reviews. ' +
            'You can see your limits in the [Codex usage dashboard]' +
            '(https://chatgpt.com/codex/cloud/settings/usage).',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0]?.botLogin, CODEX);
  assert.ok(plan.planned[0]?.body.startsWith('**Rejected**'));
  assert.match(plan.planned[0]?.body ?? '', /did not review HEAD abc1234/);
});

test('buildDispositionPlan does not disposition the #1326 false-positive review comment', () => {
  // #1326: a genuine Codex review comment that combines "Codex", a
  // reach/exceed/hit verb, and "for code reviews" in ordinary prose (the
  // concrete example flagged in PR #1319's own review of the #1312 fix)
  // must not be misclassified as a non-review notice and dispositioned.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(
          1,
          CODEX,
          'This code hits the Codex usage limits for code reviews configured for the repo.',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.skipped.length, 0);
});

test('buildDispositionPlan is idempotent: a notice already dispositioned for its bot is skipped', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODEX, CODEX_NOTICE),
        notice(2, CODERABBIT, CODERABBIT_NOTICE),
        // A trusted IDD disposition that names the Codex connector.
        notice(
          3,
          'kurone-kito',
          '**Rejected** — chatgpt-codex-connector[bot] did not review HEAD abc1234 (usage); this is not a completed review',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  // Codex covered (skipped); CodeRabbit still needs one (planned).
  assert.deepEqual(
    plan.planned.map((entry) => entry.botLogin),
    [CODERABBIT],
  );
  assert.deepEqual(
    plan.skipped.map((entry) => entry.botLogin),
    [CODEX],
  );
});

test('buildDispositionPlan attributes a disposition only to the bot it names (author-scoped)', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODERABBIT, CODERABBIT_NOTICE),
        // A Codex-only disposition must NOT cover the CodeRabbit notice.
        notice(
          2,
          'kurone-kito',
          '**Rejected** — chatgpt-codex-connector[bot] did not review HEAD abc1234 (usage); this is not a completed review',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.deepEqual(
    plan.planned.map((entry) => entry.botLogin),
    [CODERABBIT],
  );
  assert.equal(plan.skipped.length, 0);
});

test('buildDispositionPlan pairs by count: N notices, K dispositions -> N-K planned', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODEX, CODEX_NOTICE),
        notice(2, CODEX, CODEX_NOTICE),
        notice(
          3,
          'kurone-kito',
          '**Rejected** — chatgpt-codex-connector[bot] did not review HEAD abc1234 (usage); this is not a completed review',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.skipped.length, 1);
});

test('buildDispositionPlan is fail-closed: real reviews and non-bot comments are never dispositioned', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        // A real Codex review (not a notice) must not be dispositioned.
        notice(1, CODEX, 'I found an off-by-one in foo.mts at line 42.'),
        // A CodeRabbit comment that is neither a rate-limit notice nor the
        // summary walkthrough marker — the helper must not touch it.
        notice(
          2,
          CODERABBIT,
          'A nudge from the bot, not an auto-generated marker.',
        ),
        // A human comment that merely mentions usage limits.
        notice(3, 'reviewer-a', 'please cap the Codex usage limits in config'),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.skipped.length, 0);
});

test('buildDispositionPlan only considers configured advisory bots', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(1, CODEX, CODEX_NOTICE)],
    },
    { advisoryBotLogins: [CODERABBIT], trustedMarkerLogins: ['kurone-kito'] },
  );
  // Codex is not in the configured advisory-bot set here, so nothing is planned.
  assert.equal(plan.planned.length, 0);
});

test('buildDispositionPlan plans both the notice (rejected) and the summary (accepted)', () => {
  // A persistent rate-limit notice stays in the gate's outstanding set until a
  // disposition naming the bot carries it; the CodeRabbit summary walkthrough is a
  // separate completed-review item the gate scores through its general
  // updatedAt-aware pairing. The helper plans BOTH — the notice **Rejected** and
  // the summary **Accepted**.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODERABBIT, CODERABBIT_NOTICE),
        notice(2, CODERABBIT, CODERABBIT_SUMMARY),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 2);
  const rejected = plan.planned.find((entry) =>
    entry.body.startsWith('**Rejected**'),
  );
  const accepted = plan.planned.find((entry) =>
    entry.body.startsWith('**Accepted**'),
  );
  assert.ok(rejected && /did not review HEAD/.test(rejected.body));
  assert.ok(accepted && /summary walkthrough/.test(accepted.body));
  assert.equal(plan.skipped.length, 0);
});

test('buildDispositionPlan keys advisory bots by suffix-insensitive identity', () => {
  // The notice is authored as `coderabbitai` (no [bot]); the configured advisory
  // login is `coderabbitai[bot]`. They must resolve to the same identity.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(1, 'coderabbitai', CODERABBIT_NOTICE)],
    },
    {
      advisoryBotLogins: [CODERABBIT],
      trustedMarkerLogins: ['kurone-kito'],
    },
  );
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].botLogin, 'coderabbitai');
});

test('buildDispositionPlan breaks oldest-first ties deterministically by id', () => {
  // Two same-bot notices share a timestamp; the lower-id one is covered first.
  const ts = '2026-05-12T00:00:00Z';
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(2, CODEX, CODEX_NOTICE, ts),
        notice(1, CODEX, CODEX_NOTICE, ts),
        notice(
          3,
          'kurone-kito',
          '**Rejected** — chatgpt-codex-connector[bot] did not review HEAD abc1234 (usage); this is not a completed review',
          ts,
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.deepEqual(
    plan.skipped.map((entry) => entry.noticeId),
    [1],
  );
  assert.deepEqual(
    plan.planned.map((entry) => entry.noticeId),
    [2],
  );
});

test('a combined disposition naming several bots covers only one notice', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODEX, CODEX_NOTICE),
        notice(2, CODERABBIT, CODERABBIT_NOTICE),
        // One trusted disposition that (improperly) names BOTH bots: the F2/F3
        // gate consumes it once, so it must cover one notice, not one per bot.
        notice(
          3,
          'kurone-kito',
          '**Rejected** — chatgpt-codex-connector[bot] and coderabbitai[bot] did not review HEAD abc1234 (usage); this is not a completed review',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.planned.length, 1);
});

test('buildSummaryDispositionBody is marker-first, names the login + head sha, and avoids the word CodeRabbit', () => {
  const body = buildSummaryDispositionBody(CODERABBIT, 'abc1234');
  assert.ok(body.startsWith('**Accepted**'), 'marker must be first bytes');
  assert.match(body, /coderabbitai\[bot\] summary walkthrough at HEAD abc1234/);
  // The standalone word "CodeRabbit" would make the gate's createdAt-based
  // RESOLVED path permanently clear the summary instead of per-HEAD
  // re-disposition, so the body must use the login form only.
  assert.doesNotMatch(body, /\bCodeRabbit\b/);
  assert.ok(hasReviewReplyStamp(body));
});

test('buildDispositionPlan plans an **Accepted** for an undispositioned CodeRabbit summary', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(1, CODERABBIT, CODERABBIT_SUMMARY)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  const entry = plan.planned[0];
  assert.equal(entry.botLogin, CODERABBIT);
  assert.ok(entry.body.startsWith('**Accepted**'));
  assert.match(
    entry.body,
    /coderabbitai\[bot\] summary walkthrough at HEAD abc1234/,
  );
  assert.doesNotMatch(entry.body, /\bCodeRabbit\b/);
  assert.equal(plan.skipped.length, 0);
});

test('#2161: isReviewSummaryComment is false and isAdvisoryNonReviewNotice is true for a CodeRabbit skip-review notice nested in the summary marker', () => {
  assert.equal(isReviewSummaryComment(CODERABBIT_SKIP_REVIEW), false);
  assert.equal(isAdvisoryNonReviewNotice(CODERABBIT_SKIP_REVIEW), true);
});

test('#2161: isReviewSummaryComment and isAdvisoryNonReviewNotice agree on a casing-only skip-review marker variation', () => {
  const upperCased = CODERABBIT_SKIP_REVIEW.replace(
    'skip review by coderabbit.ai',
    'Skip Review By CodeRabbit.ai',
  );
  assert.equal(isReviewSummaryComment(upperCased), false);
  assert.equal(isAdvisoryNonReviewNotice(upperCased), true);
});

test('#2161: a genuine walkthrough (no inner skip-review marker) is still a summary walkthrough, not a notice', () => {
  assert.equal(isReviewSummaryComment(CODERABBIT_SUMMARY), true);
  assert.equal(isAdvisoryNonReviewNotice(CODERABBIT_SUMMARY), false);
});

test('#2695: isReviewSummaryComment recognizes a Codex review-status comment in both "Running" and "Completed" table states', () => {
  // Marker recognition alone is state-agnostic; the Running/Completed
  // distinction is enforced separately by isCodexReviewSummaryCompleteForHeadSha
  // (see the tests below), not by isReviewSummaryComment itself.
  assert.equal(isReviewSummaryComment(CODEX_SUMMARY_RUNNING), true);
  assert.equal(isReviewSummaryComment(CODEX_SUMMARY_COMPLETED), true);
});

test('#2695 (Codex review, P1): isCodexReviewSummaryCompleteForHeadSha is true only for a Completed row matching the current HEAD', () => {
  assert.equal(
    isCodexReviewSummaryCompleteForHeadSha(CODEX_SUMMARY_COMPLETED, 'abc1234'),
    true,
  );
  assert.equal(
    isCodexReviewSummaryCompleteForHeadSha(CODEX_SUMMARY_RUNNING, 'abc1234'),
    false,
  );
});

// Copilot review (PR #3422): a bare `/completed/i` substring test would
// wrongly accept "Not Completed" or "Uncompleted" (both contain the
// substring "completed"). Anchor to the exact bolded status word instead.
test('#3261 (Copilot review, PR #3422): isCodexReviewSummaryCompleteForHeadSha is false for a "Not Completed" status row (substring-match false positive)', () => {
  const notCompletedBody =
    '<!-- codex-pull-request-review-summary -->\n\n' +
    '## Codex Review Summary\n\n' +
    '| Review | Status | Commit | Review trigger |\n' +
    '| --- | --- | --- | --- |\n' +
    '| 📝 **Code Review** | ⚠️ **Not Completed** | `abc1234` | PR opened |\n';
  assert.equal(
    isCodexReviewSummaryCompleteForHeadSha(notCompletedBody, 'abc1234'),
    false,
  );
});

// Copilot review (PR #3422, second round): the first-round fix
// (`/\*\*\s*completed\s*\*\*/i.test()`) was still an unanchored substring
// search -- it would still match a malformed cell carrying a separately
// bolded "Completed" segment embedded after other bolded text, since
// `.test()` searches anywhere in the string. Extracting only the FIRST
// bolded segment and comparing it exactly closes this.
test('#3261 (Copilot review, PR #3422, round 2): isCodexReviewSummaryCompleteForHeadSha is false for a malformed cell with a separately bolded "Completed" segment', () => {
  const malformedBody =
    '<!-- codex-pull-request-review-summary -->\n\n' +
    '## Codex Review Summary\n\n' +
    '| Review | Status | Commit | Review trigger |\n' +
    '| --- | --- | --- | --- |\n' +
    '| 📝 **Code Review** | **Not **Completed** | `abc1234` | PR opened |\n';
  assert.equal(
    isCodexReviewSummaryCompleteForHeadSha(malformedBody, 'abc1234'),
    false,
  );
});

test('#2695 (Codex review, P1): isCodexReviewSummaryCompleteForHeadSha is false for a Completed row naming a different (stale) commit', () => {
  // A stale summary left over from a prior HEAD must not be mistaken for
  // completion at the CURRENT HEAD merely because some row says Completed.
  assert.equal(
    isCodexReviewSummaryCompleteForHeadSha(CODEX_SUMMARY_COMPLETED, 'def5678'),
    false,
  );
});

test('#2695 (Codex review, P1): isCodexReviewSummaryCompleteForHeadSha is false for a body with no parseable status table', () => {
  assert.equal(
    isCodexReviewSummaryCompleteForHeadSha(
      'just plain text, no table',
      'abc1234',
    ),
    false,
  );
  assert.equal(
    isCodexReviewSummaryCompleteForHeadSha(CODEX_SUMMARY_COMPLETED, ''),
    false,
  );
});

test('#2695: buildDispositionPlan plans an **Accepted** for an undispositioned Codex review-status comment, same as CodeRabbit', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(1, CODEX, CODEX_SUMMARY_COMPLETED)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  const entry = plan.planned[0];
  assert.equal(entry.botLogin, CODEX);
  assert.ok(entry.body.startsWith('**Accepted**'));
  assert.match(
    entry.body,
    /chatgpt-codex-connector\[bot\] summary walkthrough at HEAD abc1234/,
  );
  assert.equal(plan.skipped.length, 0);
});

test('#2695 (Codex review, P1): buildDispositionPlan never auto-accepts a Codex summary while its table still shows the HEAD as Running', () => {
  // Guards the exact TOCTOU hazard Codex's own review flagged on this fix's
  // first commit: accepting a still-Running summary would let the gate treat
  // the review as settled before Codex has posted its real findings.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(1, CODEX, CODEX_SUMMARY_RUNNING)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.deepEqual(plan.skipped, [
    { noticeId: 1, botLogin: CODEX, reason: 'codex-review-running' },
  ]);
});

test('#2695: buildDispositionPlan skips a Codex summary already accepted by a strictly-newer disposition (idempotent re-run)', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODEX, CODEX_SUMMARY_COMPLETED, '2026-05-12T00:00:00Z'),
        notice(
          2,
          'kurone-kito',
          buildSummaryDispositionBody(CODEX, 'abc1234'),
          '2026-05-12T01:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.deepEqual(
    plan.skipped.map((entry) => entry.noticeId),
    [1],
  );
});

test('#2161: buildDispositionPlan proposes **Rejected**, never **Accepted**, for a CodeRabbit skip-review notice', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(1, CODERABBIT, CODERABBIT_SKIP_REVIEW)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  const entry = plan.planned[0];
  assert.equal(entry.botLogin, CODERABBIT);
  assert.ok(entry.body.startsWith('**Rejected**'));
  assert.doesNotMatch(entry.body, /\*\*Accepted\*\*/);
  assert.match(entry.body, /did not review HEAD abc1234/);
  assert.equal(plan.skipped.length, 0);
});

test('buildDispositionPlan skips a summary already accepted by a strictly-newer disposition', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODERABBIT, CODERABBIT_SUMMARY, '2026-05-12T00:00:00Z'),
        // A trusted summary acceptance posted AFTER the summary's activity.
        notice(
          2,
          'kurone-kito',
          buildSummaryDispositionBody(CODERABBIT, 'abc1234'),
          '2026-05-12T01:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.deepEqual(
    plan.skipped.map((entry) => entry.noticeId),
    [1],
  );
});

test('buildDispositionPlan re-plans the summary when its updatedAt bumps past the prior acceptance', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'def5678',
      comments: [
        // The prior acceptance predates the summary's latest edit.
        notice(
          1,
          'kurone-kito',
          buildSummaryDispositionBody(CODERABBIT, 'abc1234'),
          '2026-05-12T01:00:00Z',
        ),
        // CodeRabbit edited the summary AFTER the acceptance (updatedAt bumps).
        notice(
          2,
          CODERABBIT,
          CODERABBIT_SUMMARY,
          '2026-05-12T00:00:00Z',
          '2026-05-12T02:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].noticeId, 2);
  assert.ok(plan.planned[0].body.startsWith('**Accepted**'));
});

test('buildDispositionPlan only auto-dispositions summaries from configured advisory bots', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(1, CODERABBIT, CODERABBIT_SUMMARY)],
    },
    { advisoryBotLogins: [CODEX], trustedMarkerLogins: ['kurone-kito'] },
  );
  // CodeRabbit is not in the configured advisory-bot set here.
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.skipped.length, 0);
});

test('buildDispositionPlan does not treat a comment that merely quotes the summary marker as a summary', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(
          1,
          CODERABBIT,
          'See the marker `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->` referenced inline.',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.skipped.length, 0);
});

test('buildDispositionPlan does not auto-dispose a "no actionable comments" summary (gate already RESOLVED)', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(
          1,
          CODERABBIT,
          '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n**Actionable comments posted: 0**\nNo actionable comments were generated.',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.deepEqual(
    plan.skipped.map((entry) => entry.reason),
    ['summary-resolved-no-actionable-comments'],
  );
});

test('#3260: buildDispositionPlan skips the PR #3196 in-progress revision with reason coderabbit-review-in-progress, never Accepted', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'a5a56e57267540dc046659c600bcb7c62bdc3949',
      comments: [notice(1, CODERABBIT, CODERABBIT_IN_PROGRESS)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.deepEqual(plan.skipped, [
    {
      noticeId: 1,
      botLogin: CODERABBIT,
      reason: 'coderabbit-review-in-progress',
    },
  ]);
});

// C1 critique follow-up: the two tests above never combine both markers in
// one fixture, so neither alone proves the in-progress check actually runs
// BEFORE the "No actionable comments" check (swapping their order would not
// change either test's outcome). This fixture -- PR #3160 comment
// `5747892562`'s real shape -- carries both, making the ordering
// load-bearing: were the "No actionable comments" check to run first, this
// would wrongly report `summary-resolved-no-actionable-comments` instead.
test('#3260: buildDispositionPlan reports coderabbit-review-in-progress, not summary-resolved-no-actionable-comments, for the PR #3160 fixture that carries both', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODERABBIT, CODERABBIT_IN_PROGRESS_WITH_STALE_SENTENCE),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.deepEqual(plan.skipped, [
    {
      noticeId: 1,
      botLogin: CODERABBIT,
      reason: 'coderabbit-review-in-progress',
    },
  ]);
});

test('#3260: buildDispositionPlan keeps the existing skip reason for the PR #3196 completed revision (07:20:35Z, "No actionable comments")', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'a5a56e57267540dc046659c600bcb7c62bdc3949',
      comments: [notice(1, CODERABBIT, CODERABBIT_COMPLETED_NO_ACTIONABLE)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 0);
  assert.deepEqual(
    plan.skipped.map((entry) => entry.reason),
    ['summary-resolved-no-actionable-comments'],
  );
});

test('#3260: buildDispositionPlan still plans an Accepted summary walkthrough for the PR #3196 completed revision without the "No actionable" sentence (06:10:19Z)', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'a5a56e57267540dc046659c600bcb7c62bdc3949',
      comments: [notice(1, CODERABBIT, CODERABBIT_COMPLETED_WALKTHROUGH)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  const entry = plan.planned[0];
  assert.equal(entry.botLogin, CODERABBIT);
  assert.ok(entry.body.startsWith('**Accepted**'));
  assert.match(entry.body, /summary walkthrough/);
  assert.equal(plan.skipped.length, 0);
});

test('#3260: buildDispositionPlan plans a Rejected notice with the paused noticeReason for the PR #3154 paused revision, never Accepted', () => {
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [notice(1, CODERABBIT, CODERABBIT_PAUSED)],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  const entry = plan.planned[0];
  assert.equal(entry.botLogin, CODERABBIT);
  assert.ok(entry.body.startsWith('**Rejected**'));
  assert.doesNotMatch(entry.body, /\*\*Accepted\*\*/);
  assert.match(entry.body, /did not review HEAD abc1234/);
  assert.match(entry.body, /reviews paused by the bot; a resume is needed/);
  assert.equal(plan.skipped.length, 0);
  assert.equal(
    noticeReason(CODERABBIT_PAUSED),
    'reviews paused by the bot; a resume is needed',
  );
});

test('buildDispositionPlan greedily consumes one disposition per summary (two summaries, one disposition -> one planned)', () => {
  // Two distinct summary comments coexist with a single newer acceptance. The
  // gate's greedy 1:1 pairing clears only one, so the helper must leave the
  // second planned (a bare existence check would wrongly skip both -> stuck gate).
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODERABBIT, CODERABBIT_SUMMARY, '2026-05-12T00:00:00Z'),
        notice(2, CODERABBIT, CODERABBIT_SUMMARY, '2026-05-12T00:30:00Z'),
        notice(
          3,
          'kurone-kito',
          buildSummaryDispositionBody(CODERABBIT, 'abc1234'),
          '2026-05-12T01:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  // The oldest summary (id 1) consumes the acceptance; the second (id 2) is planned.
  assert.deepEqual(
    plan.skipped.map((entry) => entry.noticeId),
    [1],
  );
  assert.deepEqual(
    plan.planned.map((entry) => entry.noticeId),
    [2],
  );
});

test('buildDispositionPlan rejects (does not also accept) a summary that is itself a rate-limit notice', () => {
  // A comment that carries the summary marker AND a rate-limit heading is a
  // non-review notice: the notice path rejects it, and the summary path must not
  // also accept it — a comment id gets at most one disposition.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(
          1,
          CODERABBIT,
          `${CODERABBIT_SUMMARY}\n\n> ## Review limit reached`,
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  assert.ok(plan.planned[0].body.startsWith('**Rejected**'));
  assert.equal(plan.skipped.length, 0);
});

test('buildDispositionPlan re-plans a summary whose acceptance an older non-agent comment could steal', () => {
  // #1122 (Copilot finding): under the gate's GLOBAL greedy pairing, a summary's
  // **Accepted** can be consumed by an OLDER undispositioned non-agent comment,
  // leaving the summary still flagged. The helper only models summary↔summary
  // pairing, so it must err toward posting when such an older comment exists.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        // An older human comment with no disposition of its own (a potential thief).
        notice(
          1,
          'reviewer-a',
          'Please rename foo to bar.',
          '2026-05-12T00:00:00Z',
        ),
        notice(2, CODERABBIT, CODERABBIT_SUMMARY, '2026-05-12T00:30:00Z'),
        notice(
          3,
          'kurone-kito',
          buildSummaryDispositionBody(CODERABBIT, 'abc1234'),
          '2026-05-12T01:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  // The acceptance (id 3) could be stolen by the older human comment (id 1), so
  // the summary (id 2) is re-planned rather than skipped.
  assert.deepEqual(
    plan.planned.map((entry) => entry.noticeId),
    [2],
  );
  assert.equal(plan.skipped.length, 0);
});

// kurone-kito/idd-skill#3267: markerCouldBeStolen routed through the shared
// classifyIddPrComment, in place of the former blanket
// `!trustedMarkerLogins.has(other.login)` check that skipped every comment
// by a trusted marker login regardless of its body.

test('buildDispositionPlan: a trusted historical live-status digest older than the disposition cannot steal it', () => {
  const digestBody = retireLiveStatusDigestBody(
    renderLiveStatusDigest({
      phase: 'E1 snapshot',
      claim: 'claim-test0001',
      branch: 'issue/1-test',
      lastChecked: '2026-05-11T00:00:00Z',
      openBlockers: 'none',
      nextAction: 'E2 critique',
      authoritativeBy: 'this comment',
    }),
  );
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        // A trusted-author digest, older than the disposition -- IDD's own
        // operational bookkeeping, not a genuine review comment.
        notice(1, 'kurone-kito', digestBody, '2026-05-12T00:00:00Z'),
        notice(2, CODERABBIT, CODERABBIT_SUMMARY, '2026-05-12T00:30:00Z'),
        notice(
          3,
          'kurone-kito',
          buildSummaryDispositionBody(CODERABBIT, 'abc1234'),
          '2026-05-12T01:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  // The digest cannot steal the disposition's pairing slot, so the summary
  // (id 2) is correctly recognized as already covered -- skipped, not
  // re-planned.
  assert.equal(plan.planned.length, 0);
  assert.deepEqual(
    plan.skipped.map((entry) => entry.noticeId),
    [2],
  );
});

test('buildDispositionPlan: an untrusted <!-- idd- shaped comment still counts as a genuine steal candidate', () => {
  const spoofedBody =
    '<!-- idd-live-status: historical -->\n\n| Field | Value |\n| --- | --- |\n';
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        // An UNTRUSTED author's marker-shaped comment, older than the
        // disposition -- never given the operational pass.
        notice(1, 'a-random-outsider', spoofedBody, '2026-05-12T00:00:00Z'),
        notice(2, CODERABBIT, CODERABBIT_SUMMARY, '2026-05-12T00:30:00Z'),
        notice(
          3,
          'kurone-kito',
          buildSummaryDispositionBody(CODERABBIT, 'abc1234'),
          '2026-05-12T01:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  // Real, unaddressed activity -- it can steal the disposition's pairing
  // slot, so the summary is re-planned rather than skipped.
  assert.deepEqual(
    plan.planned.map((entry) => entry.noticeId),
    [2],
  );
  assert.equal(plan.skipped.length, 0);
});

test('gate agreement: the planned **Accepted** clears the summary from missingRegularComments', () => {
  const summary = {
    id: 1,
    author: { login: CODERABBIT },
    body: CODERABBIT_SUMMARY,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const gateOptions = {
    iddAgentLogins: ['kurone-kito'],
    advisoryBotLogins: [CODERABBIT, CODEX],
  };
  // Before: the gate flags the undispositioned summary.
  const before = summarizeDispositionEvidenceForGate(
    { comments: [summary], threads: [] },
    gateOptions,
  );
  assert.equal(before.missingRegularCommentCount, 1);

  // The helper plans the **Accepted**; post it as an IDD-agent comment newer than
  // the summary's activity.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(
          1,
          CODERABBIT,
          CODERABBIT_SUMMARY,
          '2026-05-12T00:00:00Z',
          '2026-05-12T00:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  const accepted = {
    id: 2,
    author: { login: 'kurone-kito' },
    body: plan.planned[0].body,
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  // After: the gate no longer flags the summary.
  const after = summarizeDispositionEvidenceForGate(
    { comments: [summary, accepted], threads: [] },
    gateOptions,
  );
  assert.equal(after.missingRegularCommentCount, 0);
});

test('gate agreement: the summary stays cleared alongside another outstanding comment', () => {
  const summary = {
    id: 1,
    author: { login: CODERABBIT },
    body: CODERABBIT_SUMMARY,
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const human = {
    id: 2,
    author: { login: 'reviewer-a' },
    body: 'Please rename foo to bar.',
    createdAt: '2026-05-12T00:30:00Z',
    updatedAt: '2026-05-12T00:30:00Z',
  };
  const gateOptions = {
    iddAgentLogins: ['kurone-kito'],
    advisoryBotLogins: [CODERABBIT, CODEX],
  };
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(
          1,
          CODERABBIT,
          CODERABBIT_SUMMARY,
          '2026-05-12T00:00:00Z',
          '2026-05-12T00:00:00Z',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  // One disposition per outstanding comment: the helper's summary **Accepted**
  // plus a manual disposition for the human comment. The gate's greedy pairing
  // covers both.
  const summaryAccepted = {
    id: 3,
    author: { login: 'kurone-kito' },
    body: plan.planned[0].body,
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };
  const humanDisposition = {
    id: 4,
    author: { login: 'kurone-kito' },
    body: '**Accepted** — will rename in a follow-up',
    createdAt: '2026-05-12T01:01:00Z',
    updatedAt: '2026-05-12T01:01:00Z',
  };
  const after = summarizeDispositionEvidenceForGate(
    {
      comments: [summary, human, summaryAccepted, humanDisposition],
      threads: [],
    },
    gateOptions,
  );
  assert.equal(after.missingRegularCommentCount, 0);
});

test('the dry-run and apply output envelopes validate against the schema', () => {
  const plan = buildDispositionPlan(
    {
      headSha: HEAD_SHA,
      comments: [
        notice(1, CODEX, CODEX_NOTICE),
        notice(2, CODERABBIT, CODERABBIT_NOTICE),
        // Include a summary so `planned` carries an **Accepted** body and the
        // broadened schema pattern is exercised.
        notice(3, CODERABBIT, CODERABBIT_SUMMARY),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.ok(
    plan.planned.some((entry) => entry.body.startsWith('**Accepted**')),
    'a summary **Accepted** must be planned',
  );
  const dryRun = { mode: 'dry-run', prNumber: 7, ...plan };
  assert.equal(validate(dryRun, planSchema).length, 0, 'dry-run output');

  const apply = {
    mode: 'apply',
    prNumber: 7,
    headSha: plan.headSha,
    status: 'applied',
    applied: plan.planned.map((entry, index) => ({
      noticeId: entry.noticeId,
      commentId: 1000 + index,
    })),
    failed: [],
    skipped: plan.skipped,
  };
  assert.equal(validate(apply, planSchema).length, 0, 'apply output');
});

// --- #1709: applyDispositionPlan (extracted --apply write loop) -----------
// Mirrors resolve-review-thread.test.mts's applyResolveReviewThread suite:
// fake in-memory deps, no network, exercising the per-post claim
// revalidation, 2-attempt post/recover retry, and knownViewerCommentIds
// bookkeeping in isolation.

function fakePlan(plannedIds: number[]): DispositionPlan {
  return {
    headSha: 'abc1234',
    planned: plannedIds.map((noticeId) => ({
      noticeId,
      botLogin: CODERABBIT,
      reason: 'review limit reached / rate limited',
      body: buildDispositionBody(
        CODERABBIT,
        'abc1234',
        'review limit reached / rate limited',
        noticeId,
      ),
    })),
    skipped: [],
  };
}

test('applyDispositionPlan: happy path posts every item and reports accurate attribution', () => {
  const calls: string[] = [];
  const plan = fakePlan([101, 102]);
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => {
      calls.push('claim');
      return true;
    },
    postDisposition: (body) => {
      // Identify the item by its notice-id token (same pattern the other
      // tests in this file use), not a bare substring match, which could
      // otherwise misfire against another field (e.g. the head SHA) that
      // happens to contain the same digits.
      const noticeId = Number(/issuecomment-(\d+)/.exec(body)?.[1]);
      calls.push(`post:${noticeId}`);
      return { id: 9000 + noticeId };
    },
    recoverPostedDisposition: () => {
      calls.push('recover');
      return null;
    },
    knownViewerCommentIds: new Set([1]),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.equal(result.claimLost, false);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [
    { noticeId: 101, commentId: 9101 },
    { noticeId: 102, commentId: 9102 },
  ]);
  // The seed id plus both newly posted ids.
  assert.deepEqual(
    [...result.knownViewerCommentIds].sort((a, b) => a - b),
    [1, 9101, 9102],
  );
  // A claim check precedes each post; no recovery needed on the happy path.
  assert.deepEqual(calls, ['claim', 'post:101', 'claim', 'post:102']);
});

test('applyDispositionPlan: an empty plan is a no-op that touches no dep', () => {
  const calls: string[] = [];
  const plan = fakePlan([]);
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => {
      calls.push('claim');
      return true;
    },
    postDisposition: () => {
      calls.push('post');
      return { id: 1 };
    },
    recoverPostedDisposition: () => {
      calls.push('recover');
      return null;
    },
    knownViewerCommentIds: new Set([7]),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(result, {
    applied: [],
    failed: [],
    staleSkipped: [],
    claimLost: false,
    knownViewerCommentIds: new Set([7]),
    postFailure: null,
  });
  assert.deepEqual(calls, []);
});

test('applyDispositionPlan: claim lost mid-loop stops posting and fail-marks every remaining item', () => {
  const postCalls: number[] = [];
  const plan = fakePlan([201, 202, 203]);
  let claimChecks = 0;
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => {
      claimChecks += 1;
      // The first item's claim check passes; the second fails (handoff /
      // release raced in mid-loop).
      return claimChecks === 1;
    },
    postDisposition: (body) => {
      const noticeId = /issuecomment-(\d+)/.exec(body)?.[1];
      postCalls.push(Number(noticeId));
      return { id: 8000 + Number(noticeId) };
    },
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.equal(result.claimLost, true);
  // Only the first item (whose claim check passed) ever reaches postDisposition.
  assert.deepEqual(postCalls, [201]);
  assert.deepEqual(result.applied, [{ noticeId: 201, commentId: 8201 }]);
  assert.deepEqual(result.failed, [
    { noticeId: 202, error: 'claim revalidation failed before post' },
    { noticeId: 203, error: 'claim revalidation failed before post' },
  ]);
});

test('applyDispositionPlan: a post failure recovers via a NEW comment id without a second post (no double-post)', () => {
  const postCalls: number[] = [];
  const plan = fakePlan([301]);
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: (body) => {
      const noticeId = Number(/issuecomment-(\d+)/.exec(body)?.[1]);
      postCalls.push(noticeId);
      throw new Error(`create failed for ${noticeId}`);
    },
    recoverPostedDisposition: (_body, knownIds) => {
      // Simulates finding the comment the failed create actually posted.
      return knownIds.has(7301) ? null : { id: 7301 };
    },
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(result.applied, [{ noticeId: 301, commentId: 7301 }]);
  assert.deepEqual(result.failed, []);
  // Recovery succeeded on the first attempt, so postDisposition is called
  // exactly once for this item -- the second raw attempt never runs.
  assert.deepEqual(postCalls, [301]);
  // The recovered id lands in the returned knownViewerCommentIds.
  assert.ok(result.knownViewerCommentIds.has(7301));
});

test('applyDispositionPlan: a recovered id cannot be double-attributed across items', () => {
  // Two items whose creates both fail; the fake recovery would find the SAME
  // candidate id for both, but only the first item may claim it (the id
  // becomes "known" once attributed) -- proving no double-attribution.
  const plan = fakePlan([401, 402]);
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => {
      throw new Error('create failed');
    },
    recoverPostedDisposition: (_body, knownIds) =>
      knownIds.has(9999) ? null : { id: 9999 },
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(result.applied, [{ noticeId: 401, commentId: 9999 }]);
  assert.deepEqual(result.failed, [{ noticeId: 402, error: 'create failed' }]);
  assert.ok(result.knownViewerCommentIds.has(9999));
});

test('applyDispositionPlan: retries the raw post once when recovery finds nothing, then succeeds', () => {
  const plan = fakePlan([501]);
  let postAttempts = 0;
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => {
      postAttempts += 1;
      if (postAttempts === 1) {
        throw new Error('transient failure');
      }
      return { id: 6501 };
    },
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.equal(postAttempts, 2);
  assert.deepEqual(result.applied, [{ noticeId: 501, commentId: 6501 }]);
  assert.deepEqual(result.failed, []);
});

test('applyDispositionPlan: reports the LAST attempt error when both attempts and recovery are exhausted', () => {
  const plan = fakePlan([601]);
  let postAttempts = 0;
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => {
      postAttempts += 1;
      throw new Error(`attempt ${postAttempts} failed`);
    },
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.equal(postAttempts, 2);
  assert.deepEqual(result.applied, []);
  // lastError is reassigned on each attempt, so only attempt 2's message
  // survives into the failure report.
  assert.deepEqual(result.failed, [
    { noticeId: 601, error: 'attempt 2 failed' },
  ]);
  assert.ok(result.postFailure instanceof Error);
});

test('applyDispositionPlan: keeps a tagged gh post failure for transport classification', () => {
  const plan = fakePlan([602]);
  const ghError = new Error('gh: HTTP 503');
  Object.defineProperty(ghError, 'ghCommand', { value: true });
  Object.defineProperty(ghError, 'stderr', { value: 'gh: HTTP 503' });
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => {
      throw ghError;
    },
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.equal(result.postFailure, ghError);
  assert.equal(result.failed[0]?.error, 'gh: HTTP 503');
  const classified = classifyHelperError(result.postFailure);
  assert.equal(classified.kind, 'transport');
  assert.equal(classified.httpStatus, 503);
});

test('applyDispositionPlan: preserves a non-Error thrown value instead of collapsing to "unknown error"', () => {
  // A thrown string/object (not an Error instance) must still surface its
  // own diagnostic via String() coercion, matching this repo's
  // `error instanceof Error ? error.message : String(error)` convention
  // elsewhere (idd-onboard.mts, discover-shared-file-overlap.mts,
  // rerun-advisory-convergence.mts) -- not report a generic 'unknown error'.
  const plan = fakePlan([701]);
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => {
      throw 'rate limited: retry after 30s';
    },
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.failed, [
    { noticeId: 701, error: 'rate limited: retry after 30s' },
  ]);
});

// --- #2695 (Codex review, P1 follow-up): revalidateCodexSummaryStillComplete

function fakeCodexSummaryPlan(noticeId: number): DispositionPlan {
  return {
    headSha: 'abc1234',
    planned: [
      {
        noticeId,
        botLogin: CODEX,
        reason: 'summary walkthrough',
        body: buildSummaryDispositionBody(CODEX, 'abc1234'),
      },
    ],
    skipped: [],
  };
}

function fakeCodexNoFindPlan(noticeId: number): DispositionPlan {
  return {
    headSha: 'abc1234',
    planned: [
      {
        noticeId,
        botLogin: CODEX,
        reason: 'Codex no-find result',
        body: buildCodexNoFindDispositionBody(CODEX, 'abc1234', noticeId),
      },
    ],
    skipped: [],
  };
}

test('applyDispositionPlan: skips (not fails) a planned Codex summary that revalidateCodexSummaryStillComplete reports as no longer complete', () => {
  const calls: string[] = [];
  const plan = fakeCodexSummaryPlan(801);
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => {
      calls.push('claim');
      return true;
    },
    postDisposition: () => {
      calls.push('post');
      return { id: 1 };
    },
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
    revalidateCodexSummaryStillComplete: (item) => {
      calls.push(`revalidate:${item.noticeId}`);
      return false;
    },
  };
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.staleSkipped, [
    {
      noticeId: 801,
      botLogin: CODEX,
      reason: 'codex-review-running-at-post-time',
    },
  ]);
  // Claim revalidation and the staleness check both run, but post() never does.
  assert.deepEqual(calls, ['claim', 'revalidate:801']);
});

test('applyDispositionPlan: posts a planned Codex summary that revalidateCodexSummaryStillComplete confirms is still complete', () => {
  const plan = fakeCodexSummaryPlan(802);
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => ({ id: 9802 }),
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
    revalidateCodexSummaryStillComplete: () => true,
  };
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(result.applied, [{ noticeId: 802, commentId: 9802 }]);
  assert.deepEqual(result.staleSkipped, []);
});

test('applyDispositionPlan: omitting revalidateCodexSummaryStillComplete posts a Codex summary unconditionally (backward compatible)', () => {
  const plan = fakeCodexSummaryPlan(803);
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => ({ id: 9803 }),
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(result.applied, [{ noticeId: 803, commentId: 9803 }]);
  assert.deepEqual(result.staleSkipped, []);
});

test('applyDispositionPlan: stale Codex no-find results are skipped before posting', () => {
  const plan = fakeCodexNoFindPlan(850);
  let postCalled = false;
  const result = applyDispositionPlan(plan, {
    revalidateClaim: () => true,
    postDisposition: () => {
      postCalled = true;
      return { id: 9850 };
    },
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
    revalidateCodexNoFindStillCurrent: () => false,
  });
  assert.equal(postCalled, false);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.staleSkipped, [
    {
      noticeId: 850,
      botLogin: CODEX,
      reason: 'codex-no-find-stale-at-post-time',
    },
  ]);
});

test('applyDispositionPlan: current Codex no-find results post after revalidation', () => {
  const plan = fakeCodexNoFindPlan(851);
  let plannedHeadSha = '';
  const result = applyDispositionPlan(plan, {
    revalidateClaim: () => true,
    postDisposition: () => ({ id: 9851 }),
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
    revalidateCodexNoFindStillCurrent: (_item, headSha) => {
      plannedHeadSha = headSha;
      return true;
    },
  });
  assert.deepEqual(result.applied, [{ noticeId: 851, commentId: 9851 }]);
  assert.deepEqual(result.staleSkipped, []);
  assert.equal(plannedHeadSha, 'abc1234');
});

test('applyDispositionPlan: missing Codex no-find revalidation fails closed', () => {
  const plan = fakeCodexNoFindPlan(852);
  let postCalled = false;
  const result = applyDispositionPlan(plan, {
    revalidateClaim: () => true,
    postDisposition: () => {
      postCalled = true;
      return { id: 9852 };
    },
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
  });
  assert.equal(postCalled, false);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.staleSkipped, [
    {
      noticeId: 852,
      botLogin: CODEX,
      reason: 'codex-no-find-stale-at-post-time',
    },
  ]);
});

test('applyDispositionPlan: revalidateCodexSummaryStillComplete is never consulted for a non-Codex-summary item', () => {
  // A CodeRabbit notice item (fakePlan's default shape) must never trigger the
  // Codex-only staleness hook, even when one is supplied.
  const plan = fakePlan([901]);
  let revalidateCalled = false;
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => ({ id: 9901 }),
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
    revalidateCodexSummaryStillComplete: () => {
      revalidateCalled = true;
      return false;
    },
  };
  const result = applyDispositionPlan(plan, deps);
  assert.equal(revalidateCalled, false);
  assert.deepEqual(result.applied, [{ noticeId: 901, commentId: 9901 }]);
  assert.deepEqual(result.staleSkipped, []);
});

test('applyDispositionPlan: re-revalidates before the retry POST and stale-skips instead of retrying when Codex flips to Running mid-retry', () => {
  // Codex review (P1 follow-up on the first staleness-gate commit): the
  // first postDisposition throws, recovery finds nothing, and by the time
  // the retry would run Codex has flipped its own comment back to Running.
  // The retry must never fire -- the item is stale-skipped, not failed.
  const calls: string[] = [];
  const plan = fakeCodexSummaryPlan(804);
  let revalidateCallCount = 0;
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => {
      calls.push('post');
      throw new Error('transient create failure');
    },
    recoverPostedDisposition: () => {
      calls.push('recover');
      return null;
    },
    knownViewerCommentIds: new Set(),
    revalidateCodexSummaryStillComplete: () => {
      revalidateCallCount += 1;
      calls.push(`revalidate:${revalidateCallCount}`);
      // Complete on the first check (before attempt 0), Running by the time
      // the retry would check again.
      return revalidateCallCount === 1;
    },
  };
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.staleSkipped, [
    {
      noticeId: 804,
      botLogin: CODEX,
      reason: 'codex-review-running-at-post-time',
    },
  ]);
  // Attempt 0's revalidation passes, its post throws, recovery finds
  // nothing, the retry's revalidation fails -- and the retry POST never runs.
  assert.deepEqual(calls, ['revalidate:1', 'post', 'recover', 'revalidate:2']);
});

test('applyDispositionPlan: a throwing revalidateCodexSummaryStillComplete is treated as not-complete, not a crash', () => {
  // Copilot review: the hook call must be safe against its own failure (e.g.
  // a transient network error fetching the fresh head/body) -- never let it
  // abort the whole --apply run.
  const plan = fakeCodexSummaryPlan(805);
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => ({ id: 9805 }),
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
    revalidateCodexSummaryStillComplete: () => {
      throw new Error('gh api: network timeout');
    },
  };
  assert.doesNotThrow(() => applyDispositionPlan(plan, deps));
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.staleSkipped, [
    {
      noticeId: 805,
      botLogin: CODEX,
      reason: 'codex-review-running-at-post-time',
    },
  ]);
});
