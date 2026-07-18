import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDispositionBody,
  buildDispositionPlan,
  buildSummaryDispositionBody,
  type NoticeComment,
  noticeReason,
  parseArgs,
} from '../src/scripts/disposition-non-review-notices.mts';
import {
  dispositionNamesAdvisoryBot,
  isDispositionComment,
  summarizeDispositionEvidenceForGate,
} from '../src/scripts/protocol-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const planSchema = loadJson(
  'schemas/disposition-non-review-notices.schema.json',
);

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
const CODERABBIT_SUMMARY =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n## Walkthrough\nSome walkthrough text.';
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
    /\(review limit reached\); this is not a completed review \(source: #issuecomment-501\)$/,
  );
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
  assert.match(first?.body ?? '', /\(source: #issuecomment-101\)$/);
  assert.match(second?.body ?? '', /\(source: #issuecomment-102\)$/);
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
  assert.match(plan.planned[0]?.body ?? '', /\(source: #issuecomment-201\)$/);
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
