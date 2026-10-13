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

// Real review body: PR #4159 review 5500197614 (kurone-kito/idd-skill), in
// the October 2026 format (issue #4184): a `1 open finding` header whose item carries
// an absolute `#discussion_r` link and `· New`, a `1 resolved since last review`
// section, and `Previously missed (1)`. Backticks are escaped, and the two
// zero-width spaces in the citation path are written as \u200B.
const NEW_FORMAT_FIXTURE = `<!-- ccr-overview-v2 -->

### 🟡 Changes recommended

Unresolved validation, marker-prefix, ownership revalidation, duplicate-marker parsing, and contract documentation issues remain.

<details open>
<summary><strong>1 open finding</strong></summary>

- <picture><source media="(prefers-color-scheme: dark)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/high-v2-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/high-v2-light.svg"><img src="https://github.githubassets.com/static/images/icons/copilot-code-review/high-v2-light.png" alt="High severity" width="62" height="18" align="texttop"></picture> [Validate journal issue is durable and comment-only](https://github.com/kurone-kito/idd-skill/pull/4159#discussion_r4255899147) · New
</details>

<details>
<summary><strong>1 resolved since last review</strong></summary>

- <picture><source media="(prefers-color-scheme: dark)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/high-v2-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/high-v2-light.svg"><img src="https://github.githubassets.com/static/images/icons/copilot-code-review/high-v2-light.png" alt="High severity" width="62" height="18" align="texttop"></picture> [Enforce actor permissions or bot trust before authoring writes](https://github.com/kurone-kito/idd-skill/pull/4159#discussion_r4255818014)
</details>

<details>
<summary><strong>Previously missed (1)</strong></summary>

In code that hasn't changed since last review

<details>
<summary><picture><source media="(prefers-color-scheme: dark)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/medium-v2-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/medium-v2-light.svg"><img src="https://github.githubassets.com/static/images/icons/copilot-code-review/medium-v2-light.png" alt="Medium severity" width="62" height="18" align="texttop"></picture> Resolve marker prefix for overridden target repositories</summary>

\`src/\u200Bscripts/\u200Bpublish-authoring-hold.mts:765\`

When \`--owner/--repo\` targets a repository whose configured marker prefix differs from the caller's local policy, this always derives the prefix from the local \`config\` and the command exposes no \`--marker-prefix\` override or target-policy lookup. It will then create/post markers under the wrong family, so the target repository cannot recognize the publication or owner records and the run can stop at provenance. Resolve the target repository's prefix (or require an explicit prefix for an overridden destination) and pass that value through all sibling helpers.
</details>
</details>

🧠 **Review effort:** Lite
`;

// Real review body: PR #4205 review 5505880022 (kurone-kito/idd-skill), the
// zero-open shape of the October 2026 format (issue #4184): a `**0 open findings**` line with no
// Open section, and one resolved item with an absolute link.
const ZERO_OPEN_FIXTURE = `<!-- ccr-overview-v2 -->

### 🟢 Approval recommended

The scoped change has targeted positive and negative regression coverage, with no unresolved review findings.

**0 open findings**

<details>
<summary><strong>1 resolved since last review</strong></summary>

- <picture><source media="(prefers-color-scheme: dark)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/medium-v2-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/medium-v2-light.svg"><img src="https://github.githubassets.com/static/images/icons/copilot-code-review/medium-v2-light.png" alt="Medium severity" width="62" height="18" align="texttop"></picture> [Prevent embedded findings from being treated as sticky notices](https://github.com/kurone-kito/idd-skill/pull/4205#discussion_r4260353015)
</details>

🧠 **Review effort:** Lite`;

// Real review body: PR #4205 review 5505683343 (kurone-kito/idd-skill), the
// October 2026 format with a CRLF-terminated "What changed" section and one
// medium open finding. Its CRs are written as \r escapes.
const REAL_CRLF_FIXTURE = `<!-- ccr-overview-v2 -->

### 🟡 Changes recommended

The existing sticky-match path can still hide an embedded finding in an unedited notice.

<details open>
<summary><strong>1 open finding</strong></summary>

- <picture><source media="(prefers-color-scheme: dark)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/medium-v2-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://github.githubassets.com/static/images/icons/copilot-code-review/medium-v2-light.svg"><img src="https://github.githubassets.com/static/images/icons/copilot-code-review/medium-v2-light.png" alt="Medium severity" width="62" height="18" align="texttop"></picture> [Prevent embedded findings from being treated as sticky notices](https://github.com/kurone-kito/idd-skill/pull/4205#discussion_r4260353015) · New
</details>

<details>
<summary><strong>What changed in this PR</strong></summary>

This PR updates the merged-PR feedback sweep to recognize trusted rejections of edited bot non-review notices while continuing to report unresolved threads.

**Changes:**
- Credits terminal notices named by an unedited, trusted rejection, provided the notice has no embedded findings.
- Adds regression tests and updates the generated JavaScript helper.

| File | Description |\r
| ---- | ----------- |\r
| tests/​merged-pr-feedback-sweep.test.mts | Tests credited notices and cases that must remain flagged. |\r
| src/​scripts/​merged-pr-feedback-sweep.mts | Adds notice and rejection matching to the sweep. |\r
| scripts/​merged-pr-feedback-sweep.mjs | Mirrors the TypeScript helper change. |
</details>

🧠 **Review effort:** Lite

---

💡 <a href="/kurone-kito/idd-skill/new/main?filename=.github/skills/code-review/SKILL.md" class="Link--inTextBlock" target="_blank" rel="noopener noreferrer">Add a \`code-review\` agent skill</a> or configure MCP servers for context-aware, tailored reviews. <a href="https://docs.github.com/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review?tool=webui#mcp-servers-and-agent-skills" class="Link--inTextBlock" target="_blank" rel="noopener noreferrer">Learn more in the docs.</a>`;

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
  lastEditedAt: string | null = null,
): RawComment {
  return { id, inReplyToId, body, createdAt, lastEditedAt };
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

test('parseOverviewBody: real new-format fixture reads the "N open finding" header and absolute links', () => {
  const parsed = parseOverviewBody(NEW_FORMAT_FIXTURE);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, [
    { severity: 'high', id: 4255899147, isNew: true },
  ]);
  assert.deepEqual(parsed.previouslyMissed, { high: 0, medium: 1, low: 0 });
});

test('parseOverviewBody: a "2 open findings" header with absolute-link items gives both items', () => {
  const body = `<!-- ccr-overview-v2 -->

<details open>
<summary><strong>2 open findings</strong></summary>

- ${pictureBadge('High')} [First](https://github.com/kurone-kito/idd-skill/pull/1#discussion_r101) · New
- ${pictureBadge('Low')} [Second](https://github.com/kurone-kito/idd-skill/pull/1#discussion_r102)
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, [
    { severity: 'high', id: 101, isNew: true },
    { severity: 'low', id: 102, isNew: false },
  ]);
});

test('parseOverviewBody: the real zero-open body is v2 with an empty Open', () => {
  const parsed = parseOverviewBody(ZERO_OPEN_FIXTURE);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
  assert.deepEqual(parsed.previouslyMissed, { high: 0, medium: 0, low: 0 });
});

test('parseOverviewBody: a **0 open findings** line with a resolved section of severity items is v2 with an empty Open', () => {
  const body = `<!-- ccr-overview-v2 -->

**0 open findings**

<details>
<summary><strong>2 resolved since last review</strong></summary>

${openLine('High', 201)}
${openLine('Low', 202)}
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
});

test('parseOverviewBody: a **2 open findings** line with no Open section is unparsed', () => {
  const body = `<!-- ccr-overview-v2 -->

**2 open findings**
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'unparsed');
  assert.match(
    parsed.unparsedReason ?? '',
    /Open findings line declared 2 but no Open section was found/,
  );
});

test('parseOverviewBody: severity-labelled findings under an unrecognized header are unparsed', () => {
  const body = `<!-- ccr-overview-v2 -->

<details>
<summary><strong>Brand New Section</strong></summary>

${openLine('High', 301)}
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'unparsed');
  assert.match(
    parsed.unparsedReason ?? '',
    /section "Brand New Section" lists severity-labelled findings/,
  );
});

test('parseOverviewBody: a "2 open findings" header with one item is unparsed (count mismatch)', () => {
  const body = `<!-- ccr-overview-v2 -->

<details open>
<summary><strong>2 open findings</strong></summary>

${openLine('High', 401)}
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'unparsed');
  assert.match(
    parsed.unparsedReason ?? '',
    /Open header declared 2 but 1 were parsed/,
  );
});

const crlf = (text: string): string => text.replace(/\n/g, '\r\n');

test('parseOverviewBody: CRLF line endings keep a **0 open findings** body v2', () => {
  const parsed = parseOverviewBody(
    crlf(`<!-- ccr-overview-v2 -->

**0 open findings**

<details>
<summary><strong>1 resolved since last review</strong></summary>

${openLine('Low', 501)}
</details>
`),
  );
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
});

test('parseOverviewBody: a CRLF **2 open findings** line with no Open section is unparsed', () => {
  const parsed = parseOverviewBody(
    crlf(`<!-- ccr-overview-v2 -->

**2 open findings**
`),
  );
  assert.equal(parsed.kind, 'unparsed');
  assert.match(
    parsed.unparsedReason ?? '',
    /Open findings line declared 2 but no Open section was found/,
  );
});

test('parseOverviewBody: a **1 open finding** line beside a recognized Open section is not a reason', () => {
  const body = `<!-- ccr-overview-v2 -->

**1 open finding**

<details open>
<summary><strong>1 open finding</strong></summary>

${openLine('Medium', 601, true)}
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, [{ severity: 'medium', id: 601, isNew: true }]);
});

test('parseOverviewBody: a severity item under "What changed in this PR" is ignored, not unparsed', () => {
  const body = `<!-- ccr-overview-v2 -->

<details>
<summary><strong>What changed in this PR</strong></summary>

${openLine('Low', 701)}
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
});

test('parseOverviewBody: an "Open findings (2)" header is not a recognized Open form, so its items are unparsed', () => {
  const body = `<!-- ccr-overview-v2 -->

<details open>
<summary><strong>Open findings (2)</strong></summary>

${openLine('High', 801)}
${openLine('Low', 802)}
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'unparsed');
  assert.ok(
    (parsed.unparsedReason ?? '').includes(
      'section "Open findings (2)" lists severity-labelled findings',
    ),
  );
});

test('parseOverviewBody: a real CRLF body with a "What changed" section reads its medium open finding', () => {
  const parsed = parseOverviewBody(REAL_CRLF_FIXTURE);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, [
    { severity: 'medium', id: 4260353015, isNew: true },
  ]);
});

test('parseOverviewBody: a discussion link inside a Previously missed item is not a drift reason', () => {
  const body = `<!-- ccr-overview-v2 -->

<details>
<summary><strong>Previously missed (1)</strong></summary>

<details>
<summary>${pictureBadge('Low')} Nested finding that cites [a thread](#discussion_r901)</summary>

Body text.
</details>
</details>
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
  assert.deepEqual(parsed.previouslyMissed, { high: 0, medium: 0, low: 1 });
});

const FENCE = '```';

test('parseOverviewBody: a fenced example of an Open header and item is not an open finding', () => {
  const body = `<!-- ccr-overview-v2 -->

Example markup, not a finding:

${FENCE}html
<details>
<summary><strong>Open (1)</strong></summary>

- <picture><img alt="High severity" src="h.svg"></picture> [Example](#discussion_r909)
</details>
${FENCE}

**0 open findings**
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
});

test('parseOverviewBody: a fenced copy of the bold open-count line is not an unparsed reason', () => {
  const body = `<!-- ccr-overview-v2 -->

${FENCE}
**2 open findings**
${FENCE}
`;
  const parsed = parseOverviewBody(body);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.open, []);
});

// ---------------------------------------------------------------------------
// classifyDispositionReply
// ---------------------------------------------------------------------------

test('classifyDispositionReply: counts the needs-decision deferral reply as a deferral', () => {
  const reply =
    '**Rejected** — deferred to follow-up issue #3790 (needs-decision; the check the claim needs has no route in E5): the claim could not be verified, so the follow-up records it as unverified';
  assert.equal(classifyDispositionReply(reply), 'deferred');
});

test('classifyDispositionReply: counts an urgency deferral reply with the step suffix as a deferral', () => {
  for (const clause of [
    'urgency low; severity high; step 1',
    'urgency medium; severity medium, Copilot high; step 2',
  ]) {
    assert.equal(
      classifyDispositionReply(
        `**Rejected** — deferred to follow-up issue #5 (${clause}): reason`,
      ),
      'deferred',
      clause,
    );
  }
});

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

test('classifyDispositionReply: tolerates trailing whitespace only, matching isDispositionComment', () => {
  assert.equal(
    classifyDispositionReply('**Accepted** — fixed\n  '),
    'accepted',
  );
});

test('classifyDispositionReply: rejects Accepted/Rejected preceded by leading whitespace', () => {
  // Copilot review, PR #3245, re-review 2026-09-23T20:43:20Z
  // (#discussion_r4086537940's sibling "Previously missed" finding):
  // isDispositionComment (protocol-helpers.mts) deliberately rejects a
  // marker not at the very first byte -- this audit must agree, or its
  // disposition counts would disagree with what the merge gate credits.
  assert.equal(classifyDispositionReply('  **Accepted** — fixed'), null);
  assert.equal(
    classifyDispositionReply('  **Rejected** — not applicable'),
    null,
  );
});

test('classifyDispositionReply: AMD and rejection-confirmed markers still tolerate leading whitespace', () => {
  // AMD_MARKER_PATTERN's own established call site in protocol-helpers.mts
  // uses trimStart(); isRejectionConfirmedDisposition trims internally.
  assert.equal(
    classifyDispositionReply(
      '  **Awaiting maintainer decision** — needs input',
    ),
    'other',
  );
  assert.equal(
    classifyDispositionReply(
      '  **Rejection confirmed by maintainer** — agreed, dropping this',
    ),
    'other',
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

test('resolveThreadDisposition: edited or unknown replies do not count', () => {
  const edited = reply(
    10,
    1,
    '**Accepted** — fixed',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:01:00Z',
  );
  const unknown: RawComment = {
    id: 11,
    inReplyToId: 1,
    body: '**Accepted** — fixed',
    createdAt: '2026-01-01T00:02:00Z',
  };
  assert.equal(resolveThreadDisposition(1, [edited]), 'none');
  assert.equal(resolveThreadDisposition(1, [unknown]), 'none');
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
