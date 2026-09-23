import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildFindingThreads,
  buildTransitionTable,
  classifyDispositionReply,
  computePrAudit,
  type MergedPrCandidate,
  type ParsedOpenFinding,
  parseOverviewBody,
  type RawComment,
  type RawReview,
  RECENT_MERGED_OVER_FETCH_MAX,
  resolveThreadDisposition,
  selectMostRecentlyMerged,
  summarizeCohort,
} from '../src/scripts/copilot-review-wave-audit.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/copilot-review-wave-audit.mjs');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function pictureBadge(severity: 'High' | 'Medium' | 'Low'): string {
  const slug = severity.toLowerCase();
  return (
    `<picture><source media="(prefers-color-scheme: dark)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/${slug}-v2-dark.svg">` +
    `<source media="(prefers-color-scheme: light)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/${slug}-v2-light.svg">` +
    `<img src="https://github.githubassets.com/static/images/icons/copilot-code-review/${slug}-v2-light.png" alt="${severity} severity" width="62" height="18" align="texttop"></picture>`
  );
}

function openLine(
  severity: 'High' | 'Medium' | 'Low',
  id: number,
  isNew = false,
): string {
  return `- ${pictureBadge(severity)} [Some finding](#discussion_r${id})${isNew ? ' · New' : ''}`;
}

// Real review body: PR #3210 review 5292079228 (kurone-kito/idd-skill), an
// "Open (2)" section where both findings carry the `· New` suffix and a
// "What changed in this PR" section that must be recognized-and-ignored.
const OPEN_WITH_NEW_FIXTURE = `<!-- ccr-overview-v2 -->

## Copilot review overview

### 🟡 Changes recommended

Explicit metadata conditions and fail-closed \`rev-parse\` handling remain unresolved.

*Get a fresh assessment by requesting another Copilot review.*

**Review effort:** Lite
**Findings:** 2 ${pictureBadge('Medium')}

<details open>
<summary><strong>Open (2)</strong></summary>

${openLine('Medium', 4083347769, true)}
${openLine('Medium', 4083347840, true)}
</details>

<details>
<summary><strong>What changed in this PR</strong></summary>

Updates lite claim instructions to align detached-worktree handling with the standard safety semantics.

**Changes:**
- Clarifies absent versus STOP outcomes for detached worktrees.
</details>

---

💡 Configure MCP servers for context-aware, tailored reviews.
`;

// Real review body: PR #3147 review 5255592914 (kurone-kito/idd-skill) -- the
// header says "Findings: None" while a "Previously missed (2)" section still
// lists two Low-severity, thread-less findings nested under inner <details>
// elements (no #discussion_r link on either).
const PREVIOUSLY_MISSED_FIXTURE = `<!-- ccr-overview-v2 -->

## Copilot review overview

### 🔵 Needs a closer look

The updated instructions introduce a small grammar regression.

**Review effort:** Lite
**Findings:** None

<details>
<summary><strong>Resolved since last review (2)</strong></summary>

- ${pictureBadge('Low')} [Add spaces around em dash](#discussion_r4053024180)
- ${pictureBadge('Low')} [Add spaces around em dash](#discussion_r4053024174)
</details>

<details>
<summary><strong>Previously missed (2)</strong></summary>

In code that hasn't changed since last review

<details>
<summary>${pictureBadge('Low')} Clarify that the surviving location is the primary worktree</summary>

\`.github/instructions/idd-merge.instructions.md:544\`

The phrase is ambiguous.
</details>

<details>
<summary>${pictureBadge('Low')} Clarify that the surviving location is the primary worktree</summary>

\`idd-template/.github/instructions/idd-merge.instructions.md:539\`

The phrase is ambiguous.
</details>
</details>
`;

const LEGACY_FIXTURE = `### 🟢 Approval recommended
The change is low-risk and includes direct unit tests.
<details>
<summary>Pull request overview</summary>
This PR improves diagnostics.
</details>`;

const NO_FINDINGS_FIXTURE = `<!-- ccr-overview-v2 -->

## Copilot review overview

### 🟢 Approval recommended

The documentation change is accurate and self-contained.

**Review effort:** Lite
**Findings:** None

<details>
<summary><strong>What changed in this PR</strong></summary>

Docs-only change.
</details>
`;

function review(
  id: number,
  submittedAt: string,
  body: string,
  login = 'copilot-pull-request-reviewer[bot]',
): RawReview {
  return { id, submittedAt, body, login };
}

function reply(
  id: number,
  inReplyToId: number,
  body: string,
  createdAt: string,
): RawComment {
  return { id, inReplyToId, body, createdAt };
}

// ---------------------------------------------------------------------------
// parseOverviewBody
// ---------------------------------------------------------------------------

test('parseOverviewBody: a body without the ccr-overview-v2 marker is legacy', () => {
  const parsed = parseOverviewBody(LEGACY_FIXTURE);
  assert.equal(parsed.kind, 'legacy');
  assert.deepEqual(parsed.open, []);
  assert.deepEqual(parsed.previouslyMissed, { high: 0, medium: 0, low: 0 });
});

test('parseOverviewBody: a fully clean v2 body with no findings parses as v2 with empty Open', () => {
  const parsed = parseOverviewBody(NO_FINDINGS_FIXTURE);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
  assert.deepEqual(parsed.previouslyMissed, { high: 0, medium: 0, low: 0 });
});

test('parseOverviewBody: real Open-with-New fixture parses severity, id, and isNew per item', () => {
  const parsed = parseOverviewBody(OPEN_WITH_NEW_FIXTURE);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, [
    { severity: 'medium', id: 4083347769, isNew: true },
    { severity: 'medium', id: 4083347840, isNew: true },
  ]);
  assert.deepEqual(parsed.previouslyMissed, { high: 0, medium: 0, low: 0 });
});

test('parseOverviewBody: a carried-over Open item (no New suffix) has isNew false', () => {
  const body = `<!-- ccr-overview-v2 -->

<details open>
<summary><strong>Open (1)</strong></summary>

${openLine('High', 111)}
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, [{ severity: 'high', id: 111, isNew: false }]);
});

test('parseOverviewBody: real Findings:None + Previously missed fixture excludes it from Open', () => {
  const parsed = parseOverviewBody(PREVIOUSLY_MISSED_FIXTURE);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
  assert.deepEqual(parsed.previouslyMissed, { high: 0, medium: 0, low: 2 });
});

test('parseOverviewBody: a Resolved-only body with no Open/Previously-missed is v2 with empty Open', () => {
  const body = `<!-- ccr-overview-v2 -->

<details>
<summary><strong>Resolved since last review (1)</strong></summary>

${openLine('Low', 222)}
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
  assert.deepEqual(parsed.previouslyMissed, { high: 0, medium: 0, low: 0 });
});

test('parseOverviewBody: an unrecognized future section is ignored, not unparsed', () => {
  const body = `<!-- ccr-overview-v2 -->

<details>
<summary><strong>Some Future Section (1)</strong></summary>

Placeholder content Copilot might add later.
</details>

<details open>
<summary><strong>Open (0)</strong></summary>
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
});

test('parseOverviewBody: an Open header/item count mismatch is unparsed', () => {
  const body = `<!-- ccr-overview-v2 -->

<details open>
<summary><strong>Open (3)</strong></summary>

${openLine('Low', 1)}
${openLine('Low', 2)}
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'unparsed');
  assert.match(
    parsed.unparsedReason ?? '',
    /Open header declared 3 but 2 were parsed/,
  );
});

test('parseOverviewBody: a Previously-missed header/item count mismatch is unparsed', () => {
  const body = `<!-- ccr-overview-v2 -->

<details>
<summary><strong>Previously missed (2)</strong></summary>

<details>
<summary>${pictureBadge('Low')} one finding</summary>

body
</details>
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'unparsed');
  assert.match(
    parsed.unparsedReason ?? '',
    /Previously missed header declared 2 but 1 were parsed/,
  );
});

test('parseOverviewBody: a positive Findings header with no recognized Open section is unparsed', () => {
  // Copilot review, PR #3245 (#discussion_r4086537940's sibling
  // "Previously missed" finding): a marker-present body whose Open section
  // markup drifted (or was otherwise never recognized) must not silently
  // fall through to a "zero findings" v2 review when the summary line
  // itself declares a positive count.
  const body = `<!-- ccr-overview-v2 -->

**Findings:** 2 ${pictureBadge('Medium')}
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'unparsed');
  assert.match(
    parsed.unparsedReason ?? '',
    /Findings header declared 2 but no Open section was found/,
  );
});

test('parseOverviewBody: a "Findings: None" header with no Open section stays a genuine v2 zero-findings review', () => {
  const parsed = parseOverviewBody(NO_FINDINGS_FIXTURE);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
});

// ---------------------------------------------------------------------------
// classifyDispositionReply
// ---------------------------------------------------------------------------

test('classifyDispositionReply: recognizes all five outcomes', () => {
  assert.equal(
    classifyDispositionReply(
      '**Accepted** — fixed in abc123: renamed the field',
    ),
    'accepted',
  );
  assert.equal(
    classifyDispositionReply('**Rejected** — not applicable to this diff'),
    'rejected',
  );
  assert.equal(
    classifyDispositionReply(
      '**Rejected** — deferred to follow-up issue #100 so this patch remains scoped',
    ),
    'deferred',
  );
  assert.equal(
    classifyDispositionReply('**Awaiting maintainer decision** — needs input'),
    'other',
  );
  assert.equal(
    classifyDispositionReply(
      '**Rejection confirmed by maintainer** — agreed, dropping this',
    ),
    'other',
  );
  assert.equal(
    classifyDispositionReply('Thanks for flagging, will look into it'),
    null,
  );
});

test('classifyDispositionReply: trims surrounding whitespace before matching', () => {
  assert.equal(
    classifyDispositionReply('  \n**Accepted** — fixed\n  '),
    'accepted',
  );
});

// ---------------------------------------------------------------------------
// resolveThreadDisposition
// ---------------------------------------------------------------------------

test('resolveThreadDisposition: no replies resolves to none', () => {
  assert.equal(resolveThreadDisposition(1, []), 'none');
});

test('resolveThreadDisposition: a single accepted reply resolves to accepted', () => {
  const comments = [
    reply(10, 1, '**Accepted** — fixed', '2026-01-01T00:00:00Z'),
  ];
  assert.equal(resolveThreadDisposition(1, comments), 'accepted');
});

test('resolveThreadDisposition: the chronologically last recognized reply wins', () => {
  const comments = [
    reply(10, 1, '**Accepted** — fixed', '2026-01-01T00:00:00Z'),
    reply(
      11,
      1,
      '**Rejected** — reverted, this was wrong',
      '2026-01-02T00:00:00Z',
    ),
  ];
  assert.equal(resolveThreadDisposition(1, comments), 'rejected');
});

test('resolveThreadDisposition: trailing non-disposition chatter does not erase an earlier disposition', () => {
  const comments = [
    reply(10, 1, '**Accepted** — fixed', '2026-01-01T00:00:00Z'),
    reply(11, 1, 'Thanks!', '2026-01-02T00:00:00Z'),
  ];
  assert.equal(resolveThreadDisposition(1, comments), 'accepted');
});

test('resolveThreadDisposition: replies to a different finding id are excluded', () => {
  const comments = [
    reply(10, 999, '**Accepted** — fixed', '2026-01-01T00:00:00Z'),
  ];
  assert.equal(resolveThreadDisposition(1, comments), 'none');
});

// ---------------------------------------------------------------------------
// buildFindingThreads
// ---------------------------------------------------------------------------

test('buildFindingThreads: keys by id, keeping the first-seen severity', () => {
  const findings: ParsedOpenFinding[] = [
    { id: 1, severity: 'low', isNew: true },
    { id: 1, severity: 'high', isNew: false },
    { id: 2, severity: 'medium', isNew: true },
  ];
  const comments = [
    reply(10, 1, '**Accepted** — fixed', '2026-01-01T00:00:00Z'),
  ];
  const threads = buildFindingThreads(findings, comments);
  const thread1 = threads.find((thread) => thread.id === 1);
  const thread2 = threads.find((thread) => thread.id === 2);
  assert.equal(thread1?.severity, 'low');
  assert.equal(thread1?.disposition, 'accepted');
  assert.equal(thread2?.severity, 'medium');
  assert.equal(thread2?.disposition, 'none');
});

// ---------------------------------------------------------------------------
// buildTransitionTable
// ---------------------------------------------------------------------------

test('buildTransitionTable: keys by highest Open severity, none when Open is empty', () => {
  const rows = buildTransitionTable([
    { kind: 'v2', open: [] },
    {
      kind: 'v2',
      open: [
        { id: 1, severity: 'low', isNew: true },
        { id: 2, severity: 'high', isNew: true },
      ],
    },
  ]);
  const none = rows.find((row) => row.severity === 'none');
  const high = rows.find((row) => row.severity === 'high');
  assert.equal(none?.followed, 1);
  assert.equal(none?.last, 0);
  assert.equal(high?.followed, 0);
  assert.equal(high?.last, 1);
});

test('buildTransitionTable: a legacy/unparsed review occupies a sequence position but contributes no row', () => {
  const rows = buildTransitionTable([
    { kind: 'v2', open: [{ id: 1, severity: 'low', isNew: true }] },
    { kind: 'legacy', open: [] },
  ]);
  const low = rows.find((row) => row.severity === 'low');
  // A legacy review followed the v2 review, so the v2 review still counts
  // as "followed by another Copilot review", not "last review".
  assert.equal(low?.followed, 1);
  assert.equal(low?.last, 0);
});

// ---------------------------------------------------------------------------
// computePrAudit / summarizeCohort (small integration)
// ---------------------------------------------------------------------------

test('computePrAudit + summarizeCohort: end-to-end composition over two reviews', () => {
  const reviews: RawReview[] = [
    review(1, '2026-01-01T00:00:00Z', NO_FINDINGS_FIXTURE),
    review(
      2,
      '2026-01-02T00:00:00Z',
      `<!-- ccr-overview-v2 -->

<details open>
<summary><strong>Open (1)</strong></summary>

${openLine('Low', 5001, true)}
</details>
`,
    ),
  ];
  const comments: RawComment[] = [
    reply(10, 5001, '**Accepted** — fixed', '2026-01-03T00:00:00Z'),
  ];

  const report = computePrAudit(42, reviews, comments);
  assert.equal(report.pr, 42);
  assert.equal(report.reviewCount, 2);
  assert.equal(report.v2Count, 2);
  assert.equal(report.legacyCount, 0);
  assert.equal(report.unparsedCount, 0);
  assert.deepEqual(report.openAppearances, { high: 0, medium: 0, low: 1 });
  assert.equal(report.threads.length, 1);
  assert.equal(report.threads[0]?.disposition, 'accepted');

  // Per-review detail is preserved, not only folded into the aggregate
  // counts above (Copilot review, PR #3245): each review's own Open
  // findings, including new-versus-carried status, stay inspectable.
  assert.equal(report.reviews.length, 2);
  assert.equal(report.reviews[0]?.reviewId, 1);
  assert.equal(report.reviews[0]?.kind, 'v2');
  assert.deepEqual(report.reviews[0]?.open, []);
  assert.equal(report.reviews[1]?.reviewId, 2);
  assert.deepEqual(report.reviews[1]?.open, [
    { severity: 'low', id: 5001, isNew: true },
  ]);

  const summary = summarizeCohort([report]);
  assert.equal(summary.prCount, 1);
  assert.equal(summary.reviewCount, 2);
  assert.equal(summary.uniqueThreads.low, 1);
  assert.equal(summary.dispositionsBySeverity.low.accepted, 1);
  // The only v2 review with a non-empty Open is the last review in the
  // sequence, so it is "last", not "followed".
  const lowRow = summary.transitions.find((row) => row.severity === 'low');
  assert.equal(lowRow?.followed, 0);
  assert.equal(lowRow?.last, 1);
});

test('computePrAudit: an unparsed review is excluded from Open appearances but counted', () => {
  const reviews: RawReview[] = [
    review(
      1,
      '2026-01-01T00:00:00Z',
      `<!-- ccr-overview-v2 -->

<details open>
<summary><strong>Open (5)</strong></summary>

${openLine('Low', 1)}
</details>
`,
    ),
  ];
  const report = computePrAudit(7, reviews, []);
  assert.equal(report.unparsedCount, 1);
  assert.equal(report.v2Count, 0);
  assert.deepEqual(report.openAppearances, { high: 0, medium: 0, low: 0 });
  assert.equal(report.threads.length, 0);
  // The per-review record still carries the partially-parsed item (and the
  // reason) for diagnosis, even though it is excluded from every aggregate
  // above -- an untrusted partial parse never pollutes a trusted total.
  assert.equal(report.reviews[0]?.kind, 'unparsed');
  assert.equal(report.reviews[0]?.open.length, 1);
  assert.match(
    report.reviews[0]?.unparsedReason ?? '',
    /Open header declared 5 but 1 were parsed/,
  );
});

test('computePrAudit: a non-Copilot-login review is never handed to this function by auditPr, but a legacy review among Copilot reviews is still counted', () => {
  const reviews: RawReview[] = [
    review(1, '2026-01-01T00:00:00Z', LEGACY_FIXTURE),
  ];
  const report = computePrAudit(9, reviews, []);
  assert.equal(report.legacyCount, 1);
  assert.equal(report.v2Count, 0);
});

// ---------------------------------------------------------------------------
// selectMostRecentlyMerged
// ---------------------------------------------------------------------------

test('selectMostRecentlyMerged: sorts by mergedAt descending, not creation/list order', () => {
  // Mirrors the real, live-confirmed case this fix addresses: PR #3232 was
  // created later but merged earlier than PR #3225, so gh pr list's own
  // (creation-order) response lists 3232 first -- the correct output here
  // must still put 3225 first, since it merged later.
  const candidates: MergedPrCandidate[] = [
    { number: 3232, mergedAt: '2026-09-23T17:10:01Z' },
    { number: 3225, mergedAt: '2026-09-23T19:05:15Z' },
  ];
  assert.deepEqual(selectMostRecentlyMerged(candidates, 2), [3225, 3232]);
});

test('selectMostRecentlyMerged: a null mergedAt sorts last', () => {
  const candidates: MergedPrCandidate[] = [
    { number: 1, mergedAt: null },
    { number: 2, mergedAt: '2026-09-23T00:00:00Z' },
  ];
  assert.deepEqual(selectMostRecentlyMerged(candidates, 2), [2, 1]);
});

test('selectMostRecentlyMerged: ties break by descending PR number', () => {
  const candidates: MergedPrCandidate[] = [
    { number: 10, mergedAt: '2026-09-23T00:00:00Z' },
    { number: 20, mergedAt: '2026-09-23T00:00:00Z' },
  ];
  assert.deepEqual(selectMostRecentlyMerged(candidates, 2), [20, 10]);
});

test('selectMostRecentlyMerged: respects the exact requested limit', () => {
  const candidates: MergedPrCandidate[] = [
    { number: 1, mergedAt: '2026-09-23T03:00:00Z' },
    { number: 2, mergedAt: '2026-09-23T02:00:00Z' },
    { number: 3, mergedAt: '2026-09-23T01:00:00Z' },
  ];
  assert.deepEqual(selectMostRecentlyMerged(candidates, 2), [1, 2]);
});

// ---------------------------------------------------------------------------
// CLI smoke tests (no gh calls: --help and argument-validation-only paths)
// ---------------------------------------------------------------------------

test('CLI: --help exits 0 with no gh call', () => {
  const output = execFileSync('node', [CLI_PATH, '--help'], {
    encoding: 'utf8',
  });
  assert.match(output, /Usage:/);
  assert.match(output, /--prs <n,n,\.\.\.>/);
});

test('CLI: --prs and --limit together fails with exit 2', () => {
  assert.throws(
    () => {
      execFileSync('node', [CLI_PATH, '--prs', '1', '--limit', '5'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
    (error: unknown) => {
      const shaped = error as { status?: number; stderr?: string };
      assert.equal(shaped.status, 2);
      assert.match(shaped.stderr ?? '', /choose exactly one of --prs.*--limit/);
      return true;
    },
  );
});

test('CLI: an invalid --format fails with exit 2', () => {
  assert.throws(
    () => {
      execFileSync('node', [CLI_PATH, '--prs', '1', '--format', 'xml'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
    (error: unknown) => {
      const shaped = error as { status?: number; stderr?: string };
      assert.equal(shaped.status, 2);
      assert.match(shaped.stderr ?? '', /--format must be "json" or "tsv"/);
      return true;
    },
  );
});

test('CLI: --limit beyond the over-fetch ceiling fails closed with exit 2, no gh pr list call', () => {
  // --repo is passed explicitly so combineOwnerRepoFlags short-circuits
  // detectRepository() (which would otherwise shell out to `gh repo
  // view`); the --limit guard itself fires before any `gh pr list` call,
  // so this exercises the fail-closed path with zero network I/O.
  assert.throws(
    () => {
      execFileSync(
        'node',
        [
          CLI_PATH,
          '--repo',
          'kurone-kito/idd-skill',
          '--limit',
          String(RECENT_MERGED_OVER_FETCH_MAX + 1),
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    },
    (error: unknown) => {
      const shaped = error as { status?: number; stderr?: string };
      assert.equal(shaped.status, 2);
      assert.match(
        shaped.stderr ?? '',
        /exceeds this helper's over-fetch ceiling/,
      );
      return true;
    },
  );
});
