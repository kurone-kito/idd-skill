import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDispositionBody,
  buildDispositionPlan,
  type NoticeComment,
  noticeReason,
} from '../src/scripts/disposition-non-review-notices.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const planSchema = loadJson(
  'schemas/disposition-non-review-notices.schema.json',
);

const CODEX = 'chatgpt-codex-connector[bot]';
const CODERABBIT = 'coderabbitai[bot]';
const CODEX_NOTICE =
  'You have reached your Codex usage limits for code reviews.';
const CODERABBIT_NOTICE =
  '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> ## Review limit reached';
// A full 40-char head SHA for the cases that validate against the schema, which
// now constrains `headSha` to `^[0-9a-f]{40}$`.
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

function notice(
  id: number,
  login: string,
  body: string,
  createdAt = `2026-05-12T00:00:0${id}Z`,
): NoticeComment {
  return { id, login, body, createdAt };
}

test('buildDispositionBody is marker-first and names the bot login + head sha', () => {
  const body = buildDispositionBody(
    CODERABBIT,
    'abc1234',
    'review limit reached',
  );
  assert.ok(body.startsWith('**Rejected**'), 'marker must be first bytes');
  assert.match(body, /coderabbitai\[bot\] did not review HEAD abc1234/);
  // Canonical E6 text ends at "completed review" with no trailing punctuation.
  assert.match(
    body,
    /\(review limit reached\); this is not a completed review$/,
  );
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
        // A real CodeRabbit summarize review (not a rate-limit notice).
        notice(
          2,
          CODERABBIT,
          '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n## Walkthrough',
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

test('buildDispositionPlan plans a notice even when the bot also reviewed', () => {
  // A persistent rate-limit notice stays in the gate's outstanding set until a
  // disposition naming the bot carries it, even when the bot has a separate
  // completed review. The helper always plans the undispositioned notice.
  const plan = buildDispositionPlan(
    {
      headSha: 'abc1234',
      comments: [
        notice(1, CODERABBIT, CODERABBIT_NOTICE),
        // A separate CodeRabbit summary review (handled by the agent, not here).
        notice(
          2,
          CODERABBIT,
          '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n## Walkthrough',
        ),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
  );
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].botLogin, CODERABBIT);
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

test('the dry-run and apply output envelopes validate against the schema', () => {
  const plan = buildDispositionPlan(
    {
      headSha: HEAD_SHA,
      comments: [
        notice(1, CODEX, CODEX_NOTICE),
        notice(2, CODERABBIT, CODERABBIT_NOTICE),
      ],
    },
    { trustedMarkerLogins: ['kurone-kito'] },
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
